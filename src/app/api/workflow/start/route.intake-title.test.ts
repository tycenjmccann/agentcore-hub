import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { WorkflowDef } from "@/lib/workflow/workflow-defs";

/**
 * TEAM-4450 — the hub-created intake ticket's title prefix must come from the
 * def's INTAKE (`type:"app"`) phase, not the first `type:"agent"` phase.
 *
 * Regression: `operator`'s first agent phase is named "Build", so the intake
 * ticket used to be titled "Build: agentcore_hub_operator — <title>" —
 * indistinguishable from the operator's own BUILD ticket to
 * blueprints/operator.md's title-prefix dispatch, which routed the intake
 * ticket into BUILD and skipped planning.
 *
 * Same mocking seams as route.test.ts (DynamoDB path) and
 * route.stillborn.test.ts (Jira path's JiraCloudProvider mock), except the
 * resolved def is swappable per test via `h.def`.
 */

const h = vi.hoisted(() => {
  const invokes: Array<{ tool_name: string; parameters: Record<string, unknown> }> = [];
  const jiraCreateTicketCalls: Array<{ title: string }> = [];
  let def: WorkflowDef | null = null;
  return { invokes, jiraCreateTicketCalls, def: () => def, setDef: (d: WorkflowDef) => { def = d; } };
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
        send: async () => ({}),
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
      const payload = JSON.parse(Buffer.from(cmd.Payload).toString("utf8"));
      h.invokes.push(payload);
      // Epic create returns a key; intake create (issue_type "Task") does too —
      // invokeTicketLambda only needs { key } / no error for either.
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

vi.mock("@/lib/workflow/ticket-provider-jira", () => ({
  JiraCloudProvider: class {
    async createEpic() {
      return { id: "EPIC-1" };
    }
    async createTicket(args: { title: string }) {
      h.jiraCreateTicketCalls.push({ title: args.title });
      return { id: "TEAM-200" };
    }
    async transitionTo() {
      /* no-op */
    }
  },
}));

vi.mock("@/lib/workflow/defs-loader", () => ({
  resolveWorkflowDef: vi.fn(async () => h.def()),
}));

let POST: typeof import("./route").POST;

async function load(provider: "dynamodb" | "jira") {
  process.env.TICKET_PROVIDER = provider;
  vi.resetModules();
  ({ POST } = await import("./route"));
}

beforeEach(() => {
  h.invokes.length = 0;
  h.jiraCreateTicketCalls.length = 0;
});

afterEach(() => {
  delete process.env.TICKET_PROVIDER;
});

function post(title = "the title") {
  return POST(
    new NextRequest("http://localhost/api/workflow/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    })
  );
}

/** The intake ticket's `summary` from the DynamoDB path's Tickets___create_ticket call. */
function ddbIntakeSummary(): string {
  const create = h.invokes.find(
    (i) => i.tool_name === "Tickets___create_ticket" && i.parameters.issue_type === "Task"
  );
  expect(create).toBeTruthy();
  return String(create!.parameters.summary);
}

const BASE_DEF = {
  name: "Test",
  description: "test def",
  icon: "Workflow",
  requiresRepo: false,
  featureBranchPhase: null,
  createsPullRequest: false,
  completionRequiresAgentPhases: [],
};

const OPERATOR_DEF: WorkflowDef = {
  ...BASE_DEF,
  id: "operator",
  intakeAgentId: "agentcore_hub_operator",
  phases: [
    { id: "intake", name: "Intake", type: "app", agentPhase: "intake" },
    { id: "build", name: "Build", type: "agent", agentPhase: "development" },
    { id: "ship", name: "Ship", type: "agent", agentPhase: "ship" },
  ],
};

const SOFTWARE_DELIVERY_DEF: WorkflowDef = {
  ...BASE_DEF,
  id: "software-delivery",
  intakeAgentId: "agentcore_hub_requirements_analyst",
  phases: [
    { id: "intake", name: "Intake", type: "app", agentPhase: "intake" },
    { id: "requirements", name: "Requirements", type: "agent", agentPhase: "requirements" },
  ],
};

const MARKETING_DEF: WorkflowDef = {
  ...BASE_DEF,
  id: "marketing",
  intakeAgentId: "agentcore_hub_marketing_strategist",
  phases: [
    { id: "idea", name: "Idea", type: "app", agentPhase: "intake" },
    { id: "strategy", name: "Strategy", type: "agent", agentPhase: "strategy" },
  ],
};

const NO_APP_PHASE_DEF: WorkflowDef = {
  ...BASE_DEF,
  id: "no-app-phase",
  intakeAgentId: "agentcore_hub_requirements_analyst",
  phases: [{ id: "requirements", name: "Requirements", type: "agent", agentPhase: "requirements" }],
};

describe("POST /api/workflow/start — intake ticket title prefix (TEAM-4450, dynamodb)", () => {
  it("(a) operator def: titles the intake ticket from the app phase, NOT the first agent phase", async () => {
    h.setDef(OPERATOR_DEF);
    await load("dynamodb");
    const res = await post("Add dark mode");
    expect(res.status).toBe(200);
    const summary = ddbIntakeSummary();
    expect(summary).toBe("Intake: agentcore_hub_operator — Add dark mode");
    // The regression this test pins: must never be titled like the operator's
    // own BUILD ticket ("Build: agentcore_hub_operator — ...").
    expect(summary.startsWith("Build:")).toBe(false);
  });

  it("(b) software-delivery def: titles the intake ticket 'Intake: <analyst> — <title>'", async () => {
    h.setDef(SOFTWARE_DELIVERY_DEF);
    await load("dynamodb");
    const res = await post("Ship the widget");
    expect(res.status).toBe(200);
    expect(ddbIntakeSummary()).toBe("Intake: agentcore_hub_requirements_analyst — Ship the widget");
  });

  it("(c) marketing def: reads the app phase's own name ('Idea'), not a hardcoded literal", async () => {
    h.setDef(MARKETING_DEF);
    await load("dynamodb");
    const res = await post("Q4 launch");
    expect(res.status).toBe(200);
    expect(ddbIntakeSummary()).toBe("Idea: agentcore_hub_marketing_strategist — Q4 launch");
  });

  it("(d) def with no type:\"app\" phase falls back to the literal 'Intake'", async () => {
    h.setDef(NO_APP_PHASE_DEF);
    await load("dynamodb");
    const res = await post("Edge case");
    expect(res.status).toBe(200);
    expect(ddbIntakeSummary()).toBe("Intake: agentcore_hub_requirements_analyst — Edge case");
  });
});

describe("POST /api/workflow/start — intake ticket title prefix (TEAM-4450, jira)", () => {
  it("operator def: the Jira path produces the byte-identical title to the DynamoDB path", async () => {
    h.setDef(OPERATOR_DEF);
    await load("jira");
    const res = await post("Add dark mode");
    expect(res.status).toBe(200);
    expect(h.jiraCreateTicketCalls.length).toBe(1);
    expect(h.jiraCreateTicketCalls[0].title).toBe("Intake: agentcore_hub_operator — Add dark mode");
  });
});
