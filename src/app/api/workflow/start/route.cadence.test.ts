import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { WorkflowDef } from "@/lib/workflow/workflow-defs";

/**
 * TEAM-4247 D2 FR-D2.4 — the sweep cadence gate on POST /api/workflow/start.
 *
 * A scheduled dead-code sweep on a repo that was swept < 14 days ago, or that
 * still has an open sweep PR, is SKIPPED (200 { status: "skipped" }) with a
 * tombstone row and a `workflow.skipped` event — no epic, no ticket, no workflow
 * row, nothing to clean up. The gate sits ABOVE the dedup marker, so these tests
 * assert on the ABSENCE of writes as much as their presence.
 *
 * Seams: the same in-memory DDB store the sibling route tests use (extended with
 * a ScanCommand that really evaluates the `workflowDefId = :def` filter and can
 * be forced to paginate), the ticket Lambda, and a stubbed global fetch for the
 * GitHub open-PR probe.
 */

const h = vi.hoisted(() => ({
  store: new Map<string, Record<string, unknown>>(),
  puts: [] as Array<{ table: string; item: Record<string, unknown> }>,
  invokes: [] as Array<{ tool_name: string }>,
  scans: [] as Array<Record<string, unknown>>,
  /** Every fetch the request made (the GitHub PR probe is the only one here). */
  fetches: [] as string[],
  /** What the PR probe's GitHub call answers with. */
  prs: [] as Array<Record<string, unknown>>,
  prStatus: 200,
  /** Force the Scan to come back one item per page, to pin the pagination loop. */
  paginateScan: false,
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
  class UpdateCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class TransactWriteCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class ScanCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    PutCommand,
    GetCommand,
    UpdateCommand,
    TransactWriteCommand,
    ScanCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
          const { input } = cmd;
          const name = cmd.constructor.name;
          if (name === "GetCommand") return { Item: h.store.get(input.Key.workflowId) };
          if (name === "ScanCommand") {
            h.scans.push(input);
            // Evaluate the route's real filter: workflowDefId = :def.
            const want = input.ExpressionAttributeValues?.[":def"];
            const all = [...h.store.values()].filter((r) => r.workflowDefId === want);
            if (!h.paginateScan) return { Items: all };
            // One item per page, keyed by the row's own PK, so the route must
            // follow LastEvaluatedKey to see the older rows.
            const from = input.ExclusiveStartKey
              ? all.findIndex((r) => r.workflowId === input.ExclusiveStartKey.workflowId) + 1
              : 0;
            const item = all[from];
            if (!item) return { Items: [] };
            const more = from + 1 < all.length;
            return { Items: [item], LastEvaluatedKey: more ? { workflowId: item.workflowId } : undefined };
          }
          if (name === "TransactWriteCommand") {
            for (const ti of input.TransactItems as Array<Record<string, any>>) {
              if (ti.Put) {
                h.puts.push({ table: ti.Put.TableName, item: ti.Put.Item });
                h.store.set(ti.Put.Item.workflowId, ti.Put.Item);
              }
            }
            return {};
          }
          if (name === "UpdateCommand") return {};
          // PutCommand — honor attribute_not_exists(workflowId), then write.
          const item = input.Item as Record<string, unknown>;
          const table = String(input.TableName);
          const isEvents = table.includes("events");
          const id = String(item.workflowId);
          if (!isEvents && input.ConditionExpression?.includes("attribute_not_exists(workflowId)") && h.store.has(id)) {
            const e = new Error("conditional check failed");
            e.name = "ConditionalCheckFailedException";
            throw e;
          }
          h.puts.push({ table, item });
          if (!isEvents) h.store.set(id, item);
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
      const result =
        call.tool_name === "Tickets___create_ticket" ? { key: `TEAM-${100 + h.ticketSeq++}` } : { key: "TEAM-100" };
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

/** The real dead-code-sweep def, trimmed to what the route reads. */
const SWEEP_DEF: WorkflowDef = {
  id: "dead-code-sweep",
  name: "Dead Code Sweep",
  description: "test",
  icon: "Trash2",
  intakeAgentId: "agentcore_hub_requirements_analyst",
  requiresRepo: true,
  featureBranchPhase: "development",
  createsPullRequest: true,
  completionRequiresAgentPhases: ["development"],
  phases: [
    { id: "intake", name: "Intake", type: "app", agentPhase: "intake" },
    { id: "detection", name: "Detect", type: "agent", agentPhase: "detection" },
  ],
};
const OTHER_DEF: WorkflowDef = { ...SWEEP_DEF, id: "software-delivery", name: "Software Delivery" };

vi.mock("@/lib/workflow/defs-loader", () => ({
  resolveWorkflowDef: vi.fn(async (id: string) => (id === "dead-code-sweep" ? SWEEP_DEF : OTHER_DEF)),
}));

const REPO = "https://github.com/tycenjmccann/ember";
const REPO_KEY = "tycenjmccann/ember";
const DAY = 24 * 60 * 60 * 1000;

let POST: typeof import("./route").POST;

beforeEach(async () => {
  h.store.clear();
  h.puts.length = 0;
  h.invokes.length = 0;
  h.scans.length = 0;
  h.fetches.length = 0;
  h.prs = [];
  h.prStatus = 200;
  h.paginateScan = false;
  h.ticketSeq = 0;
  process.env.TICKET_PROVIDER = "dynamodb";
  // The repo pre-flight is a different GitHub call and a different feature.
  process.env.REPO_CHECK_MODE = "off";
  process.env.SWEEP_CADENCE_GATE = "enforce";
  process.env.GITHUB_PAT = "gh-test-token";
  vi.stubGlobal("fetch", async (url: string) => {
    h.fetches.push(String(url));
    return { status: h.prStatus, json: async () => (h.prStatus === 200 ? h.prs : { message: "nope" }) };
  });
  vi.resetModules();
  ({ POST } = await import("./route"));
});

afterEach(() => {
  delete process.env.TICKET_PROVIDER;
  delete process.env.REPO_CHECK_MODE;
  delete process.env.SWEEP_CADENCE_GATE;
  delete process.env.GITHUB_PAT;
  vi.unstubAllGlobals();
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

function sweepBody(extra: Record<string, unknown> = {}) {
  return {
    title: "Dead-code sweep 2026-09-07",
    description: "scheduled hygiene",
    workflowDefId: "dead-code-sweep",
    trigger: "scheduled",
    repoConfig: { layout: "monorepo", repos: [{ url: REPO, defaultBranch: "main", platform: "backend" }] },
    ...extra,
  };
}

/** A prior sweep row, `ageDays` old, as the workflows table stores it. */
function priorSweep(ageDays: number, over: Record<string, unknown> = {}) {
  const at = new Date(Date.now() - ageDays * DAY).toISOString();
  return {
    workflowId: `wf_prior_${ageDays}`,
    workflowDefId: "dead-code-sweep",
    phase: "complete",
    startedAt: at,
    completedAt: at,
    input: { repoConfig: { layout: "monorepo", repos: [{ url: REPO }] } },
    ...over,
  };
}

const emberSweepPr = {
  number: 56,
  html_url: `${REPO}/pull/56`,
  title: "Dead code sweep: remove unreferenced helpers",
  head: { ref: "feature/TEAM-9001-dead-code-sweep" },
  draft: false,
  labels: [],
};

const runRows = () => h.puts.filter((p) => !p.table.includes("events") && String(p.item.workflowId).startsWith("wf_"));
const tombstones = () => h.puts.filter((p) => p.item.type === "skipped");
const events = () => h.puts.filter((p) => p.table.includes("events")).map((p) => p.item);

describe("POST /api/workflow/start — sweep cadence gate (TEAM-4247 D2)", () => {
  it("skips a scheduled sweep on a repo swept 3 days ago (recent-sweep)", async () => {
    const prior = priorSweep(3);
    h.store.set(prior.workflowId, prior);

    const res = await post(sweepBody());
    expect(res.status).toBe(200); // a skip is a successful no-op, not a 4xx
    const body = await res.json();
    expect(body).toMatchObject({ status: "skipped", reason: "recent-sweep" });
    expect(body.evidence).toMatchObject({ repo: REPO_KEY, lastRunId: prior.workflowId, minIntervalDays: 14 });
    expect(body.evidence.ageDays).toBeCloseTo(3, 1);

    // Nothing was created: no epic/ticket Lambda call, no run row.
    expect(h.invokes).toEqual([]);
    expect(runRows()).toEqual([]);

    // One tombstone, in the amendment-2 shape.
    expect(tombstones()).toHaveLength(1);
    expect(tombstones()[0].item).toMatchObject({
      type: "skipped",
      reason: "recent-sweep",
      repo: REPO_KEY,
      defId: "dead-code-sweep",
      deleted: true,
      phase: "cancelled",
      skipReason: "sweep-cadence",
      trigger: "scheduled",
    });
    expect(String(tombstones()[0].item.workflowId)).toMatch(/^skip_tycenjmccann-ember_\d{8}$/);
    expect(typeof tombstones()[0].item.at).toBe("string");

    // One workflow.skipped event, keyed on the tombstone id.
    const skipped = events().filter((e) => e.type === "workflow.skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].workflowId).toBe(tombstones()[0].item.workflowId);
    expect(skipped[0].detail).toMatchObject({
      workflowId: tombstones()[0].item.workflowId,
      reason: "recent-sweep",
      repo: REPO_KEY,
      defId: "dead-code-sweep",
      mode: "enforce",
    });
  });

  it("skips when an open sweep PR is still in review (ember #56), writing no run row", async () => {
    h.prs = [{ number: 12, html_url: "u", title: "Bump deps", head: { ref: "chore/deps" }, labels: [] }, emberSweepPr];

    const res = await post(sweepBody());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reason).toBe("open-sweep-pr");
    expect(body.evidence.pr).toBe(56);
    expect(body.evidence.headRef).toBe("feature/TEAM-9001-dead-code-sweep");
    expect(body.evidence.url).toBe(`${REPO}/pull/56`);

    expect(h.invokes).toEqual([]);
    expect(runRows()).toEqual([]);
    expect(tombstones()).toHaveLength(1);
    expect(tombstones()[0].item.reason).toBe("open-sweep-pr");
    // The probe really asked GitHub for the repo's open PRs.
    expect(h.fetches.some((u) => u.includes("/repos/tycenjmccann/ember/pulls?state=open"))).toBe(true);
  });

  it("runs a scheduled sweep when the last one was 21 days ago and no sweep PR is open", async () => {
    const prior = priorSweep(21);
    h.store.set(prior.workflowId, prior);
    h.prs = [{ number: 12, html_url: "u", title: "Bump deps", head: { ref: "chore/deps" }, labels: [] }];

    const res = await post(sweepBody());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBeUndefined();
    expect(body.workflowId).toMatch(/^wf_/);
    expect(tombstones()).toEqual([]);
    expect(h.invokes.length).toBeGreaterThan(0); // the run really started
  });

  it("an ERRORED sweep 2 days ago is not a sweep — the scheduled run is created (TEAM-4265 F10)", async () => {
    // The crash-loop this fixes: a scheduled sweep that died 3 minutes in used to
    // suppress every retry for 14 days, so the repo silently stopped being swept.
    const crashed = priorSweep(2, { workflowId: "wf_prior_err", phase: "error" });
    h.store.set(crashed.workflowId, crashed);

    const res = await post(sweepBody());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBeUndefined(); // not "skipped"
    expect(body.workflowId).toMatch(/^wf_/);
    expect(tombstones()).toEqual([]);
    expect(events().filter((e) => e.type === "workflow.skipped")).toEqual([]);
    expect(h.invokes.length).toBeGreaterThan(0); // the run really started
  });

  it("paginates the scan — a prior sweep behind a page boundary still skips", async () => {
    // Two OTHER sweep rows (different repo) ahead of the recent one, so the
    // deciding row is only visible if the route follows LastEvaluatedKey.
    for (const i of [1, 2]) {
      const other = priorSweep(40, {
        workflowId: `wf_other_${i}`,
        input: { repoConfig: { layout: "monorepo", repos: [{ url: "https://github.com/other/repo" }] } },
      });
      h.store.set(other.workflowId, other);
    }
    const prior = priorSweep(2);
    h.store.set(prior.workflowId, prior);
    h.paginateScan = true;

    const body = await (await post(sweepBody())).json();
    expect(h.scans.length).toBe(3);
    expect(body.reason).toBe("recent-sweep");
    expect(body.evidence.lastRunId).toBe(prior.workflowId);
  });

  it("does not gate a MANUAL run of the same routine, even with a 3-day-old sweep", async () => {
    const prior = priorSweep(3);
    h.store.set(prior.workflowId, prior);

    const body = await (await post(sweepBody({ trigger: "manual" }))).json();
    expect(body.workflowId).toMatch(/^wf_/);
    expect(h.scans).toEqual([]); // the gate never even looked
    expect(h.fetches).toEqual([]);
    expect(tombstones()).toEqual([]);
  });

  it("does not gate a scheduled run of a DIFFERENT def", async () => {
    const prior = priorSweep(3);
    h.store.set(prior.workflowId, prior);

    const body = await (
      await post(sweepBody({ workflowDefId: "software-delivery", trigger: "scheduled" }))
    ).json();
    expect(body.workflowId).toMatch(/^wf_/);
    expect(h.scans).toEqual([]);
    expect(tombstones()).toEqual([]);
  });

  it("shadow: creates the run, emits sweep.cadence_observed, writes no tombstone", async () => {
    process.env.SWEEP_CADENCE_GATE = "shadow";
    vi.resetModules();
    ({ POST } = await import("./route"));
    const prior = priorSweep(3);
    h.store.set(prior.workflowId, prior);

    const body = await (await post(sweepBody())).json();
    expect(body.workflowId).toMatch(/^wf_/); // the run happened as today
    expect(tombstones()).toEqual([]);

    const observed = events().filter((e) => e.type === "sweep.cadence_observed");
    expect(observed).toHaveLength(1);
    expect(observed[0].detail).toMatchObject({ wouldSkip: "recent-sweep", repo: REPO_KEY, defId: "dead-code-sweep" });
    expect(events().filter((e) => e.type === "workflow.skipped")).toEqual([]);
  });

  it("off: scans nothing, probes nothing, runs", async () => {
    process.env.SWEEP_CADENCE_GATE = "off";
    vi.resetModules();
    ({ POST } = await import("./route"));
    const prior = priorSweep(1);
    h.store.set(prior.workflowId, prior);
    h.prs = [emberSweepPr];

    const body = await (await post(sweepBody())).json();
    expect(body.workflowId).toMatch(/^wf_/);
    expect(h.scans).toEqual([]);
    expect(h.fetches).toEqual([]);
    expect(events()).toEqual([]);
  });

  it("the tombstone id is deterministic per (repo, day) — a repeat tick writes one row", async () => {
    const prior = priorSweep(3);
    h.store.set(prior.workflowId, prior);

    const first = await (await post(sweepBody())).json();
    const firstId = tombstones()[0].item.workflowId;
    h.puts.length = 0;

    const second = await (await post(sweepBody())).json();
    // Same skip reported, no second tombstone row (the conditional put lost).
    expect(second).toMatchObject({ status: "skipped", reason: first.reason });
    expect(h.store.has(String(firstId))).toBe(true);
    expect(events().filter((e) => e.type === "workflow.skipped")).toEqual([]);
    expect(runRows()).toEqual([]);
  });

  it("without a GITHUB_PAT the PR probe is skipped but the cadence check still decides", async () => {
    delete process.env.GITHUB_PAT;
    vi.resetModules();
    ({ POST } = await import("./route"));
    h.prs = [emberSweepPr];

    // No prior sweep → the open sweep PR is invisible without a token, so the run
    // proceeds (the gate fails OPEN) and says why in the evidence.
    const open = await (await post(sweepBody())).json();
    expect(open.workflowId).toMatch(/^wf_/);
    expect(h.fetches).toEqual([]);

    // …but a 3-day-old sweep is still a skip: the DDB half needs no token.
    h.puts.length = 0;
    h.store.clear();
    const prior = priorSweep(3);
    h.store.set(prior.workflowId, prior);
    const body = await (await post(sweepBody())).json();
    expect(body.reason).toBe("recent-sweep");
    expect(body.evidence.prProbe).toMatchObject({ probed: false });
    expect(String(body.evidence.prProbe.reason)).toContain("GITHUB_PAT");
  });

  it("this gate's own tombstones never justify the next skip", async () => {
    // Yesterday's tombstone for the same repo, still in the table.
    const tomb = {
      workflowId: "skip_tycenjmccann-ember_20260906",
      workflowDefId: "dead-code-sweep",
      type: "skipped",
      phase: "cancelled",
      deleted: true,
      repo: REPO_KEY,
      startedAt: new Date(Date.now() - DAY).toISOString(),
      input: { repoConfig: { layout: "monorepo", repos: [{ url: REPO }] } },
    };
    h.store.set(tomb.workflowId, tomb);

    const body = await (await post(sweepBody())).json();
    expect(body.workflowId).toMatch(/^wf_/); // ran: a skip is not a sweep
    expect(tombstones()).toEqual([]);
  });
});
