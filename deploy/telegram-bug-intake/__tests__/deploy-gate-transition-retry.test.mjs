/**
 * TEAM-4751 C1 — a ✅ that approves the pipeline must not then report failure.
 *
 * WP2 (TEAM-4750) gave the ticket twins a typed-gate guard: a
 * `gate:deploy-approval` ticket may only reach `done` once the pipeline's own
 * human approval is verified. That probe reads CodePipeline ONCE, with no
 * tolerance — so the close this bridge fires immediately after its own
 * PutApprovalResult can still see the Approval action InProgress and be refused
 * with a 409. Before this change the throw landed in the update loop's generic
 * handler and the human, who had just approved production, was told
 * "⚠️ Failed to process" while the gate ticket gained a comment telling them to
 * go approve it in the console. Recovery needed a second tap.
 *
 * Three properties, and none of them is "the transition happened":
 *
 *  1. A guard refusal is RETRIED (bounded), and exactly one ✅ artefact comes out
 *     of a retried success — one edit, one answer, one PutApprovalResult.
 *  2. A refusal that survives the budget produces a TRUTHFUL surface: the deploy
 *     is approved, the ticket is not done, tapping again finishes only the
 *     ticket. Keyboard preserved, because the re-tap is the recovery.
 *  3. A non-guard 409 is an ANSWER, not a race — one POST, no retry — and the
 *     plain (non-deploy) gate path is untouched: it still throws to the loop.
 *
 * Mock idiom, fetch fake and fixtures follow deploy-gate-ordering.test.mjs; the
 * 409 bodies are the real ones (src/app/api/workflow/[id]/tickets/transition/
 * route.ts sends `{error, details, ticketId, targetStatus}` where `details` is
 * gate-contract.mjs gateRefusal().message).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TG_TOKEN = "111111:test-bot-token";
const HUB = "https://hub.example.invalid";
const CHAT = 555;
const WF = "wf-4751";
const GATE = "TEAM-9101";
const PIPELINE = "hub-widget-deploy";
const REPO = "acme/widget";
const REGION = "us-west-2";
const BUCKET = "test-artifact-bucket";
const CD_REGISTRY_KEY = "config/cd-registry.json";
const EXEC = "11111111-2222-3333-4444-555555555555";
const TOKEN = "approval-token-4751-0123456789-far-too-long-for-a-callback-data-field";
const CONSOLE_URL = `https://console.aws.amazon.com/codesuite/codepipeline/pipelines/${PIPELINE}/view?region=${REGION}`;

// The guard's own refusal text, for the deploy-approval kind (gateRefusal()).
const GUARD_DETAIL =
  `Refusing to close ${GATE}: its \`gate:deploy-approval\` condition is not met. ` +
  `the deploy approval for execution ${EXEC} is still OPEN at Approval / Approve_deploy and has not been ` +
  `answered — a human approves it through the bridge. Wait for the approval, then retry this transition; ` +
  `do not file another gate ticket. Console: ${CONSOLE_URL}`;
// A real 409 that is NOT the guard: an answer, not a race.
const NO_TRANSITION_DETAIL = `No transition to "Done" found for ${GATE}`;

// ─── AWS seams ───────────────────────────────────────────────────────────────

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

const s3 = vi.hoisted(() => ({ registry: null, puts: [] }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(c) {
      if (c.op === "put") { s3.puts.push(c.input); return {}; }
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
/** The hub's own 409 body for a rejected transition (route.ts). */
const refusal409 = (details) => jsonRes(
  { error: "Ticket transition rejected", details, ticketId: GATE, targetStatus: "done" },
  false, 409);

function makeNet(ctx, overrides = {}) {
  const net = {
    ctx, polls: 0, batches: [], afterPoll: [], workflows: [], tickets: null,
    // A scripted queue of transition responses; anything past the end is a 200.
    transitionResponses: [],
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
      const scripted = net.transitionResponses.shift();
      if (scripted) return refusal409(scripted);
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
/** A plain review gate — no deploy-approval label, so no pipeline call at all. */
const plainGateRow = (extra = {}) => ({
  ticketId: GATE, title: "Code review gate: the widget", status: "in review",
  labels: [`wf:${WF}`], ...extra,
});
const pendingState = () => ({
  stageStates: [
    { stageName: "Source",
      latestExecution: { status: "Succeeded", pipelineExecutionId: EXEC },
      actionStates: [{ actionName: "Source", currentRevision: { revisionId: "cafe1234beef5678" } }] },
    { stageName: "Approval",
      latestExecution: { status: "InProgress", pipelineExecutionId: EXEC },
      actionStates: [{ actionName: "Approve_deploy",
        latestExecution: { status: "InProgress", token: TOKEN, pipelineExecutionId: EXEC } }] },
  ],
});
/** The approval taken and gone — what a second tap sees after tap 1 approved. */
const approvedState = () => ({
  stageStates: [
    { stageName: "Source",
      latestExecution: { status: "Succeeded", pipelineExecutionId: EXEC },
      actionStates: [{ actionName: "Source", currentRevision: { revisionId: "cafe1234beef5678" } }] },
    { stageName: "Approval",
      latestExecution: { status: "Succeeded", pipelineExecutionId: EXEC },
      actionStates: [{ actionName: "Approve_deploy",
        latestExecution: { status: "Succeeded", pipelineExecutionId: EXEC } }] },
  ],
});

// The tapped message CARRIES a keyboard — the stuck-gate edit must keep it, so
// the re-tap that finishes the ticket is still possible.
const KEYBOARD = { inline_keyboard: [[
  { text: "✅ Approve", callback_data: `gok|${GATE}|${WF}` },
  { text: "❌ Request changes", callback_data: `gno|${GATE}|${WF}` },
]] };
const tap = (updateId, action, extra = {}) => ({
  update_id: updateId,
  callback_query: {
    id: `cb-${updateId}`, data: `${action}|${GATE}|${WF}`,
    message: {
      message_id: 11, chat: { id: CHAT },
      text: "*🚀 PRODUCTION DEPLOY — approval needed*",
      reply_markup: KEYBOARD, ...extra,
    },
  },
});
const kinds = () => log.entries.map((e) => e.kind);
const failedToProcess = (net) => net.sent.filter((s) => /Failed to process/.test(String(s?.text || "")));

async function runTap(mod, action, { tickets = [gateRow()], transitionResponses = [], updateId = 1 } = {}) {
  const net = makeNet(makeCtx(), { tickets, transitionResponses, batches: [[tap(updateId, action)]] });
  global.fetch = net.fetch;
  await mod.handler({}, net.ctx);
  return net;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("a lagging gate-guard read is retried, not reported as a failure (C1)", () => {
  it("(a) one guard refusal then 200 ⇒ one approval, two closes, one ✅ artefact", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, pendingState());

    const net = await runTap(mod, "gok", { transitionResponses: [GUARD_DETAIL] });

    // The irreversible write happened exactly once…
    expect(cp.approvals, "the retry must not re-approve the pipeline").toHaveLength(1);
    // …and the close was retried to success, both attempts asking for `done`.
    expect(net.transitions).toHaveLength(2);
    expect(net.transitions.every((t) => t.ticketId === GATE && t.targetStatus === "done")).toBe(true);
    expect(kinds()).toEqual(["ledger", "approval", "transition", "transition"]);

    // ONE ✅ artefact: one edit, one answer, and never the generic failure.
    const approvals = net.edited.filter((e) => /Approved — pipeline resuming/.test(String(e.text)));
    expect(approvals).toHaveLength(1);
    expect(net.edited).toHaveLength(1);
    expect(net.answered.filter((a) => /Approved/.test(String(a.text)))).toHaveLength(1);
    expect(failedToProcess(net)).toEqual([]);
  });

  it("(b) refused on every attempt ⇒ a truthful edit with the keyboard kept, and a second tap finishes it", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, pendingState());
    const tickets = [gateRow()];

    // Four refusals is one more than the budget can consume, so the run also
    // proves the loop STOPS rather than draining whatever the hub returns.
    const net = await runTap(mod, "gok", {
      tickets, transitionResponses: [GUARD_DETAIL, GUARD_DETAIL, GUARD_DETAIL, GUARD_DETAIL, GUARD_DETAIL],
    });

    expect(cp.approvals).toHaveLength(1);
    expect(net.transitions).toHaveLength(mod.DEPLOY_GATE_TRANSITION_TRIES);
    expect(mod.DEPLOY_GATE_TRANSITION_TRIES).toBe(4);
    expect(failedToProcess(net), "the deploy IS approved — this is not a total failure").toEqual([]);

    const last = net.edited.at(-1);
    expect(last.text).toMatch(/deploy IS approved on the pipeline/);
    expect(last.text).toMatch(/could not be marked done yet/);
    expect(last.text).toContain(GATE);
    expect(last.text, "the guard's own reason, so the human knows what to wait for")
      .toMatch(/condition is not met/);
    expect(last.text).toMatch(/Tap ✅ again to finish the ticket only/);
    expect(last.text).toMatch(/will not be approved twice/);
    expect(last.reply_markup, "the re-tap is the recovery — the buttons must survive").toEqual(KEYBOARD);
    expect(net.answered.at(-1).text).toMatch(new RegExp(`Deploy approved — ${GATE} still open`));
    // Not an approval artefact: the gate is NOT done.
    expect(net.edited.some((e) => /Approved — pipeline resuming/.test(String(e.text)))).toBe(false);
    // The ✅'s cleanup is deferred too — the gate can still be rejected.
    expect(db.deletes).not.toContain(`gaterework#${GATE}`);

    // ── the second tap, a later batch: the approval is recorded and gone ──
    cp.states.set(PIPELINE, approvedState());
    const approvalsBefore = cp.approvals.length;
    const again = await runTap(mod, "gok", { tickets, updateId: 2 });

    // wasGateApprovedLocally reads the ledger row tap 1 wrote → alreadyResolved.
    expect(cp.approvals.length - approvalsBefore, "the pipeline must not be approved twice").toBe(0);
    expect(again.transitions).toEqual([expect.objectContaining({ ticketId: GATE, targetStatus: "done" })]);
    expect(again.edited.at(-1).text).toMatch(/✅ Approved — pipeline resuming/);
    expect(again.answered.some((a) => /already recorded/i.test(String(a.text)))).toBe(true);
  });

  it("(c) a non-guard 409 is an answer, not a race: one POST, no retry, still no generic failure", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, pendingState());

    const net = await runTap(mod, "gok", { transitionResponses: [NO_TRANSITION_DETAIL] });

    expect(net.transitions, "\"No transition found\" will not fix itself in 10s").toHaveLength(1);
    expect(cp.approvals).toHaveLength(1);
    expect(failedToProcess(net)).toEqual([]);
    const last = net.edited.at(-1);
    expect(last.text).toMatch(/deploy IS approved on the pipeline/);
    expect(last.text).toMatch(/No transition to "Done" found/);
    expect(last.reply_markup).toEqual(KEYBOARD);
  });

  it("(d) alreadyResolved then a guard refusal then 200 ⇒ the ticket still ends done", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, pendingState());
    // Someone approved it in the console between our state read and our write.
    cp.putErrors.set(PIPELINE, {
      name: "ApprovalAlreadyCompletedException",
      message: "The approval action has already been completed",
    });
    const tickets = [gateRow()];

    const net = await runTap(mod, "gok", { tickets, transitionResponses: [GUARD_DETAIL] });

    expect(cp.approvals, "our write did not land").toEqual([]);
    // …but the pipeline is where the human wants it, so the ticket half runs —
    // and it too gets the retry, because the guard's read lags either way.
    expect(net.transitions).toHaveLength(2);
    expect(tickets[0].status).toBe("done");
    expect(net.edited.filter((e) => /✅ Approved/.test(String(e.text)))).toHaveLength(1);
    expect(failedToProcess(net)).toEqual([]);
  });

  it("a 5xx is not retried — only the guard's refusal is", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, pendingState());
    const net = makeNet(makeCtx(), { tickets: [gateRow()], batches: [[tap(1, "gok")]] });
    const inner = net.fetch;
    net.fetch = async (url, opts) => {
      if (String(url).endsWith("/tickets/transition")) {
        net.transitions.push(JSON.parse(opts.body));
        return jsonRes({ error: "upstream unavailable" }, false, 503);
      }
      return inner(url, opts);
    };
    global.fetch = net.fetch;
    await mod.handler({}, net.ctx);

    expect(net.transitions).toHaveLength(1);
    expect(net.edited.at(-1).text).toMatch(/could not be marked done yet/);
  });
});

/**
 * The plain-gate arm. No irreversible write precedes it, so a refusal there is
 * still allowed to reach the update loop's generic handler — keeping that true is
 * what makes the fix above a narrow one rather than a change to every gate tap.
 */
describe("a plain gate's ✅ is behaviourally unchanged (C1 scope)", () => {
  it("a 409 on a non-deploy gate makes ONE POST and surfaces the generic failure", async () => {
    const mod = await loadModule();

    const net = await runTap(mod, "gok", {
      tickets: [plainGateRow()], transitionResponses: [GUARD_DETAIL],
    });

    expect(cp.approvals, "an unlabelled gate reaches no CodePipeline call").toEqual([]);
    expect(net.transitions, "no retry: nothing irreversible happened first").toHaveLength(1);
    expect(failedToProcess(net)).toHaveLength(1);
    expect(failedToProcess(net)[0].text).toMatch(/transition 409/);
    expect(net.edited.some((e) => /deploy IS approved/.test(String(e.text)))).toBe(false);
  });

  it("a plain gate's ✅ still closes on a 200 with one transition and one edit", async () => {
    const mod = await loadModule();
    const tickets = [plainGateRow()];

    const net = await runTap(mod, "gok", { tickets });

    expect(net.transitions).toEqual([expect.objectContaining({ ticketId: GATE, targetStatus: "done" })]);
    expect(tickets[0].status).toBe("done");
    expect(net.edited).toHaveLength(1);
    expect(net.edited[0].text).toMatch(/✅ Approved — pipeline resuming/);
    expect(failedToProcess(net)).toEqual([]);
  });
});
