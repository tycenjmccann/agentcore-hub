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
