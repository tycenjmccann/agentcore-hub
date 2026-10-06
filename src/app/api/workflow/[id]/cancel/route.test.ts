import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { ADMIN_HEADERS, SSO_AUTH_MODE, SVC_HEADERS } from "@/lib/auth/admin-test-headers";
import { resetDecisionKeyCache } from "@/lib/workflow/decision-keys";

/**
 * TEAM-3755 — POST /api/workflow/[id]/cancel must refuse a run that already
 * closed deploy-blocked / static-ci-only, exactly like complete/route.ts and
 * the F6 UI fix (which only hides the button — this route is the actual
 * enforcement). Before this fix, TERMINAL_PHASES and the CAS
 * ConditionExpression were both hand-rolled to ["complete","error","cancelled"],
 * so cancelling a blocked run overwrote its honest verdict.
 *
 * TEAM-5358 FR-3, F2/F8/F9 — reason required, verified cancelledBy, cancelDecision
 * only on proof, human gates and live agents kept, workflow.cancelled on EventBridge.
 *
 * We mock only the seams: the DDB doc client (GetCommand returns the
 * workflow, QueryCommand the child tickets; UpdateCommand's input is captured so
 * the CAS condition itself can be inspected), S3 (gate decision records,
 * completions/) and EventBridge.
 */

const h = vi.hoisted(() => {
  process.env.ARTIFACT_BUCKET = "test-bucket";
  const state: {
    workflow: Record<string, unknown>;
    tickets: Array<Record<string, unknown>>;
    updates: Array<Record<string, unknown>>;
    puts: Array<Record<string, unknown>>;
    s3Objects: Record<string, string>;
    events: Array<{ DetailType?: string; Source?: string; Detail?: string }>;
  } = { workflow: {}, tickets: [], updates: [], puts: [], s3Objects: {}, events: [] };
  return { state };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class GetCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class UpdateCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class QueryCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class PutCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    GetCommand,
    UpdateCommand,
    QueryCommand,
    PutCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
          const name = cmd.constructor.name;
          if (name === "GetCommand") return { Item: h.state.workflow };
          if (name === "UpdateCommand") {
            h.state.updates.push(cmd.input);
            return {};
          }
          if (name === "QueryCommand") return { Items: h.state.tickets };
          h.state.puts.push(cmd.input); // PutCommand (events table)
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd: { input: { Key: string } }) {
      const body = h.state.s3Objects[cmd.input.Key];
      if (body === undefined) {
        const e = new Error("The specified key does not exist.");
        e.name = "NoSuchKey";
        throw e;
      }
      return { Body: { transformToString: async () => body } };
    }
  },
  GetObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class {
    async send(cmd: { input: { Entries?: Array<{ DetailType?: string; Source?: string; Detail?: string }> } }) {
      h.state.events.push(...(cmd.input.Entries || []));
      return {};
    }
  },
  PutEventsCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

const { POST } = await import("./route");

const TEST_DECISION_KEY = "cancel-route-test-gate-decision-key";
const SAVED_ENV = { AUTH_MODE: process.env.AUTH_MODE, GATE_DECISION_KEY: process.env.GATE_DECISION_KEY };

function makeRequest(body: unknown = { reason: "superseded by wf-2" }, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/workflow/wf-1/cancel", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  });
}

const call = (body?: unknown, headers?: Record<string, string>) => POST(makeRequest(body, headers), { params: { id: "wf-1" } });

async function signedStop(ticketId: string, over: Record<string, unknown> = {}, key = TEST_DECISION_KEY) {
  const { canonicalJson, signVerifyRecord } = await import("@/lib/workflow/decision-contract");
  const unsigned = {
    v: 3,
    ticketId,
    workflowId: "wf-1",
    kind: "gate-decision",
    status: "cancelled",
    decision: { option: "stopped", override: false, channel: "hub", by: "eng@example.com" },
    decidedAt: "2026-10-01T00:00:00Z",
    scope: null,
    cycle: null,
    labels: [],
    ...over,
  };
  return JSON.stringify({ ...unsigned, sig: signVerifyRecord([canonicalJson(unsigned)], key) });
}

const gateKey = (ticketId: string) => `pipeline-artifacts/gate-decisions/wf-1/gates/${ticketId}.json`;

beforeEach(() => {
  h.state.workflow = {};
  h.state.tickets = [];
  h.state.updates = [];
  h.state.puts = [];
  h.state.s3Objects = {};
  h.state.events = [];
  process.env.GATE_DECISION_KEY = TEST_DECISION_KEY;
  delete process.env.AUTH_MODE;
  resetDecisionKeyCache();
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetDecisionKeyCache();
});

/** Only the workflows-table CAS — the epic-close ticket update shares the same
 *  captured array but keys on ticketId, not workflowId. */
function workflowUpdates() {
  return h.state.updates.filter((u) => (u.Key as Record<string, unknown> | undefined)?.workflowId);
}

function ticketUpdateIds() {
  return h.state.updates.map((u) => (u.Key as Record<string, unknown>).ticketId).filter(Boolean);
}

function rowValues() {
  const [u] = workflowUpdates();
  return { expr: String(u.UpdateExpression), values: u.ExpressionAttributeValues as Record<string, unknown> };
}

const running = () => ({ workflowId: "wf-1", epicId: "epic-1", phase: "development" });

describe("TEAM-3755 — cancel refuses every terminal phase, not just complete/error/cancelled", () => {
  it.each(["deploy-blocked", "static-ci-only", "complete", "error", "cancelled"])(
    "409s a %s workflow and never issues the CAS write",
    async (phase) => {
      h.state.workflow = { workflowId: "wf-1", epicId: "epic-1", phase };
      const res = await call();
      expect(res.status).toBe(409);
      expect(h.state.updates).toHaveLength(0);
    }
  );

  it("still cancels a genuinely non-terminal run", async () => {
    h.state.workflow = running();
    const res = await call();
    expect(res.status).toBe(200);
    expect(workflowUpdates()).toHaveLength(1);
  });

  it("the CAS ConditionExpression excludes all five terminal phases, not the old three-literal chain", async () => {
    h.state.workflow = running();
    await call();
    expect(workflowUpdates()).toHaveLength(1);
    const [update] = workflowUpdates();
    const condition = String(update.ConditionExpression);
    const values = update.ExpressionAttributeValues as Record<string, string>;
    const excludedPhases = Object.entries(values)
      .filter(([key]) => condition.includes(`#phase <> ${key}`))
      .map(([, v]) => v)
      .sort();
    expect(excludedPhases).toEqual(
      ["complete", "error", "cancelled", "deploy-blocked", "static-ci-only"].sort()
    );
    expect(condition).toContain("attribute_not_exists(cancelledAt)");
  });
});

describe("TEAM-5358 FR-3 / F8 — reason and identity", () => {
  it.each([[null], [{}], [{ reason: "  \u0007 " }]])("body without reason -> 400 and no UpdateCommand (%j)", async (body) => {
    h.state.workflow = running();
    const res = await call(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("reason_required");
    expect(h.state.updates).toHaveLength(0);
  });

  it("a reason over 1000 chars -> 400 reason_too_long, never clamped", async () => {
    h.state.workflow = running();
    const res = await call({ reason: "x".repeat(1001) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "reason_too_long", max: 1000 });
    expect(h.state.updates).toHaveLength(0);
  });

  it("a decision other than stopped -> 400 decision_invalid", async () => {
    h.state.workflow = running();
    const res = await call({ reason: "r", decision: "approve" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("decision_invalid");
    expect(h.state.updates).toHaveLength(0);
  });

  it("SET contains cancelledBy and cancelReason and never completeReason", async () => {
    h.state.workflow = running();
    await call({ reason: "  superseded\u0000 by wf-2 " });
    const { expr, values } = rowValues();
    expect(expr).toContain("cancelledBy = :by");
    expect(expr).toContain("cancelReason = :reason");
    expect(expr).not.toContain("completeReason");
    expect(values[":reason"]).toBe("superseded by wf-2");
  });

  it("unauthenticated caller -> cancelledBy unauthenticated:cancel, claimedCaller taken from the header", async () => {
    h.state.workflow = running();
    const res = await call({ reason: "r" }, { "x-hub-caller": "workflow-manager" });
    const { expr, values } = rowValues();
    expect(values[":by"]).toBe("unauthenticated:cancel");
    expect(expr).toContain("claimedCaller = :cc");
    expect(values[":cc"]).toBe("workflow-manager");
    expect((await res.json()).cancelledBy).toBe("unauthenticated:cancel");
  });

  it("a signed-in human is the cancelledBy, and a service identity is recorded as-is", async () => {
    process.env.AUTH_MODE = SSO_AUTH_MODE;
    h.state.workflow = running();
    await call({ reason: "r" }, ADMIN_HEADERS);
    expect(rowValues().values[":by"]).toBe("admin@example.com");

    h.state.updates = [];
    await call({ reason: "r" }, SVC_HEADERS);
    expect(rowValues().values[":by"]).toBe("svc:workflow-manager");
  });
});

describe("TEAM-5358 F9 — cancelDecision needs a human or a verified stop on every human gate", () => {
  const gate = { ticketId: "G-1", status: "in_review", assignee: "human:engineer" };

  it("cancelDecision stopped is persisted only with a human identity (F9)", async () => {
    h.state.workflow = running();
    h.state.tickets = [gate];
    const anon = await call({ reason: "r", decision: "stopped" });
    expect(rowValues().expr).not.toContain("cancelDecision");
    expect((await anon.json()).decisionDropped).toBe(true);

    process.env.AUTH_MODE = SSO_AUTH_MODE;
    h.state.updates = [];
    const human = await call({ reason: "r", decision: "stopped" }, ADMIN_HEADERS);
    expect(rowValues().expr).toContain("cancelDecision = :decision");
    expect(rowValues().values[":decision"]).toBe("stopped");
    expect((await human.json()).decision).toBe("stopped");
  });

  it("a run with no human gate gives a non-human caller nothing to prove: dropped", async () => {
    h.state.workflow = running();
    await call({ reason: "r", decision: "stopped" }, SVC_HEADERS);
    expect(rowValues().expr).not.toContain("cancelDecision");
  });

  it("cancelDecision is persisted when every open human gate has a verified stopped record", async () => {
    h.state.workflow = running();
    h.state.tickets = [gate, { ticketId: "G-2", status: "cancelled", labels: ["human-review"] }, { ticketId: "A-1", status: "ready", assignee: "agentcore_hub_dev" }];
    h.state.s3Objects[gateKey("G-1")] = await signedStop("G-1");
    h.state.s3Objects[gateKey("G-2")] = await signedStop("G-2");
    const res = await call({ reason: "r", decision: "stopped" });
    expect(rowValues().values[":decision"]).toBe("stopped");
    const body = await res.json();
    expect(body.humanGatesLeftOpen).toEqual([]);
    expect(ticketUpdateIds()).toEqual(expect.arrayContaining(["G-1", "A-1", "epic-1"]));
  });

  it.each([
    ["signed with another key", async () => signedStop("G-1", {}, "some-other-key")],
    ["for another ticket", async () => signedStop("G-9")],
    ["for another workflow", async () => signedStop("G-1", { workflowId: "wf-other" })],
    ["an approve (status done)", async () => signedStop("G-1", { status: "done", decision: { option: "approve", override: false, channel: "hub", by: "e" } })],
  ])("a stop record %s does not count", async (_label, make) => {
    h.state.workflow = running();
    h.state.tickets = [gate];
    h.state.s3Objects[gateKey("G-1")] = await make();
    const res = await call({ reason: "r", decision: "stopped" });
    expect(rowValues().expr).not.toContain("cancelDecision");
    expect((await res.json()).humanGatesLeftOpen).toEqual(["G-1"]);
  });
});

describe("TEAM-5358 F2 / FR-3 — the sweep keeps human gates and live agents", () => {
  it("human gates without a stopped record are left open and listed", async () => {
    h.state.workflow = running();
    h.state.tickets = [
      { ticketId: "G-1", status: "in_review", assignee: "human:engineer" },
      { ticketId: "G-2", status: "blocked", labels: ["human-review"] },
      { ticketId: "A-1", status: "ready", assignee: "agentcore_hub_dev" },
      { ticketId: "D-1", status: "done", assignee: "agentcore_hub_dev" },
    ];
    const res = await call();
    const body = await res.json();
    expect(body.humanGatesLeftOpen).toEqual(["G-1", "G-2"]);
    expect(ticketUpdateIds()).not.toContain("G-1");
    expect(ticketUpdateIds()).not.toContain("G-2");
    expect(ticketUpdateIds()).not.toContain("D-1");
    expect(ticketUpdateIds()).toContain("A-1");
    expect(ticketUpdateIds()).not.toContain("epic-1"); // the epic is not over while a gate is open
  });

  it("a human gate with a verified stopped record is cancelled", async () => {
    h.state.workflow = running();
    h.state.tickets = [{ ticketId: "G-1", status: "in_review", assignee: "human:engineer" }];
    h.state.s3Objects[gateKey("G-1")] = await signedStop("G-1");
    const body = await (await call()).json();
    expect(body.humanGatesLeftOpen).toEqual([]);
    expect(ticketUpdateIds()).toContain("G-1");
  });

  it("an in_progress ticket with a live agentTask keeps its status", async () => {
    h.state.workflow = {
      ...running(),
      agentTasks: { "A-1": { status: "running" }, "A-2": { status: "waiting_response" }, "A-3": { status: "error" }, "A-4": { status: "complete" } },
    };
    h.state.tickets = ["A-1", "A-2", "A-3", "A-4", "A-5", "A-6"].map((ticketId) => ({ ticketId, status: "in_progress", assignee: "agentcore_hub_dev" }));
    h.state.s3Objects["completions/A-5.json"] = JSON.stringify({ ticket_id: "A-5", agent_id: "agentcore_hub_dev" });
    const body = await (await call()).json();
    expect(body.ticketsLeftRunning.sort()).toEqual(["A-1", "A-2", "A-4", "A-5"]);
    const updated = ticketUpdateIds();
    for (const kept of ["A-1", "A-2", "A-4", "A-5"]) expect(updated).not.toContain(kept);
    expect(updated).toEqual(expect.arrayContaining(["A-3", "A-6"]));
    expect(updated).not.toContain("epic-1");
  });

  it("each child cancel is conditioned on the status the sweep read", async () => {
    h.state.workflow = running();
    h.state.tickets = [{ ticketId: "A-1", status: "ready", assignee: "agentcore_hub_dev" }];
    await call();
    const child = h.state.updates.find((u) => (u.Key as Record<string, unknown>).ticketId === "A-1")!;
    expect(child.ConditionExpression).toBe("#s = :from");
    expect((child.ExpressionAttributeValues as Record<string, unknown>)[":from"]).toBe("ready");
  });
});

describe("TEAM-5358 — workflow.cancelled event", () => {
  it("workflow.cancelled goes to EventBridge and the events table with the same detail", async () => {
    h.state.workflow = running();
    h.state.tickets = [{ ticketId: "G-1", status: "in_review", assignee: "human:engineer" }];
    await call({ reason: "superseded" }, { "x-hub-caller": "telegram" });
    expect(h.state.events).toHaveLength(1);
    const [ev] = h.state.events;
    expect(ev.DetailType).toBe("workflow.cancelled");
    expect(ev.Source).toBe("agentcore-hub.orchestrator");
    const put = h.state.puts.find((p) => (p.Item as Record<string, unknown>).type === "workflow.cancelled")!;
    const tableDetail = (put.Item as Record<string, unknown>).detail as Record<string, unknown>;
    const { timestamp, ...busDetail } = JSON.parse(ev.Detail!);
    expect(timestamp).toBe(tableDetail.cancelledAt);
    expect(busDetail).toEqual(tableDetail);
    expect(tableDetail).toMatchObject({
      workflowId: "wf-1",
      cancelledBy: "unauthenticated:cancel",
      claimedCaller: "telegram",
      reason: "superseded",
      humanGatesLeftOpen: ["G-1"],
      ticketsLeftRunning: [],
      followUpsMoved: 0,
    });
  });
});
