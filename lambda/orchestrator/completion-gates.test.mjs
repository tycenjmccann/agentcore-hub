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
    // TEAM-3721 merge-gate suite: a per-test workflows.json override served in
    // PREFERENCE to s3WorkflowsConfig (loadShip seeds it; beforeEach resets null).
    workflowsConfig: /** @type {any} */ (null),
    s3Completions: /** @type {Record<string, any>} */ ({}), // completions/<ticket>.json records
    notifications: /** @type {any[]} */ ([]),
    // TEAM-3976: completions/{tid}.json records served by key (raw string —
    // s3Completions above holds objects), every GetObject key recorded (so the
    // happy path can assert ZERO record reads), and every store.mergeTaskMetadata
    // backfill captured. Mirrors evidence-harvest.test.mjs.
    s3Objects: /** @type {Record<string, string>} */ ({}),
    s3Gets: /** @type {string[]} */ ([]),
    merges: /** @type {any[]} */ ([]),
    // TEAM-3991 D1.4: cd-evidence listing (ListObjectsV2 Contents) + the ids of
    // runs whose epicRollupPending was cleared. epicTransitionThrows makes the
    // tickets-table Done write fail, which is how the roll-up failure path is
    // driven on the dynamodb provider.
    s3List: /** @type {any[]} */ ([]),
    rollupCleared: /** @type {string[]} */ ([]),
    epicTransitionThrows: false,
    ticketUpdates: /** @type {any[]} */ ([]),
    finalizationClaimWins: false,
    // TEAM-4099 F5: the roll-up retry LEASE. `rollupLeases` is the row attribute
    // (`epicRollupClaimedAt`) the conditional claim reads and writes; `rollupClaims`
    // records every attempt so the concurrency test can prove both callers tried.
    rollupLeases: /** @type {Record<string, string>} */ ({}),
    rollupClaims: /** @type {any[]} */ ([]),
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
          if (name === "UpdateCommand") {
            h.state.ticketUpdates.push(cmd.input);
            // The epic roll-up's dynamodb path is a scoped Done write on the
            // tickets table (transitionTicketToDone) — the only seam a test can
            // fail to exercise rollUpEpic's retry budget.
            if (h.state.epicTransitionThrows && cmd.input?.ExpressionAttributeValues?.[":s"] === "done") {
              throw new Error("ConditionalCheckFailed: epic write rejected");
            }
          }
          return {}; // Put (events) / Update / Get — irrelevant here
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => ({ LambdaClient: class {}, InvokeCommand: class { constructor(i) { this.input = i; } } }));
// S3 serves ONLY the two config objects, and only for the tests that prime the
// roster/def cache — through handler() (loadWithShipDef, TEAM-3747 D2 suite) or
// through loadWorkflowDefs() (loadShip, TEAM-3721 suite). The tests that call
// load() alone never touch S3 — index.mjs reads config lazily — so they keep the
// hardcoded fallback roster + fallback def (which declares NO ship phase).
// config/workflows.json prefers the TEAM-3721 per-test override
// (h.state.workflowsConfig) and falls back to the D2 suite's s3WorkflowsConfig.
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      // TEAM-3991 D1.4: the cd-evidence listing. Contents are per-test
      // (h.state.s3List); the file bodies come from s3Objects, keyed by S3 key.
      if (cmd.constructor.name === "ListObjectsV2Command") {
        return { Contents: h.state.s3List };
      }
      const key = cmd?.input?.Key;
      h.state.s3Gets.push(key);
      if (typeof key === "string" && key.includes("/cd-evidence/")) {
        const raw = h.state.s3Objects[key];
        if (raw === undefined) {
          const e = new Error("The specified key does not exist.");
          e.name = "NoSuchKey";
          throw e;
        }
        return { Body: { transformToString: async () => raw } };
      }
      if (typeof key === "string" && key.startsWith("completions/")) {
        // TEAM-3976: raw-string records (s3Objects) or object records
        // (s3Completions, TEAM-3985). Absent → the SDK's named NoSuchKey.
        const raw = h.state.s3Objects[key] !== undefined
          ? h.state.s3Objects[key]
          : h.state.s3Completions[key] !== undefined ? JSON.stringify(h.state.s3Completions[key]) : undefined;
        if (raw === undefined) {
          const e = new Error("The specified key does not exist.");
          e.name = "NoSuchKey";
          throw e;
        }
        return { Body: { transformToString: async () => raw } };
      }
      const body = key === "config/agents.json" ? h.state.s3AgentsConfig
        : key === "config/workflows.json" ? (h.state.workflowsConfig || h.state.s3WorkflowsConfig)
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
  // Default false: the completion path's own finalization claim is not what these
  // tests exercise. retryPendingEpicRollups (the D2.3 sweep entry point) flips it.
  claimFinalization: vi.fn(async () => h.state.finalizationClaimWins),
  markFinalized: vi.fn(async (id) => { h.state.finalized.push(id); }),
  // TEAM-3747 D2 — closeWorkflowBlocked's atomic terminal claim. Without this the
  // ship gate would throw into its own catch and complete anyway, so its presence
  // here is load-bearing for the divert tests below.
  claimTerminalOutcome: vi.fn(async (id, outcome, ts, reason) => {
    h.state.terminalClaims.push({ id, outcome, ts, reason: reason ?? null });
    return h.state.terminalClaimWins;
  }),
  // Apply the merge onto the fresh snapshot so a re-read after a harvest/stamp
  // sees it — exactly what the real store does (TEAM-3985/3976 tests rely on it).
  // Every call is also recorded (TEAM-3976 asserts WHICH fields were backfilled).
  mergeTaskMetadata: vi.fn(async (id, tid, fields) => {
    h.state.merges.push({ wfId: id, tid, fields });
    const tasks = h.state.freshWorkflow?.agentTasks;
    if (tasks) tasks[tid] = { ...(tasks[tid] || { ticketId: tid }), ...fields };
  }),
  appendNotification: vi.fn(async (id, n) => { h.state.notifications.push({ id, n }); }),
  // TEAM-3991 D1.4 — the epic roll-up obligation created atomically with the
  // terminal claim. finalizeWithEpicRollUp clears it on success and escalates
  // once (appendNotificationOnce, id-idempotent) on failure.
  clearEpicRollupPending: vi.fn(async (id) => {
    h.state.rollupCleared.push(id);
    delete h.state.rollupLeases[id]; // the lease goes with the discharged debt
  }),
  /**
   * TEAM-4099 F5 — the retry lease, mirroring claimEpicRollupRetry's conditional
   * write: the row must still owe the debt (not cleared), must not be finalized, and
   * any existing lease must have aged out. Check-and-set with no await in between,
   * so two concurrent callers genuinely race for one winner.
   */
  claimEpicRollupRetry: vi.fn(async (id, { now = new Date().toISOString(), leaseMs = 10 * 60 * 1000 } = {}) => {
    h.state.rollupClaims.push({ id, now, leaseMs });
    if (h.state.rollupCleared.includes(id) || h.state.finalized.includes(id)) return { won: false };
    const held = h.state.rollupLeases[id];
    if (held && Date.parse(now) - Date.parse(held) < leaseMs) return { won: false };
    h.state.rollupLeases[id] = now;
    return { won: true };
  }),
  appendNotificationOnce: vi.fn(async (id, n) => {
    if (h.state.notifications.some((x) => x.n?.id === n.id && !x.n?.acknowledged)) return false;
    h.state.notifications.push({ id, n });
    return true;
  }),
  // TEAM-4099 F1 — the ack has to be observable, because "acked" is now a THIRD
  // completion state (accepted bypass → honest blocked close), not just the
  // absence of a block. Applies to the fresh snapshot, like mergeTaskMetadata.
  ackNotifications: vi.fn(async (id, predicate) => {
    const wf = h.state.freshWorkflow?.id === id ? h.state.freshWorkflow : null;
    if (!wf || !Array.isArray(wf.humanNotifications)) return 0;
    let acked = 0;
    wf.humanNotifications = wf.humanNotifications.map((n) => {
      if (n.acknowledged || !predicate(n)) return n;
      acked++;
      return { ...n, acknowledged: true, acknowledgedAt: "2026-09-05T13:00:00Z" };
    });
    return acked;
  }),
}));

// Set before importing index.mjs: the roster/def loaders early-return to the
// hardcoded fallbacks without a bucket, and the fallback def has no ship phase.
process.env.ARTIFACT_BUCKET = "test-bucket";

let isWorkflowComplete;
let completeWorkflow;
let handler;

let _mod;
async function load() {
  vi.resetModules();
  _mod = await import("./index.mjs");
  ({ isWorkflowComplete, completeWorkflow, handler } = _mod);
  return _mod;
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
  h.state.workflowsConfig = null;
  h.state.s3Objects = {};
  h.state.s3Gets.length = 0;
  h.state.merges.length = 0;
  h.state.s3Completions = {};
  h.state.notifications.length = 0;
  h.state.s3List.length = 0;
  h.state.rollupCleared.length = 0;
  h.state.ticketUpdates.length = 0;
  h.state.epicTransitionThrows = false;
  h.state.finalizationClaimWins = false;
  h.state.rollupLeases = {};
  h.state.rollupClaims.length = 0;
  // No real sleeping in the roll-up retry budget.
  process.env.EPIC_ROLLUP_BACKOFF_MS = "0";
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
 * TEAM-3976 — completeWorkflow's completions-record fallback.
 *
 * The production failure: a dev ticket was mark_done'd (Workflow Manager) BEFORE
 * the agent's report_completion fired. The done cascade's one-shot harvest found
 * no completions/T.json and left agentTasks[T] = {status:"complete"} with no
 * output; the later report_completion wrote the record but its done→done
 * transition was a no-op, so no harvest re-ran and the gate refused forever.
 * Now the gate consults the record for the would-be offenders ONLY — the happy
 * path (every entry already carries evidence) must make ZERO completions/ reads.
 */
describe("completeWorkflow — completions-record fallback (TEAM-3976)", () => {
  const RECORD = {
    ticket_id: "T-1",
    summary: "Fixed it",
    pr_url: "https://github.com/x/y/pull/1",
    commit_sha: "abc",
    branch: "feature/x",
    artifacts: "shared/dev-evidence/T-1.md",
  };
  /** T-1 closed out-of-band: complete, but evidence-less. Siblings have output. */
  const tasksMissingT1 = () => ({
    id: "wf_1",
    agentTasks: {
      "T-1": { ticketId: "T-1", status: "complete", completedAt: "2026-09-01T00:00:00Z" },
      "T-2": { ticketId: "T-2", output: "verified" },
      "T-3": { ticketId: "T-3", output: "ci green" },
    },
  });
  const completionReads = () => h.state.s3Gets.filter((k) => String(k).startsWith("completions/"));

  it("record proves evidence → completes, backfills T-1 (deliverable fields only), no rejection", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.snapshots = [DONE];
    h.state.freshWorkflow = tasksMissingT1();
    h.state.s3Objects["completions/T-1.json"] = JSON.stringify(RECORD);
    await load();
    await completeWorkflow({ ...WF });
    expect(h.state.storeCompletions.length).toBe(1);
    expect(error.mock.calls.some((c) => String(c[0]).includes("CompletionRejectedMissingEvidence"))).toBe(false);
    // Exactly ONE record read: the TEAM-3985 re-harvest maps summary→output and
    // the re-evaluation clears `missing`, so the TEAM-3976 second pass never runs
    // (it would have been a second read of the same key).
    expect(completionReads()).toEqual(["completions/T-1.json"]);
    expect(h.state.notifications).toHaveLength(0);
    expect(h.state.merges).toHaveLength(1);
    expect(h.state.merges[0].wfId).toBe("wf_1");
    expect(h.state.merges[0].tid).toBe("T-1");
    expect(h.state.merges[0].fields).toEqual({
      output: "Fixed it",
      branch: "feature/x",
      commitSha: "abc",
      prUrl: "https://github.com/x/y/pull/1",
    });
    expect(h.state.merges[0].fields).not.toHaveProperty("mergeCommit");
    expect(h.state.merges[0].fields).not.toHaveProperty("outcome");
    error.mockRestore();
  });

  it("blank summary but PR proof (pr_url + commit_sha) → completes via the second pass; no escalation", async () => {
    // The case the TEAM-3985 re-harvest alone cannot close: it maps summary→output,
    // so a record whose deliverable proof is the PR leaves `output` empty and the
    // agentTasks-only check still fails. The TEAM-3976 rule (summary OR pr_url OR
    // commit_sha OR artifacts) resolves it — and the escalation must NOT fire.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.snapshots = [DONE];
    h.state.freshWorkflow = tasksMissingT1();
    h.state.s3Objects["completions/T-1.json"] = JSON.stringify({
      ticket_id: "T-1", summary: "", pr_url: "https://github.com/x/y/pull/1", commit_sha: "abc", branch: "feature/x",
    });
    await load();
    await completeWorkflow({ ...WF });
    expect(h.state.storeCompletions.length).toBe(1);
    expect(error.mock.calls.some((c) => String(c[0]).includes("CompletionRejectedMissingEvidence"))).toBe(false);
    expect(h.state.notifications).toHaveLength(0);
    // Two reads of the same key: the re-harvest (first pass) and our resolver.
    expect(completionReads()).toEqual(["completions/T-1.json", "completions/T-1.json"]);
    expect(h.state.merges.length).toBeGreaterThanOrEqual(1);
    const merged = Object.assign({}, ...h.state.merges.map((m) => m.fields));
    expect(merged).toMatchObject({ prUrl: "https://github.com/x/y/pull/1", commitSha: "abc", branch: "feature/x" });
    for (const m of h.state.merges) {
      expect(m.tid).toBe("T-1");
      expect(m.fields).not.toHaveProperty("output"); // a blank summary is never written as output
      expect(m.fields).not.toHaveProperty("mergeCommit");
      expect(m.fields).not.toHaveProperty("outcome");
    }
    error.mockRestore();
  });

  it("no record → still rejected (T-1@development), nothing backfilled", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.state.snapshots = [DONE];
    h.state.freshWorkflow = tasksMissingT1();
    await load();
    await completeWorkflow({ ...WF });
    expect(h.state.storeCompletions.length).toBe(0);
    expect(h.state.merges).toHaveLength(0);
    const rejected = error.mock.calls.find((c) => String(c[0]).includes("CompletionRejectedMissingEvidence"));
    expect(rejected).toBeTruthy();
    expect(String(rejected[0])).toContain("T-1@development");
    // A missing record is a fallback miss, NOT a check failure — the gate stays.
    expect(warn.mock.calls.some((c) => String(c[0]).includes("evidence check skipped"))).toBe(false);
    // TEAM-3985's escalation is preserved and fires exactly once, only after BOTH passes.
    expect(h.state.notifications).toHaveLength(1);
    expect(h.state.notifications[0].n.type).toBe("manager_escalation");
    expect(h.state.notifications[0].n.details).toContain("T-1@development");
    error.mockRestore();
    warn.mockRestore();
  });

  it("blank record (whitespace summary) → still rejected — an empty record is not evidence (AC-D4.1)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.snapshots = [DONE];
    h.state.freshWorkflow = tasksMissingT1();
    h.state.s3Objects["completions/T-1.json"] = JSON.stringify({ ticket_id: "T-1", summary: "   " });
    await load();
    await completeWorkflow({ ...WF });
    expect(h.state.storeCompletions.length).toBe(0);
    expect(h.state.merges).toHaveLength(0);
    expect(error.mock.calls.some((c) => String(c[0]).includes("T-1@development"))).toBe(true);
    expect(h.state.notifications).toHaveLength(1);
    expect(h.state.notifications[0].n.type).toBe("manager_escalation");
    error.mockRestore();
  });

  it("happy path (every entry has evidence) → ZERO completions/ reads", async () => {
    h.state.snapshots = [DONE];
    h.state.freshWorkflow = {
      id: "wf_1",
      agentTasks: {
        "T-1": { ticketId: "T-1", output: "shipped the code" },
        "T-2": { ticketId: "T-2", output: "verified" },
        "T-3": { ticketId: "T-3", output: "ci green" },
      },
    };
    h.state.s3Objects["completions/T-1.json"] = JSON.stringify(RECORD);
    await load();
    await completeWorkflow({ ...WF });
    expect(h.state.storeCompletions.length).toBe(1);
    expect(completionReads()).toEqual([]);
    expect(h.state.merges).toHaveLength(0);
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
    // TEAM-3760: mergeCommit satisfies the D2 ship-verdict gate, which now runs
    // BEFORE this merge gate (see completeWorkflow). Post-D2, TEAM-3721's scenario
    // is exactly "recorded evidence CLAIMS a merge, GitHub disproves it" — without
    // a recorded claim, D2 closes the run terminally and this gate is never reached.
    "B-4": { ticketId: "B-4", output: "shipped", mergeCommit: "9f1c2ab", prUrl: "https://github.com/o/r/pull/9" },
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

/**
 * TEAM-3985 — evidence harvested late. Agents routinely Done their ticket before
 * report_completion writes completions/<ticket>.json, so the done-cascade
 * harvest finds nothing and the run stranded forever with a silent
 * CompletionRejectedMissingEvidence (prod: sffzti/TEAM-3790, Done 19:37Z,
 * record 19:50Z). completeWorkflow must re-harvest before rejecting, and when
 * still missing, escalate ONCE instead of staying silent.
 */
describe("completeWorkflow — late evidence is re-harvested; a real gap escalates once (TEAM-3985)", () => {
  const CHILDREN = [
    { ticketId: "D-1", assignee: "agentcore_hub_backend_dev", type: "task", status: "done", phase: "development" },
    { ticketId: "D-2", assignee: "agentcore_hub_qa_verifier", type: "task", status: "done", phase: "verification" },
    { ticketId: "D-3", assignee: "agentcore_hub_ci_agent", type: "task", status: "done", phase: "review" },
    { ticketId: "D-4", assignee: "agentcore_hub_release_manager", type: "task", status: "done", phase: "ship" },
  ];
  const TASKS_MISSING_D1 = () => ({
    "D-1": { ticketId: "D-1", agentId: "agentcore_hub_backend_dev", status: "complete" }, // no output/artifact
    "D-2": { ticketId: "D-2", output: "verified" },
    "D-3": { ticketId: "D-3", output: "ci green" },
    "D-4": { ticketId: "D-4", output: "shipped", mergeCommit: "9f1c2ab" },
  });

  beforeEach(async () => {
    h.state.s3Completions = {};
    h.state.notifications.length = 0;
    h.state.storeCompletions.length = 0;
    h.state.terminalClaims.length = 0;
    delete process.env.GITHUB_PAT;
    process.env.ARTIFACT_BUCKET = "test-bucket";
    await loadWithShipDef();
  });
  afterEach(() => { delete process.env.ARTIFACT_BUCKET; });

  it("record landed after the ticket went Done → re-harvested at completion time, run completes", async () => {
    h.state.snapshots = [CHILDREN];
    h.state.freshWorkflow = { id: "wf_1", agentTasks: TASKS_MISSING_D1() };
    h.state.s3Completions["completions/D-1.json"] = {
      ticket_id: "D-1", summary: "implemented the endpoint", branch: "feature/EPIC-1-x",
      commit_sha: "c0ffee", pr_url: "https://github.com/o/r/pull/7",
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await completeWorkflow({ ...WF });

    expect(h.state.storeCompletions).toHaveLength(1);
    expect(h.state.freshWorkflow.agentTasks["D-1"].output).toBe("implemented the endpoint");
    expect(h.state.freshWorkflow.agentTasks["D-1"].prUrl).toBe("https://github.com/o/r/pull/7");
    expect(error.mock.calls.some((c) => String(c[0]).includes("CompletionRejectedMissingEvidence"))).toBe(false);
    expect(h.state.notifications).toHaveLength(0);
    error.mockRestore();
  });

  it("no record anywhere → still rejected, but a manager_escalation is appended exactly once", async () => {
    h.state.snapshots = [CHILDREN];
    h.state.freshWorkflow = { id: "wf_1", agentTasks: TASKS_MISSING_D1(), humanNotifications: [] };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await completeWorkflow({ ...WF });
    // A second pass (another re-Done kick) with the escalation still open: no duplicate.
    h.state.freshWorkflow.humanNotifications = h.state.notifications.map((x) => x.n);
    await completeWorkflow({ ...WF });

    expect(h.state.storeCompletions).toHaveLength(0);
    expect(error.mock.calls.filter((c) => String(c[0]).includes("CompletionRejectedMissingEvidence"))).toHaveLength(2);
    expect(h.state.notifications).toHaveLength(1);
    const n = h.state.notifications[0].n;
    expect(n.type).toBe("manager_escalation");
    expect(n.id).toBe("notif_completion_evidence_wf_1");
    expect(n.details).toContain("D-1@development");
    expect(n.acknowledged).toBe(false);
    error.mockRestore();
  });
});

/**
 * TEAM-3986 — GitHub's merge is the ship proof. The release manager's
 * report_completion tool has no outcome/merge_commit field, so self-report can
 * never read "shipped" and every merged run closed static-ci-only. When the
 * merge-verify probe PROVES the merge, the ship tasks are stamped with the merge
 * commit and the run completes; unknown → self-report still decides; a recorded
 * BLOCK is never overwritten.
 */
describe("completeWorkflow — GitHub merge proof drives the ship verdict (TEAM-3986)", () => {
  const SHIP_WF = {
    id: "wf_1", phase: "verification", workflowDefId: "software-delivery", epicId: "EPIC-1", input: { title: "t" },
    featureBranch: "feature/EPIC-1-fix",
    repoConfig: { layout: "multi-repo", repos: [{ platform: "backend", url: "https://github.com/o/r", defaultBranch: "main" }] },
  };
  const CHILDREN = [
    { ticketId: "S-1", assignee: "agentcore_hub_backend_dev", type: "task", status: "done", phase: "development" },
    { ticketId: "S-2", assignee: "agentcore_hub_qa_verifier", type: "task", status: "done", phase: "verification" },
    { ticketId: "S-3", assignee: "agentcore_hub_ci_agent", type: "task", status: "done", phase: "review" },
    { ticketId: "S-4", assignee: "agentcore_hub_release_manager", type: "task", status: "done", phase: "ship" },
  ];
  // What the release manager's report_completion actually yields today: output +
  // commitSha (branch HEAD) + prUrl — and NO mergeCommit / outcome.
  const SELF_REPORT_ONLY = () => ({
    "S-1": { ticketId: "S-1", output: "built" },
    "S-2": { ticketId: "S-2", output: "verified" },
    "S-3": { ticketId: "S-3", output: "ci green" },
    "S-4": { ticketId: "S-4", output: "DEPLOY SUCCEEDED", commitSha: "80a64ae", prUrl: "https://github.com/o/r/pull/327" },
  });
  const mockGitHub = ({ prs = [], compareStatus = "ahead", aheadBy = 3, fail = false } = {}) => {
    global.fetch = vi.fn(async (url) => {
      if (fail) throw new Error("github down");
      const u = String(url);
      const body = u.includes("/pulls?") ? prs : u.includes("/compare/") ? { status: compareStatus, ahead_by: aheadBy } : {};
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    });
  };
  let realFetch;
  beforeEach(async () => {
    realFetch = global.fetch;
    h.state.storeCompletions.length = 0;
    h.state.terminalClaims.length = 0;
    h.state.notifications.length = 0;
    process.env.GITHUB_PAT = "ghp_test";
    delete process.env.SHIP_MERGE_VERIFY;
    process.env.ARTIFACT_BUCKET = "test-bucket";
    await loadWithShipDef();
  });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.GITHUB_PAT;
    delete process.env.ARTIFACT_BUCKET;
  });

  it("merged PR on GitHub → ship task stamped with the merge commit, run completes (not static-ci-only)", async () => {
    h.state.snapshots = [CHILDREN];
    h.state.freshWorkflow = { id: "wf_1", agentTasks: SELF_REPORT_ONLY() };
    mockGitHub({ prs: [{ merged_at: "2026-09-04T22:00:00Z", merge_commit_sha: "c092e98", html_url: "https://github.com/o/r/pull/327" }] });

    await completeWorkflow({ ...SHIP_WF });

    expect(h.state.terminalClaims).toHaveLength(0);
    expect(h.state.storeCompletions).toHaveLength(1);
    expect(h.state.freshWorkflow.agentTasks["S-4"].mergeCommit).toBe("c092e98");
    expect(h.state.freshWorkflow.agentTasks["S-4"].mergeVerifiedBy).toBe("github");
  });

  it("GitHub unknown (API error) → no proof; self-report alone still closes static-ci-only", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.snapshots = [CHILDREN];
    h.state.freshWorkflow = { id: "wf_1", agentTasks: SELF_REPORT_ONLY() };
    mockGitHub({ fail: true });

    await completeWorkflow({ ...SHIP_WF });

    expect(h.state.storeCompletions).toHaveLength(0);
    expect(h.state.terminalClaims.map((c) => c.outcome)).toEqual(["static-ci-only"]);
    error.mockRestore();
  });

  it("provably unmerged → still rejected before any verdict (TEAM-3721 unchanged)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.snapshots = [CHILDREN];
    h.state.freshWorkflow = { id: "wf_1", agentTasks: SELF_REPORT_ONLY() };
    mockGitHub({ prs: [{ merged_at: null }], compareStatus: "ahead", aheadBy: 2 });

    await completeWorkflow({ ...SHIP_WF });

    expect(h.state.storeCompletions).toHaveLength(0);
    expect(h.state.terminalClaims).toHaveLength(0);
    expect(error.mock.calls.some((c) => String(c[0]).includes("CompletionRejectedUnmergedBranch"))).toBe(true);
    error.mockRestore();
  });

  it("a recorded BLOCK outcome is never overwritten by a merge proof", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.snapshots = [CHILDREN];
    const tasks = SELF_REPORT_ONLY();
    tasks["S-4"] = { ticketId: "S-4", output: "BLOCKED", outcome: "deploy-blocked", blockReason: "smoke failed" };
    h.state.freshWorkflow = { id: "wf_1", agentTasks: tasks };
    mockGitHub({ prs: [{ merged_at: "2026-09-04T22:00:00Z", merge_commit_sha: "c092e98" }] });

    await completeWorkflow({ ...SHIP_WF });

    expect(h.state.storeCompletions).toHaveLength(0);
    expect(h.state.terminalClaims.map((c) => c.outcome)).toEqual(["deploy-blocked"]);
    expect(h.state.freshWorkflow.agentTasks["S-4"].mergeCommit).toBeUndefined();
    error.mockRestore();
  });
});

/**
 * A run that is already terminal owes nothing. Cancel marks every open ticket
 * Done and each Done re-enters completeWorkflow with a snapshot that still says
 * "verification" — the fresh phase must win, or a cancelled run gets a
 * completion attempt / ship close / evidence escalation (prod wf_bug_TEAM-3976).
 */
describe("completeWorkflow — an already-terminal run (fresh phase) is left alone", () => {
  const CHILDREN = [
    { ticketId: "C-1", assignee: "agentcore_hub_backend_dev", type: "task", status: "done", phase: "development" },
    { ticketId: "C-4", assignee: "agentcore_hub_release_manager", type: "task", status: "done", phase: "ship" },
  ];
  beforeEach(async () => {
    h.state.storeCompletions.length = 0;
    h.state.terminalClaims.length = 0;
    h.state.notifications.length = 0;
    process.env.ARTIFACT_BUCKET = "test-bucket";
    await loadWithShipDef();
  });
  afterEach(() => { delete process.env.ARTIFACT_BUCKET; });

  for (const phase of ["cancelled", "deploy-blocked", "static-ci-only", "error"]) {
    it(`fresh phase ${phase} with a stale in-flight snapshot → no completion, no close, no escalation`, async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      h.state.snapshots = [CHILDREN];
      // Tasks carry NO evidence — every gate would fire if the check ran.
      h.state.freshWorkflow = { id: "wf_1", phase, agentTasks: { "C-1": { ticketId: "C-1" }, "C-4": { ticketId: "C-4" } } };

      await completeWorkflow({ ...WF, phase: "verification" });

      expect(h.state.storeCompletions).toHaveLength(0);
      expect(h.state.terminalClaims).toHaveLength(0);
      expect(h.state.notifications).toHaveLength(0);
      expect(error.mock.calls.some((c) => String(c[0]).includes("CompletionRejected"))).toBe(false);
      error.mockRestore();
    });
  }
});

/**
 * TEAM-3991 D1.4 — an honest terminal state, from the run's own evidence.
 *
 * Three production failures, one gate each:
 *   - wf 1pl3h1 closed `complete` while escalation gate TEAM-3757 sat in_review
 *     over unmerged PR #274, and its own "# PREFLIGHT BLOCKED" cd-evidence file
 *     went unread. Two bugs: nobody read the file, and nobody checked the gate.
 *   - wf sffzti merged 4 PRs and deployed, then closed `static-ci-only` — the CD
 *     agent's evidence says "DEPLOY SUCCEEDED", a word no outcome list contained.
 *   - wf 7ef4fp finished with its epic still open on the board: the roll-up was one
 *     inline best-effort jiraTransition with no DynamoDB path and no retry.
 *
 * The epic roll-up is now an obligation created atomically with the terminal claim
 * (store.completeWorkflow SETs epicRollupPending in the same CAS), discharged by
 * exactly one owner, and retryable by the sweep if that owner dies.
 */
describe("completeWorkflow — open gate, CD evidence, atomic epic roll-up (TEAM-3991 D1.4)", () => {
  const ESCALATION = {
    ticketId: "TEAM-3757",
    assignee: "human:reviewer@example.com",
    type: "task",
    status: "in_review",
    title: "Escalation #1: ship-review not converging",
    phase: "ship",
  };
  const GATE_DONE = {
    ticketId: "TEAM-900",
    assignee: "human:reviewer@example.com",
    type: "task",
    status: "done",
    title: "Merge Approval",
    // Deliberately no `phase`: a human gate is not an agent deliverable, so it owes
    // no evidence — stamping phase:"ship" on it would make the F3 gate demand one.
  };
  const CD_KEY = "workflows/wf_1/shared/cd-evidence/deploy-20260905T0100Z.md";
  /** A run that closed green and still owes its epic roll-up (TEAM-4099 F5). */
  const PENDING_ROLLUP = { id: "wf_1", epicId: "EPIC-1", phase: "complete", epicRollupPending: true };

  /**
   * The REAL debt filter, captured from sweep-scan.mjs rather than restated here —
   * "the row still matches the sweep filter" is only worth asserting against the
   * expression the sweep actually sends.
   */
  async function pendingRollupFilterExpression() {
    const { createPendingRollupScan } = await import("./sweep-scan.mjs");
    let captured = null;
    const scan = createPendingRollupScan({
      ddb: { send: async (cmd) => { captured = cmd.input; return { Items: [] }; } },
      workflowsTable: "workflows",
    });
    await scan();
    return String(captured.FilterExpression);
  }

  // The cd-evidence harvest is gated on ARTIFACT_BUCKET, read at module load —
  // and the suites above delete it in their afterEach, so re-assert it here.
  beforeEach(() => { process.env.ARTIFACT_BUCKET = "test-bucket"; });

  /** The release manager's own deploy note, where it really lands. */
  function seedCdEvidence(body, key = CD_KEY) {
    h.state.s3List = [{ Key: key, LastModified: "2026-09-05T01:00:00Z" }];
    h.state.s3Objects[key] = body;
  }

  it("1pl3h1: PREFLIGHT BLOCKED evidence + an escalation in_review → blocked close that NAMES the gate", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.snapshots = [[...SHIP_DONE, ESCALATION]];
    h.state.freshWorkflow = shipTasks({}); // done CD ticket, evidence present, NO outcome
    seedCdEvidence("# PREFLIGHT BLOCKED: PR #274 is not merged into main\n\nrefusing to deploy\n");
    await loadWithShipDef();
    const wf = { ...WF };
    await completeWorkflow(wf);

    // The file the agent wrote was read and stamped onto the CD ticket…
    expect(
      h.state.merges.some(
        (m) => m.tid === "T-4" && m.fields.outcome === "deploy-blocked" && m.fields.evidenceKey === CD_KEY
      )
    ).toBe(true);
    // …so the ladder had a verdict, and the close is blocked — never green.
    expect(h.state.storeCompletions).toHaveLength(0);
    expect(ebEventsOfType("workflow.complete")).toHaveLength(0);
    expect(h.state.terminalClaims).toHaveLength(1);
    expect(h.state.terminalClaims[0].outcome).toBe("deploy-blocked");
    expect(h.state.terminalClaims[0].reason).toContain("PR #274 is not merged");

    const events = ebEventsOfType("workflow.deploy_blocked");
    expect(events).toHaveLength(1);
    // The one thing a human needs to act: which gate, and whose it is.
    expect(events[0].openGate).toMatchObject({ ticketId: "TEAM-3757", kind: "escalation", status: "in_review" });
    expect(events[0].reason.startsWith("awaiting escalation TEAM-3757")).toBe(true);
    expect(wf.blockReason.startsWith("awaiting escalation TEAM-3757")).toBe(true);
    error.mockRestore();
  });

  it("an open TODO merge gate blocks a green close even when the ship verdict passes", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.snapshots = [[...SHIP_DONE, { ...GATE_DONE, status: "todo" }]];
    h.state.freshWorkflow = shipTasks({ mergeCommit: "9f1c2ab" }); // provably merged
    await loadWithShipDef();
    const wf = { ...WF };
    await completeWorkflow(wf);

    expect(h.state.storeCompletions).toHaveLength(0);
    expect(ebEventsOfType("workflow.complete")).toHaveLength(0);
    expect(h.state.terminalClaims).toHaveLength(1);
    const events = ebEventsOfType("workflow.static_ci_only");
    expect(events).toHaveLength(1);
    expect(events[0].openGate).toMatchObject({ ticketId: "TEAM-900", kind: "merge_gate", status: "todo" });
    expect(events[0].reason).toContain("awaiting merge_gate TEAM-900");
    error.mockRestore();
  });

  it("sffzti: DEPLOY SUCCEEDED evidence → complete reported as `deployed`, epic rolled up, THEN finalized", async () => {
    h.state.snapshots = [[...SHIP_DONE, GATE_DONE]];
    h.state.freshWorkflow = shipTasks({}); // no self-reported outcome — only the file
    seedCdEvidence("# DEPLOY SUCCEEDED - agentcore-hub-pipeline (4 PRs)\n");
    await loadWithShipDef();
    const wf = { ...WF };
    await completeWorkflow(wf);

    expect(h.state.merges.some((m) => m.tid === "T-4" && m.fields.outcome === "deployed")).toBe(true);
    expect(h.state.terminalClaims).toHaveLength(0);
    expect(h.state.storeCompletions).toHaveLength(1);
    const events = ebEventsOfType("workflow.complete");
    expect(events).toHaveLength(1);
    // The regression this exists for: a deployed run filed as static-ci-only.
    expect(events[0].outcome).toBe("deployed");
    expect(events[0].epicRolledUp).toBe(true);
    // The epic actually moved on the board (dynamodb provider = scoped Done write).
    expect(
      h.state.ticketUpdates.some(
        (u) => u.Key?.ticketId === "EPIC-1" && u.ExpressionAttributeValues?.[":s"] === "done"
      )
    ).toBe(true);
    expect(h.state.rollupCleared).toEqual(["wf_1"]);
    expect(h.state.finalized).toEqual(["wf_1"]); // finalized ONLY after the roll-up
  });

  it("7ef4fp: a def with NO ship phase still rolls the epic up, and claims no deploy", async () => {
    h.state.snapshots = [DONE];
    h.state.freshWorkflow = shipTasks({});
    await load(); // fallback def: development/verification/review, no ship
    await completeWorkflow({ ...WF });

    expect(h.state.storeCompletions).toHaveLength(1);
    const events = ebEventsOfType("workflow.complete");
    expect(events).toHaveLength(1);
    expect(events[0].epicRolledUp).toBe(true);
    expect(events[0].outcome).toBeUndefined(); // nothing shipped, nothing claimed
    expect(h.state.rollupCleared).toEqual(["wf_1"]);
    expect(h.state.finalized).toEqual(["wf_1"]);
  });

  it("roll-up failure: escalated once, announced as epicRolledUp:false, and NOT finalized — never un-completed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.state.snapshots = [DONE];
    h.state.freshWorkflow = shipTasks({});
    h.state.epicTransitionThrows = true;
    await load();
    await completeWorkflow({ ...WF });

    // The delivery is real: the completion claim stands.
    expect(h.state.storeCompletions).toHaveLength(1);
    const failed = ebEventsOfType("workflow.epic_rollup_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ workflowId: "wf_1", epicId: "EPIC-1", attempts: 3 });
    expect(failed[0].lastError).toContain("epic write rejected");

    // Exactly one escalation, under the run-idempotent id.
    const notifs = h.state.notifications.filter((n) => n.n?.id === "notif_epic_rollup_wf_1");
    expect(notifs).toHaveLength(1);
    expect(notifs[0].n).toMatchObject({ type: "manager_escalation", acknowledged: false });

    // Honest announcement, and NO finalized marker: the obligation is still open,
    // so the flag stays and the sweep can retry it.
    expect(ebEventsOfType("workflow.complete")[0].epicRolledUp).toBe(false);
    expect(h.state.rollupCleared).toHaveLength(0);
    expect(h.state.finalized).toHaveLength(0);
    error.mockRestore();
    warn.mockRestore();
  });

  it("retryPendingEpicRollups: the sweep takes the debt under a roll-up LEASE and recovers", async () => {
    const mod = await load();
    const res = await mod.retryPendingEpicRollups(PENDING_ROLLUP);

    expect(res).toMatchObject({ claimed: true, ok: true, attempts: 1 });
    expect(h.state.rollupClaims).toHaveLength(1);
    expect(h.state.rollupCleared).toEqual(["wf_1"]);
    expect(ebEventsOfType("workflow.epic_rolled_up")).toHaveLength(1);
    expect(ebEventsOfType("workflow.epic_rolled_up")[0]).toMatchObject({
      workflowId: "wf_1", epicId: "EPIC-1", recoveredBy: "retryPendingEpicRollups",
    });
    expect(h.state.finalized).toEqual(["wf_1"]); // finalized at last
  });

  it("retryPendingEpicRollups declines a run that owes nothing, one already finalized, and a leased one", async () => {
    const mod = await load();
    const pending = PENDING_ROLLUP;
    expect(await mod.retryPendingEpicRollups({ ...pending, epicRollupPending: false })).toMatchObject({ reason: "not_pending" });
    expect(await mod.retryPendingEpicRollups({ ...pending, phase: "review" })).toMatchObject({ reason: "not_pending" });
    expect(await mod.retryPendingEpicRollups({ ...pending, finalizedAt: "2026-09-05T00:00:00Z" })).toMatchObject({ reason: "not_pending" });
    // Pending, but a concurrent sweep holds a live lease → hands off, touches nothing.
    h.state.rollupLeases.wf_1 = new Date().toISOString();
    expect(await mod.retryPendingEpicRollups(pending)).toMatchObject({ claimed: false, reason: "claim_lost" });
    expect(h.state.rollupCleared).toHaveLength(0);
    expect(h.state.finalized).toHaveLength(0);
  });

  /**
   * TEAM-4099 F5 — the retry used to take the debt via `claimFinalization`, which
   * SETs `finalizedAt`, and `finalizedAt` is precisely the attribute the debt scan
   * excludes on (sweep-scan.mjs createPendingRollupScan). So ONE failed retry marked
   * the run "every side effect ran" and removed it from every future sweep while
   * `epicRollupPending` was still true: the epic stayed open on the board forever,
   * with nothing left that would ever look at it again.
   */
  it("a FAILED retry finalizes nothing and leaves the row exactly as the debt scan wants it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.state.epicTransitionThrows = true;
    const mod = await load();
    const res = await mod.retryPendingEpicRollups(PENDING_ROLLUP);

    expect(res).toMatchObject({ claimed: true, ok: false });
    expect(res.reason).toContain("epic write rejected");
    // The two writes that would have stranded it: neither happened.
    expect(h.state.finalized).toHaveLength(0);   // finalizedAt still absent
    expect(h.state.rollupCleared).toHaveLength(0); // epicRollupPending still set
    expect(ebEventsOfType("workflow.epic_rolled_up")).toHaveLength(0);

    // …and those are exactly the two attributes the sweep filter reads. The lease it
    // DID take is invisible to that filter, which is what makes it safe to hold.
    const filter = await pendingRollupFilterExpression();
    expect(filter).toContain("attribute_exists(epicRollupPending)");
    expect(filter).toContain("attribute_not_exists(finalizedAt)");
    expect(filter).not.toContain("epicRollupClaimedAt");
    warn.mockRestore();
  });

  it("the next sweep, once the lease ages out, discharges the debt: cleared, acked, finalized", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.state.epicTransitionThrows = true;
    const mod = await load();
    await mod.retryPendingEpicRollups(PENDING_ROLLUP);

    // Same sweep window: the lease this attempt still holds keeps a second pass out
    // (rollUpEpic already burned its own 3-attempt budget — no point re-burning it).
    expect(await mod.retryPendingEpicRollups(PENDING_ROLLUP)).toMatchObject({ reason: "claim_lost" });

    // A later sweep, past the lease: the epic write works this time.
    h.state.rollupLeases.wf_1 = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    h.state.epicTransitionThrows = false;
    // The escalation the failed completion filed is what a human would be looking at;
    // a recovered roll-up has to take it back down.
    h.state.freshWorkflow = {
      ...PENDING_ROLLUP,
      humanNotifications: [{ id: "notif_epic_rollup_wf_1", type: "manager_escalation", acknowledged: false }],
    };
    const res = await mod.retryPendingEpicRollups(PENDING_ROLLUP);

    expect(res).toMatchObject({ claimed: true, ok: true });
    expect(h.state.rollupCleared).toEqual(["wf_1"]);
    expect(h.state.freshWorkflow.humanNotifications[0].acknowledged).toBe(true);
    expect(h.state.finalized).toEqual(["wf_1"]);
    warn.mockRestore();
  });

  it("two sweeps racing the same debt: one lease wins, ONE roll-up runs", async () => {
    const mod = await load();
    const [a, b] = await Promise.all([
      mod.retryPendingEpicRollups(PENDING_ROLLUP),
      mod.retryPendingEpicRollups(PENDING_ROLLUP),
    ]);

    expect(h.state.rollupClaims).toHaveLength(2); // both tried…
    expect([a, b].filter((r) => r.claimed)).toHaveLength(1); // …one owns it
    expect([a, b].filter((r) => r.reason === "claim_lost")).toHaveLength(1);
    // One epic Done write, one announcement, one finalize.
    expect(h.state.ticketUpdates.filter((u) => u.Key?.ticketId === "EPIC-1")).toHaveLength(1);
    expect(ebEventsOfType("workflow.epic_rolled_up")).toHaveLength(1);
    expect(h.state.rollupCleared).toEqual(["wf_1"]);
    expect(h.state.finalized).toEqual(["wf_1"]);
  });
});

/**
 * TEAM-3992 Q4/D3.2 — the SHA-pinned fix-verification gate WIRED into
 * completeWorkflow (the pure fixVerificationGaps ↔ completion-evidence.ts twin is
 * pinned separately by the parity test). Reproduces wf 6ym4ef (TEAM-2811): a
 * review_fix closed Done and the run went green, but the fix's FINAL commit was
 * never re-reviewed or re-CI'd — so a regression shipped. Now: a done fix ticket
 * must carry a passing verification record pinned to agentTasks[fix].commitSha for
 * every role its kind re-arms, or the run cannot complete.
 *
 * Evidence gate is opted OUT here (COMPLETION_EVIDENCE_REQUIRED=off) so these tests
 * isolate the fix gate; the def carries no ship phase, so no ship gate follows.
 */
describe("completeWorkflow — SHA-pinned fix-verification gate (TEAM-3992 Q4, wf 6ym4ef)", () => {
  const SHA = "abcdef1234567890abcdef1234567890abcdef12";
  // A def like software-delivery but WITHOUT ship, carrying a ticketDag.fixRearm.
  // loadWorkflowDefs must carry ticketDag through (the gate reads it) — a drift
  // there silently disables the gate, which this suite would then catch.
  const FIX_WF_CONFIG = {
    workflows: [
      {
        id: "software-delivery",
        intakeAgentId: "agentcore_hub_requirements_analyst",
        featureBranchPhase: "development",
        completionRequiresAgentPhases: ["development", "verification", "review"],
        reviewGates: [],
        phases: [{ agentPhase: "development" }, { agentPhase: "verification" }, { agentPhase: "review" }],
        ticketDag: {
          fixRearm: { review_fix: ["review", "ci"], qa_fix: ["review", "ci", "verification"], codex_fix: ["review", "ci"] },
        },
      },
    ],
  };
  // The done review_fix ticket under development, plus the three ordinary done
  // tickets. fixVerificationGaps iterates the CHILDREN (parentId-index snapshot).
  const FIX_TICKET = {
    ticketId: "FIX-1", assignee: "agentcore_hub_backend_dev", type: "task", status: "done",
    spawnedBy: { kind: "review_fix", gateTicketId: "T-3" },
  };
  const CHILDREN_WITH_FIX = [...DONE, FIX_TICKET];
  // A verifier task carrying a verification record (the shape harvestCompletionEvidence
  // writes: agentTasks.<verifier>.verification).
  const vTask = (kind, verdict = "pass", headSha = SHA) => ({
    ticketId: `V-${kind}`, verification: { targetTicketId: "FIX-1", headSha, kind, verdict },
  });

  /** Prime the roster + the ticketDag-bearing def, then hand back completeWorkflow. */
  async function loadWithFixDef() {
    h.state.workflowsConfig = FIX_WF_CONFIG;
    await load();
    await handler({ Records: [] });
  }

  const ebTypes = () =>
    h.state.ebEvents.map((e) => e.Entries?.[0]?.DetailType).filter(Boolean);
  const blockedEvents = () =>
    h.state.ebEvents
      .map((e) => e.Entries?.[0])
      .filter((e) => e?.DetailType === "workflow.completion_blocked")
      .map((e) => JSON.parse(e.Detail));

  beforeEach(() => {
    process.env.COMPLETION_EVIDENCE_REQUIRED = "off"; // isolate the fix gate
    delete process.env.FIX_VERIFICATION_REQUIRED; // default enforce
  });
  afterEach(() => {
    delete process.env.FIX_VERIFICATION_REQUIRED;
  });

  it("enforce (default): blocks the run when the fix's final SHA is not re-CI'd, escalates once", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.snapshots = [CHILDREN_WITH_FIX];
    h.state.freshWorkflow = {
      id: "wf_1",
      agentTasks: {
        "FIX-1": { ticketId: "FIX-1", commitSha: SHA },
        "V-review": vTask("review"), // review re-verified, but no ci → gap
      },
    };
    await loadWithFixDef();
    await completeWorkflow({ ...WF });
    expect(h.state.storeCompletions.length).toBe(0); // never claimed
    expect(h.state.finalized.length).toBe(0);
    const rejected = error.mock.calls.find((c) => String(c[0]).includes("CompletionRejectedFixUnverified"));
    expect(rejected).toBeTruthy();
    expect(String(rejected[0])).toContain("FIX-1(ci)");
    // Idempotent manager_escalation on the pinned id.
    const esc = h.state.notifications.find((n) => n.n?.id === "notif_fix_unverified_wf_1");
    expect(esc).toBeTruthy();
    expect(esc.n.type).toBe("manager_escalation");
    // Terminal-blocked event carries the offenders.
    expect(blockedEvents().some((d) => d.reason === "fix_unverified" && d.offenders?.[0]?.ticketId === "FIX-1")).toBe(true);
    error.mockRestore();
  });

  it("enforce: completes once review AND ci are re-verified at the fix's FINAL SHA (short↔long ok)", async () => {
    h.state.snapshots = [CHILDREN_WITH_FIX];
    h.state.freshWorkflow = {
      id: "wf_1",
      agentTasks: {
        "FIX-1": { ticketId: "FIX-1", commitSha: SHA },
        "V-review": vTask("review", "pass", "abcdef1"), // 7-char prefix of the full SHA
        "V-ci": vTask("ci"),
      },
    };
    await loadWithFixDef();
    await completeWorkflow({ ...WF });
    expect(h.state.storeCompletions.length).toBe(1);
    expect(h.state.notifications.some((n) => n.n?.id === "notif_fix_unverified_wf_1")).toBe(false);
  });

  it("enforce: a re-verification at the WRONG sha does not satisfy the gate", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.snapshots = [CHILDREN_WITH_FIX];
    h.state.freshWorkflow = {
      id: "wf_1",
      agentTasks: {
        "FIX-1": { ticketId: "FIX-1", commitSha: SHA },
        "V-review": vTask("review", "pass", "9999999"),
        "V-ci": vTask("ci", "pass", "9999999"),
      },
    };
    await loadWithFixDef();
    await completeWorkflow({ ...WF });
    expect(h.state.storeCompletions.length).toBe(0);
    expect(String(error.mock.calls.find((c) => String(c[0]).includes("CompletionRejectedFixUnverified"))[0]))
      .toContain("FIX-1(review/ci)");
    error.mockRestore();
  });

  it("shadow: publishes the completion_blocked event but completes anyway (no escalation)", async () => {
    process.env.FIX_VERIFICATION_REQUIRED = "shadow";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.state.snapshots = [CHILDREN_WITH_FIX];
    h.state.freshWorkflow = {
      id: "wf_1",
      agentTasks: { "FIX-1": { ticketId: "FIX-1", commitSha: SHA }, "V-review": vTask("review") },
    };
    await loadWithFixDef();
    await completeWorkflow({ ...WF });
    expect(h.state.storeCompletions.length).toBe(1); // proceeds
    expect(blockedEvents().some((d) => d.reason === "fix_unverified" && d.shadow === true)).toBe(true);
    expect(h.state.notifications.some((n) => n.n?.id === "notif_fix_unverified_wf_1")).toBe(false);
    warn.mockRestore();
  });

  it("off: the gate is skipped entirely — an unverified fix still completes", async () => {
    process.env.FIX_VERIFICATION_REQUIRED = "off";
    h.state.snapshots = [CHILDREN_WITH_FIX];
    h.state.freshWorkflow = { id: "wf_1", agentTasks: { "FIX-1": { ticketId: "FIX-1", commitSha: SHA } } };
    await loadWithFixDef();
    await completeWorkflow({ ...WF });
    expect(h.state.storeCompletions.length).toBe(1);
    expect(ebTypes().includes("workflow.completion_blocked")).toBe(false);
  });
});

/**
 * TEAM-4099 F1 — the gate-bypass completion gate is TRI-state.
 *
 * Before: an unacked `notif_gate_bypass_*` escalation blocked completeWorkflow,
 * and the escalation the detector wrote carried `kind` instead of `type` — so the
 * console/Telegram surfaces never listed it and the PATCH route could never ack
 * it. The run was wedged permanently, and the only way out (ack) would have let it
 * close GREEN over a merge nobody approved. Now: unacked → still refused; ACKED →
 * the block lifts but the run closes `deploy-blocked` with a blockReason naming
 * the PR and the merge commit. Never `complete`.
 *
 * The detector-side half of the story (a re-Done of a flagged ticket re-publishing
 * nothing) is pinned in gate-bypass-wiring.test.mjs, which drives the real handlers.
 */
describe("completeWorkflow — accepted gate bypass closes blocked (TEAM-4099 F1)", () => {
  const MERGE_COMMIT = "cafebabe1234567";
  const PR_URL = "https://github.com/o/r/pull/327";
  const bypassNotif = (acknowledged = false) => ({
    id: `notif_gate_bypass_wf_1_${MERGE_COMMIT}`,
    type: "manager_escalation",
    title: "Merge without approval (gate bypass)",
    details: "Merge without approval: PR #327 merged before the Merge Approval gate recorded an APPROVE.",
    reviewer: "gate-bypass",
    timestamp: "2026-09-05T12:00:00Z",
    acknowledged,
    ticketId: "T-1",
    mergeCommit: MERGE_COMMIT,
    prUrl: PR_URL,
  });

  /** Evidence on every done ticket, so only the bypass gate is under test. */
  const wfWithNotifs = (humanNotifications) => ({
    id: "wf_1",
    agentTasks: {
      "T-1": { ticketId: "T-1", output: "implemented" },
      "T-2": { ticketId: "T-2", output: "verified" },
      "T-3": { ticketId: "T-3", output: "ci green" },
    },
    humanNotifications,
  });

  /**
   * Acknowledge through the SAME predicate the console PATCH route uses
   * (src/app/api/workflow/[id]/escalations/route.ts:67 — `n.type !==
   * "manager_escalation" || n.acknowledged` skips the row). Replicated rather
   * than imported because the route is a Next handler, not a module export; that
   * is exactly why the notification's `type` field is load-bearing.
   */
  async function ackViaEscalationsRoute(workflowId, notificationId) {
    const routeSelects = (n) => !(n?.type !== "manager_escalation" || n.acknowledged);
    const store = await import("./workflow-store.mjs");
    return store.ackNotifications(workflowId, (n) => routeSelects(n) && (!notificationId || n.id === notificationId));
  }

  it("unacked: completion is refused, nothing terminal is claimed, and the block is announced once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.state.snapshots = [DONE];
    h.state.freshWorkflow = wfWithNotifs([bypassNotif(false)]);
    await load();
    await completeWorkflow({ ...WF });

    expect(h.state.storeCompletions).toHaveLength(0);
    expect(h.state.terminalClaims).toHaveLength(0);
    const blocked = ebEventsOfType("workflow.completion_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ workflowId: "wf_1", reason: "gate_bypass_unacked", ticketIds: ["T-1"] });
    expect(h.state.notifications.map((n) => n.n.id)).toEqual(["notif_completion_gate_bypass_wf_1"]);
    warn.mockRestore();
  });

  it("acked through the escalations-route predicate: closes deploy-blocked, blockReason names the PR", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.snapshots = [DONE];
    h.state.freshWorkflow = wfWithNotifs([bypassNotif(false)]);
    await load();

    // A human resolves the escalation — only possible because the notification
    // carries `type: "manager_escalation"` (the F1 fix).
    expect(await ackViaEscalationsRoute("wf_1", `notif_gate_bypass_wf_1_${MERGE_COMMIT}`)).toBe(1);

    await completeWorkflow({ ...WF });

    // Never green: no completion claim, one terminal deploy-blocked claim.
    expect(h.state.storeCompletions).toHaveLength(0);
    expect(h.state.terminalClaims).toEqual([
      {
        id: "wf_1",
        outcome: "deploy-blocked",
        ts: expect.any(String),
        reason: `gate bypass accepted: PR ${PR_URL} merged cafebab before approval`,
      },
    ]);
    const closed = ebEventsOfType("workflow.deploy_blocked");
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ workflowId: "wf_1", outcome: "deploy-blocked", offenders: [] });
    expect(closed[0].reason).toContain(PR_URL);
    expect(ebEventsOfType("workflow.complete")).toHaveLength(0);
    expect(h.state.finalized).toEqual(["wf_1"]);
    // No second "cannot close" escalation: the block is resolved, not re-raised.
    expect(h.state.notifications.some((n) => n.n.id === "notif_completion_gate_bypass_wf_1")).toBe(false);
    error.mockRestore();
  });

  it("a run that never bypassed anything is untouched by the gate (control)", async () => {
    h.state.snapshots = [DONE];
    h.state.freshWorkflow = wfWithNotifs([
      // An acked escalation of a DIFFERENT kind must not divert the close.
      { id: "notif_epic_rollup_wf_1", type: "manager_escalation", acknowledged: true },
    ]);
    await load();
    await completeWorkflow({ ...WF });

    expect(h.state.storeCompletions).toHaveLength(1);
    expect(h.state.terminalClaims).toHaveLength(0);
    expect(ebEventsOfType("workflow.complete")).toHaveLength(1);
  });
});
