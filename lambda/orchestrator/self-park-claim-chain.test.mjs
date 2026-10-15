import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";

/**
 * TEAM-5777 — the self-park claim-release attribution chain, end to end.
 *
 * An agent that parks its own ticket (in_progress → blocked behind an open
 * blocker) must give its `running` invocation claim back, or the later Ready is
 * refused as "already claimed" until the 2× lease TTL hatch. The orchestrator
 * releases ONLY a park it can attribute to the current claim generation, and that
 * attribution is a contract spread over six hops in four codebases:
 *
 *   1. orchestrator dispatch sends the claim's startedAt as `claimStartedAt`
 *      (index.mjs invokeAgent)                                   — case (d)
 *   2. agent-invoker forwards it to the runtime as `claim_started_at`
 *      (agent-invoker.mjs)            — agent-invoker-retry.test.mjs (TEAM-5719)
 *   3. the runtime echoes it on its own Tickets___transition_ticket park
 *      (deploy/runtime-agent/main.py) — runtime-agent tests/test_transition_ticket_tool.py
 *   4. the REAL Jira Lambda writes `park-claim:<startedAt>:<nonce>` and carries the
 *      nonce as historyMetadata.extraData.fenceNonce on the transition's history
 *   5. the REAL /api/jira/webhook route forwards the history's `changelogId`
 *   6. parkGeneration (lease.mjs) confirms the carrier on the expand=changelog
 *      page → releaseClaimOnSelfPark → stealClaim → orchestrator.claim_released
 *                                                                — cases (a)(b)(c)
 *
 * Hops 4-6 run here for real against a stateful fake Jira that records labels,
 * links, historyMetadata and changelog ids the way Jira Cloud does; nothing about
 * the label or the history is hand-crafted. A park from a pre-#846 dispatch
 * carries none of it, so its claim is KEPT by design — the deploy-cutover window
 * TEAM-5777 observed in prod (no production defect). The label is matched with a
 * literal regex, not either side's PARK_CLAIM_LABEL, so drift in one copy fails.
 *
 * Harness: same shape as gate-creation-blocked.test.mjs — index.mjs imported for
 * real, only the AWS SDK clients and workflow-store mocked.
 */

const h = vi.hoisted(() => ({
  state: {
    workflow: /** @type {any} */ (null),
    updates: /** @type {any[]} */ ([]),
    events: /** @type {any[]} */ ([]),
    lambdaInvokes: /** @type {any[]} */ ([]),
    // Fresh per test: every timestamp in a case is relative to it.
    startedAt: "",
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
          if (name === "UpdateCommand") { h.state.updates.push(cmd.input); return {}; }
          if (name === "PutCommand") { h.state.events.push(cmd.input.Item); return {}; }
          if (name === "GetCommand") return { Item: null };
          return { Items: [] };
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

// The fixtures' repo (o/r) is CD-registered so the release manager's ship ticket
// dispatches instead of being resolved as a handoff (case (d)).
const CD_REGISTRY = JSON.stringify({ version: 1, repos: [{ repo: "o/r" }] });
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      if (cmd.constructor.name === "GetObjectCommand") {
        if (cmd.input.Key === "config/cd-registry.json") {
          return { Body: { transformToString: async () => CD_REGISTRY } };
        }
        throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
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

// In-memory workflow store: agentTasks live on h.state.workflow so the claim CAS
// (claimInvocation) and status writes are observable.
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
    ackNotifications: vi.fn(async () => {}),
    setResumeContext: vi.fn(async () => {}),
    removeResumeContext: vi.fn(async () => {}),
    // Same predicate as the real store: free unless a RUNNING claim younger
    // than staleBefore holds the slot.
    claimInvocation: vi.fn(async (_id, tid, entry, staleBefore) => {
      const cur = tasks()[tid];
      const ok = !cur || cur.status !== "running" || (cur.startedAt || "") < staleBefore;
      if (ok) tasks()[tid] = { ...entry };
      return ok;
    }),
    trackTicket: vi.fn(async (_id, tid, entry) => {
      if (tasks()[tid]) return false;
      tasks()[tid] = { ...entry };
      return true;
    }),
    claimHumanTicket: vi.fn(async () => true),
    setTaskStatus: vi.fn(async (_id, tid, status) => { if (tasks()[tid]) tasks()[tid].status = status; }),
    putTaskEntry: vi.fn(async (_id, tid, entry) => { tasks()[tid] = { ...entry }; }),
    completeTaskEntry: vi.fn(async (_id, tid, seed) => { tasks()[tid] = { ...(tasks()[tid] || seed || {}), status: "complete" }; }),
    mergeTaskMetadata: vi.fn(async () => {}),
    advancePhase: vi.fn(async (_id, phase, featureBranch) => {
      wf().phase = phase;
      if (featureBranch) wf().featureBranch = featureBranch;
      return true;
    }),
    adoptFeatureBranch: vi.fn(async () => {}),
    appendNotification: vi.fn(async () => {}),
    appendReviewNotificationOnce: vi.fn(async () => true),
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const RM = "agentcore_hub_release_manager";
const WORKFLOWS_TABLE = "agentcore-hub-workflows"; // index.mjs's default (env unset)

const JIRA_TRANSITIONS = [
  { id: "11", name: "To Do", to: { name: "To Do" } },
  { id: "21", name: "Ready", to: { name: "Ready" } },
  { id: "31", name: "In Progress", to: { name: "In Progress" } },
  { id: "41", name: "In Review", to: { name: "In Review" } },
  { id: "51", name: "Blocked", to: { name: "Blocked" } },
  { id: "61", name: "Done", to: { name: "Done" } },
];

const jsonResp = (obj, status = 200) => ({ ok: true, status, text: async () => JSON.stringify(obj) });
const eventsOf = (type) => h.state.events.filter((e) => e.type === type);
const stealCommandsFor = (ticketId) =>
  h.state.updates.filter((u) =>
    u.TableName === WORKFLOWS_TABLE &&
    u.ExpressionAttributeNames?.["#tid"] === ticketId &&
    u.UpdateExpression === "SET agentTasks.#tid.#st = :ready");

/**
 * Stateful fake Jira Cloud. Every write that Jira records as a changelog history
 * (issue link, label PUT, transition POST) appends one history — carrying the
 * POST's historyMetadata — and queues the issue_updated webhook Jira would fire,
 * whose `changelog.id` is that history's id. `?expand=changelog` returns one page,
 * newest-first, ≤100, with `total`; `/changelog` pages oldest-first.
 * `refuseLabelsOnPost` models a transition screen without the labels field
 * (TEAM-4908): the Jira Lambda then stamps via PUT and transitions without labels.
 * `fake.changelogFails = true` makes `/changelog` answer 500 from then on (TEAM-5792).
 */
function installFakeJira(issues, { refuseLabelsOnPost = false } = {}) {
  let nextHist = 10000;
  let clock = Date.parse(h.state.startedAt);
  const created = () => new Date(clock += 1000).toISOString().replace("Z", "+0000");
  const fake = { issues, webhooks: [], posts: [], puts: [], changelogFails: false };
  const record = (key, items, historyMetadata) => {
    const hist = { id: String(nextHist++), author: { displayName: "bot" }, created: created(), items, ...(historyMetadata ? { historyMetadata } : {}) };
    issues[key].histories.push(hist);
    fake.webhooks.push({ webhookEvent: "jira:issue_updated", timestamp: clock, issue: { key, fields: structuredClone(issues[key].fields) }, changelog: { id: hist.id, items } });
  };
  const applyLabels = (key, ops) => {
    const f = issues[key].fields, before = f.labels.join(" ");
    for (const op of ops) {
      if (op.add && !f.labels.includes(op.add)) f.labels.push(op.add);
      if (op.remove) f.labels = f.labels.filter((l) => l !== op.remove);
    }
    return { field: "labels", fieldtype: "jira", fromString: before, toString: f.labels.join(" ") };
  };
  const view = (key, expandChangelog) => {
    const i = issues[key];
    const newestFirst = [...i.histories].reverse().slice(0, 100);
    return { key, fields: structuredClone(i.fields), ...(expandChangelog ? { changelog: { startAt: 0, maxResults: 100, total: i.histories.length, histories: structuredClone(newestFirst) } } : {}) };
  };
  global.fetch = vi.fn(async (url, init = {}) => {
    const u = new URL(String(url));
    const method = (init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : {};
    if (u.pathname === "/rest/api/3/issueLink" && method === "POST") {
      const out = body.outwardIssue.key, inn = body.inwardIssue.key;
      issues[out].fields.issuelinks.push({ type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, inwardIssue: { key: inn } });
      record(out, [{ field: "Link", fieldtype: "jira", fromString: null, toString: `This issue is blocked by ${inn}` }]);
      return { ok: true, status: 201, text: async () => "" };
    }
    if (u.pathname === "/rest/api/3/search/jql") {
      const parent = decodeURIComponent(u.search).match(/parent = ([A-Z]+-\d+)/)?.[1];
      return jsonResp({ issues: Object.keys(issues).filter((k) => issues[k].fields.parent?.key === parent).map((k) => view(k)), isLast: true });
    }
    const m = u.pathname.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)(\/transitions|\/comment|\/changelog)?$/);
    if (!m) return jsonResp({});
    const [, key, sub] = m;
    if (!issues[key]) return { ok: false, status: 404, text: async () => JSON.stringify({ errorMessages: ["Issue does not exist"] }) };
    if (sub === "/transitions") {
      if (method === "GET") return jsonResp({ transitions: JIRA_TRANSITIONS });
      fake.posts.push(body);
      if (body.update?.labels && refuseLabelsOnPost) {
        return { ok: false, status: 400, text: async () => JSON.stringify({ errorMessages: [], errors: { labels: "Field 'labels' cannot be set. It is not on the appropriate screen, or unknown." } }) };
      }
      const target = JIRA_TRANSITIONS.find((t) => t.id === body.transition?.id);
      const items = [];
      if (body.update?.labels) items.push(applyLabels(key, body.update.labels));
      const from = issues[key].fields.status.name;
      issues[key].fields.status.name = target.to.name;
      items.push({ field: "status", fieldtype: "jira", from: "1", fromString: from, to: "2", toString: target.to.name });
      record(key, items, body.historyMetadata);
      return { ok: true, status: 204, text: async () => "" };
    }
    if (sub === "/comment") return method === "POST" ? jsonResp({ id: "1" }, 201) : jsonResp({ comments: [], total: 0 });
    if (sub === "/changelog") {
      if (fake.changelogFails) return { ok: false, status: 500, text: async () => "Internal server error" };
      const startAt = Number(u.searchParams.get("startAt") || 0), max = Number(u.searchParams.get("maxResults") || 100);
      const values = issues[key].histories.slice(startAt, startAt + max);
      return jsonResp({ startAt, maxResults: max, total: issues[key].histories.length, isLast: startAt + values.length >= issues[key].histories.length, values: structuredClone(values) });
    }
    if (method === "PUT") {
      fake.puts.push(body);
      if (body.update?.labels) record(key, [applyLabels(key, body.update.labels)]);
      return { ok: true, status: 204, text: async () => "" };
    }
    return jsonResp(view(key, u.searchParams.get("expand") === "changelog"));
  });
  return fake;
}

const fakeIssue = (key, { status, labels, parent = "TEAM-1", blockedBy = [] }) => ({
  key,
  histories: [],
  fields: {
    summary: key, status: { name: status }, labels: [...labels], issuetype: { name: "Task" }, parent: { key: parent },
    issuelinks: blockedBy.map((k) => ({ type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, inwardIssue: { key: k } })),
    comment: { comments: [] },
  },
});

/** The payload deploy/runtime-agent/main.py's Tickets___transition_ticket sends for the
 *  harness park (_harness_fail_closed). `claimStartedAt` null = a pre-#846 dispatch:
 *  no claim_started_at in the invoke payload, so none is echoed. */
const runtimeParkPayload = (claimStartedAt, { withExpected = true } = {}) => ({
  ticket_id: "TEAM-24", transition_id: "blocked",
  reason: "harness-synthesised: persona ended without report_completion — prose",
  blocked_by: ["TEAM-30"],
  ...(withExpected ? { expected_status: "in_progress" } : {}),
  ...(claimStartedAt ? { claim_started_at: claimStartedAt } : {}),
});

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ─── Per-test isolation ───────────────────────────────────────────────────────

let handler, releaseClaimOnSelfPark, jiraHandler, webhookPOST;
let envBefore;
const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  envBefore = { ...process.env };
  vi.clearAllMocks();
  h.state.updates.length = 0;
  h.state.events.length = 0;
  h.state.lambdaInvokes.length = 0;
  h.state.startedAt = new Date().toISOString();
  h.state.workflow = {
    id: "wf_1", epicId: "TEAM-1", workflowDefId: "software-delivery", phase: "development",
    humanNotifications: [], resumeContexts: {}, agentTasks: {},
    repoConfig: { layout: "multi-repo", repos: [{ platform: "backend", url: "https://github.com/o/r", defaultBranch: "main" }] },
  };
  // loadCdRegistry reads S3 only when ARTIFACT_BUCKET is set at import time.
  process.env.ARTIFACT_BUCKET = "test-bucket";
  process.env.TICKET_PROVIDER = "jira";
  process.env.JIRA_SITE_URL = "jira.test";
  process.env.JIRA_EMAIL = "bot@test";
  process.env.JIRA_API_TOKEN = "t";
  process.env.JIRA_PROJECT_KEY = "TEAM";
  process.env.ADVISORY_APPROVE_BACKOFF_MS = "0";
  process.env[`RUNTIME_ARN_${RM.toUpperCase()}`] = `arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/${RM}`;
  // TEAM-6121: the real /api/jira/webhook route now requires a signed request.
  process.env.JIRA_WEBHOOK_SECRET = "self-park-test-secret";
  // The webhook route then hands its command to the orchestrator by direct
  // InvokeCommand (captured by the Lambda mock) instead of SQS.
  delete process.env.WORKFLOW_COMMAND_QUEUE_URL;
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) if (!(k in envBefore)) delete process.env[k];
  Object.assign(process.env, envBefore);
});

/** TEAM-5792: `n` histories TEAM-24 accrued before this claim (ids "1".."n", all older than startedAt): label edits,
 *  plus an In Progress <-> Blocked pair every 20, the newest of them a move back to In Progress. */
const priorHistories = (n) => Array.from({ length: n }, (_, i) => {
  const age = n - i, back = age % 20 === 5, away = age % 20 === 15;
  return {
    id: String(i + 1), author: { displayName: "human" },
    created: new Date(Date.parse(h.state.startedAt) - age * 60_000).toISOString().replace("Z", "+0000"),
    items: back || away
      ? [{ field: "status", fieldtype: "jira", fromString: back ? "Blocked" : "In Progress", toString: back ? "In Progress" : "Blocked" }]
      : [{ field: "labels", fieldtype: "jira", fromString: "", toString: `note-${i}` }],
  };
});

/** Fresh module graph per test: the Jira Lambda reads its JIRA_* env at load. `prior` seeds TEAM-24's old changelog. */
async function boot({ prior = 0, ...opts } = {}) {
  vi.resetModules();
  ({ handler, releaseClaimOnSelfPark } = await import("./index.mjs"));
  ({ handler: jiraHandler } = await import("../agentcore-hub-jira/index.mjs"));
  ({ POST: webhookPOST } = await import("../../src/app/api/jira/webhook/route.ts"));
  const team24 = fakeIssue("TEAM-24", { status: "In Progress", labels: [`agent:${RM}`, "wf:wf_1"] });
  team24.histories.push(...priorHistories(prior));
  return installFakeJira({
    "TEAM-24": team24,
    // The human gate the park waits on — just filed, never completed.
    "TEAM-30": fakeIssue("TEAM-30", { status: "To Do", labels: ["reviewer:engineer", "wf:wf_1", "harness-synthesised"] }),
  }, opts);
}

/** The running claim a dispatch would have written. */
const seedRunningClaim = () => {
  h.state.workflow.agentTasks["TEAM-24"] = { id: "task_1", agentId: RM, ticketId: "TEAM-24", status: "running", startedAt: h.state.startedAt };
};

/**
 * TEAM-6121: the real route now verifies X-Hub-Signature, so every call
 * into it needs a real signed NextRequest rather than a bare {json} fake.
 */
function jiraWebhookRequest(payload) {
  const raw = JSON.stringify(payload);
  const sig = `sha256=${createHmac("sha256", process.env.JIRA_WEBHOOK_SECRET).update(raw, "utf8").digest("hex")}`;
  return new NextRequest("http://localhost/api/jira/webhook", {
    method: "POST",
    headers: { "x-hub-signature": sig },
    body: raw,
  });
}

/** Push every queued Jira webhook through the real route, then hand the command it emitted to the real orchestrator. */
async function deliver(fake) {
  const out = [];
  while (fake.webhooks.length) {
    const payload = fake.webhooks.shift();
    const before = h.state.lambdaInvokes.length;
    const res = await webhookPOST(jiraWebhookRequest(payload));
    const route = await res.json();
    const cmds = h.state.lambdaInvokes.slice(before).filter((i) => i.FunctionName === "agentcore-hub-orchestrator").map((i) => i.payload);
    out.push({ changelogId: payload.changelog.id, fields: payload.changelog.items.map((i) => i.field), route, cmds });
    for (const c of cmds) await handler(c);
  }
  return out;
}

// ─── Cases ────────────────────────────────────────────────────────────────────

describe("TEAM-5777: self-park claim release — real Jira Lambda → fake Jira → real webhook route → real orchestrator", () => {
  it("(a) OLD shape (pre-#846 dispatch, no claim_started_at): no park-claim label → claim KEPT, no claim_released, 'not attributable'", async () => {
    const fake = await boot();
    seedRunningClaim();
    const log = vi.spyOn(console, "log");
    const toolRes = await jiraHandler({ tool_name: "Tickets___transition_ticket", parameters: runtimeParkPayload(null, { withExpected: false }) });
    await deliver(fake);

    expect(toolRes.status).toBe("blocked");
    expect(fake.issues["TEAM-24"].fields.labels.some((l) => /^park-claim:/.test(l))).toBe(false);
    expect(h.state.workflow.agentTasks["TEAM-24"]).toMatchObject({ status: "running", startedAt: h.state.startedAt });
    expect(stealCommandsFor("TEAM-24")).toHaveLength(0);
    expect(eventsOf("orchestrator.claim_released")).toHaveLength(0);
    expect(log.mock.calls.some((c) => String(c[0]).includes("TEAM-24: in_progress → blocked not attributable to the running claim"))).toBe(true);
  });

  for (const refuseLabelsOnPost of [false, true]) {
    const path = refuseLabelsOnPost ? "labels-screen fallback: PUT then POST" : "label rides the transition POST";
    it(`(b) NEW shape (${path}): label + fenceNonce → claim RELEASED, exactly one claim_released for the DDB generation`, async () => {
      const fake = await boot({ refuseLabelsOnPost });
      seedRunningClaim();
      const startedAt = h.state.startedAt;
      const toolRes = await jiraHandler({ tool_name: "Tickets___transition_ticket", parameters: runtimeParkPayload(startedAt) });
      const deliveries = await deliver(fake);

      expect(toolRes.status).toBe("blocked");
      expect(fake.puts).toHaveLength(refuseLabelsOnPost ? 1 : 0);

      // Hop 4: the label pins this generation; its nonce is on exactly one history, the Blocked move.
      const issue = fake.issues["TEAM-24"];
      const labels = issue.fields.labels.filter((l) => /^park-claim:/.test(l));
      expect(labels).toHaveLength(1);
      const m = labels[0].match(new RegExp(`^park-claim:${escapeRe(startedAt)}:([0-9a-f-]{36})$`));
      expect(m).not.toBeNull();
      const carriers = issue.histories.filter((x) => x.historyMetadata?.extraData?.fenceNonce === m[1]);
      expect(carriers).toHaveLength(1);
      expect(carriers[0].items.filter((i) => i.field === "status").map((i) => i.toString)).toEqual(["Blocked"]);

      // Hop 5: only the status history reaches the orchestrator, carrying its own changelog id.
      const forwarded = deliveries.filter((d) => d.cmds.length);
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0].changelogId).toBe(carriers[0].id);
      expect(forwarded[0].cmds).toHaveLength(1);
      expect(forwarded[0].cmds[0]).toMatchObject({ ticketId: "TEAM-24", newStatus: "blocked", changelogId: carriers[0].id });
      for (const d of deliveries.filter((x) => !x.fields.includes("status"))) expect(d.cmds).toHaveLength(0);

      // Hop 6: released through the steal CAS on exactly the DDB generation.
      expect(h.state.workflow.agentTasks["TEAM-24"].status).toBe("ready");
      const steals = stealCommandsFor("TEAM-24");
      expect(steals).toHaveLength(1);
      expect(steals[0].Key).toEqual({ workflowId: "wf_1" });
      expect(steals[0].ConditionExpression).toBe("agentTasks.#tid.#st IN (:running, :inprog) AND agentTasks.#tid.startedAt = :exp");
      expect(steals[0].ExpressionAttributeValues[":exp"]).toBe(startedAt);
      const released = eventsOf("orchestrator.claim_released");
      expect(released).toHaveLength(1);
      expect(released[0].detail).toMatchObject({
        ticketId: "TEAM-24", agentId: RM, workflowId: "wf_1", reason: "agent_self_park",
        claimStartedAt: startedAt, blockedBy: ["TEAM-30"],
      });
    });
  }

  it("(c) releaseClaimOnSelfPark on the OLD-shape Jira read (no label, no changelogId) → false, claim kept", async () => {
    const fake = await boot();
    seedRunningClaim();
    await jiraHandler({ tool_name: "Tickets___transition_ticket", parameters: runtimeParkPayload(null, { withExpected: false }) });
    const issue = fake.issues["TEAM-24"];
    const ticket = {
      ticketId: "TEAM-24", assignee: RM, workflowId: "wf_1", parentId: "TEAM-1", status: "blocked",
      labels: issue.fields.labels, blockedBy: ["TEAM-30"],
      changelog: [...issue.histories].reverse(), changelogTotal: issue.histories.length,
    };

    expect(await releaseClaimOnSelfPark(ticket, "in_progress")).toBe(false);
    expect(h.state.workflow.agentTasks["TEAM-24"]).toMatchObject({ status: "running", startedAt: h.state.startedAt });
    expect(stealCommandsFor("TEAM-24")).toHaveLength(0);
    expect(eventsOf("orchestrator.claim_released")).toHaveLength(0);
  });

  it("(d) a Ready dispatch sends the claim it just won to the agent-invoker as claimStartedAt", async () => {
    const fake = await boot();
    fake.issues["TEAM-24"].fields.status.name = "Ready";
    h.state.workflow.agentTasks["TEAM-24"] = { id: "task_1", agentId: RM, ticketId: "TEAM-24", status: "pending" };
    const res = await webhookPOST(jiraWebhookRequest({
      webhookEvent: "jira:issue_updated", timestamp: Date.now(),
      issue: { key: "TEAM-24", fields: structuredClone(fake.issues["TEAM-24"].fields) },
      changelog: { id: "9999", items: [{ field: "status", fieldtype: "jira", fromString: "To Do", toString: "Ready" }] },
    }));
    expect((await res.json()).ignored).not.toBe(true);
    for (const c of h.state.lambdaInvokes.filter((i) => i.FunctionName === "agentcore-hub-orchestrator").map((i) => i.payload)) await handler(c);

    const claim = h.state.workflow.agentTasks["TEAM-24"];
    expect(claim.status).toBe("running");
    expect(claim.startedAt >= h.state.startedAt).toBe(true);
    const dispatches = h.state.lambdaInvokes.filter((i) => i.FunctionName === "agentcore-hub-agent-invoker" && i.payload?.ticketId === "TEAM-24");
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].payload).toMatchObject({ agentId: RM, workflowId: "wf_1", claimStartedAt: claim.startedAt });
  });
  // TEAM-5792: the expand page is capped at 100 (newest-first) while `total` counts every history, so on a long-lived
  // ticket parkGeneration saw total > histories on every read and could never release. The orchestrator now pages
  // /changelog when the expand page is short; a walk that cannot cover `total` still fails closed.
  for (const prior of [150, 250]) {
    it(`(e) ${prior} prior histories (expand page truncated): the read pages /changelog, the park is attributed → claim RELEASED once`, async () => {
      const fake = await boot({ prior });
      seedRunningClaim();
      const startedAt = h.state.startedAt;
      const toolRes = await jiraHandler({ tool_name: "Tickets___transition_ticket", parameters: runtimeParkPayload(startedAt) });
      const callsBefore = global.fetch.mock.calls.length;
      await deliver(fake);

      expect(toolRes.status).toBe("blocked");
      expect(fake.issues["TEAM-24"].histories.length).toBeGreaterThan(prior);
      const orchUrls = global.fetch.mock.calls.slice(callsBefore).map((c) => String(c[0]));
      expect(orchUrls.some((u) => u.includes("/issue/TEAM-24?") && u.includes("expand=changelog"))).toBe(true);
      expect(orchUrls.some((u) => u.includes("/issue/TEAM-24/changelog?startAt=0&"))).toBe(true);
      expect(h.state.workflow.agentTasks["TEAM-24"].status).toBe("ready");
      const steals = stealCommandsFor("TEAM-24");
      expect(steals).toHaveLength(1);
      expect(steals[0].ExpressionAttributeValues[":exp"]).toBe(startedAt);
      const released = eventsOf("orchestrator.claim_released");
      expect(released).toHaveLength(1);
      expect(released[0].detail).toMatchObject({ ticketId: "TEAM-24", reason: "agent_self_park", claimStartedAt: startedAt });
    });
  }

  it("(f) 150 prior histories and /changelog failing (500) on the orchestrator's read → the walk cannot cover `total` → claim KEPT", async () => {
    const fake = await boot({ prior: 150 });
    seedRunningClaim();
    const log = vi.spyOn(console, "log");
    const toolRes = await jiraHandler({ tool_name: "Tickets___transition_ticket", parameters: runtimeParkPayload(h.state.startedAt) });
    fake.changelogFails = true; // after the Jira Lambda's own read-back, which pages /changelog too
    await deliver(fake);

    expect(toolRes.status).toBe("blocked");
    expect(h.state.workflow.agentTasks["TEAM-24"]).toMatchObject({ status: "running", startedAt: h.state.startedAt });
    expect(stealCommandsFor("TEAM-24")).toHaveLength(0);
    expect(eventsOf("orchestrator.claim_released")).toHaveLength(0);
    expect(log.mock.calls.some((c) => String(c[0]).includes("TEAM-24: in_progress → blocked not attributable to the running claim"))).toBe(true);
  });
});
