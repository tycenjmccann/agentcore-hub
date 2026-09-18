/**
 * TEAM-4751 C2 — the in-hours consumer of `gate:awaiting-console`.
 *
 * WP2 (TEAM-4750) gave the ticket twins a typed-gate guard: a `gate:<kind>`
 * ticket may only reach `done` once its condition is verified. On a refusal the
 * gate stays in review and gains `gate:awaiting-console` — a stall only a human
 * can clear. Before this change the label's ONLY reader required the
 * notification to have been requested out of hours AND its window to have since
 * opened, so an in-hours refusal paged nobody at all: the human's first and only
 * notice was a ticket comment.
 *
 * The properties under test are about WHO gets told and HOW OFTEN, so they are
 * asserted at the scan level with a faked clock, one poller invocation at a time:
 *
 *  1. The LABEL is the trigger, not the clock — an in-hours parked gate pages.
 *  2. Exactly once per stall, keyed on NFR-5's tuple
 *     (ticketId, gateKind, headSha, consoleUrl), then bounded by the SAME
 *     reminder ledger the deploy re-ping uses (DEPLOY_REPING_INTERVAL_MS ×
 *     DEPLOY_REPING_MAX) — never one page per 60s scan.
 *  3. It fails CLOSED: no label, a resolved gate, or a `/tickets` read that
 *     proved nothing pages nobody and claims nothing (unlike the out-of-hours
 *     reminder, where the page was already owed).
 *  4. One stall is worth at most ONE message per scan — the out-of-hours
 *     reminder and this consumer are keyed differently and must not both fire.
 *  5. The copy is kind-aware: a deploy approval gets the console deep link; any
 *     other probed kind (ci-unavailable, blocker) has no console to send anyone
 *     to and is pointed at the ticket's own gate-guard comment instead.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

const TG_TOKEN = "111111:test-bot-token";
const HUB = "https://hub.example.invalid";
const CHAT = 12345;
const WF = "wf-4751";
const GATE = "TEAM-9101";
const PIPELINE = "hub-widget-deploy";
const REPO = "acme/widget";
const REGION = "us-west-2";
const BUCKET = "test-artifact-bucket";
const CD_REGISTRY_KEY = "config/cd-registry.json";
const EXEC = "11111111-2222-3333-4444-555555555555";
const HEAD = "cafe1234beef56780123456789abcdef01234567";        // 40-hex, as gateHeadOf writes
const CONSOLE_URL =
  `https://console.aws.amazon.com/codesuite/codepipeline/pipelines/${PIPELINE}/view?region=${REGION}`;

const db = vi.hoisted(() => ({ items: new Map(), puts: [], deletes: [], updates: [] }));
vi.mock("@aws-sdk/client-dynamodb", async () => {
  const { applyUpdate } = await import("./helpers/ddb-fake.mjs");
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
      if (c.op === "update") return applyUpdate(db, c.input);
      if (c.op === "del") { db.deletes.push(c.input.Key.id.S); db.items.delete(c.input.Key.id.S); return {}; }
      if (c.op === "scan") {
        const p = c.input.ExpressionAttributeValues[":p"].S;
        return { Items: [...db.items.values()].filter((i) => i.id.S.startsWith(p)) };
      }
      throw new Error(`unexpected ddb op ${c.op}`);
    }
  }
  return {
    DynamoDBClient, GetItemCommand: cmd("get"), PutItemCommand: cmd("put"),
    UpdateItemCommand: cmd("update"), DeleteItemCommand: cmd("del"), ScanCommand: cmd("scan"),
  };
});

// The registry read is what turns `pipeline:<name>` into a console URL; the
// pipeline itself is parked on nothing, so the deploy poller finds no approval.
const s3 = vi.hoisted(() => ({ registry: null }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(c) {
      if (c.input?.Key === CD_REGISTRY_KEY && s3.registry) {
        return { Body: { transformToString: async () => JSON.stringify(s3.registry) } };
      }
      const e = new Error("NoSuchKey");
      e.name = "NoSuchKey";
      throw e;
    }
  },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-codepipeline", () => {
  const cmd = (op) => class { constructor(input) { this.input = input; this.op = op; } };
  return {
    CodePipelineClient: class { async send() { return { stageStates: [] }; } },
    GetPipelineStateCommand: cmd("state"),
    GetPipelineExecutionCommand: cmd("exec"),
    PutApprovalResultCommand: class {
      constructor() { throw new Error("no approval may be written by a scan"); }
    },
  };
});
vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send() { return { FailedEntryCount: 0 }; } },
  PutEventsCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-transcribe-streaming", () => ({
  StartStreamTranscriptionCommand: class { constructor(i) { this.input = i; } },
  TranscribeStreamingClient: class { async send() { return { TranscriptResultStream: (async function* () {})() }; } },
}));
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: class { async send() { throw new Error("bedrock must not be called"); } },
  ConverseCommand: class { constructor(i) { this.input = i; } },
}));

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });

function makeNet(ctx, workflows, opts = {}) {
  const net = { ctx, workflows, sent: [], ticketReads: 0, tickets: opts.tickets ?? null };
  net.fetch = async (url, o) => {
    const u = String(url);
    const body = o?.body ? JSON.parse(o.body) : null;
    if (u.startsWith("https://api.github.com/")) return jsonRes({});
    if (u === `${HUB}/api/workflow/list`) return jsonRes({ workflows: net.workflows });
    if (/\/api\/workflow\/[^/]+\/tickets$/.test(u)) {
      net.ticketReads++;
      return net.tickets ? jsonRes({ tickets: net.tickets }) : jsonRes({}, false, 404);
    }
    if (u.endsWith("/getUpdates")) { net.ctx.remainingMs = 20_000; return jsonRes({ ok: true, result: [] }); }
    if (u.endsWith("/sendMessage")) { net.sent.push(body); return jsonRes({ ok: true, result: { message_id: 77 } }); }
    if (u.endsWith("/sendChatAction")) return jsonRes({ ok: true, result: true });
    throw new Error(`unexpected fetch: ${u}`);
  };
  return net;
}
const makeCtx = () => ({ remainingMs: 100_000, getRemainingTimeInMillis() { return this.remainingMs; } });

const ENV = {
  TELEGRAM_BOT_TOKEN: TG_TOKEN, JIRA_SITE_URL: "example.atlassian.net", JIRA_EMAIL: "bot@example.com",
  JIRA_API_TOKEN: "t", JIRA_PROJECT_KEY: "TEAM", GITHUB_TOKEN: "gh", GITHUB_USER: "test-user",
  PENDING_TABLE: "test-pending-table", HUB_API_URL: HUB, ALLOWED_CHAT_IDS: String(CHAT),
  AWS_REGION: "us-east-1", CHAT_SETTLE_MS: "0",
  // The console# ledger row — not a per-container memo — is what has to do the
  // deduping in most of these tests, so the read rate limiter is out of the way.
  AWAITING_CONSOLE_POLL_MS: "0",
};
const EXTRA_ENV = [
  "ARTIFACT_BUCKET", "DEPLOY_PIPELINE_NAME", "WM_BUSINESS_TZ", "WM_BUSINESS_HOURS", "EVENT_BUS",
  "DEPLOY_REPING_INTERVAL_MS", "DEPLOY_REPING_MAX",
];

async function loadModule(over = {}) {
  vi.resetModules();
  Object.assign(process.env, ENV);
  for (const k of EXTRA_ENV) delete process.env[k];
  process.env.ARTIFACT_BUCKET = BUCKET;
  Object.assign(process.env, over);
  s3.registry = { version: 1, repos: [{ repo: REPO, pipeline: PIPELINE, region: REGION }] };
  return import("../index.mjs");
}
const loadHandler = async (over) => (await loadModule(over)).handler;

const realFetch = global.fetch;
beforeEach(() => {
  db.items.clear(); db.puts.length = 0; db.deletes.length = 0; db.updates.length = 0;
  db.items.set(`chat#${CHAT}`, { id: { S: `chat#${CHAT}` }, chatId: { N: String(CHAT) } });
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });
afterAll(() => {
  global.fetch = realFetch;
  for (const k of [...Object.keys(ENV), ...EXTRA_ENV]) delete process.env[k];
});

// ─── fixtures ────────────────────────────────────────────────────────────────

const NOTIF_ID = "notif_TEAM-9101_a";
const notif = (timestamp, id = NOTIF_ID) => ({
  type: "review_needed", acknowledged: false, ticketId: GATE, reviewer: "engineer", id, timestamp,
});
const wf = (notifs, phase = "ship") => ({
  workflowId: WF, phase, input: { title: "Ship the widget" }, humanNotifications: notifs,
});

/** The deploy gate the twins refused to close, with WP2's stamp. */
const parkedDeployGate = (extra = {}) => ({
  ticketId: GATE,
  title: "Deploy gate: approve prod deploy for the widget",
  status: "in_review",
  labels: [
    "gate:deploy-approval", `pipeline:${PIPELINE}`, `exec:${EXEC}`,
    `head:${HEAD}`, "gate:awaiting-console",
  ],
  ...extra,
});
/** A probed gate of another kind — no console, so no console button (adjustment 2). */
const parkedCiGate = (extra = {}) => ({
  ticketId: GATE,
  title: "CI certification: the widget build",
  status: "in_review",
  labels: ["gate:ci-unavailable", `head:${HEAD}`, "gate:awaiting-console"],
  ...extra,
});

/**
 * The request-time page already went out and is accounted for — the state every
 * later scan finds, and the only state in which the `!mode` branch (and so this
 * consumer) is reached at all.
 */
function seedPagedGate(atIso, id = NOTIF_ID) {
  const at = Date.parse(atIso);
  db.items.set(`gate#${id}`, {
    id: { S: `gate#${id}` },
    ttl: { N: String(Math.floor(at / 1000) + 30 * 86400) },
    pagedAt: { S: new Date(at).toISOString() },
    claimedAt: { N: String(at) },
    deliveredAt: { N: String(at) },
    lastPingAt: { N: String(at) },
    pingCount: { N: "1" },
  });
}

/** One poller invocation at wall-clock `nowIso`. */
async function scanAt(handler, nowIso, workflows, opts = {}) {
  vi.setSystemTime(new Date(nowIso));
  const ctx = makeCtx();
  const net = makeNet(ctx, workflows, opts);
  global.fetch = net.fetch;
  await handler({}, ctx);
  return net;
}
const keys = (prefix) => [...db.items.keys()].filter((k) => k.startsWith(prefix));
const rowOf = (prefix) => db.items.get(keys(prefix)[0]);

// Wed 2026-09-09, America/Los_Angeles (the default window: 09-18 Mon-Fri).
const IN_HOURS = "2026-09-09T21:00:00.000Z";          // Wed 14:00 PDT
const IN_HOURS_LATER = "2026-09-09T21:00:01.000Z";
const OUT_OF_HOURS = "2026-09-09T07:10:00.000Z";      // Wed 00:10 PDT
const WINDOW_OPENED = "2026-09-09T16:00:30.000Z";     // Wed 09:00:30 PDT

// ─────────────────────────────────────────────────────────────────────────────

describe("an in-hours parked gate pages the human (TEAM-4751 C2)", () => {
  it("pages once, with the console link, on the NFR-5 key", async () => {
    const handler = await loadHandler();
    const n = notif(IN_HOURS);
    seedPagedGate(IN_HOURS);

    const net = await scanAt(handler, IN_HOURS, [wf([n])], { tickets: [parkedDeployGate()] });

    expect(net.sent, "the label is the trigger — business hours are not a precondition").toHaveLength(1);
    const page = net.sent[0];
    // Its own kicker: a nag on an already-open prod gate is a KIND, and "·
    // business-hours reminder" would state the wrong reason for the wait.
    expect(page.text).toContain("⏰ PRODUCTION DEPLOY — still waiting on your approval");
    expect(page.text).not.toContain("business-hours reminder");
    expect(page.text).toContain("an agent tried to close this gate and was refused");
    expect(page.text).toContain("Approve the deploy in the console");
    expect(page.text).toContain(CONSOLE_URL);
    // Still actionable from Telegram, and the console button is offered too.
    expect(JSON.stringify(page.reply_markup)).toContain(`gok|${GATE}|${WF}`);
    expect(page.reply_markup.inline_keyboard.at(-1)[0].url).toBe(CONSOLE_URL);

    // NFR-5: one row per (ticketId, gateKind, headSha, consoleUrl).
    expect(keys("console#")).toHaveLength(1);
    const [key] = keys("console#");
    expect(key.startsWith(`console#${GATE}|deploy-approval|${HEAD}|`)).toBe(true);
    expect(key.split("|"), "the tuple is the whole key").toHaveLength(4);
    expect(key, "the URL is hashed, not embedded").not.toContain("https://");
    const row = rowOf("console#");
    expect(row.deliveredAt?.N).toBeTruthy();
    expect(row.pingCount.N).toBe("1");
    expect(JSON.parse(row.messageIds.S)).toEqual([`${CHAT}:77`]);
  });

  it("does not page again on the very next scan", async () => {
    const handler = await loadHandler();
    const n = notif(IN_HOURS);
    seedPagedGate(IN_HOURS);
    const w = [wf([n])];
    const tickets = [parkedDeployGate()];

    expect((await scanAt(handler, IN_HOURS, w, { tickets })).sent).toHaveLength(1);
    expect((await scanAt(handler, IN_HOURS_LATER, w, { tickets })).sent,
      "60s later is not a new stall").toHaveLength(0);
    expect(keys("console#")).toHaveLength(1);
  });

  it("re-pages on the deploy re-ping's cadence and then stops", async () => {
    const MAX = 3;
    const INTERVAL = 3_600_000;
    const handler = await loadHandler({
      DEPLOY_REPING_INTERVAL_MS: String(INTERVAL), DEPLOY_REPING_MAX: String(MAX),
    });
    const n = notif(IN_HOURS);
    seedPagedGate(IN_HOURS);
    const w = [wf([n])];
    const tickets = [parkedDeployGate()];

    let sends = (await scanAt(handler, IN_HOURS, w, { tickets })).sent.length;
    let t = Date.parse(IN_HOURS);
    // Well past the budget: the last two rounds must send nothing at all.
    for (let round = 0; round < MAX + 2; round++) {
      t += INTERVAL + 1000;
      const net = await scanAt(handler, new Date(t).toISOString(), w, { tickets });
      // A scan halfway to the next interval is always silent.
      const mid = await scanAt(handler, new Date(t + INTERVAL / 2).toISOString(), w, { tickets });
      expect(mid.sent, "a reminder is owed on the interval, not on the scan").toHaveLength(0);
      sends += net.sent.length;
    }
    expect(sends, "the original page plus DEPLOY_REPING_MAX reminders — no more").toBe(1 + MAX);
    expect(rowOf("console#").pingCount.N).toBe(String(1 + MAX));
  });
});

describe("a kind with no console says so instead (adjustment 2)", () => {
  it("pages a ci-unavailable gate with the ticket's remedy and no console URL", async () => {
    const handler = await loadHandler();
    const n = notif(IN_HOURS);
    seedPagedGate(IN_HOURS);

    const net = await scanAt(handler, IN_HOURS, [wf([n])], { tickets: [parkedCiGate()] });

    expect(net.sent).toHaveLength(1);
    const page = net.sent[0];
    expect(page.text).toMatch(/[Aa]n agent tried to close this gate and was refused/);
    expect(page.text).toContain("gate:ci-unavailable condition has not been verified");
    expect(page.text).toContain("gate-guard comment");
    // No console exists for this kind, so none is claimed — in the text, in the
    // meta line, or as a button.
    expect(page.text, "there is no console to send anyone to").not.toContain("console.aws.amazon.com");
    expect(page.text).not.toContain("deploy gate in the console");
    expect(JSON.stringify(page.reply_markup)).not.toContain("console.aws.amazon.com");
    expect(JSON.stringify(page.reply_markup)).toContain(`gok|${GATE}|${WF}`);

    // The key still carries the head sha, so a re-pushed branch pages again.
    expect(keys("console#")).toEqual([
      expect.stringContaining(`console#${GATE}|ci-unavailable|${HEAD}|`),
    ]);
  });

  it("a fresh head sha is a fresh stall", async () => {
    const handler = await loadHandler();
    const n = notif(IN_HOURS);
    seedPagedGate(IN_HOURS);
    const w = [wf([n])];

    expect((await scanAt(handler, IN_HOURS, w, { tickets: [parkedCiGate()] })).sent).toHaveLength(1);
    const REPUSHED = "0123456789abcdef0123456789abcdef01234567";
    const moved = parkedCiGate({ labels: ["gate:ci-unavailable", `head:${REPUSHED}`, "gate:awaiting-console"] });
    expect((await scanAt(handler, IN_HOURS_LATER, w, { tickets: [moved] })).sent,
      "the human owes an answer about the new head, not the old one").toHaveLength(1);
    expect(keys("console#")).toHaveLength(2);
  });
});

describe("it fails closed", () => {
  const cases = [
    ["no gate:awaiting-console label", () => [parkedDeployGate({ labels: ["gate:deploy-approval", `pipeline:${PIPELINE}`] })]],
    ["the gate was resolved in the meantime", () => [parkedDeployGate({ status: "done" })]],
    ["the gate is not on the board at all", () => []],
    ["the tickets read proved nothing (404)", () => null],
  ];
  for (const [label, tickets] of cases) {
    it(`${label} → nobody is paged and nothing is claimed`, async () => {
      const handler = await loadHandler();
      seedPagedGate(IN_HOURS);

      const net = await scanAt(handler, IN_HOURS, [wf([notif(IN_HOURS)])], { tickets: tickets() });

      expect(net.sent).toHaveLength(0);
      expect(keys("console#"), "an unproven stall must not burn the ledger row").toEqual([]);
    });
  }

  it("a send failure leaves the stall re-pageable", async () => {
    const handler = await loadHandler();
    seedPagedGate(IN_HOURS);
    const w = [wf([notif(IN_HOURS)])];
    const tickets = [parkedDeployGate()];

    vi.setSystemTime(new Date(IN_HOURS));
    const ctx = makeCtx();
    const net = makeNet(ctx, w, { tickets });
    const ok = net.fetch;
    global.fetch = async (url, o) => {
      if (String(url).endsWith("/sendMessage")) throw new Error("Telegram 502");
      return ok(url, o);
    };
    await handler({}, ctx);

    expect(keys("console#"), "an undelivered first page must not hold the claim").toEqual([]);
    expect((await scanAt(handler, IN_HOURS_LATER, w, { tickets })).sent).toHaveLength(1);
  });
});

describe("one stall, one message per scan", () => {
  it("the out-of-hours reminder wins the scan, and the consumer takes the next one", async () => {
    const handler = await loadHandler();
    const n = notif(OUT_OF_HOURS);
    seedPagedGate(OUT_OF_HOURS);   // paged at 00:10 PDT, before the window opened
    const w = [wf([n])];
    const tickets = [parkedDeployGate()];

    const first = await scanAt(handler, WINDOW_OPENED, w, { tickets });
    expect(first.sent, "two messages about one stall is the bug").toHaveLength(1);
    // It is the reminder — and it already carries the awaiting-console copy.
    expect(keys("repage#")).toEqual([`repage#${NOTIF_ID}`]);
    expect(keys("console#")).toEqual([]);
    expect(first.sent[0].text).toContain(CONSOLE_URL);
    expect(first.sent[0].text).toContain("an agent tried to close this gate and was refused");

    // The consumer's row was never claimed, so the stall is still owed a page.
    const second = await scanAt(handler, "2026-09-09T16:01:30.000Z", w, { tickets });
    expect(second.sent).toHaveLength(1);
    expect(keys("console#")).toHaveLength(1);
  });
});

describe("reading the label is rate limited, paging is not", () => {
  it("AWAITING_CONSOLE_POLL_MS bounds the /tickets read, and the ledger bounds the page", async () => {
    // The production default, spelled out — the two scans below are 1s apart, so
    // only the first one may cost a read.
    const handler = await loadHandler({ AWAITING_CONSOLE_POLL_MS: "120000" });
    const n = notif(IN_HOURS);
    seedPagedGate(IN_HOURS);
    const w = [wf([n])];
    const tickets = [parkedDeployGate()];

    const first = await scanAt(handler, IN_HOURS, w, { tickets });
    expect(first.ticketReads).toBe(1);
    expect(first.sent).toHaveLength(1);

    const second = await scanAt(handler, IN_HOURS_LATER, w, { tickets });
    expect(second.ticketReads, "the label read is memoized for AWAITING_CONSOLE_POLL_MS").toBe(0);
    expect(second.sent).toHaveLength(0);
  });
});
