/**
 * TEAM-5322 F9 — an ops alarm delivered over SNS is relayed to Telegram as plain
 * text: alarm name, state and reason ONLY. The raw SNS message carries the account
 * id, the alarm ARN and the metric dimensions, and Telegram is off-account, so:
 *  - only OPS_ALARM_TOPIC_ARN is trusted (anything else, or the env unset, is dropped);
 *  - every ARN and 12-digit id is scrubbed from what is sent;
 *  - the branch returns BEFORE loadOffset — an alarm invoke never touches the
 *    poller's offset, never long-polls, never runs a gate scan.
 *
 * Same module-seam mocks as manager-escalation-ping.test.mjs.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const HUB = "https://hub.example.invalid";
const TOPIC = "arn:aws:sns:us-east-1:123456789012:agentcore-hub-ops-alarms";

const db = vi.hoisted(() => ({ items: new Map(), puts: [], deletes: [], updates: [], ops: [] }));
vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send() { return { FailedEntryCount: 0 }; } },
  PutEventsCommand: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/client-dynamodb", async () => {
  const { applyUpdate } = await import("./helpers/ddb-fake.mjs");
  const cmd = (op) => class { constructor(input) { this.input = input; this.op = op; } };
  class DynamoDBClient {
    async send(c) {
      db.ops.push(c.op);
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

const ENV = {
  TELEGRAM_BOT_TOKEN: "111111:test-bot-token", JIRA_SITE_URL: "example.atlassian.net", JIRA_EMAIL: "bot@example.com",
  JIRA_API_TOKEN: "test-jira-token", JIRA_PROJECT_KEY: "TEST", GITHUB_TOKEN: "test-github-token",
  GITHUB_USER: "test-user", PENDING_TABLE: "test-pending-table", HUB_API_URL: HUB, ALLOWED_CHAT_IDS: "12345,67890",
};

const ALARM = {
  AlarmName: "agentcore-hub-orchestrator-errors",
  AlarmArn: "arn:aws:cloudwatch:us-east-1:123456789012:alarm:agentcore-hub-orchestrator-errors",
  AWSAccountId: "123456789012",
  NewStateValue: "ALARM",
  NewStateReason:
    "Threshold Crossed: 1 datapoint [3.0] for arn:aws:lambda:us-east-1:123456789012:function:agentcore-hub-orchestrator was >= 1.0 (account 123456789012).",
  Trigger: { MetricName: "Errors", Dimensions: [{ name: "FunctionName", value: "agentcore-hub-orchestrator" }] },
};
const snsEvent = (topicArn = TOPIC, message = JSON.stringify(ALARM)) => ({
  Records: [{ EventSource: "aws:sns", Sns: { TopicArn: topicArn, Subject: "ALARM: orchestrator errors", Message: message } }],
});

async function run(event, { topic = TOPIC } = {}) {
  vi.resetModules();
  Object.assign(process.env, ENV);
  delete process.env.ARTIFACT_BUCKET;
  if (topic) process.env.OPS_ALARM_TOPIC_ARN = topic;
  else delete process.env.OPS_ALARM_TOPIC_ARN;
  const net = { urls: [], sent: [] };
  global.fetch = async (url, opts) => {
    const u = String(url);
    net.urls.push(u);
    if (u.endsWith("/sendMessage")) {
      net.sent.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  const { handler } = await import("../index.mjs");
  const ctx = { getRemainingTimeInMillis: () => { throw new Error("the poll path must not run"); } };
  const result = await handler(event, ctx);
  return { net, result };
}

const realFetch = global.fetch;
beforeEach(() => { db.items.clear(); db.ops.length = 0; });
afterAll(() => {
  global.fetch = realFetch;
  for (const k of [...Object.keys(ENV), "OPS_ALARM_TOPIC_ARN"]) delete process.env[k];
});

describe("SNS ops alarm branch", () => {
  it("posts plain text with name/state/reason only to every allowlisted chat, and returns before loadOffset", async () => {
    const { net, result } = await run(snsEvent());
    expect(result).toEqual({ ok: true, delivered: 2 });
    expect(net.sent.map((m) => m.chat_id)).toEqual(["12345", "67890"]);
    for (const m of net.sent) {
      expect(m.parse_mode, "plain text: an alarm reason is not Markdown").toBeUndefined();
      expect(m.reply_markup).toBeUndefined();
      expect(m.text).toMatch(/^🚨 Ops alarm: agentcore-hub-orchestrator-errors\nState: ALARM\nReason: Threshold Crossed/);
      expect(m.text).not.toMatch(/Dimensions|FunctionName|MetricName|AlarmArn|AWSAccountId/);
    }
    expect(db.ops, "no offset read, no buffer scan, no claim rows").toEqual([]);
    expect(net.urls.every((u) => u.endsWith("/sendMessage")), "no getUpdates, no hub scan").toBe(true);
  });

  it("no account id or ARN survives into the message", async () => {
    const { net } = await run(snsEvent());
    const text = net.sent[0].text;
    expect(text).not.toMatch(/arn:aws/i);
    expect(text).not.toMatch(/\d{12}/);
    expect(text).toContain("[arn]");
    expect(text).toContain("[account]");
  });

  it("a record from any other topic is dropped", async () => {
    const { net, result } = await run(snsEvent("arn:aws:sns:us-east-1:999999999999:someone-elses-topic"));
    expect(result).toEqual({ ok: true, delivered: 0 });
    expect(net.sent).toEqual([]);
    expect(db.ops).toEqual([]);
  });

  it("OPS_ALARM_TOPIC_ARN unset → every SNS record is dropped", async () => {
    const { net, result } = await run(snsEvent(), { topic: null });
    expect(result).toEqual({ ok: true, delivered: 0 });
    expect(net.sent).toEqual([]);
  });

  it("a non-JSON message relays the scrubbed subject, never the raw body", async () => {
    const { net } = await run(snsEvent(TOPIC, "raw text with arn:aws:iam::123456789012:role/x inside"));
    expect(net.sent[0].text).toBe("🚨 Ops alarm: ALARM: orchestrator errors\nState: UNKNOWN");
  });
});
