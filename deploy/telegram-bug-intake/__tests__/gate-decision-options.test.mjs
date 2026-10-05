/**
 * TEAM-5322 F10 / FR-9 bridge half — a decision-bound gate is answered on Telegram
 * by picking one of the options its description DECLARES, and the pick travels as
 * a decision token signed for this ticket by this chat.
 *
 *  - ✅ (gok) on a bound gate swaps the keyboard for the options and transitions
 *    NOTHING — a bare approve is exactly the undeclared answer the twin refuses.
 *  - a `gdc|<opt>|<ticket>|<wf>` tap POSTs {decision, decisionToken}; the token
 *    verifies in the ticket twin's own copy of the contract.
 *  - callback_data never exceeds Telegram's 64 bytes (long options go by index).
 *
 * Same module-seam mocks as manager-escalation-ping.test.mjs.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { verifyDecisionToken } from "../../../lambda/agentcore-hub-tickets/decision-contract.mjs";

const TG_TOKEN = "111111:test-bot-token";
const HUB = "https://hub.example.invalid";
const KEY = "bridge-test-key-not-a-secret";
const CHAT = 12345;
const GATE = "TEAM-5278";
const WF = "wf_1791220686225_znl7a4";

const db = vi.hoisted(() => ({ items: new Map(), puts: [], deletes: [], updates: [] }));
vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send() { return { FailedEntryCount: 0 }; } },
  PutEventsCommand: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/client-dynamodb", async () => {
  const { applyUpdate } = await import("./helpers/ddb-fake.mjs");
  const cmd = (op) => class { constructor(input) { this.input = input; this.op = op; } };
  class DynamoDBClient {
    async send(c) {
      if (c.op === "get") return { Item: db.items.get(c.input.Key.id.S) };
      if (c.op === "put") { db.items.set(c.input.Item.id.S, c.input.Item); db.puts.push(c.input.Item); return {}; }
      if (c.op === "del") { db.deletes.push(c.input.Key.id.S); db.items.delete(c.input.Key.id.S); return {}; }
      if (c.op === "scan") {
        const p = c.input.ExpressionAttributeValues[":p"].S;
        return { Items: [...db.items.values()].filter((i) => i.id.S.startsWith(p)) };
      }
      if (c.op === "update") return applyUpdate(db, c.input);
      throw new Error(`unexpected ddb op ${c.op}`);
    }
  }
  return {
    DynamoDBClient, GetItemCommand: cmd("get"), PutItemCommand: cmd("put"), UpdateItemCommand: cmd("update"),
    DeleteItemCommand: cmd("del"), ScanCommand: cmd("scan"),
  };
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
  GetPipelineExecutionCommand: class { constructor(input) { this.input = input; } },
  PutApprovalResultCommand: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { async send() { const e = new Error("NoSuchKey"); e.name = "NoSuchKey"; throw e; } },
  GetObjectCommand: class { constructor(input) { this.input = input; } },
  PutObjectCommand: class { constructor(input) { this.input = input; } },
}));
// The key comes from the GATE_DECISION_KEY seam; a Secrets Manager read in this
// suite is a bug (it would reach real AWS).
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class { async send() { throw new Error("Secrets Manager must not be called here"); } },
  GetSecretValueCommand: class { constructor(input) { this.input = input; } },
}));

const jsonRes = (body, ok = true, status = 200) => ({
  ok, status, json: async () => body, text: async () => JSON.stringify(body),
});

const ESCALATION_OPTIONS = "continue | merge-with-known-findings | cancel";
const gateRow = (description, extra = {}) => ({
  ticketId: GATE, status: "in_review", assignee: "human:operator",
  title: "Escalation #1: ship-review not converging", labels: ["gate:blocker"], description, ...extra,
});

function makeNet(overrides = {}) {
  const net = {
    remainingMs: 100_000, polls: 0, batches: [], tickets: [],
    sent: [], answered: [], edited: [], transitions: [], cancels: [], transitionReply: {},
    ...overrides,
  };
  net.ctx = { getRemainingTimeInMillis: () => net.remainingMs };
  net.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : null;
    if (u === `${HUB}/api/workflow/list`) return jsonRes({ workflows: [] });
    if (u.endsWith("/tickets/transition")) { net.transitions.push(body); return jsonRes(net.transitionReply); }
    if (u.endsWith("/cancel")) { net.cancels.push({ url: u, body }); return jsonRes({}); }
    if (/\/api\/workflow\/[^/]+\/tickets$/.test(u)) return jsonRes({ tickets: net.tickets });
    if (u.includes("/api/workflow/artifacts")) return jsonRes({}, false, 404);
    if (u.endsWith("/getUpdates")) {
      const i = net.polls++;
      if (i >= net.batches.length) net.remainingMs = 20_000;
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

const tap = (updateId, data) => ({
  update_id: updateId,
  callback_query: { id: `cb-${updateId}`, data, message: { message_id: 7, chat: { id: CHAT }, text: "Gate ping" } },
});

const ENV = {
  TELEGRAM_BOT_TOKEN: TG_TOKEN, JIRA_SITE_URL: "example.atlassian.net", JIRA_EMAIL: "bot@example.com",
  JIRA_API_TOKEN: "test-jira-token", JIRA_PROJECT_KEY: "TEST", GITHUB_TOKEN: "test-github-token",
  GITHUB_USER: "test-user", PENDING_TABLE: "test-pending-table", HUB_API_URL: HUB, ALLOWED_CHAT_IDS: String(CHAT),
};

async function run(net, { key = KEY } = {}) {
  vi.resetModules();
  Object.assign(process.env, ENV);
  delete process.env.ARTIFACT_BUCKET;
  delete process.env.GATE_DECISION_SECRET_ID;
  if (key) process.env.GATE_DECISION_KEY = key;
  else delete process.env.GATE_DECISION_KEY;
  const { handler } = await import("../index.mjs");
  global.fetch = net.fetch;
  await handler({}, net.ctx);
  return net;
}

const realFetch = global.fetch;
beforeEach(() => { db.items.clear(); db.puts.length = 0; db.deletes.length = 0; db.updates.length = 0; });
afterAll(() => {
  global.fetch = realFetch;
  for (const k of [...Object.keys(ENV), "GATE_DECISION_KEY"]) delete process.env[k];
});

const buttonsOf = (edit) => (edit?.reply_markup?.inline_keyboard || []).flat();

describe("gok on a decision-bound gate", () => {
  it("shows the declared options as buttons and transitions nothing", async () => {
    const net = await run(makeNet({
      tickets: [gateRow(`Brief\nDECISION OPTIONS: ${ESCALATION_OPTIONS}`)],
      batches: [[tap(1, `gok|${GATE}|${WF}`)]],
    }));
    expect(net.transitions, "a bare ✅ is not a decision").toEqual([]);
    const edit = net.edited.at(-1);
    expect(edit.text).toContain(`This gate needs a decision: ${ESCALATION_OPTIONS}`);
    const data = buttonsOf(edit).map((b) => b.callback_data).filter(Boolean);
    expect(data).toEqual([
      `gdc|continue|${GATE}|${WF}`,
      `gdc|merge-with-known-findings|${GATE}|${WF}`,
      `gdc|cancel|${GATE}|${WF}`,
    ]);
    expect(buttonsOf(edit).some((b) => b.url?.startsWith(`${HUB}/workflow?id=`))).toBe(true);
  });

  it("an unbound gate still closes on ✅ exactly as before (no decision fields)", async () => {
    const net = await run(makeNet({
      tickets: [gateRow("Approve this gate to continue.", { title: "Code review" })],
      batches: [[tap(1, `gok|${GATE}|${WF}`)]],
    }));
    expect(net.transitions).toHaveLength(1);
    expect(net.transitions[0]).toEqual({ ticketId: GATE, targetStatus: "done", comment: `Approved via Telegram by chat ${CHAT}` });
    expect(net.edited.at(-1).text).toMatch(/Approved — pipeline resuming/);
  });
});

describe("gdc — a Telegram pick is a signed decision", () => {
  it("mints a token the ticket twin's copy verifies, and POSTs decision + decisionToken", async () => {
    const before = Date.now();
    const net = await run(makeNet({
      tickets: [gateRow(`DECISION OPTIONS: ${ESCALATION_OPTIONS}`)],
      batches: [[tap(1, `gdc|merge-with-known-findings|${GATE}|${WF}`)]],
    }));
    expect(net.transitions).toHaveLength(1);
    const body = net.transitions[0];
    expect(body).toMatchObject({ ticketId: GATE, targetStatus: "done", decision: "merge-with-known-findings" });
    expect(body.comment).toContain("DECISION: merge-with-known-findings");
    const verified = verifyDecisionToken(body.decisionToken, { ticketId: GATE, keys: [KEY], now: Date.now() });
    expect(verified).toMatchObject({
      ok: true, option: "merge-with-known-findings", override: true, channel: "telegram", by: `chat:${CHAT}`, workflowId: WF,
    });
    expect(verified.exp - verified.iat).toBeLessThanOrEqual(900);
    expect(verified.iat * 1000).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(verifyDecisionToken(body.decisionToken, { ticketId: "TEAM-1", keys: [KEY], now: Date.now() }).ok).toBe(false);
    expect(net.answered.at(-1).text).toBe("Recorded DECISION: merge-with-known-findings");
  });

  it("a pre-TEAM-5322 letter button still answers when its option is declared", async () => {
    const net = await run(makeNet({
      tickets: [gateRow(`DECISION OPTIONS: ${ESCALATION_OPTIONS}`)],
      batches: [[tap(1, `gdc|c|${GATE}|${WF}`)]],
    }));
    expect(net.transitions[0].decision).toBe("continue");
  });

  it("an option the gate does not declare is refused and nothing moves", async () => {
    const net = await run(makeNet({
      tickets: [gateRow("DECISION OPTIONS: approve | approve-with-known-findings")],
      batches: [[tap(1, `gdc|cancel|${GATE}|${WF}`)]],
    }));
    expect(net.transitions).toEqual([]);
    expect(net.cancels).toEqual([]);
    expect(net.answered.at(-1).text).toMatch(/Not an option on this gate/);
  });

  it("no readable key on a bound gate → nothing moves, the human is sent to the console", async () => {
    const net = await run(makeNet({
      tickets: [gateRow(`DECISION OPTIONS: ${ESCALATION_OPTIONS}`)],
      batches: [[tap(1, `gdc|continue|${GATE}|${WF}`)]],
    }), { key: null });
    expect(net.transitions).toEqual([]);
    expect(net.answered.at(-1).text).toMatch(/decide from the hub console/);
  });

  it("cancel still cancels the run after the signed close", async () => {
    const net = await run(makeNet({
      tickets: [gateRow(`DECISION OPTIONS: ${ESCALATION_OPTIONS}`)],
      batches: [[tap(1, `gdc|cancel|${GATE}|${WF}`)]],
    }));
    expect(net.transitions[0].decision).toBe("cancel");
    expect(net.cancels).toHaveLength(1);
    expect(net.cancels[0].url).toBe(`${HUB}/api/workflow/${WF}/cancel`);
    expect(net.edited.at(-1).text).toMatch(/Workflow cancelled/);
  });
});

describe("callback_data never exceeds Telegram's 64 bytes", () => {
  it("every rendered button fits, long options fall back to an index that still resolves", async () => {
    const longOpt = "proceed-without-live-verification-and-log";
    const options = `access-granted | ${longOpt.slice(0, 40)} | abort`;
    const net = await run(makeNet({
      tickets: [gateRow(`DECISION OPTIONS: ${options}`)],
      batches: [[tap(1, `gok|${GATE}|${WF}`)]],
    }));
    const data = buttonsOf(net.edited.at(-1)).map((b) => b.callback_data).filter(Boolean);
    expect(data).toHaveLength(3);
    for (const d of data) expect(Buffer.byteLength(d, "utf8")).toBeLessThanOrEqual(64);
    expect(data[1]).toBe(`gdc|#1|${GATE}|${WF}`);

    const net2 = await run(makeNet({
      tickets: [gateRow(`DECISION OPTIONS: ${options}`)],
      batches: [[tap(2, data[1])]],
    }));
    expect(net2.transitions[0].decision).toBe(longOpt.slice(0, 40));
  });
});
