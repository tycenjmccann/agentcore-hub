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

// ─── TEAM-4753 N1: the two shapes a done→done comes back as ──────────────────
// dynamodb mode — the hub route's OWN pre-check answers first, with a 400 whose
// reason is in `error` (route.ts VALID_TRANSITIONS.done = ["todo"]).
const ROUTE_DONE_DONE = { status: 400, error: "Invalid transition from done to done" };
// the DDB twin's own refusal, forwarded by the route as a 409 `details`.
const TWIN_DONE_DONE = {
  status: 409,
  details: `Invalid transition "done" from status "done". Available: todo (→ todo)`,
};
// …and the near misses that must stay failures: a real invalid transition FROM a
// live status, and Jira's refusal, which says nothing about the current status.
const OTHER_INVALID_409 = {
  status: 409,
  details: `Invalid transition "done" from status "in_progress". Available: done (→ done), blocked (→ blocked)`,
};
const OTHER_INVALID_400 = { status: 400, error: "Invalid transition from in_review to done" };

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
    // A string entry is the hub's 409 refusal body with that `details` (the
    // common case); `{status, details}` scripts any other failure shape — the
    // route's OWN pre-check answers a dynamodb-mode done→done with a 400 whose
    // reason is in `error`, not `details` (TEAM-4753).
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
      if (typeof scripted === "string") return refusal409(scripted);
      if (scripted) {
        // `details` is the twin's reason forwarded by the route; `error` alone is
        // the route's own pre-check verdict. JSON.stringify drops the undefined
        // one, so each shape is byte-faithful to what the hub really sends.
        return jsonRes(
          { error: scripted.error ?? "Ticket transition rejected", details: scripted.details,
            ticketId: GATE, targetStatus: body?.targetStatus },
          false, scripted.status);
      }
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
/** Any other callback button on the same ping (the escalation-DECISION and rework-retry taps). */
const cbTap = (updateId, data, text = "*🚀 PRODUCTION DEPLOY — approval needed*") => ({
  update_id: updateId,
  callback_query: {
    id: `cb-${updateId}`, data,
    message: { message_id: 11, chat: { id: CHAT }, text, reply_markup: KEYBOARD },
  },
});
const kinds = () => log.entries.map((e) => e.kind);
const failedToProcess = (net) => net.sent.filter((s) => /Failed to process/.test(String(s?.text || "")));
const stuckEdits = (net) => net.edited.filter((e) => /could not be marked done yet/.test(String(e.text)));

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

/**
 * TEAM-4753 N1 — the re-tap C1's stuck-gate message asks for has to be able to
 * SUCCEED. It could not: the ✅ path had no idea a gate was already `done`, so it
 * re-ran both halves and read the resulting done→done refusal as a fresh failure.
 * Every re-tap repeated "could not be marked done yet — tap ✅ again", forever.
 *
 * Two guards, and the second is what makes it one rule rather than one patch:
 *
 *  (a) the `gok` pre-read already carries `status` (gateTicketOf returns the whole
 *      row), so an already-done gate short-circuits to the ✅ artefact — zero
 *      PutApprovalResult, zero transition POST, zero ledger row.
 *  (b) `transitionGate` — the ONE low-level helper every caller goes through —
 *      treats a done→done refusal as a landed close, so handleDecisionCallback
 *      gets it too, while deliverReworkNote's done→blocked keeps failing.
 *
 * The regex is the risk, so the negatives are half the block: the bridge talks to
 * the HUB ROUTE, whose answer for this input differs by provider (a 400 from its
 * own pre-check in dynamodb mode, a 409 carrying the twin's text otherwise), and
 * Jira's refusal names no status at all and must stay a failure.
 */
describe("a `done` that already landed is a success, not a stuck gate (N1)", () => {
  it("transition landed but response lost ⇒ the re-tap yields the ✅ edit, 0 extra PutApprovalResult, 0 stuck message", async () => {
    const mod = await loadModule();
    cp.states.set(PIPELINE, pendingState());
    const tickets = [gateRow()];

    // ── tap 1: the close COMMITS and the response never comes back ──
    const net = makeNet(makeCtx(), { tickets, batches: [[tap(1, "gok")]] });
    const inner = net.fetch;
    net.fetch = async (url, opts) => {
      if (String(url).endsWith("/tickets/transition")) {
        const body = JSON.parse(opts.body);
        net.transitions.push(body);
        log.entries.push({ kind: "transition", ticketId: body.ticketId, targetStatus: body.targetStatus });
        // The twin committed…
        tickets.find((t) => t.ticketId === body.ticketId).status = body.targetStatus;
        // …and then the socket died on the way back.
        throw new Error("socket hang up");
      }
      return inner(url, opts);
    };
    global.fetch = net.fetch;
    await mod.handler({}, net.ctx);

    // Tap 1's surface is unchanged and honest: it cannot know the write landed.
    expect(cp.approvals).toHaveLength(1);
    expect(net.transitions).toHaveLength(1);
    expect(stuckEdits(net)).toHaveLength(1);
    expect(tickets[0].status, "the ticket IS done — only the answer was lost").toBe("done");

    // ── tap 2: the human does what the message told them to ──
    cp.states.set(PIPELINE, approvedState());
    const again = await runTap(mod, "gok", { tickets, updateId: 2 });

    expect(cp.approvals, "the pipeline must not be approved twice").toHaveLength(1);
    expect(again.transitions, "nothing left to close — the pre-read said so").toEqual([]);
    expect(again.edited).toHaveLength(1);
    expect(again.edited[0].text).toMatch(/✅ Approved — pipeline resuming/);
    expect(stuckEdits(again), "the lie is what N1 is about").toEqual([]);
    expect(failedToProcess(again)).toEqual([]);
  });

  it("(i) a pre-read that says `done` costs 0 PutApprovalResult, 0 transition POST and 0 ledger rows", async () => {
    const mod = await loadModule();
    // A token IS waiting, so the short-circuit is driven by the TICKET, not by an
    // empty pipeline: re-approving here would be a real second production write.
    cp.states.set(PIPELINE, pendingState());

    const net = await runTap(mod, "gok", { tickets: [gateRow({ status: "done" })] });

    expect(cp.approvals).toEqual([]);
    expect(net.transitions).toEqual([]);
    expect(kinds(), "no pipeline call, no close, no decision ledger row").toEqual([]);
    expect(net.edited).toHaveLength(1);
    expect(net.edited[0].text).toMatch(/✅ Approved — pipeline resuming/);
    expect(net.answered.filter((a) => new RegExp(`Approved ${GATE}`).test(String(a.text)))).toHaveLength(1);
    expect(stuckEdits(net)).toEqual([]);
    expect(failedToProcess(net)).toEqual([]);
  });

  it("(i) …and the same holds for a plain (non-deploy) gate that is already done", async () => {
    const mod = await loadModule();

    const net = await runTap(mod, "gok", { tickets: [plainGateRow({ status: "done" })] });

    expect(cp.approvals).toEqual([]);
    expect(net.transitions).toEqual([]);
    expect(net.edited).toHaveLength(1);
    expect(net.edited[0].text).toMatch(/✅ Approved — pipeline resuming/);
    expect(failedToProcess(net)).toEqual([]);
  });

  // The residual race the pre-read cannot see: it read `in review`, and the close
  // still came back done→done (a concurrent tap, or a retry of a lost response
  // inside one invocation).
  for (const [name, scripted] of [
    ["the hub route's own 400 (dynamodb mode)", ROUTE_DONE_DONE],
    ["the twin's 409 details", TWIN_DONE_DONE],
  ]) {
    it(`(ii) ${name} is a landed close: one POST, the ✅ edit, no stuck message`, async () => {
      const mod = await loadModule();
      cp.states.set(PIPELINE, pendingState());

      const net = await runTap(mod, "gok", { transitionResponses: [scripted] });

      expect(cp.approvals).toHaveLength(1);
      expect(net.transitions, "an answer about the ticket's state is not a lagging read").toHaveLength(1);
      expect(kinds()).toEqual(["ledger", "approval", "transition"]);
      expect(net.edited).toHaveLength(1);
      expect(net.edited[0].text).toMatch(/✅ Approved — pipeline resuming/);
      expect(stuckEdits(net)).toEqual([]);
      expect(failedToProcess(net)).toEqual([]);
    });
  }

  // The regex must name done→done and nothing else. `(c)` above pins the short
  // form of Jira's refusal; this pins the real one, alongside two invalid
  // transitions FROM a live status — none of which prove the ticket is closed.
  for (const [name, scripted] of [
    ["a 409 from a non-done status", OTHER_INVALID_409],
    ["a 400 from a non-done status", OTHER_INVALID_400],
    ["Jira's `No transition to \"Done\" found`", {
      status: 409,
      details: `No transition to "Done" found. Available: Start work (-> In Progress), Block (-> Blocked)`,
    }],
  ]) {
    it(`(iii) ${name} is still a failure`, async () => {
      const mod = await loadModule();
      cp.states.set(PIPELINE, pendingState());
      const tickets = [gateRow()];

      const net = await runTap(mod, "gok", { tickets, transitionResponses: [scripted] });

      expect(cp.approvals).toHaveLength(1);
      expect(net.transitions).toHaveLength(1);
      expect(tickets[0].status, "the close did not land").toBe("in review");
      expect(stuckEdits(net), "an unproven close must still page the human").toHaveLength(1);
      expect(net.edited.at(-1).reply_markup, "the re-tap is the recovery").toEqual(KEYBOARD);
      expect(net.edited.some((e) => /✅ Approved — pipeline resuming/.test(String(e.text)))).toBe(false);
    });
  }

  it("(iv) a rework note's done→blocked refusal is untouched — it still parks the note", async () => {
    const mod = await loadModule();
    const REJ = `rej#${CHAT}`;
    db.items.set(REJ, {
      id: { S: REJ }, ticketId: { S: GATE }, workflowId: { S: WF },
      note: { S: "the saved note" }, ttl: { N: String(Math.floor(Date.now() / 1000) + 3600) },
    });
    const net = makeNet(makeCtx(), {
      batches: [[cbTap(3, `rjr|${GATE}|${WF}`, "⚠️ Couldn't send…")]],
      // Same phrasing shape, different target — `blocked` is never idempotent here.
      transitionResponses: [{ status: 400, error: "Invalid transition from done to blocked" }],
    });
    global.fetch = net.fetch;
    await mod.handler({}, net.ctx);

    expect(net.transitions).toEqual([expect.objectContaining({ targetStatus: "blocked" })]);
    expect(db.items.get(REJ)?.note?.S, "swallowing this would lose the reviewer's note").toBe("the saved note");
    expect(net.edited.at(-1).text).toMatch(/Retry failed/);
  });

  it("(v) an escalation DECISION on an already-done gate no longer says \"Failed to process\"", async () => {
    const mod = await loadModule();
    const net = makeNet(makeCtx(), {
      batches: [[cbTap(4, `gdc|m|${GATE}|${WF}`)]],
      transitionResponses: [ROUTE_DONE_DONE],
    });
    global.fetch = net.fetch;
    await mod.handler({}, net.ctx);

    // The rule lives in transitionGate, so this caller gets it with no code of
    // its own — which is the whole reason it is there and not in the gok branch.
    expect(net.transitions).toHaveLength(1);
    expect(failedToProcess(net)).toEqual([]);
    expect(net.edited.at(-1).text).toMatch(/DECISION: merge-with-known-findings recorded on TEAM-9101/);
    expect(net.answered.at(-1).text).toMatch(/Recorded DECISION: merge-with-known-findings/);
  });
});
