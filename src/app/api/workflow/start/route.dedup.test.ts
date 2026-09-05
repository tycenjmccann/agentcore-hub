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
  const invokes: Array<{ tool_name: string; parameters?: Record<string, string> }> = [];
  const puts: Array<Record<string, unknown>> = [];
  // TEAM-3703: every TransactWriteCommand input recorded so tests can assert the
  // marker ConditionCheck (fence) shape.
  const transacts: Array<Record<string, unknown>> = [];
  return {
    store,
    invokes,
    puts,
    transacts,
    // TEAM-3703 test hooks (reset in beforeEach):
    //  - onInvoke: run once, on the NEXT ticket-Lambda call, to interpose a
    //    concurrent racer while a request is mid-start (simulates a >grace stall).
    //  - failTransactOnce: force the next TransactWriteCommand to be cancelled
    //    WITHOUT mutating the store (simulates a transient transaction conflict).
    onInvoke: null as null | (() => Promise<void>),
    failTransactOnce: false,
    // TEAM-3705: epic-level state so orphan cleanup can be asserted.
    //  - tickets: every ticket the DDB Lambda "created", with its live status
    //    (create → todo, transition_ticket → target status).
    //  - failDoneTransitionOnce: next transition_id="done" returns the Lambda's
    //    textResult failure shape (drives the cleanup-failure path).
    //  - jiraDeleted / failJiraDeleteOnce: same pair for JiraCloudProvider.deleteIssue.
    tickets: new Map<string, { type: string; status: string }>(),
    ticketSeq: 0,
    failDoneTransitionOnce: false,
    // TEAM-3708: force the next Tickets___add_comment call to reject, to prove
    // the (cosmetic) audit comment can never block the terminal done transition.
    failAddCommentOnce: false,
    epicSeq: 0,
    jiraDeleted: [] as string[],
    failJiraDeleteOnce: false,
  };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class PutCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class GetCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class TransactWriteCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  function fail(): never {
    const e = new Error("conditional check failed");
    e.name = "ConditionalCheckFailedException";
    throw e;
  }
  function transactFail(): never {
    const e = new Error("transaction cancelled");
    e.name = "TransactionCanceledException";
    throw e;
  }
  return {
    PutCommand,
    GetCommand,
    TransactWriteCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
          const { input } = cmd;
          if (cmd.constructor.name === "GetCommand") {
            const key = (input.Key as { workflowId: string }).workflowId;
            return { Item: h.store.get(key) };
          }
          if (cmd.constructor.name === "TransactWriteCommand") {
            // Simulated transient conflict: cancel without touching the store.
            if (h.failTransactOnce) {
              h.failTransactOnce = false;
              transactFail();
            }
            const items = input.TransactItems as Array<Record<string, any>>;
            // Phase 1: evaluate every condition BEFORE any write (atomicity).
            for (const ti of items) {
              if (ti.ConditionCheck) {
                const cc = ti.ConditionCheck;
                const existing = h.store.get(cc.Key.workflowId);
                const cond = cc.ConditionExpression as string;
                if (cond.includes("canonicalWorkflowId = :me")) {
                  const me = cc.ExpressionAttributeValues[":me"];
                  if (!existing || existing.canonicalWorkflowId !== me) transactFail();
                }
              }
              if (ti.Put) {
                const cond = ti.Put.ConditionExpression as string | undefined;
                const existing = h.store.get(ti.Put.Item.workflowId);
                if (cond?.includes("attribute_not_exists(workflowId)") && existing) transactFail();
              }
            }
            // Phase 2: apply the writes.
            h.transacts.push(input);
            for (const ti of items) {
              if (ti.Put) {
                h.puts.push(ti.Put.Item);
                h.store.set(ti.Put.Item.workflowId, ti.Put.Item);
              }
            }
            return {};
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
      const call = JSON.parse(Buffer.from(cmd.Payload).toString("utf8"));
      h.invokes.push(call);
      const p = (call.parameters ?? {}) as Record<string, string>;
      // TEAM-3705: compute the result (and assign create keys) BEFORE the
      // interpose hook runs, so a stalled request's epic keeps its own key even
      // though the racer completes first.
      let result: Record<string, unknown> = { key: "TEAM-100" };
      if (call.tool_name === "Tickets___create_ticket") {
        const key = `TEAM-${100 + h.ticketSeq++}`;
        h.tickets.set(key, { type: p.issue_type || "Task", status: "todo" });
        result = { key };
      } else if (call.tool_name === "Tickets___transition_ticket") {
        if (p.transition_id === "done" && h.failDoneTransitionOnce) {
          h.failDoneTransitionOnce = false;
          // The real Lambda's failure shape for an invalid transition.
          result = { content: [{ text: 'Invalid transition "done" — injected cleanup failure' }] };
        } else {
          const row = h.tickets.get(p.ticket_id);
          if (row) row.status = p.transition_id;
          result = { key: p.ticket_id, status: "transitioned", to: p.transition_id };
        }
      } else if (call.tool_name === "Tickets___add_comment") {
        if (h.failAddCommentOnce) {
          h.failAddCommentOnce = false;
          throw new Error("injected add_comment failure");
        }
        result = { id: "comment-1" };
      }
      // TEAM-3703: interpose a concurrent racer exactly once, mid-start, to model
      // a request that stalls during slow external (epic) work before its row write.
      if (h.onInvoke) {
        const f = h.onInvoke;
        h.onInvoke = null;
        await f();
      }
      return { Payload: new TextEncoder().encode(JSON.stringify(result)) };
    }
  }
  return { LambdaClient, InvokeCommand };
});

// TEAM-3703: Jira backend seam — createEpic honors the same onInvoke interpose
// hook so the >grace overlap can be exercised in jira mode too.
vi.mock("@/lib/workflow/ticket-provider-jira", () => {
  class JiraCloudProvider {
    async createEpic() {
      // TEAM-3705: unique per-call id, assigned BEFORE the interpose hook so the
      // stalled loser and the racing winner get distinguishable epics.
      const id = `JIRA-EPIC-${++h.epicSeq}`;
      if (h.onInvoke) {
        const f = h.onInvoke;
        h.onInvoke = null;
        await f();
      }
      return { id };
    }
    async createTicket() {
      return { id: "JIRA-TICKET-1" };
    }
    async transitionTo() {}
    // TEAM-3705: orphan-epic cleanup seam.
    async deleteIssue(issueKey: string) {
      if (h.failJiraDeleteOnce) {
        h.failJiraDeleteOnce = false;
        throw new Error(`Jira API error 403 Forbidden on DELETE /rest/api/3/issue/${issueKey}: no permission`);
      }
      h.jiraDeleted.push(issueKey);
    }
  }
  return { JiraCloudProvider };
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
  h.transacts.length = 0;
  h.onInvoke = null;
  h.failTransactOnce = false;
  h.tickets.clear();
  h.ticketSeq = 0;
  h.failDoneTransitionOnce = false;
  h.failAddCommentOnce = false;
  h.epicSeq = 0;
  h.jiraDeleted.length = 0;
  h.failJiraDeleteOnce = false;
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

/**
 * TEAM-3703 — atomic marker-ownership FENCE (PR #244 ship-review round 2).
 *
 * The TEAM-3699 grace window narrows but does not close the double-create race:
 * a request that claims the marker and then stalls >grace during epic creation
 * can be re-pointed away by a racer, yet its LATER workflow-row write would still
 * land — two live runs for one (sourceTicket, defId). The fix writes every dedup
 * row inside a TransactWriteCommand whose ConditionCheck proves the marker STILL
 * points at this workflowId; a re-pointed loser fails that check and coalesces.
 */
const markerId9 = () => markerIdFor("TEAM-9", "software-delivery");
const wfRows = () => [...h.store.keys()].filter((k) => k.startsWith("wf_")); // excludes wfdedup_ markers

describe("POST /api/workflow/start — atomic ownership fence (TEAM-3703)", () => {
  it("(a) >grace overlap with a live winner → loser fences out, exactly one row, coalesces onto winner", async () => {
    // Request A runs; during its epic creation we age its marker beyond the grace
    // window (it "stalled") and run request B to completion. B re-points the
    // marker to itself and writes its row. A then reaches its fenced write and,
    // finding the marker now owned by B, must NOT write a row — it coalesces.
    let bBody: { workflowId: string; deduplicated?: boolean } | undefined;
    h.onInvoke = async () => {
      const m = h.store.get(markerId9())!;
      m.createdAt = new Date(Date.now() - 10 * 60_000).toISOString();
      h.store.set(markerId9(), m);
      bBody = await (await post({ title: "B", sourceTicket: "TEAM-9", workflowDefId: "software-delivery" })).json();
    };

    const aRes = await post({ title: "A", sourceTicket: "TEAM-9", workflowDefId: "software-delivery" });
    const aBody = await aRes.json();

    // B genuinely won and created its run.
    expect(bBody!.deduplicated).toBeUndefined();
    expect(bBody!.workflowId).toMatch(/^wf_/);
    // A lost the fence → coalesced onto B, wrote NO row of its own.
    expect(aRes.status).toBe(200);
    expect(aBody).toMatchObject({ workflowId: bBody!.workflowId, deduplicated: true });
    // Exactly one real workflow row exists across both requests.
    expect(wfRows()).toEqual([bBody!.workflowId]);
    // Marker points at the winner.
    expect(h.store.get(markerId9())?.canonicalWorkflowId).toBe(bBody!.workflowId);
  });

  it("(b) fence winner path: dedup row is written via a TransactWriteCommand with a marker ConditionCheck (:me = workflowId)", async () => {
    const res = await post({ title: "t", sourceTicket: "TEAM-9", workflowDefId: "software-delivery" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.deduplicated).toBeUndefined();

    // The row went out as a transaction, not a plain Put.
    expect(h.transacts.length).toBe(1);
    const items = (h.transacts[0].TransactItems as Array<Record<string, any>>);
    const put = items.find((i) => i.Put)!;
    const check = items.find((i) => i.ConditionCheck)!;
    expect(put.Put.Item.workflowId).toBe(body.workflowId);
    expect(check.ConditionCheck.Key.workflowId).toBe(markerId9());
    expect(check.ConditionCheck.ConditionExpression).toContain("canonicalWorkflowId = :me");
    expect(check.ConditionCheck.ExpressionAttributeValues[":me"]).toBe(body.workflowId);
    // Row really landed.
    expect(h.store.get(body.workflowId)?.workflowId).toBe(body.workflowId);
  });

  it("(c) genuinely dead owner: stale marker + absent row → re-point, fenced write succeeds, run created", async () => {
    seedMarkerOnly(new Date(Date.now() - 10 * 60_000).toISOString()); // old owner never returns

    const res = await post({ title: "t recover", sourceTicket: "TEAM-9", workflowDefId: "software-delivery" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.deduplicated).toBeUndefined();
    expect(body.workflowId).not.toBe(CANON);
    // The fresh run's row was written behind the fence...
    expect(h.transacts.length).toBe(1);
    expect(h.store.get(body.workflowId)?.workflowId).toBe(body.workflowId);
    // ...and the marker now points at it.
    expect(h.store.get(markerId9())?.canonicalWorkflowId).toBe(body.workflowId);
  });

  it("(d) transient transaction cancel (marker still ours) is rethrown → 500, never a coalesce", async () => {
    h.failTransactOnce = true; // cancel the fenced write without re-pointing the marker

    const res = await post({ title: "t transient", sourceTicket: "TEAM-9", workflowDefId: "software-delivery" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.deduplicated).toBeUndefined();
    expect(body.error).toBeTruthy();
    // No row was written (the transaction was cancelled).
    expect(wfRows()).toEqual([]);
  });

  it("(e) non-dedup start (no sourceTicket) uses a plain PutCommand — no transaction, no marker", async () => {
    const res = await post({ title: "t plain", workflowDefId: "software-delivery" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.deduplicated).toBeUndefined();
    // Plain PutCommand path, never a transaction.
    expect(h.transacts.length).toBe(0);
    expect(h.puts.some((p) => p.workflowId === body.workflowId)).toBe(true);
    // No dedup marker was touched at all.
    expect([...h.store.keys()].some((k) => k.startsWith("wfdedup_"))).toBe(false);
  });
});

/**
 * TEAM-3703 — the fence is provider-agnostic; prove the headline >grace overlap
 * loss also holds under the Jira backend (row write is the same fenced transaction).
 */
describe("POST /api/workflow/start — ownership fence under the Jira backend (TEAM-3703)", () => {
  let jiraPost: (body: Record<string, unknown>) => ReturnType<typeof POST>;

  beforeEach(async () => {
    process.env.TICKET_PROVIDER = "jira";
    vi.resetModules();
    const mod = await import("./route");
    jiraPost = (body) =>
      mod.POST(
        new NextRequest("http://localhost/api/workflow/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      );
  });

  it("(a/jira) >grace overlap with a live winner → loser fences out, exactly one row, coalesces", async () => {
    let bBody: { workflowId: string; deduplicated?: boolean } | undefined;
    h.onInvoke = async () => {
      const m = h.store.get(markerId9())!;
      m.createdAt = new Date(Date.now() - 10 * 60_000).toISOString();
      h.store.set(markerId9(), m);
      bBody = await (await jiraPost({ title: "B", sourceTicket: "TEAM-9", workflowDefId: "software-delivery" })).json();
    };

    const aRes = await jiraPost({ title: "A", sourceTicket: "TEAM-9", workflowDefId: "software-delivery" });
    const aBody = await aRes.json();

    expect(bBody!.deduplicated).toBeUndefined();
    expect(aRes.status).toBe(200);
    expect(aBody).toMatchObject({ workflowId: bBody!.workflowId, deduplicated: true });
    expect(wfRows()).toEqual([bBody!.workflowId]);
    expect(h.store.get(markerId9())?.canonicalWorkflowId).toBe(bBody!.workflowId);
  });
});

/**
 * TEAM-3705 — orphan-epic cleanup on fence loss (P2 residual of TEAM-3703).
 *
 * The fence stops the loser's workflow ROW, but the loser has already created a
 * persistent EXTERNAL epic before losing. These tests drive the same >grace
 * overlap interleaving as the TEAM-3703 tests and assert EPIC-level cleanup:
 * the loser's epic is deleted (Jira) or cancelled via its terminal transition
 * with an audit comment (DynamoDB), the winner's epic is untouched, and cleanup
 * failure degrades to a logged manual-cleanup warning — never a failed response.
 */
describe("POST /api/workflow/start — orphan-epic cleanup on fence loss (TEAM-3705)", () => {
  /** Run the >grace overlap: A stalls in epic creation, B runs to completion. */
  async function raceOverlap(send: (body: Record<string, unknown>) => Promise<Response>) {
    let bBody: { workflowId: string; epicId?: string; deduplicated?: boolean } | undefined;
    h.onInvoke = async () => {
      const m = h.store.get(markerId9())!;
      m.createdAt = new Date(Date.now() - 10 * 60_000).toISOString();
      h.store.set(markerId9(), m);
      bBody = await (await send({ title: "B", sourceTicket: "TEAM-9", workflowDefId: "software-delivery" })).json();
    };
    const aRes = await send({ title: "A", sourceTicket: "TEAM-9", workflowDefId: "software-delivery" });
    return { aRes, aBody: await aRes.json(), bBody: bBody! };
  }

  const epicKeys = () => [...h.tickets.entries()].filter(([, t]) => t.type === "Epic").map(([k]) => k);
  const liveEpicKeys = () =>
    [...h.tickets.entries()].filter(([, t]) => t.type === "Epic" && t.status !== "done").map(([k]) => k);

  it("dynamodb: loser's orphan epic gets the audit comment and a done transition; winner's epic is the only live one", async () => {
    const errSpy = vi.spyOn(console, "error");
    const { aRes, aBody, bBody } = await raceOverlap(post);

    expect(bBody.deduplicated).toBeUndefined();
    expect(aRes.status).toBe(200);
    expect(aBody).toMatchObject({ workflowId: bBody.workflowId, deduplicated: true });

    // Two epics were created during the race; the loser's is the one that is
    // NOT the winner's epicId.
    expect(epicKeys()).toHaveLength(2);
    const loserEpic = epicKeys().find((k) => k !== bBody.epicId)!;
    expect(loserEpic).toBeTruthy();

    // Audit comment on the loser's epic names the winning workflow. TEAM-3708:
    // the real Tickets___add_comment contract (deploy/runtime-agent/main.py:1312,
    // lambda/agentcore-hub-jira/index.mjs:534) takes `comment`, not `body`.
    const comment = h.invokes.find((i) => i.tool_name === "Tickets___add_comment");
    expect(comment?.parameters?.ticket_id).toBe(loserEpic);
    expect(comment?.parameters?.comment).toContain(bBody.workflowId);
    expect(comment?.parameters?.body).toBeUndefined();

    // Terminal transition was requested for the loser's epic and applied.
    const done = h.invokes.find(
      (i) => i.tool_name === "Tickets___transition_ticket" && i.parameters?.transition_id === "done"
    );
    expect(done?.parameters?.ticket_id).toBe(loserEpic);
    expect(h.tickets.get(loserEpic)?.status).toBe("done");
    // The route verified the { status: "transitioned" } success shape — no
    // manual-cleanup error was logged.
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining("FAILED to cancel orphan epic"));

    // Net effect: exactly one persistent (non-cancelled) epic — the winner's.
    expect(h.tickets.get(bBody.epicId!)?.status).toBe("in_progress");
    expect(liveEpicKeys()).toEqual([bBody.epicId]);
    errSpy.mockRestore();
  });

  it("dynamodb: add_comment throws/rejects → done transition still executes, orphan is still cancelled", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.failAddCommentOnce = true;
    const { aRes, aBody, bBody } = await raceOverlap(post);

    // The comment call rejected, but that is cosmetic — the response is
    // unaffected and the terminal transition still ran.
    expect(aRes.status).toBe(200);
    expect(aBody).toMatchObject({ workflowId: bBody.workflowId, deduplicated: true });

    const loserEpic = epicKeys().find((k) => k !== bBody.epicId)!;
    const done = h.invokes.find(
      (i) => i.tool_name === "Tickets___transition_ticket" && i.parameters?.transition_id === "done"
    );
    expect(done?.parameters?.ticket_id).toBe(loserEpic);
    expect(h.tickets.get(loserEpic)?.status).toBe("done");
    expect(liveEpicKeys()).toEqual([bBody.epicId]);

    // The comment failure was logged, but as a comment failure — never as a
    // cancel/manual-cleanup failure (the cancellation itself succeeded).
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("FAILED to add cancellation audit comment"));
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining("FAILED to cancel orphan epic"));
    errSpy.mockRestore();
  });

  it("dynamodb: cleanup transition fails → still deduplicated success, manual-cleanup logged, loser epic left as-is", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.failDoneTransitionOnce = true;
    const { aRes, aBody, bBody } = await raceOverlap(post);

    // The response is unaffected by the cleanup failure.
    expect(aRes.status).toBe(200);
    expect(aBody).toMatchObject({ workflowId: bBody.workflowId, deduplicated: true });
    expect(wfRows()).toEqual([bBody.workflowId]);

    // The failure was logged for manual cleanup, and the loser's epic was not
    // silently marked done.
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("FAILED to cancel orphan epic"));
    const loserEpic = epicKeys().find((k) => k !== bBody.epicId)!;
    expect(h.tickets.get(loserEpic)?.status).not.toBe("done");
    errSpy.mockRestore();
  });

  describe("jira backend", () => {
    let jiraPost: (body: Record<string, unknown>) => ReturnType<typeof POST>;

    beforeEach(async () => {
      process.env.TICKET_PROVIDER = "jira";
      vi.resetModules();
      const mod = await import("./route");
      jiraPost = (body) =>
        mod.POST(
          new NextRequest("http://localhost/api/workflow/start", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        );
    });

    it("jira: loser's epic is deleted via deleteIssue; winner's epic is never deleted", async () => {
      const errSpy = vi.spyOn(console, "error");
      const { aRes, aBody, bBody } = await raceOverlap(jiraPost);

      expect(bBody.deduplicated).toBeUndefined();
      expect(aRes.status).toBe(200);
      expect(aBody).toMatchObject({ workflowId: bBody.workflowId, deduplicated: true });

      // A created JIRA-EPIC-1 (stalled), B created JIRA-EPIC-2 (winner).
      expect(bBody.epicId).toBe("JIRA-EPIC-2");
      expect(h.jiraDeleted).toEqual(["JIRA-EPIC-1"]);
      expect(h.jiraDeleted).not.toContain(bBody.epicId);
      expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining("FAILED to delete orphan Jira epic"));

      // Net effect: of the two epics created, exactly one persists.
      const persistent = ["JIRA-EPIC-1", "JIRA-EPIC-2"].filter((id) => !h.jiraDeleted.includes(id));
      expect(persistent).toEqual([bBody.epicId]);
      errSpy.mockRestore();
    });

    it("jira: deleteIssue throws (403) → still deduplicated success, manual-cleanup logged", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      h.failJiraDeleteOnce = true;
      const { aRes, aBody, bBody } = await raceOverlap(jiraPost);

      expect(aRes.status).toBe(200);
      expect(aBody).toMatchObject({ workflowId: bBody.workflowId, deduplicated: true });
      expect(wfRows()).toEqual([bBody.workflowId]);

      // Nothing was deleted, and the orphan was logged for manual cleanup.
      expect(h.jiraDeleted).toEqual([]);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("FAILED to delete orphan Jira epic JIRA-EPIC-1"));
      errSpy.mockRestore();
    });
  });
});

/**
 * TEAM-3872 — FR3b override metadata on DEDUPLICATED responses (review finding
 * on TEAM-3832 / PR #306).
 *
 * FR3b: a caller supplying BOTH workflowDefId and a contradicting workflowType
 * must get `workflowTypeOverridden: true` plus a human-readable `note` in the
 * JSON response — and the contract does not exempt deduplicated responses. The
 * defect: `responseMeta` was spread into the two normal success returns but
 * omitted from all three deduplicated returns (the POST coalesce early-return
 * and both fence-loss returns), so a redelivery/race with contradicting inputs
 * got a bare `{ workflowId, deduplicated: true }`.
 *
 * The harness DEF ("software-delivery") carries no `type` → derives "feature",
 * so `workflowType: "bug"` alongside it is the contradicting pair.
 */
describe("POST /api/workflow/start — FR3b override note on deduplicated responses (TEAM-3872)", () => {
  const CONTRA = { sourceTicket: "TEAM-9", workflowDefId: "software-delivery", workflowType: "bug" };

  it("coalesce redelivery with contradicting inputs → deduplicated:true AND workflowTypeOverridden:true + note", async () => {
    const first = await (await post({ title: "t", ...CONTRA })).json();
    expect(first.workflowTypeOverridden).toBe(true); // sanity: the normal path already carried it
    // Mark the canonical run non-terminal so the redelivery coalesces.
    h.store.set(first.workflowId, { workflowId: first.workflowId, phase: "development" });

    const res = await post({ title: "t again", ...CONTRA });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ workflowId: first.workflowId, deduplicated: true, workflowTypeOverridden: true });
    expect(typeof body.note).toBe("string");
    expect(body.note.length).toBeGreaterThan(0);
  });

  it("coalesce redelivery with AGREEING inputs stays clean — no override flag, no note", async () => {
    const agree = { sourceTicket: "TEAM-9", workflowDefId: "software-delivery", workflowType: "feature" };
    const first = await (await post({ title: "t", ...agree })).json();
    h.store.set(first.workflowId, { workflowId: first.workflowId, phase: "development" });

    const res = await post({ title: "t again", ...agree });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deduplicated).toBe(true);
    expect(body.workflowTypeOverridden).toBeUndefined();
    expect(body.note).toBeUndefined();
  });

  /** >grace overlap (same shape as TEAM-3705's raceOverlap) where the STALLED
   *  loser A carries the contradicting pair; racer B wins the marker. */
  async function raceOverlapContra(send: (body: Record<string, unknown>) => Promise<Response>) {
    let bBody: { workflowId: string; deduplicated?: boolean } | undefined;
    h.onInvoke = async () => {
      const m = h.store.get(markerId9())!;
      m.createdAt = new Date(Date.now() - 10 * 60_000).toISOString();
      h.store.set(markerId9(), m);
      bBody = await (await send({ title: "B", sourceTicket: "TEAM-9", workflowDefId: "software-delivery" })).json();
    };
    const aRes = await send({ title: "A", ...CONTRA });
    return { aRes, aBody: await aRes.json(), bBody: bBody! };
  }

  it("dynamodb fence-loss deduplicated response carries the override flag + note", async () => {
    const { aRes, aBody, bBody } = await raceOverlapContra(post);
    expect(aRes.status).toBe(200);
    expect(aBody).toMatchObject({ workflowId: bBody.workflowId, deduplicated: true, workflowTypeOverridden: true });
    expect(typeof aBody.note).toBe("string");
    expect(aBody.note.length).toBeGreaterThan(0);
  });

  describe("jira backend", () => {
    let jiraPost: (body: Record<string, unknown>) => ReturnType<typeof POST>;

    beforeEach(async () => {
      process.env.TICKET_PROVIDER = "jira";
      vi.resetModules();
      const mod = await import("./route");
      jiraPost = (body) =>
        mod.POST(
          new NextRequest("http://localhost/api/workflow/start", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        );
    });

    it("jira fence-loss deduplicated response carries the override flag + note", async () => {
      const { aRes, aBody, bBody } = await raceOverlapContra(jiraPost);
      expect(aRes.status).toBe(200);
      expect(aBody).toMatchObject({ workflowId: bBody.workflowId, deduplicated: true, workflowTypeOverridden: true });
      expect(typeof aBody.note).toBe("string");
      expect(aBody.note.length).toBeGreaterThan(0);
    });
  });
});
