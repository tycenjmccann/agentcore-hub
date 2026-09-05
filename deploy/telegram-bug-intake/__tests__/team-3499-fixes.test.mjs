/**
 * TEAM-3499 ship-review regressions, driven through the exported handler with
 * the same module-seam mocks as ship-review-fixes.test.mjs:
 *
 *  1. DynamoDB Scan pagination: Scan returns at most 1MB per page; rows past
 *     the first page are only reachable via LastEvaluatedKey/ExclusiveStartKey.
 *     The chat registry (listChats → gate pings) and the persisted chat
 *     buffers (loadBuffers → flush) must see EVERY page: an allowlisted
 *     reviewer whose chat# row lands on page 2 must still be pinged (and if
 *     page 1 holds no allowlisted chat, the claim must NOT be released as
 *     "nobody to notify"), and a buf# row on page 2 must still be flushed.
 *     The fake DynamoDB serves scans in 1-item pages with LastEvaluatedKey,
 *     honoring ExclusiveStartKey — the assertions are on the OUTCOMES (ping
 *     delivered, buffer flushed), not on how the pages are walked.
 *
 *  2. getFile dedup for no-duration voice notes: the pre-flight size lookup
 *     (TEAM-3495) already calls getFile; transcribeVoice must reuse that
 *     result instead of calling getFile again — a transient failure of the
 *     second call would drop a note that already passed the budget check
 *     (generic failure, offset advanced), and every no-duration note doubled
 *     Telegram API load. Invariant: exactly ONE getFile across the full
 *     processing path. Duration-present notes never had a pre-flight lookup
 *     and must behave exactly as before (transcribeVoice fetches lazily).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TG_TOKEN = "111111:test-bot-token";
const HUB = "https://hub.example.invalid";

// ─── AWS SDK mocks (hoisted, shared state) ───────────────────────────────────

// db.scanPageSize (when set) makes every Scan paginate: pages of N items with
// LastEvaluatedKey, resumed via ExclusiveStartKey — like a >1MB real table.
const db = vi.hoisted(() => ({ items: new Map(), puts: [], deletes: [], scanPageSize: 0 }));
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
        const matches = [...db.items.values()].filter((i) => i.id.S.startsWith(p));
        if (!db.scanPageSize) return { Items: matches };
        const start = c.input.ExclusiveStartKey
          ? matches.findIndex((i) => i.id.S === c.input.ExclusiveStartKey.id.S) + 1
          : 0;
        const page = matches.slice(start, start + db.scanPageSize);
        const out = { Items: page };
        if (start + db.scanPageSize < matches.length && page.length) {
          out.LastEvaluatedKey = { id: page[page.length - 1].id };
        }
        return out;
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
  // yields no transcript — the voice path still completes end-to-end.
  TranscribeStreamingClient: class {
    async send() {
      transcribeRec.calls++;
      return { TranscriptResultStream: (async function* () {})() };
    }
  },
}));

// Returns a confident, valid-repo bug so a flushed buffer files a ticket —
// the buffer-pagination test asserts the user-visible outcome of the flush.
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: class {
    async send() {
      return { output: { message: { content: [{ toolUse: { input: {
        intent: "bug", title: "Buffered bug", description: "It broke.",
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
 * net.getFileCalls counts Telegram getFile requests (finding 2's invariant).
 */
function makeNet(ctx, overrides = {}) {
  const net = {
    ctx, polls: 0, batches: [], afterPoll: [],
    workflows: [], getFileSize: undefined, getFileCalls: 0,
    sent: [], answered: [], edited: [], transitions: [], jiraIssues: [],
    ...overrides,
  };
  net.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : null;
    if (u === `${HUB}/api/workflow/list`) return jsonRes({ workflows: net.workflows });
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
    if (u.endsWith("/getFile")) {
      net.getFileCalls++;
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
  db.scanPageSize = 0;
  transcribeRec.calls = 0;
});

afterAll(() => {
  global.fetch = realFetch;
  for (const k of [...Object.keys(ENV), "ALLOWED_CHAT_IDS"]) delete process.env[k];
});

const registerChat = (id) => db.items.set(`chat#${id}`, { id: { S: `chat#${id}` }, chatId: { N: String(id) } });
const seedBuffer = (chatId, text) => {
  // Both deadlines already past → the buffer is settled and flushes at once.
  const b = { chatId, parts: [{ text, fileId: null }], firstAt: Date.now() - 300_000, lastAt: Date.now() - 300_000 };
  db.items.set(`buf#${chatId}`, { id: { S: `buf#${chatId}` }, buffer: { S: JSON.stringify(b) } });
};

const voiceUpdate = (updateId, chatId, voice) => ({
  update_id: updateId,
  message: { chat: { id: chatId }, voice: { file_id: "VOICE_1", ...voice } },
});

const GATE_WORKFLOWS = [{
  workflowId: "wf-1",
  input: { title: "Test run" },
  humanNotifications: [{ type: "review_needed", acknowledged: false, ticketId: "GATE-1", reviewer: "me" }],
}];

// ─── Finding 1: DynamoDB Scan helpers must follow LastEvaluatedKey ───────────

describe("DynamoDB scans read every page (TEAM-3499 finding 1)", () => {
  it("pings an allowlisted chat whose registry row is on page 2, keeping the claim", async () => {
    const handler = await loadHandler("12345");
    registerChat(999);   // page 1 — registered but NOT allowlisted
    registerChat(12345); // page 2 — the actual reviewer
    db.scanPageSize = 1;
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { workflows: GATE_WORKFLOWS });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(net.sent.length, "the page-2 reviewer must receive the gate ping").toBe(1);
    expect(net.sent[0].chat_id).toBe(12345);
    expect(net.sent[0].text).toMatch(/review gate/i);
    expect(db.deletes, "a delivered ping must keep the dedupe claim").not.toContain("gate#GATE-1");
    expect(db.items.has("gate#GATE-1")).toBe(true);
  });

  it("loads and flushes a persisted buffer whose row is on page 2", async () => {
    const handler = await loadHandler("111,222");
    seedBuffer(111, "page-1 report: button is broken");
    seedBuffer(222, "page-2 report: page crashes on load");
    db.scanPageSize = 1;
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, {});
    global.fetch = net.fetch;

    const result = await handler({}, ctx);

    const confirmed = net.sent.filter((m) => /pipeline started/.test(m.text)).map((m) => m.chat_id);
    expect(confirmed, "both buffered chats — including page 2's — must get their ticket").toContain(222);
    expect(confirmed).toContain(111);
    expect(db.items.has("buf#222"), "the page-2 buffer must be consumed, not stranded").toBe(false);
    expect(result.buffered, "no buffer may be left behind after the flush").toBe(0);
  });
});

// ─── Finding 2: ONE getFile per no-duration voice note ───────────────────────

describe("no-duration voice notes call getFile once (TEAM-3499 finding 2)", () => {
  it("reuses the pre-flight metadata — exactly one getFile across the whole path", async () => {
    const handler = await loadHandler("12345");
    const ctx = makeCtx(900_000);
    const net = makeNet(ctx, {
      // No duration, no inline file_size → the budget check needs getFile.
      // 100 KB at the 4000 B/s fallback ≈ 25s paced — fits comfortably.
      batches: [[voiceUpdate(101, 12345, {})]],
      afterPoll: [200_000],
      getFileSize: 100_000,
    });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(transcribeRec.calls, "the note must actually be transcribed").toBe(1);
    expect(net.getFileCalls,
      "one metadata lookup must feed both the budget check and the download — " +
      "a second call can transiently fail and drop a processable note").toBe(1);
    // The path ran to completion (mock yields no transcript → the echo-empty reply).
    expect(net.sent.length).toBe(1);
    expect(net.sent[0].text).toMatch(/Couldn't make out any speech/);
  });

  it("leaves the duration-present path unchanged — transcribeVoice fetches lazily", async () => {
    const handler = await loadHandler("12345");
    const ctx = makeCtx(900_000);
    const net = makeNet(ctx, {
      batches: [[voiceUpdate(102, 12345, { duration: 5 })]],
      afterPoll: [200_000],
    });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(transcribeRec.calls).toBe(1);
    expect(net.getFileCalls, "no pre-flight lookup happens with a duration — still one getFile").toBe(1);
    expect(net.sent.length).toBe(1);
    expect(net.sent[0].text).toMatch(/Couldn't make out any speech/);
  });
});
