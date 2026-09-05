import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { WorkflowDef } from "@/lib/workflow/workflow-defs";

/**
 * TEAM-3832: `workflowDefId` is the SOLE pipeline selector; the persisted
 * `workflowType` is DERIVED from the resolved def, never copied from input.
 *
 * The defect being pinned: a caller passing `workflowType: "bug"` with NO
 * `workflowDefId` used to get a bug-LABELED run on the default
 * software-delivery pipeline — the redundant field silently failed to select
 * the bug-fix pipeline the caller wanted, and the stored label could
 * contradict the pipeline actually running.
 *
 * Contract under test (FR2/FR3/FR6):
 *   - defId-only            → that def runs; row workflowType derived from it
 *   - type-only "bug"       → maps to the bug-fix def (the regression)
 *   - type-only "feature"   → maps to the default software-delivery def
 *   - both agreeing         → unchanged behavior, no override flag
 *   - both contradicting    → the def WINS; response carries
 *                             workflowTypeOverridden:true + a note
 *   - unknown workflowDefId → still a hard 400, never a silent fallback
 *
 * Same seam-mocking harness as route.test.ts: real POST handler, DynamoDB
 * document client + ticket Lambda + def loader mocked. The def loader mock
 * resolves BY ID (unlike route.test.ts's fixed def) because def selection is
 * exactly what this suite asserts.
 */
const h = vi.hoisted(() => {
  const puts: Array<{ TableName: string; Item: Record<string, unknown> }> = [];
  return { puts };
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
    async send() {
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

function makeDef(id: string, type?: "feature" | "bug"): WorkflowDef {
  return {
    id,
    name: id,
    description: "test def",
    icon: "Workflow",
    intakeAgentId: "intake-agent",
    requiresRepo: false,
    featureBranchPhase: null,
    createsPullRequest: false,
    completionRequiresAgentPhases: [],
    phases: [{ id: "requirements", name: "Requirements", type: "agent", agentPhase: "requirements" }],
    ...(type ? { type } : {}),
  } as WorkflowDef;
}

// Mirrors src/config/workflows.json: bug-fix carries type "bug", the default
// software-delivery def "feature". Unknown ids resolve to null (hard 400).
const DEFS: Record<string, WorkflowDef> = {
  "software-delivery": makeDef("software-delivery", "feature"),
  "bug-fix": makeDef("bug-fix", "bug"),
};

vi.mock("@/lib/workflow/defs-loader", () => ({
  resolveWorkflowDef: vi.fn(async (id?: string | null) => (id && DEFS[id]) || null),
}));

let POST: typeof import("./route").POST;

const savedProvider = { value: undefined as string | undefined };

beforeEach(async () => {
  h.puts.length = 0;
  savedProvider.value = process.env.TICKET_PROVIDER;
  // The provider is a module-scope const, so pin it before the import below.
  process.env.TICKET_PROVIDER = "dynamodb";
  vi.resetModules();
  ({ POST } = await import("./route"));
});

afterEach(() => {
  if (savedProvider.value === undefined) delete process.env.TICKET_PROVIDER;
  else process.env.TICKET_PROVIDER = savedProvider.value;
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

/** The single workflow-metadata PutCommand Item a successful start writes. */
function workflowItem(): Record<string, unknown> {
  expect(h.puts.length).toBe(1);
  return h.puts[0].Item;
}

describe("POST /api/workflow/start — workflowDefId is the sole selector (TEAM-3832)", () => {
  it("(1) workflowDefId-only 'bug-fix' → runs that def; persisted workflowType derived ('bug')", async () => {
    const res = await post({ title: "t", workflowDefId: "bug-fix" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.workflowTypeOverridden).toBeUndefined();
    const item = workflowItem();
    expect(item.workflowDefId).toBe("bug-fix");
    expect(item.workflowType).toBe("bug");
  });

  it("(2) type-only 'bug' → resolves to the bug-fix def, not a bug-labeled software-delivery run", async () => {
    const res = await post({ title: "t", workflowType: "bug" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.workflowTypeOverridden).toBeUndefined();
    const item = workflowItem();
    expect(item.workflowDefId).toBe("bug-fix");
    expect(item.workflowType).toBe("bug");
  });

  it("(3) type-only 'feature' → resolves to the default software-delivery def", async () => {
    const res = await post({ title: "t", workflowType: "feature" });
    expect(res.status).toBe(200);
    const item = workflowItem();
    expect(item.workflowDefId).toBe("software-delivery");
    expect(item.workflowType).toBe("feature");
  });

  it("(4) both agreeing (bug-fix + 'bug') → no override flag, no note", async () => {
    const res = await post({ title: "t", workflowDefId: "bug-fix", workflowType: "bug" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.workflowTypeOverridden).toBeUndefined();
    expect(json.note).toBeUndefined();
    const item = workflowItem();
    expect(item.workflowDefId).toBe("bug-fix");
    expect(item.workflowType).toBe("bug");
  });

  it("(5) both contradicting (software-delivery + 'bug') → def wins, response flags the override", async () => {
    const res = await post({ title: "t", workflowDefId: "software-delivery", workflowType: "bug" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.workflowTypeOverridden).toBe(true);
    expect(typeof json.note).toBe("string");
    expect(json.note.length).toBeGreaterThan(0);
    const item = workflowItem();
    expect(item.workflowDefId).toBe("software-delivery");
    // Persisted label is DERIVED from the def — the caller's "bug" never lands on the row.
    expect(item.workflowType).toBe("feature");
  });

  it("(5b) inverse contradiction (bug-fix + 'feature') → def wins, derived 'bug' persisted", async () => {
    const res = await post({ title: "t", workflowDefId: "bug-fix", workflowType: "feature" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.workflowTypeOverridden).toBe(true);
    const item = workflowItem();
    expect(item.workflowDefId).toBe("bug-fix");
    expect(item.workflowType).toBe("bug");
  });

  it("(6) unknown workflowDefId → still a hard 400, nothing written", async () => {
    const res = await post({ title: "t", workflowDefId: "no-such-def", workflowType: "bug" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Unknown workflowDefId/);
    expect(h.puts.length).toBe(0);
  });

  it("baseline: neither field → default software-delivery def, derived 'feature' (unchanged behavior)", async () => {
    const res = await post({ title: "t" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.workflowTypeOverridden).toBeUndefined();
    const item = workflowItem();
    expect(item.workflowDefId).toBe("software-delivery");
    expect(item.workflowType).toBe("feature");
  });
});
