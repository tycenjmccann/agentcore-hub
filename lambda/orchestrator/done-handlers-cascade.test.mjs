import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-3688 (QA finding F3) — HANDLER-LEVEL cascade coverage.
 *
 * The orchestrator has TWO "ticket done" entry points that must BOTH fan a
 * completion out through the shared unblock cascade:
 *   - handleTicketDoneUnified  (Jira-webhook path)
 *   - handleTicketDone         (DDB-stream path)
 *
 * cascade.test.mjs pins createCascade().cascadeUnblock in isolation, and its
 * "both call sites" test drives the shared helper TWICE with hand-built DI — it
 * never invokes the real handlers. So a future edit that bypassed the cascade in
 * ONE handler (the exact divergence TEAM-3618 D3 fixed) would slip through.
 *
 * These tests close that gap: they invoke the REAL handleTicketDoneUnified and
 * REAL handleTicketDone from index.mjs and let them drive the REAL cascade
 * (cascade.mjs is NOT mocked, nor is lease.mjs). Only the I/O seams are mocked —
 * the AWS SDK clients and workflow-store — same harness as
 * review-rejection.test.mjs / completion-gates.test.mjs. For each handler we
 * cover both AC scenarios with the extended-states flag ON:
 *   (a) a dependent parked in_progress with a STALE lease → the cascade steals
 *       the stale lease and re-dispatches (the agent invoker fires for the gate);
 *   (b) a dependent parked in_review → the cascade re-wakes the human gate
 *       (review.reawakened + a fresh reviewer notification).
 * Each asserts the dispatch/re-wake actually happened, not just that the handler
 * was entered.
 */

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    children: /** @type {any[]} */ ([]),
    workflow: /** @type {any} */ (null),
    // Captured effects.
    lambdaInvokes: /** @type {any[]} */ ([]), // the agent invoker (dispatch)
    ebEvents: /** @type {any[]} */ ([]),
    events: /** @type {any[]} */ ([]), // events-table Put items (parsed detail)
    updates: /** @type {any[]} */ ([]), // ticket/workflow UpdateCommand inputs
    store: {
      completeTaskEntry: /** @type {any[]} */ ([]),
      claimInvocation: /** @type {any[]} */ ([]),
      appendReviewNotificationOnce: /** @type {any[]} */ ([]),
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
          const table = cmd.input.TableName;
          if (name === "GetCommand") {
            return { Item: h.state.tickets[cmd.input.Key.ticketId] || null };
          }
          if (name === "QueryCommand") {
            // lease.lastAgentActivity reads the EVENTS table → no heartbeat, so
            // every lease reads as stale. getChildTickets (and the completion
            // snapshot) read the TICKETS parentId-index → the sibling set.
            if (table === "agentcore-hub-events") return { Items: [] };
            return { Items: h.state.children };
          }
          if (name === "UpdateCommand") { h.state.updates.push(cmd.input); return {}; }
          if (name === "PutCommand") { h.state.events.push(cmd.input.Item); return {}; }
          if (name === "ScanCommand") return { Items: [] };
          return {};
        },
      }),
    },
  };
});

// The agent invoker: invokeAgent fires the async Lambda InvokeCommand. Capturing
// its input IS how we prove a re-dispatch reached the gate ticket.
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class { async send(cmd) { h.state.lambdaInvokes.push(cmd.input); return {}; } },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {}, // no send → context-builder S3 reads are caught + non-fatal
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; } },
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
  getWorkflow: vi.fn(async (id) => (h.state.workflow?.id === id ? h.state.workflow : null)),
  completeTaskEntry: vi.fn(async (wfId, tid) => { h.state.store.completeTaskEntry.push({ wfId, tid }); }),
  // redispatch → claimTicketInvocation: winning the claim is what lets the
  // re-dispatch proceed to invokeAgent.
  claimInvocation: vi.fn(async (wfId, tid) => { h.state.store.claimInvocation.push({ wfId, tid }); return true; }),
  // in_review re-wake → handleHumanReviewGate: returning truthy means THIS call
  // (re)notified, which is what makes the cascade emit review.reawakened.
  appendReviewNotificationOnce: vi.fn(async (wfId, tid) => { h.state.store.appendReviewNotificationOnce.push({ wfId, tid }); return true; }),
  setTaskStatus: vi.fn(async () => {}), // only touched on an invoke failure
}));

// cascade.mjs and lease.mjs are deliberately NOT mocked — the point of these
// tests is that the REAL handlers drive the REAL cascade + REAL lease logic.

// Extended states (commit 4b) must be ON so an in_progress/in_review dependent
// is acted on; read at module load, so set BEFORE the dynamic import.
process.env.CASCADE_EXTENDED_STATES = "on";
// Give the re-dispatched dev agent a runtime ARN so invokeAgent takes the
// happy dispatch path (no ARN → it blocks the ticket instead of invoking).
process.env.RUNTIME_ARN_AGENTCORE_HUB_BACKEND_DEV =
  "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/backend-dev";

let handleTicketDoneUnified;
let handleTicketDone;

async function load() {
  vi.resetModules();
  ({ handleTicketDoneUnified, handleTicketDone } = await import("./index.mjs"));
}

const DONE = "TEAM-1"; // the ticket that just closed
const PARENT = "EPIC-1";
const DEV = "agentcore_hub_backend_dev"; // development-phase roster agent
const GATE = "GATE-1";
const IN_PROGRESS_DEP = "TEAM-2";
// Far enough in the past that any lease reads stale (TTL is 30 min).
const STALE_STARTED = "2020-01-01T00:00:00Z";

// A workflow whose in_progress dependent carries a stale running claim. Rebuilt
// per test because markTaskComplete mutates workflow.agentTasks in place.
function makeWorkflow() {
  return {
    id: "wf_1",
    workflowId: "wf_1",
    epicId: PARENT,
    workflowDefId: "software-delivery",
    input: { title: "t" },
    humanNotifications: [],
    agentTasks: {
      [IN_PROGRESS_DEP]: {
        id: "task_t2", agentId: DEV, ticketId: IN_PROGRESS_DEP,
        status: "running", startedAt: STALE_STARTED,
      },
    },
  };
}

const eventsOfType = (type) => h.state.events.filter((e) => e.type === type);
const lambdaInvokeForTicket = (ticketId) =>
  h.state.lambdaInvokes.filter((i) => {
    try { return JSON.parse(i.Payload).ticketId === ticketId; } catch { return false; }
  });

beforeEach(async () => {
  h.state.tickets = {
    // The just-closed ticket (only handleTicketDoneUnified re-reads it).
    [DONE]: { ticketId: DONE, parentId: PARENT, workflowId: "wf_1", assignee: DEV, status: "done" },
  };
  h.state.children = [];
  h.state.workflow = makeWorkflow();
  h.state.lambdaInvokes.length = 0;
  h.state.ebEvents.length = 0;
  h.state.events.length = 0;
  h.state.updates.length = 0;
  h.state.store.completeTaskEntry.length = 0;
  h.state.store.claimInvocation.length = 0;
  h.state.store.appendReviewNotificationOnce.length = 0;
  await load();
});

// The stream-path image is unwrapped by unwrapDdbValue, which passes plain
// values through — so a plain object stands in for the DDB stream NewImage.
const streamImage = () => ({ parentId: PARENT, workflowId: "wf_1", assignee: DEV });

// Scenario (a): dependent parked in_progress with a stale lease.
function inProgressChildren() {
  h.state.children = [
    { ticketId: DONE, parentId: PARENT, status: "done", assignee: DEV, type: "task" },
    { ticketId: IN_PROGRESS_DEP, parentId: PARENT, status: "in_progress", assignee: DEV, blockedBy: [DONE], type: "task" },
  ];
}

// Scenario (b): dependent parked in_review (a human-review gate).
function inReviewChildren() {
  h.state.children = [
    { ticketId: DONE, parentId: PARENT, status: "done", assignee: DEV, type: "task" },
    { ticketId: GATE, parentId: PARENT, status: "in_review", assignee: "human:reviewer", blockedBy: [DONE], type: "task" },
  ];
}

/**
 * Shared assertions — the real cascade stole the stale lease and re-dispatched
 * the in_progress gate through the normal invoke path.
 */
function expectStaleLeaseRedispatch() {
  // The agent invoker fired for the gate ticket — the dispatch.
  expect(lambdaInvokeForTicket(IN_PROGRESS_DEP)).toHaveLength(1);
  // The stale claim was won before dispatch, and the journal recorded the invoke.
  expect(h.state.store.claimInvocation).toContainEqual({ wfId: "wf_1", tid: IN_PROGRESS_DEP });
  const invoked = eventsOfType("orchestrator.agent_invoked").filter((e) => e.detail.ticketId === IN_PROGRESS_DEP);
  expect(invoked).toHaveLength(1);
  // The closed ticket still published its own completion (handler ran to the end).
  expect(eventsOfType("agent.complete").some((e) => e.detail.ticketId === DONE)).toBe(true);
}

/**
 * Shared assertions — the real cascade re-woke the in_review human gate (no
 * agent invoked; the "dispatch" here is the reviewer re-notification + event).
 */
function expectGateReawakened() {
  expect(h.state.store.appendReviewNotificationOnce).toContainEqual({ wfId: "wf_1", tid: GATE });
  expect(eventsOfType("review.reawakened").filter((e) => e.detail.gateTicketId === GATE)).toHaveLength(1);
  expect(eventsOfType("review.needed").filter((e) => e.detail.ticketId === GATE)).toHaveLength(1);
  // A human gate is re-woken, never invoked as an agent.
  expect(h.state.lambdaInvokes).toHaveLength(0);
  expect(eventsOfType("agent.complete").some((e) => e.detail.ticketId === DONE)).toBe(true);
}

describe("handleTicketDoneUnified (Jira-webhook path) drives the real cascade", () => {
  it("(a) in_progress dependent, stale lease → cascade steals + re-dispatches the gate", async () => {
    inProgressChildren();
    await handleTicketDoneUnified(DONE);
    expectStaleLeaseRedispatch();
  });

  it("(b) in_review dependent → cascade re-wakes the human gate", async () => {
    inReviewChildren();
    await handleTicketDoneUnified(DONE);
    expectGateReawakened();
  });
});

describe("handleTicketDone (DDB-stream path) drives the real cascade", () => {
  it("(a) in_progress dependent, stale lease → cascade steals + re-dispatches the gate", async () => {
    inProgressChildren();
    await handleTicketDone(DONE, streamImage());
    expectStaleLeaseRedispatch();
  });

  it("(b) in_review dependent → cascade re-wakes the human gate", async () => {
    inReviewChildren();
    await handleTicketDone(DONE, streamImage());
    expectGateReawakened();
  });
});
