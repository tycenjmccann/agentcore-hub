import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import workflowsConfig from "../../src/config/workflows.json";

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
    // TEAM-4121 FR-9: S3 objects the mock will serve, and every S3 command it
    // saw. The GetObject count is the assertion that turning LIVE_REVERIFY on
    // does not add a second `completions/<id>.json` read to the done path.
    s3Objects: /** @type {Record<string, any>} */ ({}),
    s3Cmds: /** @type {{op: string, key: string}[]} */ ([]),
    ticketGets: /** @type {string[]} */ ([]), // GetCommand ticketIds (tickets table)
    store: {
      completeTaskEntry: /** @type {any[]} */ ([]),
      claimInvocation: /** @type {any[]} */ ([]),
      appendReviewNotificationOnce: /** @type {any[]} */ ([]),
      ackNotifications: /** @type {any[]} */ ([]),
      mergeTaskMetadata: /** @type {any[]} */ ([]),
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
            h.state.ticketGets.push(cmd.input.Key.ticketId);
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
  LambdaClient: class {
    async send(cmd) {
      h.state.lambdaInvokes.push(cmd.input);
      // invokeTickets READS the response (it needs the new key back), so the
      // tickets-tools Lambda has to answer or every create_ticket looks failed.
      let payload = null;
      try { payload = JSON.parse(cmd.input?.Payload || "{}"); } catch { /* agent invokes */ }
      if (typeof payload?.tool_name === "string" && payload.tool_name.startsWith("Tickets___create_ticket")) {
        return { Payload: new TextEncoder().encode(JSON.stringify({ key: "TEAM-4200" })) };
      }
      return {};
    }
  },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));
// Serves h.state.s3Objects and counts every command. Empty by default, and a
// miss throws NoSuchKey — the same non-fatal outcome as the previous no-send
// stub, so every pre-4121 test in this file is unaffected.
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      const key = cmd.input?.Key || "";
      h.state.s3Cmds.push({ op: cmd.constructor.name, key });
      if (cmd.constructor.name !== "GetObjectCommand" || !(key in h.state.s3Objects)) {
        const err = new Error(`NoSuchKey: ${key}`);
        err.name = "NoSuchKey";
        throw err;
      }
      const body = h.state.s3Objects[key];
      return { Body: { transformToString: async () => (typeof body === "string" ? body : JSON.stringify(body)) } };
    }
  },
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
  // TEAM-3966: a human gate going done (approve) must ack its review_needed.
  ackNotifications: vi.fn(async (wfId, predicate) => { h.state.store.ackNotifications.push({ wfId, predicate }); }),
  // TEAM-4121 FR-9: the scoped task-metadata merge behind harvestCompletionEvidence
  // and the live-reverify markers. Applied to the in-memory row like the real
  // store does, so the assertions can read agentTasks rather than a call log.
  mergeTaskMetadata: vi.fn(async (wfId, tid, fields) => {
    h.state.store.mergeTaskMetadata.push({ wfId, tid, fields });
    if (h.state.workflow?.id === wfId && h.state.workflow.agentTasks?.[tid]) {
      Object.assign(h.state.workflow.agentTasks[tid], fields);
    }
  }),
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
let handler;

async function load() {
  vi.resetModules();
  ({ handleTicketDoneUnified, handleTicketDone, handler } = await import("./index.mjs"));
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
  h.state.store.ackNotifications.length = 0;
  h.state.store.mergeTaskMetadata.length = 0;
  h.state.s3Cmds.length = 0;
  h.state.ticketGets.length = 0;
  h.state.s3Objects = {};
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

/**
 * TEAM-3747 D1 — the scheduled reconciliation-sweep sentinel route. A dedicated
 * EventBridge rule fires { source: "orchestrator.sweep", action:
 * "reconcile_sweep" }; the handler must branch to the reconcile sweep BEFORE any
 * stream/webhook parsing (the event has no Records) and return the sweep's
 * metrics summary — proof the route dispatched the sweep rather than falling
 * through. Default mode is OFF (RECONCILE_SWEEP_MODE unset — TEAM-3763 F2): now
 * that the sweep is SCHEDULED, dark-by-default keeps a fresh deploy byte-
 * identical to pre-epic, so runSweep short-circuits before its first Scan and
 * touches nothing.
 */
describe("reconcile-sweep sentinel route (TEAM-3747 D1)", () => {
  it("routes { orchestrator.sweep, reconcile_sweep } to the sweep and returns its summary", async () => {
    const result = await handler({ source: "orchestrator.sweep", action: "reconcile_sweep" });

    // The sweep ran (returned its metrics), not a stream/webhook path.
    expect(typeof result.sweepId).toBe("string");
    expect(result.mode).toBe("off");    // RECONCILE_SWEEP_MODE unset → dark default (F2)
    expect(result.candidates).toBe(0);  // off short-circuits before the Scan
    // A sweep is not a ticket-done fan-out: no agent dispatch, no board writes.
    expect(h.state.lambdaInvokes).toHaveLength(0);
    expect(h.state.updates).toHaveLength(0);
    expect(eventsOfType("agent.complete")).toHaveLength(0);
  });
});

/**
 * TEAM-3966 — approving a human review gate (gate ticket → done) must
 * acknowledge the gate's open review_needed notification on BOTH done paths.
 * Before this, handleReviewRejection (CHANGES-NEEDED) was the only caller of
 * store.ackNotifications, so an APPROVED gate left review_needed open forever
 * and the watch scheduler's parkedOnHuman() muted the run from the Workflow
 * Manager for the rest of its life.
 */
describe("human gate approved (gate → done) acks its review_needed (TEAM-3966)", () => {
  const HUMAN = "human:reviewer";

  function approvedGateFixture() {
    h.state.tickets[DONE] = { ticketId: DONE, parentId: PARENT, workflowId: "wf_1", assignee: HUMAN, status: "done" };
    h.state.workflow.humanNotifications = [
      { id: "n1", type: "review_needed", ticketId: DONE, acknowledged: false },
    ];
    h.state.children = [
      { ticketId: DONE, parentId: PARENT, status: "done", assignee: HUMAN, type: "task" },
    ];
  }

  function expectAckedExactlyThisGate() {
    expect(h.state.store.ackNotifications).toHaveLength(1);
    const { wfId, predicate } = h.state.store.ackNotifications[0];
    expect(wfId).toBe("wf_1");
    // Scoped to THIS gate's review_needed — never another gate, never an escalation.
    expect(predicate({ ticketId: DONE, type: "review_needed" })).toBe(true);
    expect(predicate({ ticketId: "GATE-OTHER", type: "review_needed" })).toBe(false);
    expect(predicate({ ticketId: DONE, type: "manager_escalation" })).toBe(false);
    // The done cascade still ran to completion.
    expect(eventsOfType("agent.complete").some((e) => e.detail.ticketId === DONE)).toBe(true);
  }

  it("Jira-webhook path (handleTicketDoneUnified) acks the approved gate", async () => {
    approvedGateFixture();
    await handleTicketDoneUnified(DONE);
    expectAckedExactlyThisGate();
  });

  it("DDB-stream path (handleTicketDone) acks the approved gate", async () => {
    approvedGateFixture();
    await handleTicketDone(DONE, { parentId: PARENT, workflowId: "wf_1", assignee: HUMAN });
    expectAckedExactlyThisGate();
  });

  it("an AGENT ticket going done does not touch notifications", async () => {
    inReviewChildren();
    await handleTicketDoneUnified(DONE); // DONE is assigned to DEV
    expect(h.state.store.ackNotifications).toHaveLength(0);
  });
});

/**
 * TEAM-4121 FR-9 — the live-reverify hook's GATING in both done twins.
 *
 * live-reverify.test.mjs pins the module's decisions and
 * replay-yteqfl-reverify.test.mjs replays the real failure through it; neither
 * proves the hook is wired into the REAL handlers, nor — the part that decides
 * whether this flag is safe to ship dark — that an unset LIVE_REVERIFY costs
 * NOTHING. "Nothing" is measurable here: the done path already reads
 * `completions/<id>.json` once for harvestCompletionEvidence, so the flag must
 * not add a second GET (index.mjs memoizes the record per invocation), and a
 * non-fix ticket must not reach the module at all even under enforce.
 */
describe("live-reverify hook gating in both done twins (TEAM-4121 FR-9)", () => {
  const FIX = "TEAM-9089";
  const HEAD = "0949f9d881423ac7fe00a70e23d60fff5654078c";
  const COMPLETIONS_KEY = `completions/${FIX}.json`;

  /** Reload index.mjs with the flag set (both are read at module load). */
  async function loadWithLiveReverify(mode) {
    process.env.ARTIFACT_BUCKET = "test-bucket";
    if (mode === undefined) delete process.env.LIVE_REVERIFY;
    else process.env.LIVE_REVERIFY = mode;
    await load();
  }

  afterEach(() => {
    delete process.env.LIVE_REVERIFY;
    delete process.env.ARTIFACT_BUCKET;
  });

  /**
   * A qa_fix that declared live evidence and closed with a prose-only completion
   * record — the exact shape the FR fires on. Seeded on the board (the stream
   * twin re-reads the normalized row) and in S3.
   */
  function liveFixFixture() {
    h.state.tickets[FIX] = {
      ticketId: FIX, parentId: PARENT, workflowId: "wf_1", assignee: DEV, status: "done",
      title: "Fix (QA): the 403 detail leaks the SDK placeholder name",
      phase: "development",
      spawnedBy: { kind: "qa_fix", qaTicketId: "TEAM-9064" },
      fixContract: {
        invariant: "the error detail never contains the placeholder name",
        evidenceSource: "live",
        evidenceRepro: "POST /api/workflow/start with an unreadable s3:// source",
        citedLocation: ["src/lib/workflow/intake.ts:212"],
        siblingScope: "none",
      },
    };
    h.state.children = [{ ...h.state.tickets[FIX], type: "task" }];
    // The fix's own task row, so harvestCompletionEvidence has somewhere to land
    // the commit sha the re-verification pins to.
    h.state.workflow.agentTasks[FIX] = {
      id: "task_fix", agentId: DEV, ticketId: FIX, status: "running", startedAt: STALE_STARTED,
    };
    h.state.s3Objects[COMPLETIONS_KEY] = {
      ticket_id: FIX, summary: "Filtered the placeholder and added a regression test.",
      commit_sha: HEAD, branch: `feature/${FIX}-bug-fixer`,
    };
  }

  const getsOf = (key) => h.state.s3Cmds.filter((c) => c.op === "GetObjectCommand" && c.key === key);
  const fixEvents = () => h.state.events.filter((e) => String(e.type || "").startsWith("fix."));
  const createTicketInvokes = () =>
    h.state.lambdaInvokes.filter((i) => {
      try { return String(JSON.parse(i.Payload).tool_name || "").startsWith("Tickets___create_ticket"); }
      catch { return false; }
    });

  describe("unset (the shipped default) — byte-identical", () => {
    it.each([
      ["webhook twin", (id) => handleTicketDoneUnified(id)],
      ["stream twin", (id) => handleTicketDone(id, { parentId: PARENT, workflowId: "wf_1", assignee: DEV })],
    ])("%s: a live fix closes with ONE completions read and no live-reverify effect", async (_label, run) => {
      await loadWithLiveReverify(undefined);
      liveFixFixture();

      await run(FIX);

      // The one read harvestCompletionEvidence always did — and no second one.
      expect(getsOf(COMPLETIONS_KEY)).toHaveLength(1);
      expect(fixEvents()).toEqual([]);
      expect(createTicketInvokes()).toEqual([]);
      expect(h.state.events.some((e) => e.detail?.ticketId === FIX && e.type === "agent.complete")).toBe(true);
      // Harvest still landed the sha, so the ONLY difference under enforce is the
      // re-verification itself, not the evidence bookkeeping.
      expect(h.state.workflow.agentTasks[FIX].commitSha).toBe(HEAD);
      expect(h.state.workflow.agentTasks[FIX].verification).toBeUndefined();
    });

    it("stream twin: with both observer flags off the normalized ticket is never re-read", async () => {
      await loadWithLiveReverify(undefined);
      liveFixFixture();

      await handleTicketDone(FIX, { parentId: PARENT, workflowId: "wf_1", assignee: DEV });

      // The stream path works off the DDB image; the extra getTicket exists only
      // to give the two observers a normalized row (index.mjs guards it with
      // `REWORK_LOOP_CAP !== "off" || LIVE_REVERIFY !== "off"`).
      expect(h.state.ticketGets.filter((id) => id === FIX)).toEqual([]);
    });
  });

  describe("enforce", () => {
    it.each([
      ["webhook twin", (id) => handleTicketDoneUnified(id)],
      ["stream twin", (id) => handleTicketDone(id, { parentId: PARENT, workflowId: "wf_1", assignee: DEV })],
    ])("%s: the hook fires and still reads completions/ exactly ONCE", async (_label, run) => {
      await loadWithLiveReverify("enforce");
      liveFixFixture();

      await run(FIX);

      // The point of the per-invocation memo: harvest and the hook share one GET.
      expect(getsOf(COMPLETIONS_KEY)).toHaveLength(1);

      // The hook actually reached the module through the real handler.
      expect(fixEvents().map((e) => e.type)).toEqual(["fix.unverified", "fix.reverify_created"]);
      expect(createTicketInvokes()).toHaveLength(1);
      const params = JSON.parse(createTicketInvokes()[0].Payload).parameters;
      expect(params.summary).toBe(`Re-verify (QA): ${h.state.tickets[FIX].title} @ 0949f9d`);
      expect(params.blocked_by).toEqual([FIX]);
      expect(params.assignee).toBe("agentcore_hub_qa_verifier");
      // The workflow row carries both markers: the one the ship context renders
      // from, and the one that makes a re-Done at this head a no-op.
      expect(h.state.workflow.agentTasks[FIX]).toMatchObject({
        commitSha: HEAD,
        verification: "unverified",
        reverifyTicketId: "TEAM-4200",
        reverifySha: "0949f9d",
      });
      // …and the done cascade still finished.
      expect(h.state.events.some((e) => e.detail?.ticketId === FIX && e.type === "agent.complete")).toBe(true);
    });

    it.each([
      ["webhook twin", (id) => handleTicketDoneUnified(id)],
      ["stream twin", (id) => handleTicketDone(id, streamImage())],
    ])("%s: a NON-fix ticket never reaches the module", async (_label, run) => {
      await loadWithLiveReverify("enforce");
      inProgressChildren();
      // The ordinary dev ticket of the (a) scenario: no spawnedBy, no contract.
      h.state.s3Objects[`completions/${DONE}.json`] = { ticket_id: DONE, summary: "shipped", commit_sha: HEAD };

      await run(DONE);

      expect(fixEvents()).toEqual([]);
      expect(createTicketInvokes()).toEqual([]);
      // Still just the harvest read — observeLiveReverify returns on the
      // FIX_KINDS check, BEFORE readCompletionRecord.
      expect(getsOf(`completions/${DONE}.json`)).toHaveLength(1);
      // And the cascade the rest of this file covers is untouched.
      expectStaleLeaseRedispatch();
    });
  });
});

// TEAM-4155 — the stream twin's artifact-chain gate must (1) still enforce for a
// playbook run and (2) do so WITHOUT re-reading the ticket: the pre-fix code fed
// the gate `await getTicket(ticketId)`, an unconditional tickets-table read that
// broke the TEAM-4121 FR-9 "never re-read while observers are off" invariant even
// when the gate fired. The fix builds the gate's ticket from the DDB stream image
// (ticketId/assignee/title — everything the gate consumes), symmetric with the
// webhook twin. This proves the gate itself still bounces a missing artifact.
describe("artifact-chain gate — stream twin builds the ticket from the image (TEAM-4155)", () => {
  const INTAKE = "agentcore_hub_requirements_analyst"; // owes intent.md + spec.md on sdlc-playbook
  const SPEC = "TEAM-7001"; // the intake ticket that just closed
  let realFetch;

  beforeEach(async () => {
    realFetch = global.fetch;
    process.env.GITHUB_PAT = "test-pat";
    // loadWorkflowDefs early-returns unless ARTIFACT_BUCKET is set (read at module
    // load), and it reads the def from config/workflows.json — so set the bucket
    // before load() and serve the real config to the S3 mock.
    process.env.ARTIFACT_BUCKET = "test-bucket";
    h.state.s3Objects["config/workflows.json"] = workflowsConfig;
    // A playbook run: sdlc-playbook declares the artifact chain, on a real repo
    // with a shared feature branch so the gate can actually probe GitHub.
    h.state.workflow = {
      id: "wf_1", workflowId: "wf_1", epicId: PARENT,
      workflowDefId: "sdlc-playbook",
      featureBranch: "feature/wf_1-shared",
      repoConfig: { repos: [{ url: "https://github.com/acme/widgets" }] },
      input: { title: "t" }, humanNotifications: [], agentTasks: {},
    };
    await load();
    // getEffectiveWorkflowDef reads the memoized _workflowDefs; nothing on the
    // done path loads it, so seed it explicitly (same seam completion-gates uses).
    const mod = await import("./index.mjs");
    await mod.loadWorkflowDefs();
  });

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.GITHUB_PAT;
    delete process.env.ARTIFACT_BUCKET;
  });

  it("bounces the intake ticket to Blocked when its artifacts are missing, with zero ticket re-reads", async () => {
    // Every contents-API probe 404s → intent.md/spec.md are not on the branch.
    global.fetch = vi.fn(async () => ({
      ok: false, status: 404, text: async () => JSON.stringify({ message: "Not Found" }),
    }));

    await handleTicketDone(SPEC, { parentId: PARENT, workflowId: "wf_1", assignee: INTAKE, title: "Author the spec" });

    // (1) Gate fired: the early return preempted markTaskComplete (no completeTaskEntry),
    // and it published artifact_chain.missing naming both owed artifacts.
    expect(h.state.store.completeTaskEntry).toEqual([]);
    const missing = h.state.events.find((e) => e.type === "artifact_chain.missing");
    expect(missing).toBeTruthy();
    expect(missing.detail.missing).toEqual(["intent.md", "spec.md"]);
    // …and it re-opened the ticket to blocked.
    expect(h.state.updates.some((u) =>
      u.Key?.ticketId === SPEC && u.ExpressionAttributeValues?.[":s"] === "blocked")).toBe(true);
    // (2) The gate used the in-hand image — no tickets-table GET at all (the FR-9
    // invariant holds even on the path where the gate DOES fire).
    expect(h.state.ticketGets).toEqual([]);
    // It probed GitHub for the two owed artifacts and nothing else.
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
