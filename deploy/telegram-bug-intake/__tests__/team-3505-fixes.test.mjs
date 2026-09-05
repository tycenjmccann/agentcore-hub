/**
 * TEAM-3505 ship-review (round 4) regressions, driven through the exported
 * handler with the same module-seam mocks as ship-review-fixes.test.mjs:
 *
 *  1. Callback allowlist (P1): the generic callback path (pick|<id>|<idx>,
 *     cancel|<id>) never checked ALLOWED_CHAT_IDS — routeMessage fails closed
 *     for messages and handleGateCallback re-checks gok/gno, but any chat
 *     tapping a repo-picker or cancel button went straight to GetItem →
 *     fileTicket()/DeleteItem. A chat de-allowlisted AFTER receiving a picker
 *     keyboard (pending items live 24h) could still file Jira tickets / start
 *     pipelines, or destroy another user's pending bug. Invariant: a
 *     non-allowlisted chat's callback produces ONLY an answerCallbackQuery —
 *     no ticket, no pending-item mutation — and (fail closed) an empty
 *     allowlist authorizes nobody. Allowlisted chats' pick/cancel unchanged.
 *
 *  2. Gate claim leak (P2): claimGate() writes the 30-day dedupe claim BEFORE
 *     listChats() runs inside scanReviewGates. The zero-chats and
 *     zero-delivered paths released the claim, but a listChats() THROW
 *     (transient DynamoDB Scan failure) propagated out with the claim still
 *     written — that gate ticket got NO ping for 30 days. Invariant: any
 *     failure between claimGate and a delivered ping releases the claim, so
 *     the next scan retries and delivers.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TG_TOKEN = "111111:test-bot-token";
const HUB = "https://hub.example.invalid";

// ─── AWS SDK mocks (hoisted, shared state) ───────────────────────────────────

// db.failChatScans (when set) makes the next N Scans over the chat# prefix
// throw — a transient DynamoDB failure hitting exactly listChats().
const db = vi.hoisted(() => ({ items: new Map(), puts: [], deletes: [], failChatScans: 0 }));
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
        if (p === "chat#" && db.failChatScans > 0) {
          db.failChatScans--;
          throw new Error("transient Scan failure");
        }
        return { Items: [...db.items.values()].filter((i) => i.id.S.startsWith(p)) };
      }
      throw new Error(`unexpected ddb op ${c.op}`);
    }
  }
  return { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand, ScanCommand };
});

vi.mock("@aws-sdk/client-transcribe-streaming", () => ({
  StartStreamTranscriptionCommand: class { constructor(input) { this.input = input; } },
  TranscribeStreamingClient: class {
    async send() { return { TranscriptResultStream: (async function* () {})() }; }
  },
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: class {
    async send() {
      return { output: { message: { content: [{ toolUse: { input: {
        intent: "bug", title: "Some bug", description: "It broke.",
        repo: "test-user/app", confidence: 0.99, severity: "normal",
      } } }] } } };
    }
  },
  ConverseCommand: class { constructor(input) { this.input = input; } },
}));

// ─── fetch router / Lambda context fakes ─────────────────────────────────────

const jsonRes = (body, ok = true, status = 200) => ({
  ok, status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/**
 * net.batches[i] is what the i-th getUpdates call returns; after each poll the
 * fake Lambda clock is set to net.afterPoll[i] (default 20s, under the 30s
 * poll reserve, so the loop always terminates once the batches run out).
 */
function makeNet(ctx, overrides = {}) {
  const net = {
    ctx, polls: 0, batches: [], afterPoll: [],
    workflows: [],
    sent: [], answered: [], edited: [], transitions: [], jiraIssues: [], workflowStarts: [],
    ...overrides,
  };
  net.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : null;
    if (u === `${HUB}/api/workflow/list`) return jsonRes({ workflows: net.workflows });
    if (u.endsWith("/api/workflow/start")) { net.workflowStarts.push(body); return jsonRes({ epicId: "EPIC-1" }); }
    if (u.endsWith("/tickets/transition")) { net.transitions.push(body); return jsonRes({}); }
    if (/\/api\/workflow\/[^/]+\/tickets$/.test(u)) return jsonRes({}, false, 404);
    if (u.includes("/api/workflow/artifacts")) return jsonRes({}, false, 404);
    if (u.startsWith("https://api.github.com/user/repos")) {
      return jsonRes([{ full_name: "test-user/app", private: false, description: "app", language: "JS" }]);
    }
    if (u.endsWith("/rest/api/3/issue")) {
      net.jiraIssues.push(body);
      return jsonRes({ key: `TEST-${net.jiraIssues.length}` });
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

// ALLOWED_CHAT_IDS is resolved at import time → fresh module per env.
async function loadHandler(allowedChatIds) {
  vi.resetModules();
  Object.assign(process.env, ENV);
  if (allowedChatIds == null) delete process.env.ALLOWED_CHAT_IDS;
  else process.env.ALLOWED_CHAT_IDS = allowedChatIds;
  const mod = await import("../index.mjs");
  return mod.handler;
}

const realFetch = global.fetch;

beforeEach(() => {
  db.items.clear();
  db.puts.length = 0;
  db.deletes.length = 0;
  db.failChatScans = 0;
});

afterAll(() => {
  global.fetch = realFetch;
  for (const k of [...Object.keys(ENV), "ALLOWED_CHAT_IDS"]) delete process.env[k];
});

const registerChat = (id) => db.items.set(`chat#${id}`, { id: { S: `chat#${id}` }, chatId: { N: String(id) } });

// A parked repo-picker bug, exactly as processBug writes it (24h TTL).
const seedPending = (id) => db.items.set(id, {
  id: { S: id },
  bug: { S: JSON.stringify({ intent: "bug", title: "Parked bug", description: "It broke.", repo: "", confidence: 0.4 }) },
  fileIds: { S: "[]" },
  candidates: { S: JSON.stringify(["test-user/app"]) },
  ttl: { N: String(Math.floor(Date.now() / 1000) + 86400) },
});

const cbUpdate = (updateId, chatId, data) => ({
  update_id: updateId,
  callback_query: { id: `cb-${updateId}`, data, message: { message_id: 7, chat: { id: chatId }, text: "Which repo?" } },
});

const GATE_WORKFLOWS = [{
  workflowId: "wf-1",
  input: { title: "Test run" },
  humanNotifications: [{ type: "review_needed", acknowledged: false, ticketId: "GATE-1", reviewer: "me" }],
}];

// ─── Finding 1: pick/cancel callbacks must respect ALLOWED_CHAT_IDS ──────────

describe("callback allowlist covers pick/cancel (TEAM-3505 finding 1)", () => {
  it("rejects pick from a non-allowlisted chat — no ticket filed, pending item intact", async () => {
    const handler = await loadHandler("12345");
    seedPending("pend1");
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { batches: [[cbUpdate(201, 666, "pick|pend1|0")]] });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(net.jiraIssues.length, "a de-allowlisted chat must not file a Jira ticket").toBe(0);
    expect(net.workflowStarts.length, "…nor start a pipeline").toBe(0);
    expect(db.items.has("pend1"), "the pending bug must not be consumed").toBe(true);
    expect(db.deletes).not.toContain("pend1");
    expect(net.edited.length, "no confirmation edit for an unauthorized tap").toBe(0);
    expect(net.answered.length, "the tap is acked so Telegram stops re-sending it").toBe(1);
    expect(net.answered[0].text).toMatch(/Not authorized/);
  });

  it("rejects cancel from a non-allowlisted chat — another user's pending bug survives", async () => {
    const handler = await loadHandler("12345");
    seedPending("pend2");
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { batches: [[cbUpdate(202, 666, "cancel|pend2")]] });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(db.items.has("pend2"), "cancel from an unauthorized chat must not destroy the pending bug").toBe(true);
    expect(db.deletes).not.toContain("pend2");
    expect(net.edited.length).toBe(0);
    expect(net.answered.length).toBe(1);
    expect(net.answered[0].text).toMatch(/Not authorized/);
  });

  it("fails closed: an empty allowlist authorizes NO callback", async () => {
    const handler = await loadHandler(null);
    seedPending("pend3");
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { batches: [[cbUpdate(203, 12345, "pick|pend3|0")]] });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(net.jiraIssues.length).toBe(0);
    expect(db.items.has("pend3")).toBe(true);
    expect(net.answered.length).toBe(1);
    expect(net.answered[0].text).toMatch(/Not authorized/);
  });

  it("still files the ticket when an ALLOWLISTED chat taps pick (no regression)", async () => {
    const handler = await loadHandler("12345");
    seedPending("pend4");
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { batches: [[cbUpdate(204, 12345, "pick|pend4|0")]] });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(net.jiraIssues.length, "authorized pick must file the ticket as before").toBe(1);
    expect(net.answered.length).toBe(1);
    expect(net.answered[0].text).toMatch(/Filed TEST-1/);
    expect(db.items.has("pend4"), "the pending item is consumed on success").toBe(false);
    expect(net.edited.length).toBe(1);
    expect(net.edited[0].text).toMatch(/pipeline started/);
  });

  it("still cancels when an ALLOWLISTED chat taps cancel (no regression)", async () => {
    const handler = await loadHandler("12345");
    seedPending("pend5");
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { batches: [[cbUpdate(205, 12345, "cancel|pend5")]] });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(db.items.has("pend5")).toBe(false);
    expect(net.answered.length).toBe(1);
    expect(net.answered[0].text).toMatch(/Cancelled/);
    expect(net.edited.length).toBe(1);
    expect(net.edited[0].text).toMatch(/Cancelled/);
    expect(net.jiraIssues.length).toBe(0);
  });
});

// ─── Finding 2: a listChats failure must not strand the gate claim ───────────

describe("gate claim released on listChats failure (TEAM-3505 finding 2)", () => {
  it("a transient chat-registry Scan failure leaves the gate claimable — the next scan delivers", async () => {
    const handler = await loadHandler("12345");
    registerChat(12345);
    global.fetch = null; // each invocation installs its own router below

    // Invocation 1: claimGate succeeds, then listChats' DynamoDB Scan throws.
    db.failChatScans = 1;
    const ctx1 = makeCtx(100_000);
    const net1 = makeNet(ctx1, { workflows: GATE_WORKFLOWS });
    global.fetch = net1.fetch;
    await handler({}, ctx1);

    expect(net1.sent.length, "nothing was deliverable during the failed scan").toBe(0);
    expect(db.items.has("gate#GATE-1"),
      "the 30-day claim must not outlive a scan that never pinged anyone").toBe(false);

    // Invocation 2 (next poller run): the registry Scan is healthy again.
    const ctx2 = makeCtx(100_000);
    const net2 = makeNet(ctx2, { workflows: GATE_WORKFLOWS });
    global.fetch = net2.fetch;
    await handler({}, ctx2);

    expect(net2.sent.length, "the retried scan must deliver the gate ping").toBe(1);
    expect(net2.sent[0].chat_id).toBe(12345);
    expect(net2.sent[0].text).toMatch(/review gate/i);
    expect(db.items.has("gate#GATE-1"), "a delivered ping keeps the dedupe claim").toBe(true);
  });
});
