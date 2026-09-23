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
 *     the earliest a death can be reaped is when the 30-min lease has expired;
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
            const typed = (v[":died"] && e.type === v[":died"])
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

  it("agent.died newer than the claim reaps without waiting for the 30-minute TTL", async () => {
    // The same death row plus a fresh heartbeat: TEAM-4889 reads died before
    // GUARD 1 and passes positiveDeath into isLeaseLive, so a runtime-finally
    // death for this generation cannot be resurrected by prior activity.
    const events = [
      ...runEvents(),
      { workflowId: WF, eventId: "4", type: "agent.streaming", timestamp: "2026-09-15T00:43:00.000Z", detail: { agentId: AGENT, ticketId: TICKET, type: "text", content: "last output before finally" } },
    ];
    const shapes = [];
    const workflow = makeWorkflow();
    const { deps } = makeDeps({ workflow, events, onQuery: (i) => shapes.push(i.ExpressionAttributeValues) });
    const m = await createDetector(deps).runSweep("enforce");

    expect(m.fired).toBe(1);
    expect(deps.redispatch).toHaveBeenCalledTimes(1);
    expect(shapes.some((v) => v[":died"])).toBe(true);
  });

  it("the reap is bounded by the first rate(5 minutes) sweep at/after agent.died", async () => {
    // A sweep one tick EARLIER (00:40, before the 00:41:08 death) sees nothing
    // to reap; the next tick does. There is still no sub-minute push path — the
    // bound is the scheduled sweep, not the event publish.
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
