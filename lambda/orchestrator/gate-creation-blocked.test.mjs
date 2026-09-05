import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-4045 / TEAM-4047 — a freshly created, never-reviewed human merge-approval
 * gate must NOT be treated as "Request changes".
 *
 * Observed in prod (Jira provider): the agentcore-hub-jira Lambda routes a new
 * ticket that has blockers To Do -> Blocked at creation time
 * (reconcileBlockersAndStatus). Jira fires `{oldStatus:"todo", newStatus:"blocked"}`
 * for that hop; the orchestrator's `case "blocked"` only checks the assignee is
 * "human:*" and calls handleReviewRejection, which (onReject:"rework") forces the
 * gate's upstream Ship ticket Blocked -> To Do -> Ready and the Ready webhook
 * dispatches the release manager while its own blockers (review/QA/CI) are still
 * open. The release manager parks the ticket -> blocked without report_completion
 * and agentTasks[ship] is left `running`, so the legitimate later re-dispatch is
 * refused as "already claimed".
 *
 * Same harness as review-rejection.test.mjs: index.mjs imported for real; only
 * the AWS SDK clients, workflow-store, and review-cap seams are mocked. The Jira
 * suites route global.fetch by URL with a STATEFUL issue map so a transition
 * POST is visible to the next read, and every transition also queues the
 * webhook Jira would fire for it (deliverQueuedWebhooks() replays them through
 * the handler — this is how the chain test observes the downstream dispatch).
 *
 * Three fixes are pinned here (none implemented by this file):
 *   1. from-state guard: a creation-time block (todo / new / missing from-state,
 *      or a DDB INSERT) never reaches handleReviewRejection — both entry points
 *      (processStatusChange + processRecord). Owned by TEAM-4044's
 *      isCreationTimeBlock (main, #364); a PRESENTED gate (ready / in_progress /
 *      in_review -> blocked) is honored as a rejection.
 *   2. rework reopen guard: an upstream ticket whose own blockedBy contains a
 *      non-done ticket is not re-Readied (Jira) / not status-rewritten (DDB), and
 *      review.rejected.reopened reflects what actually happened.
 *   3. lease housekeeping: an agent ticket in_progress -> blocked whose OWN
 *      blockers are still open (the premature-dispatch signature) releases the
 *      running claim through the stealClaim CAS so a later Ready dispatches
 *      normally. TEAM-4071 F1: a ticket whose blockers are all resolved (or
 *      empty) keeps its claim — the agent may be live. TEAM-4071 F2: the CAS is
 *      asserted on its real shape, and a lost CAS
 *      (ConditionalCheckFailedException) releases nothing.
 */

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    workflow: /** @type {any} */ (null),
    updates: /** @type {any[]} */ ([]),
    events: /** @type {any[]} */ ([]),
    ebEvents: /** @type {any[]} */ ([]),
    lambdaInvokes: /** @type {any[]} */ ([]),
    claimAttempts: /** @type {any[]} */ ([]),
    storeCalls: /** @type {any[]} */ ([]),
    enforce: /** @type {any} */ (null),
    jira: /** @type {any} */ (null),
    // TEAM-4071 F2: when true, the workflows-table steal CAS (lease.mjs
    // stealClaim) loses — a concurrent writer moved the claim generation.
    failSteal: false,
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
          if (name === "ScanCommand") return { Items: [] }; // findCodingSession -> none
          if (name === "UpdateCommand") {
            h.state.updates.push(cmd.input);
            if (h.state.failSteal && cmd.input.UpdateExpression === "SET agentTasks.#tid.#st = :ready") {
              throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
            }
            // Keep the in-memory tickets table honest for follow-up reads.
            const key = cmd.input.Key?.ticketId;
            const s = cmd.input.ExpressionAttributeValues?.[":s"];
            if (key && s && h.state.tickets[key] && /SET .*#s = :s/.test(cmd.input.UpdateExpression || "")) {
              h.state.tickets[key].status = s;
            }
            return {};
          }
          if (name === "PutCommand") { h.state.events.push(cmd.input.Item); return {}; }
          if (name === "QueryCommand") return { Items: [] };
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd) {
      if (cmd.constructor.name === "InvokeCommand") {
        let payload = null;
        try { payload = JSON.parse(cmd.input.Payload); } catch { /* ignore */ }
        h.state.lambdaInvokes.push({ FunctionName: cmd.input.FunctionName, payload });
      }
      return {};
    }
  },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      if (cmd.constructor.name === "GetObjectCommand") throw new Error("NoSuchKey");
      return {};
    }
  },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; } },
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

// In-memory workflow store: agentTasks live on h.state.workflow so the claim
// CAS (claimInvocation), creation tracking, and status writes are observable.
vi.mock("./workflow-store.mjs", () => {
  const wf = () => h.state.workflow;
  const tasks = () => {
    const w = wf();
    if (!w.agentTasks) w.agentTasks = {};
    return w.agentTasks;
  };
  return {
    initWorkflowStore: vi.fn(() => {}),
    getWorkflow: vi.fn(async (id) => (wf()?.id === id ? wf() : null)),
    ackNotifications: vi.fn(async (_id, pred) => {
      for (const n of wf()?.humanNotifications || []) if (pred(n)) n.acknowledged = true;
    }),
    setResumeContext: vi.fn(async (_id, tid, note) => {
      const w = wf();
      if (!w.resumeContexts) w.resumeContexts = {};
      w.resumeContexts[tid] = note;
    }),
    removeResumeContext: vi.fn(async (_id, tid) => { if (wf()?.resumeContexts) delete wf().resumeContexts[tid]; }),
    // Same predicate as the real store: free unless a RUNNING claim younger
    // than staleBefore holds the slot.
    claimInvocation: vi.fn(async (_id, tid, entry, staleBefore) => {
      const t = tasks();
      const cur = t[tid];
      const ok = !cur || cur.status !== "running" || (cur.startedAt || "") < staleBefore;
      h.state.claimAttempts.push({ ticketId: tid, ok, prior: cur ? { ...cur } : null });
      if (ok) t[tid] = { ...entry };
      return ok;
    }),
    trackTicket: vi.fn(async (_id, tid, entry) => {
      const t = tasks();
      if (t[tid]) return false;
      t[tid] = { ...entry };
      return true;
    }),
    setTaskStatus: vi.fn(async (_id, tid, status) => {
      const t = tasks();
      if (t[tid]) t[tid].status = status;
      h.state.storeCalls.push({ op: "setTaskStatus", ticketId: tid, status });
    }),
    putTaskEntry: vi.fn(async (_id, tid, entry) => { tasks()[tid] = { ...entry }; }),
    completeTaskEntry: vi.fn(async (_id, tid, seed) => {
      const t = tasks();
      t[tid] = { ...(t[tid] || seed || {}), status: "complete" };
    }),
    mergeTaskMetadata: vi.fn(async () => {}),
    advancePhase: vi.fn(async (_id, phase, featureBranch) => {
      wf().phase = phase;
      if (featureBranch) wf().featureBranch = featureBranch;
    }),
    adoptFeatureBranch: vi.fn(async () => {}),
    appendNotification: vi.fn(async (_id, n) => {
      const w = wf();
      if (!w.humanNotifications) w.humanNotifications = [];
      w.humanNotifications.push(n);
    }),
    appendReviewNotificationOnce: vi.fn(async (_id, tid, n) => {
      const w = wf();
      if (!w.humanNotifications) w.humanNotifications = [];
      if (w.humanNotifications.some((x) => x.ticketId === tid && x.type === "review_needed" && !x.acknowledged)) return false;
      w.humanNotifications.push(n);
      return true;
    }),
    resetDeadSessionRetry: vi.fn(async () => {}),
    incrementDeadSessionRetry: vi.fn(async () => 1),
    markDeadSessionDetected: vi.fn(async () => true),
    clearDeadSessionDetected: vi.fn(async () => true),
    claimTerminalOutcome: vi.fn(async () => false),
    completeWorkflow: vi.fn(async () => {}),
    markFinalized: vi.fn(async () => {}),
    claimFinalization: vi.fn(async () => false),
    createWorkflow: vi.fn(async () => {}),
    setRepoCheck: vi.fn(async () => {}),
    appendReviewRound: vi.fn(async () => {}),
    appendReviewCapEscalation: vi.fn(async () => {}),
    appendReviewAuthorization: vi.fn(async () => {}),
  };
});

vi.mock("./review-cap.mjs", async () => {
  const actual = await vi.importActual("./review-cap.mjs");
  return {
    parseDecision: actual.parseDecision,
    createReviewCap: () => ({ enforce: (...args) => h.state.enforce(...args) }),
  };
});

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const RM = "agentcore_hub_release_manager";
const API_DEV = "agentcore_hub_api_dev";
const BACKEND_DEV = "agentcore_hub_backend_dev";
const QA = "agentcore_hub_qa_verifier";
const CI = "agentcore_hub_ci_agent";

// Jira status names <-> orchestrator internal statuses (mirrors mapJiraStatus
// in index.mjs and the webhook route's mapJiraStatusToInternal).
const JIRA_TRANSITIONS = [
  { id: "11", name: "To Do", to: { name: "To Do" } },
  { id: "21", name: "Ready", to: { name: "Ready" } },
  { id: "31", name: "In Progress", to: { name: "In Progress" } },
  { id: "41", name: "In Review", to: { name: "In Review" } },
  { id: "51", name: "Blocked", to: { name: "Blocked" } },
  { id: "61", name: "Done", to: { name: "Done" } },
];
const INTERNAL = { "To Do": "todo", "Ready": "ready", "In Progress": "in_progress", "In Review": "in_review", "Blocked": "blocked", "Done": "done" };

const jsonResp = (obj, status = 200) => ({ ok: true, status, text: async () => JSON.stringify(obj) });

/** A Jira issue as index.mjs's mapJiraIssueToTicket expects it. */
const jiraIssue = (key, { status, labels = [], blockedBy = [], comments = [], summary = key, parent = "TEAM-1" }) => ({
  key,
  fields: {
    summary,
    status: { name: status },
    labels,
    issuetype: { name: "Task" },
    parent: { key: parent },
    issuelinks: blockedBy.map((k) => ({ type: { inward: "is blocked by" }, inwardIssue: { key: k } })),
    comment: {
      comments: comments.map((c, i) => ({
        author: { displayName: "human" },
        body: { content: [{ content: [{ text: c }] }] },
        created: `2026-09-04T00:0${i}:00.000+0000`,
      })),
    },
  },
});
const agentIssue = (key, agentId, status, blockedBy = [], summary) =>
  jiraIssue(key, { status, labels: [`agent:${agentId}`, "wf:wf_1"], blockedBy, summary });
const humanGateIssue = (key, status, blockedBy, comments = []) =>
  jiraIssue(key, { status, labels: ["human-review", "reviewer:engineer", "wf:wf_1"], blockedBy, comments, summary: "Merge Approval" });

/**
 * Stateful Jira REST router. A transition POST mutates the issue's status
 * (visible to the next GET) and queues the webhook Jira would deliver for it.
 */
function installJiraRouter(issues) {
  h.state.jira = { issues, transitionPosts: [], commentPosts: [], webhookQueue: [] };
  const fetchSpy = vi.fn(async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || "GET").toUpperCase();
    if (u.includes("/rest/api/3/search/jql")) {
      const m = u.match(/parent%20%3D%20([A-Z]+-\d+)|parent = ([A-Z]+-\d+)/);
      const parent = m ? (m[1] || m[2]) : null;
      const children = Object.values(issues).filter((i) => i.fields.parent?.key === parent);
      return jsonResp({ issues: children });
    }
    const m = u.match(/\/rest\/api\/3\/issue\/([A-Z]+-\d+)(\/transitions|\/comment)?/);
    if (!m) return jsonResp({});
    const [, key, sub] = m;
    const issue = issues[key];
    if (sub === "/transitions") {
      if (method === "GET") return jsonResp({ transitions: JIRA_TRANSITIONS });
      const body = JSON.parse(init.body || "{}");
      const target = JIRA_TRANSITIONS.find((t) => t.id === body.transition?.id);
      const from = issue?.fields.status.name;
      h.state.jira.transitionPosts.push({ key, from, to: target?.to.name });
      if (issue && target) {
        issue.fields.status.name = target.to.name;
        h.state.jira.webhookQueue.push({
          source: "jira-webhook", ticketId: key, newStatus: INTERNAL[target.to.name], oldStatus: INTERNAL[from],
        });
      }
      return { ok: true, status: 204, text: async () => "" };
    }
    if (sub === "/comment") {
      if (method === "POST") { h.state.jira.commentPosts.push({ key, body: init.body }); return jsonResp({}, 201); }
      return jsonResp({ comments: [] });
    }
    return issue ? jsonResp(issue) : { ok: false, status: 404, text: async () => "not found" };
  });
  global.fetch = fetchSpy;
  return fetchSpy;
}

const transitionsOn = (key) => (h.state.jira?.transitionPosts || []).filter((t) => t.key === key);
const eventsOf = (type) => h.state.events.filter((e) => e.type === type);
const statusWritesOn = (key) =>
  h.state.updates.filter((u) => u.Key?.ticketId === key && u.ExpressionAttributeValues?.[":s"] !== undefined);
const isLiveClaim = (task) => !!task && ["running", "in_progress"].includes(task.status);
// TEAM-4071 F2: the steal CAS as lease.mjs stealClaim actually builds it. The
// harness leaves WORKFLOWS_TABLE unset, so index.mjs uses its default.
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const stealCommandsFor = (ticketId) =>
  h.state.updates.filter(
    (u) => u.TableName === WORKFLOWS_TABLE &&
      u.ExpressionAttributeNames?.["#tid"] === ticketId &&
      u.UpdateExpression === "SET agentTasks.#tid.#st = :ready"
  );
const expectStealCas = (ticketId, startedAt) => {
  const steals = stealCommandsFor(ticketId);
  expect(steals).toHaveLength(1);
  const [steal] = steals;
  expect(steal.Key).toEqual({ workflowId: "wf_1" });
  expect(steal.ConditionExpression).toBe(
    "agentTasks.#tid.#st IN (:running, :inprog) AND agentTasks.#tid.startedAt = :exp"
  );
  expect(steal.ExpressionAttributeNames).toEqual({ "#tid": ticketId, "#st": "status" });
  expect(steal.ExpressionAttributeValues).toEqual({
    ":ready": "ready", ":running": "running", ":inprog": "in_progress", ":exp": startedAt,
  });
};
const STARTED_AT = "2026-09-05T04:00:00.000Z";

let handler;
let handleReviewRejection;
let releaseClaimOnSelfPark;
let storeMock;

async function importIndex({ provider }) {
  if (provider === "jira") {
    process.env.TICKET_PROVIDER = "jira";
    process.env.JIRA_SITE_URL = "jira.test";
    process.env.JIRA_EMAIL = "bot@test";
    process.env.JIRA_API_TOKEN = "t";
  } else {
    delete process.env.TICKET_PROVIDER;
  }
  vi.resetModules();
  ({ handler, handleReviewRejection, releaseClaimOnSelfPark } = await import("./index.mjs"));
  storeMock = await import("./workflow-store.mjs");
}

/** Replay the webhooks Jira would have delivered for the transitions so far. */
async function deliverQueuedWebhooks(max = 20) {
  let n = 0;
  while (h.state.jira.webhookQueue.length && n++ < max) {
    const wh = h.state.jira.webhookQueue.shift();
    await handler(wh);
  }
}

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  // The workflow-store mock's vi.fn spies survive vi.resetModules — clear their
  // call history so "not called" assertions see only THIS test's calls.
  vi.clearAllMocks();
  h.state.tickets = {};
  h.state.updates.length = 0;
  h.state.events.length = 0;
  h.state.ebEvents.length = 0;
  h.state.lambdaInvokes.length = 0;
  h.state.claimAttempts.length = 0;
  h.state.storeCalls.length = 0;
  h.state.jira = null;
  h.state.failSteal = false;
  // Default cap verdict: not escalated, gating -> the rework reopen path.
  h.state.enforce = vi.fn(async () => ({ escalated: false, gated: true }));
  h.state.workflow = {
    id: "wf_1", epicId: "TEAM-1", workflowDefId: "software-delivery", phase: "development",
    humanNotifications: [], resumeContexts: {}, agentTasks: {},
  };
  // Runtime ARNs so a dispatch reaches the agent-invoker instead of the
  // "no ARN" error branch (which would itself block the ticket).
  for (const a of [RM, API_DEV, BACKEND_DEV, QA, CI]) {
    process.env[`RUNTIME_ARN_${a.toUpperCase()}`] = `arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/${a}`;
  }
  process.env.ADVISORY_APPROVE_BACKOFF_MS = "0";
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  delete process.env.TICKET_PROVIDER;
  delete process.env.JIRA_SITE_URL;
  delete process.env.JIRA_EMAIL;
  delete process.env.JIRA_API_TOKEN;
  delete process.env.ADVISORY_APPROVE_BACKOFF_MS;
  for (const a of [RM, API_DEV, BACKEND_DEV, QA, CI]) delete process.env[`RUNTIME_ARN_${a.toUpperCase()}`];
});

// ─── (a), (c), missing-oldStatus, (e), (f): Jira webhook entry point ─────────

describe("processStatusChange case blocked — Jira webhook entry point (TEAM-4045)", () => {
  // The prod shape: gate TEAM-25 (human:engineer) blockedBy ship TEAM-24
  // (release manager), ship blockedBy CI TEAM-23 which is still open.
  const seedGateAndBlockedShip = () =>
    installJiraRouter({
      "TEAM-23": agentIssue("TEAM-23", CI, "Blocked", ["TEAM-22"], "CI"),
      "TEAM-24": agentIssue("TEAM-24", RM, "Blocked", ["TEAM-23"], "Ship"),
      "TEAM-25": humanGateIssue("TEAM-25", "Blocked", ["TEAM-24"]),
    });

  beforeEach(async () => {
    await importIndex({ provider: "jira" });
  });

  it("(a) creation-time todo -> blocked on a human gate: handleReviewRejection NOT reached, 0 review.rejected, 0 upstream transitions", async () => {
    seedGateAndBlockedShip();

    await handler({ source: "jira-webhook", ticketId: "TEAM-25", newStatus: "blocked", oldStatus: "todo" });

    // Neither of the handler's first side effects happened...
    expect(storeMock.ackNotifications).not.toHaveBeenCalled();
    expect(h.state.enforce).not.toHaveBeenCalled();
    // ...no rejection was recorded...
    expect(eventsOf("review.rejected")).toHaveLength(0);
    // ...and the upstream Ship ticket was not hopped Blocked -> To Do -> Ready.
    expect(transitionsOn("TEAM-24")).toEqual([]);
    expect(h.state.jira.issues["TEAM-24"].fields.status.name).toBe("Blocked");
  });

  it("(a') issue_created shape: oldStatus 'new' -> blocked is creation-time too, same no-op", async () => {
    seedGateAndBlockedShip();

    await handler({ source: "jira-webhook", ticketId: "TEAM-25", newStatus: "blocked", oldStatus: "new" });

    expect(h.state.enforce).not.toHaveBeenCalled();
    expect(eventsOf("review.rejected")).toHaveLength(0);
    expect(transitionsOn("TEAM-24")).toEqual([]);
  });

  it("(c) CONTROL: in_review -> blocked on a human gate reaches handleReviewRejection exactly once (TEAM-3966 F2 pin preserved)", async () => {
    seedGateAndBlockedShip();
    // Short-circuit at the cap so the reopen loop is not exercised here.
    h.state.enforce = vi.fn(async () => ({ escalated: true, effectiveRounds: 3, maxRounds: 3 }));

    await handler({ source: "jira-webhook", ticketId: "TEAM-25", newStatus: "blocked", oldStatus: "in_review" });

    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    expect(h.state.enforce.mock.calls[0][0].gateTicket.assignee).toBe("human:engineer");
    expect(eventsOf("review.rejected")).toHaveLength(1);
  });

  it("oldStatus MISSING on a human gate -> blocked: fails CLOSED (no reopen)", async () => {
    seedGateAndBlockedShip();
    // TEAM-4044 (main, #364) owns the from-state guard: a missing/empty
    // from-state is a creation-time block, full stop — even with an open
    // review_needed notification (the earlier evidence-based fallback on this
    // branch was superseded by that guard and removed).
    h.state.workflow.humanNotifications = [
      { id: "n1", type: "review_needed", ticketId: "TEAM-25", reviewer: "engineer", acknowledged: false, timestamp: "2026-09-04T00:00:00.000Z" },
    ];

    await handler({ source: "jira-webhook", ticketId: "TEAM-25", newStatus: "blocked" });

    expect(h.state.enforce).not.toHaveBeenCalled();
    expect(eventsOf("review.rejected")).toHaveLength(0);
    expect(transitionsOn("TEAM-24")).toEqual([]);
  });

  describe("(e) agent ticket in_progress -> blocked releases the running claim ONLY while its own blockers are open", () => {
    // The TEAM-4045 shape: Ship (TEAM-24) dispatched prematurely while its
    // blocker CI (TEAM-23) is still Blocked; the agent self-parked.
    const seedRunningShip = ({ ciStatus = "Blocked", shipBlockedBy = ["TEAM-23"] } = {}) => {
      installJiraRouter({
        "TEAM-23": agentIssue("TEAM-23", CI, ciStatus, ["TEAM-22"], "CI"),
        // The agent self-parked: Jira already shows Blocked when the webhook lands.
        "TEAM-24": agentIssue("TEAM-24", RM, "Blocked", shipBlockedBy, "Ship"),
      });
      h.state.workflow.agentTasks["TEAM-24"] = {
        id: "task_1", agentId: RM, ticketId: "TEAM-24", status: "running", startedAt: STARTED_AT,
      };
    };
    const blockedWebhook = { source: "jira-webhook", ticketId: "TEAM-24", newStatus: "blocked", oldStatus: "in_progress" };

    it("(e1) blocker open: after the blocked webhook, agentTasks[ticket] no longer reads as a live running claim — via ONE real stealClaim CAS", async () => {
      seedRunningShip();

      await handler(blockedWebhook);

      expect(isLiveClaim(h.state.workflow.agentTasks["TEAM-24"])).toBe(false);
      // Housekeeping must not masquerade as completion or a rejection.
      expect(h.state.workflow.agentTasks["TEAM-24"].status).not.toBe("complete");
      expect(eventsOf("review.rejected")).toHaveLength(0);
      // TEAM-4071 F2: the release IS the lease.mjs stealClaim CAS, on this generation.
      expectStealCas("TEAM-24", STARTED_AT);
      const released = eventsOf("orchestrator.claim_released");
      expect(released).toHaveLength(1);
      expect(released[0].detail).toMatchObject({ ticketId: "TEAM-24", agentId: RM, reason: "agent_self_park", claimStartedAt: STARTED_AT, blockedBy: ["TEAM-23"] });
    });

    it("(e2) a subsequent Ready for that ticket invokes the agent normally (not skipped as already claimed)", async () => {
      seedRunningShip();
      await handler(blockedWebhook);

      // A human moves the parked ticket back to Ready (CI finished meanwhile).
      h.state.jira.issues["TEAM-23"].fields.status.name = "Done";
      h.state.jira.issues["TEAM-24"].fields.status.name = "Ready";
      await handler({ source: "jira-webhook", ticketId: "TEAM-24", newStatus: "ready", oldStatus: "blocked" });

      const invoked = eventsOf("agent.invoked").filter((e) => e.detail.ticketId === "TEAM-24");
      expect(invoked).toHaveLength(1);
      expect(invoked[0].detail.agentId).toBe(RM);
      expect(h.state.lambdaInvokes.filter((i) => i.payload?.ticketId === "TEAM-24")).toHaveLength(1);
      expect(h.state.claimAttempts.filter((c) => c.ticketId === "TEAM-24" && c.ok)).toHaveLength(1);
    });

    it("(e3) TEAM-4071 F1: EMPTY blockedBy (legitimately dispatched, agent may be live) -> claim stays running, no steal, no event", async () => {
      seedRunningShip({ shipBlockedBy: [] });

      await handler(blockedWebhook);

      expect(h.state.workflow.agentTasks["TEAM-24"].status).toBe("running");
      expect(isLiveClaim(h.state.workflow.agentTasks["TEAM-24"])).toBe(true);
      expect(stealCommandsFor("TEAM-24")).toEqual([]);
      expect(h.state.updates.filter((u) => u.TableName === WORKFLOWS_TABLE)).toEqual([]);
      expect(eventsOf("orchestrator.claim_released")).toHaveLength(0);
    });

    it("(e4) TEAM-4071 F1: ALL blockers done (legitimately dispatched) -> claim stays running, no steal, no event", async () => {
      seedRunningShip({ ciStatus: "Done" });

      await handler(blockedWebhook);

      expect(h.state.workflow.agentTasks["TEAM-24"].status).toBe("running");
      expect(isLiveClaim(h.state.workflow.agentTasks["TEAM-24"])).toBe(true);
      expect(stealCommandsFor("TEAM-24")).toEqual([]);
      expect(eventsOf("orchestrator.claim_released")).toHaveLength(0);
    });

    it("(e5) TEAM-4071 F2: the steal CAS loses (claim generation moved) -> nothing released, claim reads as it was, no event", async () => {
      seedRunningShip();
      h.state.failSteal = true;

      await handler(blockedWebhook);

      // The CAS was attempted exactly once, on this generation...
      expectStealCas("TEAM-24", STARTED_AT);
      // ...and lost: the in-memory task is NOT flipped and no event is published.
      expect(h.state.workflow.agentTasks["TEAM-24"].status).toBe("running");
      expect(isLiveClaim(h.state.workflow.agentTasks["TEAM-24"])).toBe(true);
      expect(eventsOf("orchestrator.claim_released")).toHaveLength(0);
    });
  });

  it("(f) chain fix -> review -> QA -> CI -> ship -> human gate: creation-time todo -> blocked on the gate dispatches NOTHING", async () => {
    installJiraRouter({
      "TEAM-20": agentIssue("TEAM-20", API_DEV, "In Progress", [], "Fix"),
      "TEAM-21": agentIssue("TEAM-21", BACKEND_DEV, "Blocked", ["TEAM-20"], "Review"),
      "TEAM-22": agentIssue("TEAM-22", QA, "Blocked", ["TEAM-21"], "QA"),
      "TEAM-23": agentIssue("TEAM-23", CI, "Blocked", ["TEAM-22"], "CI"),
      "TEAM-24": agentIssue("TEAM-24", RM, "Blocked", ["TEAM-23"], "Ship"),
      "TEAM-25": humanGateIssue("TEAM-25", "Blocked", ["TEAM-24"]),
    });
    h.state.workflow.agentTasks = {
      "TEAM-20": { id: "t20", agentId: API_DEV, ticketId: "TEAM-20", status: "running", startedAt: new Date().toISOString() },
      "TEAM-21": { id: "t21", agentId: BACKEND_DEV, ticketId: "TEAM-21", status: "pending" },
      "TEAM-22": { id: "t22", agentId: QA, ticketId: "TEAM-22", status: "pending" },
      "TEAM-23": { id: "t23", agentId: CI, ticketId: "TEAM-23", status: "pending" },
      "TEAM-24": { id: "t24", agentId: RM, ticketId: "TEAM-24", status: "pending" },
    };

    // The jira Lambda's creation-time routing hop for the gate, then every
    // webhook Jira would fire for whatever the orchestrator did in response.
    await handler({ source: "jira-webhook", ticketId: "TEAM-25", newStatus: "blocked", oldStatus: "todo" });
    await deliverQueuedWebhooks();

    // expect.soft: report EVERY deviation in one run — the failure output is
    // the reproduction of the prod sequence (rejected -> reopened -> invoked).
    expect.soft(eventsOf("review.rejected")).toHaveLength(0);
    expect.soft(eventsOf("agent.invoked").filter((e) => e.detail.ticketId === "TEAM-24")).toHaveLength(0);
    expect.soft(h.state.lambdaInvokes.map((i) => i.payload?.agentId)).toEqual([]);
    expect.soft(transitionsOn("TEAM-24")).toEqual([]);
    expect.soft(h.state.jira.issues["TEAM-24"].fields.status.name).toBe("Blocked");
    expect.soft(isLiveClaim(h.state.workflow.agentTasks["TEAM-24"])).toBe(false);
    // The in-flight dev work is untouched.
    expect.soft(h.state.jira.issues["TEAM-20"].fields.status.name).toBe("In Progress");
  });
});

// ─── (b), control, (e-DDB): DDB-stream entry point ───────────────────────────

describe("processRecord case blocked — DDB-stream entry point (TEAM-4045)", () => {
  const S = (v) => ({ S: v });
  const L = (arr) => ({ L: arr.map((v) => ({ S: v })) });
  const gateImage = (status) => ({
    ticketId: S("TEAM-25"), status: S(status), assignee: S("human:engineer"), title: S("Merge Approval"),
    parentId: S("TEAM-1"), workflowId: S("wf_1"), type: S("task"), blockedBy: L(["TEAM-24"]),
  });
  const shipImage = (status) => ({
    ticketId: S("TEAM-24"), status: S(status), assignee: S(RM), title: S("Ship"),
    parentId: S("TEAM-1"), workflowId: S("wf_1"), type: S("task"), blockedBy: L(["TEAM-23"]),
  });
  const record = (eventName, NewImage, OldImage) => ({
    Records: [{ eventName, eventSource: "aws:dynamodb", dynamodb: OldImage ? { NewImage, OldImage } : { NewImage } }],
  });

  beforeEach(async () => {
    await importIndex({ provider: "dynamodb" });
    h.state.tickets = {
      "TEAM-23": { ticketId: "TEAM-23", assignee: CI, type: "task", status: "blocked", blockedBy: ["TEAM-22"], parentId: "TEAM-1", workflowId: "wf_1" },
      "TEAM-24": { ticketId: "TEAM-24", assignee: RM, type: "task", status: "blocked", blockedBy: ["TEAM-23"], parentId: "TEAM-1", workflowId: "wf_1", title: "Ship" },
      "TEAM-25": { ticketId: "TEAM-25", assignee: "human:engineer", type: "task", status: "blocked", blockedBy: ["TEAM-24"], parentId: "TEAM-1", workflowId: "wf_1", title: "Merge Approval" },
    };
  });

  it("(b) INSERT with status blocked on a human gate: handler NOT reached, 0 review.rejected, no upstream status write", async () => {
    await handler(record("INSERT", gateImage("blocked")));

    expect(storeMock.ackNotifications).not.toHaveBeenCalled();
    expect(h.state.enforce).not.toHaveBeenCalled();
    expect(eventsOf("review.rejected")).toHaveLength(0);
    expect(statusWritesOn("TEAM-24")).toEqual([]);
    expect(h.state.tickets["TEAM-24"].status).toBe("blocked");
  });

  it("(b) MODIFY todo -> blocked on a human gate: same no-op", async () => {
    await handler(record("MODIFY", gateImage("blocked"), gateImage("todo")));

    expect(h.state.enforce).not.toHaveBeenCalled();
    expect(eventsOf("review.rejected")).toHaveLength(0);
    expect(statusWritesOn("TEAM-24")).toEqual([]);
  });

  it("CONTROL: MODIFY in_review -> blocked on a human gate reaches the handler once (TEAM-3966 F2 pin preserved)", async () => {
    h.state.enforce = vi.fn(async () => ({ escalated: true, effectiveRounds: 3, maxRounds: 3 }));

    await handler(record("MODIFY", gateImage("blocked"), gateImage("in_review")));

    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    expect(h.state.enforce.mock.calls[0][0].gateTicket.ticketId).toBe("TEAM-25");
  });

  const seedRunningShipTask = () => {
    h.state.workflow.agentTasks["TEAM-24"] = {
      id: "task_1", agentId: RM, ticketId: "TEAM-24", status: "running", startedAt: STARTED_AT,
    };
  };

  it("(e-DDB) blocker open: MODIFY in_progress -> blocked releases the running claim via ONE real stealClaim CAS; a later ready dispatches", async () => {
    seedRunningShipTask();

    await handler(record("MODIFY", shipImage("blocked"), shipImage("in_progress")));
    expect(isLiveClaim(h.state.workflow.agentTasks["TEAM-24"])).toBe(false);
    expectStealCas("TEAM-24", STARTED_AT);
    expect(eventsOf("orchestrator.claim_released")).toHaveLength(1);
    expect(eventsOf("orchestrator.claim_released")[0].detail.blockedBy).toEqual(["TEAM-23"]);

    // CI lands; a human (or the cascade) marks the ship ticket ready again.
    h.state.tickets["TEAM-23"].status = "done";
    h.state.tickets["TEAM-24"].status = "ready";
    await handler(record("MODIFY", shipImage("ready"), shipImage("blocked")));

    const invoked = eventsOf("agent.invoked").filter((e) => e.detail.ticketId === "TEAM-24");
    expect(invoked).toHaveLength(1);
    expect(h.state.lambdaInvokes.filter((i) => i.payload?.ticketId === "TEAM-24")).toHaveLength(1);
  });

  it("(e-DDB-2) TEAM-4071 F1: ALL blockers done -> claim stays running, no steal against the workflows table, no event", async () => {
    seedRunningShipTask();
    h.state.tickets["TEAM-23"].status = "done";

    await handler(record("MODIFY", shipImage("blocked"), shipImage("in_progress")));

    expect(h.state.workflow.agentTasks["TEAM-24"].status).toBe("running");
    expect(isLiveClaim(h.state.workflow.agentTasks["TEAM-24"])).toBe(true);
    expect(h.state.updates.filter((u) => u.TableName === WORKFLOWS_TABLE)).toEqual([]);
    expect(eventsOf("orchestrator.claim_released")).toHaveLength(0);
  });

  it("(e-DDB-3) TEAM-4071 F1: image without blockedBy -> the ticket is READ (getTicket), not assumed; open blocker there still releases", async () => {
    seedRunningShipTask();
    const { blockedBy: _omit, ...imageNoBlockers } = shipImage("blocked");
    const { blockedBy: _omit2, ...oldNoBlockers } = shipImage("in_progress");

    await handler(record("MODIFY", imageNoBlockers, oldNoBlockers));

    // h.state.tickets["TEAM-24"].blockedBy = ["TEAM-23"] (blocked) -> released.
    expectStealCas("TEAM-24", STARTED_AT);
    expect(eventsOf("orchestrator.claim_released")[0].detail.blockedBy).toEqual(["TEAM-23"]);
  });

  it("(e-DDB-4) TEAM-4071 F2: the steal CAS loses -> releaseClaimOnSelfPark returns false, claim stays running, no event", async () => {
    seedRunningShipTask();
    h.state.failSteal = true;

    const released = await releaseClaimOnSelfPark(
      { ticketId: "TEAM-24", assignee: RM, workflowId: "wf_1", parentId: "TEAM-1", blockedBy: ["TEAM-23"] },
      "in_progress"
    );

    expect(released).toBe(false);
    expectStealCas("TEAM-24", STARTED_AT); // attempted once, on this generation
    expect(h.state.workflow.agentTasks["TEAM-24"].status).toBe("running");
    expect(isLiveClaim(h.state.workflow.agentTasks["TEAM-24"])).toBe(true);
    expect(eventsOf("orchestrator.claim_released")).toHaveLength(0);
  });
});

// ─── (d) handleReviewRejection rework path: upstream blocker guard ───────────

describe("handleReviewRejection (rework) — upstream with unresolved blockers is NOT reopened (TEAM-4045)", () => {
  const GATE = {
    ticketId: "TEAM-900", workflowId: "wf_1", parentId: "TEAM-1", assignee: "human:engineer",
    labels: ["human-review", "reviewer:engineer"], blockedBy: ["TEAM-10"], reviewComment: "please fix the null check",
  };

  describe("DDB branch", () => {
    beforeEach(async () => {
      await importIndex({ provider: "dynamodb" });
      h.state.tickets = {
        "TEAM-5": { ticketId: "TEAM-5", assignee: QA, type: "task", status: "in_progress", blockedBy: [] },
        // The upstream the gate reviews — still blocked on TEAM-5 (never done).
        "TEAM-10": { ticketId: "TEAM-10", assignee: API_DEV, type: "task", status: "blocked", blockedBy: ["TEAM-5"] },
        "TEAM-11": { ticketId: "TEAM-11", assignee: BACKEND_DEV, type: "task", status: "done", blockedBy: [] },
        "TEAM-900": { ...GATE, status: "blocked" },
      };
    });

    it("(d) upstream blockedBy contains a non-done ticket -> no status write on it; review.rejected.reopened is []", async () => {
      await handleReviewRejection(h.state.tickets["TEAM-900"]);

      expect(statusWritesOn("TEAM-10")).toEqual([]);
      const rejected = eventsOf("review.rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0].detail.reopened).toEqual([]);
    });

    it("(d) mixed upstream: the done one is reopened, the still-blocked one is skipped; reopened lists only the first", async () => {
      h.state.tickets["TEAM-900"].blockedBy = ["TEAM-10", "TEAM-11"];

      await handleReviewRejection(h.state.tickets["TEAM-900"]);

      expect(statusWritesOn("TEAM-10")).toEqual([]);
      const reopen11 = statusWritesOn("TEAM-11");
      expect(reopen11).toHaveLength(1);
      expect(reopen11[0].ExpressionAttributeValues[":s"]).toBe("todo");
      expect(eventsOf("review.rejected")[0].detail.reopened).toEqual(["TEAM-11"]);
    });
  });

  describe("Jira branch", () => {
    beforeEach(async () => {
      await importIndex({ provider: "jira" });
    });

    it("(d) upstream blockedBy contains a non-done ticket -> zero transition POSTs on it (no To Do / Ready hop); reopened is []", async () => {
      installJiraRouter({
        "TEAM-5": agentIssue("TEAM-5", QA, "In Progress", [], "QA"),
        "TEAM-10": agentIssue("TEAM-10", API_DEV, "Blocked", ["TEAM-5"], "Dev"),
        "TEAM-900": humanGateIssue("TEAM-900", "Blocked", ["TEAM-10"], ["please fix the null check"]),
      });

      await handleReviewRejection(GATE);

      expect(transitionsOn("TEAM-10")).toEqual([]);
      expect(h.state.jira.issues["TEAM-10"].fields.status.name).toBe("Blocked");
      const rejected = eventsOf("review.rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0].detail.reopened).toEqual([]);
    });

    it("CONTROL: upstream with all blockers done IS reopened via To Do -> Ready (existing rework behaviour preserved)", async () => {
      installJiraRouter({
        "TEAM-5": agentIssue("TEAM-5", QA, "Done", [], "QA"),
        "TEAM-10": agentIssue("TEAM-10", API_DEV, "Done", ["TEAM-5"], "Dev"),
        "TEAM-900": humanGateIssue("TEAM-900", "Blocked", ["TEAM-10"], ["please fix the null check"]),
      });

      await handleReviewRejection(GATE);

      expect(transitionsOn("TEAM-10").map((t) => t.to)).toEqual(["To Do", "Ready"]);
      expect(eventsOf("review.rejected")[0].detail.reopened).toEqual(["TEAM-10"]);
    });
  });
});
