/**
 * TEAM-5423 — escalation, round-cap and decision gates are re-paged at 4h, 12h
 * and every 12h of wait, held to working hours, on the existing Telegram +
 * ticket-comment path, with one `escalation.reminded` run event per reminder.
 *
 * Fixtures (fixtures/escalation-gates.json) carry the acceptance facts of
 * TEAM-5389, TEAM-5412 and TEAM-5365 (synthesized), plus each one's `real`
 * block captured from run wf_1791311636588_rfq233. Instants are around the default window,
 * 09-18 America/Los_Angeles: 09:00 PDT = 16:00Z.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const FX = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/escalation-gates.json"), "utf8"));
const TG_TOKEN = "111111:test-bot-token";
const HUB = "https://hub.example.invalid";

const db = vi.hoisted(() => ({ items: new Map(), puts: [], deletes: [], updates: [] }));
const eb = vi.hoisted(() => ({ entries: [], fail: false }));

vi.mock("@aws-sdk/client-dynamodb", async () => {
  // TEAM-4663: the handler now UPDATES claim rows (two-phase claim). One
  // shared evaluator, because a fake that replaces instead of merging would
  // hide a real regression — see helpers/ddb-fake.mjs.
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
  return { DynamoDBClient, GetItemCommand: cmd("get"), PutItemCommand: cmd("put"), UpdateItemCommand: cmd("update"), DeleteItemCommand: cmd("del"), ScanCommand: cmd("scan") };
});
vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class {
    async send(c) {
      if (eb.fail) throw new Error("PutEvents denied");
      eb.entries.push(...c.input.Entries);
      return { FailedEntryCount: 0 };
    }
  },
  PutEventsCommand: class { constructor(input) { this.input = input; } },
}));
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

const ENV = {
  TELEGRAM_BOT_TOKEN: TG_TOKEN, JIRA_SITE_URL: "example.atlassian.net", JIRA_EMAIL: "bot@example.com",
  JIRA_API_TOKEN: "t", JIRA_PROJECT_KEY: "TEAM", GITHUB_TOKEN: "t", GITHUB_USER: "test-user",
  PENDING_TABLE: "test-pending-table", HUB_API_URL: HUB, ALLOWED_CHAT_IDS: "12345",
};
const WINDOW_ENV = ["WM_BUSINESS_TZ", "WM_BUSINESS_HOURS", "EVENT_BUS"];

async function loadModule() {
  vi.resetModules();
  Object.assign(process.env, ENV);
  delete process.env.ARTIFACT_BUCKET;
  delete process.env.DEPLOY_PIPELINE_NAME;
  for (const k of WINDOW_ENV) delete process.env[k];
  return import("../index.mjs");
}

const realFetch = global.fetch;
beforeEach(() => {
  db.items.clear(); db.puts.length = 0; db.deletes.length = 0; db.updates.length = 0;
  eb.entries.length = 0; eb.fail = false;
  db.items.set("chat#12345", { id: { S: "chat#12345" }, chatId: { N: "12345" } });
});
afterEach(() => { vi.useRealTimers(); });
afterAll(() => {
  global.fetch = realFetch;
  for (const k of [...Object.keys(ENV), ...WINDOW_ENV]) delete process.env[k];
});

const H = 3600 * 1000;
const wfOf = (fx) => ({ workflowId: fx.workflowId, phase: "dev", input: { title: `Run for ${fx.notif.ticketId}` }, humanNotifications: [fx.notif] });

describe("pure helpers (U2)", () => {
  let R;
  beforeEach(async () => { R = (await loadModule())._escalationReminderForTests; });

  it("classifies the escalation gates in, and Merge Approval / unmarked human:* gates out", () => {
    expect(R.isEscalationGate(FX["TEAM-5389"].gateTicket, FX["TEAM-5389"].notif)).toBe(true);
    expect(R.isEscalationGate(FX["TEAM-5412"].gateTicket, FX["TEAM-5412"].notif)).toBe(true);
    expect(R.isEscalationGate(FX["TEAM-5365"].gateTicket, FX["TEAM-5365"].notif)).toBe(false);
    expect(R.isEscalationGate(FX.unmarked.gateTicket, FX.unmarked.notif)).toBe(false);
    // Label markers, both stored shapes.
    const t = { title: "Decision needed", labels: ["gate-round-cap"] };
    expect(R.isEscalationGate(t, { gate: "dev" })).toBe(true);
    expect(R.isEscalationGate({ title: "x", labels: ["gate:decision"] }, {})).toBe(true);
    // A deploy-approval gate never reminds, whatever its title says.
    expect(R.isEscalationGate({ title: "Escalation #1: ship-review not converging", labels: ["gate:deploy-approval"] }, {})).toBe(false);
    expect(R.isEscalationGate({ title: "x not converging", labels: [] }, { gate: "intake" })).toBe(false);
    expect(R.isEscalationGate(null, {})).toBe(false);
  });

  it("tiers: none before 4h, 0 from 4h, k at k×12h", () => {
    expect(R.escalationTierDue(4 * H - 1)).toBeNull();
    expect(R.escalationTierDue(4 * H)).toBe(0);
    expect(R.escalationTierDue(12 * H - 1)).toBe(0);
    expect(R.escalationTierDue(12 * H)).toBe(1);
    expect(R.escalationTierDue(36 * H)).toBe(3);
    expect(R.escalationTierDue(NaN)).toBeNull();
    expect(R.escalationDueAt(0, 0)).toBe(4 * H);
    expect(R.escalationDueAt(0, 2)).toBe(24 * H);
  });

  it("TEAM-5389: options verbatim, 1 open P2 R3-1, the wait as 10h08m", () => {
    const fx = FX["TEAM-5389"];
    expect(R.parseDecisionOptions(fx.gateTicket.description)).toEqual([
      "fix-r3-1 | send R3-1 back to dev for one more round, then re-review",
      "merge-known | merge with R3-1 open and file it as a follow-up",
      "cancel | cancel the run",
    ]);
    expect(R.parseOpenFindings([fx.gateTicket.description, ...fx.comments])).toBe(fx.expect.findings);
    expect(R.formatWait(fx.waitMs)).toBe(fx.expect.wait);
  });

  it("TEAM-5412: P1 regression-of-fix first, the R2-05 it mentions is not a finding", () => {
    const fx = FX["TEAM-5412"];
    const out = R.parseOpenFindings([fx.gateTicket.description]);
    expect(out).toBe(`2 open: ${fx.expect.findings}`);
    expect(out).not.toContain("R2-05");
    expect(R.parseDecisionOptions(fx.gateTicket.description)).toContain(fx.expect.option);
    expect(R.parseDecisionOptions(fx.gateTicket.description)[0]).toBe("DECISION: pick one");
    expect(R.formatWait(fx.waitMs)).toBe(fx.expect.wait);
  });

  it("findings degrade to 'see ticket'; a fixed mention closes; table rows are not options", () => {
    expect(R.parseOpenFindings(["no ids here"])).toBe("findings: see ticket");
    expect(R.parseOpenFindings(["P2 R1-1 open", "R1-1 fixed"])).toBe("0 open (all marked fixed)");
    expect(R.parseOpenFindings(["P2 R1-1 open", "R1-1 fixed", "R1-1 is back (P1)"])).toBe("1 open: P1 R1-1");
    expect(R.parseDecisionOptions("P2 | R3-1 | text\nR3-1 | x\n| a | b |")).toEqual([]);
  });

  // Real-captured text from run wf_1791311636588_rfq233 (fixture `real` blocks).
  // Both failed on the pre-fix parser: options [] and "1 open: P1 R3-02".
  it("real TEAM-5389: the backticked DECISION lines are quoted verbatim", () => {
    const r = FX["TEAM-5389"].real;
    expect(R.parseDecisionOptions(r.description)).toEqual(r.expect.options);
    expect(R.parseOpenFindings([r.description, ...r.comments])).toBe(r.expect.findings);
    expect(R.formatWait(r.waitMs)).toBe(r.expect.wait);
    expect(R.isEscalationGate({ title: r.title, labels: r.labels }, { ticketId: "TEAM-5389" })).toBe(true);
  });

  it("real TEAM-5412: 'reports the move as verified' does not close R3-01; options quoted", () => {
    const r = FX["TEAM-5412"].real;
    expect(R.parseOpenFindings([r.description, ...r.comments])).toBe(r.expect.findings);
    expect(R.parseDecisionOptions(r.description)).toEqual(r.expect.options);
    expect(R.formatWait(r.waitMs)).toBe(r.expect.wait);
    expect(R.isEscalationGate({ title: r.title, labels: r.labels }, { ticketId: "TEAM-5412" })).toBe(true);
  });

  it("real TEAM-5365: Merge Approval is not an escalation gate", () => {
    const r = FX["TEAM-5365"].real;
    expect(R.isEscalationGate({ title: r.title, labels: r.labels }, { ticketId: "TEAM-5365", gate: "ship" })).toBe(false);
  });

  it("a resolution word closes only the id it is bound to", () => {
    // Bound forms close.
    expect(R.parseOpenFindings(["P2 R1-1 open", "fixed R1-1"])).toBe("0 open (all marked fixed)");
    expect(R.parseOpenFindings(["P2 R1-1 open", "R1-1: resolved"])).toBe("0 open (all marked fixed)");
    expect(R.parseOpenFindings(["P2 R1-1 open", "R1-1 is now closed"])).toBe("0 open (all marked fixed)");
    expect(R.parseOpenFindings(["P2 R1-1 open", "- **Fixed: R1-1.** done"])).toBe("0 open (all marked fixed)");
    expect(R.parseOpenFindings(["P2 R1-1 open", "| R1-1 | P2 | the cache misses | fixed |"])).toBe("0 open (all marked fixed)");
    // Co-occurrence does not.
    expect(R.parseOpenFindings(["| R1-1 | P2 | the probe was verified against the old head |"])).toBe("1 open: P2 R1-1");
    expect(R.parseOpenFindings(["R1-1 (P2): the lock is addressed by nobody yet"])).toBe("1 open: P2 R1-1");
    expect(R.parseOpenFindings(["P1 R1-2 and P2 R1-1 fixed"])).toBe("1 open: P1 R1-2");
  });

  it("a tag goes to its nearest id, not every id in the clause", () => {
    expect(R.parseOpenFindings(["R1-1 (P2) and R1-2 (P1, regression-of-fix)"]))
      .toBe("2 open: P1 R1-2 regression-of-fix, P2 R1-1");
    expect(R.parseOpenFindings(["| R1-2 | P1 | This breaks the round-1 F2 fix. |"]))
      .toBe("1 open: P1 R1-2 regression-of-fix");
  });

  it("DECISION lines: bare, backticked, bolded, pipe form; never mid-sentence", () => {
    expect(R.parseDecisionOptions([
      "DECISION: merge",
      "- `DECISION: fix-r3-1`: api_dev gets one fix",
      "  - **`DECISION: cancel`**: nothing merges.",
      "- `retry` | one more round",
      "A human answered with `DECISION: continue`, so I filed a fix.",
    ].join("\n"))).toEqual([
      "DECISION: merge",
      "`DECISION: fix-r3-1`: api_dev gets one fix",
      "**`DECISION: cancel`**: nothing merges.",
      "`retry` | one more round",
    ]);
  });

  it("recordedTier: events first, footer fallback, null when neither is readable", () => {
    const n = FX["TEAM-5389"].notif;
    const ev = (o) => ({ type: "escalation.reminded", gateTicketId: n.ticketId, notifId: n.id, ...o });
    expect(R.recordedTier({ events: [], comments: null }, n)).toBe(-1);
    expect(R.recordedTier({ events: [ev({ tier: 0 }), ev({ tier: 1 }), ev({ tier: 5, notifId: "other" }), { type: "agent.started", tier: 9 }] }, n)).toBe(1);
    // The GET flattens detail; a raw row nests it. Both count.
    expect(R.recordedTier({ events: [{ type: "escalation.reminded", detail: { gateTicketId: n.ticketId, notifId: n.id, tier: 2 } }] }, n)).toBe(2);
    const footer = `x\n[escalation-reminder notif=${n.id} tier=1]`;
    expect(R.recordedTier({ events: null, comments: [footer, "\\[escalation-reminder notif=other tier=4\\]"] }, n)).toBe(1);
    expect(R.recordedTier({ events: null, comments: [footer.replace("[", "\\[").replace("]", "\\]")] }, n)).toBe(1);
    expect(R.recordedTier({ events: null, comments: null }, n)).toBeNull();
    // MAX over every readable source: a readable-but-empty event stream (the
    // events POST failed) does not hide a footer the comment did record.
    expect(R.recordedTier({ events: [], comments: [footer] }, n)).toBe(1);
    expect(R.recordedTier({ events: [ev({ tier: 2 })], comments: [footer] }, n)).toBe(2);
    expect(R.recordedTier({ events: [ev({ tier: 0 })], comments: [footer] }, n)).toBe(1);
  });

  it("the message quotes options, findings, cost and wait, and the comment ends with the footer", async () => {
    const mod = await loadModule();
    const R2 = mod._escalationReminderForTests;
    const fx = FX["TEAM-5389"];
    const { ping, comment } = R2.buildEscalationReminder({
      wf: wfOf(fx), notif: fx.notif, gateTicket: fx.gateTicket, comments: fx.comments,
      card: { cost: { totalUsd: 12.345 } }, tier: 0, elapsedMs: fx.waitMs,
    });
    const text = mod._buildApprovalMessageForTests({ ...ping, plain: true });
    expect(text).toMatch(/^⏰ ESCALATION — still waiting on your decision/);
    expect(text).toContain(fx.expect.option);
    expect(text).toContain("1 open: P2 R3-1");
    expect(text).toContain("cost to date: $12.35");
    expect(text).toContain("waiting 10h08m");
    expect(text).toContain("TEAM-5389");
    expect(comment).toContain(fx.expect.option);
    expect(comment).toContain("Cost to date: $12.35");
    expect(comment.trim().split("\n").pop()).toBe(`[escalation-reminder notif=${fx.notif.id} tier=0]`);
    expect(R2.costToDate(null)).toBe("unknown");
    expect(R2.costToDate({ cost: { totalUsd: 0 } })).toBe("$0.00");
    expect(R2.costToDate({ cost: { totalUsd: "12" } })).toBe("unknown");
    expect(R2.costToDate({ cost: { totalUsd: NaN } })).toBe("unknown");
    expect(R2.costToDate({ cost: {} })).toBe("unknown");
    const unknown = mod._buildApprovalMessageForTests({ ...R2.buildEscalationReminder({
      wf: wfOf(fx), notif: fx.notif, gateTicket: fx.gateTicket, tier: 1, elapsedMs: 12 * H,
    }).ping, plain: true });
    expect(unknown).toContain("cost to date: unknown");
    // A reply to it is not routed as a rework note.
    expect(unknown).not.toMatch(/REVIEW GATE|SHIP-REVIEW ESCALATION|HANDOFF —/);
  });
});

// ─── scan wiring (U3) ────────────────────────────────────────────────────────
const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });
const makeCtx = () => ({ remainingMs: 100_000, getRemainingTimeInMillis() { return this.remainingMs; } });
const JIRA = "https://example.atlassian.net";

/**
 * The hub + Jira + Telegram, with state that persists across scans: a comment
 * posted through the hub lands on the Jira read, and a POSTed event lands on
 * the events GET (detail flattened, as transformEvent does).
 */
function makeWorld(fxs) {
  const w = {
    fxs, sent: [], posted: [], comments: {}, events: {},
    eventsFail: false, eventsPostFail: false, jiraFail: false, card: null, jiraReads: [],
  };
  for (const fx of fxs) {
    w.comments[fx.notif.ticketId] = [...(fx.comments || [])];
    w.events[fx.workflowId] = [];
  }
  w.fetch = async (url, o) => {
    const u = String(url);
    const body = o?.body ? JSON.parse(o.body) : null;
    const method = o?.method || "GET";
    if (u === `${HUB}/api/workflow/list`) return jsonRes({ workflows: w.fxs.map(wfOf) });
    let m = /\/api\/workflow\/([^/]+)\/tickets$/.exec(u);
    if (m) return jsonRes({ tickets: w.fxs.filter((f) => f.workflowId === m[1]).map((f) => f.gateTicket) });
    m = /\/api\/workflow\/([^/]+)\/tickets\/comment$/.exec(u);
    if (m) { w.comments[body.ticketId].push(body.content); return jsonRes({ ok: true }); }
    m = /\/api\/workflow\/([^/?]+)\/events$/.exec(u);
    if (m && method === "POST") {
      if (w.eventsPostFail) return jsonRes({ error: "AccessDenied" }, false, 500);
      w.posted.push(body);
      w.events[m[1]].push({ ...body, timestamp: new Date().toISOString(), eventId: `${Date.now()}-escrem-x` });
      return jsonRes({ written: true });
    }
    if (m) return w.eventsFail ? jsonRes({}, false, 500) : jsonRes({ events: w.events[m[1]] });
    if (u.startsWith(`${HUB}/api/workflow/performance?`)) return w.card ? jsonRes({ card: w.card }) : jsonRes({}, false, 404);
    m = /\/rest\/api\/2\/issue\/([^/]+)\/comment/.exec(u);
    if (u.startsWith(JIRA) && m) {
      if (w.jiraFail) return jsonRes({}, false, 503);
      // Jira Cloud pages comments and caps maxResults at 100.
      const q = new URL(u).searchParams;
      const startAt = Number(q.get("startAt") || 0);
      const max = Math.min(Number(q.get("maxResults") || 50), 100);
      const all = w.comments[m[1]] || [];
      w.jiraReads.push(startAt);
      return jsonRes({ startAt, maxResults: max, total: all.length, comments: all.slice(startAt, startAt + max).map((b) => ({ body: b })) });
    }
    if (u.endsWith("/getUpdates")) return jsonRes({ ok: true, result: [] });
    if (u.endsWith("/sendMessage")) {
      if (w.tgFail) return jsonRes({ ok: false, description: "Bad Gateway" }, false, 502);
      w.sent.push(body); return jsonRes({ ok: true, result: { message_id: w.sent.length } }); }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  };
  return w;
}

async function scanAt(handler, world, atMs) {
  vi.setSystemTime(new Date(atMs));
  world.sent.length = 0;
  const before = world.posted.length;
  const ctx = makeCtx();
  global.fetch = async (u, o) => {
    if (String(u).endsWith("/getUpdates")) ctx.remainingMs = 20_000;
    return world.fetch(u, o);
  };
  await handler({}, ctx);
  return { sent: [...world.sent], posted: world.posted.slice(before) };
}
// The per-tier claim rows (escrem#…) also stop a resend; tests that prove a
// LEDGER decides drop them first, as their 30-day TTL eventually would.
const dropReminderClaims = () => { for (const k of [...db.items.keys()]) if (k.startsWith("escrem#")) db.items.delete(k); };
const reminders = (sent) => sent.filter((s) => /ESCALATION — still waiting on your decision/.test(s.text));
const reqMs = (fx) => Date.parse(fx.notif.timestamp);
const iso = (ms) => new Date(ms).toISOString();

describe("scan wiring (U3)", () => {
  let mod;
  beforeEach(async () => {
    vi.useFakeTimers();
    mod = await loadModule();
  });

  it("AC1 TEAM-5389: tier 0 at +4h in hours, once; the +12h tier (07:10Z) held to 16:00Z", async () => {
    const fx = FX["TEAM-5389"];
    const world = makeWorld([fx]);
    const T = reqMs(fx);

    const first = await scanAt(mod.handler, world, T + 60_000);
    expect(first.sent, "the request-time page is unchanged").toHaveLength(1);
    expect(reminders(first.sent)).toHaveLength(0);
    expect((await scanAt(mod.handler, world, T + 4 * H - 60_000)).sent).toHaveLength(0);

    const t0 = await scanAt(mod.handler, world, T + 4 * H);
    expect(reminders(t0.sent)).toHaveLength(1);
    expect(t0.sent).toHaveLength(1);
    const text = t0.sent[0].text.replace(/\\/g, "");
    expect(text).toContain(fx.expect.option);
    expect(text).toContain("1 open: P2 R3-1");
    expect(text).toContain("cost to date: unknown");
    expect(text).toContain("waiting 4h00m");
    expect(world.comments["TEAM-5389"].filter((c) => c.includes(`[escalation-reminder notif=${fx.notif.id} tier=0]`))).toHaveLength(1);
    expect(t0.posted).toEqual([{
      type: "escalation.reminded", gateTicketId: "TEAM-5389", notifId: fx.notif.id,
      tier: 0, dueAt: iso(T + 4 * H), elapsedMs: 4 * H,
    }]);

    for (const at of [T + 4 * H + 60_000, T + 4.5 * H]) {
      const again = await scanAt(mod.handler, world, at);
      expect(again.sent).toHaveLength(0);
      expect(again.posted).toHaveLength(0);
    }
    // Cold start: the memo is gone, the run's events say tier 0 is sent.
    mod._resetEscalationRemindersForTests();
    expect((await scanAt(mod.handler, world, T + 5 * H)).sent).toHaveLength(0);

    expect(iso(T + 12 * H)).toBe("2026-10-07T07:10:00.000Z");
    expect((await scanAt(mod.handler, world, T + 12 * H)).sent, "07:10Z is 00:10 PDT: held").toHaveLength(0);
    expect((await scanAt(mod.handler, world, Date.parse("2026-10-07T15:59:00.000Z"))).sent).toHaveLength(0);

    const t1 = await scanAt(mod.handler, world, Date.parse("2026-10-07T16:00:00.000Z"));
    expect(reminders(t1.sent)).toHaveLength(1);
    expect(t1.posted).toEqual([expect.objectContaining({ tier: 1, dueAt: iso(T + 12 * H), heldFrom: iso(T + 12 * H) })]);
    expect((await scanAt(mod.handler, world, Date.parse("2026-10-07T16:01:00.000Z"))).sent).toHaveLength(0);
  });

  it("AC2 TEAM-5412: the +4h tier is held to window open; +12h fires in hours", async () => {
    const fx = FX["TEAM-5412"];
    const world = makeWorld([fx]);
    const T = reqMs(fx);

    expect((await scanAt(mod.handler, world, T + 60_000)).sent).toHaveLength(1);
    expect((await scanAt(mod.handler, world, T + 4 * H)).sent, "13:00Z is 06:00 PDT: held").toHaveLength(0);

    const open = await scanAt(mod.handler, world, Date.parse("2026-10-07T16:00:00.000Z"));
    expect(open.sent, "one page at 09:00, not the reminder AND the business-hours page").toHaveLength(1);
    expect(reminders(open.sent)).toHaveLength(1);
    expect(open.sent[0].text.replace(/\\/g, "")).toContain("P1 R3-02 regression-of-fix, P2 R3-01");
    expect(open.posted).toEqual([expect.objectContaining({ tier: 0, heldFrom: iso(T + 4 * H) })]);
    // Ship-review escalation keeps its three DECISION buttons.
    expect(JSON.stringify(open.sent[0].reply_markup)).toContain("gdc|m|TEAM-5412");
    expect((await scanAt(mod.handler, world, Date.parse("2026-10-07T16:01:00.000Z"))).sent).toHaveLength(0);

    const t1 = await scanAt(mod.handler, world, T + 12 * H);
    expect(iso(T + 12 * H)).toBe("2026-10-07T21:00:00.000Z");
    expect(reminders(t1.sent)).toHaveLength(1);
    expect(t1.posted).toEqual([expect.objectContaining({ tier: 1, dueAt: iso(T + 12 * H), elapsedMs: 12 * H })]);
    expect(t1.posted[0]).not.toHaveProperty("heldFrom");
    expect(t1.sent[0].text).toContain("waiting 12h00m");
  });

  it("AC3: Merge Approval and an unmarked human:* gate keep their single page", async () => {
    const world = makeWorld([FX["TEAM-5365"], FX.unmarked]);
    const T = reqMs(FX["TEAM-5365"]);
    expect((await scanAt(mod.handler, world, T + 60_000)).sent).toHaveLength(2);
    for (const at of [T + 25 * 60_000, T + 4 * H, T + 24 * H, T + 48 * H]) {
      const s = await scanAt(mod.handler, world, at);
      expect(reminders(s.sent)).toHaveLength(0);
      expect(s.posted).toHaveLength(0);
    }
    expect(world.comments["TEAM-5365"]).toEqual([]);
    expect(world.comments["TEAM-5400"]).toEqual([]);
  });

  it("AC4: nothing emitted is agent.* or manager.intervention", async () => {
    const fx = FX["TEAM-5389"];
    const world = makeWorld([fx]);
    const T = reqMs(fx);
    await scanAt(mod.handler, world, T + 60_000);
    await scanAt(mod.handler, world, T + 4 * H);
    await scanAt(mod.handler, world, Date.parse("2026-10-07T16:00:00.000Z"));
    expect(world.posted.map((p) => p.type)).toEqual(["escalation.reminded", "escalation.reminded"]);
    const busTypes = eb.entries.map((e) => e.DetailType);
    expect(busTypes.filter((t) => t.startsWith("agent.") || t === "manager.intervention")).toEqual([]);
  });

  it("idempotency fallback: events unreadable → the comment footer decides", async () => {
    const fx = FX["TEAM-5389"];
    const world = makeWorld([fx]);
    const T = reqMs(fx);
    await scanAt(mod.handler, world, T + 60_000);
    expect(reminders((await scanAt(mod.handler, world, T + 4 * H)).sent)).toHaveLength(1);

    mod._resetEscalationRemindersForTests();
    dropReminderClaims();
    world.eventsFail = true;
    const s = await scanAt(mod.handler, world, T + 4 * H + 2 * 60_000);
    expect(s.sent, "footer says tier 0 is sent").toHaveLength(0);
  });

  it("events POST failed but the comment landed → the footer still counts (readable-but-empty events do not win)", async () => {
    const fx = FX["TEAM-5389"];
    const world = makeWorld([fx]);
    const T = reqMs(fx);
    await scanAt(mod.handler, world, T + 60_000);
    world.eventsPostFail = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const t0 = await scanAt(mod.handler, world, T + 4 * H);
    err.mockRestore();
    expect(reminders(t0.sent)).toHaveLength(1);
    expect(world.events[fx.workflowId], "the event write failed").toEqual([]);

    mod._resetEscalationRemindersForTests();
    dropReminderClaims();
    world.eventsPostFail = false;
    const again = await scanAt(mod.handler, world, T + 4 * H + 2 * 60_000);
    expect(reminders(again.sent), "events GET is [] but the footer says tier 0").toHaveLength(0);
  });

  it("a footer past the first 100 comments is read (Jira pagination)", async () => {
    const fx = structuredClone(FX["TEAM-5389"]);
    fx.comments = Array.from({ length: 100 }, (_, i) => `chatter ${i}`);
    const world = makeWorld([fx]);
    const T = reqMs(fx);
    await scanAt(mod.handler, world, T + 60_000);
    expect(reminders((await scanAt(mod.handler, world, T + 4 * H)).sent)).toHaveLength(1);
    expect(world.comments["TEAM-5389"]).toHaveLength(101); // the footer is comment #101

    mod._resetEscalationRemindersForTests();
    dropReminderClaims();
    world.eventsFail = true;
    world.jiraReads.length = 0;
    const s = await scanAt(mod.handler, world, T + 4 * H + 2 * 60_000);
    expect(world.jiraReads).toEqual([0, 100]);
    expect(reminders(s.sent), "comment #101 says tier 0 is sent").toHaveLength(0);
  });

  it("two concurrent invocations (two containers, one table) page a tier once", async () => {
    const fx = FX["TEAM-5389"];
    const world = makeWorld([fx]);
    const T = reqMs(fx);
    await scanAt(mod.handler, world, T + 60_000);
    const other = await loadModule(); // a second container: own memo, same PENDING_TABLE
    vi.setSystemTime(new Date(T + 4 * H));
    world.sent.length = 0;
    global.fetch = async (u, o) => world.fetch(u, o);
    const ctxA = makeCtx(); const ctxB = makeCtx();
    ctxA.remainingMs = ctxB.remainingMs = 20_000;
    await Promise.all([mod.handler({}, ctxA), other.handler({}, ctxB)]);
    expect(reminders(world.sent)).toHaveLength(1);
    expect(world.posted.filter((p) => p.tier === 0)).toHaveLength(1);
    expect(db.items.get(`escrem#${fx.notif.id}#0`)?.deliveredAt).toBeTruthy();
  });

  it("a failed send releases the tier claim, so the next scan retries", async () => {
    const fx = FX["TEAM-5389"];
    const world = makeWorld([fx]);
    const T = reqMs(fx);
    await scanAt(mod.handler, world, T + 60_000);
    world.tgFail = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(reminders((await scanAt(mod.handler, world, T + 4 * H)).sent)).toHaveLength(0);
    err.mockRestore(); warn.mockRestore();
    expect(db.items.has(`escrem#${fx.notif.id}#0`)).toBe(false);
    world.tgFail = false;
    expect(reminders((await scanAt(mod.handler, world, T + 4 * H + 60_000)).sent)).toHaveLength(1);
  });

  it("both ledgers unreadable → skip the tick, log it, send nothing", async () => {
    const fx = FX["TEAM-5389"];
    const world = makeWorld([fx]);
    const T = reqMs(fx);
    await scanAt(mod.handler, world, T + 60_000);
    world.eventsFail = true;
    world.jiraFail = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await scanAt(mod.handler, world, T + 4 * H);
    expect(reminders(s.sent)).toHaveLength(0);
    expect(s.posted).toHaveLength(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("skipped: ledger unreadable"))).toBe(true);
    warn.mockRestore();

    // Recovered on the next tick.
    world.eventsFail = false;
    world.jiraFail = false;
    expect(reminders((await scanAt(mod.handler, world, T + 4 * H + 60_000)).sent)).toHaveLength(1);
  });

  it("a zero-cost card renders $0.00, not unknown", async () => {
    const fx = FX["TEAM-5389"];
    const world = makeWorld([fx]);
    world.card = { cost: { totalUsd: 0 } };
    const T = reqMs(fx);
    await scanAt(mod.handler, world, T + 60_000);
    const s = await scanAt(mod.handler, world, T + 4 * H);
    expect(s.sent[0].text).toContain("cost to date: $0.00");
  });

  it("cost comes from the performance card when there is one", async () => {
    const fx = FX["TEAM-5389"];
    const world = makeWorld([fx]);
    world.card = { cost: { totalUsd: 7.5 } };
    const T = reqMs(fx);
    await scanAt(mod.handler, world, T + 60_000);
    const s = await scanAt(mod.handler, world, T + 4 * H);
    expect(s.sent[0].text).toContain("cost to date: $7.50");
  });

  it("a resolved gate never reminds", async () => {
    const fx = structuredClone(FX["TEAM-5389"]);
    const world = makeWorld([fx]);
    const T = reqMs(fx);
    await scanAt(mod.handler, world, T + 60_000);
    fx.gateTicket.status = "Done";
    expect((await scanAt(mod.handler, world, T + 4 * H)).sent).toHaveLength(0);
  });
});
