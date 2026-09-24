import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { WorkflowDef } from "@/lib/workflow/workflow-defs";

/**
 * TEAM-5008 finding 7 — `modelOverride` is validated at the front door.
 *
 * The defect: the route spread the request body straight into the persisted run
 * (`input: { ...body }`), so whatever arrived became the model every dev agent on
 * the run used. A typo resolved to nothing and the agents silently fell back to
 * the default — the invisible model change this epic exists to end — and a
 * retired or quarantined id was accepted just as happily.
 *
 * Contract under test: an unusable override is a 400 BEFORE any workflow row or
 * ticket is written, a usable one is persisted NORMALIZED to the id that will
 * really be invoked, and a request with no override is untouched.
 *
 * Harness is route.input-normalization.test.ts's: the real POST handler with the
 * DynamoDB, ticket-Lambda and def-loader seams mocked. ARTIFACT_BUCKET stays
 * unset, so the models registry resolves from the bundled seed rather than S3.
 */
const h = vi.hoisted(() => {
  const puts: Array<{ TableName: string; Item: Record<string, unknown> }> = [];
  const lambdaCalls: string[] = [];
  return { puts, lambdaCalls };
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
      h.lambdaCalls.push(new TextDecoder().decode(cmd.Payload));
      return { Payload: new TextEncoder().encode(JSON.stringify({ key: "TEAM-100" })) };
    }
  }
  return { LambdaClient, InvokeCommand };
});

vi.mock("@/lib/workflow/intake", () => ({
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
  name: "software-delivery",
  description: "test def",
  icon: "Workflow",
  intakeAgentId: "intake-agent",
  requiresRepo: false,
  featureBranchPhase: null,
  createsPullRequest: false,
  completionRequiresAgentPhases: [],
  phases: [{ id: "requirements", name: "Requirements", type: "agent", agentPhase: "requirements" }],
  type: "feature",
} as WorkflowDef;

vi.mock("@/lib/workflow/defs-loader", () => ({
  resolveWorkflowDef: vi.fn(async (id?: string | null) => (!id || id === "software-delivery" ? DEF : null)),
}));

let POST: typeof import("./route").POST;

const SAVED = ["TICKET_PROVIDER", "ARTIFACT_BUCKET"] as const;
const savedEnv: Partial<Record<(typeof SAVED)[number], string | undefined>> = {};

beforeEach(async () => {
  h.puts.length = 0;
  h.lambdaCalls.length = 0;
  for (const k of SAVED) savedEnv[k] = process.env[k];
  process.env.TICKET_PROVIDER = "dynamodb";
  delete process.env.ARTIFACT_BUCKET;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.resetModules();
  ({ POST } = await import("./route"));
});

afterEach(() => {
  for (const k of SAVED) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
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

function persistedOverride(): unknown {
  expect(h.puts.length).toBe(1);
  return (h.puts[0].Item.input as Record<string, unknown>).modelOverride;
}

describe("POST /api/workflow/start — modelOverride is checked against the live registry", () => {
  it("400s invalid_model_override before creating anything", async () => {
    for (const [modelOverride, reason] of [
      ["clade-opus-5", "unknown_model"],
      ["us.anthropic.claude-nonesuch-9", "not_in_catalog"],
      ["us.anthropic.claude-opus-4-8", "inactive"],
      ["anthropic.claude-opus-5", "read_only"],
      [{ openAiModelConfig: { modelId: "gpt-4-turbo-preview", apiKeyArn: "arn:x" } }, "unsupported_shape"],
    ] as Array<[unknown, string]>) {
      const res = await post({ title: "t", modelOverride });
      expect(res.status, JSON.stringify(modelOverride)).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_model_override", reason, modelOverride });
    }
    // No workflow row, no epic, no ticket: the run never started.
    expect(h.puts).toEqual([]);
    expect(h.lambdaCalls).toEqual([]);
  });

  it("persists a valid override NORMALIZED to the id that will be invoked", async () => {
    expect((await post({ title: "t", modelOverride: "claude-sonnet-5" })).status).toBe(200);
    expect(persistedOverride()).toBe("us.anthropic.claude-sonnet-5");
  });

  it("keeps the console's object form, with the resolved id inside it", async () => {
    const res = await post({ title: "t", modelOverride: { bedrockModelConfig: { modelId: "opus" } } });
    expect(res.status).toBe(200);
    expect(persistedOverride()).toEqual({ bedrockModelConfig: { modelId: "us.anthropic.claude-opus-5" } });
  });

  it("starts normally when no modelOverride is present", async () => {
    expect((await post({ title: "t" })).status).toBe(200);
    expect(persistedOverride()).toBeUndefined();
    expect(h.puts[0].Item.workflowDefId).toBe("software-delivery");
  });
});
