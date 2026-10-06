import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-5323 — POST /api/workflow/[id]/nudge and DL-035 parks.
 *
 * Targeted ({ticketId}: `dispatch`, `unstick --ticket`) is a human decision
 * about one ticket and clears its park. Untargeted (the scan) never does: it
 * skips parked tickets and lists them, so a routine unstick cannot undo the
 * orchestrator's redispatch cap. One stateful fake row backs both.
 */

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", async () => (await import("../../../../../lib/workflow/park-test-ddb")).mockLibDynamodb());

// TEAM-5338 F1: the jira dispatch path, so its un-park gate is pinned too.
const jira = vi.hoisted(() => ({ transitions: [] as string[], status: "In Progress", parent: "TEAM-EPIC" }));
vi.mock("@/lib/workflow/jira-client", () => ({
  JiraClient: {
    fromEnv: () => ({
      getIssue: async () => ({ fields: { status: { name: jira.status }, parent: { key: jira.parent } } }),
      transitionIssue: async (_key: string, to: string) => { jira.transitions.push(to); },
    }),
  },
  mapJiraStatusToInternal: (name: string) => (name === "In Progress" ? "in_progress" : name.toLowerCase()),
  blockersFromLinks: () => [],
}));

const { fake } = await import("@/lib/workflow/park-test-ddb");
const { POST } = await import("./route");

const WF = "wf_1790014803133_1ykx9f";
const AGENT = "agentcore_hub_api_dev";
const PARK = { parkedReason: "redispatch_cap", parkedAt: "2026-10-01T00:00:00Z" };

const SSO_HUMAN = { "x-agentcore-user": "u-alice", "x-agentcore-tenant": "acme", "x-agentcore-email": "alice@example.com" };
const SVC = { "x-agentcore-user": "svc:workflow-manager", "x-agentcore-tenant": "acme" };

const nudge = (body?: Record<string, unknown>, headers: Record<string, string> = {}) =>
  POST(
    new NextRequest(`http://localhost/api/workflow/${WF}/nudge`, { method: "POST", headers, ...(body ? { body: JSON.stringify(body) } : {}) }),
    { params: { id: WF } }
  );
/** TEAM-5338 F1: un-parking needs a verified SSO human. */
const nudgeAsHuman = (body: Record<string, unknown>) => {
  process.env.AUTH_MODE = "cloudflare-access";
  return nudge(body, SSO_HUMAN);
};

beforeEach(() => {
  delete process.env.TICKET_PROVIDER;
  delete process.env.AUTH_MODE;
  jira.transitions = [];
  fake.reset();
  fake.workflows[WF] = {
    workflowId: WF,
    phase: "development",
    agentTasks: { "TEAM-4931": { agentId: AGENT, ticketId: "TEAM-4931", status: "error" } },
    parkedTickets: { "TEAM-4931": PARK },
    redispatchCounts: { "TEAM-4931": 3 },
  };
  fake.tickets["TEAM-4931"] = { ticketId: "TEAM-4931", workflowId: WF, status: "todo", assignee: AGENT, blockedBy: [] };
  fake.tickets["TEAM-4932"] = { ticketId: "TEAM-4932", workflowId: WF, status: "todo", assignee: AGENT, blockedBy: [] };
  fake.tickets["TEAM-4933"] = { ticketId: "TEAM-4933", workflowId: WF, status: "blocked", assignee: AGENT, blockedBy: ["TEAM-4931"] };
});

describe("nudge — DL-035 park clears (TEAM-5323)", () => {
  it("targeted nudge on parked ticket unparks then dispatches", async () => {
    const res = await nudgeAsHuman({ ticketId: "TEAM-4931" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ nudged: ["TEAM-4931 (dispatch→ready)"], unparked: true });
    expect(fake.workflows[WF].parkedTickets).toEqual({});
    expect(fake.workflows[WF].redispatchCounts).toEqual({});
    expect(fake.tickets["TEAM-4931"].status).toBe("ready");
    const order = fake.updates.map((u) => u.UpdateExpression);
    expect(order[0]).toBe("REMOVE parkedTickets.#t, redispatchCounts.#t");
    expect(fake.events.find((e) => e.type === "workflow.nudge")?.detail).toMatchObject({ unparked: true });
  });

  it("targeted nudge on an unparked ticket reports unparked:false and writes no REMOVE", async () => {
    const res = await nudge({ ticketId: "TEAM-4932" });
    expect(await res.json()).toMatchObject({ unparked: false });
    expect(fake.updates.map((u) => u.UpdateExpression)).not.toContain("REMOVE parkedTickets.#t, redispatchCounts.#t");
  });

  it("untargeted nudge skips parked tickets and reports skippedParked", async () => {
    const res = await nudge();
    const body = await res.json();
    expect(body.skippedParked).toEqual(["TEAM-4931"]);
    expect(body.nudged).not.toContain("TEAM-4931 (todo→ready)");
    expect(fake.tickets["TEAM-4931"].status).toBe("todo");
    expect(fake.workflows[WF].parkedTickets).toEqual({ "TEAM-4931": PARK });
    expect(fake.workflows[WF].redispatchCounts).toEqual({ "TEAM-4931": 3 });
    expect(fake.updates.filter((u) => /workflows/.test(u.TableName))).toEqual([]);
  });

  it("untargeted nudge still dispatches unparked ready tickets", async () => {
    const body = await (await nudge()).json();
    expect(body.nudged).toEqual(["TEAM-4932 (todo→ready)"]);
    expect(fake.tickets["TEAM-4932"].status).toBe("ready");
    // Behind the parked ticket, so still blocked — the scan's own rule, not the park's.
    expect(fake.tickets["TEAM-4933"].status).toBe("blocked");
  });
});

describe("nudge — TEAM-5347 F6: the lease is checked BEFORE the park is cleared", () => {
  for (const provider of ["dynamodb", "jira"] as const) {
    const setup = () => {
      process.env.TICKET_PROVIDER = provider;
      fake.workflows[WF].epicId = "TEAM-EPIC";
      // A parked ticket whose claim still reads running with a fresh lease.
      fake.workflows[WF].agentTasks["TEAM-4931"] = { agentId: AGENT, ticketId: "TEAM-4931", status: "running", startedAt: new Date().toISOString() };
    };

    it(`LEASE_LIVE (${provider}): 409, the park and the redispatch budget are intact, nothing is written`, async () => {
      setup();
      const res = await nudgeAsHuman({ ticketId: "TEAM-4931" });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "LEASE_LIVE" });
      expect(fake.updates).toEqual([]);
      expect(fake.workflows[WF].parkedTickets).toEqual({ "TEAM-4931": PARK });
      expect(fake.workflows[WF].redispatchCounts).toEqual({ "TEAM-4931": 3 });
      expect(fake.tickets["TEAM-4931"].status).toBe("todo");
      expect(jira.transitions).toEqual([]);
    });

    it(`force=true (${provider}): un-parks, steals the live claim under the lease CAS, then dispatches`, async () => {
      setup();
      const res = await nudgeAsHuman({ ticketId: "TEAM-4931", force: true });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ unparked: true });
      const order = fake.updates.map((u) => u.UpdateExpression);
      expect(order[0]).toBe("REMOVE parkedTickets.#t, redispatchCounts.#t");
      expect(order[1]).toBe("SET agentTasks.#tid.#st = :ready");
      expect(fake.workflows[WF].agentTasks["TEAM-4931"].status).toBe("ready");
      expect(fake.workflows[WF].parkedTickets).toEqual({});
    });
  }
});

describe("nudge — TEAM-5338 F1: a targeted un-park needs a human identity", () => {
  const untouched = () => {
    expect(fake.updates).toEqual([]);
    expect(fake.workflows[WF].parkedTickets).toEqual({ "TEAM-4931": PARK });
    expect(fake.workflows[WF].redispatchCounts).toEqual({ "TEAM-4931": 3 });
    expect(fake.tickets["TEAM-4931"].status).toBe("todo");
    expect(jira.transitions).toEqual([]);
  };

  for (const provider of ["dynamodb", "jira"] as const) {
    const setup = () => {
      process.env.TICKET_PROVIDER = provider;
      fake.workflows[WF].epicId = "TEAM-EPIC";
    };

    it(`AUTH_MODE unset (${provider}): targeted dispatch of a parked ticket is 403, no unpark, no Ready`, async () => {
      setup();
      const res = await nudge({ ticketId: "TEAM-4931" });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "human_identity_required", reason: "default_identity", ticketId: "TEAM-4931" });
      untouched();
    });

    it(`svc: identity (${provider}): targeted dispatch of a parked ticket is 403, nothing written`, async () => {
      setup();
      process.env.AUTH_MODE = "cloudflare-access";
      const res = await nudge({ ticketId: "TEAM-4931" }, SVC);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "human_identity_required", reason: "service_identity" });
      untouched();
    });

    it(`a real SSO human (${provider}) un-parks and dispatches`, async () => {
      setup();
      const res = await nudgeAsHuman({ ticketId: "TEAM-4931" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ unparked: true });
      expect(fake.workflows[WF].parkedTickets).toEqual({});
      if (provider === "jira") expect(jira.transitions).toEqual(["Ready"]);
      else expect(fake.tickets["TEAM-4931"].status).toBe("ready");
    });
  }

  it("AUTH_MODE unset: targeted dispatch of an unparked ticket still works", async () => {
    const res = await nudge({ ticketId: "TEAM-4932" });
    expect(res.status).toBe(200);
    expect(fake.tickets["TEAM-4932"].status).toBe("ready");
  });
});
