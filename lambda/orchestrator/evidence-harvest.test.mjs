import { describe, it, expect, beforeEach, vi } from "vitest";
// TEAM-4264 F5: the real writer, so the harvest test can prove it reads the
// SHAPE report_completion actually produces (a comma string), not a shape
// nobody ever writes. Same mocked S3/Lambda/DDB seams this file already sets up.
import { handler as workflowOutputHandler } from "../workflow-output/index.mjs";

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
    s3Puts: /** @type {any[]} */ ([]),
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
      // TEAM-4264 F5: record what workflow-output's report_completion actually
      // wrote, so a test can feed that real Body straight back into the harvest
      // rather than hand-typing the shape the writer produces.
      if (cmd.constructor.name === "PutObjectCommand") h.state.s3Puts.push(cmd.input);
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

function makeWorkflow(taskEntry, defId = "software-delivery") {
  return {
    id: "wf_1",
    workflowId: "wf_1",
    epicId: PARENT,
    workflowDefId: defId,
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
  h.state.s3Puts.length = 0;
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

  it("evidence, a ship signal AND a verdict signal already present — no S3 read, no merge", async () => {
    // All THREE halves satisfied is the only short-circuit left (TEAM-4246 D1 added
    // the third); it must still hold or every done ticket re-reads S3 on every
    // cascade forever.
    h.state.workflow = makeWorkflow({ output: "webhook merge landed first", mergeCommit: "9f1c2ab", testedHead: "9f1c2ab" });
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
 * TEAM-4246 D1 — the verdict / tested-head signals.
 *
 * `evaluateVerifiedHeads` compares one persona's tested head against another's,
 * and the ONLY writer of `agentTasks[tid].testedHead` / `.verdict` on the live
 * cascade is this harvest. Run dowtdh is the proof it was missing: three gate
 * personas completed (reviewer CHANGES NEEDED, QA FAIL, CI PASS at a third head)
 * and not one verdict or head reached any task entry, so every gate above read
 * an empty field and passed.
 *
 * Two rules, both pinned below: the fills are additive (a legacy record's merged
 * key set is byte-identical to pre-4246), and `verdict` is harvested
 * DECLARED-ONLY — the prose ladder stays live in the resolver, because a stored
 * inference would make `verdictSource: "declared"` a lie on the entry.
 */
describe("verdict/head harvest — verdict / tested_head / ci_head_sha (TEAM-4246 D1)", () => {
  const GATE_RECORD = {
    summary: "VERDICT: FAIL — QA must re-run at the fix's head.",
    commit_sha: "12e9ac6ef5081343701945e8a3b39803d9c53cc6",
    verdict: "FAIL",
    verdict_source: "declared",
    tested_head: "933ea6f1f04fc0212b88b84a6fcbe6aa0ce1d052",
    ci_head_sha: "12e9ac6ef5081343701945e8a3b39803d9c53cc6",
    ci_status: "failed",
    evidence_kind: "playwright",
    evidence_keys: ["qa/TEAM-1/report.json"],
  };

  it("harvests verdict, verdictSource, testedHead and the CI/evidence signals", async () => {
    harvest(GATE_RECORD);
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges).toHaveLength(1);
    expect(h.state.merges[0].fields).toEqual({
      output: "VERDICT: FAIL — QA must re-run at the fix's head.",
      commitSha: "12e9ac6ef5081343701945e8a3b39803d9c53cc6",
      verdict: "FAIL",
      verdictSource: "declared",
      // tested_head wins the precedence over ci_head_sha and commit_sha.
      testedHead: "933ea6f1f04fc0212b88b84a6fcbe6aa0ce1d052",
      ci_head_sha: "12e9ac6ef5081343701945e8a3b39803d9c53cc6",
      ci_status: "failed",
      evidence_kind: "playwright",
      evidence_keys: ["qa/TEAM-1/report.json"],
    });
    // The in-memory entry the same invoke's completion gate will read.
    expect(h.state.workflow.agentTasks[DONE].verdict).toBe("FAIL");
    expect(h.state.workflow.agentTasks[DONE].testedHead).toBe(
      "933ea6f1f04fc0212b88b84a6fcbe6aa0ce1d052"
    );
  });

  it("DDB-stream path harvests the same verdict/head", async () => {
    harvest(GATE_RECORD);
    await handleTicketDone(DONE, streamImage());
    expect(h.state.merges[0].fields.verdict).toBe("FAIL");
    expect(h.state.merges[0].fields.testedHead).toBe("933ea6f1f04fc0212b88b84a6fcbe6aa0ce1d052");
  });

  it("the third early-return clause: an entry with evidence AND a commit still gets harvested", async () => {
    // THE regression this commit exists to prevent. Pre-4246 the early return was
    // `hasEvidence && hasShipSignal`, and a gate ticket satisfies both the moment
    // its summary lands — so the verdict and head were never read. dowtdh again.
    h.state.workflow = makeWorkflow({ output: "already summarized", commitSha: "12e9ac6ef50" });
    harvest(GATE_RECORD);
    await handleTicketDoneUnified(DONE);
    expect(h.state.s3Gets).toContain(COMPLETION_KEY);
    expect(h.state.merges[0].fields.verdict).toBe("FAIL");
    expect(h.state.merges[0].fields.testedHead).toBe("933ea6f1f04fc0212b88b84a6fcbe6aa0ce1d052");
    // The deliverable and the commit the entry already had are untouched.
    expect(h.state.merges[0].fields.output).toBeUndefined();
    expect(h.state.merges[0].fields.commitSha).toBeUndefined();
  });

  // One record per test: readCompletionRecord memoizes per invocation, so a second
  // harvest in the same test would re-serve the first record from that cache.
  it("falls back to ci_head_sha when there is no tested_head", async () => {
    harvest({ summary: "PASS", ci_head_sha: "12e9ac6ef5081343701945e8a3b39803d9c53cc6" });
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges[0].fields.testedHead).toBe("12e9ac6ef5081343701945e8a3b39803d9c53cc6");
  });

  it("falls back to commit_sha last", async () => {
    harvest({ summary: "PASS", commit_sha: "001259dab" });
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges[0].fields.testedHead).toBe("001259dab");
  });

  it("a non-SHA tested_head is dropped, not stored", async () => {
    // resolveTestedHead is structured-fields-only AND shape-checked; "HEAD" or a
    // branch name must never become a head the divergence gate then compares.
    harvest({ summary: "PASS", tested_head: "HEAD" });
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges[0].fields.testedHead).toBeUndefined();
  });

  it("verdict and testedHead already on the entry are never overwritten", async () => {
    h.state.workflow = makeWorkflow({ verdict: "PASS", verdictSource: "declared", testedHead: "aaaaaaa" });
    harvest(GATE_RECORD);
    await handleTicketDoneUnified(DONE);
    const fields = h.state.merges[0].fields;
    expect(fields.verdict).toBeUndefined();
    expect(fields.verdictSource).toBeUndefined();
    expect(fields.testedHead).toBeUndefined();
    expect(h.state.workflow.agentTasks[DONE].verdict).toBe("PASS");
    expect(h.state.workflow.agentTasks[DONE].testedHead).toBe("aaaaaaa");
  });

  it("a legacy record with none of the D1 keys merges the pre-4246 key set exactly", async () => {
    // Additive: the only key a legacy record can newly produce is testedHead, and
    // only when its commit_sha is SHA-shaped. RECORD's is "abc123" (6 chars), so
    // this merge is byte-identical to the pre-4246 one.
    h.state.s3Objects[COMPLETION_KEY] = RECORD;
    await handleTicketDoneUnified(DONE);
    expect(Object.keys(h.state.merges[0].fields).sort()).toEqual([
      "branch", "commitSha", "output", "prUrl",
    ]);
  });

  it("no verdict in the record → no verdict/verdictSource keys invented", async () => {
    // The prose says FAIL; the ladder is NOT applied here. resolveVerdictInfo does
    // that live, so `verdictSource: "declared"` on an entry always means declared.
    harvest({ summary: "VERDICT: FAIL — this is prose, not a field.", commit_sha: "001259dab" });
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges[0].fields.verdict).toBeUndefined();
    expect(h.state.merges[0].fields.verdictSource).toBeUndefined();
    // …but the head IS structural, so it is harvested.
    expect(h.state.merges[0].fields.testedHead).toBe("001259dab");
  });

  it("an empty evidence_keys array is not merged", async () => {
    harvest({ summary: "PASS", evidence_keys: [] });
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges[0].fields.evidence_keys).toBeUndefined();
  });
});

/**
 * TEAM-4247 D2 — the sweep yield.
 *
 * `verified_removable` is the number the orchestrator terminates a sweep on, and
 * this harvest is the only writer of `agentTasks[tid].verifiedRemovable`. Run
 * c2uqki is the proof it was missing: the sweeper verified 93 candidates, removed
 * none, wrote "OUTCOME: ZERO verified-dead removals" in prose, and the only thing
 * that could end the run was the model hand-skipping five downstream tickets.
 *
 * Every assertion here is really about ZERO. It is a legitimate harvested value,
 * it is "already present" for the purposes of the fill-if-absent rule, and it
 * satisfies the early-return clause — so all three tests are `Number.isInteger`,
 * never truthiness.
 */
describe("sweep-yield harvest — verified_removable / candidates (TEAM-4247 D2)", () => {
  const SWEEP = "dead-code-sweep";
  const completionReads = () => h.state.s3Gets.filter((k) => k.startsWith("completions/"));

  it("harvests a ZERO yield alongside the candidate count", async () => {
    h.state.workflow = makeWorkflow(undefined, SWEEP);
    harvest({
      summary: "Scanned 47 modules. OUTCOME: ZERO verified-dead removals of 93 candidates.",
      verified_removable: 0,
      candidates: 93,
    });
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges[0].fields.verifiedRemovable).toBe(0);
    expect(h.state.merges[0].fields.candidates).toBe(93);
    // The in-memory entry the same invoke's close hook will read.
    expect(h.state.workflow.agentTasks[DONE].verifiedRemovable).toBe(0);
  });

  it("harvests a productive yield the same way", async () => {
    h.state.workflow = makeWorkflow(undefined, SWEEP);
    harvest({ summary: "Removed 17 dead symbols.", verified_removable: 17, candidates: 93 });
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges[0].fields.verifiedRemovable).toBe(17);
  });

  it("DDB-stream path harvests the same yield", async () => {
    h.state.workflow = makeWorkflow(undefined, SWEEP);
    harvest({ summary: "no-op sweep", verified_removable: 0 });
    await handleTicketDone(DONE, streamImage());
    expect(h.state.merges[0].fields.verifiedRemovable).toBe(0);
  });

  it("the fourth early-return clause: a sweep entry with evidence, a commit AND a verdict still gets harvested", async () => {
    // The D1 regression, one gate later. A sweeper's ticket lands a summary, a
    // commit and (as a sweep gate) a head, so the first three clauses are already
    // satisfied and the harvest would return before ever reading the yield — on
    // exactly the ticket whose yield ends the run.
    h.state.workflow = makeWorkflow(
      { output: "already summarized", commitSha: "12e9ac6ef50", testedHead: "12e9ac6ef50" },
      SWEEP,
    );
    harvest({ summary: "no-op sweep", verified_removable: 0, candidates: 93 });
    await handleTicketDoneUnified(DONE);
    expect(completionReads()).toContain(COMPLETION_KEY);
    expect(h.state.merges[0].fields.verifiedRemovable).toBe(0);
    // Nothing the entry already had is touched.
    expect(h.state.merges[0].fields.output).toBeUndefined();
    expect(h.state.merges[0].fields.commitSha).toBeUndefined();
  });

  it("the clause is DEF-SCOPED: a software-delivery entry with all three prior signals still short-circuits", async () => {
    // The trap the scoping exists for. No other def's tickets will ever carry
    // verified_removable, so an unscoped clause would disable this early return
    // fleet-wide and add an S3 GET to every done ticket on every cascade.
    h.state.workflow = makeWorkflow({ output: "s", commitSha: "12e9ac6ef50", testedHead: "12e9ac6ef50" });
    harvest({ summary: "no-op sweep", verified_removable: 0 });
    await handleTicketDoneUnified(DONE);
    expect(completionReads()).toEqual([]);
    expect(h.state.merges).toHaveLength(0);
  });

  it("a stored ZERO satisfies the clause: no re-read on redelivery", async () => {
    // Number.isInteger, not truthiness. Reading a harvested 0 as "not harvested
    // yet" would re-GET the record on every redelivery of the one ticket that
    // matters most.
    h.state.workflow = makeWorkflow(
      { output: "s", commitSha: "12e9ac6ef50", testedHead: "12e9ac6ef50", verifiedRemovable: 0 },
      SWEEP,
    );
    harvest({ summary: "no-op sweep", verified_removable: 0 });
    await handleTicketDoneUnified(DONE);
    expect(completionReads()).toEqual([]);
    expect(h.state.merges).toHaveLength(0);
  });

  it("a stored ZERO is never overwritten by a later record", async () => {
    h.state.workflow = makeWorkflow({ verifiedRemovable: 0, candidates: 93 }, SWEEP);
    harvest({ summary: "s", verified_removable: 17, candidates: 5 });
    await handleTicketDoneUnified(DONE);
    const fields = h.state.merges[0].fields;
    expect(fields.verifiedRemovable).toBeUndefined();
    expect(fields.candidates).toBeUndefined();
    expect(h.state.workflow.agentTasks[DONE].verifiedRemovable).toBe(0);
  });

  it("a non-integer yield in the record is ignored (the Lambda drops it, this is the second line)", async () => {
    // workflow-output's COUNT_RE already refuses "none"/"1.5"/"-1", but a
    // hand-written or gateway-authored record can carry anything, and a coerced
    // count would either fake a no-op or fake a productive sweep.
    h.state.workflow = makeWorkflow(undefined, SWEEP);
    harvest({ summary: "s", verified_removable: "0", candidates: 1.5 });
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges[0].fields.verifiedRemovable).toBeUndefined();
    expect(h.state.merges[0].fields.candidates).toBeUndefined();
  });

  it("a legacy record with neither D2 key merges the pre-4247 key set exactly", async () => {
    h.state.workflow = makeWorkflow(undefined, SWEEP);
    h.state.s3Objects[COMPLETION_KEY] = RECORD;
    await handleTicketDoneUnified(DONE);
    expect(Object.keys(h.state.merges[0].fields).sort()).toEqual([
      "branch", "commitSha", "output", "prUrl",
    ]);
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
 * TEAM-4264 F5 — evidence_keys is written as a STRING, harvested only as an array.
 *
 * workflow-output's report_completion joins evidence_keys with commas (its schema
 * declares the field a plain string); the orchestrator's harvest accepted only
 * `Array.isArray(record.evidence_keys)`. The branch had never fired in production
 * — every real evidence_keys value silently vanished. Now it accepts both shapes
 * via live-reverify.mjs's splitCsv, the same parser hasLiveArtifact already trusts
 * for this exact field.
 */
describe("evidence_keys harvest accepts the writer's own shape (TEAM-4264 F5)", () => {
  /** Drive the REAL report_completion Lambda and hand its own S3 write to the harvest. */
  async function writeRealRecord(extra) {
    await workflowOutputHandler({
      tool_name: "WorkflowOutput___report_completion",
      arguments: { ticket_id: DONE, summary: "Ran the QA suite.", ...extra },
    });
    const put = h.state.s3Puts.find((p) => p.Key === COMPLETION_KEY);
    h.state.s3Objects[COMPLETION_KEY] = put.Body;
    return JSON.parse(put.Body);
  }

  it("a record produced by the REAL writer, given evidence_keys as a comma string, harvests as an array", async () => {
    const written = await writeRealRecord({ evidence_keys: "qa-evidence/a.png,qa-evidence/b.har" });
    expect(typeof written.evidence_keys).toBe("string"); // pins the writer's own shape
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges[0].fields.evidence_keys).toEqual(["qa-evidence/a.png", "qa-evidence/b.har"]);
  });

  it("array input is unchanged (the pre-existing shape still works)", async () => {
    harvest({ summary: "PASS", evidence_keys: ["qa/a.json", "qa/b.json"] });
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges[0].fields.evidence_keys).toEqual(["qa/a.json", "qa/b.json"]);
  });

  it('"a, ,b" → ["a","b"] — blanks between commas are dropped, not stored as empty keys', async () => {
    harvest({ summary: "PASS", evidence_keys: "a, ,b" });
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges[0].fields.evidence_keys).toEqual(["a", "b"]);
  });

  it("51 keys are capped at 50", async () => {
    const keys = Array.from({ length: 51 }, (_, i) => `qa/${i}.json`);
    harvest({ summary: "PASS", evidence_keys: keys.join(",") });
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges[0].fields.evidence_keys).toHaveLength(50);
    expect(h.state.merges[0].fields.evidence_keys).toEqual(keys.slice(0, 50));
  });

  it("a 600-char key is DROPPED, never truncated", async () => {
    const long = "qa/" + "x".repeat(600) + ".json";
    harvest({ summary: "PASS", evidence_keys: `qa/short.json,${long}` });
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges[0].fields.evidence_keys).toEqual(["qa/short.json"]);
  });

  it("duplicates collapse, first occurrence wins the order", async () => {
    harvest({ summary: "PASS", evidence_keys: "qa/a.json,qa/b.json,qa/a.json" });
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges[0].fields.evidence_keys).toEqual(["qa/a.json", "qa/b.json"]);
  });

  it("an existing entry.evidence_keys is never overwritten", async () => {
    h.state.workflow = makeWorkflow({ evidence_keys: ["already/there.json"] });
    harvest({ summary: "PASS", evidence_keys: "new/one.json" });
    await handleTicketDoneUnified(DONE);
    expect(h.state.merges[0].fields.evidence_keys).toBeUndefined();
    expect(h.state.workflow.agentTasks[DONE].evidence_keys).toEqual(["already/there.json"]);
  });
});
