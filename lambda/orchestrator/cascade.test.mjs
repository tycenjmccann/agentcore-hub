import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCascade } from "./cascade.mjs";

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
  const deps = {
    ddb,
    ticketsTable: "tickets",
    provider: overrides.provider || "dynamodb",
    jiraTransition,
    getChildTickets,
    publishEvent,
    now: () => NOW,
    log: () => {},
  };
  return { deps, ddb, publishEvent, jiraTransition, getChildTickets };
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
  const reawakenGate = overrides.reawakenGate || vi.fn(async () => {});
  const deps = {
    ...base.deps,
    extendedStates: overrides.extendedStates !== undefined ? overrides.extendedStates : true,
    lease,
    eventsTable: "events",
    workflowsTable: "workflows",
    redispatch,
    reawakenGate,
  };
  return { ...base, deps, lease, redispatch, reawakenGate };
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
