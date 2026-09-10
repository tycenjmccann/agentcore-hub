/**
 * Review-gate pings dedupe per REVIEW CYCLE, not per ticket.
 *
 * The orchestrator acks a gate's review_needed when the review concludes and
 * appends a fresh notification (new notif.id = notif_<ticket>_<ISO>) when the
 * same gate is re-parked after rework. The bridge used to claim gate#<ticketId>
 * for 30 days, so the first cycle pinged and every later cycle of that gate
 * was silently skipped — the TEAM-4343 Merge Approval that had to be approved
 * from the UI. Invariants:
 *
 *  1. Two notifications for the same gate with different ids → two pings, two
 *     claims keyed on the notification id.
 *  2. The same notification seen on two scans → one ping (claim holds).
 *  3. A notification without an id (older runs) still dedupes on the ticket.
 *  4. Unacknowledged review_needed rows on runs in a terminal phase (legacy
 *     runs pre-date the approve-time ack) are never pinged and never claimed.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TG_TOKEN = "111111:test-bot-token";
const HUB = "https://hub.example.invalid";

const db = vi.hoisted(() => ({ items: new Map(), puts: [], deletes: [] }));
vi.mock("@aws-sdk/client-dynamodb", () => {
  const cmd = (op) => class { constructor(input) { this.input = input; this.op = op; } };
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
      if (c.op === "del") { db.deletes.push(c.input.Key.id.S); db.items.delete(c.input.Key.id.S); return {}; }
      if (c.op === "scan") {
        const p = c.input.ExpressionAttributeValues[":p"].S;
        return { Items: [...db.items.values()].filter((i) => i.id.S.startsWith(p)) };
      }
      throw new Error(`unexpected ddb op ${c.op}`);
    }
  }
  return { DynamoDBClient, GetItemCommand: cmd("get"), PutItemCommand: cmd("put"), DeleteItemCommand: cmd("del"), ScanCommand: cmd("scan") };
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
    if (u.endsWith("/getUpdates")) { net.ctx.remainingMs = 20_000; return jsonRes({ ok: true, result: [] }); }
    if (u.endsWith("/sendMessage")) { net.sent.push(body); return jsonRes({ ok: true, result: {} }); }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return net;
}
const makeCtx = () => ({ remainingMs: 100_000, getRemainingTimeInMillis() { return this.remainingMs; } });

const ENV = {
  TELEGRAM_BOT_TOKEN: TG_TOKEN, JIRA_SITE_URL: "example.atlassian.net", JIRA_EMAIL: "bot@example.com",
  JIRA_API_TOKEN: "t", JIRA_PROJECT_KEY: "TEST", GITHUB_TOKEN: "t", GITHUB_USER: "test-user",
  PENDING_TABLE: "test-pending-table", HUB_API_URL: HUB, ALLOWED_CHAT_IDS: "12345",
};
async function loadHandler() {
  vi.resetModules();
  Object.assign(process.env, ENV);
  delete process.env.ARTIFACT_BUCKET;
  delete process.env.DEPLOY_PIPELINE_NAME;
  return (await import("../index.mjs")).handler;
}
const realFetch = global.fetch;
beforeEach(() => { db.items.clear(); db.puts.length = 0; db.deletes.length = 0;
  db.items.set("chat#12345", { id: { S: "chat#12345" }, chatId: { N: "12345" } }); });
afterAll(() => { global.fetch = realFetch; for (const k of Object.keys(ENV)) delete process.env[k]; });

const notif = (ticketId, id) => ({ type: "review_needed", acknowledged: false, ticketId, reviewer: "engineer", ...(id ? { id } : {}) });
const wf = (humanNotifications, phase = "ship") => ({ workflowId: "wf-1", phase, input: { title: "Multi-CD" }, humanNotifications });

async function scan(handler, workflows) {
  const ctx = makeCtx();
  const net = makeNet(ctx, workflows);
  global.fetch = net.fetch;
  await handler({}, ctx);
  return net;
}

describe("review-gate pings dedupe per review cycle", () => {
  it("re-parking the same gate after rework (new notif.id) pings again", async () => {
    const handler = await loadHandler();
    const cycle1 = notif("TEAM-4343", "notif_TEAM-4343_2026-09-10T13:53:00.000Z");
    const first = await scan(handler, [wf([cycle1])]);
    expect(first.sent).toHaveLength(1);
    expect(db.items.has("gate#notif_TEAM-4343_2026-09-10T13:53:00.000Z")).toBe(true);

    // Review concluded (ack) → rework → the orchestrator re-parks with a fresh id.
    const cycle2 = notif("TEAM-4343", "notif_TEAM-4343_2026-09-10T21:00:00.000Z");
    const second = await scan(handler, [wf([{ ...cycle1, acknowledged: true }, cycle2])]);
    expect(second.sent, "the second review cycle must ping").toHaveLength(1);
    expect(second.sent[0].text).toMatch(/TEAM-4343/);
    expect(db.items.has("gate#notif_TEAM-4343_2026-09-10T21:00:00.000Z")).toBe(true);
    expect(db.items.has("gate#TEAM-4343"), "claims are keyed on the cycle, not the ticket").toBe(false);
  });

  it("the same open notification seen on a later scan is not re-pinged", async () => {
    const handler = await loadHandler();
    const n = notif("TEAM-1", "notif_TEAM-1_2026-09-10T00:00:00.000Z");
    expect((await scan(handler, [wf([n])])).sent).toHaveLength(1);
    expect((await scan(handler, [wf([n])])).sent).toHaveLength(0);
    expect(db.deletes).toHaveLength(0);
  });

  it("a notification without an id falls back to the per-ticket claim", async () => {
    const handler = await loadHandler();
    const n = notif("GATE-1");
    expect((await scan(handler, [wf([n])])).sent).toHaveLength(1);
    expect(db.items.has("gate#GATE-1")).toBe(true);
    expect((await scan(handler, [wf([n])])).sent).toHaveLength(0);
  });

  it("open review_needed rows on terminal runs are neither pinged nor claimed", async () => {
    const handler = await loadHandler();
    const stale = [
      wf([notif("OLD-1", "notif_OLD-1_2026-08-01T00:00:00.000Z")], "complete"),
      wf([notif("OLD-2", "notif_OLD-2_2026-08-01T00:00:00.000Z")], "cancelled"),
      wf([notif("OLD-3", "notif_OLD-3_2026-08-01T00:00:00.000Z")], "failed"),
    ];
    const net = await scan(handler, stale);
    expect(net.sent).toHaveLength(0);
    expect([...db.items.keys()].filter((k) => k.startsWith("gate#"))).toEqual([]);
  });
});
