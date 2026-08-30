/**
 * TEAM-3493 ship-review regressions — the four P1 behaviours that survive at
 * the handler seam:
 *
 *  1. Runtime budget for voice notes: paced transcription costs ~the note's
 *     own duration in wall clock, so it must never start unless it fits the
 *     remaining Lambda budget. If it fits a FRESH invocation but not this
 *     one, the update is deferred (offset NOT advanced past it → Telegram
 *     redelivers next invocation). If it can never fit, it is rejected and
 *     the offset advances (no infinite replay).
 *  2. Fail-closed allowlist: an empty/unset ALLOWED_CHAT_IDS authorizes
 *     nobody, not everybody.
 *  3. Gate-callback auth: only allowlisted chats can transition gate tickets;
 *     others get their callback acked but nothing happens.
 *  4. Gate-claim release: the 30-day "already pinged" claim is dropped when
 *     zero pings were actually delivered (no chats, or every send failed).
 *
 * Everything is driven through the exported handler with the AWS SDK clients
 * and global.fetch mocked at the module seam, mirroring the existing
 * transcribe-voice tests. ALLOWED_CHAT_IDS is read at import time, so each
 * test re-imports index.mjs via vi.resetModules() with its own env.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TG_TOKEN = "111111:test-bot-token";
const HUB = "https://hub.example.invalid";

// ─── AWS SDK mocks (hoisted, shared state) ───────────────────────────────────

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

const transcribeRec = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@aws-sdk/client-transcribe-streaming", () => ({
  StartStreamTranscriptionCommand: class { constructor(input) { this.input = input; } },
  // Never consumes AudioStream (so paced sleeps don't slow the tests) and
  // yields no transcript. The assertion that matters is calls === 0.
  TranscribeStreamingClient: class {
    async send() {
      transcribeRec.calls++;
      return { TranscriptResultStream: (async function* () {})() };
    }
  },
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: class {
    async send() { throw new Error("Bedrock must not be called in these tests"); }
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
    workflows: [], sendFail: false,
    sent: [], answered: [], edited: [], transitions: [],
    ...overrides,
  };
  net.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : null;
    if (u === `${HUB}/api/workflow/list`) return jsonRes({ workflows: net.workflows });
    if (u.endsWith("/tickets/transition")) { net.transitions.push(body); return jsonRes({}); }
    if (/\/api\/workflow\/[^/]+\/tickets$/.test(u)) return jsonRes({}, false, 404);
    if (u.includes("/api/workflow/artifacts")) return jsonRes({}, false, 404);
    if (u.endsWith("/getUpdates")) {
      const i = net.polls++;
      net.ctx.remainingMs = net.afterPoll[i] ?? 20_000;
      return jsonRes({ ok: true, result: net.batches[i] || [] });
    }
    if (u.endsWith("/sendMessage")) {
      net.sent.push(body);
      return net.sendFail
        ? jsonRes({ ok: false, description: "blocked" })
        : jsonRes({ ok: true, result: {} });
    }
    if (u.endsWith("/answerCallbackQuery")) { net.answered.push(body); return jsonRes({ ok: true, result: true }); }
    if (u.endsWith("/editMessageText")) { net.edited.push(body); return jsonRes({ ok: true, result: {} }); }
    if (u.endsWith("/sendChatAction")) return jsonRes({ ok: true, result: true });
    if (u.endsWith("/getFile")) return jsonRes({ ok: true, result: { file_path: "voice/x.oga" } });
    if (u.includes("api.telegram.org/file/")) {
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(1000).buffer };
    }
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
  transcribeRec.calls = 0;
});

afterAll(() => {
  global.fetch = realFetch;
  for (const k of [...Object.keys(ENV), "ALLOWED_CHAT_IDS"]) delete process.env[k];
});

const seedOffset = (n) => db.items.set("tg#offset", { id: { S: "tg#offset" }, offset: { N: String(n) } });
const savedOffsets = () => db.puts.filter((p) => p.id.S === "tg#offset").map((p) => p.offset.N);

const voiceUpdate = (updateId, chatId, durationSec) => ({
  update_id: updateId,
  message: { chat: { id: chatId }, voice: { file_id: "VOICE_1", duration: durationSec } },
});

// ─── Finding 1: runtime budget for paced transcription ───────────────────────

describe("voice-note runtime budget (TEAM-3493 finding 1)", () => {
  it("defers a note that fits a fresh invocation but not this one — no transcription, offset not advanced", async () => {
    const handler = await loadHandler("12345");
    seedOffset(41);
    const ctx = makeCtx(900_000); // 15-min function, observed fresh at entry
    // After the poll only ~100s remain — a 146s note cannot finish here.
    const net = makeNet(ctx, { batches: [[voiceUpdate(42, 12345, 146)]], afterPoll: [100_000] });
    global.fetch = net.fetch;

    const result = await handler({}, ctx);

    expect(transcribeRec.calls, "transcription must not start without budget").toBe(0);
    expect(result.offset, "offset must stay before the deferred update").toBe(41);
    expect(savedOffsets().every((o) => o === "41"), `offset puts: ${savedOffsets()}`).toBe(true);
    expect(net.polls, "poll loop must stop so the next invocation takes over").toBe(1);
    expect(net.sent, "defer is silent — no user-facing message").toEqual([]);
  });

  it("rejects a note that could never fit any invocation, and advances the offset", async () => {
    const handler = await loadHandler("12345");
    seedOffset(49);
    const ctx = makeCtx(240_000); // 4-min function: a 500s note can NEVER fit
    const net = makeNet(ctx, { batches: [[voiceUpdate(50, 12345, 500)]], afterPoll: [200_000] });
    global.fetch = net.fetch;

    const result = await handler({}, ctx);

    expect(transcribeRec.calls, "transcription must not start for an unfittable note").toBe(0);
    expect(net.sent.length).toBe(1);
    expect(net.sent[0].chat_id).toBe(12345);
    expect(net.sent[0].text).toMatch(/too long to transcribe/);
    expect(result.offset, "rejected note must not be replayed").toBe(50);
    expect(savedOffsets()).toContain("50");
  });
});

// ─── Finding 2: fail-closed allowlist ────────────────────────────────────────

describe("empty ALLOWED_CHAT_IDS fails closed (TEAM-3493 finding 2)", () => {
  it("rejects a message from any chat when the allowlist is unset", async () => {
    const handler = await loadHandler(null);
    const ctx = makeCtx(900_000);
    const net = makeNet(ctx, {
      batches: [[{ update_id: 60, message: { chat: { id: 777 }, text: "hello there" } }]],
    });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(net.sent.length).toBe(1);
    expect(net.sent[0].chat_id).toBe(777);
    expect(net.sent[0].text).toMatch(/Not authorized/);
    expect(db.items.has("chat#777"), "chat must not be registered for gate pings").toBe(false);
    expect(db.items.has("buf#777"), "message must not be buffered for processing").toBe(false);
  });
});

// ─── Finding 3: gate-callback authorization ──────────────────────────────────

describe("gate callback authorization (TEAM-3493 finding 3)", () => {
  it("only an allowlisted chat's approval transitions the ticket; others are acked and ignored", async () => {
    const handler = await loadHandler("12345");
    const ctx = makeCtx(900_000);
    const net = makeNet(ctx, {
      batches: [[
        { update_id: 70, callback_query: { id: "cb-intruder", data: "gok|GATE-7|wf-7",
          message: { chat: { id: 999 }, message_id: 5, text: "gate ping" } } },
        { update_id: 71, callback_query: { id: "cb-owner", data: "gok|GATE-7|wf-7",
          message: { chat: { id: 12345 }, message_id: 6, text: "gate ping" } } },
      ]],
    });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(net.transitions.length, "exactly one transition — the allowlisted chat's").toBe(1);
    expect(net.transitions[0]).toMatchObject({ ticketId: "GATE-7", targetStatus: "done" });
    // Both taps are acked so Telegram stops re-sending the callback query.
    expect(net.answered.map((a) => a.callback_query_id).sort()).toEqual(["cb-intruder", "cb-owner"]);
    // Only the authorized chat's ping message is edited to "approved".
    expect(net.edited.length).toBe(1);
    expect(net.edited[0].chat_id).toBe(12345);
  });
});

// ─── Finding 4: gate claim released when nobody was pinged ───────────────────

const GATE_WORKFLOWS = [{
  workflowId: "wf-1",
  input: { title: "Test run" },
  humanNotifications: [{ type: "review_needed", acknowledged: false, ticketId: "GATE-1", reviewer: "me" }],
}];

describe("gate claim release on delivery failure (TEAM-3493 finding 4)", () => {
  it("releases the claim when every gate ping fails to send", async () => {
    const handler = await loadHandler("12345");
    db.items.set("chat#12345", { id: { S: "chat#12345" }, chatId: { N: "12345" } });
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { workflows: GATE_WORKFLOWS, sendFail: true });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(db.puts.some((p) => p.id.S === "gate#GATE-1"), "claim is taken before sending").toBe(true);
    expect(net.sent.length, "the ping was attempted").toBe(1);
    expect(db.deletes).toContain("gate#GATE-1");
    expect(db.items.has("gate#GATE-1"), "failed delivery must not hold the 30-day claim").toBe(false);
  });

  it("releases the claim when there are no registered chats to ping", async () => {
    const handler = await loadHandler("12345");
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { workflows: GATE_WORKFLOWS });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(db.puts.some((p) => p.id.S === "gate#GATE-1"), "claim is taken before the chat lookup").toBe(true);
    expect(db.deletes).toContain("gate#GATE-1");
    expect(db.items.has("gate#GATE-1"), "zero-chat scan must not hold the 30-day claim").toBe(false);
  });
});
