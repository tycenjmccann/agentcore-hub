import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Completion-evidence harvest on the done cascade.
 *
 * The evidence gate (TEAM-3690) requires agentTasks output/artifactKey, but the
 * only other writer of those fields — the agent_completion webhook's metadata
 * merge — has no live caller, so every gated run stranded non-terminal
 * (first observed: wf coc7es/TEAM-3611). markTaskComplete now harvests the
 * agent's own report_completion record (S3 completions/{ticketId}.json) into
 * the task entry via store.mergeTaskMetadata, on BOTH done paths.
 *
 * Same harness as done-handlers-cascade.test.mjs: real handlers, real cascade,
 * mocked I/O seams — except S3 here can serve completion records.
 */

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    children: /** @type {any[]} */ ([]),
    workflow: /** @type {any} */ (null),
    s3Objects: /** @type {Record<string, string>} */ ({}),
    s3Gets: /** @type {string[]} */ ([]),
    merges: /** @type {any[]} */ ([]),
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class GetCommand { constructor(input) { this.input = input; } }
  class PutCommand { constructor(input) { this.input = input; } }
  class UpdateCommand { constructor(input) { this.input = input; } }
  class QueryCommand { constructor(input) { this.input = input; } }
  class ScanCommand { constructor(input) { this.input = input; } }
  return {
    GetCommand, PutCommand, UpdateCommand, QueryCommand, ScanCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd) => {
          const name = cmd.constructor.name;
          if (name === "GetCommand") {
            return { Item: h.state.tickets[cmd.input.Key.ticketId] || null };
          }
          if (name === "QueryCommand") {
            if (cmd.input.TableName === "agentcore-hub-events") return { Items: [] };
            return { Items: h.state.children };
          }
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class { async send() { return {}; } },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      if (cmd.constructor.name === "GetObjectCommand") {
        h.state.s3Gets.push(cmd.input.Key);
        const body = h.state.s3Objects[cmd.input.Key];
        if (body === undefined) throw new Error("NoSuchKey");
        return { Body: { transformToString: async () => body } };
      }
      return {};
    }
  },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; } },
  ListObjectsV2Command: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send() { return {}; } },
  PutEventsCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-bedrock-agent-runtime", () => ({
  BedrockAgentRuntimeClient: class {},
  InvokeAgentCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("./workflow-store.mjs", () => ({
  initWorkflowStore: vi.fn(() => {}),
  getWorkflow: vi.fn(async (id) => (h.state.workflow?.id === id ? h.state.workflow : null)),
  completeTaskEntry: vi.fn(async () => true), // the real store returns "stamped?" (TEAM-5890)
  mergeTaskMetadata: vi.fn(async (wfId, tid, fields) => { h.state.merges.push({ wfId, tid, fields }); }),
  claimInvocation: vi.fn(async () => true),
  appendReviewNotificationOnce: vi.fn(async () => true),
  setTaskStatus: vi.fn(async () => {}),
  completeWorkflow: vi.fn(async () => true),
  claimFinalization: vi.fn(async () => false),
  markFinalized: vi.fn(async () => {}),
}));

// The harvest is gated on ARTIFACT_BUCKET; read at module load.
process.env.ARTIFACT_BUCKET = "test-bucket";

let handleTicketDoneUnified;
let handleTicketDone;

async function load() {
  vi.resetModules();
  ({ handleTicketDoneUnified, handleTicketDone } = await import("./index.mjs"));
}

const DONE = "TEAM-1";
const PARENT = "EPIC-1";
const DEV = "agentcore_hub_backend_dev";
const COMPLETION_KEY = `completions/${DONE}.json`;

const RECORD = JSON.stringify({
  ticket_id: DONE,
  summary: "Implemented the feature and pushed the branch.",
  branch: "feature/x",
  commit_sha: "abc123",
  pr_url: "https://github.com/o/r/pull/7",
});

function makeWorkflow(taskEntry) {
  return {
    id: "wf_1",
    workflowId: "wf_1",
    epicId: PARENT,
    workflowDefId: "software-delivery",
    input: { title: "t" },
    humanNotifications: [],
    agentTasks: {
      [DONE]: {
        id: "task_t1", agentId: DEV, ticketId: DONE,
        status: "running", startedAt: "2020-01-01T00:00:00Z",
        ...taskEntry,
      },
    },
  };
}

beforeEach(async () => {
  h.state.tickets = {
    [DONE]: { ticketId: DONE, parentId: PARENT, workflowId: "wf_1", assignee: DEV, status: "done" },
  };
  // An open sibling keeps the run from completing — these tests pin only the harvest.
  h.state.children = [
    { ticketId: DONE, parentId: PARENT, status: "done", assignee: DEV, type: "task" },
    { ticketId: "TEAM-2", parentId: PARENT, status: "todo", assignee: DEV, blockedBy: [], type: "task" },
  ];
  h.state.workflow = makeWorkflow();
  h.state.s3Objects = {};
  h.state.s3Gets.length = 0;
  h.state.merges.length = 0;
  await load();
});

const streamImage = () => ({ parentId: PARENT, workflowId: "wf_1", assignee: DEV });

describe("completion-evidence harvest on the done cascade", () => {
  it("Jira-webhook path: merges summary/branch/commitSha/prUrl from completions/{tid}.json", async () => {
    h.state.s3Objects[COMPLETION_KEY] = RECORD;
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges).toEqual([{
      wfId: "wf_1",
      tid: DONE,
      fields: {
        output: "Implemented the feature and pushed the branch.",
        branch: "feature/x",
        commitSha: "abc123",
        prUrl: "https://github.com/o/r/pull/7",
      },
    }]);
    // In-memory snapshot updated too — completeWorkflow's gate re-read aside,
    // same-invoke consumers must see the evidence.
    expect(h.state.workflow.agentTasks[DONE].output).toBe(
      "Implemented the feature and pushed the branch."
    );
  });

  it("DDB-stream path: same harvest", async () => {
    h.state.s3Objects[COMPLETION_KEY] = RECORD;
    await handleTicketDone(DONE, streamImage());
    expect(h.state.merges).toHaveLength(1);
    expect(h.state.merges[0].fields.output).toBe("Implemented the feature and pushed the branch.");
  });

  it("existing evidence wins for the deliverable — but the ship signals are still harvested", async () => {
    // TEAM-3747 D2 changed the early return from `hasEvidence` to
    // `hasEvidence && hasShipSignal`: a landed webhook merge still owns `output`,
    // yet the record's merge/deploy signals must reach the entry or the ship gate
    // would false-block a run that really did ship.
    h.state.workflow = makeWorkflow({ output: "webhook merge landed first" });
    h.state.s3Objects[COMPLETION_KEY] = RECORD;
    await handleTicketDoneUnified(DONE);
    expect(h.state.s3Gets).toContain(COMPLETION_KEY);
    expect(h.state.merges).toHaveLength(1);
    // output/branch untouched (the webhook's deliverable wins) …
    expect(h.state.merges[0].fields.output).toBeUndefined();
    expect(h.state.merges[0].fields.branch).toBeUndefined();
    // … only the ship-verdict signals are filled.
    expect(h.state.merges[0].fields).toEqual({
      commitSha: "abc123",
      prUrl: "https://github.com/o/r/pull/7",
    });
    expect(h.state.workflow.agentTasks[DONE].output).toBe("webhook merge landed first");
  });

  it("evidence AND a ship signal already present — no S3 read, no merge", async () => {
    // Both halves satisfied is the only short-circuit left; it must still hold or
    // every done ticket re-reads S3 on every cascade.
    h.state.workflow = makeWorkflow({ output: "webhook merge landed first", mergeCommit: "9f1c2ab" });
    h.state.s3Objects[COMPLETION_KEY] = RECORD;
    await handleTicketDoneUnified(DONE);
    expect(h.state.s3Gets).not.toContain(COMPLETION_KEY);
    expect(h.state.merges).toHaveLength(0);
  });

  it("missing completion record: cascade still completes, no merge, no throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges).toHaveLength(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("evidence harvest skipped"))).toBe(true);
    warn.mockRestore();
  });

  it("empty summary + no branch/pr: nothing to merge", async () => {
    h.state.s3Objects[COMPLETION_KEY] = JSON.stringify({ ticket_id: DONE, summary: "   " });
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges).toHaveLength(0);
  });

  it("oversized summary is clamped to 10000 chars", async () => {
    h.state.s3Objects[COMPLETION_KEY] = JSON.stringify({ ticket_id: DONE, summary: "x".repeat(20000) });
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges[0].fields.output).toHaveLength(10000);
  });
});

/**
 * TEAM-3747 D2 — the ship/CD verdict signals. The merge-verdict gate reads
 * agentTasks[tid].mergeCommit / .outcome / .blockReason, and the ONLY writer that
 * runs on the live cascade is this harvest. If merge_commit stopped being picked
 * up, every shipped run would false-close static-ci-only; if outcome/block_reason
 * stopped, a genuinely blocked deploy would degrade to the vaguer verdict with no
 * reason for the human. Each is filled only when the entry lacks it (additive —
 * legacy records simply have no such keys).
 */
const harvest = (record) => { h.state.s3Objects[COMPLETION_KEY] = JSON.stringify({ ticket_id: DONE, ...record }); };

describe("ship-verdict harvest — merge_commit / outcome / block_reason (TEAM-3747 D2)", () => {
  it("harvests merge_commit + a shipped outcome alongside the deliverable evidence", async () => {
    harvest({ summary: "Merged and deployed.", branch: "feature/x", commit_sha: "abc123", pr_url: "https://github.com/o/r/pull/7", merge_commit: "9f1c2ab", outcome: "shipped" });
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges).toEqual([{
      wfId: "wf_1",
      tid: DONE,
      fields: {
        output: "Merged and deployed.",
        branch: "feature/x",
        commitSha: "abc123",
        prUrl: "https://github.com/o/r/pull/7",
        mergeCommit: "9f1c2ab",
        outcome: "shipped",
      },
    }]);
    // The in-memory entry the same invoke's ship gate will read.
    expect(h.state.workflow.agentTasks[DONE].mergeCommit).toBe("9f1c2ab");
    expect(h.state.workflow.agentTasks[DONE].outcome).toBe("shipped");
  });

  it("harvests a deploy-blocked outcome WITH its block reason", async () => {
    harvest({ summary: "Pre-merge preflight BLOCKED.", outcome: "deploy-blocked", block_reason: "required check cd/deploy-staging is failing — refusing to merge" });
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges[0].fields.outcome).toBe("deploy-blocked");
    expect(h.state.merges[0].fields.blockReason).toBe("required check cd/deploy-staging is failing — refusing to merge");
    // Nothing merged pretends the work shipped.
    expect(h.state.merges[0].fields.mergeCommit).toBeUndefined();
  });

  it("static-ci-only is harvested too (the other honest terminal outcome)", async () => {
    harvest({ summary: "CI green, nothing deployed.", outcome: "STATIC-CI-ONLY  " });
    await handleTicketDoneUnified(DONE);
    // Normalized on the way in, so the gate's comparison never depends on casing.
    expect(h.state.merges[0].fields.outcome).toBe("static-ci-only");
  });

  it("TEAM-4763 P1-A: a handoff outcome is harvested, not dropped", async () => {
    // The router-level half of the fix: report_completion has accepted
    // outcome:"handoff" (with a mandatory pr_url, DL-030) since TEAM-4740, but this
    // harvest admitted no such value — so the entry reached the ship gate with NO
    // outcome and the run closed on the static-ci-only terminal phase.
    harvest({ summary: "PR handed to the owning team.", outcome: "handoff", pr_url: "https://github.com/o/r/pull/7" });
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges[0].fields.outcome).toBe("handoff");
    expect(h.state.merges[0].fields.prUrl).toBe("https://github.com/o/r/pull/7");
    // Handed off, not merged — nothing here may invent a merge commit.
    expect(h.state.merges[0].fields.mergeCommit).toBeUndefined();
    expect(h.state.workflow.agentTasks[DONE].outcome).toBe("handoff");
  });

  it("an unrecognized outcome is DROPPED, not stored — the rest still harvests", async () => {
    // A garbage or future-schema outcome must not become a verdict the gate then
    // trusts; the
    // entry stays verdict-less, which the gate reads as "not shipped".
    harvest({ summary: "done-ish", outcome: "kinda-shipped", merge_commit: "9f1c2ab" });
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges[0].fields.outcome).toBeUndefined();
    expect(h.state.merges[0].fields.mergeCommit).toBe("9f1c2ab");
  });

  it("a non-string outcome is ignored", async () => {
    harvest({ summary: "done-ish", outcome: 200 });
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges[0].fields.outcome).toBeUndefined();
  });

  it("an oversized block_reason is clamped to 500 chars", async () => {
    // The store clamps too; clamping here keeps the in-memory entry identical to
    // the persisted one (and the reason ends up in a DDB expression value).
    harvest({ summary: "blocked", outcome: "deploy-blocked", block_reason: "y".repeat(2000) });
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges[0].fields.blockReason).toHaveLength(500);
  });

  it("verdict signals already on the entry are never overwritten", async () => {
    // A ship signal is present, but no deliverable evidence → the harvest still
    // runs (for output/branch) and must leave the existing verdict alone: the
    // agent's own later report wins over a stale completion record.
    h.state.workflow = makeWorkflow({ mergeCommit: "already11", outcome: "shipped", blockReason: "prior reason" });
    harvest({ summary: "s", merge_commit: "different22", outcome: "deploy-blocked", block_reason: "new reason" });
    await handleTicketDoneUnified(DONE);
    const fields = h.state.merges[0].fields;
    expect(fields.output).toBe("s"); // the missing half IS filled
    expect(fields.mergeCommit).toBeUndefined();
    expect(fields.outcome).toBeUndefined();
    expect(fields.blockReason).toBeUndefined();
    expect(h.state.workflow.agentTasks[DONE].mergeCommit).toBe("already11");
  });

  it("a legacy record with none of the D2 keys harvests exactly as before (AC-D2.5)", async () => {
    harvest({ summary: "Implemented the feature and pushed the branch.", branch: "feature/x", commit_sha: "abc123", pr_url: "https://github.com/o/r/pull/7" });
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges[0].fields).toEqual({
      output: "Implemented the feature and pushed the branch.",
      branch: "feature/x",
      commitSha: "abc123",
      prUrl: "https://github.com/o/r/pull/7",
    });
  });
});

/**
 * TEAM-3976 — late re-harvest on an evidence-less "complete" entry.
 *
 * mark_done landed BEFORE report_completion: the done cascade ran, found no
 * completions record, and left agentTasks[tid] = {status:"complete"} with no
 * output. The dedup guard in handleTicketDoneUnified used to return before any
 * harvest, so a later done signal for that ticket could never pick the record
 * up. Now the guard re-harvests (fill-only-if-missing) when the complete entry
 * is evidence-less — and STILL skips the cascade (no second markTaskComplete).
 */
describe("late re-harvest on an evidence-less complete entry (TEAM-3976)", () => {
  const completionReads = () => h.state.s3Gets.filter((k) => k.startsWith("completions/"));

  it("entry already complete but evidence-less + record present → harvests; no second markTaskComplete, cascade skipped", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // The store mock's vi.fn instances persist across load() calls, so pin the
    // call count around this invocation rather than asserting "never called".
    const store = await import("./workflow-store.mjs");
    const completeCallsBefore = store.completeTaskEntry.mock.calls.length;
    h.state.workflow = makeWorkflow({ status: "complete", completedAt: "2020-01-01T00:05:00Z" });
    h.state.s3Objects[COMPLETION_KEY] = RECORD;
    await handleTicketDoneUnified(DONE);
    expect(store.completeTaskEntry.mock.calls.length).toBe(completeCallsBefore); // no second markTaskComplete
    expect(log.mock.calls.some((c) => String(c[0]).includes("already marked complete — skipping duplicate cascade"))).toBe(true);
    expect(completionReads()).toEqual([COMPLETION_KEY]);
    expect(h.state.merges).toEqual([{
      wfId: "wf_1",
      tid: DONE,
      fields: {
        output: "Implemented the feature and pushed the branch.",
        branch: "feature/x",
        commitSha: "abc123",
        prUrl: "https://github.com/o/r/pull/7",
      },
    }]);
    expect(h.state.workflow.agentTasks[DONE].output).toBe("Implemented the feature and pushed the branch.");
    expect(h.state.workflow.agentTasks[DONE].status).toBe("complete");
    log.mockRestore();
  });

  it("entry already complete but evidence-less + NO record → no merge, no throw, cascade still skipped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = await import("./workflow-store.mjs");
    const completeCallsBefore = store.completeTaskEntry.mock.calls.length;
    h.state.workflow = makeWorkflow({ status: "complete" });
    await handleTicketDoneUnified(DONE);
    expect(store.completeTaskEntry.mock.calls.length).toBe(completeCallsBefore);
    expect(h.state.merges).toHaveLength(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("evidence harvest skipped"))).toBe(true);
    warn.mockRestore();
  });

  it("entry already complete WITH output and a merge commit → no S3 read, no merge (existing fields never overwritten)", async () => {
    h.state.workflow = makeWorkflow({ status: "complete", output: "already there", mergeCommit: "9f1c2ab" });
    h.state.s3Objects[COMPLETION_KEY] = RECORD;
    await handleTicketDoneUnified(DONE);
    expect(completionReads()).toEqual([]);
    expect(h.state.merges).toHaveLength(0);
    expect(h.state.workflow.agentTasks[DONE].output).toBe("already there");
    expect(h.state.workflow.agentTasks[DONE].mergeCommit).toBe("9f1c2ab");
  });

  it("entry already complete WITH output (evidence present) → the guard does not re-harvest", async () => {
    // The guard's predicate is the harvest's own hasEvidence: output alone is
    // enough to skip. (Ship-signal top-up on a complete entry is the D2 harvest's
    // job on the ORIGINAL done cascade, not this late path.)
    h.state.workflow = makeWorkflow({ status: "complete", output: "already there" });
    h.state.s3Objects[COMPLETION_KEY] = RECORD;
    await handleTicketDoneUnified(DONE);
    expect(completionReads()).toEqual([]);
    expect(h.state.merges).toHaveLength(0);
  });
});

// ─── TEAM-5890: the real store, behind the mock, in front of a tiny DynamoDB ──
//
// completeTaskEntry's contract is a CONDITIONAL write (stamp once, on
// running -> complete). An inert mock cannot show whether a replayed or
// stale-read completion moves the stamp, so these tests apply the real
// workflow-store write against `row`, which plays the live table.
import { recordedHeads, featureBranchLanding } from "./completion.mjs";

function miniDdb(row) {
  const resolve = (path, names) => path.split(".").map((seg) => names?.[seg] ?? seg);
  const get = (segs) => segs.reduce((o, k) => (o == null ? undefined : o[k]), row);
  const set = (segs, v) => { let o = row; for (const k of segs.slice(0, -1)) o = (o[k] ??= {}); o[segs.at(-1)] = v; };
  const ccfe = () => { const e = new Error("ccfe"); e.name = "ConditionalCheckFailedException"; throw e; };
  return {
    async send(cmd) {
      const { UpdateExpression: ue, ConditionExpression: ce, ExpressionAttributeNames: n, ExpressionAttributeValues: v } = cmd.input;
      if (!ue) return {};
      if (ce) {
        // Reduce the condition to a boolean expression: attribute_[not_]exists(P)
        // and `P <> :v` become literals, then only AND/OR/parens remain.
        const bool = ce
          .replace(/attribute_(not_)?exists\(([^)]+)\)/g, (_, not, p) => String((get(resolve(p, n)) !== undefined) !== Boolean(not)))
          .replace(/([\w.#]+)\s*<>\s*(:\w+)/g, (_, p, ph) => String(get(resolve(p, n)) !== v[ph]))
          .replace(/\bAND\b/g, "&&").replace(/\bOR\b/g, "||");
        if (!/^[\s()truefals&|]+$/.test(bool)) throw new Error(`miniDdb: unsupported condition ${ce}`);
        if (!new Function(`return (${bool});`)()) ccfe();
      }
      for (const [, lhs, rhs] of ue.replace(/^\s*SET\s+/i, "").matchAll(/([\w.#]+)\s*=\s*(if_not_exists\([^)]*\)|:\w+)/g)) {
        const ine = /^if_not_exists\(([^,]+),\s*(:\w+)\)$/.exec(rhs);
        if (ine) { if (get(resolve(ine[1].trim(), n)) === undefined) set(resolve(lhs, n), v[ine[2]]); }
        else set(resolve(lhs, n), v[rhs]);
      }
      return {};
    },
  };
}

/** Route the mocked store's completeTaskEntry through the REAL one, writing into `row`. */
async function wireRealStore(row) {
  const mocked = await import("./workflow-store.mjs");
  const real = await vi.importActual("./workflow-store.mjs");
  real.initWorkflowStore(miniDdb(row), "workflows-test");
  mocked.completeTaskEntry.mockImplementation(real.completeTaskEntry);
  return row;
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const T1 = "2026-10-01T00:01:00.000Z", T2 = "2026-10-01T00:02:00.000Z", T3 = "2026-10-01T00:03:00.000Z";

/**
 * TEAM-5884 R3-1 / TEAM-5890 — the DDB-stream twin has no dedup guard, so a
 * replayed done reaches markTaskComplete again. It must NOT re-stamp
 * completedAt: it records when the task completed (TEAM-5707 compares it to
 * startedAt). TEAM-5913: the 404 proof no longer orders heads by it — it needs
 * every recorded head contained in the merged head — but the stamp stays honest. Since TEAM-5890 the rule is enforced by the STORE's
 * condition (stamp only on running -> complete) and mirrored in memory.
 */
describe("replayed done keeps the original completedAt (TEAM-5884 R3-1, TEAM-5890)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("DDB-stream path: an already-complete entry is re-marked with its ORIGINAL completedAt in the row AND in memory, commitSha untouched", async () => {
    const row = await wireRealStore({ agentTasks: { [DONE]: { id: "task_t1", agentId: DEV, ticketId: DONE, status: "complete", completedAt: T1, output: "done", commitSha: "head000" } } });
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(T3));
    h.state.workflow = { ...makeWorkflow(), agentTasks: clone(row.agentTasks) };
    await handleTicketDone(DONE, streamImage());
    expect(row.agentTasks[DONE]).toMatchObject({ status: "complete", completedAt: T1, commitSha: "head000" });
    expect(h.state.workflow.agentTasks[DONE].completedAt).toBe(T1);
    expect(h.state.workflow.agentTasks[DONE].commitSha).toBe("head000");
  });

  it("a GENUINELY running entry with no prior stamp (first completion) gets a fresh completedAt", async () => {
    const row = await wireRealStore({ agentTasks: { [DONE]: { id: "task_t1", agentId: DEV, ticketId: DONE, status: "running", startedAt: "2026-10-01T00:00:00.000Z" } } });
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(T1));
    h.state.workflow = { ...makeWorkflow(), agentTasks: clone(row.agentTasks) };
    await handleTicketDone(DONE, streamImage());
    expect(row.agentTasks[DONE]).toMatchObject({ status: "complete", completedAt: T1 });
    expect(h.state.workflow.agentTasks[DONE].completedAt).toBe(T1);
  });

  it("a re-claimed REWORK generation (running again, carrying completedAt T1 < startedAt) gets a NEW stamp >= startedAt — TEAM-5707 consistent, so never if_not_exists", async () => {
    const row = await wireRealStore({ agentTasks: { [DONE]: { id: "task_t1", agentId: DEV, ticketId: DONE, status: "running", startedAt: T2, completedAt: T1, commitSha: "head000" } } });
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(T3));
    h.state.workflow = { ...makeWorkflow(), agentTasks: clone(row.agentTasks) };
    await handleTicketDone(DONE, streamImage());
    expect(row.agentTasks[DONE].completedAt).toBe(T3);
    expect(h.state.workflow.agentTasks[DONE].completedAt).toBe(T3);
    expect(row.agentTasks[DONE].completedAt >= row.agentTasks[DONE].startedAt).toBe(true); // "completed in THIS generation" (index.mjs releaseClaimOnSelfPark)
  });
});

/**
 * TEAM-5890 — completedAt was latestRecordedHead's ordering key and stays
 * unrewritable (TEAM-5913 removed that ordering from the 404 proof). Two residuals left by TEAM-5884, end-to-end through the stream
 * done path (real markTaskComplete, real completeTaskEntry, row as the table):
 *   1. legacy backfill: a complete entry with NO stamp was re-stamped `now` on a
 *      replay, so the old merged head H sorted newest and the deleted-branch 404
 *      proof accepted H's old PR (merged:null -> merged:true);
 *   2. stale read: handler A read H as running while B completed it; A's late
 *      unconditional write moved H's stamp after F's.
 */
describe("TEAM-5890 — completedAt is never backfilled and never moved, and the 404 proof (every recorded head, TEAM-5913) is not steered to an old head", () => {
  const H = DONE;        // old head, merged PR #846
  const F = "TEAM-2";    // the branch advanced to F after H merged
  const HEAD_H = "old111abcdef0123456789abcdef0123456789ab";
  const mergedPr = { number: 846, merged_at: "2026-10-01T00:00:00Z", state: "closed", head: { sha: HEAD_H }, base: { ref: "main" }, merge_commit_sha: "m846", html_url: "https://github.com/o/r/pull/846" };
  // What featureBranchMergeProbe (index.mjs) hands featureBranchLanding after the branch was auto-deleted post-merge.
  const api = async (path) => {
    if (path.includes("/pulls?")) return [mergedPr];
    if (path.includes("/branches/")) throw Object.assign(new Error("GitHub GET branches 404: Branch not found"), { status: 404 });
    if (path.includes("/compare/fff0000bbbb...")) return { status: "diverged", ahead_by: 1, behind_by: 1 }; // F never landed in H
    throw new Error(`unexpected ${path}`);
  };
  const probe = (agentTasks) => featureBranchLanding({ owner: "o", repo: "r", base: "main", head: "feature/x", api, recordedHeads: recordedHeads(agentTasks) });

  function twoTicketRun(agentTasks) {
    h.state.tickets = {
      [H]: { ticketId: H, parentId: PARENT, workflowId: "wf_1", assignee: DEV, status: "done" },
      [F]: { ticketId: F, parentId: PARENT, workflowId: "wf_1", assignee: DEV, status: "done" },
    };
    h.state.children = [
      { ticketId: H, parentId: PARENT, status: "done", assignee: DEV, type: "task" },
      { ticketId: F, parentId: PARENT, status: "done", assignee: DEV, type: "task" },
      { ticketId: "TEAM-9", parentId: PARENT, status: "todo", assignee: DEV, blockedBy: [], type: "task" }, // keeps the run open
    ];
    return { agentTasks };
  }
  const snapshot = (row) => ({ ...makeWorkflow(), agentTasks: clone(row.agentTasks) });

  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("Residual 1 (legacy backfill): a replayed done on a complete entry with NO completedAt leaves it unstamped -> head stays unknown, 404 proof stays merged:null", async () => {
    const row = await wireRealStore(twoTicketRun({
      [H]: { id: "t1", agentId: DEV, ticketId: H, status: "complete", output: "done", commitSha: HEAD_H.slice(0, 12) }, // legacy: no completedAt
      [F]: { id: "t2", agentId: DEV, ticketId: F, status: "complete", output: "done", commitSha: "fff0000bbbb", completedAt: T1 },
    }));
    expect((await probe(row.agentTasks)).merged).toBe(null);

    vi.setSystemTime(new Date(T2));
    h.state.workflow = snapshot(row);
    await handleTicketDone(H, streamImage()); // the stream twin has no dedup guard

    expect(row.agentTasks[H].completedAt).toBeUndefined();
    expect(h.state.workflow.agentTasks[H].completedAt).toBeUndefined();
    expect(h.state.workflow.agentTasks[H].status).toBe("complete");
    const r = await probe(row.agentTasks);
    expect(r.merged).toBe(null); // base: merged:true — H's old PR accepted as the landing of a branch whose last head is unknown
    expect(r.reason).toMatch(/recorded head fff0000bbbb is not contained in merged PR #846/);
  });

  it("Residual 2 (concurrent stale read): A read H as running while B completed it; A's late write cannot move H after F", async () => {
    const row = await wireRealStore(twoTicketRun({
      [H]: { id: "t1", agentId: DEV, ticketId: H, status: "running", startedAt: "2026-10-01T00:00:00.000Z", commitSha: HEAD_H.slice(0, 12) },
      [F]: { id: "t2", agentId: DEV, ticketId: F, status: "running", startedAt: "2026-10-01T00:00:00.000Z", commitSha: "fff0000bbbb" },
    }));
    const staleSnapshotA = snapshot(row); // handler A's read: H still running

    vi.setSystemTime(new Date(T1));       // B completes H
    h.state.workflow = snapshot(row);
    await handleTicketDone(H, streamImage());
    expect(row.agentTasks[H].completedAt).toBe(T1);

    vi.setSystemTime(new Date(T2));       // F completes — the branch advanced past H
    h.state.workflow = snapshot(row);
    await handleTicketDone(F, streamImage());
    expect(row.agentTasks[H].completedAt < row.agentTasks[F].completedAt).toBe(true);

    vi.setSystemTime(new Date(T3));       // A's delayed duplicate lands with its stale snapshot
    h.state.workflow = staleSnapshotA;
    await handleTicketDone(H, streamImage());

    expect(row.agentTasks[H].completedAt).toBe(T1);
    expect(row.agentTasks[H].completedAt < row.agentTasks[F].completedAt).toBe(true);
    expect(staleSnapshotA.agentTasks[H].completedAt).not.toBe(T3); // memory mirrors the refused stamp (nothing to carry -> unstamped)
    expect(staleSnapshotA.agentTasks[H].status).toBe("complete");
    expect((await probe(row.agentTasks)).merged).toBe(null); // F is the last head, so H's PR is not the landing
  });
});

/**
 * TEAM-5900 — a re-claimed rework generation carries the previous generation's
 * output/commitSha forward (claimTicketInvocation spreads the prior entry). When
 * it completes again on a NEW head, the accepted running -> complete transition
 * (completeTaskEntry's `stamped`) must re-harvest THIS generation's record over
 * the old values; otherwise recordedHeads never sees the new head and the
 * deleted-branch 404 proof accepts the old merged PR as the landing.
 */
describe("TEAM-5900 — an accepted re-completion harvests the NEW head over the old one", () => {
  const HEAD_H = "old111abcdef0123456789abcdef0123456789ab"; // gen-1 head, merged in PR #846
  const HEAD_F = "fff0000bbbb";                               // gen-2 head, pushed after that merge
  const OLD_PR = "https://github.com/o/r/pull/846";
  const mergedPr = { number: 846, merged_at: "2026-10-01T00:00:00Z", state: "closed", head: { sha: HEAD_H }, base: { ref: "main" }, merge_commit_sha: "m846", html_url: OLD_PR };
  const api = async (path) => {
    if (path.includes("/pulls?")) return [mergedPr];
    if (path.includes("/branches/")) throw Object.assign(new Error("GitHub GET branches 404: Branch not found"), { status: 404 });
    if (path.includes(`/compare/${HEAD_F}...`)) return { status: "diverged", ahead_by: 1, behind_by: 1 }; // F never landed in H
    throw new Error(`unexpected ${path}`);
  };
  const genOne = (extra) => ({ id: "task_t1", agentId: DEV, ticketId: DONE, completedAt: T1, output: "gen-1 done", commitSha: HEAD_H, prUrl: OLD_PR, branch: "feature/x", ...extra });
  const rework = () => genOne({ status: "running", startedAt: T2 }); // re-claimed, still carrying gen-1's fields
  const record = (fields) => JSON.stringify({ ticket_id: DONE, summary: "gen-2 rework", branch: "feature/x", commit_sha: HEAD_F, pr_url: "https://github.com/o/r/pull/900", completed_at: "2026-10-01T00:02:30.000Z", ...fields });

  async function complete(entry, rec) {
    const row = await wireRealStore({ agentTasks: { [DONE]: entry } });
    const mocked = await import("./workflow-store.mjs");
    mocked.mergeTaskMetadata.mockImplementation((await vi.importActual("./workflow-store.mjs")).mergeTaskMetadata);
    h.state.s3Objects[COMPLETION_KEY] = rec;
    vi.setSystemTime(new Date(T3));
    h.state.workflow = { ...makeWorkflow(), agentTasks: clone(row.agentTasks) };
    await handleTicketDone(DONE, streamImage());
    return row;
  }

  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("rework re-completion records the new head: recordedHeads has it and the 404 proof stays merged:null", async () => {
    const row = await complete(rework(), record());
    expect(row.agentTasks[DONE]).toMatchObject({ status: "complete", completedAt: T3, commitSha: HEAD_F, output: "gen-2 rework" });
    expect(h.state.workflow.agentTasks[DONE].commitSha).toBe(HEAD_F);
    expect(recordedHeads(row.agentTasks)).toContain(HEAD_F);
    const r = await featureBranchLanding({ owner: "o", repo: "r", base: "main", head: "feature/x", api, recordedHeads: recordedHeads(row.agentTasks) });
    expect(r.merged).toBe(null); // main: merged:true via the old PR #846
    expect(r.reason).toMatch(/recorded head fff0000bbbb is not contained in merged PR #846/);
  });

  it("a replayed done (no transition) never overwrites, even with a newer record in S3", async () => {
    const row = await complete(genOne({ status: "complete" }), record());
    expect(row.agentTasks[DONE]).toMatchObject({ completedAt: T1, commitSha: HEAD_H, output: "gen-1 done", prUrl: OLD_PR });
    expect(h.state.workflow.agentTasks[DONE].commitSha).toBe(HEAD_H);
    expect(h.state.s3Gets).not.toContain(COMPLETION_KEY); // the evidence+ship-signal early return, byte-identical
  });

  it("a re-completion record missing a field keeps the entry's old value for it", async () => {
    const row = await complete(rework(), JSON.stringify({ ticket_id: DONE, summary: "gen-2 rework", commit_sha: HEAD_F, completed_at: "2026-10-01T00:02:30.000Z" }));
    expect(row.agentTasks[DONE]).toMatchObject({ commitSha: HEAD_F, output: "gen-2 rework", prUrl: OLD_PR, branch: "feature/x" });
  });

  it("a record older than this generation's startedAt (done before report_completion) is not taken over the entry", async () => {
    const row = await complete(rework(), record({ completed_at: T1 }));
    expect(row.agentTasks[DONE]).toMatchObject({ completedAt: T3, commitSha: HEAD_H, output: "gen-1 done", prUrl: OLD_PR });
  });
});
