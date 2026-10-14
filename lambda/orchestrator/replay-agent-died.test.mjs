import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDetector } from "./dead-session-detector.mjs";
import * as lease from "./lease.mjs";

/**
 * TEAM-4739 FR-7 replay — 15x8ql / TEAM-4700, session ...-1789517815943.
 *
 * The real run: the backend_dev persona claimed TEAM-4700, streamed for ten
 * minutes, then its turn stopped being given time. WP4's runtime now publishes
 * `agent.died` on that path (2026-09-15T00:41:08Z on this run) instead of
 * leaving the claim indistinguishable from a slow one. Before this commit the
 * orchestrator could only INFER the death from silence-vs-median, and on this
 * fixture the median said "wait longer" — so the claim sat there.
 *
 * Fixture shape (mock the I/O seams only): the REAL detector runs against the
 * REAL lease.mjs, so GUARD 1's TTL math and `hasAgentErrorSince`'s filter -
 * including the `dead_session` exclusion that must NOT be applied to
 * `agent.died` - are the production ones. Only ddb / store / ticket / dispatch
 * are faked.
 *
 * HONEST DETECTION BOUND. `agent.died` does not shorten anything:
 *   - GUARD 1 (`lease.isLeaseLive`) still runs first and is still mandatory, so
 *     the earliest a death can be reaped is when the 30-min lease has expired —
 *     with ONE exception (DL-038 / TEAM-6000): the holder's own death stamped
 *     with this claim's generation and reason transient_exhaustion is read as a
 *     dead lease, so it reaps on the first sweep after it lands;
 *   - the sweep is an EventBridge `rate(5 minutes)` rule, so the reap lands on
 *     the first sweep at or after that, i.e. within 5 minutes of eligibility,
 *     NOT within 60 seconds of the event. A sub-minute bound would need a new
 *     event-driven handler branch, and DL-009 forbids one.
 * What positive death removes is the statistical WAIT on top of that: a claim
 * nothing will ever finish no longer has to out-wait 3x the agent's median run.
 */

const AGENT = "agentcore_hub_backend_dev";
const WF = "15x8ql";
const TICKET = "TEAM-4700";
const SESSION = "agentcore_hub_backend_dev-1789517815943";

// The run's real clock. Claim start, last stream frame, the death, the sweep.
const CLAIMED_AT = "2026-09-14T23:55:00.000Z";
const LAST_STREAM = "2026-09-15T00:05:00.000Z";
const DIED_AT = "2026-09-15T00:41:08.000Z";
const SWEEP_AT = Date.parse("2026-09-15T00:45:00.000Z"); // first rate(5m) tick after the death

// 40 min of silence at SWEEP_AT: past the 30-min lease (so GUARD 1 lets us
// look) but INSIDE the threshold the median path would have demanded, which is
// exactly why this run wedged. With no completed-run samples the detector falls
// back to 2x TTL = 60 min.
const SILENCE_MS = SWEEP_AT - Date.parse(LAST_STREAM);

const leafTicket = { ticketId: TICKET, type: "task", status: "in_progress", assignee: AGENT };

/** The events partition of the real run, minus everything the reads ignore. */
function runEvents({ died = true } = {}) {
  const rows = [
    { workflowId: WF, eventId: "1", type: "agent.started", timestamp: CLAIMED_AT, detail: { agentId: AGENT, ticketId: TICKET, sessionId: SESSION } },
    { workflowId: WF, eventId: "2", type: "agent.streaming", timestamp: LAST_STREAM, detail: { agentId: AGENT, ticketId: TICKET, type: "text", content: "patching lambda/orchestrator/lease.mjs" } },
  ];
  if (died) {
    rows.push({
      workflowId: WF, eventId: "3", type: "agent.died", timestamp: DIED_AT,
      detail: { workflowId: WF, agentId: AGENT, ticketId: TICKET, sessionId: SESSION, reason: "no_completion" },
    });
  }
  return rows;
}

/**
 * Fake DocumentClient over one events partition + one workflows table, applying
 * each production query's own FilterExpression semantics (dispatched on the
 * placeholder set the caller built, so a query shape change here fails loudly
 * rather than silently returning everything).
 */
function makeDdb({ workflows, events: all, updates = [], onQuery = null, visibleUntil }) {
  // Rows the run had not written yet at sweep time do not exist yet: a replay
  // that leaks a future event would "detect" a death before it happened.
  const events = all.filter((e) => String(e.timestamp) <= visibleUntil);
  return {
    updates,
    send: vi.fn(async (cmd) => {
      const kind = cmd.constructor.name;
      const table = cmd.input.TableName;
      const v = cmd.input.ExpressionAttributeValues || {};
      if (kind === "ScanCommand" && table === "workflows") return { Items: workflows };
      if (kind === "ScanCommand" && table === "events") {
        // rollingMedian: agent.started/agent.complete for this agent. This run
        // has no completions, so the median stays unsampled → 2x TTL fallback.
        return { Items: events.filter((e) => [v[":started"], v[":complete"]].includes(e.type) && e.detail?.agentId === v[":aid"]) };
      }
      if (kind === "QueryCommand" && table === "events") {
        if (onQuery) onQuery(cmd.input);
        const part = events.filter((e) => e.workflowId === v[":w"]);
        if (v[":hb1"]) { // lease.lastAgentActivity
          return { Items: part.filter((e) => [v[":hb1"], v[":hb2"]].includes(e.type) && e.detail?.agentId === v[":aid"] && String(e.timestamp) >= String(v[":cutoff"])) };
        }
        if (v[":complete"]) { // detector.hasCompletionSince
          return { Items: part.filter((e) => e.type === v[":complete"] && e.detail?.ticketId === v[":tid"] && String(e.timestamp) >= String(v[":since"])) };
        }
        if (v[":died"] || v[":err"]) { // lease.hasAgentErrorSince
          return { Items: part.filter((e) => {
            // TEAM-5784: when the query carries a generation (:gen), a died row
            // only matches when it is unstamped (legacy) or stamped with THIS
            // generation — mirrors lease.mjs's server-side filter clause.
            // TEAM-5977: strictGeneration drops the legacy (unstamped) arm —
            // the expression carries :gen without attribute_not_exists — and
            // :dreason requires detail.reason to match.
            const strict = !String(cmd.input.FilterExpression).includes("attribute_not_exists(detail.claimStartedAt)");
            const diedTyped = v[":died"] && e.type === v[":died"]
              && (!v[":gen"] || (!strict && e.detail?.claimStartedAt == null) || e.detail?.claimStartedAt === v[":gen"])
              && (!v[":dreason"] || e.detail?.reason === v[":dreason"]);
            const typed = diedTyped
              || (v[":err"] && e.type === v[":err"] && e.detail?.reason !== v[":dead"]);
            return typed && e.detail?.ticketId === v[":tid"] && String(e.timestamp) >= String(v[":since"]);
          }) };
        }
        return { Items: [] };
      }
      if (kind === "UpdateCommand") { updates.push(cmd.input); return {}; }
      return { Items: [] };
    }),
  };
}

function makeWorkflow(task = {}) {
  return {
    id: WF, workflowId: WF, phase: "development", startedAt: CLAIMED_AT,
    agentTasks: {
      [TICKET]: { id: "task_3_backend_dev", agentId: AGENT, ticketId: TICKET, status: "running", startedAt: CLAIMED_AT, sessionId: SESSION, ...task },
    },
  };
}

function makeDeps({ workflow, events, nowMs = SWEEP_AT, onQuery = null } = {}) {
  // lease.lastAgentActivity derives its lease window from the WALL clock (it is
  // the production heartbeat read, not a test seam), so the replay clock has to
  // be the system clock for the TTL math to be the real one.
  vi.useFakeTimers({ now: nowMs, toFake: ["Date"] });
  const store = {
    markDeadSessionDetected: vi.fn(async () => true),
    clearDeadSessionDetected: vi.fn(async () => true),
    incrementDeadSessionRetry: vi.fn(async () => 1),
    setTaskStatus: vi.fn(async () => {}),
    appendNotification: vi.fn(async () => {}),
    getWorkflow: vi.fn(async () => workflow),
  };
  const ddb = makeDdb({ workflows: [workflow], events, onQuery, visibleUntil: new Date(nowMs).toISOString() });
  const deps = {
    ddb, workflowsTable: "workflows", eventsTable: "events",
    store,
    lease, // the REAL module
    getTicket: vi.fn(async () => leafTicket),
    getAgentDef: vi.fn(() => ({ agentId: AGENT, phase: "development" })),
    publishEvent: vi.fn(async () => {}),
    redispatch: vi.fn(async () => true),
    blockTicket: vi.fn(async () => {}),
    now: () => nowMs,
    log: () => {},
  };
  return { deps, store, ddb };
}

const eventsOfType = (fn, type) => fn.mock.calls.filter((c) => c[1] === type);

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe("replay 15x8ql / TEAM-4700 — agent.died is positive proof (TEAM-4739)", () => {
  it("the pre-4739 inference alone does NOT reap this claim (why the run wedged)", async () => {
    // Same fixture, death row removed: 40 min of silence against the 60-min
    // low-sample fallback threshold. Nothing fires, forever.
    const workflow = makeWorkflow();
    const { deps } = makeDeps({ workflow, events: runEvents({ died: false }) });
    const m = await createDetector(deps).runSweep("enforce");

    expect(SILENCE_MS).toBe(40 * 60 * 1000);
    expect(SILENCE_MS).toBeLessThan(2 * lease.LEASE_TTL_MS); // inside the threshold
    expect(m.candidates).toBe(1);
    expect(m.fired).toBe(0);
    expect(deps.redispatch).not.toHaveBeenCalled();
  });

  it("the first sweep after the death reaps it and re-dispatches the SAME persona", async () => {
    const workflow = makeWorkflow();
    const { deps, store } = makeDeps({ workflow, events: runEvents() });
    const m = await createDetector(deps).runSweep("enforce");

    expect(m.fired).toBe(1);
    const errs = eventsOfType(deps.publishEvent, "agent.error");
    expect(errs).toHaveLength(1);
    expect(errs[0][2].detectorMeta.positiveDeath).toBe(true);
    // Fired DESPITE silence being under the threshold — the death, not the math.
    expect(errs[0][2].detectorMeta.threshold).toBeGreaterThan(SILENCE_MS);
    // Re-dispatch on THIS sweep, same persona, through the existing path.
    expect(deps.redispatch).toHaveBeenCalledTimes(1);
    expect(deps.redispatch.mock.calls[0][1]).toEqual(leafTicket);
    expect(workflow.agentTasks[TICKET].agentId).toBe(AGENT);
    expect(store.incrementDeadSessionRetry).toHaveBeenCalledWith(WF, TICKET);
    expect(eventsOfType(deps.publishEvent, "agent.escalated")).toHaveLength(0);
  });

  it("GUARD 1 still comes first: a live lease survives its own agent.died row", async () => {
    // The same death row, but the persona streamed 2 min before the sweep (a
    // duplicate/late death publish, or a runtime that recovered). isLeaseLive
    // wins: no steal, no dispatch, and the died read is never even reached.
    const events = [
      ...runEvents(),
      { workflowId: WF, eventId: "4", type: "agent.streaming", timestamp: "2026-09-15T00:43:00.000Z", detail: { agentId: AGENT, ticketId: TICKET, type: "text", content: "still here" } },
    ];
    const shapes = [];
    const workflow = makeWorkflow();
    const { deps, ddb } = makeDeps({ workflow, events, onQuery: (i) => shapes.push(i.ExpressionAttributeValues) });
    const m = await createDetector(deps).runSweep("enforce");

    expect(m.skippedLiveLease).toBe(1);
    expect(m.fired).toBe(0);
    expect(deps.redispatch).not.toHaveBeenCalled();
    expect(ddb.updates).toEqual([]); // stealClaim is the only write, and it never ran
    // TEAM-6000: the only died read a live lease permits is the strict exhaustion
    // one (:dreason); the loose read is still never reached.
    expect(shapes.filter((v) => v[":died"] && !v[":dreason"])).toHaveLength(0);
    expect(shapes.filter((v) => v[":dreason"] === "transient_exhaustion")).toHaveLength(1);
  });

  it("the reap is bounded by the 5-min sweep, not by the event", async () => {
    // A sweep one tick EARLIER (00:40, before the 00:41:08 death) sees nothing
    // to reap; the next tick does. That gap is the honest detection bound.
    const early = makeWorkflow();
    const before = makeDeps({ workflow: early, events: runEvents(), nowMs: Date.parse("2026-09-15T00:40:00.000Z") });
    expect((await createDetector(before.deps).runSweep("enforce")).fired).toBe(0);

    const late = makeWorkflow();
    const after = makeDeps({ workflow: late, events: runEvents() });
    expect((await createDetector(after.deps).runSweep("enforce")).fired).toBe(1);
  });
});

describe("replay TEAM-4703 — exactly two auto-resumes, then a human (TEAM-4739)", () => {
  it("resumes twice and escalates on the third death — never marks it done", async () => {
    const TICKET_3 = "TEAM-4703";
    const events = runEvents().map((e) => ({ ...e, detail: { ...e.detail, ticketId: TICKET_3 } }));
    const ticket = { ...leafTicket, ticketId: TICKET_3 };
    // One workflow row carried across three sweeps, with the retry counter
    // behaving like the store's ADD: each death re-drives the same persona
    // until the counter says both auto-resumes are spent.
    const workflow = {
      id: WF, workflowId: WF, phase: "development", startedAt: CLAIMED_AT,
      deadSessionRetries: {},
      agentTasks: { [TICKET_3]: { id: "task_3", agentId: AGENT, ticketId: TICKET_3, status: "running", startedAt: CLAIMED_AT } },
    };
    const { deps, store } = makeDeps({ workflow, events });
    deps.getTicket = vi.fn(async () => ticket);
    store.incrementDeadSessionRetry = vi.fn(async (_wf, tid) => {
      workflow.deadSessionRetries[tid] = (workflow.deadSessionRetries[tid] || 0) + 1;
      // The steal flipped status→ready; the re-dispatch re-claims it.
      workflow.agentTasks[tid].status = "running";
      delete workflow.agentTasks[tid].deadSessionDetectedAt;
      return workflow.deadSessionRetries[tid];
    });
    const detector = createDetector(deps);

    const m1 = await detector.runSweep("enforce");
    const m2 = await detector.runSweep("enforce");
    const m3 = await detector.runSweep("enforce");

    expect([m1.retries, m2.retries, m3.retries]).toEqual([1, 1, 0]);
    expect(deps.redispatch).toHaveBeenCalledTimes(2);
    expect(workflow.deadSessionRetries[TICKET_3]).toBe(2);
    expect(m3.escalations).toBe(1);

    const esc = eventsOfType(deps.publishEvent, "agent.escalated");
    expect(esc).toHaveLength(1);
    expect(esc[0][2].reason).toBe("dead_session_retry_exhausted");
    const notif = store.appendNotification.mock.calls[0][1];
    expect(notif.type).toBe("manager_escalation");
    expect(notif.id).toBe(`notif_dead_session_${TICKET_3}_${new Date(SWEEP_AT).toISOString()}`);
    expect(notif.acknowledged).toBe(false);

    // The escalation hands the ticket to a human: it is blocked and its task is
    // in error. Nothing in this path closes the work out - no "complete"/"done"
    // status write, no mark_done of any shape.
    expect(deps.blockTicket).toHaveBeenCalledWith(TICKET_3, "dead_session_retry_exhausted");
    expect(store.setTaskStatus.mock.calls).toEqual([[WF, TICKET_3, "error"]]);
    expect(Object.keys(store)).not.toContain("markTaskComplete");
    expect(eventsOfType(deps.publishEvent, "agent.complete")).toHaveLength(0);
  });
});

/**
 * TEAM-5784 — a stale fail-closed park refused by TEAM-5716's claim fence.
 *
 * Invocation A claims TEAM-9100 at T1, is reaped/released, and B re-claims it
 * at T2. A's late fail-closed park is refused server-side ("claim generation
 * moved") because B already holds the claim — so A publishes `agent.died`
 * stamped with ITS OWN generation (T1), but the row lands AFTER T2. Before
 * this fix, the `timestamp >= task.startedAt` read alone could not tell A's
 * death from B's: once B's lease (claimed at T2) goes stale, the detector
 * would read A's death as proof that B died and steal B's still-running
 * claim. `claimGeneration` fences the read to B's own startedAt.
 */
describe("replay TEAM-9100 — a prior generation's agent.died must not kill the current claim (TEAM-5784)", () => {
  const TICKET_5784 = "TEAM-9100";
  const T1 = "2026-09-20T10:00:00.000Z"; // A's claim
  const T2 = "2026-09-20T11:00:00.000Z"; // B's claim (re-dispatch)
  const A_DIED_AT = "2026-09-20T11:00:05.000Z"; // A's refused park → died, AFTER T2
  // 31 min past T2: past the 30-min lease (GUARD 1 lets the sweep look) but
  // well inside the 60-min no-samples fallback threshold — the silence alone
  // would never fire; only a (mis-attributed) positive death could.
  const SWEEP_5784 = Date.parse("2026-09-20T11:31:00.000Z");

  function workflowAt(claimStartedAt) {
    return {
      id: WF, workflowId: WF, phase: "development", startedAt: T1,
      agentTasks: {
        [TICKET_5784]: { id: "task_9100", agentId: AGENT, ticketId: TICKET_5784, status: "running", startedAt: claimStartedAt },
      },
    };
  }

  function eventsFor(diedClaimStartedAt) {
    const rows = [
      { workflowId: WF, eventId: "1", type: "agent.started", timestamp: T1, detail: { agentId: AGENT, ticketId: TICKET_5784 } },
      { workflowId: WF, eventId: "2", type: "agent.started", timestamp: T2, detail: { agentId: AGENT, ticketId: TICKET_5784 } },
    ];
    const detail = { workflowId: WF, agentId: AGENT, ticketId: TICKET_5784, sessionId: "sess-A" };
    if (diedClaimStartedAt !== undefined) detail.claimStartedAt = diedClaimStartedAt;
    rows.push({ workflowId: WF, eventId: "3", type: "agent.died", timestamp: A_DIED_AT, detail });
    return rows;
  }

  it("A's death stamped with the OLD generation (T1) does not touch B's live claim (T2)", async () => {
    const workflow = workflowAt(T2);
    const { deps, store } = makeDeps({ workflow, events: eventsFor(T1), nowMs: SWEEP_5784 });
    const m = await createDetector(deps).runSweep("enforce");

    expect(m.fired).toBe(0);
    expect(deps.redispatch).not.toHaveBeenCalled();
    expect(store.markDeadSessionDetected).not.toHaveBeenCalled();
    expect(eventsOfType(deps.publishEvent, "agent.error")).toHaveLength(0);
  });

  it("a death stamped with THIS SAME generation (T2) still fires", async () => {
    const workflow = workflowAt(T2);
    const { deps } = makeDeps({ workflow, events: eventsFor(T2), nowMs: SWEEP_5784 });
    const m = await createDetector(deps).runSweep("enforce");

    expect(m.fired).toBe(1);
    const errs = eventsOfType(deps.publishEvent, "agent.error");
    expect(errs[0][2].detectorMeta.positiveDeath).toBe(true);
    expect(deps.redispatch).toHaveBeenCalledTimes(1);
  });

  it("a LEGACY death with no claimStartedAt at all still fires (older-harness compatibility)", async () => {
    const workflow = workflowAt(T2);
    const { deps } = makeDeps({ workflow, events: eventsFor(undefined), nowMs: SWEEP_5784 });
    const m = await createDetector(deps).runSweep("enforce");

    expect(m.fired).toBe(1);
    expect(deps.redispatch).toHaveBeenCalledTimes(1);
  });
});

/**
 * TEAM-5977 / TEAM-5961 — a transient Bedrock outage outlasted the runtime's
 * stream retries. The runtime published agent.error, wrote the resume object
 * and published agent.died{reason:"transient_exhaustion", claimStartedAt} —
 * and told the ticket it "was released to dead-session recovery". With the
 * detector in its DEFAULT shadow mode that was false: the sweep only published
 * dead_session.shadow and the ticket sat in_progress forever. Now the claim
 * holder's own strict-matching exhaustion death promotes THAT candidate to the
 * unchanged enforce path (GUARD 1, both CAS steps, the re-check, the retry cap).
 * TEAM-6000: GUARD 1 reads that same death on a LIVE lease too, so the backoff
 * heartbeats that preceded it no longer hold the claim for the 30-min TTL.
 */
describe("replay TEAM-5961 — transient exhaustion releases in shadow mode (TEAM-5977)", () => {
  function exhaustionEvents({ claimStartedAt = CLAIMED_AT, reason = "transient_exhaustion", extra = [] } = {}) {
    const rows = runEvents().map((e) => {
      if (e.type !== "agent.died") return e;
      const detail = { ...e.detail, lastStreamAt: LAST_STREAM };
      delete detail.reason;
      // null = omit (a default parameter would swallow undefined).
      if (claimStartedAt !== null) detail.claimStartedAt = claimStartedAt;
      if (reason !== null) detail.reason = reason;
      return { ...e, detail };
    });
    return [...rows, ...extra];
  }
  const strictQueries = (inputs) => inputs.filter((i) => i.ExpressionAttributeValues?.[":dreason"] === "transient_exhaustion");

  it("a strict claim-holder exhaustion death is stolen and re-dispatched even in shadow", async () => {
    const workflow = makeWorkflow();
    const inputs = [];
    const { deps, store, ddb } = makeDeps({ workflow, events: exhaustionEvents(), onQuery: (i) => inputs.push(i) });
    const m = await createDetector(deps).runSweep("shadow");

    expect(m.mode).toBe("shadow");
    expect(m.fired).toBe(1);
    expect(strictQueries(inputs)).toHaveLength(1);
    expect(store.markDeadSessionDetected).toHaveBeenCalledWith(WF, TICKET, CLAIMED_AT);
    // stealClaim (the real one) issued its CAS'd UpdateCommand on THIS generation.
    const steal = ddb.updates.find((u) => u.ConditionExpression?.includes("startedAt = :exp"));
    expect(steal.ExpressionAttributeValues[":exp"]).toBe(CLAIMED_AT);
    const errs = eventsOfType(deps.publishEvent, "agent.error");
    expect(errs).toHaveLength(1);
    expect(errs[0][2].reason).toBe("dead_session");
    expect(errs[0][2].detectorMeta.effectiveMode).toBe("enforce");
    expect(errs[0][2].detectorMeta.positiveDeath).toBe(true);
    expect(store.incrementDeadSessionRetry).toHaveBeenCalledWith(WF, TICKET);
    expect(deps.redispatch).toHaveBeenCalledTimes(1);
    expect(eventsOfType(deps.publishEvent, "dead_session.shadow")).toHaveLength(0);
  });

  it("a LEGACY unstamped exhaustion death stays shadow-only (strict needs the claim stamp)", async () => {
    const inputs = [];
    const { deps, store, ddb } = makeDeps({ workflow: makeWorkflow(), events: exhaustionEvents({ claimStartedAt: null }), onQuery: (i) => inputs.push(i) });
    const m = await createDetector(deps).runSweep("shadow");

    expect(strictQueries(inputs)).toHaveLength(1); // asked, and the strict read said no
    const shadow = eventsOfType(deps.publishEvent, "dead_session.shadow");
    expect(shadow).toHaveLength(1);
    expect(shadow[0][2].detectorMeta.effectiveMode).toBe("shadow");
    expect(m.fired).toBe(1);
    expect(store.markDeadSessionDetected).not.toHaveBeenCalled();
    expect(ddb.updates).toHaveLength(0);
    expect(deps.redispatch).not.toHaveBeenCalled();
  });

  it("an exhaustion death stamped with a DIFFERENT generation stays shadow-only", async () => {
    // Swept 30 min later so the silence (70 min) is past the 60-min fallback
    // threshold: the shadow branch fires on the math, with no positive death.
    const { deps, store, ddb } = makeDeps({
      workflow: makeWorkflow(), events: exhaustionEvents({ claimStartedAt: "2026-09-14T20:00:00.000Z" }),
      nowMs: SWEEP_AT + 30 * 60 * 1000,
    });
    await createDetector(deps).runSweep("shadow");

    const shadow = eventsOfType(deps.publishEvent, "dead_session.shadow");
    expect(shadow).toHaveLength(1);
    expect(shadow[0][2].detectorMeta.positiveDeath).toBe(false);
    expect(shadow[0][2].detectorMeta.effectiveMode).toBe("shadow");
    expect(store.markDeadSessionDetected).not.toHaveBeenCalled();
    expect(ddb.updates).toHaveLength(0);
    expect(deps.redispatch).not.toHaveBeenCalled();
  });

  it("a claim-stamped death with no transient_exhaustion reason stays shadow-only", async () => {
    const inputs = [];
    const { deps, store, ddb } = makeDeps({ workflow: makeWorkflow(), events: exhaustionEvents({ reason: "no_completion" }), onQuery: (i) => inputs.push(i) });
    await createDetector(deps).runSweep("shadow");

    expect(strictQueries(inputs)).toHaveLength(1);
    const shadow = eventsOfType(deps.publishEvent, "dead_session.shadow");
    expect(shadow).toHaveLength(1);
    expect(shadow[0][2].detectorMeta.positiveDeath).toBe(true);
    expect(shadow[0][2].detectorMeta.effectiveMode).toBe("shadow");
    expect(store.markDeadSessionDetected).not.toHaveBeenCalled();
    expect(ddb.updates).toHaveLength(0);
    expect(deps.redispatch).not.toHaveBeenCalled();
  });

  // A heartbeat 2 min before the sweep: the backoff beats that precede an
  // exhaustion death, so GUARD 1 reads the lease as live.
  const liveBeat = [{ workflowId: WF, eventId: "4", type: "agent.streaming", timestamp: "2026-09-15T00:41:00.000Z", detail: { agentId: AGENT, ticketId: TICKET, type: "text", content: "> ⏳ Bedrock ServiceUnavailableException — retry 10/10 in 7s…" } }];

  it("TEAM-6000: a LIVE lease with the holder's own strict exhaustion death is stolen and re-dispatched on THIS sweep", async () => {
    const inputs = [];
    const { deps, store, ddb } = makeDeps({ workflow: makeWorkflow(), events: exhaustionEvents({ extra: liveBeat }), onQuery: (i) => inputs.push(i) });
    const m = await createDetector(deps).runSweep("shadow");

    expect(m.skippedLiveLease).toBe(0);
    expect(m.fired).toBe(1);
    expect(strictQueries(inputs)).toHaveLength(1); // GUARD 1's read; the promotion reuses it
    expect(store.markDeadSessionDetected).toHaveBeenCalledWith(WF, TICKET, CLAIMED_AT);
    const steal = ddb.updates.find((u) => u.ConditionExpression?.includes("startedAt = :exp"));
    expect(steal.ExpressionAttributeValues[":exp"]).toBe(CLAIMED_AT);
    const errs = eventsOfType(deps.publishEvent, "agent.error");
    expect(errs).toHaveLength(1);
    expect(errs[0][2].detectorMeta).toMatchObject({ positiveDeath: true, liveLeaseBypass: true, effectiveMode: "enforce" });
    expect(store.incrementDeadSessionRetry).toHaveBeenCalledWith(WF, TICKET);
    expect(deps.redispatch).toHaveBeenCalledTimes(1);
    expect(eventsOfType(deps.publishEvent, "dead_session.shadow")).toHaveLength(0);
  });

  it("TEAM-6000: the live-lease bypass needs THIS generation — an older-generation exhaustion death leaves a live lease alone", async () => {
    const inputs = [];
    const { deps, store, ddb } = makeDeps({ workflow: makeWorkflow(), events: exhaustionEvents({ claimStartedAt: "2026-09-14T20:00:00.000Z", extra: liveBeat }), onQuery: (i) => inputs.push(i) });
    const m = await createDetector(deps).runSweep("shadow");

    expect(m.skippedLiveLease).toBe(1);
    expect(m.fired).toBe(0);
    expect(strictQueries(inputs)).toHaveLength(1); // asked; the generation filter said no
    expect(store.markDeadSessionDetected).not.toHaveBeenCalled();
    expect(ddb.updates).toHaveLength(0);
    expect(deps.redispatch).not.toHaveBeenCalled();
  });

  it("TEAM-6000: the live-lease bypass needs reason transient_exhaustion — a claim-stamped no_completion death still waits for expiry", async () => {
    const inputs = [];
    const { deps, store, ddb } = makeDeps({ workflow: makeWorkflow(), events: exhaustionEvents({ reason: "no_completion", extra: liveBeat }), onQuery: (i) => inputs.push(i) });
    const m = await createDetector(deps).runSweep("shadow");

    expect(m.skippedLiveLease).toBe(1);
    expect(m.fired).toBe(0);
    expect(strictQueries(inputs)).toHaveLength(1);
    expect(store.markDeadSessionDetected).not.toHaveBeenCalled();
    expect(ddb.updates).toHaveLength(0);
    expect(deps.redispatch).not.toHaveBeenCalled();
  });

  it("retries exhausted (deadSessionRetries=2): a promoted death escalates, never loops", async () => {
    const workflow = { ...makeWorkflow(), deadSessionRetries: { [TICKET]: 2 } };
    const { deps, store } = makeDeps({ workflow, events: exhaustionEvents() });
    const m = await createDetector(deps).runSweep("shadow");

    expect(m.escalations).toBe(1);
    const esc = eventsOfType(deps.publishEvent, "agent.escalated");
    expect(esc).toHaveLength(1);
    expect(esc[0][2].reason).toBe("dead_session_retry_exhausted");
    expect(store.setTaskStatus).toHaveBeenCalledWith(WF, TICKET, "error");
    expect(deps.blockTicket).toHaveBeenCalledWith(TICKET, "dead_session_retry_exhausted");
    expect(store.incrementDeadSessionRetry).not.toHaveBeenCalled();
    expect(deps.redispatch).not.toHaveBeenCalled();
  });

  it("a lost detection CAS stops the promoted candidate — no steal, no dispatch", async () => {
    const { deps, store, ddb } = makeDeps({ workflow: makeWorkflow(), events: exhaustionEvents() });
    store.markDeadSessionDetected.mockResolvedValue(false);
    const m = await createDetector(deps).runSweep("shadow");

    expect(store.markDeadSessionDetected).toHaveBeenCalledWith(WF, TICKET, CLAIMED_AT);
    expect(ddb.updates).toHaveLength(0);
    expect(eventsOfType(deps.publishEvent, "agent.error")).toHaveLength(0);
    expect(eventsOfType(deps.publishEvent, "dead_session.shadow")).toHaveLength(0);
    expect(deps.redispatch).not.toHaveBeenCalled();
    expect(m.fired).toBe(0);
  });

  it("backstop: a stolen-but-stalled task with a strict exhaustion death is re-driven in shadow", async () => {
    const workflow = makeWorkflow({ status: "ready", deadSessionDetectedAt: "2026-09-15T00:44:00.000Z" });
    const inputs = [];
    const { deps, store } = makeDeps({ workflow, events: exhaustionEvents(), onQuery: (i) => inputs.push(i) });
    await createDetector(deps).runSweep("shadow");

    expect(strictQueries(inputs)).toHaveLength(1);
    expect(store.getWorkflow).toHaveBeenCalledWith(WF);
    expect(store.incrementDeadSessionRetry).toHaveBeenCalledWith(WF, TICKET);
    expect(deps.redispatch).toHaveBeenCalledTimes(1);
  });

  it("backstop: without a strict exhaustion death the stalled task stays observe-only in shadow", async () => {
    const workflow = makeWorkflow({ status: "ready", deadSessionDetectedAt: "2026-09-15T00:44:00.000Z" });
    const inputs = [];
    const { deps, store } = makeDeps({ workflow, events: exhaustionEvents({ reason: "no_completion" }), onQuery: (i) => inputs.push(i) });
    await createDetector(deps).runSweep("shadow");

    expect(strictQueries(inputs)).toHaveLength(1); // asked, and the strict read said no
    expect(store.getWorkflow).not.toHaveBeenCalled();
    expect(store.incrementDeadSessionRetry).not.toHaveBeenCalled();
    expect(deps.redispatch).not.toHaveBeenCalled();
  });
});
