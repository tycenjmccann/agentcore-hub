/**
 * TEAM-4663, sibling sweep — the review-gate (`gate#`) and escalation (`esc#`)
 * pings share the deploy gate's claim-before-send hole.
 *
 * The claim row is written before listChats + the ticket fetch + tgSend, and
 * every later scan bails on "already claimed". A re-parked gate does mint a new
 * notif.id — but only AFTER a human reviews it, which needs someone to have been
 * paged. So an invocation killed mid-scan strands the row and the gate is silent
 * for the row's whole 30-day TTL, with nothing to re-mint it.
 *
 * Both paths adopt the RECOVERY half of the fix (no reminders — that needs a
 * design decision about repage#/REPAGE_SKIP_STATUSES and the business window):
 * `claimedAt` at claim, `deliveredAt` after a confirmed send, and a conditional-Put
 * loss consults the row and re-sends only when nothing was ever delivered.
 *
 * The two things this file exists to pin, per path:
 *   1. a STRANDED claim (claimedAt past the lease, no deliveredAt) re-sends
 *      exactly once, marks the row delivered, and never releases it;
 *   2. a PRE-UPGRADE row (no claimedAt at all — what the old code wrote) is NOT
 *      recovery-eligible, so deploying this fix cannot re-page every gate and
 *      escalation that is open at the time.
 * Plus, for gates: `pagedAt` is untouched, because TEAM-4461's business-hours
 * repage suppression keys off it and `deliveredAt` is a separate attribute.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TG_TOKEN = "111111:test-bot-token";
const HUB = "https://hub.example.invalid";

const db = vi.hoisted(() => ({ items: new Map(), puts: [], deletes: [], updates: [] }));
const eb = vi.hoisted(() => ({ entries: [] }));

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
    DynamoDBClient,
    GetItemCommand: cmd("get"), PutItemCommand: cmd("put"), UpdateItemCommand: cmd("update"),
    DeleteItemCommand: cmd("del"), ScanCommand: cmd("scan"),
  };
});
// gate.requested is the metrics record of "the human was asked" — a recovery is
// the first time that is true for a stranded row, so it must fire exactly once.
vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send(c) { eb.entries.push(...c.input.Entries); return { FailedEntryCount: 0 }; } },
  PutEventsCommand: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/client-transcribe-streaming", () => ({
  StartStreamTranscriptionCommand: class { constructor(i) { this.input = i; } },
  TranscribeStreamingClient: class { async send() { return { TranscriptResultStream: (async function* () {})() }; } },
}));
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: class { async send() { throw new Error("bedrock must not be called"); } },
  ConverseCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { async send() { const e = new Error("NoSuchKey"); e.name = "NoSuchKey"; throw e; } },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-codepipeline", () => ({
  CodePipelineClient: class { async send() { throw new Error("codepipeline must not be called"); } },
  GetPipelineStateCommand: class { constructor(i) { this.input = i; } },
  GetPipelineExecutionCommand: class { constructor(i) { this.input = i; } },
  PutApprovalResultCommand: class { constructor(i) { this.input = i; } },
}));

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });

function makeNet(ctx, workflows) {
  const net = { ctx, workflows, sent: [] };
  net.fetch = async (url, opts) => {
    const u = String(url);
    if (u === `${HUB}/api/workflow/list`) return jsonRes({ workflows: net.workflows });
    if (/\/api\/workflow\/[^/]+\/tickets$/.test(u)) return jsonRes({}, false, 404);
    if (u.includes("/api/workflow/artifacts")) return jsonRes({}, false, 404);
    if (u.endsWith("/getUpdates")) { net.ctx.remainingMs = 20_000; return jsonRes({ ok: true, result: [] }); }
    if (u.endsWith("/sendMessage")) {
      const body = JSON.parse(opts.body);
      net.sent.push(body);
      return jsonRes({ ok: true, result: { message_id: 900 + net.sent.length } });
    }
    if (u.endsWith("/sendChatAction")) return jsonRes({ ok: true, result: true });
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

async function loadHandler(env = {}) {
  vi.resetModules();
  Object.assign(process.env, ENV);
  delete process.env.ARTIFACT_BUCKET;
  delete process.env.DEPLOY_PIPELINE_NAME;
  delete process.env.PING_LEASE_MS;
  Object.assign(process.env, env);
  return (await import("../index.mjs")).handler;
}

const realFetch = global.fetch;
beforeEach(() => {
  db.items.clear(); db.puts.length = 0; db.deletes.length = 0; db.updates.length = 0;
  eb.entries.length = 0;
  db.items.set("chat#12345", { id: { S: "chat#12345" }, chatId: { N: "12345" } });
});
afterAll(() => {
  global.fetch = realFetch;
  for (const k of [...Object.keys(ENV), "PING_LEASE_MS", "ARTIFACT_BUCKET", "DEPLOY_PIPELINE_NAME"]) delete process.env[k];
});

const DAY = 86_400;
const N = (v) => ({ N: String(v) });
const STALE = () => Date.now() - 10 * 60_000;   // past PING_LEASE_MS (5 min)
const FRESH = () => Date.now() - 60_000;        // inside it

/**
 * A gate ping claim as a previous invocation would have left it.
 *
 * `agedMs` back-dates the TTL as well as `claimedAt`, because the row's 30-day
 * `ttl` IS `claimTime + 30d`: a pre-upgrade row that has been stranded for hours
 * carries a correspondingly older TTL, and that is exactly the quantity `dep#`
 * uses as its legacy fallback. Modelling it keeps the "no TTL fallback here"
 * assertions honest — with a fresh TTL a fallback would land inside the lease and
 * the tests would pass whichever policy the gate path used.
 */
const PAGED_AT = "2026-09-15T10:00:00.000Z";
function seedGateClaim(id, { claimedAt, deliveredAt, agedMs = 0 } = {}) {
  db.items.set(`gate#${id}`, {
    id: { S: `gate#${id}` },
    ttl: N(Math.floor((Date.now() - agedMs) / 1000) + 30 * DAY),
    pagedAt: { S: PAGED_AT },
    ...(claimedAt != null ? { claimedAt: N(claimedAt) } : {}),
    ...(deliveredAt != null ? { deliveredAt: N(deliveredAt) } : {}),
  });
}
function seedEscClaim(id, { claimedAt, deliveredAt, agedMs = 0 } = {}) {
  db.items.set(`esc#${id}`, {
    id: { S: `esc#${id}` },
    ttl: N(Math.floor((Date.now() - agedMs) / 1000) + 30 * DAY),
    ...(claimedAt != null ? { claimedAt: N(claimedAt) } : {}),
    ...(deliveredAt != null ? { deliveredAt: N(deliveredAt) } : {}),
  });
}

const updatesOf = (id) => db.updates.filter((u) => u.id === id);
/** Notifications carry NO timestamp here, so the business-hours repage path
 *  (isOutsideHours → null) never fires and cannot be confused with a recovery. */
const GATE_NOTIF = { id: "notif_gate_1", type: "review_needed", acknowledged: false, ticketId: "GATE-7", reviewer: "me" };
const ESC_NOTIF = { id: "notif_wm_1", type: "manager_escalation", acknowledged: false, details: "TEAM-3938 is in a DETERMINISTIC crash-loop." };
const runWith = (notif) => [{ workflowId: "wf-1", input: { title: "Music video journey" }, phase: "development", humanNotifications: [notif] }];

async function run(handler, notif) {
  const ctx = makeCtx();
  const net = makeNet(ctx, runWith(notif));
  global.fetch = net.fetch;
  await handler({}, ctx);
  return net;
}

const gatePings = (net) => net.sent.filter((m) => /REVIEW GATE/i.test(String(m.text)));
const escPings = (net) => net.sent.filter((m) => /WORKFLOW MANAGER ESCALATION/i.test(String(m.text)));

// ─── T7: review gates ─────────────────────────────────────────────────────────

describe("T7 a stranded review-gate claim is recovered", () => {
  it("re-sends the gate ping once and records the delivery", async () => {
    const handler = await loadHandler();
    seedGateClaim(GATE_NOTIF.id, { claimedAt: STALE() });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const net = await run(handler, GATE_NOTIF);

      expect(gatePings(net), "nobody was ever paged for this gate — page them").toHaveLength(1);
      expect(gatePings(net)[0].chat_id).toBe(12345);
      // The callback keys are the gate's, unchanged by the recovery.
      const buttons = gatePings(net)[0].reply_markup.inline_keyboard.flat();
      expect(buttons.some((b) => b.callback_data === `gok|${GATE_NOTIF.ticketId}|wf-1`)).toBe(true);

      const item = db.items.get(`gate#${GATE_NOTIF.id}`);
      expect(item.deliveredAt?.N, "phase 2 lands on the row").toBeTruthy();
      expect(item.pagedAt.S, "TEAM-4461 repage suppression still reads the ORIGINAL pagedAt").toBe(PAGED_AT);
      // Lease re-take, then markPingDelivered.
      expect(updatesOf(`gate#${GATE_NOTIF.id}`).length).toBe(2);
      expect(db.deletes, "a re-sent gate must keep its claim").not.toContain(`gate#${GATE_NOTIF.id}`);
      expect(warn.mock.calls.some((a) => /review gate ping never confirmed/.test(String(a[0])))).toBe(true);
      // The recovery IS when the human was asked, and nothing published before it.
      expect(eb.entries.filter((e) => e.DetailType === "gate.requested")).toHaveLength(1);
    } finally { warn.mockRestore(); }
  });

  it("does not page again on the next scan", async () => {
    const handler = await loadHandler();
    seedGateClaim(GATE_NOTIF.id, { claimedAt: STALE() });

    expect(gatePings(await run(handler, GATE_NOTIF))).toHaveLength(1);
    expect(gatePings(await run(handler, GATE_NOTIF)), "recovery is one-shot").toHaveLength(0);
    expect(eb.entries.filter((e) => e.DetailType === "gate.requested"), "exactly one gate.requested per notification").toHaveLength(1);
  });

  it("a PRE-UPGRADE row (no claimedAt) is not recovery-eligible — the deploy pages nobody", async () => {
    const handler = await loadHandler();
    // What the old code wrote: ttl + pagedAt only. Aged well past the lease, so
    // this fails if the gate path ever grows dep#'s ttl-derived fallback.
    seedGateClaim(GATE_NOTIF.id, { agedMs: 4 * 3600_000 });
    const before = db.items.get(`gate#${GATE_NOTIF.id}`);

    const net = await run(handler, GATE_NOTIF);

    expect(net.sent, "an open gate must not be re-paged just because this shipped").toEqual([]);
    expect(updatesOf(`gate#${GATE_NOTIF.id}`), "the row is not touched at all").toEqual([]);
    expect(db.items.get(`gate#${GATE_NOTIF.id}`)).toBe(before);
    expect(db.deletes).toEqual([]);
    expect(eb.entries).toEqual([]);
  });

  it("a claim inside its lease is left alone", async () => {
    const handler = await loadHandler();
    seedGateClaim(GATE_NOTIF.id, { claimedAt: FRESH() });

    const net = await run(handler, GATE_NOTIF);
    expect(net.sent, "a send may still be in flight in a sibling invocation").toEqual([]);
    expect(updatesOf(`gate#${GATE_NOTIF.id}`)).toEqual([]);
  });

  it("a DELIVERED claim past the lease is never re-sent", async () => {
    const handler = await loadHandler();
    seedGateClaim(GATE_NOTIF.id, { claimedAt: STALE(), deliveredAt: STALE() });

    const net = await run(handler, GATE_NOTIF);
    expect(net.sent, "gates get recovery, not reminders").toEqual([]);
    expect(updatesOf(`gate#${GATE_NOTIF.id}`)).toEqual([]);
  });

  it("a first claim still records claimedAt alongside pagedAt", async () => {
    const handler = await loadHandler();
    const net = await run(handler, GATE_NOTIF); // no seeded row: the normal path

    expect(gatePings(net)).toHaveLength(1);
    const item = db.items.get(`gate#${GATE_NOTIF.id}`);
    expect(item.claimedAt?.N, "phase 1 — what makes a later strand detectable").toBeTruthy();
    expect(item.pagedAt?.S, "and pagedAt keeps its own meaning").toBeTruthy();
    expect(item.deliveredAt?.N).toBeTruthy();
  });
});

// ─── T8: manager escalations (dead-session pages share this code) ─────────────

describe("T8 a stranded escalation claim is recovered", () => {
  it("re-sends the escalation ping once and records the delivery", async () => {
    const handler = await loadHandler();
    seedEscClaim(ESC_NOTIF.id, { claimedAt: STALE() });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const net = await run(handler, ESC_NOTIF);

      expect(escPings(net), "an open escalation PARKS the run — it must not be silent").toHaveLength(1);
      expect(escPings(net)[0].reply_markup.inline_keyboard.flat().some((b) => b.callback_data === "eok|wf-1")).toBe(true);

      const item = db.items.get(`esc#${ESC_NOTIF.id}`);
      expect(item.deliveredAt?.N).toBeTruthy();
      expect(JSON.parse(item.messageIds.S)).toEqual(["12345:901"]);
      expect(updatesOf(`esc#${ESC_NOTIF.id}`).length).toBe(2);
      expect(db.deletes).not.toContain(`esc#${ESC_NOTIF.id}`);
      expect(warn.mock.calls.some((a) => /manager escalation ping never confirmed/.test(String(a[0])))).toBe(true);
    } finally { warn.mockRestore(); }
  });

  it("does not page again on the next scan", async () => {
    const handler = await loadHandler();
    seedEscClaim(ESC_NOTIF.id, { claimedAt: STALE() });

    expect(escPings(await run(handler, ESC_NOTIF))).toHaveLength(1);
    expect(escPings(await run(handler, ESC_NOTIF))).toHaveLength(0);
  });

  it("a PRE-UPGRADE row (no claimedAt) is not recovery-eligible", async () => {
    const handler = await loadHandler();
    seedEscClaim(ESC_NOTIF.id, { agedMs: 4 * 3600_000 });
    const before = db.items.get(`esc#${ESC_NOTIF.id}`);

    const net = await run(handler, ESC_NOTIF);

    expect(net.sent).toEqual([]);
    expect(updatesOf(`esc#${ESC_NOTIF.id}`)).toEqual([]);
    expect(db.items.get(`esc#${ESC_NOTIF.id}`)).toBe(before);
    expect(db.deletes).toEqual([]);
  });

  it("a claim inside its lease is left alone", async () => {
    const handler = await loadHandler();
    seedEscClaim(ESC_NOTIF.id, { claimedAt: FRESH() });

    const net = await run(handler, ESC_NOTIF);
    expect(net.sent).toEqual([]);
  });

  it("a dead-session page recovers through the same claim", async () => {
    const handler = await loadHandler();
    // Same esc# claim, a different RENDERING (FR-3) — proving S3 is covered by S2.
    const dead = {
      ...ESC_NOTIF, id: "notif_dead_1", reviewer: "dead-session-detector",
      ticketId: "TEAM-9", details: "Agent dev died twice on TEAM-9. Auto-retry is exhausted.",
    };
    seedEscClaim(dead.id, { claimedAt: STALE() });

    const net = await run(handler, dead);

    const pings = net.sent.filter((m) => /DEAD SESSION/.test(String(m.text)));
    expect(pings).toHaveLength(1);
    expect(db.items.get(`esc#${dead.id}`).deliveredAt?.N).toBeTruthy();
  });

  it("PING_LEASE_MS is shared by every recovery path", async () => {
    const handler = await loadHandler({ PING_LEASE_MS: "30000" });
    seedEscClaim(ESC_NOTIF.id, { claimedAt: Date.now() - 60_000 }); // past a 30s lease

    expect(escPings(await run(handler, ESC_NOTIF))).toHaveLength(1);
  });
});
