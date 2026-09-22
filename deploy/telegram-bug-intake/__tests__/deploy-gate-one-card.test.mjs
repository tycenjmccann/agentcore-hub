/**
 * One page per deploy execution.
 *
 * Two paths page the same production-deploy decision: the pipeline poller's own
 * 🚀 card (dok/dno) and the release manager's `gate:deploy-approval` ticket
 * (gok/gno, TEAM-4706). Both used to go out for every deploy — on 2026-09-22
 * TEAM-4977 landed two minutes after the poller's page and TEAM-4979 three
 * minutes after — and a human then approved the same execution twice.
 *
 * Invariants:
 *  (a) poller first: a gate ticket filed after the pipeline's own page sends no
 *      second card, and the poller's ✅ still closes the ticket.
 *  (b) ticket first: when the ticket pages the execution, the poller's own card
 *      is never sent.
 *  (c) a ❌ on the poller's card is a rework verdict, not a settled one — the
 *      ticket still pages so the human closes that half.
 *  (d) sibling gates on one run name their PR in the subject (TEAM-4660 keeps
 *      the ticket's prose out; a PR number is not prose).
 *
 * The harness is gate-deploy-approval.test.mjs's, verbatim.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TG_TOKEN = "111111:test-bot-token";
const HUB = "https://hub.example.invalid";
const CHAT = 555;
const WF = "wf-4706";
const GATE = "TEAM-9001";
const PIPELINE = "hub-widget-deploy";
const REPO = "acme/widget";
const REGION = "us-west-2";
const BUCKET = "test-artifact-bucket";
const CD_REGISTRY_KEY = "config/cd-registry.json";
const SHA = "abc1234def5678";

const EXEC = "11111111-2222-3333-4444-555555555555";
const EXEC_OLD = "99999999-8888-7777-6666-555555555555";
const TOKEN = "approval-token-4706-0123456789-way-too-long-for-a-callback-data-field";
const TOKEN_OLD = "approval-token-4706-older-build-9876543210-also-far-too-long-to-send";

// Placeholder account id (CLAUDE.md: never a real one) for the cross-account
// triple parseCdRegistry admits: 12 digits + the RESERVED trigger-role name.
const XACCT = "210987654321";
const XROLE = `arn:aws:iam::${XACCT}:role/hub-cd-trigger-widget`;
const XEXTID = "hub-cd-widget-external-id";

// ─── AWS SDK mocks ────────────────────────────────────────────────────────────

// ONE ordered log across the AWS and Telegram seams: "both happened" is not the
// invariant — "the pipeline moved FIRST" is.
const log = vi.hoisted(() => ({ entries: [] }));

const db = vi.hoisted(() => ({ items: new Map(), puts: [], deletes: [], updates: [] }));
vi.mock("@aws-sdk/client-dynamodb", async () => {
  // TEAM-4663: the handler now UPDATES claim rows (two-phase claim). One
  // shared evaluator, because a fake that replaces instead of merging would
  // hide a real regression — see helpers/ddb-fake.mjs.
  const { applyUpdate } = await import("./helpers/ddb-fake.mjs");
  const cmd = (op) => class { constructor(input) { this.input = input; this.op = op; } };
  class DynamoDBClient {
    async send(c) {
      if (c.op === "get") return { Item: db.items.get(c.input.Key.id.S) };
      if (c.op === "put") {
        const id = c.input.Item.id.S;
        if (c.input.ConditionExpression && db.items.has(id)) {
          const err = new Error("The conditional request failed");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        db.items.set(id, c.input.Item);
        db.puts.push(c.input.Item);
        return {};
      }
      if (c.op === "update") return applyUpdate(db, c.input);
      if (c.op === "del") { db.deletes.push(c.input.Key.id.S); db.items.delete(c.input.Key.id.S); return {}; }
      if (c.op === "scan") {
        const p = c.input.ExpressionAttributeValues[":p"].S;
        return { Items: [...db.items.values()].filter((i) => i.id.S.startsWith(p)) };
      }
      throw new Error(`unexpected ddb op ${c.op}`);
    }
  }
  return {
    DynamoDBClient,
    GetItemCommand: cmd("get"), PutItemCommand: cmd("put"),
    DeleteItemCommand: cmd("del"), ScanCommand: cmd("scan"), UpdateItemCommand: cmd("update"),
  };
});

/**
 * CodePipeline, per pipeline NAME with a `"*"` wildcard (same shape as
 * deploy-approval.test.mjs). Two additions this suite needs:
 *   cp.onPut  — fires after a recorded PutApprovalResult, so a test can model
 *               "rejecting the older build frees the gate for the next one".
 *   inits     — records whether the client was built with a CREDENTIAL PROVIDER,
 *               and send() resolves it the way a signing client would, so a
 *               cross-account approval really performs its AssumeRole.
 */
const cp = vi.hoisted(() => ({
  states: new Map(), stateErrors: new Map(), putErrors: new Map(),
  approvals: [], sends: [], inits: [], onPut: null,
}));
const pick = (map, name) => (map.has(name) ? map.get(name) : map.get("*"));
vi.mock("@aws-sdk/client-codepipeline", () => {
  const cmd = (op) => class { constructor(input) { this.input = input; this.op = op; } };
  const boom = (msg) => { const e = new Error(msg); e.name = "ValidationException"; throw e; };
  class CodePipelineClient {
    constructor(cfg) {
      this.region = cfg?.region;
      this.creds = typeof cfg?.credentials === "function" ? cfg.credentials : null;
      cp.inits.push({ region: cfg?.region, assumed: Boolean(this.creds) });
    }
    async send(c) {
      if (this.creds) await this.creds(); // a real client resolves creds before signing
      cp.sends.push({ op: c.op, region: this.region, input: c.input });
      if (c.op === "state") {
        const err = pick(cp.stateErrors, c.input?.name);
        if (err) boom(err);
        return pick(cp.states, c.input?.name) || { stageStates: [] };
      }
      if (c.op === "put") {
        const err = pick(cp.putErrors, c.input?.pipelineName);
        if (err) boom(err);
        cp.approvals.push(c.input);
        log.entries.push({ kind: "approval", status: c.input?.result?.status, token: c.input?.token });
        cp.onPut?.(c.input);
        return {};
      }
      if (c.op === "exec") return { pipelineExecution: { artifactRevisions: [] } };
      throw new Error(`unexpected cp op ${c.op}`);
    }
  }
  return {
    CodePipelineClient,
    GetPipelineStateCommand: cmd("state"),
    PutApprovalResultCommand: cmd("put"),
    GetPipelineExecutionCommand: cmd("exec"),
  };
});

const sts = vi.hoisted(() => ({ assumes: [] }));
vi.mock("@aws-sdk/client-sts", () => ({
  STSClient: class {
    async send(c) {
      sts.assumes.push(c.input);
      return { Credentials: {
        AccessKeyId: "AKIAIOSFODNN7EXAMPLE", SecretAccessKey: "secret", SessionToken: "session",
        Expiration: new Date(Date.now() + 900_000),
      } };
    }
  },
  AssumeRoleCommand: class { constructor(input) { this.input = input; } },
}));

// The bridge reads one S3 key (the CD registry) and writes one (the SEC-1
// rejection marker, TEAM-4781 — load-bearing on ❌, so PutObjectCommand must be
// mocked here too: without it `new PutObjectCommand(...)` is `new undefined()`,
// and that TypeError used to be swallowed by the best-effort write).
const s3 = vi.hoisted(() => ({ calls: [], puts: [], registry: null }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(c) {
      s3.calls.push(c.input);
      if (c.op === "put") { s3.puts.push(c.input); return {}; }
      if (c.input?.Key === CD_REGISTRY_KEY && s3.registry) {
        const doc = s3.registry;
        return { Body: { transformToString: async () => (typeof doc === "string" ? doc : JSON.stringify(doc)) } };
      }
      const e = new Error("NoSuchKey");
      e.name = "NoSuchKey";
      throw e;
    }
  },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; this.op = "put"; } },
}));

vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send() { return { FailedEntryCount: 0 }; } },
  PutEventsCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-transcribe-streaming", () => ({
  StartStreamTranscriptionCommand: class { constructor(i) { this.input = i; } },
  TranscribeStreamingClient: class { async send() { return { TranscriptResultStream: (async function* () {})() }; } },
}));
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: class { async send() { throw new Error("bedrock must not be called"); } },
  ConverseCommand: class { constructor(i) { this.input = i; } },
}));

// ─── fetch fake ───────────────────────────────────────────────────────────────

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });

function makeNet(ctx, overrides = {}) {
  const net = {
    ctx, polls: 0, batches: [], afterPoll: [], workflows: [], tickets: null,
    sent: [], answered: [], edited: [], transitions: [], fetched: [], github: null,
    ...overrides,
  };
  net.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : null;
    net.fetched.push(u);
    if (u.startsWith("https://api.github.com/")) {
      if (u.includes("/pulls")) return jsonRes(net.github?.pulls ?? []);
      if (u.includes("/commits/")) return jsonRes(net.github?.commit ?? {});
      return jsonRes({});
    }
    if (u === `${HUB}/api/workflow/list`) return jsonRes({ workflows: net.workflows });
    if (u.endsWith("/tickets/transition")) {
      net.transitions.push(body);
      log.entries.push({ kind: "transition", ticketId: body?.ticketId, targetStatus: body?.targetStatus });
      const row = (net.tickets || []).find((t) => t?.ticketId === body?.ticketId);
      if (row && body?.targetStatus) row.status = body.targetStatus;
      return jsonRes({ success: true });
    }
    if (/\/api\/workflow\/[^/]+\/tickets$/.test(u)) {
      return net.tickets ? jsonRes({ tickets: net.tickets }) : jsonRes({}, false, 404);
    }
    if (u.endsWith("/getUpdates")) {
      const i = net.polls++;
      net.ctx.remainingMs = net.afterPoll[i] ?? 20_000;
      return jsonRes({ ok: true, result: net.batches[i] || [] });
    }
    if (u.endsWith("/sendMessage")) { net.sent.push(body); return jsonRes({ ok: true, result: {} }); }
    if (u.endsWith("/answerCallbackQuery")) { net.answered.push(body); return jsonRes({ ok: true, result: true }); }
    if (u.endsWith("/editMessageText")) { net.edited.push(body); return jsonRes({ ok: true, result: {} }); }
    if (u.endsWith("/sendChatAction")) return jsonRes({ ok: true, result: true });
    throw new Error(`unexpected fetch: ${u}`);
  };
  return net;
}
const makeCtx = (startMs = 100_000) => ({ remainingMs: startMs, getRemainingTimeInMillis() { return this.remainingMs; } });

const ENV = {
  TELEGRAM_BOT_TOKEN: TG_TOKEN,
  JIRA_SITE_URL: "example.atlassian.net", JIRA_EMAIL: "bot@example.com",
  JIRA_API_TOKEN: "t", JIRA_PROJECT_KEY: "TEAM",
  GITHUB_TOKEN: "gh", GITHUB_USER: "test-user",
  PENDING_TABLE: "test-pending-table", HUB_API_URL: HUB,
  ALLOWED_CHAT_IDS: String(CHAT), AWS_REGION: "us-east-1", CHAT_SETTLE_MS: "0",
};

/** Fresh container. Returns the MODULE (the retry seam lives on it). */
async function loadModule({ bucket, registry, pipeline } = {}) {
  vi.resetModules();
  Object.assign(process.env, ENV);
  if (bucket == null) delete process.env.ARTIFACT_BUCKET; else process.env.ARTIFACT_BUCKET = bucket;
  if (pipeline == null) delete process.env.DEPLOY_PIPELINE_NAME; else process.env.DEPLOY_PIPELINE_NAME = pipeline;
  s3.registry = registry ?? null;
  const mod = await import("../index.mjs");
  mod._setDeployGateRetryMsForTests(0); // no 10s sleeps in a unit test
  return mod;
}

function resetAll() {
  db.items.clear(); db.puts.length = 0; db.deletes.length = 0;
  cp.states.clear(); cp.stateErrors.clear(); cp.putErrors.clear();
  cp.approvals.length = 0; cp.sends.length = 0; cp.inits.length = 0; cp.onPut = null;
  s3.calls.length = 0; s3.puts.length = 0; s3.registry = null;
  sts.assumes.length = 0;
  log.entries.length = 0;
  db.items.set(`chat#${CHAT}`, { id: { S: `chat#${CHAT}` }, chatId: { N: String(CHAT) } });
}

const realFetch = global.fetch;
beforeEach(resetAll);
afterAll(() => {
  global.fetch = realFetch;
  for (const k of [...Object.keys(ENV), "ARTIFACT_BUCKET", "DEPLOY_PIPELINE_NAME"]) delete process.env[k];
});

// ─── fixtures ────────────────────────────────────────────────────────────────

/** Canonical labels an agent writes. */
const LABELS_COLON = [`gate:deploy-approval`, `pipeline:${PIPELINE}`, `exec:${EXEC}`, `wf:${WF}`];
/** The SAME labels after Jira's sanitizeUserLabels ([^a-z0-9._-] -> "-"). */
const LABELS_HYPHEN = [`gate-deploy-approval`, `pipeline-${PIPELINE}`, `exec-${EXEC}`, `wf-${WF}`];

const gateRow = (labels, extra = {}) => ({
  ticketId: GATE,
  title: "Deploy gate: approve prod deploy for the widget",
  status: "in review",
  labels,
  ...extra,
});

const registry = (extra = {}) => ({
  version: 1,
  repos: [{ repo: REPO, pipeline: PIPELINE, region: REGION, ...extra }],
});

/** A pipeline whose Approval action is parked on `executionId`. */
const pendingState = (token, executionId, { revision } = {}) => ({
  stageStates: [
    { stageName: "Source", actionStates: [{
      actionName: "Source",
      latestExecution: { status: "Succeeded", pipelineExecutionId: executionId },
      ...(revision ? { currentRevision: { revisionId: revision } } : {}),
    }] },
    { stageName: "Approval", actionStates: [{
      actionName: "Approve_deploy",
      latestExecution: { status: "InProgress", token, pipelineExecutionId: executionId },
    }] },
    { stageName: "Deploy", actionStates: [{ actionName: "Deploy_prod", latestExecution: {} }] },
  ],
});

const workflow = (extra = {}) => ({
  workflowId: WF,
  phase: "ship",
  input: { title: "Sprocket cache for the widget" },
  humanNotifications: [{
    id: "n-4706", type: "review_needed", acknowledged: false,
    ticketId: GATE, reviewer: "release-manager",
    timestamp: new Date().toISOString(),
    summary: "Ship review passed; prod deploy is waiting on you.",
  }],
  ...extra,
});

const GITHUB = {
  commit: { commit: { message: "feat(widget): sprocket cache (TEAM-4706)" }, stats: { additions: 12, deletions: 3 }, files: [{}, {}] },
  pulls: [{
    number: 7, title: "feat(widget): sprocket cache (TEAM-4706)",
    html_url: `https://github.com/${REPO}/pull/7`,
    body: "## Summary\nCaches sprockets between builds.",
  }],
};

const cbUpdate = (id, data, chat = CHAT) => ({
  update_id: id,
  callback_query: {
    id: `cb-${id}`, data,
    message: { message_id: 42, chat: { id: chat }, text: "*🚀 PRODUCTION DEPLOY — approval needed*\nSprocket cache" },
  },
});

/** hashToken() from index.mjs (djb2) — the legacy poller's claim key shape. */
const djb2 = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const targetKey = (pipeline, token) => `dp${djb2(`${pipeline} ${token}`)}`;
/**
 * Pretend the legacy poller already paged this wait, so its 🚀 page doesn't add
 * a second message to the assertions. PR 1 makes the ticket's ✅ work; which of
 * the two artefacts survives is a later unit's problem.
 */
const seedDeployClaim = (pipeline, token) => {
  const id = `dep#${targetKey(pipeline, token)}`;
  db.items.set(id, {
    id: { S: id }, pipelineName: { S: pipeline }, region: { S: REGION },
    stageName: { S: "Approval" }, actionName: { S: "Approve_deploy" }, token: { S: token },
  });
};

const kinds = () => log.entries.filter((e) => e.kind === "approval" || e.kind === "transition").map((e) => e.kind);
const bodies = (net) => [...net.sent, ...net.edited, ...net.answered].map((m) => JSON.stringify(m));

// ─── fixtures for this suite ──────────────────────────────────────────────────

/** EXEC after a ❌ on the pipeline's own page: no token, a Failed approval naming who answered. */
const rejectedState = () => ({
  stageStates: [
    { stageName: "Source", latestExecution: { status: "Succeeded", pipelineExecutionId: EXEC },
      actionStates: [{ actionName: "Source", latestExecution: { status: "Succeeded" } }] },
    { stageName: "Approval", latestExecution: { status: "Failed", pipelineExecutionId: EXEC },
      actionStates: [{ actionName: "Approve_deploy",
        latestExecution: { status: "Failed", summary: "Rejected via Telegram by chat 555", lastUpdatedBy: "arn:aws:sts::1:assumed-role/bridge" } }] },
    { stageName: "Deploy", actionStates: [{ actionName: "Deploy_prod", latestExecution: {} }] },
  ],
});
/** EXEC after a ✅ on the pipeline's own page. */
const approvedState = () => ({
  stageStates: [
    { stageName: "Source", latestExecution: { status: "Succeeded", pipelineExecutionId: EXEC },
      actionStates: [{ actionName: "Source", latestExecution: { status: "Succeeded" } }] },
    { stageName: "Approval", latestExecution: { status: "Succeeded", pipelineExecutionId: EXEC },
      actionStates: [{ actionName: "Approve_deploy",
        latestExecution: { status: "Succeeded", summary: "Approved via Telegram by chat 555", lastUpdatedBy: "arn:aws:sts::1:assumed-role/bridge" } }] },
    { stageName: "Deploy", latestExecution: { status: "InProgress", pipelineExecutionId: EXEC },
      actionStates: [{ actionName: "Deploy_prod", latestExecution: { status: "InProgress", externalExecutionId: "build/1" } }] },
  ],
});

const buttonsOf = (m) => (m.reply_markup?.inline_keyboard?.flat() || []).map((b) => b.callback_data || "");
const cardsWith = (net, prefix) => net.sent.filter((m) => buttonsOf(m).some((d) => d.startsWith(prefix)));

describe("one page per deploy execution", () => {
  it("(a) poller first: the gate ticket filed afterwards sends no second card, and the poller's ✅ still closes it", async () => {
    const mod = await loadModule({ bucket: BUCKET, registry: registry() });
    cp.states.set(PIPELINE, pendingState(TOKEN, EXEC));

    // Scan 1 — the wait is parked, no ticket yet: the pipeline's own card.
    const net1 = makeNet(makeCtx(), { batches: [[]] });
    global.fetch = net1.fetch;
    await mod.handler({}, net1.ctx);
    expect(cardsWith(net1, "dok|"), "the pipeline's own page").toHaveLength(1);
    expect(db.items.get(`paged#${PIPELINE}#${EXEC}`)?.by?.S).toBe("pipeline");

    // Scan 2 — the release manager has filed the gate ticket for the SAME execution.
    const net2 = makeNet(makeCtx(), { batches: [[]], workflows: [workflow()], tickets: [gateRow(LABELS_COLON)] });
    global.fetch = net2.fetch;
    await mod.handler({}, net2.ctx);
    expect(cardsWith(net2, "gok|"), "no second card for a question already asked").toHaveLength(0);
    expect(cardsWith(net2, "dok|"), "and the poller does not repeat itself").toHaveLength(0);
    expect(net2.transitions, "the ticket is left open — nobody has answered yet").toEqual([]);

    // The human answers the poller's card.
    const key = buttonsOf(cardsWith(net1, "dok|")[0]).find((d) => d.startsWith("dok|")).split("|")[1];
    const net3 = makeNet(makeCtx(), { batches: [[cbUpdate(9, `dok|${key}`)]], workflows: [workflow()], tickets: [gateRow(LABELS_COLON)] });
    global.fetch = net3.fetch;
    cp.states.set(PIPELINE, approvedState());
    await mod.handler({}, net3.ctx);
    expect(cp.approvals.map((a) => a.result.status)).toEqual(["Approved"]);
    // ...and the gate follows the pipeline's verdict on the next scan.
    const net4 = makeNet(makeCtx(), { batches: [[]], workflows: [workflow()], tickets: [gateRow(LABELS_COLON)] });
    global.fetch = net4.fetch;
    await mod.handler({}, net4.ctx);
    expect([...net3.transitions, ...net4.transitions]).toEqual([expect.objectContaining({ ticketId: GATE, targetStatus: "done" })]);
    expect([...cardsWith(net3, "gok|"), ...cardsWith(net4, "gok|")], "never a ticket card").toHaveLength(0);
  });

  it("(b) ticket first: the pipeline's own card is never sent once the gate ticket paged the execution", async () => {
    const mod = await loadModule({ bucket: BUCKET, registry: registry() });
    cp.states.set(PIPELINE, pendingState(TOKEN, EXEC));
    // One cycle runs the gate scan before the deploy scan; both see the same wait.
    const net1 = makeNet(makeCtx(), { batches: [[]], workflows: [workflow()], tickets: [gateRow(LABELS_COLON)] });
    global.fetch = net1.fetch;
    await mod.handler({}, net1.ctx);
    expect(cardsWith(net1, "gok|"), "the ticket's 🚀 card").toHaveLength(1);
    expect(cardsWith(net1, "dok|"), "and NOT the poller's").toHaveLength(0);
    expect(db.items.get(`paged#${PIPELINE}#${EXEC}`)?.by?.S).toBe("ticket");

    // A later cycle: still one question, still one card.
    const net2 = makeNet(makeCtx(), { batches: [[]], workflows: [workflow()], tickets: [gateRow(LABELS_COLON)] });
    global.fetch = net2.fetch;
    await mod.handler({}, net2.ctx);
    expect(cardsWith(net2, "gok|")).toHaveLength(0);
    expect(cardsWith(net2, "dok|")).toHaveLength(0);
    // The poller's claim is silenced, not stranded: no recovery re-send later either.
    const claim = db.items.get(`dep#${targetKey(PIPELINE, TOKEN)}`);
    expect(claim?.deliveredAt?.N, "claim marked delivered").toBeTruthy();
  });

  it("(c) a ❌ on the poller's card is a rework verdict — the gate ticket still pages", async () => {
    const mod = await loadModule({ bucket: BUCKET, registry: registry() });
    cp.states.set(PIPELINE, pendingState(TOKEN, EXEC));
    const net1 = makeNet(makeCtx(), { batches: [[]] });
    global.fetch = net1.fetch;
    await mod.handler({}, net1.ctx);
    expect(cardsWith(net1, "dok|")).toHaveLength(1);

    cp.states.set(PIPELINE, rejectedState()); // the human tapped 🛑 on that card
    const net2 = makeNet(makeCtx(), { batches: [[]], workflows: [workflow()], tickets: [gateRow(LABELS_COLON)] });
    global.fetch = net2.fetch;
    await mod.handler({}, net2.ctx);
    expect(cardsWith(net2, "gok|"), "the ticket half still needs the human").toHaveLength(1);
    expect(net2.transitions, "nothing auto-closed").toEqual([]);
  });

  it("(d) sibling gates on one run name their PR in the subject", async () => {
    const mod = await loadModule({ bucket: BUCKET, registry: registry() });
    const mergeGate = {
      ticketId: GATE, status: "in review", labels: ["gate:merge", `wf:${WF}`],
      title: "Merge Approval: PR #620 cold-sid session sweep into juno main (TEAM-4968)",
    };
    const wf = workflow({ humanNotifications: [{
      id: "n-merge", type: "review_needed", acknowledged: false, ticketId: GATE, reviewer: "engineer",
      timestamp: new Date().toISOString(), gate: "merge",
      summary: "Approve to merge PR #620 into juno main.",
    }] });
    const net = makeNet(makeCtx(), { batches: [[]], workflows: [wf], tickets: [mergeGate] });
    global.fetch = net.fetch;
    await mod.handler({}, net.ctx);
    expect(cardsWith(net, "gok|")).toHaveLength(1);
    expect(cardsWith(net, "gok|")[0].text).toContain("PR #620");
    expect(cardsWith(net, "gok|")[0].text, "the run title is still the subject").toContain("Sprocket cache for the widget");
    expect(cardsWith(net, "gok|")[0].text, "the ticket's prose is still not rendered").not.toContain("cold-sid session sweep");
  });
});
