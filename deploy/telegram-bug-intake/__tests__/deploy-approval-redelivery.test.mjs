/**
 * TEAM-4663 — a pending production-deploy approval must never go quiet.
 *
 * The incident: CodePipeline sat on Approval/Approve_deploy for 8h45m with no
 * actionable Telegram ping, while the same Lambda kept delivering review-gate
 * pings to the same chat. The `dep#` claim row was written BEFORE listChats +
 * three GitHub calls + tgSend, recorded nothing about delivery, and every later
 * scan bailed on `!claimed` — so one invocation killed mid-scan parked an
 * irreversible prod deploy behind a 7-day row that nothing could detect or
 * recover.
 *
 * The invariant this file pins: a pending Approve_deploy is either pinged with a
 * working Approve/Reject callback, or re-pinged on a bounded schedule when the
 * first delivery cannot be confirmed. Concretely:
 *
 *   T1  an undelivered claim past PING_LEASE_MS is re-taken and re-sent, exactly
 *       once; inside the lease nothing is sent (a send may be in flight); a
 *       PRE-UPGRADE row derives its claim time from the TTL, which is what gives
 *       the row stranded by the incident its one recovery ping.
 *   T2  a DELIVERED claim on a still-pending approval earns a bounded reminder —
 *       every DEPLOY_REPING_INTERVAL_MS, at most DEPLOY_REPING_MAX, on the SAME
 *       dok|/dno| key so the original token still works.
 *   T3  a rich message Telegram rejects falls back once to plain text, so a
 *       brief can degrade the ping but never block the decision — and the claim
 *       is NOT released, which is what used to loop release→re-claim→same 400.
 *   T4  the commit named is the one the WAITING execution ships, never the
 *       newest revision in the pipeline.
 *   T5  the in-loop scans only start with real runway, and a blocked scan does
 *       not burn its 60s window.
 *
 * Harness is deploy-approval.test.mjs's, with the claim row seeded directly:
 * every state this file cares about is a row a previous invocation left behind.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TG_TOKEN = "111111:test-bot-token";
const HUB = "https://hub.example.invalid";
const PIPELINE = "agentcore-hub-deploy";
const TOKEN = "approval-token-abcdef-0123456789-way-too-long-for-callback-data-field";
const CD_REGISTRY_KEY = "config/cd-registry.json";
/** The commit the parked execution would ship (PR #593 in the incident). */
const RIGHT_SHA = "486b5ac9deadbeef";
/** The newest Source revision — a DIFFERENT execution's commit (PR #596). */
const WRONG_SHA = "9f6a9e0dfeedface";

// ─── AWS SDK mocks (same seams as deploy-approval.test.mjs) ───────────────────

const db = vi.hoisted(() => ({ items: new Map(), puts: [], deletes: [], updates: [] }));
vi.mock("@aws-sdk/client-dynamodb", async () => {
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
      if (c.op === "del") { db.deletes.push(c.input.Key.id.S); db.items.delete(c.input.Key.id.S); return {}; }
      if (c.op === "scan") {
        const p = c.input.ExpressionAttributeValues[":p"].S;
        return { Items: [...db.items.values()].filter((i) => i.id.S.startsWith(p)) };
      }
      if (c.op === "update") return applyUpdate(db, c.input);
      throw new Error(`unexpected ddb op ${c.op}`);
    }
  }
  return {
    DynamoDBClient,
    GetItemCommand: cmd("get"), PutItemCommand: cmd("put"), UpdateItemCommand: cmd("update"),
    DeleteItemCommand: cmd("del"), ScanCommand: cmd("scan"),
  };
});

const cp = vi.hoisted(() => ({
  states: new Map(), executions: new Map(), execError: null, sends: [],
}));
vi.mock("@aws-sdk/client-codepipeline", () => {
  const cmd = (op) => class { constructor(input) { this.input = input; this.op = op; } };
  class CodePipelineClient {
    constructor(cfg) { this.region = cfg?.region; }
    async send(c) {
      cp.sends.push({ op: c.op, region: this.region, input: c.input });
      if (c.op === "state") return cp.states.get(c.input?.name) || { stageStates: [] };
      if (c.op === "exec") {
        if (cp.execError) { const e = new Error(cp.execError); e.name = cp.execError; throw e; }
        const revision = cp.executions.get(c.input?.pipelineExecutionId);
        return { pipelineExecution: {
          pipelineExecutionId: c.input?.pipelineExecutionId,
          ...(revision ? { artifactRevisions: [{ revisionId: revision }] } : {}),
        } };
      }
      if (c.op === "put") return {};
      throw new Error(`unexpected cp op ${c.op}`);
    }
  }
  return {
    CodePipelineClient,
    GetPipelineStateCommand: cmd("state"),
    GetPipelineExecutionCommand: cmd("exec"),
    PutApprovalResultCommand: cmd("put"),
  };
});

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { async send() { const e = new Error("NoSuchKey"); e.name = "NoSuchKey"; throw e; } },
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
vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send() { return { FailedEntryCount: 0 }; } },
  PutEventsCommand: class { constructor(i) { this.input = i; } },
}));

// ─── fetch fake ───────────────────────────────────────────────────────────────

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });

/**
 * `sendReply(body)` (when set) decides each sendMessage's Telegram response, so a
 * test can reject the FORMATTED message and accept the plain one — the whole
 * point of the rich→terse fallback. Default: everything succeeds.
 * `advanceOnPoll[i]` moves the fake clock on the i-th getUpdates (default 61s),
 * which is how the in-loop 60s scan window is crossed without fake timers.
 */
function makeNet(ctx, overrides = {}) {
  const net = {
    ctx, polls: 0, batches: [], afterPoll: [], advanceOnPoll: [],
    sent: [], attempts: [], fetched: [], github: null, sendReply: null,
    ...overrides,
  };
  net.fetch = async (url, opts) => {
    const u = String(url);
    net.fetched.push(u);
    if (u.startsWith("https://api.github.com/")) {
      if (u.includes("/pulls")) return jsonRes(net.github?.pulls ?? []);
      if (u.includes("/commits/")) return jsonRes(net.github?.commit ?? {});
      return jsonRes({});
    }
    if (u === `${HUB}/api/workflow/list`) return jsonRes({ workflows: [] });
    if (u.endsWith("/getUpdates")) {
      const i = net.polls++;
      advanceClock(net.advanceOnPoll[i] ?? 61_000);
      net.ctx.remainingMs = net.afterPoll[i] ?? 20_000;
      return jsonRes({ ok: true, result: net.batches[i] || [] });
    }
    if (u.endsWith("/sendMessage")) {
      const body = JSON.parse(opts.body);
      net.attempts.push(body);
      const reply = net.sendReply ? net.sendReply(body) : null;
      if (reply) return jsonRes(reply, reply.ok !== false, reply.ok === false ? 400 : 200);
      net.sent.push(body);
      return jsonRes({ ok: true, result: { message_id: 1000 + net.sent.length } });
    }
    if (u.endsWith("/answerCallbackQuery")) return jsonRes({ ok: true, result: true });
    if (u.endsWith("/editMessageText")) return jsonRes({ ok: true, result: {} });
    if (u.endsWith("/sendChatAction")) return jsonRes({ ok: true, result: true });
    throw new Error(`unexpected fetch: ${u}`);
  };
  return net;
}

function makeCtx(startMs) { return { remainingMs: startMs, getRemainingTimeInMillis() { return this.remainingMs; } }; }

// Real timers would make the poll loop's awaits hang; only Date.now moves.
const realNow = Date.now.bind(Date);
let clockSkewMs = 0;
vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockSkewMs);
const advanceClock = (ms) => { clockSkewMs += ms; };

const ENV = {
  TELEGRAM_BOT_TOKEN: TG_TOKEN,
  JIRA_SITE_URL: "example.atlassian.net", JIRA_EMAIL: "bot@example.com",
  JIRA_API_TOKEN: "tok", JIRA_PROJECT_KEY: "TEST",
  GITHUB_TOKEN: "gh", GITHUB_USER: "test-user",
  PENDING_TABLE: "test-pending-table", HUB_API_URL: HUB,
  AWS_REGION: "us-east-1",
};
/** Env the module reads at LOAD time, so it must be cleaned between loads. */
const TUNABLES = ["PING_LEASE_MS", "DEPLOY_REPING_INTERVAL_MS", "DEPLOY_REPING_MAX"];

async function loadHandler({ allowed = "555", pipeline = PIPELINE, env = {} } = {}) {
  vi.resetModules();
  Object.assign(process.env, ENV);
  delete process.env.ARTIFACT_BUCKET;   // no registry: the env target is the only one
  for (const k of TUNABLES) delete process.env[k];
  if (allowed == null) delete process.env.ALLOWED_CHAT_IDS; else process.env.ALLOWED_CHAT_IDS = allowed;
  if (pipeline == null) delete process.env.DEPLOY_PIPELINE_NAME; else process.env.DEPLOY_PIPELINE_NAME = pipeline;
  Object.assign(process.env, env);
  return (await import("../index.mjs")).handler;
}

const realFetch = global.fetch;
beforeEach(() => {
  db.items.clear(); db.puts.length = 0; db.deletes.length = 0; db.updates.length = 0;
  cp.states.clear(); cp.executions.clear(); cp.execError = null; cp.sends.length = 0;
  clockSkewMs = 0;
  db.items.set("chat#555", { id: { S: "chat#555" }, chatId: { N: "555" } });
});
afterAll(() => {
  vi.restoreAllMocks();
  global.fetch = realFetch;
  for (const k of [...Object.keys(ENV), ...TUNABLES, "ALLOWED_CHAT_IDS", "DEPLOY_PIPELINE_NAME", "ARTIFACT_BUCKET"]) {
    delete process.env[k];
  }
});

// ─── fixtures ─────────────────────────────────────────────────────────────────

const EXEC = "1a2b3c4d-0000-4000-8000-000000000001";
const OTHER_EXEC = "99887766-0000-4000-8000-000000000002";

/** Mirrors deploy-approval.test.mjs — stages carry their own execution id. */
const pendingState = (token = TOKEN, { revision, exec = EXEC, sourceExec } = {}) => ({
  stageStates: [
    { stageName: "Build",
      latestExecution: { pipelineExecutionId: sourceExec || exec, status: "Succeeded" },
      actionStates: [{
        actionName: "Build",
        latestExecution: { status: "Succeeded" },
        ...(revision ? { currentRevision: { revisionId: revision } } : {}),
      }] },
    { stageName: "Approval",
      latestExecution: { pipelineExecutionId: exec, status: "InProgress" },
      actionStates: [{
        actionName: "Approve_deploy",
        entityUrl: "https://github.com/o/r/commits/main",
        latestExecution: { status: "InProgress", token },
      }] },
    { stageName: "Deploy",
      latestExecution: { pipelineExecutionId: exec },
      actionStates: [{ actionName: "Deploy_three_targets", latestExecution: {} }] },
  ],
});

/** hashToken() from index.mjs (djb2) — pins the KEY SHAPE, which is unchanged. */
const djb2 = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
/** The env pipeline keeps the legacy token-only shape (TEAM-4347). */
const KEY = `dp${djb2(TOKEN)}`;
const ROW_ID = `dep#${KEY}`;
const DAY = 86_400;
const N = (v) => ({ N: String(v) });

/**
 * The row a previous invocation left behind. `claimedAt`/`deliveredAt` etc. are
 * opt-in so a test can build a PRE-UPGRADE row (the current code's shape) by
 * simply not passing them.
 */
function seedClaim({ claimedAt, deliveredAt, lastPingAt, pingCount, ttlSec, executionId = EXEC } = {}) {
  db.items.set(ROW_ID, {
    id: { S: ROW_ID },
    pipelineName: { S: PIPELINE },
    region: { S: "us-east-1" },
    stageName: { S: "Approval" },
    actionName: { S: "Approve_deploy" },
    token: { S: TOKEN },
    ttl: N(ttlSec ?? Math.floor(Date.now() / 1000) + 7 * DAY),
    ...(executionId ? { executionId: { S: executionId } } : {}),
    ...(claimedAt != null ? { claimedAt: N(claimedAt) } : {}),
    ...(deliveredAt != null ? { deliveredAt: N(deliveredAt) } : {}),
    ...(lastPingAt != null ? { lastPingAt: N(lastPingAt) } : {}),
    ...(pingCount != null ? { pingCount: N(pingCount) } : {}),
  });
}

const row = () => db.items.get(ROW_ID);
const updatesOf = (id = ROW_ID) => db.updates.filter((u) => u.id === id);
const btnData = (msg) => msg.reply_markup.inline_keyboard.flat().map((b) => b.callback_data).filter(Boolean);
const stateCalls = () => cp.sends.filter((s) => s.op === "state");
const execCalls = () => cp.sends.filter((s) => s.op === "exec");
const ghUrls = (net) => net.fetched.filter((u) => u.startsWith("https://api.github.com/"));

/** One invocation with a pending approval on the env pipeline. */
async function runScan(handler, { ctxMs = 100_000, ...overrides } = {}) {
  const ctx = makeCtx(ctxMs);
  const net = makeNet(ctx, overrides);
  global.fetch = net.fetch;
  await handler({}, ctx);
  return net;
}

// ─── T1: recovery vs. the lease ───────────────────────────────────────────────

describe("T1 an undelivered claim is recovered, once, after the lease", () => {
  it("re-sends a claim stranded before delivery and marks it delivered", async () => {
    const handler = await loadHandler();
    cp.states.set(PIPELINE, pendingState());
    // What a mid-scan timeout leaves behind: claimed, never delivered.
    seedClaim({ claimedAt: Date.now() - 10 * 60_000 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const net = await runScan(handler);

      expect(net.sent.length, "the stranded approval must be re-pinged").toBe(1);
      expect(btnData(net.sent[0]), "same key ⇒ the stashed token still approves").toEqual(
        [`dok|${KEY}`, `dno|${KEY}`],
      );
      // Phase 2 now on the row: this is what stops the NEXT scan re-sending.
      expect(row().deliveredAt?.N, "a confirmed send records deliveredAt").toBeTruthy();
      expect(row().pingCount.N).toBe("1");
      expect(JSON.parse(row().messageIds.S)).toEqual(["555:1001"]);
      // The lease was taken first, then delivery marked — two updates, no delete.
      expect(updatesOf().length).toBe(2);
      expect(db.deletes, "a re-sent claim must never be released").not.toContain(ROW_ID);
      expect(warn.mock.calls.some((a) => /deploy approval ping never confirmed/.test(String(a[0])))).toBe(true);
    } finally { warn.mockRestore(); }
  });

  it("a second scan after the recovery does not ping again", async () => {
    const handler = await loadHandler();
    cp.states.set(PIPELINE, pendingState());
    seedClaim({ claimedAt: Date.now() - 10 * 60_000 });

    const first = await runScan(handler);
    expect(first.sent.length).toBe(1);
    // Same container, same wait: the row now proves a human has the page.
    const second = await runScan(handler);
    expect(second.sent.length, "recovery is one-shot, not a loop").toBe(0);
  });

  it("stays silent inside the lease — a send may still be in flight", async () => {
    const handler = await loadHandler();
    cp.states.set(PIPELINE, pendingState());
    seedClaim({ claimedAt: Date.now() - 60_000 }); // 1 min < PING_LEASE_MS (5 min)

    const net = await runScan(handler);

    expect(net.sent.length, "a fresh claim belongs to an in-flight send").toBe(0);
    expect(updatesOf(), "and nothing may touch the row").toEqual([]);
    expect(row().deliveredAt).toBeUndefined();
  });

  it("PING_LEASE_MS is the knob that decides it", async () => {
    const handler = await loadHandler({ env: { PING_LEASE_MS: "30000" } });
    cp.states.set(PIPELINE, pendingState());
    seedClaim({ claimedAt: Date.now() - 60_000 }); // now PAST a 30s lease

    const net = await runScan(handler);
    expect(net.sent.length).toBe(1);
  });

  it("a PRE-UPGRADE row derives its claim time from the TTL and recovers once", async () => {
    const handler = await loadHandler();
    cp.states.set(PIPELINE, pendingState());
    // Exactly what the current code writes: no claimedAt at all. ttl = claim + 7d,
    // so a ttl 7 days out minus 10 minutes means "claimed 10 minutes ago".
    seedClaim({ ttlSec: Math.floor((Date.now() - 10 * 60_000) / 1000) + 7 * DAY });
    expect(row().claimedAt, "the fixture must be a pre-upgrade row").toBeUndefined();

    const net = await runScan(handler);

    expect(net.sent.length, "the row stranded by the incident gets its one ping").toBe(1);
    expect(row().deliveredAt?.N).toBeTruthy();
  });

  it("a pre-upgrade row claimed seconds ago is still inside its lease", async () => {
    const handler = await loadHandler();
    cp.states.set(PIPELINE, pendingState());
    seedClaim({ ttlSec: Math.floor(Date.now() / 1000) + 7 * DAY }); // claimed ~now
    expect(row().claimedAt).toBeUndefined();

    const net = await runScan(handler);
    expect(net.sent.length, "the TTL fallback must respect the lease too").toBe(0);
  });
});

// ─── T2: bounded reminders on a delivered claim ───────────────────────────────

describe("T2 a delivered approval nobody actioned earns bounded reminders", () => {
  it("re-pings after the interval, on the same key, and counts the reminder", async () => {
    const handler = await loadHandler();
    cp.states.set(PIPELINE, pendingState());
    const now = Date.now();
    seedClaim({
      claimedAt: now - 9 * 3_600_000,      // parked 9h — the incident's shape
      deliveredAt: now - 9 * 3_600_000,
      lastPingAt: now - 3 * 3_600_000,     // 3h > DEPLOY_REPING_INTERVAL_MS (2h)
      pingCount: 1,
    });

    const net = await runScan(handler);

    expect(net.sent.length).toBe(1);
    const text = net.sent[0].text;
    expect(text).toMatch(/still waiting on your approval/);
    expect(text).toMatch(/reminder 1 of 6/);
    expect(text, "how long a human has kept prod waiting").toMatch(/Pending 9h 0m/);
    expect(btnData(net.sent[0]), "the ORIGINAL token is behind the same key").toEqual(
      [`dok|${KEY}`, `dno|${KEY}`],
    );
    expect(row().pingCount.N, "reminder 1 sent ⇒ 2 pings so far").toBe("2");
    expect(row().deliveredAt.N, "deliveredAt still means the FIRST delivery").toBe(String(now - 9 * 3_600_000));
  });

  it("says nothing inside the interval", async () => {
    const handler = await loadHandler();
    cp.states.set(PIPELINE, pendingState());
    const now = Date.now();
    seedClaim({ claimedAt: now - 3_600_000, deliveredAt: now - 3_600_000, lastPingAt: now - 30 * 60_000, pingCount: 1 });

    const net = await runScan(handler);
    expect(net.sent.length, "a reminder every 60s scan would be the nag we refuse to send").toBe(0);
  });

  it("stops at DEPLOY_REPING_MAX", async () => {
    const handler = await loadHandler();
    cp.states.set(PIPELINE, pendingState());
    const now = Date.now();
    // pingCount 7 = the original + 6 reminders = the whole budget.
    seedClaim({ claimedAt: now - 20 * 3_600_000, deliveredAt: now - 20 * 3_600_000, lastPingAt: now - 3 * 3_600_000, pingCount: 7 });

    const net = await runScan(handler);
    expect(net.sent.length, "reminders are bounded, not forever").toBe(0);
    expect(row().pingCount.N, "and the counter is not moved by a refused reminder").toBe("7");
  });

  it("both knobs are read from the env", async () => {
    const handler = await loadHandler({ env: { DEPLOY_REPING_INTERVAL_MS: "1000", DEPLOY_REPING_MAX: "1" } });
    cp.states.set(PIPELINE, pendingState());
    const now = Date.now();
    seedClaim({ claimedAt: now - 60_000, deliveredAt: now - 60_000, lastPingAt: now - 5_000, pingCount: 1 });

    const net = await runScan(handler);
    expect(net.sent.length, "a 1s interval fires at once").toBe(1);
    expect(net.sent[0].text).toMatch(/reminder 1 of 1/);

    // Budget of 1 is now spent (pingCount 2).
    const again = await runScan(handler);
    expect(again.sent.length).toBe(0);
  });

  it("an undelivered row is never treated as a reminder candidate", async () => {
    const handler = await loadHandler();
    cp.states.set(PIPELINE, pendingState());
    const now = Date.now();
    // Old enough for a reminder interval, but nothing was ever delivered: this is
    // the RECOVERY case, and it must send the full ping, not "reminder 1 of 6".
    seedClaim({ claimedAt: now - 5 * 3_600_000, lastPingAt: now - 5 * 3_600_000, pingCount: 1 });

    const net = await runScan(handler);
    expect(net.sent.length).toBe(1);
    expect(net.sent[0].text).not.toMatch(/reminder \d of/);
    expect(net.sent[0].text).toMatch(/approval needed/);
  });
});

// ─── T3: rich → terse, so formatting can never block a prod gate ─────────────

/** Telegram's legacy-Markdown rejection: the WHOLE message, on one bad entity. */
const MARKDOWN_400 = {
  ok: false,
  description: "Bad Request: can't parse entities in message text: Can't find end of the entity starting at byte offset 42",
};

describe("T3 a rejected rich message falls back to plain text", () => {
  it("delivers the terse ping and keeps the claim", async () => {
    const handler = await loadHandler();
    cp.states.set(PIPELINE, pendingState());
    const net = await runScan(handler, {
      // Reject anything formatted; accept plain text.
      sendReply: (body) => (body.parse_mode ? MARKDOWN_400 : null),
    });

    expect(net.attempts.length, "one rich attempt, one plain retry").toBe(2);
    expect(net.attempts[0].parse_mode).toBe("Markdown");
    expect(net.sent.length, "the human is paged").toBe(1);
    expect(net.sent[0].parse_mode, "the fallback carries no parse_mode at all").toBeUndefined();
    // Same facts, same decision: pipeline, execution, and working buttons.
    expect(net.sent[0].text).toContain(PIPELINE);
    expect(net.sent[0].text).toContain(EXEC.slice(0, 8));
    expect(net.sent[0].text, "no Markdown left to reject").not.toMatch(/[*_`[\]]/);
    expect(btnData(net.sent[0])).toEqual([`dok|${KEY}`, `dno|${KEY}`]);
    // The old bug: release → re-claim → identical 400, every 60s, forever.
    expect(db.deletes, "a delivered ping must not release its claim").not.toContain(ROW_ID);
    expect(row().deliveredAt?.N).toBeTruthy();
  });

  it("a re-scan after the fallback does not re-ping", async () => {
    const handler = await loadHandler();
    cp.states.set(PIPELINE, pendingState());
    await runScan(handler, { sendReply: (body) => (body.parse_mode ? MARKDOWN_400 : null) });
    const second = await runScan(handler, { sendReply: (body) => (body.parse_mode ? MARKDOWN_400 : null) });
    expect(second.sent.length).toBe(0);
    expect(second.attempts.length, "not even an attempt — the row says delivered").toBe(0);
  });

  it("a blocked chat is NOT retried as plain text, and the claim is released", async () => {
    const handler = await loadHandler();
    cp.states.set(PIPELINE, pendingState());
    const net = await runScan(handler, {
      sendReply: () => ({ ok: false, description: "Forbidden: bot was blocked by the user" }),
    });

    expect(net.attempts.length, "a plain retry cannot fix a blocked chat").toBe(1);
    expect(net.sent.length).toBe(0);
    // Nobody was paged and we created the row — drop it so the next scan retries.
    expect(db.deletes).toContain(ROW_ID);
  });
});

// ─── T4: the commit is the WAITING execution's, not the newest ────────────────

describe("T4 attribution follows the execution parked at the approval", () => {
  const GITHUB = (sha) => ({
    commit: { commit: { message: `fix(pipeline): the change ${sha.slice(0, 7)} ships` }, stats: { additions: 5, deletions: 2 }, files: [{}, {}] },
    pulls: [{ number: 593, title: "fix(pipeline): the right change", html_url: "https://github.com/o/r/pull/593", body: "## Summary\nShips the reviewed change." }],
  });

  it("(a) two executions in flight and no GetPipelineExecution ⇒ terse, never the wrong commit", async () => {
    const handler = await loadHandler();
    // Build carries a NEWER execution's revision — the incident exactly.
    cp.states.set(PIPELINE, pendingState(TOKEN, { revision: WRONG_SHA, sourceExec: OTHER_EXEC }));
    cp.execError = "AccessDeniedException"; // update-config.sh not run yet
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const net = await runScan(handler);

      expect(net.sent.length, "the gate still reaches a human").toBe(1);
      expect(ghUrls(net), "an unattributable commit must not be enriched").toEqual([]);
      expect(net.fetched.some((u) => u.includes(WRONG_SHA)), "the other execution's commit must never be described").toBe(false);
      // A human can still correlate the ping with the console.
      expect(net.sent[0].text).toContain(EXEC.slice(0, 8));
      expect(net.sent[0].text).not.toMatch(/Commit:/);
      expect(execCalls().length, "it did try the execution-scoped lookup").toBe(1);
      expect(warn.mock.calls.some((a) => /could not resolve the commit/.test(String(a[0])))).toBe(true);
    } finally { warn.mockRestore(); }
  });

  it("(b) GetPipelineExecution names the commit THIS execution ships", async () => {
    const handler = await loadHandler();
    cp.states.set(PIPELINE, pendingState(TOKEN, { revision: WRONG_SHA, sourceExec: OTHER_EXEC }));
    cp.executions.set(EXEC, RIGHT_SHA);

    const net = await runScan(handler, { github: GITHUB(RIGHT_SHA) });

    expect(net.sent.length).toBe(1);
    expect(ghUrls(net).some((u) => u.includes(`/commits/${RIGHT_SHA}`)), "enriched from the parked execution's commit").toBe(true);
    expect(net.fetched.some((u) => u.includes(WRONG_SHA))).toBe(false);
    expect(net.sent[0].text).toMatch(/Ships the reviewed change/);
    expect(net.sent[0].text).toContain(RIGHT_SHA.slice(0, 7));
  });

  it("(c) one execution in flight ⇒ the Source revision is trusted, no extra API call", async () => {
    const handler = await loadHandler();
    // Every stage on the SAME execution — today's happy path.
    cp.states.set(PIPELINE, pendingState(TOKEN, { revision: RIGHT_SHA }));

    const net = await runScan(handler, { github: GITHUB(RIGHT_SHA) });

    expect(net.sent.length).toBe(1);
    expect(execCalls(), "a matching stage revision needs no GetPipelineExecution").toEqual([]);
    expect(ghUrls(net).some((u) => u.includes(`/commits/${RIGHT_SHA}`))).toBe(true);
    expect(net.sent[0].text).toMatch(/Ships the reviewed change/);
  });

  it("the execution id is on the FIRST ping too, and on the claim row", async () => {
    const handler = await loadHandler();
    cp.states.set(PIPELINE, pendingState());

    const net = await runScan(handler);

    expect(net.sent[0].text).toContain(EXEC.slice(0, 8));
    expect(db.items.get(ROW_ID).executionId.S, "so a later reminder can quote it").toBe(EXEC);
  });
});

// ─── T5: the in-loop scans need real runway ───────────────────────────────────

/**
 * The three periodic scans are serial and do network I/O; starting a round with
 * 30s left is how an invocation dies between the claim and the send. The guard
 * requires POLL_RESERVE_MS + SCAN_BUDGET_MS (120s), and deliberately does NOT
 * stamp lastGateScan when it blocks — otherwise a blocked round would also burn
 * the next 60s window.
 */
describe("T5 in-loop scan budget guard", () => {
  it("does not start a scan round with 80s left", async () => {
    const handler = await loadHandler();
    cp.states.set(PIPELINE, pendingState());
    // Each poll advances the clock past the 60s window; the budget is what differs.
    const net = await runScan(handler, { ctxMs: 300_000, afterPoll: [80_000, 20_000] });

    expect(net.polls).toBe(2);
    expect(stateCalls().length, "only the start-of-invocation scan ran").toBe(1);
  });

  it("starts one with 200s left", async () => {
    const handler = await loadHandler();
    cp.states.set(PIPELINE, pendingState());
    const net = await runScan(handler, { ctxMs: 300_000, afterPoll: [200_000, 20_000] });

    expect(stateCalls().length, "start scan + one in-loop scan").toBe(2);
    expect(net.sent.length, "and the claim still dedupes the second scan").toBe(1);
  });

  it("a blocked round does not burn the 60s window", async () => {
    const handler = await loadHandler();
    cp.states.set(PIPELINE, pendingState());
    // Poll 1 crosses the window (61s) but the budget is 80s → blocked. Poll 2
    // adds only 10s: if the blocked round had stamped lastGateScan, 10s < 60s
    // would skip this round too and the scan would be lost for another minute.
    const net = await runScan(handler, {
      ctxMs: 300_000,
      advanceOnPoll: [61_000, 10_000],
      afterPoll: [80_000, 200_000, 20_000],
    });

    expect(net.polls).toBe(3);
    expect(stateCalls().length, "the deferred scan runs as soon as there is budget").toBe(2);
  });
});
