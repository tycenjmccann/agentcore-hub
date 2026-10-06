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
const { POST } = await import("./route");

const WF = "wf_1790014803133_1ykx9f";
const AGENT = "agentcore_hub_api_dev";

const retry = (body: Record<string, unknown>) =>
  POST(new NextRequest(`http://localhost/api/workflow/${WF}/retry`, { method: "POST", body: JSON.stringify(body) }), { params: { id: WF } });

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
  fake.reset();
});

describe("retry — DL-035 park clears (TEAM-5323)", () => {
  it("retry on parked ticket clears parkedTickets and redispatchCounts then readies", async () => {
    seed({ status: "error" }, {
      parkedTickets: { "TEAM-4931": { parkedReason: "redispatch_cap", parkedAt: "2026-10-01T00:00:00Z" } },
      redispatchCounts: { "TEAM-4931": 3, "TEAM-4954": 1 },
    });
    const res = await retry({ agentId: AGENT });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, ticketId: "TEAM-4931", unparked: true });

    const row = fake.workflows[WF];
    expect(row.parkedTickets).toEqual({});
    expect(row.redispatchCounts).toEqual({ "TEAM-4954": 1 }); // another ticket's budget is untouched
    expect(row.agentTasks["TEAM-4931"].status).toBe("ready");
    expect(fake.tickets["TEAM-4931"].status).toBe("ready");

    // Un-park lands before the ticket goes Ready — the stream event from that
    // write would otherwise race a still-parked claim.
    const order = fake.updates.map((u) => u.UpdateExpression);
    expect(order.indexOf("REMOVE parkedTickets.#t, redispatchCounts.#t")).toBeLessThan(order.indexOf("SET #s = :s, #u = :u"));
    expect(fake.events.find((e) => e.type === "agent.retry")?.detail).toMatchObject({ ticketId: "TEAM-4931", unparked: true });
  });

  it("retry on a parked ticket whose task still reads running goes through the lease steal", async () => {
    seed({ status: "running", startedAt: "2026-09-01T00:00:00.000Z" }, {
      parkedTickets: { "TEAM-4931": { parkedReason: "agent_blocked", parkedAt: "2026-10-01T00:00:00Z" } },
    });
    const res = await retry({ agentId: AGENT });
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
    expect(fake.updates.map((u) => u.UpdateExpression)).not.toContain("REMOVE parkedTickets.#t, redispatchCounts.#t");
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

  it("LEASE_LIVE → 409", async () => {
    seed({ status: "running", startedAt: new Date().toISOString() });
    const res = await retry({ agentId: AGENT });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "LEASE_LIVE" });
    expect(fake.tickets["TEAM-4931"].status).toBe("todo");
  });
});
