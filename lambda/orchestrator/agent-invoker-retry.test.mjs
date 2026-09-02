/**
 * TEAM-3748 D4.2 — agent-invoker bounded transient-retry regression suite.
 *
 * These tests drive the REAL `handler` export through the legacy HARNESS path
 * (harnessArn has no ":runtime/" segment and USE_RUNTIME is unset), so
 * `withInvokeRetry` + `isRetriableInvokeError` + the escalation / dual-write
 * paths are all exercised end-to-end without exporting any internals from
 * agent-invoker.mjs. The harness path's single AWS seam is
 * `@aws-sdk/client-bedrock-agentcore`, whose `send` we mock to throw controlled
 * errors; the DynamoDB / EventBridge seams are mocked to record writes.
 *
 * Env is set BEFORE the dynamic import because agent-invoker.mjs reads
 * AGENT_INVOKE_MAX_ATTEMPTS / backoff knobs at module load. Backoff is pinned to
 * 0ms so retries are instant.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mutable state the mocked AWS seams write into. Hoisted so it survives
// vi.resetModules() (which only cache-busts the module graph, not this object).
const h = vi.hoisted(() => ({
  state: {
    updates: [],      // UpdateCommand inputs → TICKETS_TABLE
    puts: [],         // PutCommand inputs → EVENTS_TABLE (dual-write half)
    ebEntries: [],    // EventBridge PutEventsCommand entries
    invokeCalls: 0,   // how many times the harness client.send fired
    invokeImpl: async () => ({}),
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      send: async (cmd) => {
        const n = cmd?.constructor?.name;
        if (n === "UpdateCommand") { h.state.updates.push(cmd.input); return {}; }
        if (n === "PutCommand") { h.state.puts.push(cmd.input); return {}; }
        if (n === "GetCommand") return { Item: null };
        if (n === "QueryCommand") return { Items: [] };
        return {};
      },
    }),
  },
  UpdateCommand: class { constructor(i) { this.input = i; } },
  GetCommand: class { constructor(i) { this.input = i; } },
  QueryCommand: class { constructor(i) { this.input = i; } },
  PutCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class {
    async send(cmd) { h.state.ebEntries.push(...(cmd?.input?.Entries || [])); return {}; }
  },
  PutEventsCommand: class { constructor(i) { this.input = i; } },
}));

// The dynamically-imported harness seams. The shim's loader intercepts dynamic
// import() of these bare specifiers (verified) as long as the importing module
// lives in the repo (not /tmp).
vi.mock("@aws-sdk/client-bedrock-agentcore", () => ({
  BedrockAgentCoreClient: class {
    async send() { h.state.invokeCalls++; return h.state.invokeImpl(); }
  },
  InvokeHarnessCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@smithy/node-http-handler", () => ({
  NodeHttpHandler: class { constructor() {} },
}));

const HARNESS_EVENT = {
  // No ":runtime/" segment → legacy harness path.
  harnessArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/my-harness",
  sessionId: "sess-1",
  prompt: "do the thing",
  workflowId: "wf_1",
  agentId: "agentcore_hub_api_dev",
  ticketId: "TEAM-42",
};

// Reload agent-invoker.mjs with the desired env applied at module-load time.
async function loadHandler() {
  vi.resetModules();
  const mod = await import("./agent-invoker.mjs");
  return mod.handler;
}

function makeErr({ message = "boom", statusCode, name, code } = {}) {
  const e = new Error(message);
  if (statusCode !== undefined) e.statusCode = statusCode;
  if (name !== undefined) e.name = name;
  if (code !== undefined) e.code = code;
  return e;
}

const blockedUpdates = () => h.state.updates.filter((u) => u.ExpressionAttributeValues?.[":s"] === "blocked");
const doneUpdates = () => h.state.updates.filter((u) => u.ExpressionAttributeValues?.[":s"] === "done");
const errorEntries = () => h.state.ebEntries.filter((e) => e.DetailType === "agent.error");

beforeEach(() => {
  vi.clearAllMocks();
  h.state.updates = [];
  h.state.puts = [];
  h.state.ebEntries = [];
  h.state.invokeCalls = 0;
  h.state.invokeImpl = async () => ({});
  // Bounded to 3 attempts, zero backoff so retries are instant.
  process.env.AGENT_INVOKE_MAX_ATTEMPTS = "3";
  process.env.AGENT_INVOKE_BACKOFF_BASE_MS = "0";
  process.env.AGENT_INVOKE_BACKOFF_MAX_MS = "0";
  delete process.env.USE_RUNTIME;
});

describe("AC-D4.2(a) — transient 5xx fails twice then succeeds", () => {
  it("retries automatically, succeeds within the bound, no escalation/park", async () => {
    let n = 0;
    h.state.invokeImpl = async () => {
      n++;
      if (n <= 2) throw makeErr({ message: "Runtime returned 503: unavailable", statusCode: 503 });
      return {}; // success (no stream) → handler writes done
    };

    const handler = await loadHandler();
    await handler({ ...HARNESS_EVENT });

    // Two transient failures + one success = exactly 3 invoke attempts (<= bound).
    expect(h.state.invokeCalls).toBe(3);
    expect(h.state.invokeCalls).toBeLessThanOrEqual(3);
    // Legacy success path writes the ticket done itself.
    expect(doneUpdates()).toHaveLength(1);
    // No escalation: no blocked write, no agent.error published.
    expect(blockedUpdates()).toHaveLength(0);
    expect(errorEntries()).toHaveLength(0);
  });
});

describe("AC-D4.2(b) — transient failure exhausts the attempt bound", () => {
  it("stops at exactly AGENT_INVOKE_MAX_ATTEMPTS then falls through to escalation", async () => {
    h.state.invokeImpl = async () => { throw makeErr({ message: "Runtime returned 503", statusCode: 503 }); };

    const handler = await loadHandler();
    await handler({ ...HARNESS_EVENT });

    // Exactly the bound — no infinite loop (R7).
    expect(h.state.invokeCalls).toBe(3);
    // Existing escalation path: ticket blocked + one agent.error event.
    expect(blockedUpdates()).toHaveLength(1);
    expect(blockedUpdates()[0].Key).toEqual({ ticketId: "TEAM-42" });
    expect(errorEntries()).toHaveLength(1);
    expect(doneUpdates()).toHaveLength(0);
  });
});

describe("AC-D4.2(c) — non-retriable 4xx", () => {
  it("does NOT retry: single attempt, immediate escalation", async () => {
    h.state.invokeImpl = async () => { throw makeErr({ message: "Runtime returned 400: bad request", statusCode: 400 }); };

    const handler = await loadHandler();
    await handler({ ...HARNESS_EVENT });

    // Deterministic client fault → tried exactly once.
    expect(h.state.invokeCalls).toBe(1);
    expect(blockedUpdates()).toHaveLength(1);
    expect(errorEntries()).toHaveLength(1);
  });
});

describe("AC-D4.2(d) — isRetriableInvokeError classification (through the handler)", () => {
  // [label, expectedAttempts, errorFactory]. Retriable → runs the full bound (3);
  // non-retriable → exactly one attempt.
  const cases = [
    ["statusCode 500", 3, () => makeErr({ statusCode: 500 })],
    ["statusCode 503", 3, () => makeErr({ statusCode: 503 })],
    ["statusCode 429", 3, () => makeErr({ statusCode: 429 })],
    ["name ThrottlingException", 3, () => makeErr({ name: "ThrottlingException" })],
    ["name ServiceUnavailableException", 3, () => makeErr({ name: "ServiceUnavailableException" })],
    ["code ECONNRESET", 3, () => makeErr({ code: "ECONNRESET" })],
    ["message-only timeout", 3, () => makeErr({ message: "connection timed out" })],
    ["statusCode 400", 1, () => makeErr({ statusCode: 400 })],
    ["statusCode 403", 1, () => makeErr({ statusCode: 403 })],
    ["statusCode 404", 1, () => makeErr({ statusCode: 404 })],
    ["statusCode 422", 1, () => makeErr({ statusCode: 422 })],
    ["unknown/unclassifiable", 1, () => makeErr({ message: "weird opaque failure" })],
  ];

  it.each(cases)("%s → %s invoke attempt(s)", async (label, attempts, makeThrow) => {
    h.state.invokeImpl = async () => { throw makeThrow(); };

    const handler = await loadHandler();
    await handler({ ...HARNESS_EVENT });

    expect(h.state.invokeCalls).toBe(attempts);
    // Every terminal failure escalates exactly once regardless of retriability.
    expect(blockedUpdates()).toHaveLength(1);
    expect(errorEntries()).toHaveLength(1);
  });
});

describe("D4.3 liveness — publishAgentEvent dual-writes + threads ticketId", () => {
  it("writes agent.error to BOTH EventBridge and EVENTS_TABLE with the ticketId", async () => {
    h.state.invokeImpl = async () => { throw makeErr({ message: "Runtime returned 400", statusCode: 400 }); };

    const handler = await loadHandler();
    await handler({ ...HARNESS_EVENT });

    // EventBridge half.
    const eb = errorEntries();
    expect(eb).toHaveLength(1);
    expect(eb[0].Source).toBe("agentcore-hub.agent-invoker");
    const ebDetail = JSON.parse(eb[0].Detail);
    expect(ebDetail.workflowId).toBe("wf_1");
    expect(ebDetail.agentId).toBe("agentcore_hub_api_dev");
    expect(ebDetail.ticketId).toBe("TEAM-42");
    expect(ebDetail.timestamp).toBeDefined();

    // EVENTS_TABLE half (the D4.3 addition that lets the detector read harness heartbeats).
    const errPuts = h.state.puts.filter((p) => p.Item?.type === "agent.error");
    expect(errPuts).toHaveLength(1);
    const put = errPuts[0];
    expect(put.Item.workflowId).toBe("wf_1");
    expect(put.Item.detail.ticketId).toBe("TEAM-42");
    expect(put.Item.detail.agentId).toBe("agentcore_hub_api_dev");
    expect(put.Item.eventId).toBeDefined();
    expect(put.Item.timestamp).toBeDefined();
  });

  it("falls back workflowId→agentId on the EVENTS_TABLE key when workflowId is absent", async () => {
    h.state.invokeImpl = async () => { throw makeErr({ statusCode: 400 }); };

    const handler = await loadHandler();
    await handler({ ...HARNESS_EVENT, workflowId: undefined });

    const errPuts = h.state.puts.filter((p) => p.Item?.type === "agent.error");
    expect(errPuts).toHaveLength(1);
    // Item.workflowId = workflowId || agentId.
    expect(errPuts[0].Item.workflowId).toBe("agentcore_hub_api_dev");
  });
});
