import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createReconcileSweep } from "./reconcile-sweep.mjs";
import { createCascade } from "./cascade.mjs";
import { createDeadSessionEscalation } from "./dead-session-escalation.mjs";

/**
 * TEAM-4120 FR-3 ACCEPTANCE REPLAY — the yteqfl dead release manager.
 *
 * Fixture: deploy/workflow-manager/toolkit/fixtures/yteqfl-dossier.json (ticket
 * rows, workflow row and events verbatim), reduced from
 *   s3://agentcore-hub-artifacts-838829463875-us-east-1/workflows/
 *     wf_1788582225496_yteqfl/analysis/1788636963523-wsgf/dossier.json
 *
 * SLICE 06:51:10.346Z → 07:36:10.154Z. What really happened:
 *   06:51:10.346Z  the release manager claims TEAM-4066 ("Ship: submit_workflow
 *                  source validation fix", blockedBy [TEAM-4065]) — and goes
 *                  silent. Its ONE automatic re-dispatch is already spent
 *                  (workflow.deadSessionRetries["TEAM-4066"] === 1).
 *   06:59–07:14Z   six tickets are filed inside that dead claim (TEAM-4101…4106
 *                  — the ship-review r2 fixes plus the QA/CI re-verify chain).
 *   07:36:10.154Z  the reconcile sweep publishes agent.escalated
 *                  {reason:"dead_session_retry_exhausted", source:"reconcile-sweep",
 *                  claimStartedAt:"2026-09-05T06:51:10.346Z"} and appends the
 *                  EVIDENCE-FREE page {reviewer:"reconcile-sweep", title:"Dead
 *                  session (retry exhausted): TEAM-4066"}. cascade.mjs
 *                  escalationHeld then pins the ticket in `error` forever.
 *   09:28:31Z      the last of those six children (TEAM-4104) finishes — the
 *                  Workflow Manager's OWN stated resume condition for the run.
 *   11:02:30Z      a human/WM manual nudge finally re-drives TEAM-4066, because
 *                  4066's blockedBy lists only TEAM-4065, so no cascade could
 *                  ever re-fire on the children it had just spawned.
 *
 * The tree replaces that dead end with blockers: block TEAM-4066 on the children
 * it spawned and hand its retry budget back, so the ordinary reconcile path
 * re-drives it as soon as they land — within one sweep interval of 09:28:31Z,
 * about 94 minutes earlier than the manual nudge, with no human in the loop.
 *
 * TWO FIXTURES, because the ticket's stated AC and the real board disagree and
 * both deserve pinning:
 *   A "literal acceptance" — only the tickets that existed at 07:00:20Z
 *     (TEAM-4101, TEAM-4102), the pair the AC names.
 *   B "full real slice" — all six in-window tickets, as production had them.
 * They also cover the OTHER documented discrepancy: the design's literal "spawned
 * children are the in-window tickets with an empty blockedBy" rule would select
 * {TEAM-4101, TEAM-4105} and DROP the 4101→4102→4103→4104 chain the dying
 * release manager had just built; the implemented dependency-CLOSURE rule keeps
 * it (selectChildren, dead-session-escalation.mjs) — so fixture A's expected
 * children are [4101, 4102], not [4101] alone.
 *
 * Everything is injected: the REAL sweep drives the REAL cascade drives the REAL
 * escalation tree, over an in-memory board + workflow row and a fake clock. No
 * AWS, no timers (reconcileDependent never sleeps — only cascadeUnblock's
 * deferred-retry path does, and the sweep does not use it).
 */

const DOSSIER = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../deploy/workflow-manager/toolkit/fixtures/yteqfl-dossier.json", import.meta.url)), "utf8")
);

/** A ticket row exactly as the dossier recorded it (throws if the fixture moves). */
function fixtureTicket(ticketId) {
  const row = DOSSIER.tickets.find((t) => t.ticketId === ticketId);
  if (!row) throw new Error(`yteqfl fixture has no ${ticketId}`);
  return row;
}

const WF_ID = "wf_1788582225496_yteqfl";
const EPIC = "TEAM-4054";
const HELD = "TEAM-4066";
const RM = "agentcore_hub_release_manager";
const BLOCKER = "TEAM-4065"; // 4066's ONLY real blocker — done long before the claim
const CLAIM_STARTED = "2026-09-05T06:51:10.346Z";
const ESCALATED_AT = "2026-09-05T07:36:10.154Z";
const LAST_HEARD = "2026-09-05T06:52:00.000Z"; // RM's last stream, ~45m before the sweep
const TTL_MS = 30 * 60 * 1000;

/** The six tickets created inside the dead claim, in creation order. */
const IN_WINDOW = ["TEAM-4101", "TEAM-4102", "TEAM-4103", "TEAM-4104", "TEAM-4105", "TEAM-4106"];
/** The pair the ticket's AC names (everything that existed at 07:00:20Z). */
const AC_WINDOW = ["TEAM-4101", "TEAM-4102"];

/**
 * When each child actually finished, from its dev-/qa-evidence artifact time.
 * NOT monotonic (TEAM-4105 closed at 07:15:57Z, before the escalation, and
 * TEAM-4101 eight seconds before it) — the replay clamps the clock forward
 * rather than rewinding it, which changes nothing: a child that is already done
 * when we select it is still evidence, `selectChildren` excludes only cancelled.
 */
const DONE_ORDER = [
  ["TEAM-4101", "2026-09-05T07:36:02Z"],
  ["TEAM-4102", "2026-09-05T07:54:43Z"],
  ["TEAM-4105", "2026-09-05T07:15:57Z"],
  ["TEAM-4106", "2026-09-05T08:14:03Z"],
  ["TEAM-4103", "2026-09-05T09:22:46Z"],
  ["TEAM-4104", "2026-09-05T09:28:31Z"],
];

/**
 * The RM's last streamed line. Carries a token on purpose: the page is what
 * leaves the account (Telegram), so the replay asserts the real end-to-end join
 * → redact → clip order, not just the unit-level pattern table.
 */
const LAST_TEXT = `merging PR #371 for TEAM-4054 with token=ghp_${"a".repeat(36)} — transitioning TEAM-4066`;

/**
 * One world = one in-memory board + workflow row + the real sweep/cascade/tree
 * wired together. `children` picks the fixture (A or B); `wireEscalation:false`
 * is the mode-off regression (escalate unwired, exactly as production is with
 * DEAD_SESSION_ESCALATION_MODE unset).
 */
// What the tickets Lambda answers create_ticket with. DynamoDB's shape by default
// (yteqfl was a dynamodb-mode run); jira answers `{ ticketId }` (TEAM-4156). This
// suite injects `invokeTickets` directly rather than mocking the Lambda boundary,
// so swapping the shape exercises dead-session-escalation's own reader, not
// index.mjs's normalization.
const DDB_CREATE_REPLY = () => ({ key: "TEAM-NEVER" });

function makeWorld({ children = IN_WINDOW, wireEscalation = true, createReply = DDB_CREATE_REPLY } = {}) {
  let clock = Date.parse(ESCALATED_AT);
  const nowIso = () => new Date(clock).toISOString();

  // ── the board ──
  // updatedAt is the parked-window input (reconcile-sweep parkedLongEnough); the
  // held ticket and its blocker carry pre-claim timestamps, and each child keeps
  // the createdAt the dossier recorded, so the window filter is real data rather
  // than something tuned to make the assertions pass.
  const tickets = {};
  const seed = (id, over) => { tickets[id] = { ...fixtureTicket(id), ...over }; };
  seed(EPIC, { status: "in_progress", updatedAt: "2026-09-05T06:00:00Z" });
  seed(BLOCKER, { status: "done", updatedAt: "2026-09-05T06:06:51Z" });
  seed(HELD, { status: "in_progress", updatedAt: "2026-09-05T06:00:00Z" });
  for (const id of children) seed(id, { status: "in_progress", updatedAt: fixtureTicket(id).createdAt });

  // ── the workflow row, as it read at 07:36:10Z ──
  // The task status is "running", not "error": `error` is what THIS escalation is
  // about to write, and pre-setting it would trip cascade.mjs escalationHeld and
  // make the exhaustion path unreachable.
  const wf = {
    id: WF_ID, workflowId: WF_ID, epicId: EPIC, phase: "ship",
    workflowDefId: DOSSIER.workflow.workflowDefId,
    updatedAt: CLAIM_STARTED,
    repoConfig: DOSSIER.workflow.repoConfig,
    humanNotifications: [],
    deadSessionRetries: { [HELD]: 1 },
    agentTasks: {
      [HELD]: { id: "task_1788583106127_agentcore_hub_release_manager", agentId: RM, ticketId: HELD, status: "running", startedAt: CLAIM_STARTED },
    },
  };

  // ── store: the real write semantics, in memory ──
  const store = {
    setTaskStatus: vi.fn(async (_wf, tid, status) => { if (wf.agentTasks[tid]) wf.agentTasks[tid].status = status; }),
    incrementDeadSessionRetry: vi.fn(async (_wf, tid) => { wf.deadSessionRetries[tid] = (wf.deadSessionRetries[tid] || 0) + 1; }),
    // REMOVE deadSessionRetries.<tid> — the budget is handed back, not zeroed.
    resetDeadSessionRetry: vi.fn(async (_wf, tid) => { delete wf.deadSessionRetries[tid]; return true; }),
    mergeTaskMetadata: vi.fn(async (_wf, tid, fields) => { Object.assign((wf.agentTasks[tid] ||= {}), fields); }),
    // Security F5 CAS: attribute_not_exists(deadSessionSynthesized.<tid>).
    claimDeadSessionSynthesis: vi.fn(async (_wf, tid) => {
      wf.deadSessionSynthesized ||= {};
      if (wf.deadSessionSynthesized[tid]) return false;
      wf.deadSessionSynthesized[tid] = 1;
      return true;
    }),
    appendNotification: vi.fn(async (_wf, notification) => { wf.humanNotifications.push(notification); }),
  };

  // ── lease: only the held ticket reads stale ──
  // The other in-window agents were genuinely streaming, so R3 gates them to a
  // nudge (and the sweep's own suppression makes even that a no-op) — which is
  // also what keeps this replay's assertions about TEAM-4066 unambiguous.
  const lease = {
    LEASE_TTL_MS: TTL_MS,
    lastAgentActivity: vi.fn(async (_d, _t, _w, _agentId, tid) => (tid === HELD ? LAST_HEARD : nowIso())),
    isLeaseLive: vi.fn((_task, lastActivity, nowMs) => {
      const ms = Date.parse(lastActivity || "");
      return Number.isFinite(ms) && nowMs - ms < TTL_MS;
    }),
    stealClaim: vi.fn(async () => true),
    lastStreamedText: vi.fn(async () => LAST_TEXT),
    hasAgentErrorSince: vi.fn(async () => false),
  };

  // ── effects ──
  const events = [];
  const publishEvent = vi.fn(async (ticketId, type, detail) => { events.push({ ticketId, type, detail }); });
  const getChildTickets = vi.fn(async (parentId) => Object.values(tickets).filter((t) => t.parentId === parentId || t.ticketId === parentId));
  const getTicket = vi.fn(async (id) => tickets[id] || null);
  const addBlockers = vi.fn(async (ticketId, ids) => {
    const t = tickets[ticketId];
    if (!t) return;
    t.blockedBy = [...(t.blockedBy || []), ...ids.filter((i) => !(t.blockedBy || []).includes(i))];
    t.status = "blocked";
  });
  const blockTicket = vi.fn(async (ticketId) => { if (tickets[ticketId]) tickets[ticketId].status = "blocked"; });
  const redispatchedIds = [];
  const redispatch = vi.fn(async (_wf, sibling) => { redispatchedIds.push(sibling.ticketId); return true; });
  const invokeTickets = vi.fn(async (_tool, params) => createReply(params));
  const parkGateForHuman = vi.fn(async () => {});
  const transitionTicket = vi.fn(async () => {});
  const s3Get = vi.fn(async () => null);
  const ddb = { send: vi.fn(async (cmd) => (cmd.constructor.name === "ScanCommand" ? { Items: [wf] } : {})) };

  const escalation = createDeadSessionEscalation({
    mode: "enforce",
    store, lease, ddb, eventsTable: "events",
    getChildTickets, getTicket, invokeTickets,
    // No completion record existed at 07:36 — the one in the dossier was written
    // 11:20:02.551Z, after the manual re-dispatch. Serving today's bucket here
    // would be a time-travel error, not a better fixture.
    s3Get,
    githubApi: undefined,
    addBlockers, parkGateForHuman, publishEvent, transitionTicket,
    now: () => clock,
    log: { log: () => {}, warn: () => {} },
  });

  const cascade = createCascade({
    ddb, ticketsTable: "tickets", provider: "dynamodb",
    jiraTransition: vi.fn(async () => {}),
    getChildTickets, publishEvent,
    now: () => clock, log: () => {},
    extendedStates: "enforce",
    lease, eventsTable: "events", workflowsTable: "workflows",
    redispatch, reawakenGate: vi.fn(async () => true),
    store, blockTicket,
    ...(wireEscalation ? { escalate: escalation.escalateExhausted } : {}),
  });

  const sweep = createReconcileSweep({
    ddb, workflowsTable: "workflows", cascade, getChildTickets,
    leaseTtlMs: TTL_MS, now: () => clock, log: () => {},
  });

  /** One sweep tick, optionally advancing the clock (never backwards). */
  const tick = async (atIso) => {
    if (atIso) clock = Math.max(clock + 1000, Date.parse(atIso));
    return sweep.runSweep("enforce");
  };
  const markDone = (id) => { tickets[id].status = "done"; tickets[id].updatedAt = nowIso(); };

  return {
    wf, tickets, store, lease, events, publishEvent, getChildTickets,
    addBlockers, blockTicket, redispatch, redispatchedIds,
    invokeTickets, parkGateForHuman, transitionTicket, s3Get,
    tick, markDone, at: () => nowIso(),
    notifications: () => wf.humanNotifications,
    eventsOfType: (type) => events.filter((e) => e.type === type),
  };
}

// The sweep + cascade emit their EMF summaries straight to console.log (their
// injected `log` is a no-op). Those records are asserted in
// reconcile-sweep.test.mjs; here they are just noise across seven ticks.
let quiet;
beforeEach(() => { quiet = vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => quiet.mockRestore());

describe("fixture A — the literal acceptance slice (TEAM-4101 + TEAM-4102)", () => {
  it("blocks TEAM-4066 on the two tickets it spawned and hands its retry budget back", async () => {
    const w = makeWorld({ children: AC_WINDOW });

    const m = await w.tick();

    // The upstream emitter is unchanged: agent.escalated with the real reason +
    // source + claimStartedAt the dossier recorded.
    expect(m.escalated).toBe(1);
    const escalated = w.eventsOfType("agent.escalated");
    expect(escalated).toHaveLength(1);
    expect(escalated[0].detail).toMatchObject({
      workflowId: WF_ID, ticketId: HELD, agentId: RM,
      reason: "dead_session_retry_exhausted", source: "reconcile-sweep",
      claimStartedAt: CLAIM_STARTED,
    });

    // The synthesis: blocked on the closure, budget handed back, provenance stamped.
    expect(w.addBlockers).toHaveBeenCalledTimes(1);
    expect(w.addBlockers).toHaveBeenCalledWith(HELD, ["TEAM-4101", "TEAM-4102"]);
    expect(w.tickets[HELD].blockedBy).toEqual([BLOCKER, "TEAM-4101", "TEAM-4102"]);
    expect(w.wf.deadSessionRetries[HELD]).toBeUndefined();
    expect(w.wf.agentTasks[HELD]).toMatchObject({
      status: "error", synthesized: true, evidenceSource: "children", children: ["TEAM-4101", "TEAM-4102"],
    });
    expect(w.eventsOfType("agent.escalation_synthesized")).toHaveLength(1);
    expect(w.eventsOfType("agent.escalation_synthesized")[0].detail).toMatchObject({
      workflowId: WF_ID, ticketId: HELD, evidenceSource: "children", children: ["TEAM-4101", "TEAM-4102"],
    });
  });

  it("pages ONCE, with evidence, and the evidence-free legacy page is gone", async () => {
    const w = makeWorld({ children: AC_WINDOW });

    await w.tick();

    expect(w.notifications()).toHaveLength(1);
    const notif = w.notifications()[0];
    expect(notif).toMatchObject({
      type: "manager_escalation",
      reviewer: "dead-session-escalation",
      source: "reconcile-sweep",       // which emitter buried the claim
      ticketId: HELD,
      agentId: RM,
      ticketTitle: "Ship: submit_workflow source validation fix",
      disposition: "synthesized_children",
      children: ["TEAM-4101", "TEAM-4102"],
      acknowledged: false,
    });
    // No completion record at 07:36, and no PR lookup wired → both honestly empty.
    expect(notif.artifacts).toEqual({ completionRecord: false, prUrl: null });
    // Join → redact → clip, end to end: the page carries the RM's last words
    // with the token removed.
    expect(notif.lastText).toContain("merging PR #371");
    expect(notif.lastText).toContain("[REDACTED]");
    expect(notif.lastText).not.toContain("ghp_");

    // The two pre-4120 pages must not ALSO be written — that would double-page.
    const legacy = w.notifications().filter((n) => n.reviewer === "reconcile-sweep" || n.reviewer === "dead-session-detector");
    expect(legacy).toEqual([]);
    expect(w.notifications().some((n) => /^Dead session \(retry exhausted\)/.test(n.title || ""))).toBe(false);
  });

  it("reads liveness + errors for the claim it is burying, and writes nothing else", async () => {
    const w = makeWorld({ children: AC_WINDOW });

    await w.tick();

    // The error probe is scoped to THIS claim (a pre-claim agent.error belongs to
    // a different attempt — yteqfl's only agent.error is at 06:39:24Z, before it).
    expect(w.lease.hasAgentErrorSince).toHaveBeenCalledTimes(1);
    expect(w.lease.hasAgentErrorSince.mock.calls[0].slice(1)).toEqual(["events", WF_ID, HELD, CLAIM_STARTED]);
    expect(w.lease.lastStreamedText).toHaveBeenCalledTimes(1);

    // R3: no claim stolen, no agent invoked, no ticket closed, no human gate —
    // synthesis is blockers + a budget reset, nothing else.
    expect(w.lease.stealClaim).not.toHaveBeenCalled();
    expect(w.redispatch).not.toHaveBeenCalled();
    expect(w.invokeTickets).not.toHaveBeenCalled();
    expect(w.parkGateForHuman).not.toHaveBeenCalled();
    expect(w.transitionTicket).not.toHaveBeenCalled();
    expect(w.store.incrementDeadSessionRetry).not.toHaveBeenCalled();
  });

  it("stays put while the children are open, then ONE reconcile tick re-drives it", async () => {
    const w = makeWorld({ children: AC_WINDOW });
    await w.tick();

    // Children still in flight → not even a candidate (blockers unresolved).
    const open = await w.tick("2026-09-05T08:00:00Z");
    expect(w.redispatchedIds).toEqual([]);
    expect(open.redispatched).toBe(0);

    w.markDone("TEAM-4101");
    w.markDone("TEAM-4102");
    const resumed = await w.tick("2026-09-05T08:30:00Z");

    // escalationHeld released itself (the budget was handed back), the lease is
    // still stale, and the ticket is blocked → the ordinary claim-CAS dispatch.
    expect(resumed.redispatched).toBe(1);
    expect(resumed.escalationHeld).toBe(0);
    expect(w.redispatchedIds).toEqual([HELD]);
    expect(w.redispatch.mock.calls[0][1].ticketId).toBe(HELD);
  });
});

describe("fixture B — the full real slice (all six in-window tickets)", () => {
  it("selects the whole dependency closure the dying release manager built", async () => {
    const w = makeWorld();

    await w.tick();

    // Sorted by creation: the 4101→4102→4103→4104 chain plus the two fixes filed
    // by concurrent agents in the same window. The literal "empty blockedBy" rule
    // would have selected only [4101, 4105].
    expect(w.addBlockers).toHaveBeenCalledWith(HELD, IN_WINDOW);
    expect(w.notifications()[0].children).toEqual(IN_WINDOW);
    expect(w.tickets[HELD].blockedBy).toEqual([BLOCKER, ...IN_WINDOW]);
  });

  it("re-drives TEAM-4066 on the tick after the LAST child lands, and not before", async () => {
    const w = makeWorld();
    await w.tick();

    // Replay the real completion order, one sweep tick after each.
    const table = [];
    for (const [id, at] of DONE_ORDER) {
      w.markDone(id);
      const m = await w.tick(at);
      table.push([id, m.candidates, m.redispatched, m.skippedLiveLease]);
    }

    // [child closed, candidates, redispatched, skippedLiveLease] per tick.
    expect(table).toEqual([
      ["TEAM-4101", 1, 0, 1],
      ["TEAM-4102", 3, 0, 3],
      ["TEAM-4105", 2, 0, 2],
      ["TEAM-4106", 1, 0, 1],
      ["TEAM-4103", 1, 0, 1],
      ["TEAM-4104", 1, 1, 0],
    ]);
    // Exactly one re-dispatch, of the held ticket, on the 4104 tick — i.e. within
    // one sweep interval of 09:28:31Z instead of the 11:02:30Z manual nudge.
    expect(w.redispatchedIds).toEqual([HELD]);
    expect(w.eventsOfType("agent.escalated")).toHaveLength(1);
    expect(w.notifications()).toHaveLength(1);
  });

  it("a second death with nothing new to show parks on ONE human gate", async () => {
    const w = makeWorld();
    await w.tick();

    // The resumed RM claims at 09:30 and dies again, budget re-spent. Its claim
    // window contains no new tickets (the six all predate it) and there is still
    // no completion record — so there is no evidence left to synthesize from.
    w.wf.agentTasks[HELD] = { agentId: RM, ticketId: HELD, status: "running", startedAt: "2026-09-05T09:30:00.000Z" };
    w.wf.deadSessionRetries[HELD] = 1;
    w.tickets[HELD].status = "in_progress";
    for (const id of IN_WINDOW) w.markDone(id);

    const m = await w.tick("2026-09-05T10:15:00Z");

    // Park, not another round of blockers. The F5 synthesis CAS is NOT spent here
    // (the park is reached without it), so an attempt that does spawn work later
    // can still synthesize.
    expect(m.escalated).toBe(1);
    expect(w.store.claimDeadSessionSynthesis).toHaveBeenCalledTimes(1);
    expect(w.invokeTickets).toHaveBeenCalledTimes(1);
    expect(w.invokeTickets.mock.calls[0][1]).toMatchObject({
      summary: `Escalation: dead session on ${HELD} (${RM})`,
      assignee: "human:engineer",
      parent_key: EPIC,
      blocked_by: [],
    });
    expect(w.parkGateForHuman).toHaveBeenCalledWith("TEAM-NEVER", "human:engineer", w.wf);
    expect(w.notifications()).toHaveLength(2);
    expect(w.notifications()[1]).toMatchObject({ disposition: "parked", gateTicketId: "TEAM-NEVER" });
  });

  it("the same park under TICKET_PROVIDER=jira still gates on the human (TEAM-4156)", async () => {
    // jira's create_ticket answers `{ ticketId }`. Before TEAM-4156 the park read
    // `key` only, so in jira mode the gate ticket landed on the board and was then
    // reported missing: no blocker on TEAM-4066, nothing handed to a human, and the
    // disposition degraded to "shadow" — prod's stall with extra bookkeeping.
    const w = makeWorld({
      createReply: () => ({ ticketId: "TEAM-NEVER", status: "created", message: "Created TEAM-NEVER" }),
    });
    await w.tick();

    w.wf.agentTasks[HELD] = { agentId: RM, ticketId: HELD, status: "running", startedAt: "2026-09-05T09:30:00.000Z" };
    w.wf.deadSessionRetries[HELD] = 1;
    w.tickets[HELD].status = "in_progress";
    for (const id of IN_WINDOW) w.markDone(id);

    const m = await w.tick("2026-09-05T10:15:00Z");

    expect(m.escalated).toBe(1);
    expect(w.invokeTickets).toHaveBeenCalledTimes(1);
    expect(w.parkGateForHuman).toHaveBeenCalledWith("TEAM-NEVER", "human:engineer", w.wf);
    // The gate is in the held ticket's blockedBy, so its own done cascade resumes it.
    expect(w.tickets[HELD].blockedBy).toContain("TEAM-NEVER");
    expect(w.notifications()[1]).toMatchObject({ disposition: "parked", gateTicketId: "TEAM-NEVER" });
  });
});

describe("regression — mode off reproduces the prod dead end byte for byte", () => {
  it("writes the evidence-free page, keeps the budget spent, and stalls forever", async () => {
    const w = makeWorld({ children: AC_WINDOW, wireEscalation: false });

    const m = await w.tick();

    expect(m.escalated).toBe(1);
    expect(w.notifications()).toHaveLength(1);
    expect(w.notifications()[0]).toMatchObject({
      type: "manager_escalation",
      title: `Dead session (retry exhausted): ${HELD}`,
      reviewer: "reconcile-sweep",
      ticketId: HELD,
      acknowledged: false,
    });
    // No evidence, no resume path: the budget stays spent and blockedBy still
    // lists only TEAM-4065, so nothing the children do can ever re-fire a cascade.
    expect(w.wf.deadSessionRetries[HELD]).toBe(1);
    expect(w.addBlockers).not.toHaveBeenCalled();
    expect(w.tickets[HELD].blockedBy).toEqual([BLOCKER]);

    // Every child finishes — including TEAM-4104 at 09:28:31Z, the WM's own
    // stated resume condition — and the sweep still refuses to re-drive it:
    // escalationHeld pins the ticket for a human. This is the 3h26m stall the
    // run actually took, and the acceptance criterion for FR-3.
    for (const [id, at] of DONE_ORDER.filter(([id]) => AC_WINDOW.includes(id))) {
      w.markDone(id);
      await w.tick(at);
    }
    const held = await w.tick("2026-09-05T09:28:31Z");
    expect(held.escalationHeld).toBe(1);
    expect(held.redispatched).toBe(0);
    expect(w.redispatchedIds).toEqual([]);
  });
});
