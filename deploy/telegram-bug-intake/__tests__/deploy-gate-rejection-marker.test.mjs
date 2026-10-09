/**
 * TEAM-4781 (SR1-2 of PR #640) — the SEC-1 rejection marker is LOAD-BEARING.
 *
 * DL-031 called `pipeline-artifacts/ship-approvals/<merge_commit>.rejected.json`
 * a durable fact. It was not one: `writeShipRejection` swallowed every PutObject
 * error, `decideDeployGate` returned "decided" regardless, and the legacy
 * tokenless path deleted its claim row and edited Telegram either way. With a
 * valid ship-approval record already on the same merge commit, that is a bypass:
 *
 *   E1's `decide` hits a transient S3 error -> prints 0 -> the human gate runs ->
 *   the human taps ❌ -> the marker write fails silently -> the run is restarted ->
 *   E2's `decide` reads the untouched record fine -> prints 1 -> the Approval
 *   stage is SKIPPED and the rejected commit deploys.
 *
 * So a ❌ whose marker will not land is no longer a completed decision. The
 * property under test is the PAIR: the rejection stands on the pipeline (it is
 * irreversible, and saying otherwise is the lie TEAM-4751 C1 removed elsewhere)
 * while the TICKET side is left completely alone, because the ticket — and, on the
 * legacy page, the claim row — is the only thing that can retry the marker.
 *
 * Sibling of deploy-gate-ordering.test.mjs, which pins the ORDER of the writes;
 * this file pins what happens when the last of them fails.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TG_TOKEN = "111111:test-bot-token";
const HUB = "https://hub.example.invalid";
const CHAT = 555;
const WF = "wf-4781";
const GATE = "TEAM-9781";
const PIPELINE = "hub-widget-deploy";
const REPO = "acme/widget";
const REGION = "us-west-2";
const BUCKET = "test-artifact-bucket";
const CD_REGISTRY_KEY = "config/cd-registry.json";
const EXEC = "11111111-2222-3333-4444-555555555555";
const TOKEN = "approval-token-4781-0123456789-far-too-long-for-a-callback-data-field";
const REVISION = "cafe1234beef5678";
const MARKER_KEY = `pipeline-artifacts/ship-approvals/${REVISION}.rejected.json`;

// ─── seams ───────────────────────────────────────────────────────────────────

const log = vi.hoisted(() => ({ entries: [] }));
const db = vi.hoisted(() => ({ items: new Map(), puts: [], deletes: [] }));
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
        if (/^(approved|resolved)#/.test(id)) log.entries.push({ kind: "ledger", id });
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

const cp = vi.hoisted(() => ({ states: new Map(), putErrors: new Map(), approvals: [] }));
const pick = (map, name) => (map.has(name) ? map.get(name) : map.get("*"));
vi.mock("@aws-sdk/client-codepipeline", () => {
  const cmd = (op) => class { constructor(input) { this.input = input; this.op = op; } };
  class CodePipelineClient {
    constructor(cfg) { this.creds = typeof cfg?.credentials === "function" ? cfg.credentials : null; }
    async send(c) {
      if (this.creds) await this.creds();
      if (c.op === "state") return pick(cp.states, c.input?.name) || { stageStates: [] };
      if (c.op === "put") {
        const err = pick(cp.putErrors, c.input?.pipelineName);
        if (err) { const e = new Error(err.message); e.name = err.name; throw e; }
        cp.approvals.push(c.input);
        log.entries.push({ kind: "approval", status: c.input?.result?.status });
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

// `failPuts` is a COUNTDOWN, not a flag: the write retries once internally, so
// "fails once then succeeds" and "fails every time" are different tests, and
// `attempts` is what tells them apart.
const s3 = vi.hoisted(() => ({ registry: null, puts: [], attempts: 0, failPuts: 0 }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(c) {
      if (c.op === "put") {
        s3.attempts++;
        if (s3.failPuts > 0) {
          s3.failPuts--;
          const e = new Error("Access Denied");
          e.name = "AccessDenied";
          throw e;
        }
        s3.puts.push(c.input);
        log.entries.push({ kind: "rejection-marker", key: c.input?.Key });
        return {};
      }
      if (c.input?.Key === CD_REGISTRY_KEY && s3.registry) {
        return { Body: { transformToString: async () => JSON.stringify(s3.registry) } };
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
    sent: [], answered: [], edited: [], transitions: [], comments: [],
    commentStatus: 200, ...overrides,
  };
  net.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : null;
    if (u.startsWith("https://api.github.com/")) return jsonRes({});
    if (u === `${HUB}/api/workflow/list`) return jsonRes({ workflows: net.workflows });
    if (u.endsWith("/tickets/comment")) {
      net.comments.push(body);
      log.entries.push({ kind: "comment", ticketId: body?.ticketId });
      return net.commentStatus === 200
        ? jsonRes({ success: true })
        : jsonRes({ error: "boom" }, false, net.commentStatus);
    }
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

async function loadModule({ bucket = BUCKET } = {}) {
  vi.resetModules();
  Object.assign(process.env, ENV);
  if (bucket) process.env.ARTIFACT_BUCKET = bucket;
  else delete process.env.ARTIFACT_BUCKET;
  delete process.env.DEPLOY_PIPELINE_NAME;
  s3.registry = { version: 1, repos: [{ repo: REPO, pipeline: PIPELINE, region: REGION }] };
  const mod = await import("../index.mjs");
  mod._setDeployGateRetryMsForTests(0);
  return mod;
}

const realFetch = global.fetch;
beforeEach(() => {
  db.items.clear(); db.puts.length = 0; db.deletes.length = 0;
  cp.states.clear(); cp.putErrors.clear(); cp.approvals.length = 0;
  s3.puts.length = 0; s3.registry = null; s3.attempts = 0; s3.failPuts = 0;
  log.entries.length = 0;
  db.items.set(`chat#${CHAT}`, { id: { S: `chat#${CHAT}` }, chatId: { N: String(CHAT) } });
});
afterAll(() => {
  global.fetch = realFetch;
  for (const k of [...Object.keys(ENV), "ARTIFACT_BUCKET", "DEPLOY_PIPELINE_NAME"]) delete process.env[k];
});

// ─── fixtures ────────────────────────────────────────────────────────────────

const gateRow = (extra = {}) => ({
  ticketId: GATE,
  title: "Deploy gate: approve prod deploy for the widget",
  status: "in review",
  labels: ["gate:deploy-approval", `pipeline:${PIPELINE}`, `exec:${EXEC}`, `wf:${WF}`],
  ...extra,
});
/** The Approval action parked on EXEC, with a Source revision to attribute. */
const pendingState = () => ({
  stageStates: [
    { stageName: "Source",
      latestExecution: { status: "Succeeded", pipelineExecutionId: EXEC },
      actionStates: [{ actionName: "Source", currentRevision: { revisionId: REVISION } }] },
    { stageName: "Approval",
      latestExecution: { status: "InProgress", pipelineExecutionId: EXEC },
      actionStates: [{ actionName: "Approve_deploy",
        latestExecution: { status: "InProgress", token: TOKEN, pipelineExecutionId: EXEC } }] },
  ],
});
/** The same pipeline with nothing parked: the shape a re-tap sees. */
const settledState = () => ({
  stageStates: [
    { stageName: "Source",
      latestExecution: { status: "Succeeded", pipelineExecutionId: EXEC },
      actionStates: [{ actionName: "Source", currentRevision: { revisionId: REVISION } }] },
  ],
});
const tap = (updateId, action) => ({
  update_id: updateId,
  callback_query: {
    id: `cb-${updateId}`, data: `${action}|${GATE}|${WF}`,
    message: {
      message_id: 11, chat: { id: CHAT }, text: "*🚀 PRODUCTION DEPLOY — approval needed*",
      reply_markup: { inline_keyboard: [[{ text: "✅", callback_data: `gok|${GATE}|${WF}` },
                                         { text: "❌", callback_data: `gno|${GATE}|${WF}` }]] },
    },
  },
});
const kinds = () => log.entries.map((e) => e.kind);

async function runTap(mod, action, { tickets = [gateRow()], updateId = 1, net: over = {} } = {}) {
  const net = makeNet(makeCtx(), { tickets, batches: [[tap(updateId, action)]], ...over });
  global.fetch = net.fetch;
  await mod.handler({}, net.ctx);
  return net;
}

// The legacy tokenless page: a claim row keyed by djb2(pipeline + " " + token).
const djb2 = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const CLAIM_KEY = `dp${djb2(`${PIPELINE} ${TOKEN}`)}`;
const seedDeployClaim = () => {
  const id = `dep#${CLAIM_KEY}`;
  db.items.set(id, {
    id: { S: id }, pipelineName: { S: PIPELINE }, region: { S: REGION },
    stageName: { S: "Approval" }, actionName: { S: "Approve_deploy" },
    token: { S: TOKEN }, executionId: { S: EXEC },
  });
};
const legacyTap = (updateId, action) => ({
  update_id: updateId,
  callback_query: {
    id: `cb-${updateId}`, data: `${action}|${CLAIM_KEY}`,
    message: { message_id: 42, chat: { id: CHAT }, text: "*🚀 PRODUCTION DEPLOY — approval needed*" },
  },
});
async function runLegacyTap(mod, action, updateId) {
  const net = makeNet(makeCtx(), { batches: [[legacyTap(updateId, action)]] });
  global.fetch = net.fetch;
  await mod.handler({}, net.ctx);
  return net;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("the ❌ ticket half waits for the marker (TEAM-4781)", () => {
  it("a marker that lands lets the ticket half run, exactly as before", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, pendingState());

    const net = await runTap(mod, "gno");

    expect(kinds()).toEqual(["ledger", "approval", "rejection-marker"]);
    expect(s3.puts[0]).toMatchObject({ Bucket: BUCKET, Key: MARKER_KEY });
    expect(s3.attempts, "one attempt is enough when it works").toBe(1);
    // The rework plumbing — the ticket half of a ❌ — ran.
    expect(db.items.has(`rej#${CHAT}`)).toBe(true);
    expect(db.items.has(`gaterework#${GATE}`)).toBe(true);
    expect(net.answered.at(-1).text).toMatch(/reply with what needs to change/i);
    expect(net.comments, "nothing to report when the marker lands").toEqual([]);
  });

  it("a transient failure is retried in place and then proceeds normally", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, pendingState());
    s3.failPuts = 1;

    const net = await runTap(mod, "gno");

    expect(s3.attempts, "one retry, in the same tap").toBe(2);
    expect(s3.puts[0]).toMatchObject({ Key: MARKER_KEY });
    expect(db.items.has(`rej#${CHAT}`)).toBe(true);
    expect(net.comments).toEqual([]);
    expect(net.edited.at(-1).text).toMatch(/Changes requested/);
  });

  it("two failed writes leave the gate ticket untouched and name the key", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, pendingState());
    s3.failPuts = 99;

    const net = await runTap(mod, "gno");

    // The pipeline moved and cannot be un-moved…
    expect(cp.approvals[0].result.status).toBe("Rejected");
    expect(s3.attempts).toBe(2);
    // …and NOTHING on the ticket side ran: no transition, and none of the rework
    // plumbing, because a parked rework note would take the gate out of the state
    // where a re-tap can still retry the marker.
    expect(net.transitions).toEqual([]);
    expect(db.items.has(`rej#${CHAT}`)).toBe(false);
    expect(db.items.has(`gaterework#${GATE}`)).toBe(false);
    // The gate ticket is told which object is missing, by KEY only.
    expect(net.comments.length).toBe(1);
    expect(net.comments[0]).toMatchObject({ ticketId: GATE });
    expect(net.comments[0].content).toContain(MARKER_KEY);
    expect(net.comments[0].content, "no bucket, no ARNs, no credentials").not.toContain(BUCKET);
    // The human is told the truth in both directions, with the keyboard intact so
    // the re-tap is possible.
    const edit = net.edited.at(-1);
    expect(edit.text).toMatch(/IS rejected on the pipeline/);
    expect(edit.text).toContain(MARKER_KEY);
    expect(edit.text).toContain(GATE);
    expect(edit.reply_markup, "the ❌ button must survive — the tap is the retry").toBeTruthy();
    expect(net.answered.at(-1).text).toMatch(/marker did not save/i);
  });

  it("the re-tap ❌ retries the marker and then the ticket half runs", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, pendingState());
    s3.failPuts = 99;
    await runTap(mod, "gno", { updateId: 1 });
    expect(s3.puts).toEqual([]);

    // Second tap: the gate is no longer parked (we rejected it), and the ledger
    // row from the first tap is what proves the rejection was ours — so the only
    // work left is the marker.
    cp.states.set(PIPELINE, settledState());
    s3.failPuts = 0;
    s3.attempts = 0;
    log.entries.length = 0;
    const net = await runTap(mod, "gno", { updateId: 2 });

    expect(cp.approvals.length, "the pipeline is not rejected twice").toBe(1);
    expect(s3.puts[0]).toMatchObject({ Key: MARKER_KEY });
    expect(db.items.has(`rej#${CHAT}`), "now the rework note may be parked").toBe(true);
    expect(net.answered.some((a) => /reply with what needs to change/i.test(a.text))).toBe(true);
  });

  it("a comment that fails does not mask the missing marker", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, pendingState());
    s3.failPuts = 99;

    const net = await runTap(mod, "gno", { net: { commentStatus: 500 } });

    expect(net.transitions).toEqual([]);
    expect(db.items.has(`rej#${CHAT}`)).toBe(false);
    expect(net.edited.at(-1).text).toContain(MARKER_KEY);
  });

  // SR2 of this same review: "we already answered this gate" and "we already
  // answered it the SAME way" are different facts, and only the second licenses
  // re-running the ❌ half. The window is narrow but real - a ✅ that lands on the
  // pipeline and then fails its ticket transition leaves the gate in_review with
  // an "Approved" ledger row, so the caller's isTicketDone guard does not catch a
  // later ❌ tap.
  it("a ❌ after our own recorded ✅ writes no marker and runs no rework", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, settledState());   // nothing parked: the ✅ closed it
    db.items.set(`approved#${GATE}`, {
      id: { S: `approved#${GATE}` }, decision: { S: "Approved" },
      decidedAt: { N: String(Date.now()) },
    });
    s3.failPuts = 99;   // would fail IF anything wrote — nothing should

    const net = await runTap(mod, "gno");

    expect(s3.attempts, "no marker for a commit we approved").toBe(0);
    expect(cp.approvals, "and nothing new on the pipeline").toEqual([]);
    expect(net.comments).toEqual([]);
    expect(net.transitions).toEqual([]);
    expect(db.items.has(`rej#${CHAT}`), "no parked rework note").toBe(false);
    expect(db.items.has(`gaterework#${GATE}`)).toBe(false);
    expect(net.answered.at(-1).text).toMatch(/already approved/i);
    // No edit: that branch's text carries "Changes requested", which is
    // gateFromReply's routing vocabulary and would mis-route the next message.
    expect(net.edited.some((e) => /Changes requested/.test(e.text || ""))).toBe(false);
  });

  it("a ❌ after our own recorded ❌ still retries the marker", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, settledState());
    db.items.set(`approved#${GATE}`, {
      id: { S: `approved#${GATE}` }, decision: { S: "Rejected" },
      decidedAt: { N: String(Date.now()) },
    });

    const net = await runTap(mod, "gno");

    expect(s3.puts[0], "same decision: the marker is the half still missing").toMatchObject({ Key: MARKER_KEY });
    expect(db.items.has(`rej#${CHAT}`)).toBe(true);
    expect(net.answered.some((a) => /reply with what needs to change/i.test(a.text))).toBe(true);
  });

  it("a ledger row with no decision attribute stays conservative", async () => {
    // A row written by an older build. Unknown is not "Approved": it must keep
    // exactly today's behaviour rather than gain a meaning it was never written
    // with, and the marker only ever ADDS a human gate.
    const mod = await loadModule();
    cp.states.set(PIPELINE, settledState());
    db.items.set(`approved#${GATE}`, {
      id: { S: `approved#${GATE}` }, decidedAt: { N: String(Date.now()) },
    });

    const net = await runTap(mod, "gno");

    // No decision attribute reads as "no row at all", so there is nothing to
    // prove the gate is ours and decideDeployGate reports a plain failure.
    expect(s3.attempts).toBe(0);
    expect(net.transitions).toEqual([]);
    expect(db.items.has(`rej#${CHAT}`)).toBe(false);
  });

  it("✅ is unaffected: no marker, no comment, the ticket closes", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, pendingState());
    s3.failPuts = 99;   // would fail IF anything wrote — nothing should

    const net = await runTap(mod, "gok");

    expect(s3.attempts).toBe(0);
    expect(net.comments).toEqual([]);
    expect(net.transitions).toEqual([expect.objectContaining({ ticketId: GATE, targetStatus: "done" })]);
  });
});

describe("the legacy tokenless page keeps its claim row for the retry", () => {
  it("❌ with a marker that lands spends the claim as before", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, pendingState());
    seedDeployClaim();

    const net = await runLegacyTap(mod, "dno", 20);

    expect(cp.approvals[0].result.status).toBe("Rejected");
    expect(s3.puts[0]).toMatchObject({ Key: MARKER_KEY });
    expect(db.deletes).toContain(`dep#${CLAIM_KEY}`);
    expect(net.edited.at(-1).text).toMatch(/Rejected — deploy stopped/);
  });

  it("❌ whose marker fails twice keeps the claim row and names the key", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, pendingState());
    seedDeployClaim();
    s3.failPuts = 99;

    const net = await runLegacyTap(mod, "dno", 21);

    expect(cp.approvals[0].result.status).toBe("Rejected");
    expect(s3.attempts).toBe(2);
    // The claim row IS the retry affordance on this page — dropping it is what
    // makes the ❌ button dead.
    expect(db.deletes).not.toContain(`dep#${CLAIM_KEY}`);
    expect(db.items.has(`dep#${CLAIM_KEY}`)).toBe(true);
    expect(net.edited.at(-1).text).toContain(MARKER_KEY);
    // No gate ticket exists on this path, so there is nothing to comment on.
    expect(net.comments).toEqual([]);
  });

  it("…and the re-tap retries the marker, then spends the claim", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, pendingState());
    seedDeployClaim();
    s3.failPuts = 99;
    await runLegacyTap(mod, "dno", 22);
    expect(db.items.has(`dep#${CLAIM_KEY}`)).toBe(true);

    // The token is spent now, so CodePipeline refuses the second write — which is
    // exactly the signal that the rejection already stands and only the marker is
    // outstanding.
    cp.putErrors.set(PIPELINE, {
      name: "ApprovalAlreadyCompletedException",
      message: "The approval action has already been completed",
    });
    s3.failPuts = 0;
    s3.attempts = 0;
    const net = await runLegacyTap(mod, "dno", 23);

    expect(cp.approvals.length, "the pipeline is not rejected twice").toBe(1);
    expect(s3.puts[0]).toMatchObject({ Key: MARKER_KEY });
    expect(db.deletes).toContain(`dep#${CLAIM_KEY}`);
    expect(net.edited.at(-1).text).toMatch(/Rejected — deploy stopped/);
  });

  it("❌ after our own recorded ✅ writes no marker and claims no stop", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, pendingState());
    seedDeployClaim();
    db.items.set(`resolved#${PIPELINE}#${EXEC}`, {
      id: { S: `resolved#${PIPELINE}#${EXEC}` }, decision: { S: "Approved" },
      decidedAt: { N: String(Date.now()) },
    });
    // The token this page holds is spent, which is exactly how a ❌ landing after
    // an ✅ presents.
    cp.putErrors.set(PIPELINE, {
      name: "ApprovalAlreadyCompletedException",
      message: "The approval action has already been completed",
    });
    s3.failPuts = 99;

    const net = await runLegacyTap(mod, "dno", 25);

    expect(s3.attempts, "no marker for a commit we approved").toBe(0);
    expect(net.edited.at(-1).text).toMatch(/Already approved on the pipeline/);
    expect(net.edited.at(-1).text, "the old copy was a flat lie here").not.toMatch(/deploy stopped/);
    // Token spent either way, so there is nothing left to retry on this page.
    expect(db.deletes).toContain(`dep#${CLAIM_KEY}`);
  });

  it("❌ that cannot be attributed records the marker but claims no stop", async () => {
    // No prior ledger row and the token already consumed: somebody else answered
    // this gate and we cannot tell which way. The marker is still written (it only
    // ever adds a human gate), but "deploy stopped" would be unprovable.
    const mod = await loadModule();
    cp.states.set(PIPELINE, pendingState());
    seedDeployClaim();
    cp.putErrors.set(PIPELINE, {
      name: "ApprovalAlreadyCompletedException",
      message: "The approval action has already been completed",
    });

    const net = await runLegacyTap(mod, "dno", 26);

    expect(s3.puts[0]).toMatchObject({ Key: MARKER_KEY });
    expect(net.edited.at(-1).text).toMatch(/Already actioned on the pipeline/);
    expect(net.edited.at(-1).text).not.toMatch(/deploy stopped/);
    expect(db.deletes).toContain(`dep#${CLAIM_KEY}`);
  });

  it("no ARTIFACT_BUCKET: nothing to record, nothing to retry, so it proceeds", async () => {
    // An install with no bucket has no ship-approval RECORD either, so nothing
    // can skip its gate: preapproved-check.sh prints 0 without a bucket and
    // refuses on the empty path. Blocking the ❌ here would strand the page.
    const mod = await loadModule({ bucket: null });
    cp.states.set(PIPELINE, pendingState());
    seedDeployClaim();

    const net = await runLegacyTap(mod, "dno", 24);

    expect(cp.approvals[0].result.status).toBe("Rejected");
    expect(s3.attempts).toBe(0);
    expect(db.deletes).toContain(`dep#${CLAIM_KEY}`);
    expect(net.edited.at(-1).text).toMatch(/Rejected — deploy stopped/);
  });
});
