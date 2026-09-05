import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCascade } from "./cascade.mjs";
import { createReconcileSweep } from "./reconcile-sweep.mjs";

/**
 * TEAM-3747 D1 — AC-D1.2 replay fixtures.
 *
 * Three real production failure runs, each of which historically required a
 * HUMAN to manually re-dispatch parked tickets (the orchestrator left them
 * stalled forever). Each is captured here as a small deterministic plain-object
 * fixture and replayed through the D1 machinery. The assertion for every run is
 * the same: ZERO required manual re-dispatches — every parked ticket reaches a
 * dispatched/re-woken/nudged state automatically, and NO manager_* intervention
 * or escalation event is emitted.
 *
 *   - ztc61f : 7 tickets parked in_progress/in_review whose blockers completed
 *              while parked. The unblock cascade DID fire (blocker-done events
 *              are replayed through cascadeUnblock in enforce) — but the old
 *              stream twin ignored already-moving dependents, so all 7 needed a
 *              manual kick. Now the extended-state path recovers them.
 *   - d68649 : 6 tickets whose unblock event was MISSED ENTIRELY (orchestrator
 *              crashed between the blocker close and the fan-out). No cascade
 *              will ever re-fire — the reconciliation sweep is the only recovery.
 *   - xm2bmz : 5 tickets in a mix of states — live-lease (nudge only, the agent
 *              is alive), stale-lease (steal + re-dispatch), and ready loop-backs
 *              (straight re-dispatch). Recovered by the sweep with correct
 *              per-class handling.
 */

const TTL_MS = 30 * 60 * 1000;
const NOW = Date.parse("2026-09-01T12:00:00Z");
const STALE = "2026-09-01T00:00:00Z"; // 12h before NOW → stale lease + parked long enough

// Events that would signal a human had to step in. If ANY of these is published
// during a replay, the run did NOT auto-recover.
const MANUAL_EVENT_TYPES = ["manager_intervention", "manager_escalation", "agent.escalated"];
const manualEvents = (publishEvent) =>
  publishEvent.mock.calls.filter((c) => MANUAL_EVENT_TYPES.includes(c[1]));
const eventsOfType = (fn, type) => fn.mock.calls.filter((c) => c[1] === type);

beforeEach(() => vi.clearAllMocks());

// ── Cascade harness (ztc61f replays blocker-done events through cascadeUnblock). ─
function makeCascade({ siblings, workflow, leaseLiveFor = () => false } = {}) {
  const publishEvent = vi.fn(async () => {});
  const lease = {
    LEASE_TTL_MS: TTL_MS,
    isLeaseLive: vi.fn((task) => leaseLiveFor(task)),
    lastAgentActivity: vi.fn(async () => null),
    stealClaim: vi.fn(async () => true),
  };
  const redispatch = vi.fn(async () => true);
  const reawakenGate = vi.fn(async () => true);
  const cascade = createCascade({
    ddb: { send: vi.fn(async () => ({})) },
    ticketsTable: "tickets",
    provider: "dynamodb",
    jiraTransition: vi.fn(async () => {}),
    getChildTickets: vi.fn(async () => siblings),
    publishEvent,
    now: () => NOW,
    log: () => {},
    extendedStates: "enforce",
    lease,
    eventsTable: "events",
    workflowsTable: "workflows",
    redispatch,
    reawakenGate,
  });
  return { cascade, publishEvent, lease, redispatch, reawakenGate };
}

// ── Sweep harness (d68649 / xm2bmz recover via a real cascade + the sweep). ──
function makeSweep({ workflow, siblings, leaseLiveFor = () => false } = {}) {
  const { cascade, publishEvent, lease, redispatch, reawakenGate } = makeCascade({ siblings, workflow, leaseLiveFor });
  const ddb = { send: vi.fn(async (cmd) => (cmd.constructor.name === "ScanCommand" ? { Items: [workflow] } : {})) };
  const sweep = createReconcileSweep({
    ddb,
    workflowsTable: "workflows",
    cascade,
    getChildTickets: vi.fn(async () => siblings),
    leaseTtlMs: TTL_MS,
    now: () => NOW,
    log: () => {},
  });
  return { ...sweep, publishEvent, lease, redispatch, reawakenGate };
}

describe("AC-D1.2 replay — ztc61f (7 parked-while-blocked tickets recovered by the cascade)", () => {
  // 5 in_progress (stale lease) + 2 in_review, each blocked by its OWN blocker
  // that closes. Replaying the 7 blocker-done events fans each to its dependent.
  const IN_PROGRESS = ["Z-1", "Z-2", "Z-3", "Z-4", "Z-5"];
  const IN_REVIEW = ["Z-6", "Z-7"];
  const blockerOf = (dep) => `B-${dep}`;

  const siblings = [
    ...IN_PROGRESS.map((d) => ({ ticketId: blockerOf(d), status: "done", type: "task" })),
    ...IN_REVIEW.map((d) => ({ ticketId: blockerOf(d), status: "done", type: "task" })),
    ...IN_PROGRESS.map((d) => ({ ticketId: d, status: "in_progress", assignee: "dev", type: "task", blockedBy: [blockerOf(d)] })),
    ...IN_REVIEW.map((d) => ({ ticketId: d, status: "in_review", assignee: "human:reviewer", type: "task", blockedBy: [blockerOf(d)] })),
  ];
  const workflow = {
    id: "ztc61f", workflowId: "ztc61f", epicId: "EPIC-Z",
    agentTasks: Object.fromEntries(
      IN_PROGRESS.map((d) => [d, { id: `t_${d}`, agentId: "dev", ticketId: d, status: "running", startedAt: STALE }])
    ),
  };

  it("all 7 recover automatically (5 re-dispatched, 2 re-woken) — 0 manual", async () => {
    const { cascade, publishEvent, redispatch, reawakenGate, lease } = makeCascade({ siblings, workflow });

    // Replay the historical event stream: each blocker's done event, in order.
    for (const d of [...IN_PROGRESS, ...IN_REVIEW]) {
      await cascade.cascadeUnblock(blockerOf(d), "EPIC-Z", workflow);
    }

    // Every in_progress dependent: stale generation stolen + re-dispatched once.
    expect(lease.stealClaim).toHaveBeenCalledTimes(5);
    expect(redispatch).toHaveBeenCalledTimes(5);
    expect(new Set(redispatch.mock.calls.map((c) => c[1].ticketId))).toEqual(new Set(IN_PROGRESS));
    // Every in_review gate re-woken once.
    expect(reawakenGate).toHaveBeenCalledTimes(2);
    expect(eventsOfType(publishEvent, "review.reawakened")).toHaveLength(2);

    const autoRecovered = redispatch.mock.calls.length + eventsOfType(publishEvent, "review.reawakened").length;
    expect(autoRecovered).toBe(7);
    expect(manualEvents(publishEvent)).toHaveLength(0);
  });
});

describe("AC-D1.2 replay — d68649 (6 tickets with a silently-missed unblock event, recovered by the sweep)", () => {
  // The unblock cascade never fired, so only the periodic sweep can recover
  // these. 3 in_progress (stale) + 2 ready + 1 in_review, all blockers satisfied.
  const IN_PROGRESS = ["D-1", "D-2", "D-3"];
  const READY = ["D-4", "D-5"];
  const IN_REVIEW = ["D-6"];
  const ALL = [...IN_PROGRESS, ...READY, ...IN_REVIEW];

  const siblings = [
    { ticketId: "B-D", status: "done", type: "task" }, // the blocker that closed unnoticed
    ...IN_PROGRESS.map((d) => ({ ticketId: d, status: "in_progress", assignee: "dev", type: "task", blockedBy: ["B-D"], updatedAt: STALE })),
    ...READY.map((d) => ({ ticketId: d, status: "ready", assignee: "dev", type: "task", blockedBy: ["B-D"], updatedAt: STALE })),
    ...IN_REVIEW.map((d) => ({ ticketId: d, status: "in_review", assignee: "human:reviewer", type: "task", blockedBy: ["B-D"], updatedAt: STALE })),
  ];
  const workflow = {
    id: "d68649", workflowId: "d68649", epicId: "EPIC-D", phase: "development", updatedAt: STALE,
    agentTasks: Object.fromEntries(
      IN_PROGRESS.map((d) => [d, { id: `t_${d}`, agentId: "dev", ticketId: d, status: "running", startedAt: STALE }])
    ),
  };

  it("all 6 recover on one sweep (5 re-dispatched, 1 re-woken) — 0 manual", async () => {
    const { runSweep, publishEvent, redispatch, reawakenGate, lease } = makeSweep({ workflow, siblings });

    const m = await runSweep("enforce");

    expect(m.candidates).toBe(ALL.length); // 6
    // in_progress → steal+dispatch (3); ready → dispatch (2); in_review → reawaken (1).
    expect(lease.stealClaim).toHaveBeenCalledTimes(3);
    expect(redispatch).toHaveBeenCalledTimes(5);
    expect(reawakenGate).toHaveBeenCalledTimes(1);
    expect(m.redispatched).toBe(5);
    expect(m.reviewReawakened).toBe(1);
    expect(m.skippedLiveLease).toBe(0);
    expect(m.noop).toBe(0);
    expect(m.candidateErrors).toBe(0);

    const autoRecovered = m.redispatched + m.reviewReawakened;
    expect(autoRecovered).toBe(6);
    expect(manualEvents(publishEvent)).toHaveLength(0);
  });
});

describe("AC-D1.2 replay — xm2bmz (5 mixed tickets, correct per-class handling by the sweep)", () => {
  // 2 live-lease in_progress (nudge only — the agent is alive), 2 stale-lease
  // in_progress (steal + re-dispatch), 1 ready loop-back (re-dispatch).
  const LIVE = ["X-1", "X-2"];
  const STALE_IP = ["X-3", "X-4"];
  const READY = ["X-5"];

  const siblings = [
    { ticketId: "B-X", status: "done", type: "task" },
    ...LIVE.map((d) => ({ ticketId: d, status: "in_progress", assignee: "dev", type: "task", blockedBy: ["B-X"], updatedAt: STALE })),
    ...STALE_IP.map((d) => ({ ticketId: d, status: "in_progress", assignee: "dev", type: "task", blockedBy: ["B-X"], updatedAt: STALE })),
    ...READY.map((d) => ({ ticketId: d, status: "ready", assignee: "dev", type: "task", blockedBy: ["B-X"], updatedAt: STALE })),
  ];
  const workflow = {
    id: "xm2bmz", workflowId: "xm2bmz", epicId: "EPIC-X", phase: "development", updatedAt: STALE,
    agentTasks: {
      ...Object.fromEntries(LIVE.map((d) => [d, { id: `t_${d}`, agentId: "dev", ticketId: d, status: "running", startedAt: STALE, live: true }])),
      ...Object.fromEntries(STALE_IP.map((d) => [d, { id: `t_${d}`, agentId: "dev", ticketId: d, status: "running", startedAt: STALE, live: false }])),
    },
  };
  // Liveness is decided by the task's `live` flag (the sweep gates on it FIRST).
  const leaseLiveFor = (task) => task?.live === true;

  it("live→nudge, stale→steal+redispatch, ready→redispatch; 0 manual", async () => {
    const { runSweep, publishEvent, redispatch, lease } = makeSweep({ workflow, siblings, leaseLiveFor });

    const m = await runSweep("enforce");

    expect(m.candidates).toBe(5);
    // Live leases are NEVER stolen (R3) — only the 2 stale in_progress are.
    expect(lease.stealClaim).toHaveBeenCalledTimes(2);
    expect(new Set(lease.stealClaim.mock.calls.map((c) => c[3]))).toEqual(new Set(STALE_IP));
    // 2 stale in_progress + 1 ready are re-dispatched; the live ones are not.
    expect(redispatch).toHaveBeenCalledTimes(3);
    expect(new Set(redispatch.mock.calls.map((c) => c[1].ticketId))).toEqual(new Set([...STALE_IP, ...READY]));
    // The 2 live ones are left alone — observed, not nudged (TEAM-3969: a
    // per-cycle nudge would keep every run looking fresh to the WM watch scan).
    expect(eventsOfType(publishEvent, "orchestrator.nudge")).toHaveLength(0);
    expect(m.skippedLiveLease).toBe(2);
    expect(m.redispatched).toBe(3);
    expect(m.noop).toBe(0);
    expect(m.candidateErrors).toBe(0);

    // Every candidate was handled correctly (recovered OR correctly left to a live
    // agent) — nothing awaits a human.
    const autoHandled = m.redispatched + m.reviewReawakened + m.skippedLiveLease;
    expect(autoHandled).toBe(5);
    expect(manualEvents(publishEvent)).toHaveLength(0);
  });
});

/**
 * TEAM-3991 D2.2 replay — 1pl3h1 (a parked origin whose FIX closes).
 *
 * The D2.2 edge in the other direction. When an agent files a fix ticket and
 * parks, the origin becomes `blockedBy` its own fix (tickets-edge.test.mjs pins
 * the write side). In prod 1pl3h1 that edge did not exist, so when the fixes
 * TEAM-3744/TEAM-3745 closed, nothing linked them back to the parked origins —
 * TEAM-3727 (twice, it parked in two separate rounds) and TEAM-3726 sat blocked
 * until a human dispatched them by hand, three times.
 *
 * With the edge in place the fixes' own done events are ordinary cascade input:
 * each origin is `blocked` with all blockers resolved, so the commit-4a path
 * transitions it to Ready and journals orchestrator.unblocked. The assertion that
 * matters is the same one as every other replay here — ZERO manager dispatches.
 *
 * The companion sffzti replay (TEAM-3799 re-driven by the escalation-decision
 * recompute) lives in recompute-park.test.mjs — "sffzti shape: a decided
 * escalation gate re-drives TEAM-3799 through the cascade, with ZERO manager
 * dispatches" — because it needs the REAL index.mjs handler, not this DI harness.
 */
describe("D2.2 replay — 1pl3h1 (parked origins re-woken by their fix tickets, 0 manual)", () => {
  const FIXES = { "TEAM-3744": "TEAM-3727", "TEAM-3745": "TEAM-3726" };

  // The fixes themselves are freshly-claimed work (an agent is on them right
  // now), so the sweep must not treat them as candidates either.
  const FRESH = new Date(NOW - 30 * 1000).toISOString();

  /** Origins parked blocked on their fix; the named fix already closed. */
  const snapshotWith = (closedFix) => [
    { ticketId: "TEAM-3744", title: "Fix: build breaks on the dev branch", type: "task", assignee: "dev",
      status: closedFix === "TEAM-3744" ? "done" : "in_progress", spawnedBy: "TEAM-3727", updatedAt: FRESH },
    { ticketId: "TEAM-3745", title: "Fix: contract mismatch in the API stub", type: "task", assignee: "dev",
      status: closedFix === "TEAM-3745" ? "done" : "in_progress", spawnedBy: "TEAM-3726", updatedAt: FRESH },
    { ticketId: "TEAM-3727", status: "blocked", assignee: "dev", type: "task", blockedBy: ["TEAM-3744"], updatedAt: STALE },
    { ticketId: "TEAM-3726", status: "blocked", assignee: "dev", type: "task", blockedBy: ["TEAM-3745"], updatedAt: STALE },
  ];

  const workflow = { id: "1pl3h1", workflowId: "1pl3h1", epicId: "EPIC-1PL", phase: "development", updatedAt: STALE };

  it("each fix's done re-wakes exactly its own origin — no cross-talk, no manual dispatch", async () => {
    for (const [fix, origin] of Object.entries(FIXES)) {
      const { cascade, publishEvent } = makeCascade({ siblings: snapshotWith(fix), workflow });

      const unblocked = await cascade.cascadeUnblock(fix, "EPIC-1PL", workflow);

      // Only this fix's origin moves; the other origin's blocker is still open.
      expect(unblocked).toEqual([origin]);
      const events = eventsOfType(publishEvent, "orchestrator.unblocked");
      expect(events).toHaveLength(1);
      expect(events[0][2]).toMatchObject({ ticketId: origin, unblockedBy: fix, workflowId: "1pl3h1" });
      expect(manualEvents(publishEvent)).toHaveLength(0);
    }
  });

  it("TEAM-3727's SECOND park round re-wakes the same way — the recovery is not one-shot", async () => {
    // It parked twice in prod; the second round is the one a human had already
    // learned to expect. Same edge, same automatic recovery.
    const round2 = [
      { ticketId: "TEAM-3746", title: "Fix: flaky integration test", type: "task", assignee: "dev", status: "done", spawnedBy: "TEAM-3727" },
      { ticketId: "TEAM-3727", status: "blocked", assignee: "dev", type: "task", blockedBy: ["TEAM-3744", "TEAM-3746"], updatedAt: STALE },
    ];
    const { cascade, publishEvent } = makeCascade({
      siblings: [...round2, { ticketId: "TEAM-3744", status: "done", type: "task" }],
      workflow,
    });

    expect(await cascade.cascadeUnblock("TEAM-3746", "EPIC-1PL", workflow)).toEqual(["TEAM-3727"]);
    expect(manualEvents(publishEvent)).toHaveLength(0);
  });

  it("the sweep is a no-op safety net here — it never re-dispatches a still-blocked origin", async () => {
    // Both fixes still open: every origin has an unresolved blocker, so the sweep
    // must leave them alone and SAY so (blockers_pending), not dispatch over a
    // fix that hasn't landed.
    const { runSweep, redispatch } = makeSweep({ workflow, siblings: snapshotWith(null) });

    const m = await runSweep("enforce");

    expect(redispatch).not.toHaveBeenCalled();
    expect(m.skipped.blockers_pending).toBe(2);
    expect(m.acted).toBe(0);
    expect(m.scanned).toBe(Object.values(m.skipped).reduce((a, b) => a + b, 0));
  });

  it("once a fix lands, the sweep alone recovers the origin (missed-event path)", async () => {
    // The belt to the cascade's braces: if the fix's done event is lost, the
    // origin is a plain blocked-with-resolved-blockers candidate and the sweep
    // readies it.
    const { runSweep, publishEvent, redispatch, lease } = makeSweep({ workflow, siblings: snapshotWith("TEAM-3744") });

    const m = await runSweep("enforce");

    // blocked-with-resolved-blockers goes straight through the claim CAS — there
    // is no live claim to steal, so the origin is dispatched, not stolen.
    expect(redispatch.mock.calls.map((c) => c[1].ticketId)).toEqual(["TEAM-3727"]);
    expect(lease.stealClaim).not.toHaveBeenCalled();
    expect(m.acted).toBe(1);
    expect(m.redispatched).toBe(1);
    expect(m.skipped.blockers_pending).toBe(1); // TEAM-3726, its fix still open
    expect(manualEvents(publishEvent)).toHaveLength(0);
  });
});
