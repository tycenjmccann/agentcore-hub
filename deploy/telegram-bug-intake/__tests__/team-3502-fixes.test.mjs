/**
 * TEAM-3502 ship-review regression (round 4), driven through the exported
 * handler with the same module-seam mocks as team-3499-fixes.test.mjs:
 *
 * Non-gate callback actions bypassed ALLOWED_CHAT_IDS. Gate buttons
 * (gok|/gno|) were allowlist-checked inside handleGateCallback, and inbound
 * messages fail closed in routeMessage — but the repo-picker callbacks
 * (`pick|<id>|<idx>` / `cancel|<id>`) executed with NO auth check at all. A
 * chat REMOVED from ALLOWED_CHAT_IDS could still tap an old inline
 * repo-picker button and file a Jira Bug (kicking off a dev pipeline) or
 * cancel someone else's pending bug. Inline buttons outlive de-allowlisting,
 * so handleCallback must enforce the same fail-closed check as routeMessage:
 * a non-allowlisted chat gets its callback query answered (or Telegram
 * re-sends it forever) and NOTHING else — no fileTicket, no DDB delete, no
 * gate transition.
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
    if (u.endsWith("/tickets/transition")) { net.transitions.push(body); return jsonRes({}); }
    if (/\/api\/workflow\/[^/]+\/tickets$/.test(u)) return jsonRes({}, false, 404);
    if (u.includes("/api/workflow/artifacts")) return jsonRes({}, false, 404);
    if (u.endsWith("/api/workflow/start")) {
      net.workflowStarts.push(body);
      return jsonRes({ epicId: `EPIC-${net.workflowStarts.length}` });
    }
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
});

afterAll(() => {
  global.fetch = realFetch;
  for (const k of [...Object.keys(ENV), "ALLOWED_CHAT_IDS"]) delete process.env[k];
});

const cbUpdate = (updateId, chatId, data) => ({
  update_id: updateId,
  callback_query: {
    id: `cb-${updateId}`,
    data,
    message: { message_id: 7, chat: { id: chatId }, text: "Which repo?" },
  },
});

// A parked repo-picker bug, exactly as processBug writes it.
const PENDING_ID = "abc123def456";
const seedPending = () => db.items.set(PENDING_ID, {
  id: { S: PENDING_ID },
  bug: { S: JSON.stringify({ intent: "bug", title: "Broken button", description: "It broke.", repo: "", confidence: 0.4, severity: "normal" }) },
  fileIds: { S: "[]" },
  candidates: { S: JSON.stringify(["test-user/app", "test-user/other"]) },
});

// ─── Non-allowlisted chats: NO callback action of any kind may execute ───────

describe("callback auth fails closed for non-gate actions (TEAM-3502)", () => {
  it("pick| from a non-allowlisted chat files nothing and keeps the pending bug", async () => {
    const handler = await loadHandler("12345"); // 666 is NOT on the list
    seedPending();
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { batches: [[cbUpdate(201, 666, `pick|${PENDING_ID}|0`)]] });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(net.jiraIssues.length, "no Jira Bug may be filed for a revoked chat").toBe(0);
    expect(net.workflowStarts.length, "no dev pipeline may be started").toBe(0);
    expect(db.deletes, "the pending item must not be consumed").not.toContain(PENDING_ID);
    expect(db.items.has(PENDING_ID), "the pending bug must survive for its real owner").toBe(true);
    expect(net.answered.length, "the callback query must still be ACKed or Telegram re-sends it").toBe(1);
    expect(net.answered[0].callback_query_id).toBe("cb-201");
    expect(net.answered[0].text).toMatch(/not authorized/i);
    expect(net.edited.length, "the picker message must not be rewritten").toBe(0);
  });

  it("cancel| from a non-allowlisted chat does not delete the pending item", async () => {
    const handler = await loadHandler("12345");
    seedPending();
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { batches: [[cbUpdate(202, 666, `cancel|${PENDING_ID}`)]] });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(db.deletes, "a revoked chat must not cancel someone's pending bug").not.toContain(PENDING_ID);
    expect(db.items.has(PENDING_ID)).toBe(true);
    expect(net.answered.length).toBe(1);
    expect(net.answered[0].text).toMatch(/not authorized/i);
    expect(net.edited.length).toBe(0);
  });

  it("empty/unset allowlist authorizes nobody — pick| still refused (fail closed)", async () => {
    const handler = await loadHandler(null); // ALLOWED_CHAT_IDS unset
    seedPending();
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { batches: [[cbUpdate(203, 12345, `pick|${PENDING_ID}|0`)]] });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(net.jiraIssues.length).toBe(0);
    expect(db.items.has(PENDING_ID)).toBe(true);
    expect(net.answered.length).toBe(1);
    expect(net.answered[0].text).toMatch(/not authorized/i);
  });

  it("gate callback (gok|) from a non-allowlisted chat still transitions nothing", async () => {
    const handler = await loadHandler("12345");
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { batches: [[cbUpdate(204, 666, "gok|GATE-1|wf-1")]] });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(net.transitions.length, "no gate ticket transition for a revoked chat").toBe(0);
    expect(net.answered.length).toBe(1);
    expect(net.answered[0].text).toMatch(/not authorized/i);
    expect(net.edited.length, "the gate ping must not be rewritten").toBe(0);
  });
});

// ─── Allowlisted chats: pick/cancel behavior unchanged ───────────────────────

describe("allowlisted callback behavior is unchanged (TEAM-3502 guard)", () => {
  it("pick| files the ticket, consumes the pending item, and answers Filed", async () => {
    const handler = await loadHandler("12345");
    seedPending();
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { batches: [[cbUpdate(205, 12345, `pick|${PENDING_ID}|0`)]] });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(net.jiraIssues.length, "an allowlisted pick must still file the Jira Bug").toBe(1);
    expect(net.jiraIssues[0].fields.labels).toContain("repo:test-user/app");
    expect(db.deletes).toContain(PENDING_ID);
    expect(db.items.has(PENDING_ID)).toBe(false);
    expect(net.answered.length).toBe(1);
    expect(net.answered[0].text).toMatch(/Filed TEST-1/);
    expect(net.edited.length).toBe(1);
    expect(net.edited[0].text).toMatch(/pipeline started/);
  });

  it("cancel| deletes the pending item and answers Cancelled", async () => {
    const handler = await loadHandler("12345");
    seedPending();
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { batches: [[cbUpdate(206, 12345, `cancel|${PENDING_ID}`)]] });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(db.deletes).toContain(PENDING_ID);
    expect(db.items.has(PENDING_ID)).toBe(false);
    expect(net.jiraIssues.length).toBe(0);
    expect(net.answered.length).toBe(1);
    expect(net.answered[0].text).toMatch(/Cancelled/);
    expect(net.edited.length).toBe(1);
    expect(net.edited[0].text).toMatch(/Cancelled/);
  });
});
