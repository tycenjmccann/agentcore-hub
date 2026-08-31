/**
 * TEAM-3495 ship re-review regressions — the two P1 behaviours, driven through
 * the exported handler with the same module-seam mocks as
 * ship-review-fixes.test.mjs:
 *
 *  1. Gate-ping allowlist: the chat registry (chat#<id> rows) is historical —
 *     a chat de-allowlisted from ALLOWED_CHAT_IDS keeps its registration
 *     forever. Gate pings must go ONLY to allowlisted chats: a send to a
 *     revoked chat leaks workflow titles/Jira links AND counts toward
 *     `delivered`, which suppresses the releaseGate() retry path for the
 *     reviewers who never got pinged. If no allowlisted recipient was
 *     reached, the claim must be released so a later scan retries.
 *
 *  2. No-duration voice budget: Telegram can omit/zero msg.voice.duration.
 *     transcribeVoice() then paces by FILE SIZE (~4000 B/s fallback), so the
 *     pre-flight budget must estimate from the same byte rate. A zero
 *     duration collapses the estimate to overhead only, letting a huge note
 *     pass the check and die mid-paced-stream before saveOffset → Telegram
 *     redelivery loop. Invariant: paced streaming never starts unless its
 *     worst-case wall clock fits the remaining budget; an unbudgetable note
 *     is rejected with the offset advanced (never replayed).
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
 * net.getFileSize, when set, is returned as file_size from getFile.
 */
function makeNet(ctx, overrides = {}) {
  const net = {
    ctx, polls: 0, batches: [], afterPoll: [],
    workflows: [], getFileSize: undefined,
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
    if (u.endsWith("/sendMessage")) { net.sent.push(body); return jsonRes({ ok: true, result: {} }); }
    if (u.endsWith("/answerCallbackQuery")) { net.answered.push(body); return jsonRes({ ok: true, result: true }); }
    if (u.endsWith("/editMessageText")) { net.edited.push(body); return jsonRes({ ok: true, result: {} }); }
    if (u.endsWith("/sendChatAction")) return jsonRes({ ok: true, result: true });
    if (u.endsWith("/getFile")) {
      return jsonRes({ ok: true, result: { file_path: "voice/x.oga", ...(net.getFileSize != null ? { file_size: net.getFileSize } : {}) } });
    }
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
const registerChat = (id) => db.items.set(`chat#${id}`, { id: { S: `chat#${id}` }, chatId: { N: String(id) } });

const voiceUpdate = (updateId, chatId, voice) => ({
  update_id: updateId,
  message: { chat: { id: chatId }, voice: { file_id: "VOICE_1", ...voice } },
});

const GATE_WORKFLOWS = [{
  workflowId: "wf-1",
  input: { title: "Secret internal run" },
  humanNotifications: [{ type: "review_needed", acknowledged: false, ticketId: "GATE-1", reviewer: "me" }],
}];

// ─── Finding 1: gate pings must respect ALLOWED_CHAT_IDS ─────────────────────

describe("gate pings respect ALLOWED_CHAT_IDS (TEAM-3495 finding 1)", () => {
  it("never pings a registered-but-not-allowlisted chat, and releases the claim", async () => {
    const handler = await loadHandler("12345");
    registerChat(999); // in the registry, NOT in the allowlist
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { workflows: GATE_WORKFLOWS });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(net.sent, "no gate content may reach a non-allowlisted chat").toEqual([]);
    expect(db.puts.some((p) => p.id.S === "gate#GATE-1"), "claim is taken before the chat lookup").toBe(true);
    expect(db.deletes).toContain("gate#GATE-1");
    expect(db.items.has("gate#GATE-1"),
      "delivered must stay 0 with no allowlisted recipient → claim released so a later scan retries").toBe(false);
  });

  it("still pings the allowlisted registered chat (and only it) and keeps the claim", async () => {
    const handler = await loadHandler("12345");
    registerChat(12345); // allowlisted
    registerChat(999);   // registered but revoked
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { workflows: GATE_WORKFLOWS });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(net.sent.length, "exactly one ping — the allowlisted chat's").toBe(1);
    expect(net.sent[0].chat_id).toBe(12345);
    expect(net.sent[0].text).toMatch(/Review gate/);
    expect(db.deletes).not.toContain("gate#GATE-1");
    expect(db.items.has("gate#GATE-1"), "a delivered ping holds the dedupe claim").toBe(true);
  });
});

// ─── Finding 2: no-duration voice notes must be budgeted by file size ────────

describe("no-duration voice notes are budgeted by file size (TEAM-3495 finding 2)", () => {
  it("rejects a zero-duration LARGE note without ever starting Transcribe, and advances the offset", async () => {
    const handler = await loadHandler("12345");
    seedOffset(80);
    const ctx = makeCtx(240_000); // 4-min function: a ~500s-equivalent file can NEVER fit
    const net = makeNet(ctx, {
      // duration 0 + 2 MB file → ~500s of paced delivery at the 4000 B/s fallback.
      batches: [[voiceUpdate(81, 12345, { duration: 0, file_size: 2_000_000 })]],
      afterPoll: [200_000],
    });
    global.fetch = net.fetch;

    const result = await handler({}, ctx);

    expect(transcribeRec.calls, "paced streaming must never start when worst-case doesn't fit").toBe(0);
    expect(net.sent.length).toBe(1);
    expect(net.sent[0].chat_id).toBe(12345);
    expect(net.sent[0].text).toMatch(/too long to transcribe/);
    expect(result.offset, "rejected note must not be replayed").toBe(81);
    expect(savedOffsets()).toContain("81");
  });

  it("defers a missing-duration note (size via getFile) that fits a fresh invocation but not this one", async () => {
    const handler = await loadHandler("12345");
    seedOffset(90);
    const ctx = makeCtx(900_000); // 15-min function, observed fresh at entry
    const net = makeNet(ctx, {
      // No duration, no inline file_size; getFile reports 400 KB → ~100s paced
      // delivery. After the poll only ~100s remain → cannot finish here.
      batches: [[voiceUpdate(91, 12345, {})]],
      afterPoll: [100_000],
      getFileSize: 400_000,
    });
    global.fetch = net.fetch;

    const result = await handler({}, ctx);

    expect(transcribeRec.calls, "paced streaming must never start without budget").toBe(0);
    expect(result.offset, "offset must stay before the deferred update").toBe(90);
    expect(savedOffsets().every((o) => o === "90"), `offset puts: ${savedOffsets()}`).toBe(true);
    expect(net.polls, "poll loop must stop so the next invocation takes over").toBe(1);
    expect(net.sent, "defer is silent — no user-facing message").toEqual([]);
  });

  it("rejects a note with no usable duration OR size, advancing the offset so it is never replayed", async () => {
    const handler = await loadHandler("12345");
    seedOffset(95);
    const ctx = makeCtx(900_000);
    const net = makeNet(ctx, {
      batches: [[voiceUpdate(96, 12345, {})]], // no duration; getFile has no file_size either
    });
    global.fetch = net.fetch;

    const result = await handler({}, ctx);

    expect(transcribeRec.calls, "an unbudgetable note must never reach Transcribe").toBe(0);
    expect(net.sent.length).toBe(1);
    expect(net.sent[0].chat_id).toBe(12345);
    expect(result.offset, "unbudgetable note must not be replayed").toBe(96);
    expect(savedOffsets()).toContain("96");
  });
});
