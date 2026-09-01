import { createHash } from "node:crypto";
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
 * TEAM-3699 adds the overlap window: the marker is claimed BEFORE the workflow
 * row is written, so a concurrent start can see marker-without-row. A FRESH
 * marker in that state means the winner is in-flight (coalesce, no second
 * epic); a STALE one means it died mid-start (re-point, fresh run).
 *
 * The DDB seam is a small in-memory store that honors the two conditional-put
 * guards (attribute_not_exists(workflowId), canonicalWorkflowId = :old) and
 * records every PutCommand item so tests can assert nothing was written.
 */

const h = vi.hoisted(() => {
  const store = new Map<string, Record<string, unknown>>();
  const invokes: Array<{ tool_name: string }> = [];
  const puts: Array<Record<string, unknown>> = [];
  return { store, invokes, puts };
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
          h.puts.push(item);
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
  h.puts.length = 0;
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

/**
 * TEAM-3699 — the overlap window. Request A claims the marker and is still
 * creating its epic/workflow row when request B arrives for the same
 * (sourceTicket, defId). B sees marker-present / canonical-row-ABSENT: before
 * the fix it fell through to the terminal-run re-point path and double-created.
 *
 * The in-flight winner is simulated by seeding ONLY the marker row (that is
 * exactly A's state between its two writes) with a controlled createdAt.
 */
const CANON = "wf_1700000000000_canon1";

/** Marker id for (sourceTicket, defId) — must match resolveDedup's hash. */
function markerIdFor(sourceTicket: string, defId: string) {
  return `wfdedup_${createHash("sha256").update(`${sourceTicket}:${defId}`).digest("hex")}`;
}

/** Seed an in-flight winner: marker only, no canonical workflow row. */
function seedMarkerOnly(createdAt: string | undefined) {
  h.store.set(markerIdFor("TEAM-9", "software-delivery"), {
    workflowId: markerIdFor("TEAM-9", "software-delivery"),
    canonicalWorkflowId: CANON,
    sourceTicket: "TEAM-9",
    defId: "software-delivery",
    ...(createdAt ? { createdAt } : {}),
  });
}

describe("POST /api/workflow/start — dedup overlap window (TEAM-3699, AC-D4.2)", () => {
  it("marker fresh + canonical row not yet written → coalesces on the in-flight run, creates nothing", async () => {
    seedMarkerOnly(new Date(Date.now() - 5_000).toISOString());

    const res = await post({ title: "t overlap", sourceTicket: "TEAM-9", workflowDefId: "software-delivery" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ workflowId: CANON, deduplicated: true });

    // No second epic/intake ticket...
    expect(h.invokes).toEqual([]);
    // ...no second workflow row, and no marker re-point.
    expect(h.puts).toEqual([]);
    expect(h.store.get(markerIdFor("TEAM-9", "software-delivery"))?.canonicalWorkflowId).toBe(CANON);
    expect([...h.store.keys()].some((k) => k.startsWith("wf_") && k !== CANON)).toBe(false);
  });

  it("marker stale (beyond the grace window) + canonical row absent → re-points and starts a fresh run", async () => {
    seedMarkerOnly(new Date(Date.now() - 10 * 60_000).toISOString());

    const res = await post({ title: "t stillborn", sourceTicket: "TEAM-9", workflowDefId: "software-delivery" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deduplicated).toBeUndefined();
    expect(body.workflowId).toMatch(/^wf_/);
    expect(body.workflowId).not.toBe(CANON);
    // Marker re-pointed at the fresh run, and that run really was created.
    expect(h.store.get(markerIdFor("TEAM-9", "software-delivery"))?.canonicalWorkflowId).toBe(body.workflowId);
    expect(h.invokes.length).toBeGreaterThan(0);
  });

  it("marker with no createdAt → treated as stale (re-point allowed, never wedged)", async () => {
    seedMarkerOnly(undefined);

    const res = await post({ title: "t no stamp", sourceTicket: "TEAM-9", workflowDefId: "software-delivery" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deduplicated).toBeUndefined();
    expect(body.workflowId).not.toBe(CANON);
    expect(h.store.get(markerIdFor("TEAM-9", "software-delivery"))?.canonicalWorkflowId).toBe(body.workflowId);
  });

  it("fresh marker does NOT block re-running a canonical run that already finished", async () => {
    seedMarkerOnly(new Date(Date.now() - 5_000).toISOString());
    // Same fresh marker, but this time the canonical row exists and is terminal.
    h.store.set(CANON, { workflowId: CANON, phase: "complete" });

    const res = await post({ title: "t redo", sourceTicket: "TEAM-9", workflowDefId: "software-delivery" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.deduplicated).toBeUndefined();
    expect(body.workflowId).not.toBe(CANON);
    expect(h.invokes.length).toBeGreaterThan(0);
  });
});
