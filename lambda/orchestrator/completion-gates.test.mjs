import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-3686 F3 + F4 — the orchestrator's completion gates.
 *
 * F3: completeWorkflow runs the deliverable-evidence check (same semantics as
 * the HTTP complete route) BEFORE the completion claim: flag off → shadow-log
 * the would-block outcome and proceed; flag on → abort with
 * CompletionRejectedMissingEvidence and never touch store.completeWorkflow.
 *
 * F4: isWorkflowComplete re-verifies a passing verdict after a bounded delay
 * when the trigger ticket's kind can spawn fix tickets (verification/review/
 * ship roster phases, or a human gate) — the children read goes through the
 * eventually-consistent parentId-index GSI, so a just-filed fix can be
 * invisible to the first snapshot. A flipped verdict defers completion
 * (CompletionRecheckFlipped); non-trigger kinds keep the single read.
 *
 * index.mjs is imported for real; only its I/O seams (AWS SDK, workflow-store)
 * are mocked — the same harness as review-rejection.test.mjs. Both functions
 * are exported solely for these tests.
 */

const h = vi.hoisted(() => ({
  state: {
    // Children returned by successive parentId-index queries: each query
    // consumes one snapshot; the last snapshot repeats once exhausted.
    snapshots: /** @type {any[][]} */ ([]),
    queries: 0,
    freshWorkflow: /** @type {any} */ (null),
    getWorkflowThrows: false,
    storeCompletions: /** @type {any[]} */ ([]),
    finalized: /** @type {any[]} */ ([]),
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
          if (name === "QueryCommand") {
            const i = Math.min(h.state.queries, h.state.snapshots.length - 1);
            h.state.queries += 1;
            return { Items: h.state.snapshots[i] || [] };
          }
          return {}; // Put (events) / Update / Get — irrelevant here
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => ({ LambdaClient: class {}, InvokeCommand: class { constructor(i) { this.input = i; } } }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {},
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; } },
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
  initWorkflowStore: vi.fn(() => {}), // called at index.mjs module load
  getWorkflow: vi.fn(async (id) => {
    if (h.state.getWorkflowThrows) throw new Error("workflow read exploded");
    return h.state.freshWorkflow?.id === id ? h.state.freshWorkflow : null;
  }),
  completeWorkflow: vi.fn(async (id, ts) => {
    h.state.storeCompletions.push({ id, ts });
    return true; // this caller wins the claim
  }),
  claimFinalization: vi.fn(async () => false),
  markFinalized: vi.fn(async (id) => { h.state.finalized.push(id); }),
}));

let isWorkflowComplete;
let completeWorkflow;

async function load() {
  vi.resetModules();
  ({ isWorkflowComplete, completeWorkflow } = await import("./index.mjs"));
}

// Fallback roster phases: backend_dev→development, qa_verifier→verification,
// ci_agent→review. Fallback software-delivery def requires exactly those three
// phases and declares no review gates.
const DONE = [
  { ticketId: "T-1", assignee: "agentcore_hub_backend_dev", type: "task", status: "done" },
  { ticketId: "T-2", assignee: "agentcore_hub_qa_verifier", type: "task", status: "done" },
  { ticketId: "T-3", assignee: "agentcore_hub_ci_agent", type: "task", status: "done" },
];
// The same run plus a just-filed open fix ticket routed under development.
const WITH_FIX = [
  ...DONE,
  {
    ticketId: "FIX-1",
    assignee: "agentcore_hub_backend_dev",
    type: "task",
    status: "todo",
    spawnedBy: { kind: "qa_fix", qaTicketId: "T-2" },
    phase: "development",
  },
];

const WF = { id: "wf_1", phase: "review", workflowDefId: "software-delivery", epicId: "EPIC-1", input: { title: "t" } };

beforeEach(() => {
  h.state.snapshots = [];
  h.state.queries = 0;
  h.state.freshWorkflow = null;
  h.state.getWorkflowThrows = false;
  h.state.storeCompletions.length = 0;
  h.state.finalized.length = 0;
  delete process.env.COMPLETION_EVIDENCE_REQUIRED;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.COMPLETION_EVIDENCE_REQUIRED;
});

describe("isWorkflowComplete — fix-spawn re-check (TEAM-3686 F4)", () => {
  it("defers completion when the re-read reveals a fix the first snapshot missed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.state.snapshots = [DONE, WITH_FIX];
    await load();
    vi.useFakeTimers();
    const p = isWorkflowComplete("EPIC-1", { ...WF }, "agentcore_hub_qa_verifier");
    await vi.runAllTimersAsync();
    expect(await p).toBe(false);
    expect(h.state.queries).toBe(2);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("CompletionRecheckFlipped"))).toBe(true);
    warn.mockRestore();
  });

  it("completes when the verdict holds on the second read", async () => {
    h.state.snapshots = [DONE, DONE];
    await load();
    vi.useFakeTimers();
    const p = isWorkflowComplete("EPIC-1", { ...WF }, "agentcore_hub_qa_verifier");
    await vi.runAllTimersAsync();
    expect(await p).toBe(true);
    expect(h.state.queries).toBe(2);
  });

  it("a human review gate as the trigger also re-checks", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.state.snapshots = [DONE, WITH_FIX];
    await load();
    vi.useFakeTimers();
    const p = isWorkflowComplete("EPIC-1", { ...WF }, "human:reviewer");
    await vi.runAllTimersAsync();
    expect(await p).toBe(false);
    expect(h.state.queries).toBe(2);
    warn.mockRestore();
  });

  it("a non-fix-spawning trigger (development agent) keeps the single read", async () => {
    // The second snapshot would flip the verdict — but a dev ticket's done
    // can't have just spawned a fix, so no re-read happens.
    h.state.snapshots = [DONE, WITH_FIX];
    await load();
    vi.useFakeTimers();
    const p = isWorkflowComplete("EPIC-1", { ...WF }, "agentcore_hub_backend_dev");
    await vi.runAllTimersAsync();
    expect(await p).toBe(true);
    expect(h.state.queries).toBe(1);
  });

  it("a failing first read short-circuits — no delay, no second read", async () => {
    h.state.snapshots = [WITH_FIX];
    await load();
    vi.useFakeTimers();
    const p = isWorkflowComplete("EPIC-1", { ...WF }, "agentcore_hub_qa_verifier");
    await vi.runAllTimersAsync();
    expect(await p).toBe(false);
    expect(h.state.queries).toBe(1);
  });
});

describe("completeWorkflow — evidence gate wiring (TEAM-3686 F3)", () => {
  it("flag OFF (default): shadow-logs the would-block outcome and completes anyway", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.state.snapshots = [DONE];
    h.state.freshWorkflow = { id: "wf_1", agentTasks: {} }; // no evidence anywhere
    await load();
    await completeWorkflow({ ...WF });
    expect(h.state.storeCompletions.length).toBe(1);
    expect(h.state.finalized).toEqual(["wf_1"]); // side effects ran to the end
    const shadow = warn.mock.calls.find((c) => String(c[0]).includes("would be blocked for missing evidence"));
    expect(shadow).toBeTruthy();
    expect(String(shadow[0])).toContain("T-1@development");
    warn.mockRestore();
  });

  it("flag ON: aborts BEFORE the completion claim and logs CompletionRejectedMissingEvidence", async () => {
    process.env.COMPLETION_EVIDENCE_REQUIRED = "true";
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.snapshots = [DONE];
    h.state.freshWorkflow = { id: "wf_1", agentTasks: {} };
    await load();
    await completeWorkflow({ ...WF });
    expect(h.state.storeCompletions.length).toBe(0);
    expect(h.state.finalized.length).toBe(0);
    const rejected = error.mock.calls.find((c) => String(c[0]).includes("CompletionRejectedMissingEvidence"));
    expect(rejected).toBeTruthy();
    expect(String(rejected[0])).toContain("T-1@development");
    error.mockRestore();
  });

  it("flag ON: completes when every done required-phase ticket has evidence", async () => {
    process.env.COMPLETION_EVIDENCE_REQUIRED = "on";
    h.state.snapshots = [DONE];
    h.state.freshWorkflow = {
      id: "wf_1",
      agentTasks: {
        "T-1": { ticketId: "T-1", output: "shipped the code" },
        "T-2": { ticketId: "T-2", output: "", artifactKey: "workflows/wf_1/qa.md" },
        "T-3": { ticketId: "T-3", output: "review notes" },
      },
    };
    await load();
    await completeWorkflow({ ...WF });
    expect(h.state.storeCompletions.length).toBe(1);
  });

  it("a failure of the check itself never blocks completion (route parity)", async () => {
    process.env.COMPLETION_EVIDENCE_REQUIRED = "true";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.state.snapshots = [DONE];
    h.state.getWorkflowThrows = true;
    await load();
    await completeWorkflow({ ...WF });
    expect(h.state.storeCompletions.length).toBe(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("evidence check skipped"))).toBe(true);
    warn.mockRestore();
  });
});
