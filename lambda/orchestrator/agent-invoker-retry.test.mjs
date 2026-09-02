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
    // TEAM-3756 F4 — the liveness re-check's Query seam (agentStartedSince) and
    // the runtime path's raw-HTTPS seam.
    queries: [],      // QueryCommand inputs → EVENTS_TABLE
    queryImpl: async () => ({ Items: [] }),
    httpCalls: 0,     // how many https requests the runtime path sent
    httpImpl: null,   // (options, cb) => req — per-test behavior
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
        if (n === "QueryCommand") { h.state.queries.push(cmd.input); return h.state.queryImpl(cmd.input); }
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

// The runtime path's dynamically-imported seams (TEAM-3756 F4 tests): raw
// https + SigV4 signing. The signer passes the request through untouched.
vi.mock("https", () => ({
  default: {
    request: (options, cb) => { h.state.httpCalls++; return h.state.httpImpl(options, cb); },
  },
}));
vi.mock("@smithy/signature-v4", () => ({
  SignatureV4: class { async sign(req) { return req; } },
}));
vi.mock("@aws-crypto/sha256-js", () => ({ Sha256: class {} }));
vi.mock("@aws-sdk/credential-provider-node", () => ({ defaultProvider: () => () => ({}) }));

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
  h.state.queries = [];
  h.state.queryImpl = async () => ({ Items: [] });
  h.state.httpCalls = 0;
  h.state.httpImpl = null;
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
    // TEAM-3756 F4: post-write-ambiguous failures (reset/timeout with no HTTP
    // response) are NOT retried on the synchronous harness path — the first
    // request may already have been accepted, and this path has no liveness
    // view to prove otherwise (no-duplicate-session, R7/FR-D4.4). These two
    // previously ran the full bound of 3, which was the F4 double-send bug.
    ["code ECONNRESET (post-write ambiguous)", 1, () => makeErr({ code: "ECONNRESET" })],
    ["message-only timeout (post-write ambiguous)", 1, () => makeErr({ message: "connection timed out" })],
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

/**
 * TEAM-3756 F4 — the no-duplicate-session retry guard on the fire-and-forget
 * RUNTIME path (R7 / FR-D4.4). A post-write connection failure leaves it
 * unknowable whether the runtime accepted the request and started the agent;
 * re-sending with the SAME sessionId would double-start it. Before each such
 * retry the invoker now re-checks EVENTS_TABLE for agent.started/agent.streaming
 * heartbeats for this ticket:
 *   started      → the first attempt succeeded: no retry, treated as success;
 *   not started  → the bounded transient retry proceeds (FR-D4.2 retained);
 *   unknowable   → no retry (the dead-session detector recovers a lost claim; a
 *                  duplicate session cannot be recalled).
 * A failure carrying an HTTP status (5xx/429) is a PROVEN rejection — the
 * runtime answered, so nothing started — and stays a blind bounded retry with
 * no liveness query at all.
 */
describe("TEAM-3756 F4 — runtime retry re-checks liveness before re-sending", () => {
  const RUNTIME_EVENT = {
    ...HARNESS_EVENT,
    harnessArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my-runtime",
  };

  // (options, cb) → req whose end() fails post-write with ECONNRESET.
  const resetAfterWrite = () => (options, cb) => {
    const handlers = {};
    const req = {
      on: (ev, fn) => { handlers[ev] = fn; return req; },
      write: () => {},
      end: () => setTimeout(() => handlers.error?.(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })), 0),
    };
    return req;
  };
  // (options, cb) → req that is accepted with HTTP 200.
  const accept = () => (options, cb) => {
    const req = {
      on: () => req,
      write: () => {},
      end: () => setTimeout(() => cb({ statusCode: 200, destroy: () => {}, on: () => {} }), 0),
    };
    return req;
  };
  // (options, cb) → req answered with an HTTP 503 (proven rejection).
  const reject503 = () => (options, cb) => {
    const req = {
      on: () => req,
      write: () => {},
      end: () => setTimeout(() => {
        const resHandlers = {};
        cb({ statusCode: 503, destroy: () => {}, on: (ev, fn) => { resHandlers[ev] = fn; } });
        setTimeout(() => { resHandlers.data?.(Buffer.from("unavailable")); resHandlers.end?.(); }, 0);
      }, 0),
    };
    return req;
  };
  const startedEvent = (overrides = {}) => ({
    type: "agent.started",
    timestamp: new Date().toISOString(),
    detail: { ticketId: "TEAM-42", agentId: "agentcore_hub_api_dev" },
    ...overrides,
  });
  const perCall = (...impls) => {
    let i = 0;
    return (options, cb) => impls[Math.min(i++, impls.length - 1)]()(options, cb);
  };

  it("post-write reset + agent.started observed → NO second request, treated as success", async () => {
    h.state.httpImpl = resetAfterWrite();
    h.state.queryImpl = async () => ({ Items: [startedEvent()] });

    const handler = await loadHandler();
    await handler({ ...RUNTIME_EVENT });

    expect(h.state.httpCalls).toBe(1);        // the retry never fired
    expect(h.state.queries).toHaveLength(1);  // ...because the re-check proved a start
    expect(blockedUpdates()).toHaveLength(0); // success: no escalation of any kind
    expect(errorEntries()).toHaveLength(0);
  });

  it("post-write reset + NO heartbeat → bounded retry proceeds and succeeds (FR-D4.2 retained)", async () => {
    h.state.httpImpl = perCall(resetAfterWrite, accept);

    const handler = await loadHandler();
    await handler({ ...RUNTIME_EVENT });

    expect(h.state.httpCalls).toBe(2);
    expect(h.state.queries.length).toBeGreaterThanOrEqual(1); // the guard ran before the retry
    expect(blockedUpdates()).toHaveLength(0);
    expect(errorEntries()).toHaveLength(0);
  });

  it("a STALE heartbeat (before this invocation) does not suppress the retry", async () => {
    h.state.httpImpl = perCall(resetAfterWrite, accept);
    // A heartbeat from the ticket's PREVIOUS session, two minutes old.
    h.state.queryImpl = async () => ({
      Items: [startedEvent({ timestamp: new Date(Date.now() - 120_000).toISOString() })],
    });

    const handler = await loadHandler();
    await handler({ ...RUNTIME_EVENT });

    expect(h.state.httpCalls).toBe(2); // old event ignored → retry proceeds
    expect(errorEntries()).toHaveLength(0);
  });

  it("post-write reset + liveness UNKNOWABLE (query fails) → no retry, existing escalation runs once", async () => {
    h.state.httpImpl = resetAfterWrite();
    h.state.queryImpl = async () => { throw new Error("ThrottlingException"); };

    const handler = await loadHandler();
    await handler({ ...RUNTIME_EVENT });

    expect(h.state.httpCalls).toBe(1);        // R7 wins: never re-send on maybe-started
    expect(blockedUpdates()).toHaveLength(1); // the normal terminal-failure path
    expect(errorEntries()).toHaveLength(1);
  });

  it("a PROVEN rejection (HTTP 503) is still a blind bounded retry — no liveness query", async () => {
    h.state.httpImpl = perCall(reject503, accept);

    const handler = await loadHandler();
    await handler({ ...RUNTIME_EVENT });

    expect(h.state.httpCalls).toBe(2);       // retried as before F4
    expect(h.state.queries).toHaveLength(0); // the runtime answered → nothing could have started
    expect(blockedUpdates()).toHaveLength(0);
    expect(errorEntries()).toHaveLength(0);
  });
});
