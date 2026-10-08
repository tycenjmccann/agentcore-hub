/**
 * TEAM-5423 — escalation, round-cap and decision gates are re-paged at 4h, 12h
 * and every 12h of wait, held to working hours, on the existing Telegram +
 * ticket-comment path, with one `escalation.reminded` run event per reminder.
 *
 * Fixtures (fixtures/escalation-gates.json) carry the acceptance facts of
 * TEAM-5389, TEAM-5412 and TEAM-5365. Instants are around the default window,
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
    expect(R2.costToDate({ cost: { totalUsd: 0 } })).toBe("unknown");
    const unknown = mod._buildApprovalMessageForTests({ ...R2.buildEscalationReminder({
      wf: wfOf(fx), notif: fx.notif, gateTicket: fx.gateTicket, tier: 1, elapsedMs: 12 * H,
    }).ping, plain: true });
    expect(unknown).toContain("cost to date: unknown");
    // A reply to it is not routed as a rework note.
    expect(unknown).not.toMatch(/REVIEW GATE|SHIP-REVIEW ESCALATION|HANDOFF —/);
  });
});
