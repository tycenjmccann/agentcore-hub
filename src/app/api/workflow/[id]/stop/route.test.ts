import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { ADMIN_HEADERS, SSO_AUTH_MODE, SVC_HEADERS } from "@/lib/auth/admin-test-headers";
import { resetDecisionKeyCache } from "@/lib/workflow/decision-keys";
import { scopeHash, verifyDecisionToken } from "@/lib/workflow/decision-contract";

/**
 * TEAM-5358 FR-8 — POST /api/workflow/[id]/stop: human-only. Every open human:*
 * gate is closed with a hub-minted `stopped` token (scope-bound) through the
 * ticket Lambda, THEN the run is cancelled with decision stopped. Same seams as
 * cancel/route.test.ts (DDB doc client, S3, EventBridge, ticket Lambda).
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
    tools: Array<{ tool: string; params: Record<string, unknown> }>;
    toolImpl: (tool: string, params: Record<string, unknown>) => unknown;
    onUpdate?: (input: Record<string, unknown>) => void;
  } = { workflow: {}, tickets: [], updates: [], puts: [], s3Objects: {}, events: [], tools: [], toolImpl: () => ({}) };
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
            h.state.onUpdate?.(cmd.input);
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

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd: { input: { Payload: Uint8Array } }) {
      const { tool_name, parameters } = JSON.parse(Buffer.from(cmd.input.Payload).toString());
      h.state.tools.push({ tool: tool_name, params: parameters });
      return { Payload: new TextEncoder().encode(JSON.stringify(h.state.toolImpl(tool_name, parameters))) };
    }
  },
  InvokeCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

const { POST } = await import("./route");

const TEST_DECISION_KEY = "stop-route-test-gate-decision-key";
const SAVED_ENV = { AUTH_MODE: process.env.AUTH_MODE, GATE_DECISION_KEY: process.env.GATE_DECISION_KEY };
const HUMAN = { ...ADMIN_HEADERS };

const call = (body: unknown = { reason: "wrong repo, stopping" }, headers: Record<string, string> = HUMAN) =>
  POST(
    new NextRequest("http://localhost/api/workflow/wf-1/stop", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
    }),
    { params: { id: "wf-1" } }
  );

const running = () => ({ workflowId: "wf-1", epicId: "epic-1", phase: "development" });
const GATE_DESC = "Approve the merge.\nDECISION OPTIONS: approve | reject";
const gate = (ticketId: string, over: Record<string, unknown> = {}) => ({
  ticketId,
  status: "in_review",
  assignee: "human:engineer",
  title: `Merge approval ${ticketId}`,
  description: GATE_DESC,
  ...over,
});
const transitions = () => h.state.tools.filter((t) => t.tool === "Tickets___transition_ticket");
const workflowUpdates = () => h.state.updates.filter((u) => (u.Key as Record<string, unknown> | undefined)?.workflowId);

function defaultTool(tool: string, params: Record<string, unknown>): unknown {
  if (tool === "Tickets___transition_ticket") return { key: params.ticket_id, status: "transitioned" };
  return { key: params.ticket_id, status: "updated" };
}

beforeEach(() => {
  h.state.workflow = running();
  h.state.tickets = [];
  h.state.updates = [];
  h.state.puts = [];
  h.state.s3Objects = {};
  h.state.events = [];
  h.state.tools = [];
  h.state.toolImpl = defaultTool;
  h.state.onUpdate = undefined;
  process.env.GATE_DECISION_KEY = TEST_DECISION_KEY;
  process.env.AUTH_MODE = SSO_AUTH_MODE;
  resetDecisionKeyCache();
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetDecisionKeyCache();
});

describe("TEAM-5358 FR-8 — Stop the run", () => {
  it.each([
    ["auth off (default identity)", () => delete process.env.AUTH_MODE, HUMAN],
    ["a service identity", () => undefined, SVC_HEADERS],
  ])("%s -> 403 and no twin invoke, no row write", async (_l, setup, headers) => {
    setup();
    h.state.tickets = [gate("T-G1")];
    const res = await call(undefined, headers);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("human_identity_required");
    expect(h.state.tools).toHaveLength(0);
    expect(h.state.updates).toHaveLength(0);
  });

  it("missing reason -> 400 reason_required, nothing touched", async () => {
    h.state.tickets = [gate("T-G1")];
    const res = await call({});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("reason_required");
    expect(h.state.tools).toHaveLength(0);
  });

  it("one cancelled transition per open human gate with a stopped token, then one cancel with decision stopped", async () => {
    h.state.tickets = [
      gate("T-G1"),
      gate("T-G2", { status: "blocked", description: "Ship it?" }),
      gate("T-DONE", { status: "done" }),
      { ticketId: "T-A", status: "ready", assignee: "agentcore_hub_backend_dev" },
    ];
    let rowWrittenBeforeAGate = false;
    h.state.toolImpl = (tool, params) => {
      if (workflowUpdates().length > 0) rowWrittenBeforeAGate = true;
      return defaultTool(tool, params);
    };
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "cancelled", gatesStopped: ["T-G1", "T-G2"], gatesNotStopped: [] });
    expect(body.decision).toBe("stopped");

    const calls = transitions();
    expect(calls.map((c) => c.params.ticket_id)).toEqual(["T-G1", "T-G2"]);
    for (const c of calls) {
      expect(c.params).toMatchObject({
        transition_id: "cancelled",
        decision: "stopped",
        note: "wrong repo, stopping",
        reason: "wrong repo, stopping\nDECISION: override:stopped",
      });
      const v = verifyDecisionToken(c.params.decision_token, { ticketId: String(c.params.ticket_id), keys: [TEST_DECISION_KEY], workflowId: "wf-1" });
      expect(v).toMatchObject({ ok: true, option: "stopped", channel: "hub", by: "admin@example.com" });
      const desc = c.params.ticket_id === "T-G1" ? GATE_DESC : "Ship it?";
      expect((v as { s?: string }).s).toBe(scopeHash(desc));
    }
    expect(rowWrittenBeforeAGate).toBe(false);

    const [row] = workflowUpdates();
    expect(String(row.UpdateExpression)).toContain("cancelDecision = :decision");
    expect((row.ExpressionAttributeValues as Record<string, unknown>)[":by"]).toBe("admin@example.com");
  });

  it("a gate the twin refuses lands in gatesNotStopped and the cancel still runs", async () => {
    h.state.tickets = [gate("T-G1"), gate("T-G2")];
    h.state.toolImpl = (tool, params) =>
      params.ticket_id === "T-G2" ? { ok: false, reason: "decision_scope_changed", content: [{ text: "Error: scope changed" }] } : defaultTool(tool, params);
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.gatesStopped).toEqual(["T-G1"]);
    expect(body.gatesNotStopped).toEqual([{ ticketId: "T-G2", error: expect.stringMatching(/decision_scope_changed/) }]);
    expect(workflowUpdates()).toHaveLength(1);
    expect(body.status).toBe("cancelled");
  });

  it("a terminal run -> 409 before any gate is touched", async () => {
    h.state.workflow = { ...running(), phase: "complete" };
    h.state.tickets = [gate("T-G1")];
    const res = await call();
    expect(res.status).toBe(409);
    expect(h.state.tools).toHaveLength(0);
  });

  it("a run with no open human gate is just a cancel with decision stopped", async () => {
    h.state.tickets = [{ ticketId: "T-A", status: "ready", assignee: "agentcore_hub_backend_dev" }];
    const body = await (await call()).json();
    expect(body).toMatchObject({ status: "cancelled", gatesStopped: [], gatesNotStopped: [] });
    expect(transitions()).toHaveLength(0);
  });
});
