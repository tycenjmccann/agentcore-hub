import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { WorkflowDef } from "@/lib/workflow/workflow-defs";

/**
 * TEAM-3886: the persisted row's `input` must be NORMALIZED — it must carry the
 * RESOLVED `workflowDefId`, matching the row's top-level field.
 *
 * The defect being pinned (ship-review finding F1 on TEAM-3832/TEAM-3872, PRs
 * #306/#309): both startWithJira and startWithDynamoDB persisted the RAW request
 * body as `input`. For a type-only submission ({ workflowType: "bug" }, no
 * workflowDefId) the run correctly executes the bug-fix pipeline (the
 * orchestrator scopes off the TOP-LEVEL workflow.workflowDefId), but
 * `input.workflowDefId` stayed undefined — and WorkflowBoard selects its
 * rendered phases from state.input.workflowDefId, whose getPipelinePhases
 * lookup defaults to SOFTWARE-DELIVERY. Net effect: the UI rendered
 * software-delivery phases for a run actually executing BUG-FIX. Display-only,
 * but user-visible and misleading — and exactly the Telegram/MCP type-only bug
 * submission journey the TEAM-3832 fix targeted.
 *
 * Contract under test (both ticket backends):
 *   - type-only "bug"  → input.workflowDefId === "bug-fix" (the regression)
 *   - defId-only       → input.workflowDefId === the resolved def id
 *   - neither field    → input.workflowDefId === the resolved default def id
 *   In every case input.workflowDefId === the row's top-level workflowDefId.
 *
 * Same seam-mocking harness as route.workflow-type.test.ts: real POST handler,
 * DynamoDB document client + ticket Lambda + def loader mocked; def loader
 * resolves BY ID. The jira backend additionally mocks JiraCloudProvider (as in
 * route.dedup.test.ts) — its workflow row goes through the same DDB seam.
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

vi.mock("@/lib/workflow/ticket-provider-jira", () => {
  class JiraCloudProvider {
    async createEpic() {
      return { id: "JIRA-EPIC-1" };
    }
    async createTicket() {
      return { id: "JIRA-TICKET-1" };
    }
    async transitionTo() {}
    async deleteIssue() {}
  }
  return { JiraCloudProvider };
});

vi.mock("@/lib/workflow/intake", () => ({
  validateIntakeSources: vi.fn(async () => []),
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
// software-delivery def "feature".
const DEFS: Record<string, WorkflowDef> = {
  "software-delivery": makeDef("software-delivery", "feature"),
  "bug-fix": makeDef("bug-fix", "bug"),
};

vi.mock("@/lib/workflow/defs-loader", () => ({
  resolveWorkflowDef: vi.fn(async (id?: string | null) => (id && DEFS[id]) || null),
}));

let POST: typeof import("./route").POST;

const savedProvider = { value: undefined as string | undefined };

beforeEach(() => {
  h.puts.length = 0;
  savedProvider.value = process.env.TICKET_PROVIDER;
});

afterEach(() => {
  if (savedProvider.value === undefined) delete process.env.TICKET_PROVIDER;
  else process.env.TICKET_PROVIDER = savedProvider.value;
});

/** Pin the provider (a module-scope const) and (re)import the real handler. */
async function loadRoute(provider: "dynamodb" | "jira") {
  process.env.TICKET_PROVIDER = provider;
  vi.resetModules();
  ({ POST } = await import("./route"));
}

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

function persistedInput(item: Record<string, unknown>): Record<string, unknown> {
  return item.input as Record<string, unknown>;
}

for (const provider of ["dynamodb", "jira"] as const) {
  describe(`POST /api/workflow/start — persisted input carries the resolved workflowDefId (TEAM-3886, ${provider} backend)`, () => {
    beforeEach(async () => {
      await loadRoute(provider);
    });

    it("type-only 'bug' → input.workflowDefId is the resolved 'bug-fix' (the regression)", async () => {
      const res = await post({ title: "t", workflowType: "bug" });
      expect(res.status).toBe(200);
      const item = workflowItem();
      // Top-level normalization (TEAM-3832) — unchanged.
      expect(item.workflowDefId).toBe("bug-fix");
      // TEAM-3886: input is normalized too — WorkflowBoard reads THIS field.
      const input = persistedInput(item);
      expect(input.workflowDefId).toBe("bug-fix");
      expect(input.workflowDefId).toBe(item.workflowDefId);
      // The rest of the caller's input survives untouched.
      expect(input.title).toBe("t");
      expect(input.workflowType).toBe("bug");
    });

    it("defId-only → input.workflowDefId equals the resolved def id", async () => {
      const res = await post({ title: "t", workflowDefId: "bug-fix" });
      expect(res.status).toBe(200);
      const item = workflowItem();
      expect(item.workflowDefId).toBe("bug-fix");
      const input = persistedInput(item);
      expect(input.workflowDefId).toBe("bug-fix");
      expect(input.workflowDefId).toBe(item.workflowDefId);
    });

    it("neither field → input.workflowDefId equals the resolved default def id", async () => {
      const res = await post({ title: "t" });
      expect(res.status).toBe(200);
      const item = workflowItem();
      expect(item.workflowDefId).toBe("software-delivery");
      const input = persistedInput(item);
      expect(input.workflowDefId).toBe("software-delivery");
      expect(input.workflowDefId).toBe(item.workflowDefId);
    });
  });
}
