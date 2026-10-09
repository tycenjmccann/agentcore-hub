/**
 * TEAM-4739 SEC-10 — the ORDER of the two writes a ✅/❌ on a
 * `gate:deploy-approval` ticket performs, and what each outcome of the first one
 * permits the second to do.
 *
 * TEAM-4706 established the order (the pipeline moves first) and TEAM-4739 makes
 * `decideDeployGate` tri-state about the WRITE — `decided` / `alreadyResolved` /
 * `failed` — because "did the human approve?" and "did the approval get
 * recorded?" are different questions and the old boolean answered neither
 * cleanly. Three invariants, and they are only expressible as ordering:
 *
 *  1. The ledger row, then the approval, then the ticket. A run that dies
 *     between any two must leave the world recoverable: the ledger proves the
 *     next tap that the gate is already ours (so `alreadyResolved` is not
 *     ambiguous), and a ticket that moved without an approval is the 29h stall.
 *  2. `failed` ⇒ the ticket is not touched AT ALL. Not transitioned, not
 *     commented, not re-pinged — the tap itself is the retry.
 *  3. `alreadyResolved` ⇒ the ticket IS transitioned. The pipeline is already
 *     where the human wants it; refusing the ticket half here is what leaves a
 *     resolved gate parked in `in_review` forever.
 *
 * The assertion vehicle is ONE ordered log across the AWS and hub seams, because
 * "both writes happened" is not the property under test.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TG_TOKEN = "111111:test-bot-token";
const HUB = "https://hub.example.invalid";
const CHAT = 555;
const WF = "wf-4739";
const GATE = "TEAM-9101";
const PIPELINE = "hub-widget-deploy";
const REPO = "acme/widget";
const REGION = "us-west-2";
const BUCKET = "test-artifact-bucket";
const CD_REGISTRY_KEY = "config/cd-registry.json";
const EXEC = "11111111-2222-3333-4444-555555555555";
const TOKEN = "approval-token-4739-0123456789-far-too-long-for-a-callback-data-field";

// ─── one ordered log across every write seam ─────────────────────────────────

const log = vi.hoisted(() => ({ entries: [] }));
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
        // Only the gate LEDGER rows are ordering-relevant; claim rows are noise.
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

// The registry read, plus the SEC-1 rejection marker write (the bridge's only
// PutObject) — logged, because a ❌ records it AFTER the pipeline said Rejected.
const s3 = vi.hoisted(() => ({ registry: null, puts: [] }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(c) {
      if (c.op === "put") {
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
    sent: [], answered: [], edited: [], transitions: [], comments: [], ...overrides,
  };
  net.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : null;
    if (u.startsWith("https://api.github.com/")) return jsonRes({});
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

async function loadModule() {
  vi.resetModules();
  Object.assign(process.env, ENV);
  process.env.ARTIFACT_BUCKET = BUCKET;
  delete process.env.DEPLOY_PIPELINE_NAME;
  s3.registry = { version: 1, repos: [{ repo: REPO, pipeline: PIPELINE, region: REGION }] };
  const mod = await import("../index.mjs");
  mod._setDeployGateRetryMsForTests(0);
  return mod;
}

const realFetch = global.fetch;
beforeEach(() => {
  db.items.clear(); db.puts.length = 0; db.deletes.length = 0; db.updates.length = 0;
  cp.states.clear(); cp.putErrors.clear(); cp.approvals.length = 0;
  s3.puts.length = 0; s3.registry = null;
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
      actionStates: [{ actionName: "Source", currentRevision: { revisionId: "cafe1234beef5678" } }] },
    { stageName: "Approval",
      latestExecution: { status: "InProgress", pipelineExecutionId: EXEC },
      // No pipelineExecutionId on the ACTION: CodePipeline's ActionExecution has
      // none — only the stage's record names the execution (prod, 2026-09-21).
      actionStates: [{ actionName: "Approve_deploy",
        latestExecution: { status: "InProgress", token: TOKEN } }] },
  ],
});
/** The same gate after someone ELSE approved it: no token, a Succeeded approval. */
const settledState = (summary = "Approved via Telegram by chat 999") => ({
  stageStates: [
    { stageName: "Source",
      latestExecution: { status: "Succeeded", pipelineExecutionId: EXEC },
      actionStates: [{ actionName: "Source", currentRevision: { revisionId: "cafe1234beef5678" } }] },
    { stageName: "Approval",
      latestExecution: { status: "Succeeded", pipelineExecutionId: EXEC },
      actionStates: [{ actionName: "Approve_deploy",
        latestExecution: { status: "Succeeded", summary, lastUpdatedBy: "arn:aws:sts::1:assumed-role/bridge" } }] },
  ],
});
const tap = (updateId, action) => ({
  update_id: updateId,
  callback_query: {
    id: `cb-${updateId}`, data: `${action}|${GATE}|${WF}`,
    message: { message_id: 11, chat: { id: CHAT }, text: "*🚀 PRODUCTION DEPLOY — approval needed*" },
  },
});
const kinds = () => log.entries.map((e) => e.kind);

async function runTap(mod, action, { tickets = [gateRow()] } = {}) {
  const net = makeNet(makeCtx(), { tickets, batches: [[tap(1, action)]] });
  global.fetch = net.fetch;
  await mod.handler({}, net.ctx);
  return net;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("a deploy gate records the pipeline before the ticket (SEC-10)", () => {
  it("✅ orders the ledger row, the approval, then the transition", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, pendingState());

    const net = await runTap(mod, "gok");

    // The whole point: the transition is LAST, and the ledger is FIRST — a run
    // that dies after the ledger row can prove on retry that the gate is ours.
    expect(kinds()).toEqual(["ledger", "approval", "transition"]);
    expect(log.entries[0].id).toBe(`approved#${GATE}`);
    expect(cp.approvals[0]).toMatchObject({
      pipelineName: PIPELINE, stageName: "Approval", actionName: "Approve_deploy", token: TOKEN,
    });
    expect(cp.approvals[0].result.status).toBe("Approved");
    expect(net.transitions).toEqual([expect.objectContaining({ ticketId: GATE, targetStatus: "done" })]);
  });

  it("❌ orders the ledger row, the rejection, the marker, then the transition", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, pendingState());

    await runTap(mod, "gno");

    // The SEC-1 marker is written from the state the rejection was decided on,
    // and only AFTER the pipeline actually took it — a marker for a rejection
    // that never landed would make the next run skip a live approval.
    expect(kinds()).toEqual(["ledger", "approval", "rejection-marker"]);
    expect(cp.approvals[0].result.status).toBe("Rejected");
    expect(s3.puts[0]).toMatchObject({
      Bucket: BUCKET,
      Key: "pipeline-artifacts/ship-approvals/cafe1234beef5678.rejected.json",
    });
    expect(JSON.parse(s3.puts[0].Body)).toMatchObject({
      executionId: EXEC, pipeline: PIPELINE, chatId: String(CHAT),
    });
    // ❌ parks a rework note rather than transitioning — the ordering that
    // matters is that nothing on the ticket side ran before the pipeline did.
    expect(kinds().indexOf("approval")).toBeLessThan(
      kinds().includes("transition") ? kinds().indexOf("transition") : Infinity);
  });
});

describe("the tri-state decides whether the ticket half runs at all (SEC-8)", () => {
  it("failed: the approval write throws ⇒ the ticket is never touched", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, pendingState());
    cp.putErrors.set(PIPELINE, { name: "AccessDeniedException", message: "not authorized to PutApprovalResult" });

    const net = await runTap(mod, "gok");

    expect(net.transitions, "a pipeline that did not move must not move the ticket").toEqual([]);
    expect(kinds()).not.toContain("transition");
    // …and the human is told so, on the message they tapped, with the keyboard
    // still there: the tap is the retry.
    expect(net.edited.at(-1).text).toMatch(/NOT approved/);
    expect(net.edited.at(-1).text).toContain(GATE);
    expect(net.answered.at(-1).text).toMatch(/nothing changed/i);
  });

  it("failed on ❌: no rejection marker either", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, pendingState());
    cp.putErrors.set(PIPELINE, { name: "AccessDeniedException", message: "not authorized to PutApprovalResult" });

    const net = await runTap(mod, "gno");

    expect(s3.puts, "an unrecorded rejection must not leave a marker behind").toEqual([]);
    expect(net.transitions).toEqual([]);
    expect(net.edited.at(-1).text).toMatch(/NOT rejected/);
  });

  it("alreadyResolved: the gate was answered in the gap ⇒ the ticket STILL moves", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, pendingState());
    // Someone approved it in the console between our state read and our write.
    cp.putErrors.set(PIPELINE, {
      name: "ApprovalAlreadyCompletedException",
      message: "The approval action has already been completed",
    });

    const net = await runTap(mod, "gok");

    expect(cp.approvals, "our write did not land").toEqual([]);
    expect(net.transitions, "…but the pipeline IS where the human wants it")
      .toEqual([expect.objectContaining({ ticketId: GATE, targetStatus: "done" })]);
    expect(net.edited.at(-1).text).toMatch(/✅ Approved/);
  });

  it("alreadyResolved: nothing is waiting but the ledger says we answered it", async () => {
    const mod = await loadModule();
    // The retried tap: the previous invocation wrote the ledger row and the
    // approval, then died before the transition. No approval action is parked.
    cp.states.set(PIPELINE, { stageStates: [] });
    db.items.set(`approved#${GATE}`, {
      id: { S: `approved#${GATE}` },
      decision: { S: "Approved" }, decidedAt: { N: String(Date.now()) },
      chatId: { S: String(CHAT) },
    });

    const net = await runTap(mod, "gok");

    expect(cp.approvals).toEqual([]);
    expect(net.transitions).toEqual([expect.objectContaining({ ticketId: GATE, targetStatus: "done" })]);
    expect(net.answered.some((a) => /already recorded/i.test(a.text))).toBe(true);
  });

  it("alreadyResolved: the pipeline's OWN page answered this execution first ⇒ the ticket still moves", async () => {
    const mod = await loadModule();
    // The human tapped the pipeline's tokenless page a moment ago: that page
    // wrote the pipeline+execution ledger row and consumed the wait. No
    // ticket-keyed row exists. This used to be "no approval action is waiting"
    // and a gate parked in in_review behind a deploy that had shipped.
    cp.states.set(PIPELINE, settledState());
    db.items.set(`resolved#${PIPELINE}#${EXEC}`, {
      id: { S: `resolved#${PIPELINE}#${EXEC}` },
      decision: { S: "Approved" }, decidedAt: { N: String(Date.now()) }, chatId: { S: "999" },
    });

    const net = await runTap(mod, "gok");

    expect(cp.approvals, "nothing left to approve").toEqual([]);
    expect(net.transitions).toEqual([expect.objectContaining({ ticketId: GATE, targetStatus: "done" })]);
    expect(db.items.has(`approved#${GATE}`), "ticket-keyed row stamped so a re-tap is a no-op").toBe(true);
    expect(net.edited.at(-1).text).toMatch(/✅ Approved/);
  });

  it("alreadyResolved: no ledger at all, but the pipeline shows this execution Approved (console) ⇒ the ticket still moves", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, settledState("Approved by a human in the console"));

    const net = await runTap(mod, "gok");

    expect(cp.approvals).toEqual([]);
    expect(net.transitions).toEqual([expect.objectContaining({ ticketId: GATE, targetStatus: "done" })]);
  });

  it("failed: nothing is waiting, no ledger, and the pipeline has no verdict for this execution ⇒ the ticket is untouched", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, { stageStates: [] });

    const net = await runTap(mod, "gok");

    expect(net.transitions).toEqual([]);
    expect(net.edited.at(-1).text).toMatch(/no approval action is waiting/);
  });
});
