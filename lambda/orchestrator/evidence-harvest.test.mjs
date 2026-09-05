import { describe, it, expect, beforeEach, vi } from "vitest";

// TEAM-3991 D1.2 — the GitHub-side synthesizer (pure module, safe to import
// statically here: evidence.mjs pulls in no AWS SDK and no mocked seam).
import { evidenceFromBranchProbe, probeTicketBranches, synthesizeCompletion } from "./evidence.mjs";

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
  completeTaskEntry: vi.fn(async () => {}),
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
 * TEAM-4099 F4 — real evidence supersedes SYNTHESIZED evidence on the row.
 *
 * A synthesized row carries both `output` and `commitSha`, so it used to satisfy
 * `hasEvidence && hasShipSignal` and short-circuit the harvest: the agent's own
 * report_completion, landing after the salvage guessed, was never promoted onto
 * the row and `evidenceSource` stayed "synthesized" forever. The synthesizer can
 * never clobber a real record (conditional S3 create + conditional row write), so
 * this is the other half of the same rule — real always wins.
 */
describe("real report_completion supersedes a synthesized row (TEAM-4099 F4)", () => {
  const SYNTH_ROW = {
    output: "[synthesized] 3 commit(s) on feature/x; PR none",
    branch: "feature/x",
    commitSha: "guessed0",
    evidenceSource: "synthesized",
    synthesizedAt: "2026-09-05T11:00:00Z",
  };

  it("a real record overwrites the synthesized output and re-stamps evidenceSource=agent", async () => {
    h.state.workflow = makeWorkflow(SYNTH_ROW);
    h.state.s3Objects[COMPLETION_KEY] = JSON.stringify({
      ticket_id: DONE, source: "agent", summary: "The agent's own summary.",
      branch: "feature/x", commit_sha: "abc123", pr_url: "https://github.com/o/r/pull/7",
    });
    await handleTicketDoneUnified(DONE);
    expect(h.state.s3Gets).toContain(COMPLETION_KEY); // NOT short-circuited any more
    expect(h.state.merges).toHaveLength(1);
    expect(h.state.merges[0].fields).toEqual({
      output: "The agent's own summary.",
      branch: "feature/x",
      commitSha: "abc123", // the agent's SHA beats the branch-head guess
      prUrl: "https://github.com/o/r/pull/7",
      evidenceSource: "agent",
    });
    expect(h.state.workflow.agentTasks[DONE].evidenceSource).toBe("agent");
  });

  it("a manager mark-done record promotes with its own provenance, not 'agent'", async () => {
    h.state.workflow = makeWorkflow(SYNTH_ROW);
    h.state.s3Objects[COMPLETION_KEY] = JSON.stringify({
      ticket_id: DONE, source: "manager", summary: "Closed by the manager.",
    });
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges[0].fields).toMatchObject({
      output: "Closed by the manager.",
      evidenceSource: "manager",
    });
  });

  it("a synthesized record over a synthesized row has nothing to promote — no output rewrite", async () => {
    h.state.workflow = makeWorkflow(SYNTH_ROW);
    h.state.s3Objects[COMPLETION_KEY] = JSON.stringify({
      ticket_id: DONE, source: "synthesized", summary: SYNTH_ROW.output, branch: "feature/x", commit_sha: "guessed0",
    });
    await handleTicketDoneUnified(DONE);
    // Only additive verdict signals may land; output/branch/evidenceSource untouched.
    for (const m of h.state.merges) {
      expect(m.fields.output).toBeUndefined();
      expect(m.fields.branch).toBeUndefined();
      expect(m.fields.evidenceSource).toBeUndefined();
    }
    expect(h.state.workflow.agentTasks[DONE].output).toBe(SYNTH_ROW.output);
  });

  it("a non-synthesized row is unaffected: existing output still wins over the record", async () => {
    h.state.workflow = makeWorkflow({ output: "webhook merge landed first", mergeCommit: "9f1c2ab" });
    h.state.s3Objects[COMPLETION_KEY] = RECORD;
    await handleTicketDoneUnified(DONE);
    expect(h.state.s3Gets).not.toContain(COMPLETION_KEY); // short-circuit preserved
    expect(h.state.merges).toHaveLength(0);
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

/**
 * TEAM-3991 D1.2 — synthesized completion evidence (evidence.mjs).
 *
 * The harvest above can only read a record the agent wrote. When the agent died
 * before report_completion there is no record at all, yet the work may be
 * provably on GitHub (TEAM-3790: branch 3 commits ahead of main with an open PR)
 * — the run then stranded on the evidence gate forever. evidence.mjs harvests
 * that proof from the GitHub API instead.
 *
 * Harness (b): pure module, injected fetch + store recorders. The mocks above
 * are irrelevant to these tests (nothing here loads index.mjs).
 */
function fakeGithub(routes, calls = []) {
  return async (path) => {
    calls.push(path);
    const hit = Object.entries(routes).find(([k]) => String(path).includes(k));
    if (!hit) { const e = new Error(`404 Not Found: ${path}`); e.status = 404; throw e; }
    const val = typeof hit[1] === "function" ? hit[1](path) : hit[1];
    if (val instanceof Error) throw val;
    return val;
  };
}

describe("evidenceFromBranchProbe", () => {
  const openPr = { number: 12, state: "open", merged_at: null, html_url: "https://github.com/o/r/pull/12", head: { sha: "aaa111", ref: "feature/TEAM-3790-backend-dev" } };
  const mergedPr = { number: 9, state: "closed", merged_at: "2026-09-01T09:00:00Z", html_url: "https://github.com/o/r/pull/9", head: { sha: "bbb222", ref: "feature/TEAM-3790-backend-dev" } };

  it("commits ahead + an open PR is evidence", () => {
    const ev = evidenceFromBranchProbe({
      branch: "feature/TEAM-3790-backend-dev",
      branchHead: { name: "feature/TEAM-3790-backend-dev", commit: { sha: "ccc333" } },
      compare: { ahead_by: 3, status: "ahead" },
      prs: [openPr],
    });
    expect(ev).toEqual({
      hasEvidence: true,
      branch: "feature/TEAM-3790-backend-dev",
      commitSha: "ccc333",
      prUrl: "https://github.com/o/r/pull/12",
      prNumber: 12,
      prState: "open",
      aheadBy: 3,
    });
  });

  it("commits ahead with no PR is still evidence", () => {
    const ev = evidenceFromBranchProbe({ branch: "b", branchHead: { commit: { sha: "ccc333" } }, compare: { ahead_by: 1 }, prs: [] });
    expect(ev.hasEvidence).toBe(true);
    expect(ev.prUrl).toBe("");
    expect(ev.prNumber).toBeNull();
  });

  it("a PR with no commits ahead (already merged) is evidence too", () => {
    const ev = evidenceFromBranchProbe({ branch: "b", branchHead: null, compare: { ahead_by: 0, status: "behind" }, prs: [mergedPr] });
    expect(ev.hasEvidence).toBe(true);
    expect(ev.prState).toBe("merged");
    expect(ev.commitSha).toBe("bbb222"); // falls back to the PR head sha
  });

  it("prefers a merged PR over an open one", () => {
    const ev = evidenceFromBranchProbe({ branch: "b", compare: { ahead_by: 2 }, prs: [openPr, mergedPr] });
    expect(ev.prNumber).toBe(9);
    expect(ev.prState).toBe("merged");
  });

  it("no commits and no PR is NOT evidence — nothing to fabricate from", () => {
    const ev = evidenceFromBranchProbe({ branch: "b", branchHead: { commit: { sha: "ccc333" } }, compare: { ahead_by: 0, status: "identical" }, prs: [] });
    expect(ev.hasEvidence).toBe(false);
    expect(ev.aheadBy).toBe(0);
  });

  it("an empty probe is not evidence", () => {
    expect(evidenceFromBranchProbe({}).hasEvidence).toBe(false);
    expect(evidenceFromBranchProbe().hasEvidence).toBe(false);
  });
});

describe("probeTicketBranches", () => {
  it("skips branches GitHub 404s and returns the first one with evidence", async () => {
    const calls = [];
    const gh = fakeGithub({
      "/branches/feature%2FTEAM-3790-backend-dev": { name: "feature/TEAM-3790-backend-dev", commit: { sha: "ccc333" } },
      "/compare/": { ahead_by: 3, status: "ahead" },
      "?head=": [{ number: 12, state: "open", merged_at: null, html_url: "u", head: { sha: "aaa111", ref: "x" } }],
    }, calls);
    const ev = await probeTicketBranches(gh, {
      owner: "o", repo: "r", base: "main",
      branches: ["feature/TEAM-3790-nope", "feature/TEAM-3790-backend-dev"],
    });
    expect(ev.hasEvidence).toBe(true);
    expect(ev.branch).toBe("feature/TEAM-3790-backend-dev");
    // The missing branch cost exactly one call — no compare/PR lookups for it.
    expect(calls.filter((p) => p.includes("nope"))).toHaveLength(1);
  });

  it("dedupes candidates and reports no evidence when every probe is empty", async () => {
    const calls = [];
    const gh = fakeGithub({ "/branches/": { commit: { sha: "c" } }, "/compare/": { ahead_by: 0, status: "identical" }, "&head=": [] }, calls);
    const ev = await probeTicketBranches(gh, { owner: "o", repo: "r", base: "main", branches: ["b", "b", "", null] });
    expect(ev).toEqual({ hasEvidence: false });
    expect(calls.filter((p) => p.includes("/branches/"))).toHaveLength(1);
  });

  it("a thrown compare/PR call is treated as absent, never as a throw", async () => {
    const gh = fakeGithub({
      "/branches/": { commit: { sha: "c" } },
      "/compare/": new Error("GitHub GET /compare 502"),
      "?head=": new Error("GitHub GET /pulls 502"),
    });
    await expect(probeTicketBranches(gh, { owner: "o", repo: "r", branches: ["b"] })).resolves.toEqual({ hasEvidence: false });
  });
});

describe("synthesizeCompletion", () => {
  const TID = "TEAM-3790";
  const AGENT = "agentcore_hub_backend_dev";
  const BRANCH = `feature/${TID}-backend-dev`;
  const NOW = Date.parse("2026-09-05T12:00:00Z");
  const KEY = `completions/${TID}.json`;

  const wf = (extra = {}) => ({
    id: "wf_3790",
    featureBranch: "feature/EPIC-3780-thing",
    repoConfig: { repos: [{ url: "https://github.com/o/r", defaultBranch: "main" }] },
    agentTasks: {},
    ...extra,
  });
  const tkt = (extra = {}) => ({ ticketId: TID, assignee: AGENT, status: "in_progress", ...extra });

  // The TEAM-3790 shape: branch 3 commits ahead of main + an open PR, no record.
  const liveRoutes = () => ({
    "state=all&base=main": [{ number: 42, state: "open", merged_at: null, html_url: "https://github.com/o/r/pull/42", head: { sha: "aaa111", ref: BRANCH } }],
    [`/branches/${encodeURIComponent(BRANCH)}`]: { name: BRANCH, commit: { sha: "ccc333" } },
    "/compare/": { ahead_by: 3, status: "ahead" },
    "?head=": [{ number: 42, state: "open", merged_at: null, html_url: "https://github.com/o/r/pull/42", head: { sha: "aaa111", ref: BRANCH } }],
  });

  // TEAM-4099 F4 — the store seam is now three CAS-shaped calls, and the S3 put is
  // a conditional create reporting { written }. `state` lets a test flip any of
  // them to the losing side without touching the rest of the harness.
  function harness(overrides = {}) {
    const writes = { claims: [], rows: [], puts: [], releases: [], transitions: [], events: [], order: [] };
    const state = {
      claimWins: overrides.claimWins !== false,
      putWritten: overrides.putWritten !== false,
      rowApplied: overrides.rowApplied !== false,
    };
    const deps = {
      githubFetch: overrides.gh || fakeGithub(liveRoutes()),
      s3Get: overrides.s3Get || (async () => { throw new Error("NoSuchKey"); }),
      s3PutIfAbsent: overrides.s3PutIfAbsent || (async (key, body) => {
        writes.puts.push({ key, body });
        writes.order.push("put");
        return { written: state.putWritten };
      }),
      store: {
        claimCompletionSynthesis: async (id, tid, opts) => {
          writes.claims.push({ id, tid, opts });
          writes.order.push("claim");
          return state.claimWins ? { won: true, claimedAt: opts?.now } : { won: false };
        },
        setSynthesizedEvidence: async (id, tid, fields, opts) => {
          writes.rows.push({ id, tid, fields, opts });
          writes.order.push("row");
          return { applied: state.rowApplied };
        },
        releaseCompletionSynthesisClaim: async (id, tid, claimedAt) => {
          writes.releases.push({ id, tid, claimedAt });
          writes.order.push("release");
          return true;
        },
      },
      transitionTicket: async (tid, status) => { writes.transitions.push({ tid, status }); writes.order.push("transition"); },
      publishEvent: async (tid, type, detail) => { writes.events.push({ tid, type, detail }); writes.order.push("event"); },
      now: () => NOW,
      log: { warn: () => {} },
    };
    return { writes, deps, state };
  }
  const NO_WRITES = { claims: [], rows: [], puts: [], releases: [], transitions: [], events: [], order: [] };

  it("TEAM-3790 shape: merges metadata, writes the record, transitions done, emits the event", async () => {
    const { writes, deps } = harness();
    const res = await synthesizeCompletion({
      workflow: wf(), ticket: tkt(), agentSlug: "backend-dev", deps,
    });

    expect(res).toMatchObject({ synthesized: true, branch: BRANCH, commitSha: "ccc333", prUrl: "https://github.com/o/r/pull/42", aheadBy: 3 });
    expect(res.summary).toBe(`[synthesized] 3 commit(s) on ${BRANCH}; PR https://github.com/o/r/pull/42`);

    // Claimed first, seeded with the assignee for the never-tracked case.
    expect(writes.claims).toHaveLength(1);
    expect(writes.claims[0]).toMatchObject({
      id: "wf_3790", tid: TID, opts: { now: new Date(NOW).toISOString(), seed: { agentId: AGENT } },
    });
    expect(writes.releases).toEqual([]); // evidence now exists — the claim stays

    expect(writes.rows).toHaveLength(1);
    expect(writes.rows[0]).toMatchObject({ id: "wf_3790", tid: TID, opts: { claimedAt: new Date(NOW).toISOString() } });
    expect(writes.rows[0].fields).toEqual({
      output: res.summary,
      branch: BRANCH,
      commitSha: "ccc333",
      prUrl: "https://github.com/o/r/pull/42",
      evidenceSource: "synthesized",
      synthesizedAt: new Date(NOW).toISOString(),
    });

    expect(writes.puts).toHaveLength(1);
    expect(writes.puts[0].key).toBe(KEY);
    expect(JSON.parse(writes.puts[0].body)).toEqual({
      ticket_id: TID,
      agent_id: AGENT,
      workflow_id: "wf_3790",
      source: "synthesized", // never mistakable for an agent's own report
      branch: BRANCH,
      commit_sha: "ccc333",
      pr_url: "https://github.com/o/r/pull/42",
      summary: res.summary,
      synthesized_at: new Date(NOW).toISOString(),
    });

    expect(writes.transitions).toEqual([{ tid: TID, status: "done" }]);
    expect(writes.events).toHaveLength(1);
    expect(writes.events[0].type).toBe("agent.completion_synthesized");
    expect(writes.events[0].detail).toMatchObject({ workflowId: "wf_3790", ticketId: TID, agentId: AGENT, branch: BRANCH, aheadBy: 3 });

    // The ordering F4 mandates: claim → durable record → row → provider done.
    expect(writes.order).toEqual(["claim", "put", "row", "transition", "event"]);
  });

  it("an already-done ticket is not re-transitioned (the rest still lands)", async () => {
    const { writes, deps } = harness();
    const res = await synthesizeCompletion({ workflow: wf(), ticket: tkt({ status: "done" }), agentSlug: "backend-dev", deps });
    expect(res.synthesized).toBe(true);
    expect(writes.transitions).toEqual([]);
    expect(writes.puts).toHaveLength(1);
  });

  it("an existing completion record wins — zero writes, not even the claim", async () => {
    const { writes, deps } = harness({ s3Get: async () => JSON.stringify({ ticket_id: TID, summary: "the agent spoke" }) });
    const res = await synthesizeCompletion({ workflow: wf(), ticket: tkt(), agentSlug: "backend-dev", deps });
    expect(res).toEqual({ synthesized: false, reason: "evidence_exists" });
    expect(writes).toEqual(NO_WRITES);
  });

  it("existing agentTasks output wins too — has_output, zero writes", async () => {
    const { writes, deps } = harness();
    const workflow = wf({ agentTasks: { [TID]: { output: "already reported" } } });
    const res = await synthesizeCompletion({ workflow, ticket: tkt(), agentSlug: "backend-dev", deps });
    expect(res).toEqual({ synthesized: false, reason: "has_output" });
    expect(writes).toEqual(NO_WRITES);
  });

  it("NO branch and NO PR → no_evidence, no record/row writes, and the claim is RELEASED", async () => {
    const { writes, deps } = harness({ gh: fakeGithub({ "state=all&base=main": [] }) });
    const res = await synthesizeCompletion({ workflow: wf({ featureBranch: "" }), ticket: tkt(), agentSlug: "backend-dev", deps });
    expect(res).toEqual({ synthesized: false, reason: "no_evidence" });
    expect(writes.puts).toEqual([]);
    expect(writes.rows).toEqual([]);
    expect(writes.transitions).toEqual([]);
    expect(writes.events).toEqual([]);
    // A sticky claim would block the salvage forever once the branch appears.
    expect(writes.releases).toEqual([{ id: "wf_3790", tid: TID, claimedAt: new Date(NOW).toISOString() }]);
  });

  it("a branch identical to base (no commits, no PR) is not evidence either", async () => {
    const gh = fakeGithub({
      "state=all&base=main": [],
      "/branches/": { commit: { sha: "ccc333" } },
      "/compare/": { ahead_by: 0, status: "identical" },
      "?head=": [],
    });
    const { writes, deps } = harness({ gh });
    const res = await synthesizeCompletion({ workflow: wf(), ticket: tkt(), agentSlug: "backend-dev", deps });
    expect(res).toEqual({ synthesized: false, reason: "no_evidence" });
    expect(writes.puts).toEqual([]);
  });

  it("no repo config → no_repo, no GitHub calls, no claim at all", async () => {
    const calls = [];
    const { writes, deps } = harness({ gh: fakeGithub(liveRoutes(), calls) });
    const res = await synthesizeCompletion({ workflow: wf({ repoConfig: null }), ticket: tkt(), deps });
    expect(res).toEqual({ synthesized: false, reason: "no_repo" });
    expect(calls).toEqual([]);
    expect(writes).toEqual(NO_WRITES);
  });

  it("discovers the per-ticket branch from an open PR when no agentSlug is known", async () => {
    const calls = [];
    const { writes, deps } = harness({ gh: fakeGithub(liveRoutes(), calls) });
    const res = await synthesizeCompletion({ workflow: wf(), ticket: tkt(), agentSlug: "", deps });
    expect(res.synthesized).toBe(true);
    expect(res.branch).toBe(BRANCH);
    expect(writes.rows[0].fields.branch).toBe(BRANCH);
  });

  it("a store failure is swallowed as reason=error, never thrown at the cascade", async () => {
    const { writes, deps } = harness();
    deps.store.setSynthesizedEvidence = async () => { throw new Error("DDB down"); };
    const res = await synthesizeCompletion({ workflow: wf(), ticket: tkt(), agentSlug: "backend-dev", deps });
    expect(res).toEqual({ synthesized: false, reason: "error" });
    // The record was already written, so the claim is NOT handed back — the next
    // trigger must not re-synthesize over a durable record.
    expect(writes.puts).toHaveLength(1);
    expect(writes.releases).toEqual([]);
  });

  it("a throw BEFORE the record write releases the claim (reason=error, retryable)", async () => {
    const { writes, deps } = harness({ s3PutIfAbsent: async () => { throw new Error("S3 500"); } });
    const res = await synthesizeCompletion({ workflow: wf(), ticket: tkt(), agentSlug: "backend-dev", deps });
    expect(res).toEqual({ synthesized: false, reason: "error" });
    expect(writes.rows).toEqual([]);
    expect(writes.releases).toHaveLength(1);
  });

  // ─── TEAM-4099 F4: synth must never clobber a real report_completion ─────────

  it("(a) the real record landing after the claim wins the S3 CAS → abort, ZERO row writes", async () => {
    // The agent's report_completion put the record while we were probing GitHub;
    // the conditional create comes back 412.
    const { writes, deps } = harness({ putWritten: false });
    const res = await synthesizeCompletion({ workflow: wf(), ticket: tkt(), agentSlug: "backend-dev", deps });
    expect(res).toEqual({ synthesized: false, reason: "record_exists" });
    expect(writes.puts).toHaveLength(1);          // attempted, refused by S3
    expect(writes.rows).toEqual([]);              // the real record is untouched
    expect(writes.transitions).toEqual([]);       // and no second done-cascade
    expect(writes.events).toEqual([]);
    expect(writes.releases).toEqual([]);          // real evidence exists — claim stays
  });

  it("(b) real evidence landing between the claim and the row write → no overwrite", async () => {
    const { writes, deps } = harness({ rowApplied: false });
    const res = await synthesizeCompletion({ workflow: wf(), ticket: tkt(), agentSlug: "backend-dev", deps });
    expect(res).toEqual({ synthesized: false, reason: "real_evidence_won" });
    expect(writes.rows).toHaveLength(1);          // attempted with the CAS condition
    expect(writes.rows[0].opts).toEqual({ claimedAt: new Date(NOW).toISOString() });
    expect(writes.transitions).toEqual([]);
    expect(writes.events).toEqual([]);
    expect(writes.releases).toEqual([]);
  });

  it("(c) two concurrent triggers: exactly ONE claim wins ⇒ one harvest, one put, one row, one cascade", async () => {
    // Shared fake store: the claim is a real first-writer-wins latch, so both
    // Promise.all branches race it exactly as two Lambda invocations would.
    const shared = { claimed: false, ghCalls: 0, puts: [], rows: [], transitions: [], events: [], releases: [] };
    const mkDeps = () => ({
      githubFetch: async (path) => { shared.ghCalls++; return await fakeGithub(liveRoutes())(path); },
      s3Get: async () => { throw new Error("NoSuchKey"); },
      s3PutIfAbsent: async (key, body) => {
        if (shared.puts.some((p) => p.key === key)) return { written: false };
        shared.puts.push({ key, body });
        return { written: true };
      },
      store: {
        claimCompletionSynthesis: async (id, tid, opts) => {
          if (shared.claimed) return { won: false };
          shared.claimed = true;
          return { won: true, claimedAt: opts?.now };
        },
        setSynthesizedEvidence: async (id, tid, fields, opts) => {
          shared.rows.push({ id, tid, fields, opts });
          return { applied: true };
        },
        releaseCompletionSynthesisClaim: async (id, tid, claimedAt) => {
          shared.releases.push({ id, tid, claimedAt });
          return true;
        },
      },
      transitionTicket: async (tid, status) => { shared.transitions.push({ tid, status }); },
      publishEvent: async (tid, type, detail) => { shared.events.push({ tid, type, detail }); },
      now: () => NOW,
      log: { warn: () => {} },
    });

    const call = () => synthesizeCompletion({ workflow: wf(), ticket: tkt(), agentSlug: "backend-dev", deps: mkDeps() });
    const [a, b] = await Promise.all([call(), call()]);

    const winners = [a, b].filter((r) => r.synthesized);
    const losers = [a, b].filter((r) => !r.synthesized);
    expect(winners).toHaveLength(1);
    expect(losers).toEqual([{ synthesized: false, reason: "claimed" }]);
    expect(shared.puts).toHaveLength(1);
    expect(shared.rows).toHaveLength(1);
    expect(shared.transitions).toEqual([{ tid: TID, status: "done" }]); // ONE cascade
    expect(shared.events).toHaveLength(1);
    expect(shared.releases).toEqual([]);
    // The loser did no GitHub work either — the claim precedes the harvest.
    expect(shared.ghCalls).toBeGreaterThan(0);
  });

  it("(d) the claim loser writes nothing and makes no GitHub calls", async () => {
    const calls = [];
    const { writes, deps } = harness({ claimWins: false, gh: fakeGithub(liveRoutes(), calls) });
    const res = await synthesizeCompletion({ workflow: wf(), ticket: tkt(), agentSlug: "backend-dev", deps });
    expect(res).toEqual({ synthesized: false, reason: "claimed" });
    expect(calls).toEqual([]);
    expect(writes.puts).toEqual([]);
    expect(writes.rows).toEqual([]);
    expect(writes.transitions).toEqual([]);
    expect(writes.events).toEqual([]);
    expect(writes.releases).toEqual([]);          // not ours to release
  });
});
