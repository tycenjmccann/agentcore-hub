/**
 * CI/CD deploy-approval bridge: the bot polls the AWS-native deploy pipelines
 * for a ManualApproval action awaiting a decision, pings Telegram with
 * Approve/Reject buttons, and maps the tap back to
 * codepipeline:PutApprovalResult. The account blocks public Lambda endpoints,
 * so SNS→HTTPS is out — this reuses the review-gate poll pattern.
 *
 * Which pipelines it watches (TEAM-4338): every CD-registry entry that names a
 * pipeline, in that entry's own region, plus the DEPLOY_PIPELINE_NAME fallback.
 *
 * Invariants:
 *  1. A pending approval → exactly one ping per allowlisted chat, with dok/dno
 *     buttons; the claim (dep#<key>) dedupes so a re-scan of the same wait
 *     doesn't re-ping.
 *  2. Approve/Reject tap → one PutApprovalResult with the stashed token and the
 *     right status, sent to the claim's OWN region; the claim row is cleared
 *     (one-shot token).
 *  3. A non-allowlisted chat tapping the button → only an answerCallbackQuery,
 *     never a PutApprovalResult.
 *  4. DEPLOY_PIPELINE_NAME *and* ARTIFACT_BUCKET unset → no AWS calls at all
 *     (OSS / no pipeline): not one GetPipelineState, not one registry read.
 *  5. One target's failure never costs another target its ping.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TG_TOKEN = "111111:test-bot-token";
const HUB = "https://hub.example.invalid";
const PIPELINE = "agentcore-hub-deploy";
const TOKEN = "approval-token-abcdef-0123456789-way-too-long-for-callback-data-field";
// A second registered repo's pipeline, in another region (TEAM-4338).
const WIDGET = "hub-widget-deploy";
const WIDGET_REPO = "acme/widget";
const TOKEN2 = "approval-token-widget-9876543210-also-way-too-long-for-callback-data";
const BUCKET = "test-artifact-bucket";
const CD_REGISTRY_KEY = "config/cd-registry.json";

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

/**
 * CodePipeline state is keyed BY PIPELINE NAME now, with a `"*"` wildcard entry
 * that answers for every pipeline — which is what the single-pipeline accessors
 * (`cp.state = …`, `cp.stateError = …`, `cp.putError = …`) write, so a test that
 * only cares about "the" pipeline reads exactly as it did before.
 *   cp.states / cp.stateErrors / cp.putErrors — per-name overrides (Maps).
 *   cp.approvals     — raw PutApprovalResult inputs (unchanged shape).
 *   cp.approvalCalls — the same calls tagged with the CLIENT's region, which is
 *                      how "the right region approved it" is asserted.
 *   cp.sends / cp.inits — every send / every client construction, for the
 *                      "nothing configured → no AWS calls" invariant.
 */
const cp = vi.hoisted(() => {
  const s = {
    states: new Map(), stateErrors: new Map(), putErrors: new Map(),
    approvals: [], approvalCalls: [], sends: [], inits: [],
  };
  for (const [prop, map] of [["state", "states"], ["stateError", "stateErrors"], ["putError", "putErrors"]]) {
    Object.defineProperty(s, prop, {
      get: () => s[map].get("*"),
      set: (v) => { s[map].set("*", v); },
    });
  }
  return s;
});
/** A per-name override when present, else the `"*"` wildcard. */
const pick = (map, name) => (map.has(name) ? map.get(name) : map.get("*"));

vi.mock("@aws-sdk/client-codepipeline", () => {
  const cmd = (op) => class { constructor(input) { this.input = input; this.op = op; } };
  class CodePipelineClient {
    constructor(cfg) { this.region = cfg?.region; cp.inits.push(cfg?.region); }
    async send(c) {
      cp.sends.push({ op: c.op, region: this.region, input: c.input });
      if (c.op === "state") {
        const err = pick(cp.stateErrors, c.input?.name);
        if (err) { const e = new Error(err); e.name = err; throw e; }
        return pick(cp.states, c.input?.name) || { stageStates: [] };
      }
      if (c.op === "put") {
        const err = pick(cp.putErrors, c.input?.pipelineName);
        if (err) { const e = new Error(err); e.name = err; throw e; }
        cp.approvals.push(c.input);
        cp.approvalCalls.push({ region: this.region, pipelineName: c.input?.pipelineName, input: c.input });
        return {};
      }
      throw new Error(`unexpected cp op ${c.op}`);
    }
  }
  return { CodePipelineClient, GetPipelineStateCommand: cmd("state"), PutApprovalResultCommand: cmd("put") };
});

// Key-aware S3: the bridge reads exactly ONE key (the CD registry). `registry`
// null → NoSuchKey, which is also what an install with no registry yet sees.
const s3 = vi.hoisted(() => ({ calls: [], inits: [], registry: null }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    constructor(cfg) { this.region = cfg?.region; s3.inits.push(cfg?.region); }
    async send(c) {
      s3.calls.push(c.input);
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
}));

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
  const net = { ctx, polls: 0, batches: [], afterPoll: [], workflows: [], sent: [], answered: [], edited: [], fetched: [], ...overrides };
  net.fetch = async (url, opts) => {
    const u = String(url);
    net.fetched.push(u);
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
  // Pinned so the default-region client (legacy claims, env target) is deterministic.
  AWS_REGION: "us-east-1",
};

async function loadHandler({ allowed, pipeline, bucket, registry } = {}) {
  vi.resetModules();
  Object.assign(process.env, ENV);
  if (allowed == null) delete process.env.ALLOWED_CHAT_IDS; else process.env.ALLOWED_CHAT_IDS = allowed;
  if (pipeline == null) delete process.env.DEPLOY_PIPELINE_NAME; else process.env.DEPLOY_PIPELINE_NAME = pipeline;
  if (bucket == null) delete process.env.ARTIFACT_BUCKET; else process.env.ARTIFACT_BUCKET = bucket;
  s3.registry = registry ?? null;
  return (await import("../index.mjs")).handler;
}

const realFetch = global.fetch;
beforeEach(() => {
  db.items.clear(); db.puts.length = 0; db.deletes.length = 0;
  cp.states.clear(); cp.stateErrors.clear(); cp.putErrors.clear();
  cp.approvals.length = 0; cp.approvalCalls.length = 0; cp.sends.length = 0; cp.inits.length = 0;
  s3.calls.length = 0; s3.inits.length = 0; s3.registry = null;
  cp.state = { stageStates: [] }; cp.stateError = null; cp.putError = null;
});
afterAll(() => {
  global.fetch = realFetch;
  for (const k of [...Object.keys(ENV), "ALLOWED_CHAT_IDS", "DEPLOY_PIPELINE_NAME", "ARTIFACT_BUCKET"]) delete process.env[k];
});

const registerChat = (id) => db.items.set(`chat#${id}`, { id: { S: `chat#${id}` }, chatId: { N: String(id) } });
/**
 * A pipeline state with one ManualApproval action awaiting a decision. `token`
 * defaults to TOKEN (so existing no-arg callers are unchanged); a second target
 * needs its own token, since the claim key is derived from pipeline + token.
 */
const pendingState = (token = TOKEN, { revision } = {}) => ({
  stageStates: [
    { stageName: "Build", actionStates: [{
      actionName: "Build",
      latestExecution: { status: "Succeeded" },
      ...(revision ? { currentRevision: { revisionId: revision } } : {}),
    }] },
    { stageName: "Approval", actionStates: [{
      actionName: "Approve_deploy",
      entityUrl: "https://github.com/o/r/commits/main",
      latestExecution: { status: "InProgress", token },
    }] },
    { stageName: "Deploy", actionStates: [{ actionName: "Deploy_three_targets", latestExecution: {} }] },
  ],
});
const cbUpdate = (updateId, chatId, data) => ({
  update_id: updateId,
  callback_query: { id: `cb-${updateId}`, data, message: { message_id: 9, chat: { id: chatId }, text: "🚀 Deploy approval — agentcore-hub-deploy" } },
});

/** Two registered pipelines in two regions, plus a DEPLOY.md-mode repo that has
 * no pipeline and must therefore NOT become a target. */
const REGISTRY_TWO = {
  version: 1,
  repos: [
    { repo: "test-user/agentcore-hub", pipeline: PIPELINE, region: "us-east-1" },
    { repo: WIDGET_REPO, pipeline: WIDGET, region: "us-west-2" },
    { repo: "acme/legacy", deployDoc: "docs/DEPLOY.md" },
  ],
};

/** The dok/dno callback_data values on a ping. */
const btnData = (msg) => msg.reply_markup.inline_keyboard.flat().map((b) => b.callback_data).filter(Boolean);
/** The dok key on a ping. */
const dokKey = (msg) => btnData(msg).find((d) => d.startsWith("dok|")).split("|")[1];

/** hashToken() from index.mjs (djb2), copied so the tests pin the KEY SHAPE
 *  rather than whatever the implementation currently produces. */
const djb2 = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const legacyKey = (token) => `dp${djb2(token)}`;                        // pre-TEAM-4338 shape
const targetKey = (pipeline, token) => `dp${djb2(`${pipeline} ${token}`)}`;
const claimIds = () => db.puts.filter((i) => i.id.S.startsWith("dep#")).map((i) => i.id.S);

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

  // ─── multi-target off the CD registry (TEAM-4338) ───────────────────────────

  it("two registered pipelines in two regions → two pings, each approved in its own region", async () => {
    const handler = await loadHandler({ allowed: "555", bucket: BUCKET, registry: REGISTRY_TWO });
    registerChat(555);
    cp.states.set(PIPELINE, pendingState(TOKEN));
    cp.states.set(WIDGET, pendingState(TOKEN2));

    const net = makeNet(makeCtx(100_000), { batches: [[]] });
    global.fetch = net.fetch;
    await handler({}, net.ctx);

    expect(net.sent.length, "one ping per registered pipeline").toBe(2);
    const claims = db.puts.filter((i) => i.id.S.startsWith("dep#"));
    expect(claims.length).toBe(2);
    expect(claims.map((c) => c.pipelineName.S).sort()).toEqual([PIPELINE, WIDGET]);
    expect(claims.map((c) => c.region.S).sort()).toEqual(["us-east-1", "us-west-2"]);
    // The DEPLOY.md-mode repo has no pipeline, so it was never polled.
    const polled = cp.sends.filter((s) => s.op === "state").map((s) => s.input.name);
    expect(polled.sort()).toEqual([PIPELINE, WIDGET]);

    // Tap Approve on both pings; each must be recorded on its own pipeline, by a
    // client constructed for that pipeline's region.
    const keys = net.sent.map(dokKey);
    const net2 = makeNet(makeCtx(100_000), {
      batches: [keys.map((k, i) => cbUpdate(500 + i, 555, `dok|${k}`))],
    });
    global.fetch = net2.fetch;
    cp.states.clear();
    await handler({}, net2.ctx);

    expect(cp.approvalCalls.length).toBe(2);
    const byPipeline = Object.fromEntries(cp.approvalCalls.map((c) => [c.pipelineName, c]));
    expect(byPipeline[PIPELINE].region).toBe("us-east-1");
    expect(byPipeline[PIPELINE].input.token).toBe(TOKEN);
    expect(byPipeline[WIDGET].region).toBe("us-west-2");
    expect(byPipeline[WIDGET].input.token).toBe(TOKEN2);
  });

  it("env DEPLOY_PIPELINE_NAME and a registry entry naming it are ONE target", async () => {
    const handler = await loadHandler({
      allowed: "555", pipeline: PIPELINE, bucket: BUCKET,
      registry: { version: 1, repos: [{ repo: "test-user/agentcore-hub", pipeline: PIPELINE, region: "us-east-1" }] },
    });
    registerChat(555);
    cp.state = pendingState();

    const net = makeNet(makeCtx(100_000), { batches: [[]] });
    global.fetch = net.fetch;
    await handler({}, net.ctx);

    expect(net.sent.length, "the env fallback must not duplicate a registered pipeline").toBe(1);
    expect(cp.sends.filter((s) => s.op === "state").length).toBe(1);
    expect(db.puts.filter((i) => i.id.S.startsWith("dep#")).length).toBe(1);
  });

  it("a foreign repo's brief is enriched from THAT repo, and the ping names pipeline + repo", async () => {
    const handler = await loadHandler({
      allowed: "555", bucket: BUCKET,
      registry: { version: 1, repos: [{ repo: WIDGET_REPO, pipeline: WIDGET, region: "us-west-2" }] },
    });
    registerChat(555);
    cp.states.set(WIDGET, pendingState(TOKEN2, { revision: "abc1234def567" }));

    const net = makeNet(makeCtx(100_000), {
      batches: [[]],
      github: {
        commit: { commit: { message: "feat(widget): add sprocket cache" }, stats: { additions: 12, deletions: 3 }, files: new Array(2).fill({}) },
        pulls: [{ number: 7, title: "feat(widget): add sprocket cache", html_url: "https://github.com/acme/widget/pull/7", body: "## Summary\nCaches sprockets between builds." }],
      },
    });
    global.fetch = net.fetch;
    await handler({}, net.ctx);

    expect(net.sent.length).toBe(1);
    // The GitHub enrichment hit the REGISTERED repo, not the hub's own.
    const ghUrls = net.fetched.filter((u) => u.startsWith("https://api.github.com/"));
    expect(ghUrls.length).toBeGreaterThan(0);
    for (const u of ghUrls) expect(u.startsWith(`https://api.github.com/repos/${WIDGET_REPO}/`)).toBe(true);
    expect(ghUrls.some((u) => u.includes("/commits/abc1234def567"))).toBe(true);
    // …and a human can see WHICH pipeline and WHICH repo they are shipping.
    expect(net.sent[0].text).toContain(WIDGET);
    expect(net.sent[0].text).toContain(WIDGET_REPO);
    expect(net.sent[0].text).toMatch(/Caches sprockets between builds/);
  });

  it("one target's GetPipelineState failure does not cost the other target its ping", async () => {
    const handler = await loadHandler({ allowed: "555", bucket: BUCKET, registry: REGISTRY_TWO });
    registerChat(555);
    cp.stateErrors.set(PIPELINE, "PipelineNotFoundException");
    cp.states.set(WIDGET, pendingState(TOKEN2));

    const net = makeNet(makeCtx(100_000), { batches: [[]] });
    global.fetch = net.fetch;
    await handler({}, net.ctx);

    expect(net.sent.length, "the healthy pipeline still pings").toBe(1);
    const claims = db.puts.filter((i) => i.id.S.startsWith("dep#"));
    expect(claims.map((c) => c.pipelineName.S)).toEqual([WIDGET]);
  });

  it("a legacy claim row with no region still approves, via the default-region client", async () => {
    const handler = await loadHandler({ allowed: "555" }); // nothing configured; only the callback matters
    registerChat(555);
    // Exactly the item shape written before TEAM-4338: no region, no repo.
    db.items.set("dep#dplegacy", {
      id: { S: "dep#dplegacy" },
      pipelineName: { S: PIPELINE },
      stageName: { S: "Approval" },
      actionName: { S: "Approve_deploy" },
      token: { S: TOKEN },
    });

    const net = makeNet(makeCtx(100_000), { batches: [[cbUpdate(601, 555, "dok|dplegacy")]] });
    global.fetch = net.fetch;
    await handler({}, net.ctx);

    expect(cp.approvalCalls.length).toBe(1);
    expect(cp.approvalCalls[0].region, "falls back to the region the only pipeline lived in").toBe("us-east-1");
    expect(cp.approvalCalls[0].input).toMatchObject({ pipelineName: PIPELINE, token: TOKEN });
    expect(cp.approvalCalls[0].input.result.status).toBe("Approved");
    expect(db.deletes).toContain("dep#dplegacy");
  });

  it("nothing configured (no ARTIFACT_BUCKET, no DEPLOY_PIPELINE_NAME) → zero S3 and CodePipeline calls", async () => {
    const handler = await loadHandler({ allowed: "555" });
    registerChat(555);
    cp.state = pendingState();
    const net = makeNet(makeCtx(100_000), { batches: [[]] });
    global.fetch = net.fetch;
    await handler({}, net.ctx);

    expect(s3.calls, "no registry read without a bucket").toEqual([]);
    expect(cp.sends, "no pipeline call without a target").toEqual([]);
    // Not even a client: the deploy path is inert on an OSS install.
    expect(s3.inits).toEqual([]);
    expect(cp.inits).toEqual([]);
    expect(net.sent.length).toBe(0);
  });

  it("callback_data stays dok|/dno| and within 64 bytes for registry targets", async () => {
    const handler = await loadHandler({ allowed: "555", bucket: BUCKET, registry: REGISTRY_TWO });
    registerChat(555);
    cp.states.set(PIPELINE, pendingState(TOKEN));
    cp.states.set(WIDGET, pendingState(TOKEN2));

    const net = makeNet(makeCtx(100_000), { batches: [[]] });
    global.fetch = net.fetch;
    await handler({}, net.ctx);

    expect(net.sent.length).toBe(2);
    const all = net.sent.flatMap(btnData);
    expect(all.length).toBe(4);
    for (const d of all) {
      expect(d).toMatch(/^d(ok|no)\|dp[0-9a-z]+$/);
      expect(Buffer.byteLength(d, "utf8"), "Telegram's 64-byte callback_data cap").toBeLessThanOrEqual(64);
    }
    // Two targets → two DIFFERENT keys (the pipeline is part of the hash input).
    expect(new Set(all.map((d) => d.split("|")[1])).size).toBe(2);
  });

  // ─── F4: registry repo can't steer the GitHub call (TEAM-4347) ────────────

  it.each(["acme/widget?per_page=1", "acme/..", "acme/widget#x", "acme/re po"])(
    "a registry repo containing metacharacters (%s) never reaches the GitHub API",
    async (badRepo) => {
      const handler = await loadHandler({
        allowed: "555", bucket: BUCKET,
        registry: { version: 1, repos: [{ repo: badRepo, pipeline: WIDGET, region: "us-west-2" }] },
      });
      registerChat(555);
      cp.states.set(WIDGET, pendingState(TOKEN2, { revision: "abc1234def567" }));

      const net = makeNet(makeCtx(100_000), { batches: [[]] });
      global.fetch = net.fetch;
      await handler({}, net.ctx);

      const ghUrls = net.fetched.filter((u) => u.startsWith("https://api.github.com/"));
      expect(ghUrls, "an unsafe repo must never reach the GitHub API").toEqual([]);
      expect(net.sent.length, "the approval ping still goes out on the terse path").toBe(1);
    },
  );

  it("an unsafe repo skips enrichment but the gate still pings on the terse path", async () => {
    const badRepo = "acme/widget?per_page=1";
    const handler = await loadHandler({
      allowed: "555", bucket: BUCKET,
      registry: { version: 1, repos: [{ repo: badRepo, pipeline: WIDGET, region: "us-west-2" }] },
    });
    registerChat(555);
    cp.states.set(WIDGET, pendingState(TOKEN2, { revision: "abc1234def567" }));

    const net = makeNet(makeCtx(100_000), { batches: [[]] });
    global.fetch = net.fetch;
    await handler({}, net.ctx);

    expect(net.sent.length).toBe(1);
    const text = net.sent[0].text;
    expect(text).not.toMatch(/Workflow:/);
    expect(text).not.toMatch(/Scope:/);
    expect(text).not.toMatch(/Commit:/);
    expect(text).toContain(WIDGET);
  });

  it("a valid registry repo with dots/underscores still enriches from that repo", async () => {
    const goodRepo = "acme/widget_v2.0";
    const handler = await loadHandler({
      allowed: "555", bucket: BUCKET,
      registry: { version: 1, repos: [{ repo: goodRepo, pipeline: WIDGET, region: "us-west-2" }] },
    });
    registerChat(555);
    cp.states.set(WIDGET, pendingState(TOKEN2, { revision: "abc1234def567" }));

    const net = makeNet(makeCtx(100_000), {
      batches: [[]],
      github: {
        commit: { commit: { message: "feat(widget): bump" }, stats: { additions: 1, deletions: 1 }, files: [{}] },
        pulls: [{ number: 1, title: "feat(widget): bump", html_url: "https://github.com/acme/widget_v2.0/pull/1", body: "## Summary\nBumps the widget." }],
      },
    });
    global.fetch = net.fetch;
    await handler({}, net.ctx);

    const ghUrls = net.fetched.filter((u) => u.startsWith("https://api.github.com/"));
    expect(ghUrls.length).toBeGreaterThan(0);
    for (const u of ghUrls) expect(u.startsWith(`https://api.github.com/repos/${goodRepo}/`)).toBe(true);
  });

  it("the env fallback repo (GITHUB_USER/agentcore-hub) is accepted", async () => {
    const handler = await loadHandler({ allowed: "555", pipeline: PIPELINE });
    registerChat(555);
    const st = pendingState();
    st.stageStates[0].actionStates[0].currentRevision = { revisionId: "abc1234def567" };
    cp.state = st;

    const net = makeNet(makeCtx(100_000), {
      batches: [[]],
      github: {
        commit: { commit: { message: "chore: bump" }, stats: { additions: 1, deletions: 1 }, files: [{}] },
        pulls: [],
      },
    });
    global.fetch = net.fetch;
    await handler({}, net.ctx);

    const ghUrls = net.fetched.filter((u) => u.startsWith("https://api.github.com/"));
    expect(ghUrls.length).toBeGreaterThan(0);
    for (const u of ghUrls) expect(u.startsWith("https://api.github.com/repos/test-user/agentcore-hub/")).toBe(true);
  });

  it("warns once per bad repo, not once per scan", async () => {
    const badRepo = "acme/widget?x=1";
    const handler = await loadHandler({
      allowed: "555", bucket: BUCKET,
      registry: { version: 1, repos: [{ repo: badRepo, pipeline: WIDGET, region: "us-west-2" }] },
    });
    registerChat(555);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      cp.states.set(WIDGET, pendingState(TOKEN2, { revision: "abc1234def567" }));
      const net1 = makeNet(makeCtx(100_000), { batches: [[]] });
      global.fetch = net1.fetch;
      await handler({}, net1.ctx);

      // Second scan, same wait would be deduped by the claim — use a fresh token
      // so the ping (and therefore buildDeployBrief) actually runs again.
      cp.states.set(WIDGET, pendingState("approval-token-widget-second-9999999999-also-way-too-long"));
      const net2 = makeNet(makeCtx(100_000), { batches: [[]] });
      global.fetch = net2.fetch;
      await handler({}, net2.ctx);

      expect(net1.sent.length + net2.sent.length, "both scans still ping").toBe(2);
      const unsafeWarnings = warnSpy.mock.calls.filter((args) => /unsafe repo/.test(args[0]));
      expect(unsafeWarnings.length, "warn once per bad repo per container, not once per scan").toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ─── F5: no double ping across the claim-key upgrade (TEAM-4347) ──────────

  it("an approval claimed under the legacy key shape does not re-ping after the upgrade", async () => {
    const handler = await loadHandler({ allowed: "555", pipeline: PIPELINE });
    registerChat(555);
    db.items.set(`dep#${legacyKey(TOKEN)}`, {
      id: { S: `dep#${legacyKey(TOKEN)}` },
      pipelineName: { S: PIPELINE },
      stageName: { S: "Approval" },
      actionName: { S: "Approve_deploy" },
      token: { S: TOKEN },
    });
    cp.state = pendingState();

    const net = makeNet(makeCtx(100_000), { batches: [[]] });
    global.fetch = net.fetch;
    await handler({}, net.ctx);

    expect(net.sent.length, "already claimed under the legacy key — must not re-ping").toBe(0);
    expect(claimIds()).toEqual([]);
  });

  it("the hub registered in the registry still uses the legacy key, so a widget ping is the only one", async () => {
    const handler = await loadHandler({ allowed: "555", pipeline: PIPELINE, bucket: BUCKET, registry: REGISTRY_TWO });
    registerChat(555);
    db.items.set(`dep#${legacyKey(TOKEN)}`, {
      id: { S: `dep#${legacyKey(TOKEN)}` },
      pipelineName: { S: PIPELINE },
      stageName: { S: "Approval" },
      actionName: { S: "Approve_deploy" },
      token: { S: TOKEN },
    });
    cp.states.set(PIPELINE, pendingState(TOKEN));
    cp.states.set(WIDGET, pendingState(TOKEN2));

    const net = makeNet(makeCtx(100_000), { batches: [[]] });
    global.fetch = net.fetch;
    await handler({}, net.ctx);

    expect(net.sent.length, "only the widget pings — the hub wait was already claimed under the legacy key").toBe(1);
    expect(claimIds()).toEqual([`dep#${targetKey(WIDGET, TOKEN2)}`]);
    const widgetClaim = db.puts.find((i) => i.id.S === `dep#${targetKey(WIDGET, TOKEN2)}`);
    expect(widgetClaim.pipelineName.S).toBe(WIDGET);
  });

  it("claim keys: legacy shape for the env pipeline, pipeline-scoped for the rest", async () => {
    const handler = await loadHandler({ allowed: "555", pipeline: PIPELINE, bucket: BUCKET, registry: REGISTRY_TWO });
    registerChat(555);
    cp.states.set(PIPELINE, pendingState(TOKEN));
    cp.states.set(WIDGET, pendingState(TOKEN2));

    const net = makeNet(makeCtx(100_000), { batches: [[]] });
    global.fetch = net.fetch;
    await handler({}, net.ctx);

    expect(claimIds().sort()).toEqual(
      [`dep#${legacyKey(TOKEN)}`, `dep#${targetKey(WIDGET, TOKEN2)}`].sort(),
    );
    const all = net.sent.flatMap(btnData);
    expect(all.length).toBe(4);
    for (const d of all) {
      expect(d).toMatch(/^d(ok|no)\|dp[0-9a-z]+$/);
      expect(Buffer.byteLength(d, "utf8"), "Telegram's 64-byte callback_data cap").toBeLessThanOrEqual(64);
    }
  });
});
