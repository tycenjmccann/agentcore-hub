import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCascade, normalizeExtendedMode, newMetrics, reconcileReason } from "./cascade.mjs";

/**
 * TEAM-3618 D3 — the shared unblock cascade. Both "ticket done" paths
 * (Jira-webhook handleTicketDoneUnified and DDB-stream handleTicketDone) now
 * delegate to createCascade().cascadeUnblock, so these DI tests pin the ONE
 * behavior both call sites inherit.
 *
 * Commit 4a (this file's first blocks) pins the UNION semantics: a dependent in
 * {blocked, todo} with all blockers resolved is Readied in BOTH providers, and
 * every Ready transition emits an orchestrator.unblocked journal event (the
 * stream twin previously matched only "blocked" and emitted no journal).
 */

const NOW = Date.parse("2026-09-01T12:00:00Z");

function makeDdb() {
  return { send: vi.fn(async () => ({})) };
}

function makeDeps(overrides = {}) {
  const ddb = overrides.ddb || makeDdb();
  const publishEvent = overrides.publishEvent || vi.fn(async () => {});
  const jiraTransition = overrides.jiraTransition || vi.fn(async () => {});
  const getChildTickets = overrides.getChildTickets || vi.fn(async () => []);
  // Injectable, zero-delay sleep so the stale-GSI retry (Finding 3) never waits
  // real time in tests and its invocation is assertable.
  const sleep = overrides.sleep || vi.fn(async () => {});
  const deps = {
    ddb,
    ticketsTable: "tickets",
    provider: overrides.provider || "dynamodb",
    jiraTransition,
    getChildTickets,
    publishEvent,
    now: () => NOW,
    log: () => {},
    sleep,
    ...(overrides.retryDelayMs !== undefined ? { retryDelayMs: overrides.retryDelayMs } : {}),
  };
  return { deps, ddb, publishEvent, jiraTransition, getChildTickets, sleep };
}

// emitCascadeMetrics writes a single EMF record straight to console.log (the
// cascade's own `log` dep is a no-op here), so any captured `_aws` record IS a
// metrics emission. Returns the parsed records + a restore().
function captureMetrics() {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  return {
    records: () =>
      spy.mock.calls
        .map((c) => { try { return JSON.parse(c[0]); } catch { return null; } })
        .filter((r) => r && r._aws),
    restore: () => spy.mockRestore(),
  };
}

const workflow = { id: "wf_1", workflowId: "wf_1" };
const DONE = "TEAM-1"; // the ticket that just closed

const eventsOfType = (fn, type) => fn.mock.calls.filter((c) => c[1] === type);
const statusWrites = (ddb) =>
  ddb.send.mock.calls.filter((c) => c[0]?.input?.UpdateExpression?.includes("#s = :s"));

beforeEach(() => vi.clearAllMocks());

describe("commit 4a — union {blocked, todo} → Ready (DDB provider)", () => {
  it("Readies a BLOCKED dependent whose last blocker just closed", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "blocked", blockedBy: [DONE] },
    ];
    const { deps, ddb, publishEvent } = makeDeps({ getChildTickets: vi.fn(async () => siblings) });
    const { cascadeUnblock } = createCascade(deps);

    const unblocked = await cascadeUnblock(DONE, "EPIC-1", workflow);

    expect(unblocked).toEqual(["TEAM-2"]);
    const w = statusWrites(ddb);
    expect(w).toHaveLength(1);
    expect(w[0][0].input.Key).toEqual({ ticketId: "TEAM-2" });
    expect(w[0][0].input.ExpressionAttributeValues[":s"]).toBe("todo");
    const journal = eventsOfType(publishEvent, "orchestrator.unblocked");
    expect(journal).toHaveLength(1);
    expect(journal[0][2]).toMatchObject({ ticketId: "TEAM-2", unblockedBy: DONE, workflowId: "wf_1" });
  });

  it("Readies a parked TODO dependent too — the stream-path divergence fix", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "todo", blockedBy: [DONE] },
    ];
    const { deps, ddb, publishEvent } = makeDeps({ getChildTickets: vi.fn(async () => siblings) });
    const { cascadeUnblock } = createCascade(deps);

    const unblocked = await cascadeUnblock(DONE, "EPIC-1", workflow);

    expect(unblocked).toEqual(["TEAM-2"]);
    expect(statusWrites(ddb)).toHaveLength(1);
    expect(eventsOfType(publishEvent, "orchestrator.unblocked")).toHaveLength(1);
  });

  it("Readies BOTH a blocked and a todo dependent in one cascade", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "blocked", blockedBy: [DONE] },
      { ticketId: "TEAM-3", status: "todo", blockedBy: [DONE] },
    ];
    const { deps, ddb, publishEvent } = makeDeps({ getChildTickets: vi.fn(async () => siblings) });
    const { cascadeUnblock } = createCascade(deps);

    const unblocked = await cascadeUnblock(DONE, "EPIC-1", workflow);

    expect(new Set(unblocked)).toEqual(new Set(["TEAM-2", "TEAM-3"]));
    expect(statusWrites(ddb)).toHaveLength(2);
    expect(eventsOfType(publishEvent, "orchestrator.unblocked")).toHaveLength(2);
  });
});

describe("blocker-resolution predicate (unchanged)", () => {
  it("does NOT unblock while another blocker is still open", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-9", status: "in_progress" }, // second blocker, not resolved
      { ticketId: "TEAM-2", status: "blocked", blockedBy: [DONE, "TEAM-9"] },
    ];
    const { deps, ddb, publishEvent } = makeDeps({ getChildTickets: vi.fn(async () => siblings) });
    const { cascadeUnblock } = createCascade(deps);

    const unblocked = await cascadeUnblock(DONE, "EPIC-1", workflow);

    expect(unblocked).toEqual([]);
    expect(statusWrites(ddb)).toHaveLength(0);
    expect(eventsOfType(publishEvent, "orchestrator.unblocked")).toHaveLength(0);
  });

  it("unblocks once the LAST blocker resolves (cancelled counts as resolved)", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-9", status: "cancelled" },
      { ticketId: "TEAM-2", status: "blocked", blockedBy: [DONE, "TEAM-9"] },
    ];
    const { deps } = makeDeps({ getChildTickets: vi.fn(async () => siblings) });
    const { cascadeUnblock } = createCascade(deps);
    expect(await cascadeUnblock(DONE, "EPIC-1", workflow)).toEqual(["TEAM-2"]);
  });

  it("ignores the closed ticket itself and non-dependents", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "blocked", blockedBy: ["TEAM-OTHER"] }, // not blocked by DONE
    ];
    const { deps } = makeDeps({ getChildTickets: vi.fn(async () => siblings) });
    const { cascadeUnblock } = createCascade(deps);
    expect(await cascadeUnblock(DONE, "EPIC-1", workflow)).toEqual([]);
  });
});

describe("commit 4a leaves NON-{blocked,todo} dependents untouched", () => {
  it("does not touch in_progress / in_review dependents (extended states are 4b)", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "in_progress", blockedBy: [DONE] },
      { ticketId: "TEAM-3", status: "in_review", blockedBy: [DONE] },
    ];
    const { deps, ddb, publishEvent } = makeDeps({ getChildTickets: vi.fn(async () => siblings) });
    const { cascadeUnblock } = createCascade(deps);

    const unblocked = await cascadeUnblock(DONE, "EPIC-1", workflow);

    expect(unblocked).toEqual([]);
    expect(statusWrites(ddb)).toHaveLength(0);
    expect(eventsOfType(publishEvent, "orchestrator.unblocked")).toHaveLength(0);
    expect(eventsOfType(publishEvent, "orchestrator.nudge")).toHaveLength(0);
    expect(eventsOfType(publishEvent, "review.reawakened")).toHaveLength(0);
  });
});

describe("provider branching", () => {
  it("Jira provider transitions to Ready (no DDB status write)", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "blocked", blockedBy: [DONE] },
    ];
    const { deps, ddb, jiraTransition } = makeDeps({
      provider: "jira",
      getChildTickets: vi.fn(async () => siblings),
    });
    const { cascadeUnblock } = createCascade(deps);

    const unblocked = await cascadeUnblock(DONE, "EPIC-1", workflow);

    expect(unblocked).toEqual(["TEAM-2"]);
    expect(jiraTransition).toHaveBeenCalledWith("TEAM-2", "Ready");
    expect(statusWrites(ddb)).toHaveLength(0);
  });
});

/**
 * Commit 4b — extended states behind CASCADE_EXTENDED_STATES. When the LAST
 * blocker of an ALREADY-MOVING dependent resolves:
 *   - in_progress → lease-guarded (live → nudge only; stale → steal + dispatch)
 *   - in_review   → re-wake the gate (review.reawakened + gate re-run)
 * Off by default → those dependents are untouched.
 */
const TTL_MS = 30 * 60 * 1000;
const STALE_STARTED = "2026-09-01T00:00:00Z"; // 12h before NOW → any lease is stale

function makeExtDeps(overrides = {}) {
  const base = makeDeps(overrides);
  const lease = {
    LEASE_TTL_MS: TTL_MS,
    isLeaseLive: vi.fn(() => false), // stale by default
    lastAgentActivity: vi.fn(async () => null),
    stealClaim: vi.fn(async () => true),
    ...overrides.lease,
  };
  const redispatch = overrides.redispatch || vi.fn(async () => true);
  // Default resolves TRUTHY: reawakenGate (handleHumanReviewGate) returns whether
  // THIS call (re)notified, and the re-wake now publishes review.reawakened only
  // on a truthy result (TEAM-3684 Finding 2). "Gate notified" is the normal case.
  const reawakenGate = overrides.reawakenGate || vi.fn(async () => true);
  // TEAM-3755 F9 — the strongly-consistent blocker confirm (index.mjs
  // getTicketConsistent). Default agrees with the snapshot (the blocker really is
  // done), so every pre-F9 expectation in this file stands; the F9 block below
  // overrides it to model a stale GSI page.
  const getTicketConsistent =
    overrides.getTicketConsistent || vi.fn(async (ticketId) => ({ ticketId, status: "done" }));
  const deps = {
    ...base.deps,
    extendedStates: overrides.extendedStates !== undefined ? overrides.extendedStates : true,
    lease,
    eventsTable: "events",
    workflowsTable: "workflows",
    redispatch,
    reawakenGate,
    ...(overrides.getTicketConsistent === null ? {} : { getTicketConsistent }),
  };
  return { ...base, deps, lease, redispatch, reawakenGate, getTicketConsistent };
}

// A workflow carrying a running claim for the in_progress dependent.
const extWorkflow = {
  id: "wf_1",
  workflowId: "wf_1",
  agentTasks: { "TEAM-2": { id: "t2", agentId: "dev", ticketId: "TEAM-2", status: "running", startedAt: STALE_STARTED } },
};

describe("commit 4b — in_progress dependent, LIVE lease (AC-D3.3)", () => {
  it("nudges only — ZERO steal, ZERO claim, ZERO re-dispatch", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "in_progress", assignee: "dev", blockedBy: [DONE] },
    ];
    const { deps, ddb, publishEvent, lease, redispatch } = makeExtDeps({
      getChildTickets: vi.fn(async () => siblings),
      lease: { isLeaseLive: vi.fn(() => true) },
    });
    const { cascadeUnblock } = createCascade(deps);

    const unblocked = await cascadeUnblock(DONE, "EPIC-1", extWorkflow);

    expect(unblocked).toEqual([]); // not a Ready transition
    const nudges = eventsOfType(publishEvent, "orchestrator.nudge");
    expect(nudges).toHaveLength(1);
    expect(nudges[0][2]).toMatchObject({ agentId: "dev", unblockedBy: DONE, workflowId: "wf_1" });
    expect(lease.stealClaim).not.toHaveBeenCalled();
    expect(redispatch).not.toHaveBeenCalled();
    expect(statusWrites(ddb)).toHaveLength(0);
  });
});

describe("commit 4b — in_progress dependent, STALE lease", () => {
  it("steals on the exact generation then re-dispatches through the claim CAS", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "in_progress", assignee: "dev", blockedBy: [DONE] },
    ];
    const { deps, publishEvent, lease, redispatch } = makeExtDeps({
      getChildTickets: vi.fn(async () => siblings),
    });
    const { cascadeUnblock } = createCascade(deps);

    await cascadeUnblock(DONE, "EPIC-1", extWorkflow);

    expect(lease.stealClaim).toHaveBeenCalledWith(deps.ddb, "workflows", "wf_1", "TEAM-2", STALE_STARTED);
    expect(redispatch).toHaveBeenCalledTimes(1);
    expect(redispatch.mock.calls[0][1].ticketId).toBe("TEAM-2");
    expect(eventsOfType(publishEvent, "orchestrator.nudge")).toHaveLength(0);
  });

  it("does NOT re-dispatch when the steal loses (claim moved)", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "in_progress", assignee: "dev", blockedBy: [DONE] },
    ];
    const { deps, redispatch } = makeExtDeps({
      getChildTickets: vi.fn(async () => siblings),
      lease: { stealClaim: vi.fn(async () => false) },
    });
    const { cascadeUnblock } = createCascade(deps);

    await cascadeUnblock(DONE, "EPIC-1", extWorkflow);

    expect(redispatch).not.toHaveBeenCalled();
  });

  it("tolerates a re-dispatch refused by the claim CAS (returns false)", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "in_progress", assignee: "dev", blockedBy: [DONE] },
    ];
    const { deps, lease } = makeExtDeps({
      getChildTickets: vi.fn(async () => siblings),
      redispatch: vi.fn(async () => false), // live claim raced in, CAS lost
    });
    const { cascadeUnblock } = createCascade(deps);

    const unblocked = await cascadeUnblock(DONE, "EPIC-1", extWorkflow);
    expect(unblocked).toEqual([]);
    expect(lease.stealClaim).toHaveBeenCalledTimes(1);
  });
});

describe("commit 4b — in_review gate re-wake (AC-D3.1 / AC-D3.2)", () => {
  it("AC-D3.1: last blocker done → review.reawakened + gate re-invoked in the same cascade", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "GATE-1", status: "in_review", assignee: "human:reviewer", blockedBy: [DONE] },
    ];
    const { deps, publishEvent, reawakenGate } = makeExtDeps({
      getChildTickets: vi.fn(async () => siblings),
    });
    const { cascadeUnblock } = createCascade(deps);

    const unblocked = await cascadeUnblock(DONE, "EPIC-1", extWorkflow);

    expect(unblocked).toEqual([]); // not a Ready transition
    const reawaken = eventsOfType(publishEvent, "review.reawakened");
    expect(reawaken).toHaveLength(1);
    expect(reawaken[0][2]).toMatchObject({ gateTicketId: "GATE-1", unblockedBy: DONE, workflowId: "wf_1" });
    expect(reawakenGate).toHaveBeenCalledWith("GATE-1", "human:reviewer", extWorkflow);
  });

  it("AC-D3.2: reopened gate blocked by fix children — last child done re-dispatches the SAME cycle", async () => {
    // Rework loop-back: the gate was reopened and blocked_by-chained to fix + CI
    // re-validate children. The last child closing resolves all gate blockers.
    const siblings = [
      { ticketId: "FIX-1", status: "done" },
      { ticketId: "CI-1", status: "done" }, // the last child, just closed = DONE below
      { ticketId: "GATE-1", status: "in_review", assignee: "human:reviewer", blockedBy: ["FIX-1", "CI-1"] },
    ];
    const { deps, publishEvent, reawakenGate } = makeExtDeps({
      getChildTickets: vi.fn(async () => siblings),
    });
    const { cascadeUnblock } = createCascade(deps);

    await cascadeUnblock("CI-1", "EPIC-1", extWorkflow);

    expect(eventsOfType(publishEvent, "review.reawakened")).toHaveLength(1);
    expect(reawakenGate).toHaveBeenCalledWith("GATE-1", "human:reviewer", extWorkflow);
  });
});

describe("commit 4b — flag OFF leaves extended-state dependents untouched", () => {
  it("in_progress + in_review are no-ops when extendedStates is false", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "in_progress", assignee: "dev", blockedBy: [DONE] },
      { ticketId: "GATE-1", status: "in_review", assignee: "human:reviewer", blockedBy: [DONE] },
    ];
    const { deps, publishEvent, lease, redispatch, reawakenGate } = makeExtDeps({
      getChildTickets: vi.fn(async () => siblings),
      extendedStates: false,
    });
    const { cascadeUnblock } = createCascade(deps);

    const unblocked = await cascadeUnblock(DONE, "EPIC-1", extWorkflow);

    expect(unblocked).toEqual([]);
    expect(lease.stealClaim).not.toHaveBeenCalled();
    expect(lease.lastAgentActivity).not.toHaveBeenCalled();
    expect(redispatch).not.toHaveBeenCalled();
    expect(reawakenGate).not.toHaveBeenCalled();
    expect(eventsOfType(publishEvent, "orchestrator.nudge")).toHaveLength(0);
    expect(eventsOfType(publishEvent, "review.reawakened")).toHaveLength(0);
  });
});

describe("commit 4b — terminal-state dependent is a no-op even with the flag ON", () => {
  it("done / cancelled dependents whose blockers resolved fall through untouched", async () => {
    // Both list the just-closed ticket as their (only) blocker, so the
    // blocker-resolution predicate passes — but a dependent already in a
    // terminal state must not be Readied, nudged, stolen, or re-woken. Guards
    // the fall-through at cascade.mjs (neither blocked/todo nor in_progress/
    // in_review), which the other 4b cases never exercise.
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "done", assignee: "dev", blockedBy: [DONE] },
      { ticketId: "TEAM-3", status: "cancelled", assignee: "dev", blockedBy: [DONE] },
    ];
    const { deps, ddb, publishEvent, lease, redispatch, reawakenGate } = makeExtDeps({
      getChildTickets: vi.fn(async () => siblings),
    });
    const { cascadeUnblock } = createCascade(deps);

    const unblocked = await cascadeUnblock(DONE, "EPIC-1", extWorkflow);

    expect(unblocked).toEqual([]);
    expect(statusWrites(ddb)).toHaveLength(0);
    expect(lease.lastAgentActivity).not.toHaveBeenCalled();
    expect(lease.stealClaim).not.toHaveBeenCalled();
    expect(redispatch).not.toHaveBeenCalled();
    expect(reawakenGate).not.toHaveBeenCalled();
    expect(eventsOfType(publishEvent, "orchestrator.nudge")).toHaveLength(0);
    expect(eventsOfType(publishEvent, "review.reawakened")).toHaveLength(0);
    expect(eventsOfType(publishEvent, "orchestrator.unblocked")).toHaveLength(0);
  });
});

describe("both call sites exercise identical helper behavior", () => {
  it("two independent cascade instances (webhook + stream wiring) produce identical output", async () => {
    const siblings = () => [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "blocked", blockedBy: [DONE] },
      { ticketId: "TEAM-3", status: "todo", blockedBy: [DONE] },
    ];
    const a = makeDeps({ getChildTickets: vi.fn(async () => siblings()) });
    const b = makeDeps({ getChildTickets: vi.fn(async () => siblings()) });
    const unblockedA = await createCascade(a.deps).cascadeUnblock(DONE, "EPIC-1", workflow);
    const unblockedB = await createCascade(b.deps).cascadeUnblock(DONE, "EPIC-1", workflow);

    expect(unblockedA).toEqual(unblockedB);
    expect(statusWrites(a.ddb).length).toBe(statusWrites(b.ddb).length);
    expect(eventsOfType(a.publishEvent, "orchestrator.unblocked").length).toBe(
      eventsOfType(b.publishEvent, "orchestrator.unblocked").length
    );
  });
});

/**
 * TEAM-3684 Finding 1 — per-dependent error isolation. One dependent that throws
 * mid-transition must not strand its siblings or reject the whole cascade (which
 * at the call site would skip agent.complete + the completion check). The failed
 * dependent is counted (CascadeDependentErrors) and excluded from `unblocked`.
 */
describe("Finding 1 — per-dependent error isolation", () => {
  it("a dependent whose Ready transition throws is skipped; later dependents still Ready", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-FAIL", status: "blocked", blockedBy: [DONE] },
      { ticketId: "TEAM-OK", status: "blocked", blockedBy: [DONE] },
    ];
    // DDB status write throws only for TEAM-FAIL; TEAM-OK writes fine.
    const ddb = {
      send: vi.fn(async (cmd) => {
        if (cmd?.input?.Key?.ticketId === "TEAM-FAIL") throw new Error("ddb boom");
        return {};
      }),
    };
    const { deps, publishEvent } = makeDeps({ ddb, getChildTickets: vi.fn(async () => siblings) });
    const cap = captureMetrics();
    const { cascadeUnblock } = createCascade(deps);

    const unblocked = await cascadeUnblock(DONE, "EPIC-1", workflow);
    const records = cap.records();
    cap.restore();

    // Loop continued past the failure: TEAM-OK Readied, TEAM-FAIL excluded.
    expect(unblocked).toEqual(["TEAM-OK"]);
    const journal = eventsOfType(publishEvent, "orchestrator.unblocked");
    expect(journal).toHaveLength(1);
    expect(journal[0][2]).toMatchObject({ ticketId: "TEAM-OK" });
    expect(journal.some((c) => c[2].ticketId === "TEAM-FAIL")).toBe(false);
    // The error was counted and surfaced as a metric.
    expect(records).toHaveLength(1);
    expect(records[0].CascadeDependentErrors).toBe(1);
  });

  it("a throwing in_progress (extended-state) handler is isolated too", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "in_progress", assignee: "dev", blockedBy: [DONE] },
      { ticketId: "TEAM-3", status: "blocked", blockedBy: [DONE] },
    ];
    const { deps, publishEvent } = makeExtDeps({
      getChildTickets: vi.fn(async () => siblings),
      lease: { lastAgentActivity: vi.fn(async () => { throw new Error("lease boom"); }) },
    });
    const cap = captureMetrics();
    const { cascadeUnblock } = createCascade(deps);

    const unblocked = await cascadeUnblock(DONE, "EPIC-1", extWorkflow);
    const records = cap.records();
    cap.restore();

    // TEAM-2's handler threw but TEAM-3 was still Readied.
    expect(unblocked).toEqual(["TEAM-3"]);
    expect(eventsOfType(publishEvent, "orchestrator.unblocked")).toHaveLength(1);
    expect(records[0].CascadeDependentErrors).toBe(1);
  });

  it("never rejects for a per-dependent failure (protects the caller's completion check)", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-FAIL", status: "blocked", blockedBy: [DONE] },
    ];
    const ddb = { send: vi.fn(async () => { throw new Error("every write boom"); }) };
    const { deps } = makeDeps({ ddb, getChildTickets: vi.fn(async () => siblings) });
    const { cascadeUnblock } = createCascade(deps);

    await expect(cascadeUnblock(DONE, "EPIC-1", workflow)).resolves.toEqual([]);
  });
});

/**
 * TEAM-3684 Finding 2 — idempotent in_review re-wake. Concurrent last-blocker
 * completions must not each emit review.reawakened + re-notify the reviewer. The
 * gate (reawakenGate) is the single arbiter via its CAS-guarded notification:
 * only when it reports it actually (re)notified does the cascade emit the event.
 */
describe("Finding 2 — idempotent in_review re-wake", () => {
  it("reawakenGate falsy (CAS lost / already open) → NO event, metric not incremented", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "GATE-1", status: "in_review", assignee: "human:reviewer", blockedBy: [DONE] },
    ];
    const { deps, publishEvent, reawakenGate } = makeExtDeps({
      getChildTickets: vi.fn(async () => siblings),
      reawakenGate: vi.fn(async () => false),
    });
    const cap = captureMetrics();
    const { cascadeUnblock } = createCascade(deps);

    await cascadeUnblock(DONE, "EPIC-1", extWorkflow);
    const records = cap.records();
    cap.restore();

    expect(reawakenGate).toHaveBeenCalledWith("GATE-1", "human:reviewer", extWorkflow);
    expect(eventsOfType(publishEvent, "review.reawakened")).toHaveLength(0);
    // reviewReawakened stayed 0 → no metric record claims a re-wake.
    expect(records.some((r) => r.CascadeReviewReawaken > 0)).toBe(false);
  });

  it("reawakenGate truthy → EXACTLY one review.reawakened + metric counts one", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "GATE-1", status: "in_review", assignee: "human:reviewer", blockedBy: [DONE] },
    ];
    const { deps, publishEvent } = makeExtDeps({
      getChildTickets: vi.fn(async () => siblings),
      reawakenGate: vi.fn(async () => true),
    });
    const cap = captureMetrics();
    const { cascadeUnblock } = createCascade(deps);

    await cascadeUnblock(DONE, "EPIC-1", extWorkflow);
    const records = cap.records();
    cap.restore();

    expect(eventsOfType(publishEvent, "review.reawakened")).toHaveLength(1);
    expect(records[0].CascadeReviewReawaken).toBe(1);
  });
});

/**
 * TEAM-3684 Finding 3 — bounded single retry against the eventually-consistent
 * parentId-index GSI. A blocker that already closed but hasn't propagated to the
 * snapshot would otherwise permanently miss the last unblock. One re-fetch (after
 * an injectable sleep) re-evaluates only the deferred dependents.
 */
describe("Finding 3 — bounded stale-GSI retry", () => {
  it("re-fetches once and Readies the dependent when the blocker resolves on the retry", async () => {
    const stale = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-9", status: "in_progress" }, // not done in the first snapshot
      { ticketId: "TEAM-2", status: "blocked", blockedBy: [DONE, "TEAM-9"] },
    ];
    const fresh = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-9", status: "done" }, // GSI caught up
      { ticketId: "TEAM-2", status: "blocked", blockedBy: [DONE, "TEAM-9"] },
    ];
    const getChildTickets = vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh);
    const { deps, publishEvent, sleep } = makeDeps({ getChildTickets, retryDelayMs: 250 });
    const { cascadeUnblock } = createCascade(deps);

    const unblocked = await cascadeUnblock(DONE, "EPIC-1", workflow);

    expect(unblocked).toEqual(["TEAM-2"]);
    expect(getChildTickets).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(eventsOfType(publishEvent, "orchestrator.unblocked")).toHaveLength(1);
  });

  it("still-unresolved after the retry → skipped, with EXACTLY one re-fetch", async () => {
    const stale = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-9", status: "in_progress" },
      { ticketId: "TEAM-2", status: "blocked", blockedBy: [DONE, "TEAM-9"] },
    ];
    // Second snapshot STILL shows TEAM-9 open — genuinely still blocked.
    const getChildTickets = vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(stale);
    const { deps, publishEvent, sleep } = makeDeps({ getChildTickets });
    const { cascadeUnblock } = createCascade(deps);

    const unblocked = await cascadeUnblock(DONE, "EPIC-1", workflow);

    expect(unblocked).toEqual([]);
    expect(getChildTickets).toHaveBeenCalledTimes(2); // one bounded re-fetch, no more
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(eventsOfType(publishEvent, "orchestrator.unblocked")).toHaveLength(0);
  });

  it("no retry / no sleep when every dependent resolves on the first pass", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "blocked", blockedBy: [DONE] },
    ];
    const getChildTickets = vi.fn(async () => siblings);
    const { deps, sleep } = makeDeps({ getChildTickets });
    const { cascadeUnblock } = createCascade(deps);

    const unblocked = await cascadeUnblock(DONE, "EPIC-1", workflow);

    expect(unblocked).toEqual(["TEAM-2"]);
    expect(getChildTickets).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

/**
 * TEAM-3747 D1 — the extended-state path is now a tri-state safe rollout
 * (off | shadow | enforce, fail-safe default shadow) mirroring
 * DEAD_SESSION_DETECTOR_MODE. These blocks pin:
 *   - normalizeExtendedMode's exact coercion table (the ONE place mode is decided);
 *   - AC-D1.1: a parked in_progress dependent whose LAST blocker closes is
 *     re-dispatched EXACTLY once under enforce, and CascadeRedispatch == 1;
 *   - AC-D1.3: the same dependent under a LIVE lease — zero steal, zero
 *     re-dispatch, exactly one orchestrator.nudge, CascadeRedispatch == 0;
 *   - shadow — the extended path is fully evaluated + would-* metrics are
 *     emitted, but ZERO state-mutating effects fire (no steal / redispatch /
 *     nudge / reawaken, no ticket write).
 */
describe("TEAM-3747 D1 — normalizeExtendedMode coercion table", () => {
  it("legacy boolean true → enforce", () => {
    expect(normalizeExtendedMode(true)).toBe("enforce");
  });

  it("unset (undefined / null / empty string) and false → off", () => {
    expect(normalizeExtendedMode(undefined)).toBe("off");
    expect(normalizeExtendedMode(null)).toBe("off");
    expect(normalizeExtendedMode("")).toBe("off");
    expect(normalizeExtendedMode(false)).toBe("off");
  });

  it("legacy string truthies on / true / 1 → enforce (case + whitespace tolerant)", () => {
    expect(normalizeExtendedMode("on")).toBe("enforce");
    expect(normalizeExtendedMode("true")).toBe("enforce");
    expect(normalizeExtendedMode("1")).toBe("enforce");
    expect(normalizeExtendedMode("  ON  ")).toBe("enforce");
    expect(normalizeExtendedMode("True")).toBe("enforce");
  });

  it("canonical off / shadow / enforce pass through (case + whitespace tolerant)", () => {
    expect(normalizeExtendedMode("off")).toBe("off");
    expect(normalizeExtendedMode("shadow")).toBe("shadow");
    expect(normalizeExtendedMode("enforce")).toBe("enforce");
    expect(normalizeExtendedMode(" SHADOW ")).toBe("shadow");
    expect(normalizeExtendedMode("Enforce")).toBe("enforce");
  });

  it("anything unrecognized fails SAFE to shadow (observe-only)", () => {
    expect(normalizeExtendedMode("enfrce")).toBe("shadow");
    expect(normalizeExtendedMode("garbage")).toBe("shadow");
    expect(normalizeExtendedMode("0")).toBe("shadow");
    expect(normalizeExtendedMode("no")).toBe("shadow");
    expect(normalizeExtendedMode(42)).toBe("shadow");
  });

  it("createCascade surfaces the normalized mode on extendedMode", () => {
    expect(createCascade(makeExtDeps({ extendedStates: "enforce" }).deps).extendedMode).toBe("enforce");
    expect(createCascade(makeExtDeps({ extendedStates: "shadow" }).deps).extendedMode).toBe("shadow");
    expect(createCascade(makeExtDeps({ extendedStates: "off" }).deps).extendedMode).toBe("off");
    expect(createCascade(makeExtDeps({ extendedStates: "gibberish" }).deps).extendedMode).toBe("shadow");
  });
});

describe("TEAM-3747 D1 — AC-D1.1: enforce re-dispatches a parked in_progress dependent exactly once", () => {
  it("last blocker done → steal the stale generation + redispatch once; CascadeRedispatch == 1", async () => {
    // A ship-phase dependent parked in_progress on a stale lease, its ONLY
    // blocker just closed. Under enforce this is the missed-unblock recovery.
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "in_progress", assignee: "dev", blockedBy: [DONE] },
    ];
    const { deps, ddb, publishEvent, lease, redispatch } = makeExtDeps({
      getChildTickets: vi.fn(async () => siblings),
      extendedStates: "enforce",
    });
    const cap = captureMetrics();
    const { cascadeUnblock, extendedMode } = createCascade(deps);

    await cascadeUnblock(DONE, "EPIC-1", extWorkflow);
    const records = cap.records();
    cap.restore();

    expect(extendedMode).toBe("enforce");
    // Exactly one steal on the exact claim generation, then exactly one dispatch.
    expect(lease.stealClaim).toHaveBeenCalledTimes(1);
    expect(lease.stealClaim).toHaveBeenCalledWith(deps.ddb, "workflows", "wf_1", "TEAM-2", STALE_STARTED);
    expect(redispatch).toHaveBeenCalledTimes(1);
    expect(redispatch.mock.calls[0][1].ticketId).toBe("TEAM-2");
    // A re-dispatch is NOT a Ready transition → no orchestrator.nudge, no board write.
    expect(eventsOfType(publishEvent, "orchestrator.nudge")).toHaveLength(0);
    expect(statusWrites(ddb)).toHaveLength(0);
    // The metric proves exactly one recovery.
    expect(records).toHaveLength(1);
    expect(records[0].CascadeRedispatch).toBe(1);
    expect(records[0].CascadeNudgeLiveLease).toBe(0);
  });
});

describe("TEAM-3747 D1 — AC-D1.3: a LIVE lease is nudge-only (never re-dispatched)", () => {
  it("live lease → zero steal, zero redispatch, exactly one nudge; CascadeRedispatch == 0", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "in_progress", assignee: "dev", blockedBy: [DONE] },
    ];
    const { deps, ddb, publishEvent, lease, redispatch } = makeExtDeps({
      getChildTickets: vi.fn(async () => siblings),
      extendedStates: "enforce",
      lease: { isLeaseLive: vi.fn(() => true) },
    });
    const cap = captureMetrics();
    const { cascadeUnblock } = createCascade(deps);

    await cascadeUnblock(DONE, "EPIC-1", extWorkflow);
    const records = cap.records();
    cap.restore();

    expect(lease.stealClaim).not.toHaveBeenCalled();
    expect(redispatch).not.toHaveBeenCalled();
    const nudges = eventsOfType(publishEvent, "orchestrator.nudge");
    expect(nudges).toHaveLength(1);
    expect(nudges[0][2]).toMatchObject({ agentId: "dev", unblockedBy: DONE, workflowId: "wf_1" });
    expect(statusWrites(ddb)).toHaveLength(0);
    expect(records).toHaveLength(1);
    expect(records[0].CascadeRedispatch).toBe(0);
    expect(records[0].CascadeNudgeLiveLease).toBe(1);
    expect(records[0].CascadeSkippedLiveLease).toBe(1);
  });
});

describe("TEAM-3747 D1 — shadow mode evaluates + emits would-* metrics but writes NOTHING", () => {
  it("stale in_progress → would-steal + would-redispatch metrics, ZERO writes", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "in_progress", assignee: "dev", blockedBy: [DONE] },
    ];
    const { deps, ddb, publishEvent, lease, redispatch } = makeExtDeps({
      getChildTickets: vi.fn(async () => siblings),
      extendedStates: "shadow",
    });
    const cap = captureMetrics();
    const { cascadeUnblock, extendedMode } = createCascade(deps);

    const unblocked = await cascadeUnblock(DONE, "EPIC-1", extWorkflow);
    const records = cap.records();
    cap.restore();

    expect(extendedMode).toBe("shadow");
    expect(unblocked).toEqual([]);
    // The path is EVALUATED (liveness is read) but NO state-mutating effect fires.
    expect(lease.lastAgentActivity).toHaveBeenCalledTimes(1);
    expect(lease.stealClaim).not.toHaveBeenCalled();
    expect(redispatch).not.toHaveBeenCalled();
    expect(eventsOfType(publishEvent, "orchestrator.nudge")).toHaveLength(0);
    expect(eventsOfType(publishEvent, "review.reawakened")).toHaveLength(0);
    expect(statusWrites(ddb)).toHaveLength(0);
    // …but the shadow would-* counters were emitted.
    expect(records).toHaveLength(1);
    expect(records[0].CascadeWouldSteal).toBe(1);
    expect(records[0].CascadeWouldRedispatch).toBe(1);
    expect(records[0].CascadeRedispatch).toBe(0);
  });

  it("live in_progress → would-nudge + skipped-live-lease metrics, ZERO nudge published", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "in_progress", assignee: "dev", blockedBy: [DONE] },
    ];
    const { deps, publishEvent, lease, redispatch } = makeExtDeps({
      getChildTickets: vi.fn(async () => siblings),
      extendedStates: "shadow",
      lease: { isLeaseLive: vi.fn(() => true) },
    });
    const cap = captureMetrics();
    const { cascadeUnblock } = createCascade(deps);

    await cascadeUnblock(DONE, "EPIC-1", extWorkflow);
    const records = cap.records();
    cap.restore();

    expect(lease.stealClaim).not.toHaveBeenCalled();
    expect(redispatch).not.toHaveBeenCalled();
    expect(eventsOfType(publishEvent, "orchestrator.nudge")).toHaveLength(0);
    expect(records).toHaveLength(1);
    expect(records[0].CascadeWouldNudge).toBe(1);
    expect(records[0].CascadeSkippedLiveLease).toBe(1);
    expect(records[0].CascadeNudgeLiveLease).toBe(0);
  });

  it("shadow in_review → would-reawaken metric, reawakenGate never called, no event", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "GATE-1", status: "in_review", assignee: "human:reviewer", blockedBy: [DONE] },
    ];
    const { deps, publishEvent, reawakenGate } = makeExtDeps({
      getChildTickets: vi.fn(async () => siblings),
      extendedStates: "shadow",
    });
    const cap = captureMetrics();
    const { cascadeUnblock } = createCascade(deps);

    await cascadeUnblock(DONE, "EPIC-1", extWorkflow);
    const records = cap.records();
    cap.restore();

    expect(reawakenGate).not.toHaveBeenCalled();
    expect(eventsOfType(publishEvent, "review.reawakened")).toHaveLength(0);
    expect(records).toHaveLength(1);
    expect(records[0].CascadeWouldReviewReawaken).toBe(1);
    expect(records[0].CascadeReviewReawaken).toBe(0);
  });
});

/**
 * TEAM-3755 F7 (P1) — TOCTOU liveness re-check before every stealClaim.
 *
 * leaseIsLive reads lastAgentActivity ONCE, then the steal CAS keys on the claim
 * GENERATION (startedAt). An agent that was merely silent when we read liveness
 * and heart-beats in the read→steal window keeps the SAME generation, so its
 * claim SATISFIES the CAS: it gets stolen and the ticket re-dispatched while the
 * original session is still running — a double-invoke (R1). The dead-session
 * detector already re-checks liveness immediately before its steal
 * (dead-session-detector.mjs step 1b); the cascade did not. These pin that it now
 * does, on BOTH paths that reach stealAndRedispatch (event + sweep).
 */
describe("TEAM-3755 F7 — liveness is re-checked immediately before the steal", () => {
  const inProgressSiblings = [
    { ticketId: DONE, status: "done" },
    { ticketId: "TEAM-2", status: "in_progress", assignee: "dev", blockedBy: [DONE] },
  ];

  it("event path: an agent that heart-beats in the read→steal window is NOT stolen", async () => {
    // First read: stale (this is what classified the lease dead). Second read —
    // the F7 re-check — live: the agent resurrected.
    const isLeaseLive = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { deps, ddb, publishEvent, lease, redispatch } = makeExtDeps({
      getChildTickets: vi.fn(async () => inProgressSiblings),
      extendedStates: "enforce",
      lease: { isLeaseLive },
    });
    const cap = captureMetrics();
    const { cascadeUnblock } = createCascade(deps);

    await cascadeUnblock(DONE, "EPIC-1", extWorkflow);
    const records = cap.records();
    cap.restore();

    // The whole point: no steal, no re-dispatch, no second session.
    expect(lease.stealClaim).not.toHaveBeenCalled();
    expect(redispatch).not.toHaveBeenCalled();
    expect(statusWrites(ddb)).toHaveLength(0);
    // Two independent liveness reads — the classification and the re-check.
    expect(lease.lastAgentActivity).toHaveBeenCalledTimes(2);
    expect(isLeaseLive).toHaveBeenCalledTimes(2);
    // It degrades to exactly what the non-racing ordering would have done
    // (AC-D3.3): a context nudge for the live agent.
    const nudges = eventsOfType(publishEvent, "orchestrator.nudge");
    expect(nudges).toHaveLength(1);
    expect(nudges[0][2]).toMatchObject({ agentId: "dev", unblockedBy: DONE, workflowId: "wf_1" });
    expect(records[0].CascadeRedispatch).toBe(0);
    expect(records[0].CascadeNudgeLiveLease).toBe(1);
  });

  it("a lease still stale on the re-check steals + re-dispatches exactly once", async () => {
    const { deps, lease, redispatch } = makeExtDeps({
      getChildTickets: vi.fn(async () => inProgressSiblings),
      extendedStates: "enforce",
    });
    const { cascadeUnblock } = createCascade(deps);

    await cascadeUnblock(DONE, "EPIC-1", extWorkflow);

    // The guard costs one extra read; it must not cost (or duplicate) a recovery.
    expect(lease.lastAgentActivity).toHaveBeenCalledTimes(2);
    expect(lease.stealClaim).toHaveBeenCalledTimes(1);
    expect(lease.stealClaim).toHaveBeenCalledWith(deps.ddb, "workflows", "wf_1", "TEAM-2", STALE_STARTED);
    expect(redispatch).toHaveBeenCalledTimes(1);
  });

  it("sweep path (reconcileDependent) gets the same guard", async () => {
    // The sweep routes in_progress candidates straight to stealAndRedispatch, so
    // the re-check has to live THERE, not in the event-path branch — otherwise the
    // reconcile sweep keeps the double-invoke window.
    const isLeaseLive = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { deps, publishEvent, lease, redispatch } = makeExtDeps({ lease: { isLeaseLive } });
    const { reconcileDependent } = createCascade(deps);
    const m = newMetrics();

    // TEAM-3991 D2.1: reconcileDependent now returns { outcome, reason } — the
    // outcome vocabulary is unchanged, so every assertion reads `.outcome`.
    const { outcome, reason } = await reconcileDependent(
      { ticketId: "TEAM-2", status: "in_progress", assignee: "dev", blockedBy: [DONE] },
      "reconcile-sweep", extWorkflow, m, "enforce"
    );

    // TEAM-3969: the periodic sweep observes a live lease but publishes nothing —
    // a per-cycle orchestrator.nudge would reset every activity clock that only
    // filters agent.streaming (WM watch scan) and keep the run "fresh" forever.
    expect(outcome).toBe("live");
    expect(reason).toBe("lease_live");
    expect(lease.stealClaim).not.toHaveBeenCalled();
    expect(redispatch).not.toHaveBeenCalled();
    expect(eventsOfType(publishEvent, "orchestrator.nudge")).toHaveLength(0);
    expect(m.skippedLiveLease).toBe(1);
    expect(m.redispatched).toBe(0);
  });

  it("shadow mode still performs ZERO liveness re-checks and zero writes", async () => {
    // Shadow returns before the steal, so there is nothing to re-check — the guard
    // must not add a second read (or any write) on the observe-only path.
    const { deps, lease, redispatch } = makeExtDeps({
      getChildTickets: vi.fn(async () => inProgressSiblings),
      extendedStates: "shadow",
    });
    const { cascadeUnblock } = createCascade(deps);

    await cascadeUnblock(DONE, "EPIC-1", extWorkflow);

    expect(lease.lastAgentActivity).toHaveBeenCalledTimes(1);
    expect(lease.stealClaim).not.toHaveBeenCalled();
    expect(redispatch).not.toHaveBeenCalled();
  });
});

/**
 * TEAM-3755 F9 (P2) — strongly-consistent per-blocker confirm on the EVENT path.
 *
 * allBlockersResolved judges the sibling snapshot, which comes from the
 * eventually-consistent parentId-index GSI (index.mjs getChildTickets, no
 * ConsistentRead). A stale page can still show a blocker that was JUST reopened
 * for rework as done — and under enforce that drove a steal + RE-DISPATCH of an
 * in_progress dependent whose inputs are not fixed yet, so the agent re-runs
 * against known-bad inputs. The reconcile sweep is shielded by its leaseTtlMs
 * quiet period; the event path fires seconds after the blocker closes and has
 * none, so it confirms each blocker by key before acting.
 */
describe("TEAM-3755 F9 — blockers are confirmed by consistent point-read before an extended-state action", () => {
  const stalePage = [
    { ticketId: DONE, status: "done" },      // GSI says done…
    { ticketId: "TEAM-2", status: "in_progress", assignee: "dev", blockedBy: [DONE] },
  ];

  it("a blocker reopened for rework (stale snapshot) → NO steal, NO redispatch, NO nudge", async () => {
    // …the authoritative read says it was reopened.
    const getTicketConsistent = vi.fn(async (ticketId) => ({ ticketId, status: "in_progress" }));
    const { deps, ddb, publishEvent, lease, redispatch } = makeExtDeps({
      getChildTickets: vi.fn(async () => stalePage),
      extendedStates: "enforce",
      getTicketConsistent,
    });
    const cap = captureMetrics();
    const { cascadeUnblock } = createCascade(deps);

    await cascadeUnblock(DONE, "EPIC-1", extWorkflow);
    const records = cap.records();
    cap.restore();

    expect(getTicketConsistent).toHaveBeenCalledWith(DONE);
    expect(lease.stealClaim).not.toHaveBeenCalled();
    expect(redispatch).not.toHaveBeenCalled();
    expect(statusWrites(ddb)).toHaveLength(0);
    // Not even a nudge: the premise of the nudge ("your last blocker resolved")
    // is the thing that turned out to be stale. Liveness is never even read.
    expect(eventsOfType(publishEvent, "orchestrator.nudge")).toHaveLength(0);
    expect(lease.lastAgentActivity).not.toHaveBeenCalled();
    expect(records[0].CascadeBlockerConfirmAborted).toBe(1);
    expect(records[0].CascadeRedispatch).toBe(0);
  });

  it("a blocker the point-read cannot find counts as UNRESOLVED (fail safe)", async () => {
    // A just-filed fix ticket / a blocker outside this epic's GSI page: absence is
    // not proof of resolution, so we refuse to re-dispatch.
    const { deps, lease, redispatch } = makeExtDeps({
      getChildTickets: vi.fn(async () => stalePage),
      extendedStates: "enforce",
      getTicketConsistent: vi.fn(async () => null),
    });
    const { cascadeUnblock } = createCascade(deps);

    await cascadeUnblock(DONE, "EPIC-1", extWorkflow);

    expect(lease.stealClaim).not.toHaveBeenCalled();
    expect(redispatch).not.toHaveBeenCalled();
  });

  it("EVERY blocker is confirmed, and a genuinely resolved set proceeds to the steal", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "FIX-1", status: "done" },
      { ticketId: "TEAM-2", status: "in_progress", assignee: "dev", blockedBy: [DONE, "FIX-1"] },
    ];
    const getTicketConsistent = vi.fn(async (ticketId) => ({ ticketId, status: "cancelled" }));
    const { deps, lease, redispatch } = makeExtDeps({
      getChildTickets: vi.fn(async () => siblings),
      extendedStates: "enforce",
      getTicketConsistent,
    });
    const { cascadeUnblock } = createCascade(deps);

    await cascadeUnblock(DONE, "EPIC-1", extWorkflow);

    // Both blockers point-read (cancelled resolves a blocker, same as done)…
    expect(getTicketConsistent.mock.calls.map((c) => c[0]).sort()).toEqual(["FIX-1", DONE].sort());
    // …then the normal stale-lease recovery runs, unchanged.
    expect(lease.stealClaim).toHaveBeenCalledTimes(1);
    expect(redispatch).toHaveBeenCalledTimes(1);
  });

  it("shadow mode confirms too, so would-* metrics predict enforce honestly", async () => {
    const { deps, lease, redispatch } = makeExtDeps({
      getChildTickets: vi.fn(async () => stalePage),
      extendedStates: "shadow",
      getTicketConsistent: vi.fn(async (ticketId) => ({ ticketId, status: "in_progress" })),
    });
    const cap = captureMetrics();
    const { cascadeUnblock } = createCascade(deps);

    await cascadeUnblock(DONE, "EPIC-1", extWorkflow);
    const records = cap.records();
    cap.restore();

    // A would-steal here would be a LIE: enforce would have refused this one.
    expect(records[0].CascadeWouldSteal).toBe(0);
    expect(records[0].CascadeWouldRedispatch).toBe(0);
    expect(records[0].CascadeBlockerConfirmAborted).toBe(1);
    expect(lease.stealClaim).not.toHaveBeenCalled();
    expect(redispatch).not.toHaveBeenCalled();
  });

  it("a dependent with NO blockers needs no confirm (no point-read at all)", async () => {
    // in_progress reached via a sibling that lists the closed ticket but carries an
    // empty blockedBy is impossible here, so use the sweep entry point: it accepts
    // candidates whose blockedBy is vacuously satisfied.
    const getTicketConsistent = vi.fn(async () => null);
    const { deps, lease } = makeExtDeps({ getTicketConsistent });
    const { handleInProgressDependent } = createCascade(deps);

    await handleInProgressDependent(
      { ticketId: "TEAM-2", status: "in_progress", assignee: "dev" },
      DONE, extWorkflow, newMetrics(), "enforce"
    );

    expect(getTicketConsistent).not.toHaveBeenCalled();
    expect(lease.stealClaim).toHaveBeenCalledTimes(1);
  });

  it("unwired getTicketConsistent → pre-F9 behavior (no confirm, steal proceeds)", async () => {
    // Back-compat for any caller that constructs a cascade without the dep.
    const { deps, lease, redispatch } = makeExtDeps({
      getChildTickets: vi.fn(async () => stalePage),
      extendedStates: "enforce",
      getTicketConsistent: null,
    });
    const { cascadeUnblock } = createCascade(deps);

    await cascadeUnblock(DONE, "EPIC-1", extWorkflow);

    expect(lease.stealClaim).toHaveBeenCalledTimes(1);
    expect(redispatch).toHaveBeenCalledTimes(1);
  });

  it("the SWEEP path is deliberately not confirmed (its quiet period is the guard)", async () => {
    // Scope boundary, pinned on purpose: reconcileDependent must keep recovering a
    // long-parked candidate even when a blocker reads non-terminal — that is the
    // missed-DISPATCH case the sweep exists for, and parkedLongEnough (leaseTtlMs)
    // is what keeps it from racing a live cascade.
    const getTicketConsistent = vi.fn(async (ticketId) => ({ ticketId, status: "in_progress" }));
    const { deps, lease, redispatch } = makeExtDeps({ getTicketConsistent });
    const { reconcileDependent } = createCascade(deps);

    const { outcome, reason } = await reconcileDependent(
      { ticketId: "TEAM-2", status: "in_progress", assignee: "dev", blockedBy: [DONE] },
      "reconcile-sweep", extWorkflow, newMetrics(), "enforce"
    );

    expect(outcome).toBe("redispatched");
    expect(reason).toBe("claimed");
    expect(getTicketConsistent).not.toHaveBeenCalled();
    expect(lease.stealClaim).toHaveBeenCalledTimes(1);
    expect(redispatch).toHaveBeenCalledTimes(1);
  });
});

/**
 * TEAM-3991 D2.1 — the reconcile return shape. index.mjs's recomputeRun publishes
 * `orchestrator.recompute` with a per-candidate { outcome, reason }, so the reason
 * has to come from the cascade (one vocabulary) rather than being re-derived by
 * each caller from the outcome string.
 */
describe("reconcileDependent return shape (D2.1)", () => {
  it("returns { outcome, reason } with the outcome vocabulary unchanged", async () => {
    const { deps } = makeExtDeps({ lease: { isLeaseLive: vi.fn(() => true) } });
    const cascade = createCascade(deps);

    const res = await cascade.reconcileDependent(
      { ticketId: "TEAM-2", status: "in_progress", assignee: "dev", blockedBy: [DONE] },
      "recompute", extWorkflow, newMetrics(), "enforce"
    );

    // A live lease under enforce nudges (never steals) — both map to lease_live.
    expect(res).toEqual({ outcome: "nudged", reason: "lease_live" });
  });

  it("reconcileReason maps every outcome the router can return, and is honest about the rest", () => {
    for (const outcome of [
      "escalation-held", "live", "nudged", "would-nudge", "review-reawakened", "review-noop",
      "would-review", "blockers-unconfirmed", "redispatched", "redispatch-refused",
      "would-redispatch", "steal-lost", "would-steal", "escalated", "would-escalate",
    ]) {
      expect(reconcileReason(outcome)).not.toBe("unknown");
    }
    expect(reconcileReason("something-new")).toBe("unknown");
  });

  it("exposes transitionToReady for callers that must re-Ready through the provider branch", () => {
    const { deps } = makeExtDeps();
    expect(typeof createCascade(deps).transitionToReady).toBe("function");
  });
});
