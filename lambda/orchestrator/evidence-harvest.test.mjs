import { describe, it, expect, beforeEach, vi } from "vitest";

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

  it("existing evidence wins — no S3 read, no merge", async () => {
    h.state.workflow = makeWorkflow({ output: "webhook merge landed first" });
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
