import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-3686 F3 + F4 — the orchestrator's completion gates.
 *
 * F3 / TEAM-3690: completeWorkflow runs the deliverable-evidence check (same
 * semantics as the HTTP complete route) BEFORE the completion claim. It now
 * ENFORCES by default (AC-D4.1): missing evidence → abort with
 * CompletionRejectedMissingEvidence, never touching store.completeWorkflow.
 * Unset/empty/unrecognized values all enforce (fail-closed). Only the explicit
 * opt-out COMPLETION_EVIDENCE_REQUIRED=off|false|0 shadow-logs and proceeds.
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
    workflowsConfig: /** @type {any} */ (null),
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
// S3 GetObject serves config/workflows.json so loadWorkflowDefs() can register a
// ship-phase def (the TEAM-3721 merge gate only engages when the def requires
// "ship"). h.state.workflowsConfig is the served body; null → not-found (throws,
// loadWorkflowDefs falls back — matching the evidence-gate tests that use the
// fallback software-delivery def with no ship phase).
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      const key = cmd?.input?.Key;
      if (key === "config/workflows.json") {
        if (!h.state.workflowsConfig) { const e = new Error("NoSuchKey"); e.name = "NoSuchKey"; throw e; }
        return { Body: { transformToString: async () => JSON.stringify(h.state.workflowsConfig) } };
      }
      return {};
    }
  },
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

let _mod;
async function load() {
  vi.resetModules();
  _mod = await import("./index.mjs");
  ({ isWorkflowComplete, completeWorkflow } = _mod);
  return _mod;
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
  h.state.workflowsConfig = null;
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
  it("AC-D4.1 (TEAM-3690): flag UNSET (default ON) aborts before the completion claim on missing evidence", async () => {
    // The regression F2 named: the DEFAULT/production config must REJECT an
    // empty completion record, not shadow-log it. Env var deleted in beforeEach
    // → the true default → enforce.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.snapshots = [DONE];
    h.state.freshWorkflow = { id: "wf_1", agentTasks: {} }; // no evidence anywhere
    await load();
    await completeWorkflow({ ...WF });
    expect(h.state.storeCompletions.length).toBe(0); // never claimed completion
    expect(h.state.finalized.length).toBe(0); // no side effects
    const rejected = error.mock.calls.find((c) => String(c[0]).includes("CompletionRejectedMissingEvidence"));
    expect(rejected).toBeTruthy();
    expect(String(rejected[0])).toContain("T-1@development");
    error.mockRestore();
  });

  it("fail-closed: an unrecognized value (\"banana\") also aborts on missing evidence", async () => {
    process.env.COMPLETION_EVIDENCE_REQUIRED = "banana";
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.snapshots = [DONE];
    h.state.freshWorkflow = { id: "wf_1", agentTasks: {} };
    await load();
    await completeWorkflow({ ...WF });
    expect(h.state.storeCompletions.length).toBe(0);
    expect(h.state.finalized.length).toBe(0);
    expect(error.mock.calls.some((c) => String(c[0]).includes("CompletionRejectedMissingEvidence"))).toBe(true);
    error.mockRestore();
  });

  it("explicit opt-out (=off): shadow-logs the would-block outcome and completes anyway", async () => {
    // Shadow mode is no longer the default (TEAM-3690); it requires an explicit
    // emergency opt-out (off|false|0). Here we assert off.
    process.env.COMPLETION_EVIDENCE_REQUIRED = "off";
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

/**
 * TEAM-3721 CD dead-zone: a ship-phase run must not finalize as "complete" when
 * its feature branch was never actually merged (RM's CD ticket can go done
 * without landing the merge). completeWorkflow verifies the branch against
 * GitHub before claiming completion. Fail-open on API errors / no PAT.
 *
 * A ship-def workflow requires the "ship" phase; the bug-fix def in workflows.json
 * declares completionRequiresAgentPhases including "ship". We give every required
 * phase real evidence so ONLY the merge gate can block, and drive GitHub via a
 * mocked global.fetch.
 */
describe("completeWorkflow — ship-phase merge gate (TEAM-3721)", () => {
  const SHIP_WF = {
    id: "wf_1",
    phase: "verification",
    workflowDefId: "bug-fix",
    epicId: "EPIC-1",
    input: { title: "t" },
    featureBranch: "feature/EPIC-1-fix",
    repoConfig: { layout: "multi-repo", repos: [{ platform: "backend", url: "https://github.com/o/r", defaultBranch: "main" }] },
  };
  // bug-fix requires development, verification, review, ship — one done agent
  // ticket per phase, each with evidence, plus the human Merge Approval gate done.
  const SHIP_CHILDREN = [
    { ticketId: "B-1", assignee: "agentcore_hub_bug_fixer", type: "task", status: "done", phase: "development" },
    { ticketId: "B-2", assignee: "agentcore_hub_qa_verifier", type: "task", status: "done", phase: "verification" },
    { ticketId: "B-3", assignee: "agentcore_hub_code_reviewer", type: "task", status: "done", phase: "review" },
    { ticketId: "B-4", assignee: "agentcore_hub_release_manager", type: "task", status: "done", phase: "ship" },
    { ticketId: "B-5", assignee: "human:engineer", type: "task", status: "done", phase: "ship" },
  ];
  const SHIP_TASKS = {
    "B-1": { ticketId: "B-1", output: "fixed" },
    "B-2": { ticketId: "B-2", output: "verified" },
    "B-3": { ticketId: "B-3", output: "reviewed" },
    "B-4": { ticketId: "B-4", output: "shipped", prUrl: "https://github.com/o/r/pull/9" },
    "B-5": { ticketId: "B-5", output: "approved" },
  };

  // A minimal workflows.json whose bug-fix def requires the ship phase, so
  // defHasShipPhase(bug-fix) is true after loadWorkflowDefs() reads it from the
  // (mocked) S3 config.
  const SHIP_CONFIG = {
    workflows: [
      {
        id: "bug-fix",
        intakeAgentId: "agentcore_hub_requirements_analyst",
        completionRequiresAgentPhases: ["development", "verification", "review", "ship"],
        reviewGates: [],
        phases: [
          { agentPhase: "requirements" },
          { agentPhase: "development" },
          { agentPhase: "verification", extraAgentPhases: ["review", "ship"] },
        ],
      },
    ],
  };

  // Seed the ship def, then let index.mjs read it via the mocked S3.
  async function loadShip() {
    h.state.workflowsConfig = SHIP_CONFIG;
    // loadWorkflowDefs early-returns unless ARTIFACT_BUCKET is set (read at
    // module load), so set it before importing index.mjs.
    process.env.ARTIFACT_BUCKET = "test-bucket";
    const mod = await load();
    await mod.loadWorkflowDefs();
  }

  let realFetch;
  beforeEach(() => {
    realFetch = global.fetch;
    process.env.GITHUB_PAT = "ghp_test";
    delete process.env.SHIP_MERGE_VERIFY;
  });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.GITHUB_PAT;
    delete process.env.SHIP_MERGE_VERIFY;
    delete process.env.ARTIFACT_BUCKET;
  });

  const mockGitHub = ({ prs = [], compareStatus = "ahead", aheadBy = 3 } = {}) => {
    global.fetch = vi.fn(async (url) => {
      const u = String(url);
      const body = u.includes("/pulls?")
        ? prs
        : u.includes("/compare/")
        ? { status: compareStatus, ahead_by: aheadBy }
        : {};
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    });
  };

  it("BLOCKS finalize when the branch is unmerged (no merged PR + compare ahead)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.snapshots = [SHIP_CHILDREN];
    h.state.freshWorkflow = { id: "wf_1", agentTasks: SHIP_TASKS };
    mockGitHub({ prs: [{ merged_at: null }], compareStatus: "ahead", aheadBy: 2 });
    await loadShip();
    await completeWorkflow({ ...SHIP_WF });
    expect(h.state.storeCompletions.length).toBe(0); // never claimed
    expect(h.state.finalized.length).toBe(0);
    expect(error.mock.calls.some((c) => String(c[0]).includes("CompletionRejectedUnmergedBranch"))).toBe(true);
    error.mockRestore();
  });

  it("completes when a PR from the branch is merged", async () => {
    h.state.snapshots = [SHIP_CHILDREN];
    h.state.freshWorkflow = { id: "wf_1", agentTasks: SHIP_TASKS };
    mockGitHub({ prs: [{ merged_at: "2026-09-02T10:00:00Z" }] });
    await loadShip();
    await completeWorkflow({ ...SHIP_WF });
    expect(h.state.storeCompletions.length).toBe(1);
  });

  it("completes when compare says base already contains the branch (squash-safe)", async () => {
    h.state.snapshots = [SHIP_CHILDREN];
    h.state.freshWorkflow = { id: "wf_1", agentTasks: SHIP_TASKS };
    mockGitHub({ prs: [], compareStatus: "identical" });
    await loadShip();
    await completeWorkflow({ ...SHIP_WF });
    expect(h.state.storeCompletions.length).toBe(1);
  });

  it("fail-open: a GitHub error never blocks a legitimate completion", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.state.snapshots = [SHIP_CHILDREN];
    h.state.freshWorkflow = { id: "wf_1", agentTasks: SHIP_TASKS };
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" }));
    await loadShip();
    await completeWorkflow({ ...SHIP_WF });
    expect(h.state.storeCompletions.length).toBe(1);
    warn.mockRestore();
  });

  it("opt-out SHIP_MERGE_VERIFY=off skips the check entirely", async () => {
    process.env.SHIP_MERGE_VERIFY = "off";
    h.state.snapshots = [SHIP_CHILDREN];
    h.state.freshWorkflow = { id: "wf_1", agentTasks: SHIP_TASKS };
    // fetch would say unmerged, but the gate is off so it must not even be called.
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify([{ merged_at: null }]) }));
    await loadShip();
    await completeWorkflow({ ...SHIP_WF });
    expect(h.state.storeCompletions.length).toBe(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
