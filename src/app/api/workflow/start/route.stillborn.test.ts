import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { WorkflowDef } from "@/lib/workflow/workflow-defs";

/**
 * TEAM-3686 F5 — stillborn-run marking on intake-ticket failure.
 *
 * The workflow row is written BEFORE the intake ticket is created. If intake
 * creation then fails, the row would sit non-terminal with zero tickets and —
 * via the D4b dedup marker — own its (sourceTicket, defId) key forever. The
 * fix marks the just-created row phase=error (erroredAt + startError) before
 * rethrowing, so the next trigger's terminal-run re-point can mint a fresh
 * run. The error-mark itself is best-effort: if IT fails too, the ORIGINAL
 * intake error still propagates.
 *
 * Same seams as route.dedup.test.ts: in-memory DDB store, capturing Lambda
 * client (per-test failure injection), and a mocked Jira provider class.
 */

const h = vi.hoisted(() => {
  const store = new Map<string, Record<string, unknown>>();
  const state: {
    invokes: Array<{ tool_name: string; parameters: Record<string, unknown> }>;
    // Per-invocation override keyed by create_ticket call index (0 = epic,
    // 1 = intake). A function may return a payload or throw.
    invokeImpl: ((payload: { tool_name: string; parameters: Record<string, unknown> }) => unknown) | null;
    failMark: boolean;
    jiraCreateTicket: (() => Promise<{ id: string }>) | null;
    jiraTransitionTo: (() => Promise<void>) | null;
  } = { invokes: [], invokeImpl: null, failMark: false, jiraCreateTicket: null, jiraTransitionTo: null };
  return { store, state };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class PutCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class GetCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class UpdateCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    PutCommand,
    GetCommand,
    UpdateCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
          const { input } = cmd;
          if (cmd.constructor.name === "GetCommand") {
            const key = (input.Key as { workflowId: string }).workflowId;
            return { Item: h.store.get(key) };
          }
          if (cmd.constructor.name === "UpdateCommand") {
            // Only markWorkflowStartError updates the workflows table here —
            // apply its SET so the test can assert the terminal stamp.
            if (h.state.failMark) throw new Error("mark write failed");
            const key = (input.Key as { workflowId: string }).workflowId;
            const vals = input.ExpressionAttributeValues as Record<string, unknown>;
            const existing = h.store.get(key) || { workflowId: key };
            h.store.set(key, {
              ...existing,
              phase: vals[":error"],
              erroredAt: vals[":ts"],
              startError: vals[":msg"],
            });
            return {};
          }
          // PutCommand — plain write (no dedup guards exercised in these tests).
          const item = input.Item as Record<string, unknown>;
          h.store.set(item.workflowId as string, item);
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
      const payload = JSON.parse(Buffer.from(cmd.Payload).toString("utf8"));
      h.state.invokes.push(payload);
      const impl = h.state.invokeImpl;
      const result = impl ? impl(payload) : { key: "TEAM-100" };
      return { Payload: new TextEncoder().encode(JSON.stringify(result)) };
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

vi.mock("@/lib/workflow/ticket-provider-jira", () => ({
  JiraCloudProvider: class {
    async createEpic() {
      return { id: "EPIC-1" };
    }
    async createTicket() {
      if (h.state.jiraCreateTicket) return h.state.jiraCreateTicket();
      return { id: "TEAM-200" };
    }
    async transitionTo() {
      if (h.state.jiraTransitionTo) return h.state.jiraTransitionTo();
    }
  },
}));

const DEF: WorkflowDef = {
  id: "software-delivery",
  name: "Software Delivery",
  description: "test",
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

async function load(provider: "dynamodb" | "jira") {
  process.env.TICKET_PROVIDER = provider;
  vi.resetModules();
  ({ POST } = await import("./route"));
}

beforeEach(() => {
  h.store.clear();
  h.state.invokes.length = 0;
  h.state.invokeImpl = null;
  h.state.failMark = false;
  h.state.jiraCreateTicket = null;
  h.state.jiraTransitionTo = null;
});

afterEach(() => {
  delete process.env.TICKET_PROVIDER;
});

function post() {
  return POST(
    new NextRequest("http://localhost/api/workflow/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "t", workflowDefId: "software-delivery" }),
    })
  );
}

/** The (only) workflow row minted by the request. */
function workflowRow() {
  return [...h.store.values()].find((i) => String(i.workflowId).startsWith("wf_"));
}

/** invokeImpl that fails the SECOND create_ticket (the intake ticket). */
function failIntake(mode: "error-field" | "throw") {
  let creates = 0;
  return (payload: { tool_name: string }) => {
    if (payload.tool_name === "Tickets___create_ticket" && ++creates === 2) {
      if (mode === "throw") throw new Error("network down");
      return { error: "intake exploded" };
    }
    return { key: `TEAM-${100 + creates}` };
  };
}

describe("POST /api/workflow/start — stillborn-run marking (TEAM-3686 F5, ddb)", () => {
  it("marks the workflow row phase=error before rethrowing when intake creation reports an error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.invokeImpl = failIntake("error-field");
    await load("dynamodb");
    const res = await post();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("Failed to create requirements ticket: intake exploded");
    const row = workflowRow();
    expect(row?.phase).toBe("error");
    expect(String(row?.startError)).toContain("intake exploded");
    expect(row?.erroredAt).toBeTruthy();
    error.mockRestore();
  });

  it("marks the row when the intake invoke itself throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.invokeImpl = failIntake("throw");
    await load("dynamodb");
    const res = await post();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("network down");
    expect(workflowRow()?.phase).toBe("error");
    error.mockRestore();
  });

  it("a failing error-mark still rethrows the ORIGINAL intake error and logs both", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.invokeImpl = failIntake("error-field");
    h.state.failMark = true;
    await load("dynamodb");
    const res = await post();
    expect(res.status).toBe(500);
    // The original failure, not the mark write's.
    expect((await res.json()).error).toContain("intake exploded");
    // Row untouched (still the intake phase) — and the double failure is logged.
    expect(workflowRow()?.phase).toBe("requirements");
    const logged = error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("mark write failed");
    expect(logged).toContain("intake exploded");
    error.mockRestore();
  });

  it("a successful start leaves the row in the intake phase with no error fields", async () => {
    await load("dynamodb");
    const res = await post();
    expect(res.status).toBe(200);
    const row = workflowRow();
    expect(row?.phase).toBe("requirements");
    expect(row?.startError).toBeUndefined();
  });
});

describe("POST /api/workflow/start — stillborn-run marking (TEAM-3686 F5, jira)", () => {
  it("marks the row phase=error when the Jira intake ticket creation throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.jiraCreateTicket = async () => {
      throw new Error("jira 502");
    };
    await load("jira");
    const res = await post();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("jira 502");
    const row = workflowRow();
    expect(row?.phase).toBe("error");
    expect(String(row?.startError)).toContain("jira 502");
    error.mockRestore();
  });

  it("marks the row when the Ready transition fails (same stillborn window)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.jiraTransitionTo = async () => {
      throw new Error("no Ready transition");
    };
    await load("jira");
    const res = await post();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("no Ready transition");
    expect(workflowRow()?.phase).toBe("error");
    error.mockRestore();
  });
});
