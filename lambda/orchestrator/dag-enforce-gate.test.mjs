import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-4100 F2 — the HARD realized-graph topology gate (design D3.4 / TEAM-3993
 * "cannot be bypassed by the analyst"). Twin of dag-audit.test.mjs, but for
 * DAG_VALIDATION_MODE=enforce: at the run's FIRST development-phase entry the
 * orchestrator validates the REALIZED child graph against the def's ticketDag
 * BEFORE advancing the phase, and on a violation (or a missing plan) it PARKS
 * the fresh claim, raises ONE idempotent manager_escalation, and ABORTS dispatch
 * (never invokes). Because the phase is not advanced, a re-trigger re-runs the
 * gate — so a fixed topology later dispatches, and a still-broken one raises no
 * second escalation/event.
 *
 * Scope: the gate fires ONLY when the run is advancing INTO development
 * (agentPhaseIdx > currentPhaseIdx). Fix/re-verify chains and the ship phase
 * re-drive dev tickets while the run is ALREADY in development, so they never
 * re-enter the phase-advance block and are never gated here; orchestrator-
 * spawned tickets (any `spawnedBy`) are additionally filtered out of the check.
 *
 * Harness mirrors dag-audit.test.mjs (§3(a): real index.mjs + real dag.mjs,
 * mocked I/O seams). The workflow def is served from S3 config/workflows.json;
 * the roster falls back to FALLBACK_ROSTER (backend_dev→development,
 * qa_verifier→verification), so nodes map by phase.
 */

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    children: /** @type {any[]} */ ([]),
    workflow: /** @type {any} */ (null),
    events: /** @type {any[]} */ ([]),
    lambdaInvokes: /** @type {any[]} */ ([]),
    workflowDefs: /** @type {any} */ (null),
    /** shared/ticket-plan.json body served to the gate (null → GetObject 404 → PLAN_NOT_SUBMITTED). */
    planBody: /** @type {any} */ (null),
    parkClaimCalls: /** @type {any[]} */ ([]),
    notifyCalls: /** @type {any[]} */ ([]),
    /** appended notification ids — the mock dedupes like the real appendNotificationOnce. */
    appendedIds: /** @type {Set<string>} */ (new Set()),
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
          if (name === "GetCommand") return { Item: h.state.tickets[cmd.input.Key.ticketId] || null };
          if (name === "QueryCommand") {
            if (cmd.input.TableName === "agentcore-hub-events") return { Items: [] };
            return { Items: h.state.children };
          }
          if (name === "PutCommand") { h.state.events.push(cmd.input.Item); return {}; }
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class { async send(cmd) { h.state.lambdaInvokes.push(cmd.input); return {}; } },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      const name = cmd.constructor.name;
      if (name === "PutObjectCommand") return { ETag: '"etag-put"' };
      if (name === "DeleteObjectCommand") return {};
      if (name === "GetObjectCommand") {
        const key = cmd.input.Key;
        if (key === "config/workflows.json" && h.state.workflowDefs) {
          return { Body: { transformToString: async () => JSON.stringify(h.state.workflowDefs) } };
        }
        if (key.endsWith("/shared/ticket-plan.json") && h.state.planBody) {
          return { Body: { transformToString: async () => JSON.stringify(h.state.planBody) } };
        }
        const e = new Error("The specified key does not exist.");
        e.name = "NoSuchKey";
        throw e;
      }
      return {};
    }
  },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; } },
  DeleteObjectCommand: class { constructor(i) { this.input = i; } },
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
  claimInvocation: vi.fn(async () => true),
  setResumeContext: vi.fn(async () => {}),
  removeResumeContext: vi.fn(async () => {}),
  mergeTaskMetadataOrTrack: vi.fn(async () => {}),
  mergeTaskMetadata: vi.fn(async () => {}),
  completeTaskEntry: vi.fn(async () => {}),
  setTaskStatus: vi.fn(async () => {}),
  trackTask: vi.fn(async () => {}),
  appendNotification: vi.fn(async () => {}),
  // Mirrors the real appendNotificationOnce dedupe: the FIRST caller with a given
  // id appends (true); a later caller with the same unacknowledged id stands down (false).
  appendNotificationOnce: vi.fn(async (wfId, notification) => {
    h.state.notifyCalls.push({ wfId, notification });
    if (h.state.appendedIds.has(notification.id)) return false;
    h.state.appendedIds.add(notification.id);
    return true;
  }),
  appendReviewNotificationOnce: vi.fn(async () => true),
  ackNotifications: vi.fn(async () => {}),
  resetDeadSessionRetry: vi.fn(async () => {}),
  incrementDeadSessionRetry: vi.fn(async () => {}),
  completeWorkflow: vi.fn(async () => true),
  claimTerminalOutcome: vi.fn(async () => true),
  claimFinalization: vi.fn(async () => false),
  markFinalized: vi.fn(async () => {}),
  setProtectionCheck: vi.fn(async () => {}),
  setRepoCheck: vi.fn(async () => {}),
  advancePhase: vi.fn(async () => {}),
  setDagAudit: vi.fn(async () => true),
  parkClaim: vi.fn(async (wfId, ticketId, startedAt) => {
    h.state.parkClaimCalls.push({ wfId, ticketId, startedAt });
    return true;
  }),
}));

process.env.ARTIFACT_BUCKET = "test-bucket";
process.env.GITHUB_PAT = "test-pat";
process.env.RUNTIME_ARN_AGENTCORE_HUB_BACKEND_DEV =
  "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/backend-dev";

const TICKET = "TEAM-100";
const PARENT = "EPIC-9";
const DEV = "agentcore_hub_backend_dev"; // FALLBACK_ROSTER phase: development
const QA = "agentcore_hub_qa_verifier"; // FALLBACK_ROSTER phase: verification
const DEF_ID = "dag-test";

const TICKET_DAG = {
  nodes: {
    dev: { agentPhases: ["development"], min: 1 },
    qa: { agentPhases: ["verification"], min: 1 },
  },
  edges: [{ from: "dev", to: "qa" }],
};

function defsConfig(withDag = true) {
  return {
    workflows: [{
      id: DEF_ID,
      intakeAgentId: "agentcore_hub_requirements_analyst",
      featureBranchPhase: "development",
      createsPullRequest: true,
      completionRequiresAgentPhases: ["development", "verification"],
      phases: [
        { agentPhase: "requirements" },
        { agentPhase: "design" },
        { agentPhase: "development" },
        { agentPhase: "verification" },
      ],
      ...(withDag ? { ticketDag: TICKET_DAG } : {}),
    }],
  };
}

const child = (id, assignee, blockedBy = [], extra = {}) => ({
  id, ticketId: id, assignee, title: id, blockedBy, parentId: PARENT, type: "task", ...extra,
});

const VALID_CHILDREN = [child("DEV-1", DEV), child("QA-1", QA, ["DEV-1"])];
const VIOLATING_CHILDREN = [child("DEV-1", DEV), child("QA-1", QA)]; // qa misses dev→qa edge

/** A non-empty persisted plan (its presence, not content, is what the gate reads). */
const PLAN = { requirements: "r", tickets: [{ id: "p1", assignee: DEV }, { id: "p2", assignee: QA }] };

function makeWorkflow(phase = "design") {
  return {
    id: "wf_1",
    workflowId: "wf_1",
    epicId: PARENT,
    workflowDefId: DEF_ID,
    phase, // one phase below development → first dev dispatch advances
    input: { title: "t" },
    featureBranch: "feature/EPIC-9-widget", // set → branch-creation block is skipped
    repoConfig: { repos: [{ url: "https://github.com/o/r", defaultBranch: "main" }] },
    humanNotifications: [],
    agentTasks: { [TICKET]: { id: "t1", agentId: DEV, ticketId: TICKET, status: "ready", startedAt: "2026-01-01T00:00:00.000Z" } },
  };
}

const readyRecord = () => ({
  eventName: "MODIFY",
  dynamodb: {
    NewImage: { ticketId: TICKET, status: "ready", assignee: DEV, parentId: PARENT, workflowId: "wf_1", type: "task", blockedBy: [] },
    OldImage: { ticketId: TICKET, status: "todo" },
  },
});

let handler;
async function load(mode = "enforce") {
  process.env.TICKET_PROVIDER = "dynamodb";
  process.env.DAG_VALIDATION_MODE = mode;
  vi.resetModules();
  ({ handler } = await import("./index.mjs"));
}

const eventsOfType = (type) => h.state.events.filter((e) => e.type === type);
const store = () => import("./workflow-store.mjs");

beforeEach(() => {
  h.state.tickets = {
    [TICKET]: { ticketId: TICKET, status: "ready", assignee: DEV, parentId: PARENT, workflowId: "wf_1", type: "task", blockedBy: [] },
  };
  h.state.children = [];
  h.state.workflow = makeWorkflow();
  h.state.events.length = 0;
  h.state.lambdaInvokes.length = 0;
  h.state.workflowDefs = defsConfig(true);
  h.state.planBody = PLAN;
  h.state.parkClaimCalls.length = 0;
  h.state.notifyCalls.length = 0;
  h.state.appendedIds.clear();

  vi.stubGlobal("fetch", async (url) => {
    const u = String(url);
    if (u.includes("/pulls?")) return { ok: true, status: 200, text: async () => "[]" };
    return { ok: false, status: 404, text: async () => "{}" };
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("realized-graph HARD gate (F2) — enforce mode, first development-phase entry", () => {
  it("valid plan + violating tickets → parked, ONE escalation, ZERO dispatch, phase not advanced", async () => {
    await load("enforce");
    h.state.children = VIOLATING_CHILDREN;

    await handler({ Records: [readyRecord()] });

    // Parked the fresh claim (generation-scoped: startedAt of the claim).
    expect(h.state.parkClaimCalls).toHaveLength(1);
    expect(h.state.parkClaimCalls[0]).toMatchObject({ wfId: "wf_1", ticketId: TICKET });

    // Exactly one manager_escalation with the pinned idempotent id + coded detail.
    expect(h.state.notifyCalls).toHaveLength(1);
    const n = h.state.notifyCalls[0].notification;
    expect(n.id).toBe("notif_dag_violation_wf_1");
    expect(n.type).toBe("manager_escalation");
    expect(n.acknowledged).toBe(false);
    expect(n.details).toContain("missing_required_edge");

    // One enforced dag_violation event, and NO agent was invoked.
    const ev = eventsOfType("workflow.dag_violation");
    expect(ev).toHaveLength(1);
    expect(ev[0].detail).toMatchObject({ workflowId: "wf_1", defId: DEF_ID, enforced: true });
    expect(h.state.lambdaInvokes).toHaveLength(0);

    // Phase was NOT advanced (the gate aborted before advancePhase).
    const s = await store();
    expect(s.advancePhase).not.toHaveBeenCalled();
  });

  it("re-trigger of a still-violating run → no second escalation/event, still no dispatch", async () => {
    await load("enforce");
    h.state.children = VIOLATING_CHILDREN;

    await handler({ Records: [readyRecord()] });
    expect(h.state.notifyCalls).toHaveLength(1);
    expect(eventsOfType("workflow.dag_violation")).toHaveLength(1);

    // Same warm container, run still parked in its prior phase → re-enters the gate.
    h.state.workflow.phase = "design";
    await handler({ Records: [readyRecord()] });

    // parkClaim runs again (idempotent), but appendNotificationOnce dedupes so
    // there is NO second escalation and NO second event.
    expect(h.state.notifyCalls).toHaveLength(2); // called again...
    expect(h.state.appendedIds.size).toBe(1); // ...but only ONE id ever appended
    expect(eventsOfType("workflow.dag_violation")).toHaveLength(1);
    expect(h.state.lambdaInvokes).toHaveLength(0);
  });

  it("conforming tickets → dispatch proceeds (no park, no escalation)", async () => {
    await load("enforce");
    h.state.children = VALID_CHILDREN;

    await handler({ Records: [readyRecord()] });

    expect(h.state.parkClaimCalls).toHaveLength(0);
    expect(h.state.notifyCalls).toHaveLength(0);
    expect(eventsOfType("workflow.dag_violation")).toHaveLength(0);
    const s = await store();
    expect(s.advancePhase).toHaveBeenCalled();
    expect(h.state.lambdaInvokes.length).toBeGreaterThan(0);
  });

  it("no plan persisted (enforce) → PLAN_NOT_SUBMITTED: parked + escalation, no dispatch", async () => {
    await load("enforce");
    h.state.planBody = null; // GetObject 404 → the def requires a plan but none exists
    h.state.children = VALID_CHILDREN; // conforming, but the plan is missing

    await handler({ Records: [readyRecord()] });

    expect(h.state.parkClaimCalls).toHaveLength(1);
    expect(h.state.notifyCalls).toHaveLength(1);
    expect(h.state.notifyCalls[0].notification.details).toContain("submit_ticket_plan");
    const ev = eventsOfType("workflow.dag_violation");
    expect(ev).toHaveLength(1);
    expect(ev[0].detail.violations[0].code).toBe("PLAN_NOT_SUBMITTED");
    expect(h.state.lambdaInvokes).toHaveLength(0);
  });

  it("orchestrator-spawned (spawnedBy) tickets are excluded from the check", async () => {
    await load("enforce");
    // A conforming dev+qa graph PLUS a fix ticket that would otherwise be an
    // unmapped violation — it is filtered out because it carries spawnedBy.
    h.state.children = [
      ...VALID_CHILDREN,
      child("FIX-1", DEV, [], { spawnedBy: { kind: "review_fix", rearmOf: "DEV-1" } }),
    ];

    await handler({ Records: [readyRecord()] });

    expect(h.state.parkClaimCalls).toHaveLength(0);
    expect(h.state.notifyCalls).toHaveLength(0);
    expect(h.state.lambdaInvokes.length).toBeGreaterThan(0);
  });

  it("a run ALREADY in development (fix/re-verify chain) is never gated", async () => {
    await load("enforce");
    h.state.workflow = makeWorkflow("development"); // not advancing INTO development
    h.state.children = VIOLATING_CHILDREN; // would violate IF the gate ran

    await handler({ Records: [readyRecord()] });

    // Phase-advance block not entered → gate not run → dispatch proceeds.
    expect(h.state.parkClaimCalls).toHaveLength(0);
    expect(h.state.notifyCalls).toHaveLength(0);
    expect(h.state.lambdaInvokes.length).toBeGreaterThan(0);
  });

  it("shadow mode → advisory only: proceeds to dispatch, no park/escalation", async () => {
    await load("shadow");
    h.state.children = VIOLATING_CHILDREN;

    await handler({ Records: [readyRecord()] });

    expect(h.state.parkClaimCalls).toHaveLength(0);
    expect(h.state.notifyCalls).toHaveLength(0);
    expect(h.state.lambdaInvokes.length).toBeGreaterThan(0);
    const s = await store();
    expect(s.advancePhase).toHaveBeenCalled();
  });
});
