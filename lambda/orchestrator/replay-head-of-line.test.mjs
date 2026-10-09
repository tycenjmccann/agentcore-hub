import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * TEAM-4740 FR-4 — head-of-line replay fixture.
 *
 * A real production run whose delivery work was lost because a decision that had to
 * be made was recorded in prose instead of being returned as a value, so nothing
 * downstream could act on it.
 *
 *   - p5ogpg : the release manager called Pipeline___start_deploy for the merge
 *              commit 9f6a9e0d while an OLDER execution (347b9bcb) had been parked
 *              on the human Approve_deploy action since 17:33Z. start_deploy
 *              cheerfully started a second execution, which queued invisibly
 *              behind that approval and was still queued when the run was closed
 *              GREEN. A ship-approval record was written for a deploy that never
 *              ran. The fix is a REFUSAL: nothing started, nothing recorded, and
 *              the blocker named in a shape an agent can branch on.
 *
 * The same run's OTHER failure — TEAM-4663, the fix ticket filed mid-run with no
 * base branch, whose PR went to the integration branch the merge then superseded —
 * is replayed where the code that owns it lives: through the real twins and the real
 * workflow-output in lambda/agentcore-hub-tickets/replay-base-branch-main.test.mjs
 * and lambda/agentcore-hub-jira/replay-base-branch-main.test.mjs.
 *
 * Placement note: this file lives in lambda/orchestrator/ with its sibling
 * replays, and costs the DL-009 surface guard NOTHING — check-orchestrator-
 * surface.sh derives its module list from `ls *.mjs | grep -v '\.test\.mjs$'`, so
 * *.test.mjs files are outside the module allow-list, the env scan and both LOC
 * budgets. It adds no orchestrator behaviour: p5ogpg is replayed through the
 * pipeline-tools Lambda, where the decision belongs. Nothing here imports the
 * orchestrator, and nothing here imports a ticket twin — the twins' own runners own
 * that half.
 *
 * MUST be listed in vitest.config.ts's include array. That list is explicit
 * per-file for lambda/**\/*.test.mjs, so a replay that is not added there silently
 * never runs, which is worse than not writing it.
 */

// The fixture's real identifiers, verbatim from the run.
const PIPELINE = "agentcore-hub-deploy";
const OUR_COMMIT = "9f6a9e0d1c3b4f5a8d7e2b1c0a9f8e7d6c5b4a39";
const PARKED_EXECUTION = "347b9bcb-6c02-4b0e-9b3e-1f2a4d5c6e70";
const PARKED_SOURCE_SHA = "1111111111111111111111111111111111111111";
const PARKED_SINCE = "2026-09-14T17:33:00Z";
const APPROVED_HEAD_SHA = "abcdef0123456789abcdef0123456789abcdef01";
// A token value that must never reach a response, a log line or a ticket.
const GATE_TOKEN = "approval-token-must-never-appear";

const h = vi.hoisted(() => ({
  state: {
    cpCalls: [],
    s3Puts: [],
    githubCalls: [],
    getPipelineStateImpl: async () => ({ stageStates: [] }),
    getPipelineExecutionImpl: async () => ({ pipelineExecution: { artifactRevisions: [] } }),
  },
}));

vi.mock("@aws-sdk/client-codepipeline", () => ({
  CodePipelineClient: class {
    async send(cmd) {
      h.state.cpCalls.push({ type: cmd.__type, input: cmd.input });
      if (cmd.__type === "GetPipelineState") return h.state.getPipelineStateImpl(cmd.input);
      if (cmd.__type === "GetPipelineExecution")
        return h.state.getPipelineExecutionImpl(cmd.input);
      if (cmd.__type === "StartPipelineExecution") return { pipelineExecutionId: "exec-new" };
      return {};
    }
  },
  GetPipelineStateCommand: class { constructor(i) { this.input = i; this.__type = "GetPipelineState"; } },
  GetPipelineExecutionCommand: class { constructor(i) { this.input = i; this.__type = "GetPipelineExecution"; } },
  StartPipelineExecutionCommand: class { constructor(i) { this.input = i; this.__type = "StartPipelineExecution"; } },
  ListActionExecutionsCommand: class { constructor(i) { this.input = i; this.__type = "ListActionExecutions"; } },
  ListPipelineExecutionsCommand: class { constructor(i) { this.input = i; this.__type = "ListPipelineExecutions"; } },
  StopPipelineExecutionCommand: class { constructor(i) { this.input = i; this.__type = "StopPipelineExecution"; } },
}));

vi.mock("@aws-sdk/client-codebuild", () => ({
  CodeBuildClient: class { async send() { return {}; } },
  ListBuildsForProjectCommand: class { constructor(i) { this.input = i; } },
  BatchGetBuildsCommand: class { constructor(i) { this.input = i; } },
  StartBuildCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      if (cmd.__type === "PutObject") {
        h.state.s3Puts.push(cmd.input);
        return {};
      }
      // No registry, no handoff marker, no rejection marker: every read is a miss,
      // so the env target is the only target and nothing short-circuits.
      const err = new Error("NotFound");
      err.name = "NotFound";
      err.$metadata = { httpStatusCode: 404 };
      throw err;
    }
  },
  GetObjectCommand: class { constructor(i) { this.input = i; this.__type = "GetObject"; } },
  PutObjectCommand: class { constructor(i) { this.input = i; this.__type = "PutObject"; } },
  HeadObjectCommand: class { constructor(i) { this.input = i; this.__type = "HeadObject"; } },
}));

vi.mock("@aws-sdk/client-cloudwatch-logs", () => ({
  CloudWatchLogsClient: class { async send() { return {}; } },
  GetLogEventsCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-sts", () => ({
  STSClient: class { async send() { return {}; } },
  AssumeRoleCommand: class { constructor(i) { this.input = i; } },
}));

process.env.PIPELINE_NAME = PIPELINE;
process.env.ARTIFACT_BUCKET = "hub-artifacts-replay";
process.env.PIPELINE_REPO = "tycenjmccann/agentcore-hub";
// No GITHUB_TOKEN: the fixture's call did not opt into abandon, and a replay must
// not be able to reach the network even if it did.
delete process.env.GITHUB_TOKEN;

const { handler } = await import("../agentcore-hub-pipeline-tools/index.mjs");

/** The run's pipeline state at the moment the release manager called start_deploy. */
function p5ogpgState() {
  return {
    stageStates: [
      {
        stageName: "Source",
        latestExecution: { status: "Succeeded", pipelineExecutionId: PARKED_EXECUTION },
        actionStates: [{ actionName: "GitHub_main", latestExecution: { status: "Succeeded" } }],
      },
      {
        stageName: "Build",
        latestExecution: { status: "Succeeded", pipelineExecutionId: PARKED_EXECUTION },
        actionStates: [{ actionName: "Build", latestExecution: { status: "Succeeded" } }],
      },
      {
        stageName: "Approve_deploy",
        latestExecution: { status: "InProgress", pipelineExecutionId: PARKED_EXECUTION },
        actionStates: [
          {
            actionName: "Approve_deploy",
            latestExecution: {
              status: "InProgress",
              token: GATE_TOKEN,
              lastStatusChange: PARKED_SINCE,
            },
          },
        ],
      },
    ],
  };
}

async function callTool(tool, args) {
  const res = await handler({ name: `Pipeline___${tool}`, arguments: args });
  return { raw: res.content[0].text, body: JSON.parse(res.content[0].text) };
}

const callsOfType = (type) => h.state.cpCalls.filter((c) => c.type === type);

beforeEach(() => {
  h.state.cpCalls = [];
  h.state.s3Puts = [];
  h.state.githubCalls = [];
  h.state.getPipelineStateImpl = async () => ({ stageStates: [] });
  h.state.getPipelineExecutionImpl = async () => ({
    pipelineExecution: { status: "InProgress", artifactRevisions: [{ revisionId: PARKED_SOURCE_SHA }] },
  });
});

describe("p5ogpg — start_deploy behind an older parked approval", () => {
  it("REFUSES, names the blocker, and starts nothing", async () => {
    h.state.getPipelineStateImpl = async () => p5ogpgState();

    const { body: response } = await callTool("start_deploy", {
      pipeline_name: PIPELINE,
      commit_sha: OUR_COMMIT,
      approved_head_sha: APPROVED_HEAD_SHA,
      pr_url: "https://github.com/tycenjmccann/agentcore-hub/pull/619",
      workflow_id: "p5ogpg",
      ticket_id: "TEAM-4663",
    });

    // The four assertions that make the historical failure impossible.
    expect(response.ok).toBe(false);
    expect(response.reason).toBe("approval_stage_occupied");
    expect(response.blocker.executionId).toBe(PARKED_EXECUTION);
    expect(response.blocker.pendingSince).toBe("2026-09-14T17:33:00.000Z");

    // Historically: a second execution was started and queued forever behind the
    // parked approval.
    expect(callsOfType("StartPipelineExecution")).toEqual([]);
    // Historically: a ship-approval record was written for a deploy that never ran,
    // which would have let the pipeline skip the human gate for a phantom run.
    expect(h.state.s3Puts).toEqual([]);
    // And nothing was stopped: this call did not ask to abandon anything.
    expect(callsOfType("StopPipelineExecution")).toEqual([]);
  });

  it("hands the agent a complete, actionable blocker — not prose", async () => {
    h.state.getPipelineStateImpl = async () => p5ogpgState();

    const { body: response } = await callTool("start_deploy", {
      commit_sha: OUR_COMMIT,
      abandon: "",
    });

    // Seven keys, every one present. A blueprint told to branch on `remedy` and
    // report `blocker.pendingSince` must never meet an undefined.
    expect(Object.keys(response.blocker).sort()).toEqual([
      "action",
      "executionId",
      "pendingSince",
      "pr",
      "sourceSha",
      "stage",
      "supersedable",
    ]);
    expect(response.blocker.stage).toBe("Approve_deploy");
    expect(response.blocker.action).toBe("Approve_deploy");
    expect(response.blocker.sourceSha).toBe(PARKED_SOURCE_SHA);
    // Nothing in front of us is superseded by anything, so waiting is the remedy —
    // and "abandon" is NOT offered, because no ancestry has been proven.
    expect(response.blocker.supersedable).toBe(false);
    expect(response.remedy).toBe("wait");
    expect(response.remedy).not.toBe("abandon");
  });

  it("never puts the human's approval token in the response", async () => {
    h.state.getPipelineStateImpl = async () => p5ogpgState();
    const { raw } = await callTool("start_deploy", { commit_sha: OUR_COMMIT });
    expect(raw).not.toContain(GATE_TOKEN);
  });

  it("get_state on the same run reports the same blocker, so the two agree", async () => {
    // The release manager polls get_state and calls start_deploy; if the two
    // disagreed about who holds the gate, an agent would loop between them.
    h.state.getPipelineStateImpl = async () => p5ogpgState();

    const { body: state } = await callTool("get_state", {
      pipeline_name: PIPELINE,
      execution_id: "9f6a9e0d-0000-4000-8000-000000000000",
    });

    expect(state.waitingOn.holdsGate).toBe("older");
    expect(state.blocker.executionId).toBe(PARKED_EXECUTION);
    expect(state.blocker.pendingSince).toBe("2026-09-14T17:33:00.000Z");
    expect(state.remedy).toBe("wait");
  });

  it("REGRESSION: an unoccupied gate still starts, exactly as before", async () => {
    // The whole fix must be invisible when nothing is in front of us — otherwise it
    // trades an invisible queue for a blocked ship.
    h.state.getPipelineStateImpl = async () => ({ stageStates: [] });

    const { body: response } = await callTool("start_deploy", {
      pipeline_name: PIPELINE,
      commit_sha: OUR_COMMIT,
    });

    expect(response.started).toBe(true);
    expect(response.ok).not.toBe(false);
    expect(response).not.toHaveProperty("blocker");
    expect(callsOfType("StartPipelineExecution")).toHaveLength(1);
  });

  it("REGRESSION: the caller's OWN pending approval is not a blocker", async () => {
    // The gate our own run is parked on is the normal ship path, not head-of-line
    // blocking. Refusing here would deadlock every deploy that needs an approval.
    const ours = "9f6a9e0d-0000-4000-8000-000000000000";
    h.state.getPipelineStateImpl = async () => {
      const state = p5ogpgState();
      for (const s of state.stageStates) {
        if (s.latestExecution) s.latestExecution.pipelineExecutionId = ours;
      }
      return state;
    };

    const { body: state } = await callTool("get_state", {
      pipeline_name: PIPELINE,
      execution_id: ours,
    });

    expect(state.waitingOn.holdsGate).toBe("this");
    expect(state.blocker).toBe(null);
    expect(state.remedy).toBe(null);
  });
});

// TEAM-4663's own replay is NOT here: it lives where the code it exercises does, in
// lambda/agentcore-hub-tickets/replay-base-branch-main.test.mjs (the real tickets
// twin + the real workflow-output) and lambda/agentcore-hub-jira/replay-base-branch-main.test.mjs.
