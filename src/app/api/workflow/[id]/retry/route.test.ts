import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-5323 — POST /api/workflow/[id]/retry clears a DL-035 park.
 *
 * The orchestrator's claim CAS refuses a parked ticket, so a retry that only
 * re-Readied it would dispatch nothing. One stateful fake row (park-test-ddb)
 * backs every read and write, so the assertions are about the row the next
 * claim would see, not about which commands were sent.
 */

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", async () => (await import("../../../../../lib/workflow/park-test-ddb")).mockLibDynamodb());

const { fake } = await import("@/lib/workflow/park-test-ddb");
const { PARK_CLEAR_WRITES } = await import("@/lib/workflow/park");
const { POST } = await import("./route");

const WF = "wf_1790014803133_1ykx9f";
const AGENT = "agentcore_hub_api_dev";

const SSO_HUMAN = { "x-agentcore-user": "u-alice", "x-agentcore-tenant": "acme", "x-agentcore-email": "alice@example.com" };
const SVC = { "x-agentcore-user": "svc:workflow-manager", "x-agentcore-tenant": "acme" };

const retry = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  POST(new NextRequest(`http://localhost/api/workflow/${WF}/retry`, { method: "POST", body: JSON.stringify(body), headers }), { params: { id: WF } });
/** TEAM-5338 F1: un-parking needs a verified SSO human. */
const retryAsHuman = (body: Record<string, unknown>) => {
  process.env.AUTH_MODE = "cloudflare-access";
  return retry(body, SSO_HUMAN);
};

function seed(task: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  fake.workflows[WF] = {
    workflowId: WF,
    phase: "development",
    agentTasks: { "TEAM-4931": { agentId: AGENT, ticketId: "TEAM-4931", ...task } },
    parkedTickets: {},
    redispatchCounts: {},
    ...extra,
  };
  fake.tickets["TEAM-4931"] = { ticketId: "TEAM-4931", workflowId: WF, status: "todo", assignee: AGENT };
}

beforeEach(() => {
  delete process.env.TICKET_PROVIDER;
  delete process.env.AUTH_MODE;
  fake.reset();
});

describe("retry — DL-035 park clears (TEAM-5323)", () => {
  it("retry on parked ticket clears parkedTickets and redispatchCounts then readies", async () => {
    seed({ status: "error" }, {
      parkedTickets: { "TEAM-4931": { parkedReason: "redispatch_cap", parkedAt: "2026-10-01T00:00:00Z" } },
      redispatchCounts: { "TEAM-4931": 3, "TEAM-4954": 1 },
      deadSessionRetries: { "TEAM-4931": 2, "TEAM-4954": 1 }, // legacy leaves (TEAM-5345 F3)
    });
    const res = await retryAsHuman({ agentId: AGENT });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, ticketId: "TEAM-4931", unparked: true });

    const row = fake.workflows[WF];
    expect(row.parkedTickets).toEqual({});
    expect(row.redispatchCounts).toEqual({ "TEAM-4954": 1 }); // another ticket's budget is untouched
    expect(row.deadSessionRetries).toEqual({ "TEAM-4954": 1 }); // and its legacy leaf
    expect(row.agentTasks["TEAM-4931"].status).toBe("ready");
    expect(fake.tickets["TEAM-4931"].status).toBe("ready");

    // The clear is the whole PARK_CLEAR_WRITES sequence, in its order (legacy leaf
    // first, then park + counter), sequential, and it lands before the ticket goes
    // Ready — the stream event from that write would otherwise race a still-parked claim.
    const order = fake.updates.map((u) => u.UpdateExpression);
    expect(order.slice(0, PARK_CLEAR_WRITES.length)).toEqual(PARK_CLEAR_WRITES.map((w) => w.update));
    expect(order.indexOf("REMOVE parkedTickets.#t, redispatchCounts.#t")).toBeLessThan(order.indexOf("SET #s = :s, #u = :u"));
    expect(fake.events.find((e) => e.type === "agent.retry")?.detail).toMatchObject({ ticketId: "TEAM-4931", unparked: true });
  });

  it("retry on a parked ticket whose task still reads running goes through the lease steal", async () => {
    seed({ status: "running", startedAt: "2026-09-01T00:00:00.000Z" }, {
      parkedTickets: { "TEAM-4931": { parkedReason: "agent_blocked", parkedAt: "2026-10-01T00:00:00Z" } },
    });
    const res = await retryAsHuman({ agentId: AGENT });
    expect(res.status).toBe(200);
    expect(fake.workflows[WF].parkedTickets).toEqual({});
    expect(fake.updates.map((u) => u.UpdateExpression)).toContain("SET agentTasks.#tid.#st = :ready");
  });

  it("retry on error task is accepted", async () => {
    seed({ status: "error" });
    const res = await retry({ agentId: AGENT });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ticketId: "TEAM-4931", unparked: false });
    expect(fake.workflows[WF].agentTasks["TEAM-4931"].status).toBe("ready");
    for (const w of PARK_CLEAR_WRITES) expect(fake.updates.map((u) => u.UpdateExpression)).not.toContain(w.update);
  });

  it("retry on done ticket refused", async () => {
    // Parked or not, a settled task is never reopened.
    seed({ status: "done" }, { parkedTickets: { "TEAM-4931": { parkedReason: "x", parkedAt: "2026-10-01T00:00:00Z" } } });
    const res = await retry({ agentId: AGENT });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "TASK_NOT_FOUND" });
    expect(fake.updates).toEqual([]);
    expect(fake.workflows[WF].parkedTickets).toHaveProperty("TEAM-4931");
  });

  it("LEASE_LIVE leaves parkedTickets intact", async () => {
    // A parked ticket whose task still reads running with a fresh lease: the 409
    // must come before the un-park, or the reaper could redispatch it unasked.
    const park = { parkedReason: "agent_blocked", parkedAt: "2026-10-01T00:00:00Z" };
    seed({ status: "running", startedAt: new Date().toISOString() }, {
      parkedTickets: { "TEAM-4931": park },
      redispatchCounts: { "TEAM-4931": 3 },
    });
    const res = await retryAsHuman({ agentId: AGENT });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "LEASE_LIVE" });
    expect(fake.workflows[WF].parkedTickets).toEqual({ "TEAM-4931": park });
    expect(fake.workflows[WF].redispatchCounts).toEqual({ "TEAM-4931": 3 });
    expect(fake.updates).toEqual([]);
    expect(fake.tickets["TEAM-4931"].status).toBe("todo");
  });

  it("LEASE_LIVE → 409", async () => {
    seed({ status: "running", startedAt: new Date().toISOString() });
    const res = await retry({ agentId: AGENT });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "LEASE_LIVE" });
    expect(fake.tickets["TEAM-4931"].status).toBe("todo");
  });
});

describe("retry — TEAM-5338 F1: un-parking needs a human identity", () => {
  const park = { parkedReason: "redispatch_cap", parkedAt: "2026-10-01T00:00:00Z" };
  const seedParked = () => seed({ status: "error" }, {
    parkedTickets: { "TEAM-4931": park },
    redispatchCounts: { "TEAM-4931": 3 },
  });
  const untouched = () => {
    expect(fake.updates).toEqual([]);
    expect(fake.workflows[WF].parkedTickets).toEqual({ "TEAM-4931": park });
    expect(fake.workflows[WF].redispatchCounts).toEqual({ "TEAM-4931": 3 });
    expect(fake.workflows[WF].agentTasks["TEAM-4931"].status).toBe("error");
    expect(fake.tickets["TEAM-4931"].status).toBe("todo");
    expect(fake.events.find((e) => e.type === "agent.retry")).toBeUndefined();
  };

  it("AUTH_MODE unset: retry of a parked ticket is 403 and parkedTickets/redispatchCounts are untouched", async () => {
    seedParked();
    const res = await retry({ agentId: AGENT });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "human_identity_required", reason: "default_identity", ticketId: "TEAM-4931" });
    untouched();
  });

  it("svc: identity: retry of a parked ticket is 403, nothing written", async () => {
    process.env.AUTH_MODE = "cloudflare-access";
    seedParked();
    const res = await retry({ agentId: AGENT }, SVC);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "human_identity_required", reason: "service_identity" });
    untouched();
  });

  it("a real SSO human un-parks", async () => {
    seedParked();
    const res = await retryAsHuman({ agentId: AGENT });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ unparked: true });
    expect(fake.workflows[WF].parkedTickets).toEqual({});
  });

  it("AUTH_MODE unset: retry of an errored, unparked ticket still succeeds (Workflow Manager retry stays open)", async () => {
    seed({ status: "error" });
    const res = await retry({ agentId: AGENT });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ unparked: false });
    expect(fake.tickets["TEAM-4931"].status).toBe("ready");
  });
});
