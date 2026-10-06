import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";

/**
 * TEAM-5323 — a parked ticket's whole lifecycle, once per clear path.
 *
 * park → cap 3 → clear → the claim CAS admits again, with the REAL orchestrator
 * store (lambda/orchestrator/workflow-store.mjs: incrementRedispatch, parkTicket,
 * claimInvocation) and the REAL hub routes moving one in-memory workflow row
 * (park-test-ddb). The starting row is the TEAM-5320 fixture
 * lambda/orchestrator/fixtures/park-redispatch-cap.json, re-opened (phase
 * development) with TEAM-4931 handed to an agent: its redispatchCounts is
 * already 3, the cap.
 *
 * Clear paths: retry (POST /retry {agentId}), dispatch (POST /nudge {ticketId})
 * and `intervene.py unstick --ticket` (the same targeted nudge body —
 * test_intervene.py pins that the CLI sends exactly it). The negative is the
 * untargeted nudge, which must leave the park in place.
 */

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", async () => (await import("./park-test-ddb")).mockLibDynamodb());

const { fake, mockLibDynamodb } = await import("./park-test-ddb");
const store = await import("../../../lambda/orchestrator/workflow-store.mjs");
const { POST: retryPOST } = await import("@/app/api/workflow/[id]/retry/route");
const { POST: nudgePOST } = await import("@/app/api/workflow/[id]/nudge/route");
const { isParked } = await import("./park");

const root = resolve(__dirname, "../../..");
const fixture = JSON.parse(readFileSync(resolve(root, "lambda/orchestrator/fixtures/park-redispatch-cap.json"), "utf8"));
const WF: string = fixture.workflowId;
const T = "TEAM-4931";
const AGENT = "agentcore_hub_api_dev";

store.initWorkflowStore(mockLibDynamodb().client, "agentcore-hub-workflows");

type Route = (req: NextRequest, ctx: { params: { id: string } }) => Promise<Response>;

const post = (route: Route, path: string, body?: Record<string, unknown>) =>
  route(
    new NextRequest(`http://localhost/api/workflow/${WF}/${path}`, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) }),
    { params: { id: WF } }
  );

const claim = () =>
  store.claimInvocation(WF, T, { agentId: AGENT, ticketId: T, status: "running", startedAt: new Date().toISOString() }, new Date(0).toISOString());

/** Seed the fixture row and drive TEAM-4931 into a park the way the orchestrator does. */
async function parkAtCap() {
  fake.reset();
  fake.workflows[WF] = {
    ...structuredClone(fixture),
    phase: "development",
    agentTasks: { ...structuredClone(fixture.agentTasks), [T]: { agentId: AGENT, ticketId: T, status: "error" } },
  };
  fake.tickets[T] = { ticketId: T, workflowId: WF, status: "todo", assignee: AGENT, blockedBy: [] };

  expect(store.redispatchCountOf(fake.workflows[WF], T)).toBe(store.REDISPATCH_CAP);
  expect(await store.incrementRedispatch(WF, T)).toEqual({ allowed: false });
  expect(await store.parkTicket(WF, T, "redispatch_cap")).toBe(true);
  expect(isParked(fake.workflows[WF], T)).toBe(true);
  expect(await claim()).toBe(false);
}

/** After a clear: no park, a fresh budget, and the claim CAS admits. */
async function expectCleared() {
  const row = fake.workflows[WF];
  expect(isParked(row, T)).toBe(false);
  expect(row.redispatchCounts).not.toHaveProperty(T);
  // Other tickets' DL-035 state is untouched.
  expect(row.parkedTickets).toHaveProperty("TEAM-4939");
  expect(row.redispatchCounts).toMatchObject({ "TEAM-4954": 1 });
  expect(fake.tickets[T].status).toBe("ready");
  expect(await claim()).toBe(true);
  expect(await store.incrementRedispatch(WF, T)).toEqual({ allowed: true, count: 1 });
}

beforeEach(() => {
  delete process.env.TICKET_PROVIDER;
});

describe("park lifecycle — park → cap 3 → clear → claim admits (TEAM-5323)", () => {
  it("retry clears the park", async () => {
    await parkAtCap();
    const res = await post(retryPOST, "retry", { agentId: AGENT });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ticketId: T, unparked: true });
    await expectCleared();
  });

  it("targeted nudge (dispatch) clears the park", async () => {
    await parkAtCap();
    const res = await post(nudgePOST, "nudge", { ticketId: T });
    expect(await res.json()).toMatchObject({ unparked: true });
    await expectCleared();
  });

  it("unstick --ticket clears the park", async () => {
    await parkAtCap();
    // The body intervene.py's `unstick --ticket` posts (test_intervene.py pins it).
    const res = await post(nudgePOST, "nudge", { ticketId: T });
    expect(await res.json()).toMatchObject({ nudged: [`${T} (dispatch→ready)`], unparked: true });
    await expectCleared();
  });

  it("untargeted unstick leaves the park, and the claim still refuses", async () => {
    await parkAtCap();
    const res = await post(nudgePOST, "nudge");
    expect(await res.json()).toMatchObject({ skippedParked: [T] });
    expect(isParked(fake.workflows[WF], T)).toBe(true);
    expect(fake.workflows[WF].redispatchCounts[T]).toBe(3);
    expect(await claim()).toBe(false);
  });
});
