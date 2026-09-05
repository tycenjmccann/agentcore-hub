import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { MAX_INTAKE_SOURCES } from "@/lib/workflow/source-shape";
import type { WorkflowDef } from "@/lib/workflow/workflow-defs";

/**
 * TEAM-4078 F1a — the start route's intake-source SHAPE gate.
 *
 * The route has no auth under AUTH_MODE=none and is POSTed directly by
 * routines-runner, prd-submitter, the telegram intake Lambda and scripts. It
 * took `await req.json()` straight into WorkflowInput with no per-item check, so
 * `sources:[{ type:"upload", value:null }]` was accepted (validateIntakeSources
 * coerces a non-string value to "" → "skipped"), persisted verbatim (null
 * survives DynamoDB's removeUndefinedValues), and crashed the board on read.
 *
 * Same seams mocked as route.repo-check.test.ts. source-shape.ts is deliberately
 * NOT mocked — the gate under test is the real one.
 */
const h = vi.hoisted(() => {
  const puts: Array<{ TableName: string; Item: Record<string, unknown> }> = [];
  const invokes: Array<{ tool_name: string; parameters: Record<string, unknown> }> = [];
  const validate = { fn: vi.fn() };
  return { puts, invokes, validate };
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
      return { Payload: new TextEncoder().encode(JSON.stringify({ key: "TEAM-100" })) };
    }
  }
  return { LambdaClient, InvokeCommand };
});
vi.mock("@/lib/workflow/intake", () => ({
  validateIntakeSources: vi.fn(async (sources: unknown[] = []) => {
    h.validate.fn(sources);
    return { results: [], definitiveErrors: [], transientErrors: [], sources };
  }),
  getSourceValidationMode: vi.fn(() => "lenient" as const),
  shouldRejectSubmission: vi.fn(() => ({ reject: false, errors: [] as string[] })),
}));

const DEF: WorkflowDef = {
  id: "software-delivery",
  name: "Software Delivery",
  description: "test def",
  icon: "Workflow",
  intakeAgentId: "requirements-analyst",
  requiresRepo: true,
  featureBranchPhase: null,
  phases: [],
  reviewGates: [],
} as unknown as WorkflowDef;
vi.mock("@/lib/workflow/defs-loader", () => ({ resolveWorkflowDef: vi.fn(async () => DEF) }));

let POST: (req: NextRequest) => Promise<Response>;
const SAVED_KEYS = ["TICKET_PROVIDER", "REPO_CHECK_MODE"] as const;
const saved: Record<string, string | undefined> = {};

const repoConfig = {
  layout: "monorepo",
  repos: [{ url: "https://github.com/tycenjmccann/agentcore-hub", defaultBranch: "main", platform: "backend" }],
};

beforeEach(async () => {
  h.puts.length = 0;
  h.invokes.length = 0;
  h.validate.fn.mockReset();
  for (const key of SAVED_KEYS) saved[key] = process.env[key];
  // The repo pre-flight is a separate concern — switch it off so a 4xx here can
  // only have come from the shape gate.
  process.env.REPO_CHECK_MODE = "off";
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

function post(body: Record<string, unknown>) {
  return POST(
    new NextRequest("http://localhost/api/workflow/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("POST /api/workflow/start — intake source shape gate (TEAM-4078)", () => {
  it("rejects sources:[{ type:'upload', value:null }] with 400 and writes nothing", async () => {
    const res = await post({ title: "t", repoConfig, sources: [{ type: "upload", value: null }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("sources[0].value must be a non-empty string");
    // Nothing persisted, no ticket minted, and the reachability validator was
    // never even reached — a null value has nothing to reach.
    expect(h.puts.length).toBe(0);
    expect(h.invokes.length).toBe(0);
    expect(h.validate.fn).not.toHaveBeenCalled();
  });

  it("rejects a non-array sources with 400", async () => {
    const res = await post({ title: "t", repoConfig, sources: "not-an-array" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/sources must be an array/);
    expect(h.puts.length).toBe(0);
  });

  it("rejects a non-string type with 400 (the 'not valid as a React child' payload)", async () => {
    const res = await post({ title: "t", repoConfig, sources: [{ type: {}, value: "https://example.com/x" }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/sources\[0\]\.type/);
    expect(h.puts.length).toBe(0);
  });

  it("does NOT reject a well-formed source — it reaches the reachability validator and persists", async () => {
    const sources = [{ type: "url", value: "https://example.com/x" }];
    const res = await post({ title: "t", repoConfig, sources });
    expect(res.status).not.toBe(400);
    expect(res.status).toBe(200);
    expect(h.validate.fn).toHaveBeenCalledWith(sources);
    expect((h.puts[0].Item.input as { sources: unknown[] }).sources).toEqual(sources);
  });

  it("does NOT reject a submission with no sources at all", async () => {
    const res = await post({ title: "t", repoConfig });
    expect(res.status).toBe(200);
  });

  // TEAM-4091 F3: every source costs the server up to two 10s outbound GETs or a
  // HeadObject, all concurrent, so an unbounded array is a request amplifier on
  // an unauthenticated route.
  it("rejects more than MAX_INTAKE_SOURCES sources with 400 before any fan-out", async () => {
    const sources = Array.from({ length: MAX_INTAKE_SOURCES + 1 }, (_, i) => ({
      type: "url",
      value: `https://example.com/${i}`,
    }));
    const res = await post({ title: "t", repoConfig, sources });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(`sources must have at most ${MAX_INTAKE_SOURCES} items`);
    expect(h.puts.length).toBe(0);
    expect(h.invokes.length).toBe(0);
    // The whole point: not one outbound request was ever queued.
    expect(h.validate.fn).not.toHaveBeenCalled();
  });

  it("accepts exactly MAX_INTAKE_SOURCES sources", async () => {
    const sources = Array.from({ length: MAX_INTAKE_SOURCES }, (_, i) => ({
      type: "url",
      value: `https://example.com/${i}`,
    }));
    const res = await post({ title: "t", repoConfig, sources });
    expect(res.status).toBe(200);
    expect(h.validate.fn).toHaveBeenCalledWith(sources);
  });
});
