import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { WorkflowDef } from "@/lib/workflow/workflow-defs";

/**
 * TEAM-3619 D4b — start idempotency on (sourceTicket, workflowDefId).
 *
 * A dedup marker (`wfdedup_<sha256(sourceTicket:defId)>`) is claimed in the
 * workflows table before any epic exists. A redelivery for the same pair
 * coalesces onto the live canonical run (200 { deduplicated:true }); a different
 * def forks a new run; a request with no sourceTicket is untouched; and a marker
 * whose canonical run is terminal is atomically re-pointed at a fresh run.
 *
 * The DDB seam is a small in-memory store that honors the two conditional-put
 * guards (attribute_not_exists(workflowId), canonicalWorkflowId = :old).
 */

const h = vi.hoisted(() => {
  const store = new Map<string, Record<string, unknown>>();
  const invokes: Array<{ tool_name: string }> = [];
  return { store, invokes };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class PutCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class GetCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  function fail(): never {
    const e = new Error("conditional check failed");
    e.name = "ConditionalCheckFailedException";
    throw e;
  }
  return {
    PutCommand,
    GetCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
          const { input } = cmd;
          if (cmd.constructor.name === "GetCommand") {
            const key = (input.Key as { workflowId: string }).workflowId;
            return { Item: h.store.get(key) };
          }
          // PutCommand — evaluate the conditional guard, then write.
          const item = input.Item as Record<string, unknown>;
          const id = item.workflowId as string;
          const cond = input.ConditionExpression as string | undefined;
          const existing = h.store.get(id);
          if (cond?.includes("attribute_not_exists(workflowId)") && existing) fail();
          if (cond?.includes("canonicalWorkflowId = :old")) {
            const old = (input.ExpressionAttributeValues as Record<string, unknown>)[":old"];
            if (!existing || existing.canonicalWorkflowId !== old) fail();
          }
          if (cond?.includes("attribute_not_exists(canonicalWorkflowId)") && existing?.canonicalWorkflowId) fail();
          h.store.set(id, item);
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

vi.mock("@/lib/workflow/intake", () => ({ validateIntakeSources: vi.fn(async () => []) }));

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
const OTHER_DEF: WorkflowDef = { ...DEF, id: "bug-fix", name: "Bug Fix" };

vi.mock("@/lib/workflow/defs-loader", () => ({
  resolveWorkflowDef: vi.fn(async (id: string) => (id === "bug-fix" ? OTHER_DEF : DEF)),
}));

let POST: typeof import("./route").POST;

beforeEach(async () => {
  h.store.clear();
  h.invokes.length = 0;
  process.env.TICKET_PROVIDER = "dynamodb";
  vi.resetModules();
  ({ POST } = await import("./route"));
});

afterEach(() => {
  delete process.env.TICKET_PROVIDER;
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

describe("POST /api/workflow/start — dedup on (sourceTicket, defId) (D4b)", () => {
  it("first start with a sourceTicket creates a run and claims the marker", async () => {
    const res = await post({ title: "t", sourceTicket: "TEAM-9", workflowDefId: "software-delivery" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workflowId).toMatch(/^wf_/);
    expect(body.deduplicated).toBeUndefined();
    // A marker row now exists pointing at the created run.
    const marker = [...h.store.values()].find((i) => String(i.workflowId).startsWith("wfdedup_"));
    expect(marker?.canonicalWorkflowId).toBe(body.workflowId);
    expect(h.invokes.length).toBeGreaterThan(0); // epic was created
  });

  it("a redelivery for the same (sourceTicket, def) coalesces onto the live run", async () => {
    const first = await (await post({ title: "t", sourceTicket: "TEAM-9", workflowDefId: "software-delivery" })).json();
    // Mark the canonical run non-terminal.
    h.store.set(first.workflowId, { workflowId: first.workflowId, phase: "development" });
    h.invokes.length = 0;

    const res = await post({ title: "t again", sourceTicket: "TEAM-9", workflowDefId: "software-delivery" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deduplicated).toBe(true);
    expect(body.workflowId).toBe(first.workflowId);
    expect(h.invokes.length).toBe(0); // no second epic
  });

  it("a different workflowDefId forks a new run (different marker key)", async () => {
    const first = await (await post({ title: "t", sourceTicket: "TEAM-9", workflowDefId: "software-delivery" })).json();
    h.store.set(first.workflowId, { workflowId: first.workflowId, phase: "development" });

    const res = await post({ title: "t", sourceTicket: "TEAM-9", workflowDefId: "bug-fix" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.deduplicated).toBeUndefined();
    expect(body.workflowId).not.toBe(first.workflowId);
  });

  it("no sourceTicket → no dedup marker, always a fresh run", async () => {
    const res = await post({ title: "t", workflowDefId: "software-delivery" });
    expect(res.status).toBe(200);
    expect((await res.json()).deduplicated).toBeUndefined();
    expect([...h.store.keys()].some((k) => k.startsWith("wfdedup_"))).toBe(false);
  });

  it("a terminal canonical run lets a new start re-point the marker and proceed fresh", async () => {
    const first = await (await post({ title: "t", sourceTicket: "TEAM-9", workflowDefId: "software-delivery" })).json();
    // Canonical run finished.
    h.store.set(first.workflowId, { workflowId: first.workflowId, phase: "complete" });
    h.invokes.length = 0;

    const res = await post({ title: "t redo", sourceTicket: "TEAM-9", workflowDefId: "software-delivery" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.deduplicated).toBeUndefined();
    expect(body.workflowId).not.toBe(first.workflowId);
    // Marker now points at the fresh run.
    const marker = [...h.store.values()].find((i) => String(i.workflowId).startsWith("wfdedup_"));
    expect(marker?.canonicalWorkflowId).toBe(body.workflowId);
    expect(h.invokes.length).toBeGreaterThan(0);
  });
});
