import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { resetDecisionKeyCache } from "@/lib/workflow/decision-keys";
import { buildGateDecisionRecord } from "../../../../../../lambda/agentcore-hub-tickets/gate-contract.mjs";

/**
 * TEAM-5395 F6 — POST /api/workflow/[id]/nudge (broad scan) readies a blocked
 * dependent only when every blocker resolves by THE rule (nudgeBlockerResolved): a
 * done agent ticket, or a done human gate whose signed gate decision stands. A gate
 * a human dragged to Done in Jira whose ratify and reopen both failed reads Done
 * with no record and must keep its dependent blocked. Both providers.
 * Seams: DDB doc client, S3, ticket Lambda (get_issue), JiraClient.
 */

const h = vi.hoisted(() => {
  process.env.ARTIFACT_BUCKET = "test-bucket";
  const state: {
    workflow: Record<string, unknown>;
    tickets: Array<Record<string, unknown>>;
    issues: Array<Record<string, unknown>>;
    updates: Array<Record<string, unknown>>;
    jiraTransitions: Array<[string, string]>;
    s3Objects: Record<string, string>;
    s3Error?: Error;
    tools: Array<{ tool: string; params: Record<string, unknown> }>;
    toolImpl: (tool: string, params: Record<string, unknown>) => unknown;
  } = { workflow: {}, tickets: [], issues: [], updates: [], jiraTransitions: [], s3Objects: {}, tools: [], toolImpl: () => ({}) };
  return { state };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class GetCommand { constructor(public input: Record<string, unknown>) {} }
  class UpdateCommand { constructor(public input: Record<string, unknown>) {} }
  class ScanCommand { constructor(public input: Record<string, unknown>) {} }
  class PutCommand { constructor(public input: Record<string, unknown>) {} }
  return {
    GetCommand, UpdateCommand, ScanCommand, PutCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
          const name = cmd.constructor.name;
          if (name === "GetCommand") return { Item: h.state.workflow };
          if (name === "ScanCommand") return { Items: h.state.tickets };
          if (name === "UpdateCommand") h.state.updates.push(cmd.input);
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd: { input: { Key: string } }) {
      if (h.state.s3Error) throw h.state.s3Error;
      const body = h.state.s3Objects[cmd.input.Key];
      if (body === undefined) {
        const e = new Error("The specified key does not exist.");
        e.name = "NoSuchKey";
        throw e;
      }
      return { Body: { transformToString: async () => body } };
    }
  },
  GetObjectCommand: class { constructor(public input: Record<string, unknown>) {} },
}));

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd: { input: { Payload: Uint8Array } }) {
      const { tool_name, parameters } = JSON.parse(Buffer.from(cmd.input.Payload).toString());
      h.state.tools.push({ tool: tool_name, params: parameters });
      return { Payload: new TextEncoder().encode(JSON.stringify(h.state.toolImpl(tool_name, parameters))) };
    }
  },
  InvokeCommand: class { constructor(public input: Record<string, unknown>) {} },
}));

// The "no decision key" case: the secret read fails (never a real AWS call).
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class { async send() { throw Object.assign(new Error("not found"), { name: "ResourceNotFoundException" }); } },
  GetSecretValueCommand: class { constructor(public input: Record<string, unknown>) {} },
}));

vi.mock("@/lib/workflow/jira-client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/workflow/jira-client")>();
  return {
    ...real,
    JiraClient: {
      fromEnv: () => ({
        getChildIssues: async () => h.state.issues,
        transitionIssue: async (key: string, to: string) => { h.state.jiraTransitions.push([key, to]); },
      }),
    },
  };
});

const { POST } = await import("./route");

const KEY = "nudge-route-test-gate-decision-key";
const WF = "wf-1";
const G = "GATE-1";
const D = "TEAM-D";
const SAVED_ENV = { GATE_DECISION_KEY: process.env.GATE_DECISION_KEY, TICKET_PROVIDER: process.env.TICKET_PROVIDER };

const call = () =>
  POST(new NextRequest(`http://localhost/api/workflow/${WF}/nudge`, { method: "POST" }), { params: { id: WF } });

/** The twin's signed approve for G in the gate's current (never-reset) cycle. */
const decide = (option = "approve") => {
  h.state.s3Objects[`pipeline-artifacts/gate-decisions/${WF}/gates/${G}.json`] = JSON.stringify(
    buildGateDecisionRecord({ ticketId: G, workflowId: WF, decision: { option, channel: "console", by: "human:ops" }, labels: [], cycle: null }, KEY)
  );
};
const getIssueCalls = () => h.state.tools.filter((t) => t.tool === "Tickets___get_issue");
const liveGate = (_tool: string, params: Record<string, unknown>) => ({ key: params.ticket_id, fields: { description: "" }, gateCycle: null });

beforeEach(() => {
  h.state.workflow = { workflowId: WF, epicId: "EPIC-1", phase: "development" };
  h.state.tickets = [];
  h.state.issues = [];
  h.state.updates = [];
  h.state.jiraTransitions = [];
  h.state.s3Objects = {};
  h.state.s3Error = undefined;
  h.state.tools = [];
  h.state.toolImpl = liveGate;
  process.env.GATE_DECISION_KEY = KEY;
  resetDecisionKeyCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetDecisionKeyCache();
  vi.restoreAllMocks();
});

describe("DynamoDB provider", () => {
  beforeEach(() => { process.env.TICKET_PROVIDER = "dynamodb"; });
  const board = (blocker: Record<string, unknown>, depStatus = "blocked") => {
    h.state.tickets = [blocker, { ticketId: D, workflowId: WF, status: depStatus, assignee: "dev", blockedBy: [blocker.ticketId] }];
  };
  const gateDone = { ticketId: G, workflowId: WF, status: "done", assignee: "human:ops" };
  const readied = () => h.state.updates.filter((u) => (u.Key as { ticketId?: string }).ticketId === D);

  it("(1) gate Done with no decision record → dependent not readied", async () => {
    board(gateDone);
    const body = await (await call()).json();
    expect(body.nudged).toEqual([]);
    expect(readied()).toHaveLength(0);
  });

  it("(2) a standing decision → readied exactly once; a re-nudge is a no-op", async () => {
    decide();
    board(gateDone);
    expect((await (await call()).json()).nudged).toEqual([`${D} (unblocked→ready)`]);
    expect(readied()).toHaveLength(1);
    board(gateDone, "ready");
    expect((await (await call()).json()).nudged).toEqual([]);
    expect(readied()).toHaveLength(1);
  });

  it("(2) a signed stop is not an approve → dependent not readied", async () => {
    decide("stopped");
    board(gateDone);
    await call();
    expect(readied()).toHaveLength(0);
  });

  it("(3) a done agent blocker readies as before, touching neither S3 nor get_issue", async () => {
    h.state.s3Error = new Error("S3 must not be read");
    board({ ticketId: "TEAM-1", workflowId: WF, status: "done", assignee: "dev" });
    expect((await (await call()).json()).nudged).toEqual([`${D} (unblocked→ready)`]);
    expect(getIssueCalls()).toHaveLength(0);
  });

  it.each([
    ["S3 read fails", () => { decide(); h.state.s3Error = Object.assign(new Error("AccessDenied"), { name: "AccessDenied" }); }],
    ["get_issue refuses", () => { decide(); h.state.toolImpl = () => ({ error: "boom" }); }],
    ["no decision key", () => { decide(); delete process.env.GATE_DECISION_KEY; }],
  ])("(4) %s → dependent stays blocked", async (_n, arrange) => {
    arrange();
    board(gateDone);
    const res = await call();
    expect(res.status).toBe(200);
    expect(readied()).toHaveLength(0);
  });
});

describe("Jira provider", () => {
  beforeEach(() => { process.env.TICKET_PROVIDER = "jira"; });
  const issue = (key: string, status: string, labels: string[], blockedBy: string[] = []) => ({
    key,
    fields: {
      status: { name: status },
      labels,
      issuelinks: blockedBy.map((b) => ({ type: { name: "Blocks" }, inwardIssue: { key: b } })),
    },
  });
  const onGate = () => {
    h.state.issues = [issue(G, "Done", ["reviewer:ops", `wf:${WF}`]), issue(D, "Blocked", ["agent:dev"], [G])];
  };
  const readied = () => h.state.jiraTransitions.filter(([k]) => k === D);

  it("(1) a gate reading Done after a failed reopen (no record) → dependent not readied", async () => {
    onGate();
    const body = await (await call()).json();
    expect(body.nudged).toEqual([]);
    expect(readied()).toHaveLength(0);
  });

  it("(2) a standing decision → readied exactly once", async () => {
    decide();
    onGate();
    expect((await (await call()).json()).nudged).toEqual([`${D} (unblocked→ready)`]);
    expect(readied()).toEqual([[D, "Ready"]]);
    expect(getIssueCalls().map((c) => c.params.ticket_id)).toEqual([G]);
  });

  it("(3) a done agent blocker readies as before with no decision read", async () => {
    h.state.s3Error = new Error("S3 must not be read");
    h.state.issues = [issue("TEAM-1", "Done", ["agent:dev"]), issue(D, "Blocked", ["agent:dev"], ["TEAM-1"])];
    expect((await (await call()).json()).nudged).toEqual([`${D} (unblocked→ready)`]);
    expect(getIssueCalls()).toHaveLength(0);
  });

  it("(4) a stale decision (the gate's cycle reset since) → dependent stays blocked", async () => {
    decide();
    h.state.toolImpl = (_t, p) => ({ key: p.ticket_id, fields: { description: "" }, gateCycle: "2026-10-06T00:00:00.000Z" });
    onGate();
    await call();
    expect(readied()).toHaveLength(0);
  });
});
