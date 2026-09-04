/**
 * Workflow Manager escalations must page a human.
 *
 * intervene.py `escalate` records an unacknowledged manager_escalation and the
 * watch scheduler skips the run while it is open — by design a human gate. But
 * the bot only paged for review_needed, so an escalated run was parked
 * silently until someone opened the UI (TEAM-3938: 7h invisible). This pins
 * the contract: one ping per escalation to allowlisted chats, a Resolved button
 * that PATCHes /api/workflow/[id]/escalations, fail-closed on the allowlist.
 *
 * Same module-seam mocks as team-3499-fixes.test.mjs.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TG_TOKEN = "111111:test-bot-token";
const HUB = "https://hub.example.invalid";

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

const ESCALATION = {
  id: "notif_wm_1",
  type: "manager_escalation",
  acknowledged: false,
  details: "TEAM-3938 (frontend_designer) is in a DETERMINISTIC crash-loop: image >8000px. Needs a harness fix.",
};
const escalatedRun = (notif = ESCALATION) => [{
  workflowId: "wf-1",
  input: { title: "Music video journey" },
  humanNotifications: [notif],
}];
const escalations = (net) => net.sent.filter((m) => String(m.text).includes("Workflow Manager escalation"));

describe("manager_escalation pages allowlisted chats", () => {
  it("sends one ping with a Resolved button and dedupes across scans", async () => {
    const handler = await loadHandler("12345");
    registerChat(12345);
    registerChat(999); // registered, not allowlisted → must not be pinged
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { workflows: escalatedRun() });
    global.fetch = net.fetch;

    await handler({}, ctx);
    const pings = escalations(net);
    expect(pings).toHaveLength(1);
    expect(pings[0].chat_id).toBe(12345);
    expect(pings[0].text).toContain("Music video journey");
    expect(pings[0].text).toContain("crash-loop");
    const buttons = pings[0].reply_markup.inline_keyboard.flat();
    expect(buttons.find((b) => b.callback_data === "eok|wf-1")).toBeTruthy();
    expect(buttons.find((b) => b.url === `${HUB}/workflow?id=wf-1`)).toBeTruthy();
    expect(db.items.has("esc#notif_wm_1")).toBe(true);

    // Same open escalation on the next invocation → no second ping.
    const ctx2 = makeCtx(100_000);
    const net2 = makeNet(ctx2, { workflows: escalatedRun() });
    global.fetch = net2.fetch;
    await handler({}, ctx2);
    expect(escalations(net2)).toHaveLength(0);
  });

  it("ignores acknowledged escalations and review_needed-only runs", async () => {
    const handler = await loadHandler("12345");
    registerChat(12345);
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { workflows: [
      ...escalatedRun({ ...ESCALATION, acknowledged: true }),
      { workflowId: "wf-2", input: { title: "Gate only" },
        humanNotifications: [{ type: "review_needed", acknowledged: false, ticketId: "GATE-1", reviewer: "me" }] },
    ] });
    global.fetch = net.fetch;
    await handler({}, ctx);
    expect(escalations(net)).toHaveLength(0);
    expect(db.items.has("esc#notif_wm_1")).toBe(false);
  });

  it("releases the claim when no allowlisted chat can be paged", async () => {
    const handler = await loadHandler("12345");
    registerChat(999); // nobody allowlisted is registered
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { workflows: escalatedRun() });
    global.fetch = net.fetch;
    await handler({}, ctx);
    expect(escalations(net)).toHaveLength(0);
    expect(db.items.has("esc#notif_wm_1")).toBe(false); // a later scan may retry
  });
});

describe("Resolved button", () => {
  const tap = (chatId) => ({
    update_id: 1,
    callback_query: { id: "cb1", data: "eok|wf-1", message: { chat: { id: chatId }, message_id: 7, text: "🚨 escalation" } },
  });

  it("acknowledges every open escalation on the run via the hub API", async () => {
    const handler = await loadHandler("12345");
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { batches: [[tap(12345)]] });
    global.fetch = net.fetch;
    await handler({}, ctx);
    expect(net.patches).toEqual([{ url: `${HUB}/api/workflow/wf-1/escalations`, method: "PATCH", body: {} }]);
    expect(net.answered[0].text).toMatch(/back under watch/);
    expect(net.edited[0].text).toContain("Resolved via Telegram");
  });

  it("fails closed for a chat outside the allowlist", async () => {
    const handler = await loadHandler("12345");
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { batches: [[tap(555)]] });
    global.fetch = net.fetch;
    await handler({}, ctx);
    expect(net.patches).toHaveLength(0);
    expect(net.answered[0].text).toMatch(/Not authorized/);
    expect(net.edited).toHaveLength(0);
  });
});
