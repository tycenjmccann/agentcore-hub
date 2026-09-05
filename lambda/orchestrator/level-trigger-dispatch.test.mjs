import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCascade } from "./cascade.mjs";

/**
 * TEAM-4060 — level-triggered dispatch. The done-cascade closes the "dispatch
 * dead-zone": instead of Readying a dependent and waiting for the provider's
 * Ready-status webhook to circle back and invoke it (edge-triggered — a
 * Ready→Ready no-op or a dropped webhook idled the ticket until the reconcile
 * sweep), the cascade invokes the newly-dispatchable dependent IN-PROCESS via
 * the injected `dispatchReady`. off | shadow | enforce, default off; off is
 * byte-identical to pre-4060 (pure webhook path).
 *
 * `dispatchReady` is a black box here: in production it routes through
 * handleTicketReadyUnified, whose claim CAS is the sole dedup arbiter, so a
 * webhook that ALSO fires no-ops. These DI tests pin the cascade's contract
 * with that function — when it is called, with what, and that a failure from it
 * (e.g. a concurrent claim already won) never strands the cascade.
 */

const NOW = Date.parse("2026-09-01T12:00:00Z");
const workflow = { id: "wf_1", workflowId: "wf_1" };
const DONE = "TEAM-1"; // the ticket that just closed

function makeDeps(overrides = {}) {
  const ddb = overrides.ddb || { send: vi.fn(async () => ({})) };
  const publishEvent = overrides.publishEvent || vi.fn(async () => {});
  const getChildTickets = overrides.getChildTickets || vi.fn(async () => []);
  const dispatchReady = overrides.dispatchReady || vi.fn(async () => {});
  const deps = {
    ddb,
    ticketsTable: "tickets",
    provider: overrides.provider || "dynamodb",
    jiraTransition: vi.fn(async () => {}),
    getChildTickets,
    publishEvent,
    now: () => NOW,
    log: () => {},
    sleep: vi.fn(async () => {}),
    levelTriggerDispatch: overrides.levelTriggerDispatch, // undefined → off default
    dispatchReady,
  };
  return { deps, ddb, publishEvent, getChildTickets, dispatchReady };
}

// emitCascadeMetrics writes one EMF record straight to console.log; any captured
// `_aws` record IS a metrics emission (the cascade's own `log` dep is a no-op).
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

const eventsOfType = (fn, type) => fn.mock.calls.filter((c) => c[1] === type);
const statusWrites = (ddb) =>
  ddb.send.mock.calls.filter((c) => c[0]?.input?.UpdateExpression?.includes("#s = :s"));

beforeEach(() => vi.clearAllMocks());

describe("off (default) — pure webhook path, byte-identical to pre-4060", () => {
  it("never calls dispatchReady; still Readies the dependent", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "blocked", blockedBy: [DONE] },
    ];
    const { deps, ddb, dispatchReady } = makeDeps({ getChildTickets: vi.fn(async () => siblings) });
    const cap = captureMetrics();
    const { cascadeUnblock } = createCascade(deps);

    const unblocked = await cascadeUnblock(DONE, "EPIC-1", workflow);
    const records = cap.records();
    cap.restore();

    expect(unblocked).toEqual(["TEAM-2"]);
    expect(statusWrites(ddb)).toHaveLength(1); // the Ready transition still happens
    expect(dispatchReady).not.toHaveBeenCalled();
    // No level-trigger metrics on the off path.
    expect(records.some((r) => "CascadeLevelDispatched" in r && r.CascadeLevelDispatched > 0)).toBe(false);
    expect(records.some((r) => "CascadeWouldDispatch" in r && r.CascadeWouldDispatch > 0)).toBe(false);
  });

  it("does NOT invoke a dependent already parked in Ready (that is the dead-zone off leaves open)", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "ready", blockedBy: [DONE] },
    ];
    const { deps, ddb, dispatchReady } = makeDeps({ getChildTickets: vi.fn(async () => siblings) });
    const { cascadeUnblock } = createCascade(deps);

    const unblocked = await cascadeUnblock(DONE, "EPIC-1", workflow);

    expect(unblocked).toEqual([]);         // no transition — it was already Ready
    expect(statusWrites(ddb)).toHaveLength(0);
    expect(dispatchReady).not.toHaveBeenCalled(); // the bug we are fixing, unfixed when off
  });
});

describe("enforce — dispatch in-process (happy path)", () => {
  it("blocked → Ready: transitions AND dispatches the dependent once", async () => {
    const sib = { ticketId: "TEAM-2", status: "blocked", blockedBy: [DONE] };
    const siblings = [{ ticketId: DONE, status: "done" }, sib];
    const { deps, ddb, publishEvent, dispatchReady } = makeDeps({
      getChildTickets: vi.fn(async () => siblings),
      levelTriggerDispatch: "enforce",
    });
    const cap = captureMetrics();
    const { cascadeUnblock } = createCascade(deps);

    const unblocked = await cascadeUnblock(DONE, "EPIC-1", workflow);
    const records = cap.records();
    cap.restore();

    expect(unblocked).toEqual(["TEAM-2"]);
    expect(statusWrites(ddb)).toHaveLength(1);
    expect(dispatchReady).toHaveBeenCalledTimes(1);
    expect(dispatchReady).toHaveBeenCalledWith(workflow, sib);
    expect(eventsOfType(publishEvent, "orchestrator.unblocked")).toHaveLength(1);
    expect(records.find((r) => "CascadeLevelDispatched" in r)?.CascadeLevelDispatched).toBe(1);
  });

  it("already-Ready dependent whose last blocker just closed: dispatches WITHOUT re-transitioning", async () => {
    // The canonical dead-zone: the Ready-status transition that would have fired
    // the webhook was a no-op, so nothing ever invoked this ticket until the sweep.
    const sib = { ticketId: "TEAM-2", status: "ready", blockedBy: [DONE] };
    const siblings = [{ ticketId: DONE, status: "done" }, sib];
    const { deps, ddb, publishEvent, dispatchReady } = makeDeps({
      getChildTickets: vi.fn(async () => siblings),
      levelTriggerDispatch: "enforce",
    });
    const { cascadeUnblock } = createCascade(deps);

    const unblocked = await cascadeUnblock(DONE, "EPIC-1", workflow);

    expect(unblocked).toEqual([]);                 // no transition — already Ready
    expect(statusWrites(ddb)).toHaveLength(0);
    expect(dispatchReady).toHaveBeenCalledTimes(1);
    expect(dispatchReady).toHaveBeenCalledWith(workflow, sib);
    expect(eventsOfType(publishEvent, "orchestrator.unblocked")).toHaveLength(0);
  });

  it("dispatches EACH of several newly-unblocked dependents exactly once", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "blocked", blockedBy: [DONE] },
      { ticketId: "TEAM-3", status: "todo", blockedBy: [DONE] },
      { ticketId: "TEAM-4", status: "ready", blockedBy: [DONE] },
    ];
    const { deps, dispatchReady } = makeDeps({
      getChildTickets: vi.fn(async () => siblings),
      levelTriggerDispatch: "enforce",
    });
    const { cascadeUnblock } = createCascade(deps);

    await cascadeUnblock(DONE, "EPIC-1", workflow);

    expect(dispatchReady).toHaveBeenCalledTimes(3);
    const dispatched = new Set(dispatchReady.mock.calls.map((c) => c[1].ticketId));
    expect(dispatched).toEqual(new Set(["TEAM-2", "TEAM-3", "TEAM-4"]));
  });
});

describe("enforce — failure isolation (concurrent claim / any dispatch error)", () => {
  it("a throwing dispatchReady is non-fatal: cascade completes, ticket stays Readied, error counted", async () => {
    // Models the concurrent-webhook race: the webhook's handleTicketReadyUnified
    // already won the claim CAS, so our in-process dispatchReady no-ops/throws.
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "blocked", blockedBy: [DONE] },
    ];
    const dispatchReady = vi.fn(async () => { throw new Error("already claimed"); });
    const { deps, ddb, publishEvent } = makeDeps({
      getChildTickets: vi.fn(async () => siblings),
      levelTriggerDispatch: "enforce",
      dispatchReady,
    });
    const cap = captureMetrics();
    const { cascadeUnblock } = createCascade(deps);

    const unblocked = await cascadeUnblock(DONE, "EPIC-1", workflow);
    const records = cap.records();
    cap.restore();

    // Transition + journal still happen; the webhook + sweep remain the backstop.
    expect(unblocked).toEqual(["TEAM-2"]);
    expect(statusWrites(ddb)).toHaveLength(1);
    expect(eventsOfType(publishEvent, "orchestrator.unblocked")).toHaveLength(1);
    expect(records.find((r) => "CascadeLevelDispatchErrors" in r)?.CascadeLevelDispatchErrors).toBe(1);
  });
});

describe("shadow — observe only, zero invokes", () => {
  it("counts wouldDispatch, never calls dispatchReady, still transitions", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "blocked", blockedBy: [DONE] },
    ];
    const { deps, ddb, dispatchReady } = makeDeps({
      getChildTickets: vi.fn(async () => siblings),
      levelTriggerDispatch: "shadow",
    });
    const cap = captureMetrics();
    const { cascadeUnblock } = createCascade(deps);

    const unblocked = await cascadeUnblock(DONE, "EPIC-1", workflow);
    const records = cap.records();
    cap.restore();

    expect(unblocked).toEqual(["TEAM-2"]);
    expect(statusWrites(ddb)).toHaveLength(1);
    expect(dispatchReady).not.toHaveBeenCalled();
    expect(records.find((r) => "CascadeWouldDispatch" in r)?.CascadeWouldDispatch).toBe(1);
    expect(records.some((r) => "CascadeLevelDispatched" in r && r.CascadeLevelDispatched > 0)).toBe(false);
  });

  it("shadow still observes an already-Ready dead-zone dependent (would-dispatch, no invoke)", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "ready", blockedBy: [DONE] },
    ];
    const { deps, ddb, dispatchReady } = makeDeps({
      getChildTickets: vi.fn(async () => siblings),
      levelTriggerDispatch: "shadow",
    });
    const cap = captureMetrics();
    const { cascadeUnblock } = createCascade(deps);

    await cascadeUnblock(DONE, "EPIC-1", workflow);
    const records = cap.records();
    cap.restore();

    expect(statusWrites(ddb)).toHaveLength(0);
    expect(dispatchReady).not.toHaveBeenCalled();
    expect(records.find((r) => "CascadeWouldDispatch" in r)?.CascadeWouldDispatch).toBe(1);
  });
});

describe("unrecognized mode → treated as off", () => {
  it("garbage levelTriggerDispatch value never dispatches", async () => {
    const siblings = [
      { ticketId: DONE, status: "done" },
      { ticketId: "TEAM-2", status: "blocked", blockedBy: [DONE] },
    ];
    const { deps, dispatchReady } = makeDeps({
      getChildTickets: vi.fn(async () => siblings),
      levelTriggerDispatch: "on", // not one of off|shadow|enforce
    });
    const { cascadeUnblock } = createCascade(deps);

    await cascadeUnblock(DONE, "EPIC-1", workflow);

    expect(dispatchReady).not.toHaveBeenCalled();
  });
});
