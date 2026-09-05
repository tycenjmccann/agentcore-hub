import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { WorkflowDef } from "@/lib/workflow/workflow-defs";

/**
 * TEAM-3335 F2: the reserved-intakeChannel gate on POST /api/workflow/start.
 *
 * "anomaly-detector" is the value the anomaly-watcher Lambda files under; its
 * fleet-wide open-filing cap is a GSI count on that exact value, and FR-7 needs
 * autonomous filings to be audit-distinguishable. The route has no auth in the
 * default AUTH_MODE=none, so the reserved value must demand the shared-secret
 * header — and FAIL CLOSED when ANOMALY_INTAKE_SECRET is unset on the server.
 *
 * We mock ONLY the seams: the DynamoDB document client (capturing every
 * PutCommand Item), the ticket-tools Lambda invoke, the live-config def loader,
 * and source validation. The real POST handler runs — including the regex
 * check, the reserved-value gate, and the conditional `...(body.intakeChannel …)`
 * spread whose byte-identical behavior for omitted values is the regression
 * being pinned here.
 */
const h = vi.hoisted(() => {
  const puts: Array<{ TableName: string; Item: Record<string, unknown> }> = [];
  const invokes: Array<{ tool_name: string; parameters: Record<string, unknown> }> = [];
  return { puts, invokes };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class PutCommand {
    constructor(public input: { TableName: string; Item: Record<string, unknown> }) {}
  }
  return {
    PutCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: InstanceType<typeof PutCommand>) => {
          h.puts.push(cmd.input);
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => {
  class InvokeCommand {
    Payload: Uint8Array;
    constructor(input: { Payload: Uint8Array }) {
      this.Payload = input.Payload;
    }
  }
  class LambdaClient {
    async send(cmd: InstanceType<typeof InvokeCommand>) {
      h.invokes.push(JSON.parse(Buffer.from(cmd.Payload).toString("utf8")));
      // Shape invokeTicketLambda expects from Tickets___create_ticket /
      // Tickets___transition_ticket — a key and no error.
      return { Payload: new TextEncoder().encode(JSON.stringify({ key: "TEAM-100" })) };
    }
  }
  return { LambdaClient, InvokeCommand };
});

vi.mock("@/lib/workflow/intake", () => ({
  // TEAM-4054 contract: a structured result + the two pure decision helpers.
  validateIntakeSources: vi.fn(async (sources: unknown[] = []) => ({
    results: [],
    definitiveErrors: [],
    transientErrors: [],
    sources,
  })),
  getSourceValidationMode: vi.fn(() => "lenient" as const),
  shouldRejectSubmission: vi.fn(() => ({ reject: false, errors: [] as string[] })),
}));

const DEF: WorkflowDef = {
  id: "software-delivery",
  name: "Software Delivery",
  description: "test def",
  icon: "Workflow",
  intakeAgentId: "requirements-analyst",
  requiresRepo: false,
  featureBranchPhase: null,
  createsPullRequest: false,
  completionRequiresAgentPhases: [],
  phases: [{ id: "requirements", name: "Requirements", type: "agent", agentPhase: "requirements" }],
};

vi.mock("@/lib/workflow/defs-loader", () => ({
  resolveWorkflowDef: vi.fn(async () => DEF),
}));

let POST: typeof import("./route").POST;

const SAVED_KEYS = ["ANOMALY_INTAKE_SECRET", "TICKET_PROVIDER"] as const;
const saved: Partial<Record<(typeof SAVED_KEYS)[number], string | undefined>> = {};

beforeEach(async () => {
  h.puts.length = 0;
  h.invokes.length = 0;
  for (const key of SAVED_KEYS) saved[key] = process.env[key];
  delete process.env.ANOMALY_INTAKE_SECRET;
  // The provider is a module-scope const, so pin it before the import below.
  process.env.TICKET_PROVIDER = "dynamodb";
  vi.resetModules();
  ({ POST } = await import("./route"));
});

afterEach(() => {
  for (const key of SAVED_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest("http://localhost/api/workflow/start", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

/** The single workflow-metadata PutCommand Item a successful start writes. */
function workflowItem(): Record<string, unknown> {
  expect(h.puts.length).toBe(1);
  return h.puts[0].Item;
}

describe("POST /api/workflow/start — reserved intakeChannel gate (TEAM-3335)", () => {
  it("rejects the reserved value with 403 when the secret header is missing, writing nothing", async () => {
    process.env.ANOMALY_INTAKE_SECRET = "topsecret";
    const res = await post({ title: "t", intakeChannel: "anomaly-detector" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/reserved/);
    expect(h.puts.length).toBe(0);
    expect(h.invokes.length).toBe(0);
  });

  it("rejects the reserved value with 403 on a wrong secret", async () => {
    process.env.ANOMALY_INTAKE_SECRET = "topsecret";
    const res = await post(
      { title: "t", intakeChannel: "anomaly-detector" },
      { "x-intake-internal-secret": "not-the-secret" }
    );
    expect(res.status).toBe(403);
    expect(h.puts.length).toBe(0);
    expect(h.invokes.length).toBe(0);
  });

  it("accepts the reserved value with the correct secret and persists it on the Item", async () => {
    process.env.ANOMALY_INTAKE_SECRET = "topsecret";
    const res = await post(
      { title: "t", intakeChannel: "anomaly-detector" },
      { "x-intake-internal-secret": "topsecret" }
    );
    expect(res.status).toBe(200);
    expect((await res.json()).workflowId).toMatch(/^wf_/);
    expect(workflowItem().intakeChannel).toBe("anomaly-detector");
  });

  it("fails CLOSED: secret unset on the server rejects even a correct-looking header", async () => {
    // beforeEach deleted ANOMALY_INTAKE_SECRET — nothing the caller sends may match.
    const res = await post(
      { title: "t", intakeChannel: "anomaly-detector" },
      { "x-intake-internal-secret": "topsecret" }
    );
    expect(res.status).toBe(403);
    expect(h.puts.length).toBe(0);
    expect(h.invokes.length).toBe(0);
  });

  it("regression: an omitted intakeChannel succeeds with NO intakeChannel attribute on the Item", async () => {
    process.env.ANOMALY_INTAKE_SECRET = "topsecret";
    const res = await post({ title: "t" });
    expect(res.status).toBe(200);
    const item = workflowItem();
    expect("intakeChannel" in item).toBe(false);
  });

  it("accepts a non-reserved value with no header (regex-only path) and persists it", async () => {
    process.env.ANOMALY_INTAKE_SECRET = "topsecret";
    const res = await post({ title: "t", intakeChannel: "jira-webhook" });
    expect(res.status).toBe(200);
    expect(workflowItem().intakeChannel).toBe("jira-webhook");
  });

  it("still 400s a malformed value first, before any reserved-value logic", async () => {
    const res = await post({ title: "t", intakeChannel: "Bad_Channel!" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/intakeChannel must match/);
    expect(h.puts.length).toBe(0);
    expect(h.invokes.length).toBe(0);
  });
});
