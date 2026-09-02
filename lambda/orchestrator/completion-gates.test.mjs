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
 * TEAM-3747 D2: completeWorkflow ALSO runs the ship/CD merge-verdict gate ("no
 * green close over unshipped work"). When the def has a ship phase and a done ship
 * ticket carries no merge/deploy verdict, the run must NOT claim "complete" — it
 * diverts to closeWorkflowBlocked, which atomically claims the honest terminal
 * outcome (deploy-blocked / static-ci-only) and emits a TERMINAL verdict event.
 * Same COMPLETION_EVIDENCE_REQUIRED flag (fail-closed; only off|false|0 shadow-logs).
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
    // TEAM-3747 D2: the honest-terminal-close seam. Every claimTerminalOutcome
    // call is recorded; terminalClaimWins=false simulates losing the CAS to a
    // concurrent close (the idempotency case).
    terminalClaims: /** @type {any[]} */ ([]),
    terminalClaimWins: true,
    ebEvents: /** @type {any[]} */ ([]),
    // S3 config the roster/def loaders read on the FIRST handler() invocation —
    // the only way to get a def whose completionRequiresAgentPhases has "ship".
    s3AgentsConfig: {
      agents: [
        { agentId: "agentcore_hub_backend_dev", phase: "development" },
        { agentId: "agentcore_hub_qa_verifier", phase: "verification" },
        { agentId: "agentcore_hub_ci_agent", phase: "review" },
        { agentId: "agentcore_hub_release_manager", phase: "ship" },
      ],
    },
    s3WorkflowsConfig: {
      workflows: [
        {
          id: "software-delivery",
          intakeAgentId: "agentcore_hub_requirements_analyst",
          featureBranchPhase: "development",
          createsPullRequest: false, // the release manager owns the PR on a ship def
          completionRequiresAgentPhases: ["development", "verification", "review", "ship"],
          reviewGates: [],
          phases: [
            { agentPhase: "development" },
            { agentPhase: "verification" },
            { agentPhase: "review" },
            { agentPhase: "ship" },
          ],
        },
      ],
    },
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
// S3 serves ONLY the two config objects, and only for the tests that prime the
// roster/def cache through handler() (see loadWithShipDef). The tests that call
// load() alone never touch S3 — index.mjs reads config lazily — so they keep the
// hardcoded fallback roster + fallback def (which declares NO ship phase).
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      const key = cmd?.input?.Key;
      const body = key === "config/agents.json" ? h.state.s3AgentsConfig
        : key === "config/workflows.json" ? h.state.s3WorkflowsConfig
        : null;
      if (!body) throw new Error("NoSuchKey");
      return { Body: { transformToString: async () => JSON.stringify(body) } };
    }
  },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; } },
  // index.mjs imports this one too; a factory that omits it links fine under
  // vitest but not under a strict ESM runner, so keep the surface complete.
  ListObjectsV2Command: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send(cmd) { h.state.ebEvents.push(cmd.input); return {}; } },
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
  // TEAM-3747 D2 — closeWorkflowBlocked's atomic terminal claim. Without this the
  // ship gate would throw into its own catch and complete anyway, so its presence
  // here is load-bearing for the divert tests below.
  claimTerminalOutcome: vi.fn(async (id, outcome, ts, reason) => {
    h.state.terminalClaims.push({ id, outcome, ts, reason: reason ?? null });
    return h.state.terminalClaimWins;
  }),
  mergeTaskMetadata: vi.fn(async () => {}),
}));

// Set before importing index.mjs: the roster/def loaders early-return to the
// hardcoded fallbacks without a bucket, and the fallback def has no ship phase.
process.env.ARTIFACT_BUCKET = "test-bucket";

let isWorkflowComplete;
let completeWorkflow;
let handler;

async function load() {
  vi.resetModules();
  ({ isWorkflowComplete, completeWorkflow, handler } = await import("./index.mjs"));
}

/**
 * Load with a def whose completionRequiresAgentPhases INCLUDES "ship" (the shape
 * the real software-delivery pipeline has since the release manager joined it).
 * The roster/def caches are only filled by handler(), so we prime them with an
 * empty stream event — no records, no side effects — then drive completeWorkflow.
 */
async function loadWithShipDef() {
  await load();
  await handler({ Records: [] });
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
  h.state.terminalClaims.length = 0;
  h.state.terminalClaimWins = true;
  h.state.ebEvents.length = 0;
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
 * TEAM-3747 D2 — completeWorkflow's ship/CD merge-verdict gate.
 *
 * These use loadWithShipDef() so the resolved def requires the ship phase (the
 * fallback def used by the tests above does not, which is exactly the AC-D2.5
 * legacy case pinned at the bottom). The ship ticket T-4 is a done release-manager
 * ticket WITH deliverable evidence, so the F3 evidence gate always passes and the
 * only thing under test is the merge verdict.
 */
const SHIP_DONE = [
  ...DONE,
  { ticketId: "T-4", assignee: "agentcore_hub_release_manager", type: "task", status: "done" },
];

/** agentTasks with evidence on every done ticket; `ship` overrides T-4's entry. */
const shipTasks = (ship) => ({
  id: "wf_1",
  agentTasks: {
    "T-1": { ticketId: "T-1", output: "implemented" },
    "T-2": { ticketId: "T-2", output: "verified" },
    "T-3": { ticketId: "T-3", output: "ci green" },
    "T-4": { ticketId: "T-4", output: "release notes written", ...ship },
  },
});

const ebEventsOfType = (type) =>
  h.state.ebEvents
    .flatMap((i) => i.Entries || [])
    .filter((e) => e.DetailType === type)
    .map((e) => JSON.parse(e.Detail));

describe("completeWorkflow — ship/CD merge-verdict gate (TEAM-3747 D2)", () => {
  it("FR-D2.1: a ship ticket with a recorded deploy BLOCK diverts to the honest terminal close", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.snapshots = [SHIP_DONE];
    h.state.freshWorkflow = shipTasks({
      outcome: "deploy-blocked",
      blockReason: "preflight: required check cd/deploy is failing — refusing to merge",
    });
    await loadWithShipDef();
    const wf = { ...WF };
    await completeWorkflow(wf);

    // NEVER a green close…
    expect(h.state.storeCompletions.length).toBe(0);
    // …but not a silent stall either: exactly one atomic terminal claim, with the
    // block reason carried through to the record.
    expect(h.state.terminalClaims).toHaveLength(1);
    expect(h.state.terminalClaims[0].id).toBe("wf_1");
    expect(h.state.terminalClaims[0].outcome).toBe("deploy-blocked");
    expect(h.state.terminalClaims[0].reason).toContain("refusing to merge");
    expect(wf.phase).toBe("deploy-blocked");
    expect(wf.blockReason).toContain("refusing to merge");

    // A TERMINAL verdict event that also carries `outcome` for complete-shaped consumers.
    const events = ebEventsOfType("workflow.deploy_blocked");
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("deploy-blocked");
    expect(events[0].workflowId).toBe("wf_1");
    expect(events[0].reason).toContain("refusing to merge");
    expect(events[0].offenders).toEqual([{ ticketId: "T-4", phase: "ship", verdict: "deploy-blocked" }]);
    expect(ebEventsOfType("workflow.complete")).toHaveLength(0);
    // Side effects still finalize, so no retry re-closes the run.
    expect(h.state.finalized).toEqual(["wf_1"]);
    expect(error.mock.calls.some((c) => String(c[0]).includes("closed deploy-blocked (not shipped)"))).toBe(true);
    error.mockRestore();
  });

  it("AC-D2.4: a done ship ticket with evidence but NO merge verdict closes static-ci-only", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.snapshots = [SHIP_DONE];
    // Output + artifact are present (the F3 gate is satisfied) — but nothing merged.
    h.state.freshWorkflow = shipTasks({ artifactKey: "workflows/wf_1/shared/ship.md" });
    await loadWithShipDef();
    const wf = { ...WF };
    await completeWorkflow(wf);

    expect(h.state.storeCompletions.length).toBe(0);
    expect(h.state.terminalClaims).toHaveLength(1);
    expect(h.state.terminalClaims[0].outcome).toBe("static-ci-only");
    expect(h.state.terminalClaims[0].reason).toBeNull(); // no block was declared
    expect(wf.phase).toBe("static-ci-only");
    const events = ebEventsOfType("workflow.static_ci_only");
    expect(events).toHaveLength(1);
    expect(events[0].offenders).toEqual([{ ticketId: "T-4", phase: "ship", verdict: "none" }]);
    expect(ebEventsOfType("workflow.complete")).toHaveLength(0);
    error.mockRestore();
  });

  it("a ship ticket WITH a merge commit completes normally — the gate only diverts phantoms", async () => {
    h.state.snapshots = [SHIP_DONE];
    h.state.freshWorkflow = shipTasks({ mergeCommit: "9f1c2ab", prUrl: "https://github.com/o/r/pull/7" });
    await loadWithShipDef();
    const wf = { ...WF };
    await completeWorkflow(wf);

    expect(h.state.terminalClaims).toHaveLength(0);
    expect(h.state.storeCompletions.length).toBe(1);
    expect(wf.phase).toBe("complete");
    expect(ebEventsOfType("workflow.complete")).toHaveLength(1);
    expect(h.state.finalized).toEqual(["wf_1"]);
  });

  it("fail-closed: an unrecognized flag value (\"banana\") still diverts", async () => {
    process.env.COMPLETION_EVIDENCE_REQUIRED = "banana";
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.snapshots = [SHIP_DONE];
    h.state.freshWorkflow = shipTasks({});
    await loadWithShipDef();
    await completeWorkflow({ ...WF });
    expect(h.state.storeCompletions.length).toBe(0);
    expect(h.state.terminalClaims).toHaveLength(1);
    error.mockRestore();
  });

  it("explicit opt-out (=off): shadow-logs the would-be outcome and completes anyway", async () => {
    process.env.COMPLETION_EVIDENCE_REQUIRED = "off";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.state.snapshots = [SHIP_DONE];
    h.state.freshWorkflow = shipTasks({});
    await loadWithShipDef();
    await completeWorkflow({ ...WF });

    expect(h.state.terminalClaims).toHaveLength(0); // nothing closed as blocked
    expect(h.state.storeCompletions.length).toBe(1); // fail-open ONLY when explicitly off
    const shadow = warn.mock.calls.find((c) => String(c[0]).includes("would close as static-ci-only (shadow opt-out)"));
    expect(shadow).toBeTruthy();
    expect(String(shadow[0])).toContain("T-4@ship:none");
    warn.mockRestore();
  });

  it("idempotent: a duplicate close whose CAS is lost writes nothing and emits nothing", async () => {
    // The race: two cascades both reach the gate. The first won the terminal claim;
    // this one loses it, so it must publish no second verdict event and not finalize.
    h.state.terminalClaimWins = false;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    h.state.snapshots = [SHIP_DONE];
    h.state.freshWorkflow = shipTasks({});
    await loadWithShipDef();
    const wf = { ...WF };
    await completeWorkflow(wf);

    expect(h.state.terminalClaims).toHaveLength(1); // attempted…
    expect(h.state.storeCompletions.length).toBe(0); // …never fell through to complete
    expect(ebEventsOfType("workflow.static_ci_only")).toHaveLength(0);
    expect(h.state.finalized).toHaveLength(0);
    expect(wf.phase).toBe("review"); // untouched — the winner owns the record
    expect(log.mock.calls.some((c) => String(c[0]).includes("already terminal — skipping duplicate"))).toBe(true);
    log.mockRestore();
  });

  it("a failure of the ship-verdict check itself never blocks completion (route parity)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.state.snapshots = [SHIP_DONE];
    h.state.getWorkflowThrows = true; // both gates' workflow re-read explodes
    await loadWithShipDef();
    await completeWorkflow({ ...WF });
    expect(h.state.storeCompletions.length).toBe(1);
    expect(h.state.terminalClaims).toHaveLength(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("ship-verdict check skipped"))).toBe(true);
    warn.mockRestore();
  });

  it("AC-D2.5: a legacy def with NO ship phase is untouched by the gate", async () => {
    // load() (not loadWithShipDef) → the fallback def: development/verification/
    // review only. An old-shape record with no ship fields anywhere must complete
    // exactly as it did before D2.
    h.state.snapshots = [DONE];
    h.state.freshWorkflow = {
      id: "wf_1",
      agentTasks: {
        "T-1": { ticketId: "T-1", output: "implemented" },
        "T-2": { ticketId: "T-2", output: "verified" },
        "T-3": { ticketId: "T-3", output: "ci green" },
      },
    };
    await load();
    const wf = { ...WF };
    await completeWorkflow(wf);
    expect(h.state.terminalClaims).toHaveLength(0);
    expect(h.state.storeCompletions.length).toBe(1);
    expect(wf.phase).toBe("complete");
    expect(h.state.finalized).toEqual(["wf_1"]);
  });
});
