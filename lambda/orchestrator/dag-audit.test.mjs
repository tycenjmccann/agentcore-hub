import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-3992 D3.4 — the one-shot realized-graph audit (design Q2, last paragraph).
 *
 * At the FIRST development-phase dispatch the orchestrator validates the run's
 * realized child graph against the def's declared `ticketDag` (the PURE validator
 * in dag.mjs, exhaustively covered by dag.test.ts / dag-parity.test.ts) and
 * records the outcome exactly once via store.setDagAudit — whose
 * `attribute_not_exists(dagAudit)` condition is the authoritative idempotency
 * guard. A non-empty violation set surfaces a NON-FATAL `workflow.dag_violation`
 * event; the dispatch itself NEVER blocks on the audit.
 *
 * These prove the WIRING at the real dispatch boundary (same rationale as
 * dispatch-guard / gate-bypass-wiring: a correct module nobody invokes fixes
 * nothing): first dev dispatch of a violating graph → one event + one store
 * write; the audit never fires twice for one run; a valid graph records but emits
 * nothing; a def with no ticketDag is a pure no-op.
 *
 * Harness: the §3(a) shape (real index.mjs + real dag.mjs, mocked I/O seams). The
 * workflow def is served from S3 config/workflows.json so a real ticketDag flows
 * through loadWorkflowDefs; the roster falls back to the hardcoded FALLBACK_ROSTER
 * (backend_dev→development, qa_verifier→verification), so nodes map by phase.
 */

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    children: /** @type {any[]} */ ([]),
    workflow: /** @type {any} */ (null),
    events: /** @type {any[]} */ ([]),
    lambdaInvokes: /** @type {any[]} */ ([]),
    s3Puts: /** @type {any[]} */ ([]),
    /** config/workflows.json body served to loadWorkflowDefs (null → not served). */
    workflowDefs: /** @type {any} */ (null),
    /** setDagAudit call log + a simulated one-shot conditional. */
    dagAuditCalls: /** @type {any[]} */ ([]),
    dagAuditRecorded: false,
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
      if (name === "PutObjectCommand") { h.state.s3Puts.push(cmd.input); return { ETag: '"etag-put"' }; }
      if (name === "DeleteObjectCommand") return {};
      if (name === "GetObjectCommand") {
        if (cmd.input.Key === "config/workflows.json" && h.state.workflowDefs) {
          return { Body: { transformToString: async () => JSON.stringify(h.state.workflowDefs) } };
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
  appendNotificationOnce: vi.fn(async () => true),
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
  // The unit under test: the conditional one-shot write. The mock mirrors the
  // real `attribute_not_exists(dagAudit)` semantics — the FIRST caller records
  // and wins (true), every later caller loses the CAS (false).
  setDagAudit: vi.fn(async (wfId, audit) => {
    h.state.dagAuditCalls.push({ wfId, audit });
    if (h.state.dagAuditRecorded) return false;
    h.state.dagAuditRecorded = true;
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

// A minimal ticketDag: a dev node and a qa node, with a required dev→qa edge.
const TICKET_DAG = {
  nodes: {
    dev: { agentPhases: ["development"], min: 1 },
    qa: { agentPhases: ["verification"], min: 1 },
  },
  edges: [{ from: "dev", to: "qa" }],
};

/** The S3 workflows.json body: one def carrying TICKET_DAG. */
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

/** A realized child ticket. `id` is the handle blocked_by references. */
const child = (id, assignee, blockedBy = []) => ({
  id, ticketId: id, assignee, title: id, blockedBy, parentId: PARENT, type: "task",
});

const VALID_CHILDREN = [child("DEV-1", DEV), child("QA-1", QA, ["DEV-1"])];
const VIOLATING_CHILDREN = [child("DEV-1", DEV), child("QA-1", QA)]; // qa misses dev→qa edge

function makeWorkflow() {
  return {
    id: "wf_1",
    workflowId: "wf_1",
    epicId: PARENT,
    workflowDefId: DEF_ID,
    phase: "design", // one phase below development → first dev dispatch advances
    input: { title: "t" },
    featureBranch: "feature/EPIC-9-widget", // set → branch-creation block is skipped
    repoConfig: { repos: [{ url: "https://github.com/o/r", defaultBranch: "main" }] },
    humanNotifications: [],
    agentTasks: { [TICKET]: { id: "t1", agentId: DEV, ticketId: TICKET, status: "ready" } },
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
async function load() {
  process.env.TICKET_PROVIDER = "dynamodb";
  // TEAM-4100 F2 — auditRealizedGraphOnce is now the SHADOW/OFF advisory path;
  // enforce mode runs the HARD gate instead (see dag-enforce-gate.test.mjs).
  // These tests pin the advisory audit, so run them under shadow.
  process.env.DAG_VALIDATION_MODE = "shadow";
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
  h.state.s3Puts.length = 0;
  h.state.workflowDefs = defsConfig(true);
  h.state.dagAuditCalls.length = 0;
  h.state.dagAuditRecorded = false;

  // No PR → the D1.5 pre-dispatch guard proceeds; branch/compare probes 404.
  vi.stubGlobal("fetch", async (url) => {
    const u = String(url);
    if (u.includes("/pulls?")) return { ok: true, status: 200, text: async () => "[]" };
    return { ok: false, status: 404, text: async () => "{}" };
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("realized-graph audit (D3.4) — first development-phase dispatch", () => {
  it("violating graph → one dag_violation event + one store write, dispatch still proceeds", async () => {
    await load();
    h.state.children = VIOLATING_CHILDREN;

    await handler({ Records: [readyRecord()] });

    // Recorded exactly once, with the capped violations + count.
    expect(h.state.dagAuditCalls).toHaveLength(1);
    const audit = h.state.dagAuditCalls[0].audit;
    expect(audit.violationCount).toBe(1);
    expect(audit.violations[0]).toMatchObject({ code: "missing_required_edge", from: "dev", to: "qa" });

    // Exactly one non-fatal event carrying the run + def identity.
    const ev = eventsOfType("workflow.dag_violation");
    expect(ev).toHaveLength(1);
    expect(ev[0].detail).toMatchObject({ workflowId: "wf_1", defId: DEF_ID });
    expect(ev[0].detail.violations[0].code).toBe("missing_required_edge");

    // The audit never blocks dispatch — the agent was still claimed + invoked.
    const s = await store();
    expect(s.claimInvocation).toHaveBeenCalled();
    expect(h.state.lambdaInvokes.length).toBeGreaterThan(0);
  });

  it("audit is one-shot per run — a re-entry short-circuits (no second write, no second event)", async () => {
    await load();
    h.state.children = VIOLATING_CHILDREN;

    await handler({ Records: [readyRecord()] });
    expect(h.state.dagAuditCalls).toHaveLength(1);
    expect(eventsOfType("workflow.dag_violation")).toHaveLength(1);

    // Simulate a re-entry at the dev phase in the SAME warm container: the
    // workflow object now carries the in-memory dagAudit stamp from the first run.
    h.state.workflow.phase = "design"; // force the phase-advance branch to fire again
    await handler({ Records: [readyRecord()] });

    expect(h.state.dagAuditCalls).toHaveLength(1); // no second write
    expect(eventsOfType("workflow.dag_violation")).toHaveLength(1); // no second event
  });

  it("valid graph → the audit is recorded but no violation event fires", async () => {
    await load();
    h.state.children = VALID_CHILDREN;

    await handler({ Records: [readyRecord()] });

    expect(h.state.dagAuditCalls).toHaveLength(1);
    expect(h.state.dagAuditCalls[0].audit.violationCount).toBe(0);
    expect(eventsOfType("workflow.dag_violation")).toHaveLength(0);

    const s = await store();
    expect(s.claimInvocation).toHaveBeenCalled();
  });

  it("def without a ticketDag → pure no-op (no store write, no event)", async () => {
    await load();
    h.state.workflowDefs = defsConfig(false); // def declares no ticketDag
    h.state.children = VIOLATING_CHILDREN; // would violate IF audited

    await handler({ Records: [readyRecord()] });

    expect(h.state.dagAuditCalls).toHaveLength(0);
    expect(eventsOfType("workflow.dag_violation")).toHaveLength(0);

    const s = await store();
    expect(s.claimInvocation).toHaveBeenCalled(); // dispatch unaffected
  });
});
