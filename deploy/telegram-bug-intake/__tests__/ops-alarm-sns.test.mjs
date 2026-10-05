/**
 * The ops-alarm topic (TEAM-5321): the pipeline stack's agentcore-hub-ops-alarms
 * SNS topic invokes this Lambda directly. An SNS record is relayed to every
 * allowed chat as plain text and the invocation returns — no long poll, no
 * tg#offset read or write (a concurrent poller owns the offset). A non-SNS
 * event still runs the poll loop.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TG_TOKEN = "111111:test-bot-token";
const HUB = "https://hub.example.invalid";

const db = vi.hoisted(() => ({ items: new Map(), puts: [], deletes: [], updates: [], gets: [] }));
// Publishing gate.requested (TEAM-4453 D3) is best-effort in index.mjs, so an
// unmocked EventBridge does not fail a test — it silently reaches real AWS and
// logs the AccessDenied. Stubbed here to keep this suite hermetic; the event
// itself is asserted in gate-working-hours.test.mjs.
vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send() { return { FailedEntryCount: 0 }; } },
  PutEventsCommand: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/client-dynamodb", async () => {
  // TEAM-4663: the handler now UPDATES claim rows (two-phase claim). One
  // shared evaluator, because a fake that replaces instead of merging would
  // hide a real regression — see helpers/ddb-fake.mjs.
  const { applyUpdate } = await import("./helpers/ddb-fake.mjs");
  const cmd = (op) => class { constructor(input) { this.input = input; this.op = op; } };
  class DynamoDBClient {
    async send(c) {
      if (c.op === "get") { db.gets.push(c.input.Key.id.S); return { Item: db.items.get(c.input.Key.id.S) }; }
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
      if (c.op === "del") { db.deletes.push(c.input.Key.id.S); db.items.delete(c.input.Key.id.S); return {}; }
      if (c.op === "scan") {
        const p = c.input.ExpressionAttributeValues[":p"].S;
        return { Items: [...db.items.values()].filter((i) => i.id.S.startsWith(p)) };
      }
      if (c.op === "update") return applyUpdate(db, c.input);
      throw new Error(`unexpected ddb op ${c.op}`);
    }
  }
  return { DynamoDBClient, GetItemCommand: cmd("get"), PutItemCommand: cmd("put"), UpdateItemCommand: cmd("update"), DeleteItemCommand: cmd("del"), ScanCommand: cmd("scan") };
});
vi.mock("@aws-sdk/client-transcribe-streaming", () => ({
  StartStreamTranscriptionCommand: class { constructor(input) { this.input = input; } },
  TranscribeStreamingClient: class { async send() { return { TranscriptResultStream: (async function* () {})() }; } },
}));
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: class { async send() { throw new Error("bedrock must not be called"); } },
  ConverseCommand: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { async send() { const e = new Error("NoSuchKey"); e.name = "NoSuchKey"; throw e; } },
  GetObjectCommand: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/client-codepipeline", () => ({
  CodePipelineClient: class { async send() { throw new Error("codepipeline must not be called"); } },
  GetPipelineStateCommand: class { constructor(input) { this.input = input; } },
  GetPipelineExecutionCommand: class { constructor(input) { this.input = input; } },
  PutApprovalResultCommand: class { constructor(input) { this.input = input; } },
}));

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });

function makeNet(ctx, workflows) {
  const net = { ctx, workflows, sent: [] };
  net.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : null;
    if (u === `${HUB}/api/workflow/list`) return jsonRes({ workflows: net.workflows });
    if (/\/api\/workflow\/[^/]+\/tickets$/.test(u)) return jsonRes({}, false, 404);
    if (u.endsWith("/getUpdates")) { net.polled = true; net.ctx.remainingMs = 20_000; return jsonRes({ ok: true, result: [] }); }
    if (u.endsWith("/sendMessage")) { net.sent.push(body); return jsonRes({ ok: true, result: {} }); }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return net;
}
const makeCtx = () => ({ remainingMs: 100_000, getRemainingTimeInMillis() { return this.remainingMs; } });

const ENV = {
  TELEGRAM_BOT_TOKEN: TG_TOKEN, JIRA_SITE_URL: "example.atlassian.net", JIRA_EMAIL: "bot@example.com",
  JIRA_API_TOKEN: "t", JIRA_PROJECT_KEY: "TEST", GITHUB_TOKEN: "t", GITHUB_USER: "test-user",
  PENDING_TABLE: "test-pending-table", HUB_API_URL: HUB, ALLOWED_CHAT_IDS: "12345,67890",
};
async function loadHandler() {
  vi.resetModules();
  Object.assign(process.env, ENV);
  delete process.env.ARTIFACT_BUCKET;
  delete process.env.DEPLOY_PIPELINE_NAME;
  return (await import("../index.mjs")).handler;
}
const realFetch = global.fetch;
beforeEach(() => { db.items.clear(); db.puts.length = 0; db.gets.length = 0; db.deletes.length = 0; db.updates.length = 0;
  db.items.set("chat#12345", { id: { S: "chat#12345" }, chatId: { N: "12345" } }); });
afterAll(() => { global.fetch = realFetch; for (const k of Object.keys(ENV)) delete process.env[k]; });

const alarmEvent = (message, subject = "ALARM") => ({
  Records: [{ EventSource: "aws:sns", Sns: { Subject: subject, Message: message } }],
});

async function invoke(handler, event) {
  const ctx = makeCtx();
  const net = makeNet(ctx, []);
  global.fetch = net.fetch;
  const result = await handler(event, ctx);
  return { net, result };
}

describe("ops-alarm SNS records", () => {
  it("relays the alarm to every allowed chat in plain text, without polling", async () => {
    const handler = await loadHandler();
    const msg = JSON.stringify({
      AlarmName: "agentcore-hub-tickets-errors",
      NewStateValue: "ALARM",
      NewStateReason: "Threshold Crossed: 2 out of the last 5 datapoints [3.0 (05/10/26 12:00:00)] > 0.0",
    });
    const { net, result } = await invoke(handler, alarmEvent(msg));
    expect(result).toEqual({ done: "ops-alarm", delivered: 2 });
    expect(net.sent.map((m) => String(m.chat_id))).toEqual(["12345", "67890"]);
    for (const m of net.sent) {
      expect(m.text).toContain("agentcore-hub-tickets-errors");
      expect(m.text).toContain("ALARM");
      expect(m.text).toContain("Threshold Crossed");
      expect(m.parse_mode).toBeUndefined();
    }
    expect(net.polled).toBeUndefined();
    expect(db.gets).not.toContain("tg#offset");
    expect(db.puts.map((i) => i.id.S)).not.toContain("tg#offset");
  });

  it("a non-JSON message is relayed raw", async () => {
    const handler = await loadHandler();
    const { net } = await invoke(handler, alarmEvent("plain text alarm", "Ops test"));
    expect(net.sent).toHaveLength(2);
    expect(net.sent[0].text).toContain("Ops test");
    expect(net.sent[0].text).toContain("plain text alarm");
  });

  it("a non-SNS event still runs the poll loop", async () => {
    const handler = await loadHandler();
    const { net } = await invoke(handler, {});
    expect(net.polled).toBe(true);
    expect(db.gets).toContain("tg#offset");
  });
});
