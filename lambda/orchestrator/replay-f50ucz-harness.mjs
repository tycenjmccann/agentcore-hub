import { vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAwaitedIds } from "./awaited-ids.mjs";
import { createCascade } from "./cascade.mjs";
import { createReconcileSweep } from "./reconcile-sweep.mjs";

/**
 * TEAM-4166 — the shared in-memory harness for the two f50ucz acceptance replays
 * (replay-f50ucz-ship-rewake.test.mjs = D1, replay-f50ucz-liveness.test.mjs = D2).
 *
 * ONE board + workflow row + fake clock, wired to the REAL awaited-ids + cascade +
 * reconcile-sweep exactly as index.mjs wires them (only AWS + the provider seams
 * are fakes). No AWS, no timers. Not a test file itself — imported by the two
 * replays (and so excluded from the vitest include allow-list on purpose).
 *
 * Fixture: fixtures/f50ucz-ship-rewake.json (reduced from the workflow's dossier).
 *
 * WHAT REALLY HAPPENED (the bug the fix removes):
 *   07:07–07:08Z  the release manager on TEAM-4126 (Ship) files ship-review r1
 *                 fixes TEAM-4155/4156 (spawnedBy.shipTicketId=TEAM-4126) + a CI
 *                 re-cert TEAM-4157 (spawnedBy.ciTicketId=TEAM-4125, already DONE),
 *                 and parks its OWN ticket in_progress on a sub-cap CHANGES-NEEDED.
 *   07:43:10.259Z the RM re-claims TEAM-4126 (deadSessionRetries already = 1).
 *   07:45:00Z     the RM session EXITS CLEANLY (invoke OK, no report_completion) —
 *                 the ticket is left in_progress, blockedBy frozen at [TEAM-4125]
 *                 (long done); nothing lists the awaited fixes.
 *   08:15:10.430Z the reconcile sweep, seeing a spent retry budget + a stale lease,
 *                 FALSELY escalates dead_session_retry_exhausted (the D2 bug).
 *   08:19–08:27Z  the awaited fixes land — but 4126's blockedBy never listed them,
 *                 so no cascade re-fires. It sat until a 19:46Z human nudge.
 */

const FX = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/f50ucz-ship-rewake.json", import.meta.url)), "utf8")
);

export { FX };
export const WF_ID = FX.workflowId;
export const EPIC = FX.epicId; // TEAM-4116
export const SHIP = "TEAM-4126";
export const CI_DONE = "TEAM-4125"; // 4157's origin — DONE long before the window
export const FIX_A = "TEAM-4155";   // ship_fix → TEAM-4126
export const FIX_B = "TEAM-4156";   // ship_fix → TEAM-4126
export const FIX_CI = "TEAM-4157";  // ci_fix   → TEAM-4125 (DONE → spawn skipped)

export const PARKED = FX.parkedSnapshot[SHIP];
export const CLAIM_STARTED = PARKED.agentTask.startedAt; // 2026-09-06T07:43:10.259Z
export const TTL_MS = 30 * 60 * 1000;

/** When each fix ticket actually completed, from the fixture's agentTasks. */
export const COMPLETED = Object.fromEntries(
  [FIX_A, FIX_B, FIX_CI].map((id) => [id, FX.workflow.agentTasks[id].completedAt])
);
// TEAM-4155 07:42:38.973Z, TEAM-4156 08:19:27.775Z, TEAM-4157 08:27:48.071Z.

/** The spawnedBy block the fixture reconstructed from each fix ticket's contract. */
export const fxSpawnedBy = (id) => FX.tickets.find((t) => t.ticketId === id)?.spawnedBy;

/**
 * One world. `provider` swaps only the addBlockers seam (dynamodb applyBlockerEdge
 * semantics vs. jira issue-links); `awaitedMode` is the AWAITED_IDS_MODE under
 * test; `holdOpen` names fix tickets that must NEVER reach done (FR-1.4 / FR-2.1);
 * `startClock` overrides the window start.
 */
export function makeWorld({
  provider = "dynamodb",
  awaitedMode = "enforce",
  timeoutMinutes = 120,
  holdOpen = [],
  startClock = "2026-09-06T07:07:00Z",
} = {}) {
  let clock = Date.parse(startClock);
  const nowIso = () => new Date(clock).toISOString();
  const held = new Set(holdOpen);

  // ── the board. Fix tickets start in_progress and flip to done once the clock
  //    passes their real completedAt (rewind semantics); TEAM-4126 is frozen
  //    in_progress (its completedAt 20:13Z is never reached in the slice), and
  //    TEAM-4125 is done from the start. ──
  const tickets = {
    [EPIC]: { ticketId: EPIC, type: "epic", status: "done", blockedBy: [] },
    [CI_DONE]: { ticketId: CI_DONE, type: "task", status: "done", assignee: "agentcore_hub_ci_agent", parentId: EPIC, blockedBy: [] },
    [SHIP]: { ticketId: SHIP, type: "task", status: "in_progress", assignee: "agentcore_hub_release_manager", parentId: EPIC, blockedBy: [...PARKED.blockedBy], updatedAt: CLAIM_STARTED },
    [FIX_A]: { ticketId: FIX_A, type: "task", status: "in_progress", assignee: "agentcore_hub_backend_dev", parentId: EPIC, blockedBy: [], updatedAt: nowIso() },
    [FIX_B]: { ticketId: FIX_B, type: "task", status: "in_progress", assignee: "agentcore_hub_backend_dev", parentId: EPIC, blockedBy: [FIX_A], updatedAt: nowIso() },
    [FIX_CI]: { ticketId: FIX_CI, type: "task", status: "in_progress", assignee: "agentcore_hub_ci_agent", parentId: EPIC, blockedBy: [FIX_A, FIX_B], updatedAt: nowIso() },
  };
  const syncClock = () => {
    for (const id of [FIX_A, FIX_B, FIX_CI]) {
      if (!held.has(id) && clock >= Date.parse(COMPLETED[id])) tickets[id].status = "done";
    }
  };

  // ── the workflow row, as it read while TEAM-4126 was parked ──
  const wf = {
    id: WF_ID, workflowId: WF_ID, epicId: EPIC, phase: "ship",
    workflowDefId: FX.workflowDefId,
    updatedAt: CLAIM_STARTED,
    deadSessionRetries: { [SHIP]: PARKED.deadSessionRetries }, // { TEAM-4126: 1 }
    cleanExitRedispatches: {},
    humanNotifications: [],
    agentTasks: {
      // The parked RM claim: running, startedAt at the re-claim, NO completedAt.
      [SHIP]: { agentId: "agentcore_hub_release_manager", ticketId: SHIP, status: "running", startedAt: CLAIM_STARTED },
    },
  };

  // ── the ONE provider-aware addBlockers seam (index.mjs addBlockers). Both
  //    branches append the edge (deduped) and return the list of NEWLY-added ids,
  //    OMITTING an already-present id (the idempotent no-op the real seam signals
  //    by omission). preserveStatusIf keeps a parked in_progress/in_review agent
  //    where it is; otherwise the ticket flips to blocked. ──
  const issueLinks = []; // jira: the is-blocked-by links written
  const addBlockers = vi.fn(async (ticketId, ids, opts = {}) => {
    const t = tickets[ticketId];
    if (!t) return [];
    const preserve = opts.preserveStatusIf || [];
    const added = [];
    for (const id of Array.isArray(ids) ? ids : [ids]) {
      if ((t.blockedBy || []).includes(id)) continue; // present → omit (idempotent)
      if (provider === "jira") issueLinks.push({ type: "Blocks", inwardIssue: id, outwardIssue: ticketId });
      t.blockedBy = [...(t.blockedBy || []), id];
      added.push(id);
    }
    if (added.length && !preserve.includes(t.status)) t.status = "blocked";
    return added; // id-string form — tallyBlockerResult treats omissions as "present"
  });

  // ── the preconditionUnmet stamp, through the SAME Tickets___* tool shape the
  //    report_precondition_unmet channel uses. Merges ids; returns the real
  //    annotate Lambda shape { ticketId, preconditionUnmet } (TEAM-4156 contract). ──
  const annotatePreconditionUnmet = vi.fn(async (originId, { awaitingIds, source, reportedAt }) => {
    const t = tickets[originId];
    const prior = t?.preconditionUnmet?.awaitingIds || [];
    const merged = [...new Set([...prior, ...awaitingIds])];
    const preconditionUnmet = { awaitingIds: merged, source, reportedAt };
    if (t) t.preconditionUnmet = preconditionUnmet;
    return { ticketId: originId, preconditionUnmet };
  });

  // ── effects ──
  const events = [];
  const publishEvent = vi.fn(async (ticketId, type, detail) => { events.push({ ticketId, type, detail }); });
  const getChildTickets = vi.fn(async (parentId) => {
    syncClock();
    return Object.values(tickets).filter((t) => t.parentId === parentId);
  });
  const getTicket = vi.fn(async (id) => { syncClock(); return tickets[id] || null; });

  // ── the in-memory workflow store (R2). markAwaitTimeoutEmitted + the clean-exit
  //    CAS are the D1/D2 additions; the rest is what the cascade touches. ──
  const store = {
    markAwaitTimeoutEmitted: vi.fn(async (_wfId, tid) => {
      wf.awaitTimeoutEmitted ||= {};
      if (wf.awaitTimeoutEmitted[tid]) return false;
      wf.awaitTimeoutEmitted[tid] = 1;
      return true;
    }),
    incrementCleanExitRedispatch: vi.fn(async (_wfId, tid) => {
      wf.cleanExitRedispatches[tid] = (wf.cleanExitRedispatches[tid] || 0) + 1;
    }),
    incrementDeadSessionRetry: vi.fn(async (_wfId, tid) => {
      wf.deadSessionRetries[tid] = (wf.deadSessionRetries[tid] || 0) + 1;
    }),
    setTaskStatus: vi.fn(async (_wfId, tid, status) => { if (wf.agentTasks[tid]) wf.agentTasks[tid].status = status; }),
    appendNotification: vi.fn(async (_wfId, n) => { wf.humanNotifications.push(n); }),
    getWorkflow: vi.fn(async () => wf),
  };

  // ── lease: TEAM-4126's parked claim reads DEAD; a redispatch makes it live
  //    again (a fresh claim streaming). Every other in-flight fix ticket is live,
  //    so a normal cascade nudges them and never steals. ──
  const deadClaims = new Set([SHIP]);
  const lease = {
    LEASE_TTL_MS: TTL_MS,
    lastAgentActivity: vi.fn(async () => null),
    isLeaseLive: vi.fn((task) => !!task && !deadClaims.has(task.ticketId)),
    // Generation CAS: succeeds only against the exact startedAt we inspected.
    stealClaim: vi.fn(async (_ddb, _tbl, _wfId, tid, startedAt) =>
      !!wf.agentTasks[tid] && wf.agentTasks[tid].startedAt === startedAt),
  };

  const redispatchedIds = [];
  const redispatchedBlockedBy = [];
  const redispatch = vi.fn(async (_wf, sibling) => {
    redispatchedIds.push(sibling.ticketId);
    redispatchedBlockedBy.push([...(sibling.blockedBy || [])]);
    // A fresh claim: new generation, and the lease is now live.
    wf.agentTasks[sibling.ticketId] = { agentId: sibling.assignee, ticketId: sibling.ticketId, status: "running", startedAt: nowIso() };
    deadClaims.delete(sibling.ticketId);
    return true;
  });

  const getLastStreamAt = vi.fn(async () => null);

  const awaited = createAwaitedIds({
    addBlockers,
    annotatePreconditionUnmet,
    publishEvent,
    getTicket,
    store,
    now: () => clock,
    mode: awaitedMode,
    timeoutMinutes,
    log: () => {},
  });

  const cascade = createCascade({
    ddb: { send: vi.fn(async () => ({})) },
    ticketsTable: "tickets",
    provider,
    jiraTransition: vi.fn(async () => {}),
    getChildTickets,
    publishEvent,
    now: () => clock,
    log: () => {},
    extendedStates: "enforce",
    lease,
    eventsTable: "events",
    workflowsTable: "workflows",
    redispatch,
    reawakenGate: vi.fn(async () => true),
    store,
    blockTicket: vi.fn(async () => {}),
    awaitedIds: awaited,
    cleanExitRedispatchCap: 3,
    getLastStreamAt,
  });

  const ddb = { send: vi.fn(async (cmd) => (cmd.constructor.name === "ScanCommand" ? { Items: [wf] } : {})) };
  const sweep = createReconcileSweep({
    ddb, workflowsTable: "workflows", cascade, getChildTickets,
    leaseTtlMs: TTL_MS, awaitedIds: awaited, now: () => clock, log: () => {},
  });

  const advanceTo = (iso) => { clock = Math.max(clock + 1, Date.parse(iso)); syncClock(); };

  return {
    wf, tickets, awaited, cascade, sweep, store, lease, deadClaims,
    addBlockers, annotatePreconditionUnmet, publishEvent, getChildTickets,
    redispatch, redispatchedIds, redispatchedBlockedBy, issueLinks,
    events, at: () => nowIso(), advanceTo,
    eventsOfType: (type) => events.filter((e) => e.type === type),
    // Apply the derived spawn edges for the two ship fixes + the CI fix, exactly
    // as index.mjs's trackTicketCreation hook does at ticket-creation time.
    applySpawnEdges: async () => {
      await awaited.applyAwaitedEdgesForSpawn(FIX_A, fxSpawnedBy(FIX_A));
      await awaited.applyAwaitedEdgesForSpawn(FIX_B, fxSpawnedBy(FIX_B));
      await awaited.applyAwaitedEdgesForSpawn(FIX_CI, fxSpawnedBy(FIX_CI));
    },
  };
}
