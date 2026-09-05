/**
 * CI/CD deploy-approval bridge: the bot polls the AWS-native deploy pipeline
 * (agentcore-hub-deploy) for a ManualApproval action awaiting a decision, pings
 * Telegram with Approve/Reject buttons, and maps the tap back to
 * codepipeline:PutApprovalResult. The account blocks public Lambda endpoints,
 * so SNS→HTTPS is out — this reuses the review-gate poll pattern.
 *
 * Invariants:
 *  1. A pending approval → exactly one ping per allowlisted chat, with dok/dno
 *     buttons; the claim (dep#<key>) dedupes so a re-scan of the same wait
 *     doesn't re-ping.
 *  2. Approve/Reject tap → one PutApprovalResult with the stashed token and the
 *     right status; the claim row is cleared (one-shot token).
 *  3. A non-allowlisted chat tapping the button → only an answerCallbackQuery,
 *     never a PutApprovalResult.
 *  4. DEPLOY_PIPELINE_NAME unset → no pipeline calls at all (OSS / no pipeline).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TG_TOKEN = "111111:test-bot-token";
const HUB = "https://hub.example.invalid";
const PIPELINE = "agentcore-hub-deploy";
const TOKEN = "approval-token-abcdef-0123456789-way-too-long-for-callback-data-field";

// ─── AWS SDK mocks ────────────────────────────────────────────────────────────

const db = vi.hoisted(() => ({ items: new Map(), puts: [], deletes: [] }));
vi.mock("@aws-sdk/client-dynamodb", () => {
  const cmd = (op) => class { constructor(input) { this.input = input; this.op = op; } };
  class DynamoDBClient {
    async send(c) {
      if (c.op === "get") return { Item: db.items.get(c.input.Key.id.S) };
      if (c.op === "put") {
        const id = c.input.Item.id.S;
        if (c.input.ConditionExpression && db.items.has(id)) {
          const err = new Error("conditional failed");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        db.items.set(id, c.input.Item);
        db.puts.push(c.input.Item);
        return {};
      }
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
    DeleteItemCommand: cmd("del"), ScanCommand: cmd("scan"),
  };
});

// cp.state = what GetPipelineState returns; cp.approvals = captured PutApprovalResult;
// cp.stateError (name) = make GetPipelineState throw; cp.putError (name) = make Put throw.
const cp = vi.hoisted(() => ({ state: { stageStates: [] }, approvals: [], stateError: null, putError: null }));
vi.mock("@aws-sdk/client-codepipeline", () => {
  const cmd = (op) => class { constructor(input) { this.input = input; this.op = op; } };
  class CodePipelineClient {
    async send(c) {
      if (c.op === "state") {
        if (cp.stateError) { const e = new Error(cp.stateError); e.name = cp.stateError; throw e; }
        return cp.state;
      }
      if (c.op === "put") {
        if (cp.putError) { const e = new Error(cp.putError); e.name = cp.putError; throw e; }
        cp.approvals.push(c.input);
        return {};
      }
      throw new Error(`unexpected cp op ${c.op}`);
    }
  }
  return { CodePipelineClient, GetPipelineStateCommand: cmd("state"), PutApprovalResultCommand: cmd("put") };
});

vi.mock("@aws-sdk/client-transcribe-streaming", () => ({
  StartStreamTranscriptionCommand: class { constructor(i) { this.input = i; } },
  TranscribeStreamingClient: class { async send() { return { TranscriptResultStream: (async function* () {})() }; } },
}));
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: class { async send() { return { output: { message: { content: [] } } }; } },
  ConverseCommand: class { constructor(i) { this.input = i; } },
}));

// ─── fetch fake ───────────────────────────────────────────────────────────────

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });

function makeNet(ctx, overrides = {}) {
  const net = { ctx, polls: 0, batches: [], afterPoll: [], workflows: [], sent: [], answered: [], edited: [], ...overrides };
  net.fetch = async (url, opts) => {
    const u = String(url);
    // GitHub enrichment for buildDeployBrief — served from net.github when set.
    if (u.startsWith("https://api.github.com/")) {
      if (u.includes("/pulls")) return jsonRes(net.github?.pulls ?? []);
      if (u.includes("/commits/")) return jsonRes(net.github?.commit ?? {});
      return jsonRes({});
    }
    if (u === `${HUB}/api/workflow/list`) return jsonRes({ workflows: net.workflows });
    if (u.endsWith("/getUpdates")) {
      const i = net.polls++;
      net.ctx.remainingMs = net.afterPoll[i] ?? 20_000;
      return jsonRes({ ok: true, result: net.batches[i] || [] });
    }
    if (u.endsWith("/sendMessage")) { net.sent.push(JSON.parse(opts.body)); return jsonRes({ ok: true, result: {} }); }
    if (u.endsWith("/answerCallbackQuery")) { net.answered.push(JSON.parse(opts.body)); return jsonRes({ ok: true, result: true }); }
    if (u.endsWith("/editMessageText")) { net.edited.push(JSON.parse(opts.body)); return jsonRes({ ok: true, result: {} }); }
    if (u.endsWith("/sendChatAction")) return jsonRes({ ok: true, result: true });
    throw new Error(`unexpected fetch: ${u}`);
  };
  return net;
}

function makeCtx(startMs) { return { remainingMs: startMs, getRemainingTimeInMillis() { return this.remainingMs; } }; }

const ENV = {
  TELEGRAM_BOT_TOKEN: TG_TOKEN,
  JIRA_SITE_URL: "example.atlassian.net", JIRA_EMAIL: "bot@example.com",
  JIRA_API_TOKEN: "tok", JIRA_PROJECT_KEY: "TEST",
  GITHUB_TOKEN: "gh", GITHUB_USER: "test-user",
  PENDING_TABLE: "test-pending-table", HUB_API_URL: HUB,
};

async function loadHandler({ allowed, pipeline } = {}) {
  vi.resetModules();
  Object.assign(process.env, ENV);
  if (allowed == null) delete process.env.ALLOWED_CHAT_IDS; else process.env.ALLOWED_CHAT_IDS = allowed;
  if (pipeline == null) delete process.env.DEPLOY_PIPELINE_NAME; else process.env.DEPLOY_PIPELINE_NAME = pipeline;
  return (await import("../index.mjs")).handler;
}

const realFetch = global.fetch;
beforeEach(() => {
  db.items.clear(); db.puts.length = 0; db.deletes.length = 0;
  cp.state = { stageStates: [] }; cp.approvals.length = 0; cp.stateError = null; cp.putError = null;
});
afterAll(() => {
  global.fetch = realFetch;
  for (const k of [...Object.keys(ENV), "ALLOWED_CHAT_IDS", "DEPLOY_PIPELINE_NAME"]) delete process.env[k];
});

const registerChat = (id) => db.items.set(`chat#${id}`, { id: { S: `chat#${id}` }, chatId: { N: String(id) } });
const pendingState = () => ({
  stageStates: [
    { stageName: "Build", actionStates: [{ actionName: "Build", latestExecution: { status: "Succeeded" } }] },
    { stageName: "Approval", actionStates: [{
      actionName: "Approve_deploy",
      entityUrl: "https://github.com/o/r/commits/main",
      latestExecution: { status: "InProgress", token: TOKEN },
    }] },
    { stageName: "Deploy", actionStates: [{ actionName: "Deploy_three_targets", latestExecution: {} }] },
  ],
});
const cbUpdate = (updateId, chatId, data) => ({
  update_id: updateId,
  callback_query: { id: `cb-${updateId}`, data, message: { message_id: 9, chat: { id: chatId }, text: "🚀 Deploy approval — agentcore-hub-deploy" } },
});

describe("deploy-approval bridge", () => {
  it("pings allowlisted chat once with dok/dno buttons; re-scan doesn't re-ping", async () => {
    const handler = await loadHandler({ allowed: "555", pipeline: PIPELINE });
    registerChat(555);
    cp.state = pendingState();
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { batches: [[], []], afterPoll: [20_000, 20_000] });
    global.fetch = net.fetch;

    await handler({}, ctx);
    // start-scan + one in-loop 60s scan won't refire in a 100s ctx, so exactly one ping.
    expect(net.sent.length, "one deploy-approval ping").toBe(1);
    const kb = net.sent[0].reply_markup.inline_keyboard;
    const btns = kb.flat().map((b) => b.callback_data).filter(Boolean);
    expect(btns.some((d) => d.startsWith("dok|"))).toBe(true);
    expect(btns.some((d) => d.startsWith("dno|"))).toBe(true);
    for (const d of btns) expect(d.length, "callback_data within Telegram's 64-byte cap").toBeLessThanOrEqual(64);
    expect(kb.flat().some((b) => b.url === "https://github.com/o/r/commits/main"), "view-commit link").toBe(true);

    // Second invocation, same wait/token → claim already held → no second ping.
    const net2 = makeNet(makeCtx(100_000), { batches: [[]] });
    global.fetch = net2.fetch;
    cp.state = pendingState();
    await handler({}, net2.ctx);
    expect(net2.sent.length, "same wait must not re-ping").toBe(0);
  });

  it("Approve tap → PutApprovalResult Approved with the stashed token; claim cleared", async () => {
    const handler = await loadHandler({ allowed: "555", pipeline: PIPELINE });
    registerChat(555);
    cp.state = pendingState();
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { batches: [[]] });
    global.fetch = net.fetch;
    await handler({}, ctx); // produces the ping + claim

    const dok = net.sent[0].reply_markup.inline_keyboard.flat().find((b) => b.callback_data?.startsWith("dok|"));
    const key = dok.callback_data.split("|")[1];

    const net2 = makeNet(makeCtx(100_000), { batches: [[cbUpdate(301, 555, `dok|${key}`)]] });
    global.fetch = net2.fetch;
    cp.state = { stageStates: [] }; // wait's gone now; only the callback matters
    await handler({}, net2.ctx);

    expect(cp.approvals.length).toBe(1);
    expect(cp.approvals[0]).toMatchObject({ pipelineName: PIPELINE, stageName: "Approval", actionName: "Approve_deploy", token: TOKEN });
    expect(cp.approvals[0].result.status).toBe("Approved");
    expect(db.deletes).toContain(`dep#${key}`);
    expect(net2.answered[0].text).toMatch(/approved/i);
  });

  it("Reject tap → PutApprovalResult Rejected", async () => {
    const handler = await loadHandler({ allowed: "555", pipeline: PIPELINE });
    registerChat(555);
    cp.state = pendingState();
    const net = makeNet(makeCtx(100_000), { batches: [[]] });
    global.fetch = net.fetch;
    await handler({}, net.ctx);
    const key = net.sent[0].reply_markup.inline_keyboard.flat().find((b) => b.callback_data?.startsWith("dno|")).callback_data.split("|")[1];

    const net2 = makeNet(makeCtx(100_000), { batches: [[cbUpdate(302, 555, `dno|${key}`)]] });
    global.fetch = net2.fetch;
    cp.state = { stageStates: [] };
    await handler({}, net2.ctx);

    expect(cp.approvals.length).toBe(1);
    expect(cp.approvals[0].result.status).toBe("Rejected");
    expect(net2.answered[0].text).toMatch(/rejected/i);
  });

  it("non-allowlisted chat tapping the button never records an approval", async () => {
    const handler = await loadHandler({ allowed: "555", pipeline: PIPELINE });
    registerChat(555);
    cp.state = pendingState();
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { batches: [[]] });
    global.fetch = net.fetch;
    await handler({}, ctx);
    const key = net.sent[0].reply_markup.inline_keyboard.flat().find((b) => b.callback_data?.startsWith("dok|")).callback_data.split("|")[1];

    const net2 = makeNet(makeCtx(100_000), { batches: [[cbUpdate(401, 999, `dok|${key}`)]] });
    global.fetch = net2.fetch;
    cp.state = { stageStates: [] };
    await handler({}, net2.ctx);

    expect(cp.approvals.length, "unauthorized chat must not approve a deploy").toBe(0);
    expect(net2.answered[0].text).toMatch(/not authorized/i);
  });

  it("brief summary = the Summary section, not the ship-review status line; subject not cut mid-key", async () => {
    const handler = await loadHandler({ allowed: "555", pipeline: PIPELINE });
    registerChat(555);
    // A pending approval whose Source revision is a real SHA → buildDeployBrief runs.
    const st = pendingState();
    st.stageStates[0].actionStates[0].currentRevision = { revisionId: "0cf3f09abc123" };
    cp.state = st;

    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, {
      batches: [[]],
      github: {
        commit: { commit: { message: "fix(workflow): submit_workflow source validation (TEAM-4054)" },
          stats: { additions: 3415, deletions: 74 }, files: new Array(24).fill({}) },
        pulls: [{
          number: 512,
          title: "fix(workflow): submit_workflow source validation — real S3 HeadObject errors, GET-signed presigned URL check, lenient unverified mode (TEAM-4054)",
          html_url: "https://github.com/o/r/pull/512",
          body: [
            "Status: SHIP REVIEW ROUND 3 (head `45694ddc`) = PASS — awaiting the human Merge Approval gate (TEAM-4067).",
            "Do NOT merge by hand; CD ticket TEAM-4068 performs the squash-merge + `agentcore-hub-deploy`.",
            "",
            "## Summary",
            "Validates the submit_workflow source ref against S3 before a run starts, surfacing the real HeadObject error instead of a generic failure, and adds a lenient unverified mode for presigned URLs.",
            "",
            "## Testing",
            "- [x] unit",
          ].join("\n"),
        }],
      },
    });
    global.fetch = net.fetch;
    await handler({}, ctx);

    expect(net.sent.length).toBe(1);
    const text = net.sent[0].text;
    // The human-meaningful summary is present… (esc() escapes _, so match a
    // substring free of Markdown-escaped chars).
    expect(text).toMatch(/source ref against S3 before a run starts/);
    // …and the process/status chatter is NOT the summary.
    expect(text).not.toMatch(/SHIP REVIEW ROUND 3/);
    expect(text).not.toMatch(/Do NOT merge by hand/);
    // Subject dropped the trailing (TEAM-4054) and never cut mid-token "(TEAM-".
    expect(text).not.toMatch(/\(TEAM-\s|\(TEAM-$|\(TEAM-\n/);
    expect(text).toMatch(/Workflow: TEAM-4054/);
    expect(text).toMatch(/Scope: 24 files \(\+3415\/-74\)/);
  });

  it("DEPLOY_PIPELINE_NAME unset → no pipeline calls, no ping", async () => {
    const handler = await loadHandler({ allowed: "555" }); // pipeline unset
    registerChat(555);
    cp.state = pendingState();
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { batches: [[]] });
    global.fetch = net.fetch;
    await handler({}, ctx);
    expect(net.sent.length).toBe(0);
    expect(cp.approvals.length).toBe(0);
  });
});
