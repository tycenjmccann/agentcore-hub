import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { WorkflowDef } from "@/lib/workflow/workflow-defs";

/**
 * TEAM-4740 FR-9 — the route half of the dead-code-sweep preflight.
 *
 * The preflight's whole value is what it does NOT do: a skip must produce no
 * epic, no tickets and no workflow row, because those are the cost it exists to
 * avoid. That is a negative property, so it is asserted here at the route rather
 * than in sweep-preflight.test.ts — the pure decision cannot see whether an epic
 * was created.
 *
 * Three more things this pins, each of which was a real footgun:
 *  - the gate is `def.preflight === "sweep"`, so a def without the flag makes ZERO
 *    GitHub calls (the preflight must not add latency to every submission);
 *  - a skip RELEASES the dedup marker it claimed, fenced on its own id — otherwise
 *    every redelivery inside the grace window coalesces onto a run that never was;
 *  - a probe failure still starts the run (DL-028 — "we could not look" is not
 *    "there is nothing to sweep").
 *
 * The DDB seam is the in-memory store route.dedup.test.ts uses, extended with
 * DeleteCommand (which this commit is the first caller of). `fetch` is stubbed.
 */

const h = vi.hoisted(() => ({
  store: new Map<string, Record<string, unknown>>(),
  invokes: [] as Array<{ tool_name: string; parameters?: Record<string, string> }>,
  puts: [] as Array<Record<string, unknown>>,
  deletes: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  fetches: [] as Array<{ url: string; init?: RequestInit }>,
  routes: {} as Record<string, { status?: number; json?: unknown }>,
  ticketSeq: 0,
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class PutCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class GetCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class DeleteCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class UpdateCommand {
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
  return {
    PutCommand,
    GetCommand,
    DeleteCommand,
    UpdateCommand,
    TransactWriteCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
          const { input } = cmd;
          const kind = cmd.constructor.name;
          if (kind === "GetCommand") return { Item: h.store.get(input.Key.workflowId) };
          if (kind === "DeleteCommand") {
            const existing = h.store.get(input.Key.workflowId);
            const cond = input.ConditionExpression as string | undefined;
            if (cond?.includes("canonicalWorkflowId = :mine")) {
              const mine = input.ExpressionAttributeValues[":mine"];
              if (!existing || existing.canonicalWorkflowId !== mine) fail();
            }
            h.deletes.push(input);
            h.store.delete(input.Key.workflowId);
            return {};
          }
          if (kind === "TransactWriteCommand") {
            const items = input.TransactItems as Array<Record<string, any>>;
            for (const ti of items) {
              if (ti.ConditionCheck) {
                const cc = ti.ConditionCheck;
                const existing = h.store.get(cc.Key.workflowId);
                if ((cc.ConditionExpression as string).includes("canonicalWorkflowId = :me")) {
                  if (!existing || existing.canonicalWorkflowId !== cc.ExpressionAttributeValues[":me"]) fail();
                }
              }
            }
            for (const ti of items) {
              if (ti.Put) {
                h.puts.push(ti.Put.Item);
                h.store.set(ti.Put.Item.workflowId, ti.Put.Item);
              }
            }
            return {};
          }
          // PutCommand — events table rows are recorded separately from rows.
          const item = input.Item as Record<string, unknown>;
          if (input.TableName === "agentcore-hub-events") {
            h.events.push(item);
            return {};
          }
          const id = item.workflowId as string;
          const cond = input.ConditionExpression as string | undefined;
          const existing = h.store.get(id);
          if (cond?.includes("attribute_not_exists(workflowId)") && existing) fail();
          if (cond?.includes("canonicalWorkflowId = :old")) {
            if (!existing || existing.canonicalWorkflowId !== input.ExpressionAttributeValues[":old"]) fail();
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
      let result: Record<string, unknown> = { key: "TEAM-100" };
      if (call.tool_name === "Tickets___create_ticket") result = { key: `TEAM-${100 + h.ticketSeq++}` };
      return { Payload: new TextEncoder().encode(JSON.stringify(result)) };
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

const SWEEP_DEF: WorkflowDef = {
  id: "dead-code-sweep",
  name: "Dead Code Sweep",
  description: "test",
  icon: "Trash2",
  intakeAgentId: "agentcore_hub_requirements_analyst",
  requiresRepo: true,
  featureBranchPhase: "development",
  createsPullRequest: true,
  ledgerCommit: false,
  preflight: "sweep",
  completionRequiresAgentPhases: [],
  phases: [{ id: "sweep", name: "Sweep", type: "agent", agentPhase: "development" }],
};
/** Same def with the flag removed — the untouched path. */
const PLAIN_DEF: WorkflowDef = { ...SWEEP_DEF, id: "software-delivery", preflight: undefined };

vi.mock("@/lib/workflow/defs-loader", () => ({
  resolveWorkflowDef: vi.fn(async (id: string) => (id === "dead-code-sweep" ? SWEEP_DEF : PLAIN_DEF)),
}));

const MAIN = "0760fcc1a2b3c4d5e6f708192a3b4c5d6e7f8091";
const REPO_CONFIG = {
  layout: "multi-repo" as const,
  repos: [
    {
      url: "https://github.com/tycenjmccann/agentcore-hub",
      defaultBranch: "main",
      platform: "backend" as const,
    },
  ],
};

let POST: typeof import("./route").POST;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  h.store.clear();
  h.invokes.length = 0;
  h.puts.length = 0;
  h.deletes.length = 0;
  h.events.length = 0;
  h.fetches.length = 0;
  h.routes = {};
  h.ticketSeq = 0;
  process.env.TICKET_PROVIDER = "dynamodb";
  // The URL pre-flight is a separate concern with its own tests; off here so the
  // only GitHub traffic in this file is the sweep preflight's.
  process.env.REPO_CHECK_MODE = "off";
  process.env.GITHUB_PAT = "pat";
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    h.fetches.push({ url: String(url), init });
    const path = String(url).replace("https://api.github.com", "");
    // LONGEST match, not first: the preflight now reads both `/pulls/33` (for
    // `mergeable`) and `/pulls/33/files`, and a first-match stub would confuse them.
    const key = Object.keys(h.routes)
      .filter((k) => path.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) return { status: 404, json: async () => ({ message: "Not Found" }) };
    const r = h.routes[key];
    return { status: r.status ?? 200, json: async () => r.json ?? null };
  }) as unknown as typeof fetch;
  vi.resetModules();
  ({ POST } = await import("./route"));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.TICKET_PROVIDER;
  delete process.env.REPO_CHECK_MODE;
  delete process.env.GITHUB_PAT;
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

/** #33: open, based on main HEAD, from a branch in this repo, and mergeable. */
const PR_33 = {
  number: 33,
  html_url: "u33",
  head: { ref: "chore/dead-code-sweep-33", repo: { full_name: "tycenjmccann/agentcore-hub" } },
  base: { sha: MAIN, ref: "main" },
};

const openSweepPrAtMain = (detailOver: Record<string, unknown> = {}) => {
  h.routes = {
    "/repos/tycenjmccann/agentcore-hub/commits/main": { json: { sha: MAIN } },
    "/repos/tycenjmccann/agentcore-hub/pulls?state=open": { json: [PR_33] },
    // TEAM-4752 D4: the single-PR endpoint is the only one carrying `mergeable`.
    "/repos/tycenjmccann/agentcore-hub/pulls/33": { json: { ...PR_33, draft: false, mergeable: true, ...detailOver } },
    "/repos/tycenjmccann/agentcore-hub/pulls/33/files": { json: [{ status: "removed", filename: "src/gone.ts" }] },
    "/repos/tycenjmccann/agentcore-hub/issues/33/comments": { status: 201, json: {} },
  };
};

const submit = (extra: Record<string, unknown> = {}) =>
  post({
    title: "Scheduled dead-code sweep",
    description: "Sweep the repo.",
    workflowDefId: "dead-code-sweep",
    repoConfig: REPO_CONFIG,
    ...extra,
  });

describe("POST /api/workflow/start — sweep preflight skip", () => {
  it("answers 200 { skipped:true } and creates NO epic, ticket or workflow row", async () => {
    openSweepPrAtMain();
    const res = await submit();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      skipped: true,
      reason: "open_sweep_pr",
      prs: [{ number: 33, url: "u33", baseSha: MAIN, mergeable: true }],
      mainSha: MAIN,
    });
    // The saving, stated as absence: not one ticket-Lambda call, not one row.
    expect(h.invokes).toEqual([]);
    expect(h.puts).toEqual([]);
  });

  it("records workflow.skipped and comments once on the newest open sweep PR", async () => {
    openSweepPrAtMain();
    await submit();
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      type: "workflow.skipped",
      detail: {
        reason: "open_sweep_pr",
        mainSha: MAIN,
        prs: [{ number: 33, url: "u33", baseSha: MAIN, mergeable: true }],
      },
    });
    expect(h.events[0].workflowId).toEqual(h.events[0].detail && (h.events[0].detail as any).workflowId);
    const comments = h.fetches.filter((f) => f.url.endsWith("/issues/33/comments"));
    expect(comments).toHaveLength(1);
    expect(JSON.parse(String(comments[0].init?.body))).toEqual({
      // The observed mergeability reaches the comment through the route, which is
      // the whole point of carrying it on the echo (TEAM-4752 D4). The date is the
      // run's own timestamp, so it is matched by shape rather than recomputed here.
      body: expect.stringMatching(
        new RegExp(`^re-verified against main @${MAIN} on \\d{4}-\\d{2}-\\d{2}; still mergeable$`)
      ),
    });
  });

  it("says 'not yet computed' when GitHub has not answered mergeability yet", async () => {
    // Still a skip — null is not a negative — but the comment must not tell the
    // human the PR is fine on the strength of a base SHA.
    openSweepPrAtMain({ mergeable: null });
    const res = await submit();
    expect((await res.json()).skipped).toBe(true);
    const comments = h.fetches.filter((f) => f.url.endsWith("/issues/33/comments"));
    expect(JSON.parse(String(comments[0].init?.body)).body).toContain("mergeability not yet computed by GitHub");
  });

  it("does NOT skip when the open sweep PR is conflicting — it starts the run", async () => {
    openSweepPrAtMain({ mergeable: false });
    const res = await submit();
    const body = await res.json();
    expect(body.skipped).toBeUndefined();
    // A real run: a workflow row exists, and nothing was commented on a PR that
    // cannot deliver the sweep.
    expect(h.puts.find((p) => (p.workflowId as string)?.startsWith("wf_"))).toBeDefined();
    expect(h.fetches.filter((f) => f.url.endsWith("/comments"))).toEqual([]);
    expect(h.events.filter((e) => e.type === "workflow.skipped")).toEqual([]);
  });

  it("releases the dedup marker it claimed, fenced on its own id", async () => {
    openSweepPrAtMain();
    const markerId = `wfdedup_${createHash("sha256").update("TEAM-9:dead-code-sweep").digest("hex")}`;
    const res = await submit({ sourceTicket: "TEAM-9" });
    expect((await res.json()).skipped).toBe(true);
    expect(h.deletes).toHaveLength(1);
    expect(h.deletes[0].Key).toEqual({ workflowId: markerId });
    expect(h.deletes[0].ConditionExpression).toBe("canonicalWorkflowId = :mine");
    // Gone, so the next redelivery starts a real run instead of coalescing onto
    // a canonical workflow that was never created.
    expect(h.store.has(markerId)).toBe(false);
  });

  it("does not delete a marker a racer legitimately re-pointed", async () => {
    openSweepPrAtMain();
    const markerId = `wfdedup_${createHash("sha256").update("TEAM-9:dead-code-sweep").digest("hex")}`;
    // Claim happens inside the route; the racer re-points it before the skip's
    // Delete lands. The conditional Delete must lose, not clobber.
    const spy = vi.spyOn(h.store, "get").mockImplementation((k: string) => {
      if (k === markerId) return { workflowId: markerId, canonicalWorkflowId: "wf_someone_else" };
      return undefined;
    });
    const res = await submit({ sourceTicket: "TEAM-9" });
    spy.mockRestore();
    // Still a skip — the marker is a coalescing hint, never a reason to run.
    expect((await res.json()).skipped).toBe(true);
    expect(h.deletes).toEqual([]);
  });
});

describe("POST /api/workflow/start — sweep preflight proceed", () => {
  it("appends alreadyRemoved to the description and stamps input.preflight", async () => {
    const moved = "bbb2220000000000000000000000000000000000";
    const pr23 = {
      number: 23,
      html_url: "u23",
      head: { ref: "chore/dead-code-sweep-23", repo: { full_name: "tycenjmccann/agentcore-hub" } },
      base: { sha: MAIN, ref: "main" },
      body: "## Removal Ledger\n- `budget_map`",
    };
    h.routes = {
      "/repos/tycenjmccann/agentcore-hub/commits/main": { json: { sha: moved } },
      "/repos/tycenjmccann/agentcore-hub/pulls?state=open": { json: [pr23] },
      "/repos/tycenjmccann/agentcore-hub/pulls/23": { json: { ...pr23, draft: false, mergeable: true } },
      "/repos/tycenjmccann/agentcore-hub/pulls/23/files": { json: [] },
    };
    const res = await submit();
    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toBeUndefined();
    const row = h.puts.find((p) => (p.workflowId as string)?.startsWith("wf_"));
    expect(row).toBeDefined();
    const input = row!.input as { description: string; preflight: Record<string, unknown> };
    // index.mjs renders input.description into every persona's context, so this
    // is the delivery mechanism — no orchestrator change needed.
    expect(input.description).toContain("Sweep the repo.");
    expect(input.description).toContain("## Sweep preflight");
    expect(input.description).toContain("- budget_map");
    expect(input.preflight).toEqual({
      decision: "proceed",
      alreadyRemoved: ["budget_map"],
      stackedOn: { number: 23, url: "u23" },
      mainSha: moved,
    });
    expect(h.events.filter((e) => e.type === "workflow.skipped")).toEqual([]);
  });

  it("starts the run anyway when the probe fails (fail open)", async () => {
    h.routes = {}; // every GitHub read 404s
    const res = await submit();
    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toBeUndefined();
    const row = h.puts.find((p) => (p.workflowId as string)?.startsWith("wf_"));
    const input = row!.input as { description: string; preflight: Record<string, unknown> };
    // Nothing appended — we have no list, and inventing an empty one as if we had
    // looked would tell the analyst something we do not know.
    expect(input.description).toBe("Sweep the repo.");
    expect(input.preflight).toEqual({ decision: "proceed", alreadyRemoved: [], mainSha: null });
  });
});

describe("POST /api/workflow/start — defs without the flag are untouched", () => {
  it("makes ZERO GitHub calls and starts normally", async () => {
    openSweepPrAtMain(); // would have skipped, if the gate were on def.id or repo
    const res = await post({
      title: "A normal feature",
      description: "Do the thing.",
      workflowDefId: "software-delivery",
      repoConfig: REPO_CONFIG,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toBeUndefined();
    expect(h.fetches).toEqual([]);
    const row = h.puts.find((p) => (p.workflowId as string)?.startsWith("wf_"));
    const input = row!.input as { description: string; preflight?: unknown };
    expect(input.description).toBe("Do the thing.");
    expect(input.preflight).toBeUndefined();
  });
});
