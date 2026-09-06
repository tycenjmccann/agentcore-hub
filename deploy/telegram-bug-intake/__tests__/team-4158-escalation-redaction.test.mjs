/**
 * TEAM-4158: every string a manager_escalation (and its review-gate siblings)
 * sends to Telegram must pass through redactText() BEFORE clipping.
 *
 * Telegram is off-account. Any producer that lands agent-streamed text, an
 * error carrying an `Authorization: Bearer …` header, a `ghp_…` token, or a
 * presigned S3 URL (`X-Amz-Signature=`) into notif.details/notif.message would
 * otherwise leak it verbatim. The ping must STILL go out (Resolved button and
 * all) — only the secrets are scrubbed.
 *
 * Same module-seam mocks / harness as manager-escalation-ping.test.mjs.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TG_TOKEN = "111111:test-bot-token";
const HUB = "https://hub.example.invalid";
// Mirrors `const ESC_DETAIL_MAX = 700` in index.mjs (not exported).
const ESC_DETAIL_MAX = 700;

const db = vi.hoisted(() => ({ items: new Map(), puts: [], deletes: [] }));
vi.mock("@aws-sdk/client-dynamodb", () => {
  const cmd = (op) => class { constructor(input) { this.input = input; this.op = op; } };
  const GetItemCommand = cmd("get");
  const PutItemCommand = cmd("put");
  const DeleteItemCommand = cmd("del");
  const ScanCommand = cmd("scan");
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
      if (c.op === "del") {
        db.deletes.push(c.input.Key.id.S);
        db.items.delete(c.input.Key.id.S);
        return {};
      }
      if (c.op === "scan") {
        const p = c.input.ExpressionAttributeValues[":p"].S;
        return { Items: [...db.items.values()].filter((i) => i.id.S.startsWith(p)) };
      }
      throw new Error(`unexpected ddb op ${c.op}`);
    }
  }
  return { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand, ScanCommand };
});
vi.mock("@aws-sdk/client-transcribe-streaming", () => ({
  StartStreamTranscriptionCommand: class { constructor(input) { this.input = input; } },
  TranscribeStreamingClient: class { async send() { return { TranscriptResultStream: (async function* () {})() }; } },
}));
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: class { async send() { throw new Error("not used"); } },
  ConverseCommand: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/client-codepipeline", () => ({
  CodePipelineClient: class { async send() { throw new Error("not used"); } },
  GetPipelineStateCommand: class { constructor(input) { this.input = input; } },
  PutApprovalResultCommand: class { constructor(input) { this.input = input; } },
}));

const jsonRes = (body, ok = true, status = 200) => ({
  ok, status, json: async () => body, text: async () => JSON.stringify(body),
});

function makeNet(ctx, overrides = {}) {
  const net = {
    ctx, polls: 0, batches: [], afterPoll: [], workflows: [],
    sent: [], answered: [], edited: [], transitions: [], patches: [],
    ...overrides,
  };
  net.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : null;
    if (u === `${HUB}/api/workflow/list`) return jsonRes({ workflows: net.workflows });
    if (u.endsWith("/tickets/transition")) { net.transitions.push(body); return jsonRes({}); }
    if (/\/api\/workflow\/[^/]+\/escalations$/.test(u)) {
      net.patches.push({ url: u, method: opts?.method, body });
      return jsonRes({ workflowId: "wf-1", resolved: ["notif_wm_1"] });
    }
    if (/\/api\/workflow\/[^/]+\/tickets$/.test(u)) return jsonRes({}, false, 404);
    if (u.includes("/api/workflow/artifacts")) return jsonRes({}, false, 404);
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

function makeCtx(startMs) {
  return { remainingMs: startMs, getRemainingTimeInMillis() { return this.remainingMs; } };
}

const ENV = {
  TELEGRAM_BOT_TOKEN: TG_TOKEN,
  JIRA_SITE_URL: "example.atlassian.net",
  JIRA_EMAIL: "bot@example.com",
  JIRA_API_TOKEN: "test-jira-token",
  JIRA_PROJECT_KEY: "TEST",
  GITHUB_TOKEN: "test-github-token",
  GITHUB_USER: "test-user",
  PENDING_TABLE: "test-pending-table",
  HUB_API_URL: HUB,
};

async function loadHandler(allowedChatIds) {
  vi.resetModules();
  Object.assign(process.env, ENV);
  if (allowedChatIds == null) delete process.env.ALLOWED_CHAT_IDS;
  else process.env.ALLOWED_CHAT_IDS = allowedChatIds;
  const mod = await import("../index.mjs");
  return mod.handler;
}

const realFetch = global.fetch;
beforeEach(() => { db.items.clear(); db.puts.length = 0; db.deletes.length = 0; });
afterAll(() => {
  global.fetch = realFetch;
  for (const k of [...Object.keys(ENV), "ALLOWED_CHAT_IDS"]) delete process.env[k];
});

const registerChat = (id) => db.items.set(`chat#${id}`, { id: { S: `chat#${id}` }, chatId: { N: String(id) } });

// The exact secrets the invariant must scrub. Kept as named parts so the tests
// can assert each one is gone.
const GHP_TAIL = "a".repeat(36);
const GHP = `ghp_${GHP_TAIL}`;
const BEARER = "Bearer abc.def-ghi_jkl";
const PRESIGNED = "https://b.s3.amazonaws.com/x?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIAX/example";
const PROSE = "the run is wedged and needs a harness fix"; // no MarkdownV2 metachars

// Every secret substring the sent text must NOT contain. `ghp_` survives esc()
// only as `ghp\_`, so GHP_TAIL is the strong signal that the token was scrubbed.
function assertScrubbed(text) {
  expect(text).not.toContain(GHP);
  expect(text).not.toContain(GHP_TAIL);
  expect(text).not.toContain("Bearer abc");
  expect(text).not.toContain("X-Amz-Signature=deadbeef");
  expect(text).not.toContain("AKIA");
  // Positive: redaction actually fired (esc() renders it as \[REDACTED\]).
  expect(text).toContain("REDACTED");
}

const escalatedRun = (notif) => [{
  workflowId: "wf-1",
  input: { title: "Music video journey" },
  humanNotifications: [notif],
}];
const escalations = (net) => net.sent.filter((m) => String(m.text).toLowerCase().includes("workflow manager escalation"));

describe("TEAM-4158 — manager_escalation redacts before clipping", () => {
  it("scrubs secrets in notif.details while keeping the prose + Resolved button", async () => {
    const handler = await loadHandler("12345");
    registerChat(12345);
    const ctx = makeCtx(100_000);
    const details = `${PROSE}. leaked ${GHP} header Authorization: ${BEARER} url ${PRESIGNED}`;
    const net = makeNet(ctx, { workflows: escalatedRun({
      id: "notif_wm_1", type: "manager_escalation", acknowledged: false, details,
    }) });
    global.fetch = net.fetch;

    await handler({}, ctx);
    const pings = escalations(net);
    expect(pings).toHaveLength(1);
    assertScrubbed(pings[0].text);
    // Non-secret prose survives.
    expect(pings[0].text).toContain("wedged");
    expect(pings[0].text).toContain("harness fix");
    // The ping still pages: subject + Resolved button intact.
    expect(pings[0].text).toContain("Music video journey");
    const buttons = pings[0].reply_markup.inline_keyboard.flat();
    expect(buttons.find((b) => b.callback_data === "eok|wf-1")).toBeTruthy();
  });

  it("scrubs secrets when the text is only in notif.message (no details)", async () => {
    const handler = await loadHandler("12345");
    registerChat(12345);
    const ctx = makeCtx(100_000);
    const message = `${PROSE}. token ${GHP} and ${PRESIGNED} plus Authorization: ${BEARER}`;
    const net = makeNet(ctx, { workflows: escalatedRun({
      id: "notif_wm_1", type: "manager_escalation", acknowledged: false, message,
    }) });
    global.fetch = net.fetch;

    await handler({}, ctx);
    const pings = escalations(net);
    expect(pings).toHaveLength(1);
    assertScrubbed(pings[0].text);
    expect(pings[0].text).toContain("harness fix");
  });

  it("redacts BEFORE the clip so a token straddling the clip boundary can't leak", async () => {
    const handler = await loadHandler("12345");
    registerChat(12345);
    const ctx = makeCtx(100_000);
    // The token starts just inside the clip window; a clip-then-redact order
    // would slice mid-token and strand a `ghp_…` prefix.
    const details = "x".repeat(ESC_DETAIL_MAX - 10) + GHP;
    const net = makeNet(ctx, { workflows: escalatedRun({
      id: "notif_wm_1", type: "manager_escalation", acknowledged: false, details,
    }) });
    global.fetch = net.fetch;

    await handler({}, ctx);
    const pings = escalations(net);
    expect(pings).toHaveLength(1);
    expect(pings[0].text).not.toContain("ghp_");
    expect(pings[0].text).not.toContain(GHP_TAIL);
  });
});

describe("TEAM-4158 — review-gate sibling redacts its summary", () => {
  it("scrubs a secret in a review_needed notif.summary", async () => {
    const handler = await loadHandler("12345");
    registerChat(12345);
    const ctx = makeCtx(100_000);
    const summary = `${PROSE}. review this: ${GHP} via Authorization: ${BEARER}`;
    const net = makeNet(ctx, { workflows: [{
      workflowId: "wf-1",
      input: { title: "Gate run" },
      humanNotifications: [{
        type: "review_needed", acknowledged: false, ticketId: "GATE-1",
        reviewer: "me", gate: "dev", summary,
      }],
    }] });
    global.fetch = net.fetch;

    await handler({}, ctx);
    const gatePings = net.sent.filter((m) => /REVIEW GATE/i.test(String(m.text)));
    expect(gatePings).toHaveLength(1);
    assertScrubbed(gatePings[0].text);
    expect(gatePings[0].text).toContain("wedged");
    // The approve/reject controls still ship.
    const buttons = gatePings[0].reply_markup.inline_keyboard.flat();
    expect(buttons.find((b) => b.callback_data === "gok|GATE-1|wf-1")).toBeTruthy();
  });
});
