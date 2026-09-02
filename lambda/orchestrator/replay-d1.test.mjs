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
    // The 2 live ones get a context nudge only.
    expect(eventsOfType(publishEvent, "orchestrator.nudge")).toHaveLength(2);
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
