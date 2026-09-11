/**
 * TEAM-4453 D3 — working-hours gate paging.
 *
 * A gate page fires the moment the gate opens, 02:00 Saturday included. That is
 * deliberate and must never change: the invariant under test is that the
 * request-time page is UNCONDITIONAL, and the window only ADDS two things.
 *
 *  1. `gate.requested` on EventBridge, exactly once per notification, carrying
 *     whether the human was asked outside their window and when that window next
 *     opens — the record the metrics side needs to tell "the reviewer was
 *     asleep" from "the reviewer was slow".
 *  2. Exactly ONE reminder page per notification, when the window opens and the
 *     gate is still open. Not one per scan, not one per day, and never a second
 *     one for the same notification.
 *
 * The clock is faked so the scans below are the real ones a poller would run:
 * the notification's timestamp and `Date.now()` are the only inputs that decide
 * anything. All fixed instants are chosen around America/Los_Angeles (the
 * default window): 09:00 PDT = 16:00Z, 09:00 PST = 17:00Z.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

const TG_TOKEN = "111111:test-bot-token";
const HUB = "https://hub.example.invalid";

const db = vi.hoisted(() => ({ items: new Map(), puts: [], deletes: [] }));
const eb = vi.hoisted(() => ({ entries: [], fail: false }));

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
  PutApprovalResultCommand: class { constructor(input) { this.input = input; } },
}));

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });

function makeNet(ctx, workflows, opts = {}) {
  const net = { ctx, workflows, sent: [], tickets: opts.tickets || null, sendThrowsFor: opts.sendThrowsFor || null };
  net.fetch = async (url, o) => {
    const u = String(url);
    const body = o?.body ? JSON.parse(o.body) : null;
    if (u === `${HUB}/api/workflow/list`) return jsonRes({ workflows: net.workflows });
    if (/\/api\/workflow\/[^/]+\/tickets$/.test(u)) {
      return net.tickets ? jsonRes({ tickets: net.tickets }) : jsonRes({}, false, 404);
    }
    if (u.endsWith("/getUpdates")) { net.ctx.remainingMs = 20_000; return jsonRes({ ok: true, result: [] }); }
    if (u.endsWith("/sendMessage")) {
      if (net.sendThrowsFor && net.sendThrowsFor(body)) throw new Error("Telegram 502");
      net.sent.push(body);
      return jsonRes({ ok: true, result: {} });
    }
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
const WINDOW_ENV = ["WM_BUSINESS_TZ", "WM_BUSINESS_HOURS", "EVENT_BUS"];

/** Fresh module (so businessWindow re-reads the env) + the exported helpers. */
async function loadModule(over = {}) {
  vi.resetModules();
  Object.assign(process.env, ENV);
  delete process.env.ARTIFACT_BUCKET;
  delete process.env.DEPLOY_PIPELINE_NAME;
  for (const k of WINDOW_ENV) delete process.env[k];
  Object.assign(process.env, over);
  return import("../index.mjs");
}
const loadHandler = async (over) => (await loadModule(over)).handler;

const realFetch = global.fetch;
beforeEach(() => {
  db.items.clear(); db.puts.length = 0; db.deletes.length = 0;
  eb.entries.length = 0; eb.fail = false;
  db.items.set("chat#12345", { id: { S: "chat#12345" }, chatId: { N: "12345" } });
});
afterEach(() => { vi.useRealTimers(); });
afterAll(() => {
  global.fetch = realFetch;
  for (const k of [...Object.keys(ENV), ...WINDOW_ENV]) delete process.env[k];
});

const notif = (ticketId, id, timestamp) => ({
  type: "review_needed", acknowledged: false, ticketId, reviewer: "engineer",
  ...(id ? { id } : {}), ...(timestamp === undefined ? {} : { timestamp }),
});
const wf = (humanNotifications, phase = "ship") => ({ workflowId: "wf-1", phase, input: { title: "Multi-CD" }, humanNotifications });

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
const requested = () => eb.entries.filter((e) => e.DetailType === "gate.requested");
const detailOf = (entry) => JSON.parse(entry.Detail);

// Wed 2026-09-09 00:10 PDT — well outside the 09-18 window.
const OUT_OF_HOURS = "2026-09-09T07:10:00.000Z";
// The window opening that follows it: Wed 09:00 PDT.
const WINDOW_OPENS = "2026-09-09T16:00:00.000Z";
// Wed 2026-09-09 14:00 PDT — inside it.
const IN_HOURS = "2026-09-09T21:00:00.000Z";

describe("request-time page + gate.requested", () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it("(1) pages an out-of-hours gate immediately and publishes ONE gate.requested with the window context", async () => {
    const handler = await loadHandler();
    const n = notif("TEAM-1", "notif_TEAM-1_a", OUT_OF_HOURS);

    const net = await scanAt(handler, "2026-09-09T07:11:00.000Z", [wf([n])]);

    expect(net.sent, "the 00:10 page is never delayed").toHaveLength(1);
    expect(db.items.has("gate#notif_TEAM-1_a")).toBe(true);
    expect(requested()).toHaveLength(1);
    expect(requested()[0]).toMatchObject({
      EventBusName: "default",
      Source: "agentcore-hub.orchestrator",
      DetailType: "gate.requested",
    });
    expect(detailOf(requested()[0])).toEqual({
      ticketId: "TEAM-1",
      workflowId: "wf-1",
      reviewer: "engineer",
      requestedAt: OUT_OF_HOURS,
      outsideHours: true,
      nextBusinessOpenAt: WINDOW_OPENS,
      producer: "telegram-bug-intake",
      timestamp: "2026-09-09T07:11:00.000Z",
    });
  });

  it("(4) an in-hours gate is tagged outsideHours:false and never earns a reminder", async () => {
    const handler = await loadHandler();
    const n = notif("TEAM-4", "notif_TEAM-4_a", IN_HOURS);

    const first = await scanAt(handler, "2026-09-09T21:01:00.000Z", [wf([n])]);
    expect(first.sent).toHaveLength(1);
    const d = detailOf(requested()[0]);
    expect(d.outsideHours).toBe(false);
    // In-hours → the window is already open, so nextBusinessOpenAt is the ask itself.
    expect(d.nextBusinessOpenAt).toBe(IN_HOURS);

    // The next opening comes and goes: still no reminder, no repage claim.
    const later = await scanAt(handler, "2026-09-10T16:00:30.000Z", [wf([n])]);
    expect(later.sent).toHaveLength(0);
    expect(keys("repage#")).toEqual([]);
  });

  it("(11) a notification with no timestamp is published as unknown and never reminded", async () => {
    const handler = await loadHandler();
    const n = notif("TEAM-11", "notif_TEAM-11_a", undefined);

    const first = await scanAt(handler, OUT_OF_HOURS, [wf([n])]);
    expect(first.sent).toHaveLength(1);
    const d = detailOf(requested()[0]);
    expect(d.requestedAt).toBeNull();
    expect(d.outsideHours, "unknown must not read as inside").toBeNull();
    expect(d.nextBusinessOpenAt).toBeNull();

    const later = await scanAt(handler, WINDOW_OPENS, [wf([n])]);
    expect(later.sent).toHaveLength(0);
    expect(keys("repage#")).toEqual([]);
  });

  it("(13) a PutEvents failure does not re-send the page, keep the gate claim, or throw", async () => {
    const handler = await loadHandler();
    eb.fail = true;
    const n = notif("TEAM-13", "notif_TEAM-13_a", OUT_OF_HOURS);

    const first = await scanAt(handler, "2026-09-09T07:11:00.000Z", [wf([n])]);
    expect(first.sent).toHaveLength(1);
    expect(db.items.has("gate#notif_TEAM-13_a"), "the claim must survive a publish failure").toBe(true);
    expect(db.deletes).toEqual([]);

    // The page is not re-sent on the next scan — the claim held.
    eb.fail = false;
    const second = await scanAt(handler, "2026-09-09T07:12:00.000Z", [wf([n])]);
    expect(second.sent).toHaveLength(0);
    expect(requested()).toHaveLength(0);
  });

  it("(14) a terminal-phase run is neither paged nor published", async () => {
    const handler = await loadHandler();
    const net = await scanAt(handler, WINDOW_OPENS, [wf([notif("OLD-1", "notif_OLD-1_a", OUT_OF_HOURS)], "complete")]);
    expect(net.sent).toHaveLength(0);
    expect(eb.entries).toEqual([]);
    expect(keys("gate#")).toEqual([]);
    expect(keys("repage#")).toEqual([]);
  });

  it("(2) EVENT_BUS routes the event to the configured bus", async () => {
    const handler = await loadHandler({ EVENT_BUS: "agentcore-hub" });
    await scanAt(handler, "2026-09-09T07:11:00.000Z", [wf([notif("TEAM-B", "notif_TEAM-B_a", OUT_OF_HOURS)])]);
    expect(requested()[0].EventBusName).toBe("agentcore-hub");
  });
});

describe("business-hours reminder", () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it("(2) re-pages once when the window opens, and publishes no second gate.requested", async () => {
    const handler = await loadHandler();
    const n = notif("TEAM-2", "notif_TEAM-2_a", OUT_OF_HOURS);
    const w = [wf([n])];

    const first = await scanAt(handler, "2026-09-09T07:11:00.000Z", w);
    expect(first.sent).toHaveLength(1);

    const reminder = await scanAt(handler, "2026-09-09T16:00:30.000Z", w);
    expect(reminder.sent).toHaveLength(1);
    expect(reminder.sent[0].text).toContain("business-hours reminder");
    expect(reminder.sent[0].text).toContain("TEAM-2");
    // Actionable: the reminder carries the same decision buttons as the page.
    expect(JSON.stringify(reminder.sent[0].reply_markup)).toContain("gok|TEAM-2|wf-1");
    expect(db.items.has("repage#notif_TEAM-2_a")).toBe(true);
    expect(requested(), "the reminder is not a new request").toHaveLength(1);
    // TEAM-4461: the request-time page's own claim is stamped BEFORE the window
    // opened, which is exactly what makes this a genuine (reminder-worthy) case.
    expect(db.items.get("gate#notif_TEAM-2_a").pagedAt.S).toBe("2026-09-09T07:11:00.000Z");
  });

  // TEAM-4461 F4 — the request-time page itself landed inside the window, either
  // because the gate opened just before it (A) or because delivery was delayed
  // past the opening, e.g. a notifier outage (B). Neither earns a reminder: the
  // human already has the page, in hours.
  it("(A) a gate requested 08:59 and paged by the 09:00 scan earns no reminder", async () => {
    const handler = await loadHandler();
    const REQUESTED_08_59 = "2026-09-09T15:59:00.000Z"; // Wed 08:59 PDT — outside
    const n = notif("TEAM-15", "notif_TEAM-15_a", REQUESTED_08_59);
    const w = [wf([n])];

    const first = await scanAt(handler, "2026-09-09T16:00:30.000Z", w); // Wed 09:00:30 PDT
    expect(first.sent).toHaveLength(1);
    expect(db.items.get("gate#notif_TEAM-15_a").pagedAt.S).toBe("2026-09-09T16:00:30.000Z");
    const d = detailOf(requested()[0]);
    expect(d.outsideHours).toBe(true);
    expect(d.nextBusinessOpenAt).toBe(WINDOW_OPENS);

    const later = await scanAt(handler, "2026-09-09T16:01:00.000Z", w);
    expect(later.sent).toHaveLength(0);
    expect(keys("repage#")).toEqual([]);
  });

  it("(B) a request-time page delayed past the opening (e.g. notifier outage) earns no reminder", async () => {
    const handler = await loadHandler();
    const REQUESTED_03_00 = "2026-09-09T10:00:00.000Z"; // Wed 03:00 PDT — outside
    const n = notif("TEAM-16", "notif_TEAM-16_a", REQUESTED_03_00);
    const w = [wf([n])];

    // Delivery didn't happen until the 10:00 PDT scan — already inside the window.
    const first = await scanAt(handler, "2026-09-09T17:00:00.000Z", w);
    expect(first.sent).toHaveLength(1);
    expect(db.items.get("gate#notif_TEAM-16_a").pagedAt.S).toBe("2026-09-09T17:00:00.000Z");

    const later = await scanAt(handler, "2026-09-09T17:01:00.000Z", w);
    expect(later.sent).toHaveLength(0);
    expect(keys("repage#")).toEqual([]);
  });

  it("(3) a later scan in the same window sends nothing", async () => {
    const handler = await loadHandler();
    const n = notif("TEAM-3", "notif_TEAM-3_a", OUT_OF_HOURS);
    const w = [wf([n])];

    await scanAt(handler, "2026-09-09T07:11:00.000Z", w);
    expect((await scanAt(handler, "2026-09-09T16:00:30.000Z", w)).sent).toHaveLength(1);
    expect((await scanAt(handler, "2026-09-09T16:01:00.000Z", w)).sent).toHaveLength(0);
  });

  it("(3b) the NEXT day's opening does not re-remind — one per notification, not per day", async () => {
    const handler = await loadHandler();
    const n = notif("TEAM-3b", "notif_TEAM-3b_a", OUT_OF_HOURS);
    const w = [wf([n])];

    await scanAt(handler, "2026-09-09T07:11:00.000Z", w);
    expect((await scanAt(handler, "2026-09-09T16:00:30.000Z", w)).sent).toHaveLength(1);
    expect((await scanAt(handler, "2026-09-10T16:00:00.000Z", w)).sent).toHaveLength(0);
    expect(keys("repage#")).toEqual(["repage#notif_TEAM-3b_a"]);
  });

  it("(3c) the same gate re-parked after rework (new notif.id) gets a fresh page AND a fresh reminder", async () => {
    const handler = await loadHandler();
    const cycle1 = notif("TEAM-3c", "notif_TEAM-3c_a", OUT_OF_HOURS);
    await scanAt(handler, "2026-09-09T07:11:00.000Z", [wf([cycle1])]);
    await scanAt(handler, "2026-09-09T16:00:30.000Z", [wf([cycle1])]);

    // Rework → re-park with a fresh id, again out of hours (Thu 00:10 PDT).
    const cycle2 = notif("TEAM-3c", "notif_TEAM-3c_b", "2026-09-10T07:10:00.000Z");
    const both = [wf([{ ...cycle1, acknowledged: true }, cycle2])];
    const page2 = await scanAt(handler, "2026-09-10T07:11:00.000Z", both);
    expect(page2.sent).toHaveLength(1);
    expect(requested()).toHaveLength(2);

    const reminder2 = await scanAt(handler, "2026-09-10T16:00:30.000Z", both);
    expect(reminder2.sent).toHaveLength(1);
    expect(reminder2.sent[0].text).toContain("business-hours reminder");
    expect(keys("repage#").sort()).toEqual(["repage#notif_TEAM-3c_a", "repage#notif_TEAM-3c_b"]);
  });

  it("(5) an acknowledged (or vanished) notification is not reminded", async () => {
    const handler = await loadHandler();
    const n = notif("TEAM-5", "notif_TEAM-5_a", OUT_OF_HOURS);
    await scanAt(handler, "2026-09-09T07:11:00.000Z", [wf([n])]);

    const acked = await scanAt(handler, WINDOW_OPENS, [wf([{ ...n, acknowledged: true }])]);
    expect(acked.sent).toHaveLength(0);
    const gone = await scanAt(handler, WINDOW_OPENS, [wf([])]);
    expect(gone.sent).toHaveLength(0);
    expect(keys("repage#")).toEqual([]);
  });

  it("(6) a gate resolved from the board is claimed but not nagged", async () => {
    const handler = await loadHandler();
    const n = notif("TEAM-6", "notif_TEAM-6_a", OUT_OF_HOURS);
    const w = [wf([n])];
    await scanAt(handler, "2026-09-09T07:11:00.000Z", w);

    const tickets = [{ ticketId: "TEAM-6", title: "Merge Approval: Multi-CD", status: "done" }];
    const net = await scanAt(handler, "2026-09-09T16:00:30.000Z", w, { tickets });
    expect(net.sent).toHaveLength(0);
    // The claim is kept: there is nothing to remind about, ever.
    expect(db.items.has("repage#notif_TEAM-6_a")).toBe(true);
    expect(db.deletes).toEqual([]);
  });

  it("(12) a failing reminder releases only its own claim and the next gate still pages", async () => {
    const handler = await loadHandler();
    const stale = notif("TEAM-12", "notif_TEAM-12_a", OUT_OF_HOURS);
    await scanAt(handler, "2026-09-09T07:11:00.000Z", [wf([stale])]);
    expect(db.items.has("gate#notif_TEAM-12_a")).toBe(true);

    // Same scan: the reminder for gate 1 throws, gate 2 is brand new.
    const fresh = notif("TEAM-12b", "notif_TEAM-12b_a", IN_HOURS);
    const net = await scanAt(handler, "2026-09-09T16:00:30.000Z", [wf([stale, fresh])], {
      sendThrowsFor: (body) => String(body?.text || "").includes("business-hours reminder"),
    });

    expect(db.items.has("repage#notif_TEAM-12_a"), "a failed reminder must be retryable").toBe(false);
    expect(db.deletes).toContain("repage#notif_TEAM-12_a");
    expect(net.sent, "gate 2's request-time page still went out").toHaveLength(1);
    expect(net.sent[0].text).toContain("TEAM-12b");
    expect(db.items.has("gate#notif_TEAM-12b_a")).toBe(true);
  });
});

describe("window configuration", () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it("(9) an unknown WM_BUSINESS_TZ warns once and falls back to America/Los_Angeles", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = await loadHandler({ WM_BUSINESS_TZ: "Mars/Olympus" });
    const n = notif("TEAM-9", "notif_TEAM-9_a", OUT_OF_HOURS);

    const net = await scanAt(handler, "2026-09-09T07:11:00.000Z", [wf([n])]);
    expect(net.sent, "a bad zone must never cost the page").toHaveLength(1);
    // LA was used: 00:10 PDT is out of hours and the window opens at 16:00Z.
    expect(detailOf(requested()[0])).toMatchObject({ outsideHours: true, nextBusinessOpenAt: WINDOW_OPENS });

    const notes = warn.mock.calls.map((c) => String(c[0])).filter((s) => s.includes("WM_BUSINESS_TZ"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("America/Los_Angeles");
    expect(notes[0]).toContain("request-time gate pages are unaffected");

    // Memoized: a second scan does not warn again.
    await scanAt(handler, "2026-09-09T07:12:00.000Z", [wf([n])]);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("WM_BUSINESS_TZ"))).toHaveLength(1);
    warn.mockRestore();
  });

  it("(10) an unparseable WM_BUSINESS_HOURS warns and falls back to 09-18", async () => {
    for (const bad of ["9to5", "18-08", "25-30", ""]) {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      db.items.clear(); db.items.set("chat#12345", { id: { S: "chat#12345" }, chatId: { N: "12345" } });
      eb.entries.length = 0;

      const handler = await loadHandler({ WM_BUSINESS_HOURS: bad });
      const net = await scanAt(handler, "2026-09-09T07:11:00.000Z", [wf([notif("TEAM-10", "notif_TEAM-10_a", OUT_OF_HOURS)])]);

      expect(net.sent, `"${bad}" must not cost the page`).toHaveLength(1);
      expect(detailOf(requested()[0]), `"${bad}" must fall back to 09-18`)
        .toMatchObject({ outsideHours: true, nextBusinessOpenAt: WINDOW_OPENS });
      const notes = warn.mock.calls.map((c) => String(c[0])).filter((s) => s.includes("WM_BUSINESS_HOURS"));
      expect(notes, `"${bad}" must warn exactly once`).toHaveLength(1);
      expect(notes[0]).toContain("9-18");
      warn.mockRestore();
    }
  });

  it("a valid WM_BUSINESS_HOURS / WM_BUSINESS_TZ pair is honoured", async () => {
    const handler = await loadHandler({ WM_BUSINESS_HOURS: "06-14", WM_BUSINESS_TZ: "UTC" });
    // 07:10Z is inside 06-14 UTC, so the same instant is now IN hours.
    await scanAt(handler, "2026-09-09T07:11:00.000Z", [wf([notif("TEAM-TZ", "notif_TEAM-TZ_a", OUT_OF_HOURS)])]);
    expect(detailOf(requested()[0])).toMatchObject({ outsideHours: false, nextBusinessOpenAt: OUT_OF_HOURS });
  });
});

/**
 * The two pure helpers, exercised directly — the weekend hop and the DST
 * boundaries are the cases a scan-level test can only reach one instant at a
 * time, and getting them wrong sends a "business-hours reminder" at 02:00.
 */
describe("isOutsideHours / nextBusinessOpenAt", () => {
  let isOutsideHours, nextBusinessOpenAt;
  beforeEach(async () => { ({ isOutsideHours, nextBusinessOpenAt } = await loadModule()); });

  const openAt = (ts) => nextBusinessOpenAt(ts).toISOString();

  it("classifies in-hours, before, after, and weekend", () => {
    expect(isOutsideHours(IN_HOURS)).toBe(false);                       // Wed 14:00 PDT
    expect(isOutsideHours("2026-09-09T16:00:00.000Z")).toBe(false);     // Wed 09:00 — inclusive start
    expect(isOutsideHours("2026-09-09T15:59:00.000Z")).toBe(true);      // Wed 08:59
    expect(isOutsideHours("2026-09-10T01:00:00.000Z")).toBe(true);      // Wed 18:00 — exclusive end
    expect(isOutsideHours("2026-09-12T20:00:00.000Z")).toBe(true);      // Sat 13:00
    expect(isOutsideHours("2026-09-13T20:00:00.000Z")).toBe(true);      // Sun 13:00
  });

  it("returns null for a missing or unparseable timestamp", () => {
    expect(isOutsideHours(undefined)).toBeNull();
    expect(isOutsideHours(null)).toBeNull();
    expect(isOutsideHours("")).toBeNull();
    expect(isOutsideHours("not a date")).toBeNull();
    expect(nextBusinessOpenAt(undefined)).toBeNull();
    expect(nextBusinessOpenAt("not a date")).toBeNull();
  });

  it("returns the instant itself when it is already in-hours", () => {
    expect(openAt(IN_HOURS)).toBe(IN_HOURS);
  });

  it("(7) Friday evening and Saturday both hop to Monday 09:00", () => {
    expect(openAt("2026-09-12T02:00:00.000Z")).toBe("2026-09-14T16:00:00.000Z"); // Fri 19:00 PDT
    expect(openAt("2026-09-12T20:00:00.000Z")).toBe("2026-09-14T16:00:00.000Z"); // Sat 13:00 PDT
    expect(openAt("2026-09-13T20:00:00.000Z")).toBe("2026-09-14T16:00:00.000Z"); // Sun 13:00 PDT
  });

  it("(7) an early weekday morning opens the same day", () => {
    expect(openAt(OUT_OF_HOURS)).toBe(WINDOW_OPENS);                            // Wed 00:10 PDT
    expect(openAt("2026-09-10T01:00:00.000Z")).toBe("2026-09-10T16:00:00.000Z"); // Wed 18:00 → Thu 09:00
  });

  it("(8) DST: 09:00 local is 17:00Z under PST and 16:00Z under PDT", () => {
    // Spring forward is Sun 2026-03-08.
    expect(openAt("2026-03-06T09:00:00.000Z")).toBe("2026-03-06T17:00:00.000Z"); // Fri 01:00 PST → 09:00 PST
    expect(openAt("2026-03-07T20:00:00.000Z")).toBe("2026-03-09T16:00:00.000Z"); // Sat PST → Mon 09:00 PDT
    // Fall back is Sun 2026-11-01.
    expect(openAt("2026-10-30T08:00:00.000Z")).toBe("2026-10-30T16:00:00.000Z"); // Fri 01:00 PDT → 09:00 PDT
    expect(openAt("2026-10-31T20:00:00.000Z")).toBe("2026-11-02T17:00:00.000Z"); // Sat PDT → Mon 09:00 PST
  });

  it("honours an explicit window argument without touching the env", () => {
    const utcNights = { timeZone: "UTC", start: 22, end: 24, days: [0, 1, 2, 3, 4, 5, 6] };
    expect(isOutsideHours("2026-09-12T22:30:00.000Z", utcNights)).toBe(false); // Saturday counts
    expect(isOutsideHours("2026-09-12T21:30:00.000Z", utcNights)).toBe(true);
    expect(nextBusinessOpenAt("2026-09-12T21:30:00.000Z", utcNights).toISOString()).toBe("2026-09-12T22:00:00.000Z");
  });
});
