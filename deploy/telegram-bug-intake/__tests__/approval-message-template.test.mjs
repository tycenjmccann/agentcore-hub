/**
 * TEAM-4660 — every approval ping is composed by ONE builder over structured
 * inputs, so a ping reads the same whoever filed the gate ticket.
 *
 * The bug: an orchestrator-materialized gate ticket is titled
 * "<GateName>: <run title>" and carries a review package, so its ping was clean.
 * A RELEASE-MANAGER-authored gate ticket (deploy gate / handoff) has an
 * agent-written title and a console runbook for a description, and no review
 * package — and the review-gate path rendered both raw: gateLabel's
 * slice(0, 24) fallback put the title in the KICKER, and cleanDesc put 400 chars
 * of runbook in the SUMMARY. A reviewer got
 *   🚦 DEPLOY GATE: APPROVE APP REVIEW GATE — approval needed
 * followed by execution ids and SHAs. Nothing anywhere counted review cycles
 * either, which is why the RM had written "(3×)" into the ticket title.
 *
 * Invariants:
 *  1. The kicker comes from the enum table; no part of a freeform ticket title
 *     and nothing from its description reaches the ping; it stays under the cap;
 *     the reply-routing contract (REVIEW GATE + 🎫 handle) and the buttons hold.
 *  2. A re-paged gate says so ONCE — "Attempt 2 — previous issue: <note>" — with
 *     the reason the bridge itself recorded when it delivered the rejection.
 *  3. A release manager who files a NEW ticket per attempt (TEAM-4656/57/58)
 *     gets the same Attempt line, counted from the sibling gates.
 *  4. The CodePipeline deploy ping keeps its templated brief through the builder,
 *     and its terse fallback is builder-stamped too.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TG_TOKEN = "111111:test-bot-token";
const HUB = "https://hub.example.invalid";
const CHAT = 12345;
const WF = "wf-4660";
const GATE = "TEAM-4658";
const PIPELINE = "agentcore-hub-deploy";
const TOKEN = "approval-token-abcdef-0123456789-way-too-long-for-callback-data-field";

// The verbatim shape that filed the bug: pipeline state, two execution ids, two
// SHAs, a PR pair and an attempt count, all in the TITLE.
const RM_TITLE =
  "Deploy gate: approve Approve_deploy IN THE CODEPIPELINE CONSOLE for 347b9bcb (PR #593) " +
  "then 19688946 (PR #596, main @ 9f6a9e0d) — Telegram ticket approvals did not release it (3×)";
const RM_RUNBOOK = [
  "Two deploys are queued behind this gate. Do them in order.",
  "",
  "1. Open the CodePipeline console for agentcore-hub-deploy.",
  "2. Execution 347b9bcb is still InProgress at Stage: Approval — click Approve_deploy, then Approve.",
  "3. Then execution 19688946 (main @ 9f6a9e0d) needs the same treatment.",
  "",
  "Telegram ticket approvals did not release it (3×): the ManualApproval action is human-only.",
].join("\n");
const RUN_TITLE = "Pipeline arg contract + CI guard";

// ─── AWS SDK mocks (module seam) ──────────────────────────────────────────────

const db = vi.hoisted(() => ({ items: new Map(), puts: [], deletes: [] }));
vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send() { return { FailedEntryCount: 0 }; } },
  PutEventsCommand: class { constructor(input) { this.input = input; } },
}));
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
// A rework note must never reach the classifier; a gate ping never needs it.
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: class { async send() { throw new Error("bedrock must not be called"); } },
  ConverseCommand: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { async send() { const e = new Error("NoSuchKey"); e.name = "NoSuchKey"; throw e; } },
  GetObjectCommand: class { constructor(input) { this.input = input; } },
}));
const cp = vi.hoisted(() => ({ state: null, sends: [] }));
vi.mock("@aws-sdk/client-codepipeline", () => {
  const cmd = (op) => class { constructor(input) { this.input = input; this.op = op; } };
  class CodePipelineClient {
    async send(c) {
      cp.sends.push(c.op);
      if (c.op === "state") return cp.state || { stageStates: [] };
      throw new Error(`unexpected cp op ${c.op}`);
    }
  }
  return { CodePipelineClient, GetPipelineStateCommand: cmd("state"), PutApprovalResultCommand: cmd("put") };
});

// ─── fetch fake ───────────────────────────────────────────────────────────────

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });

function makeNet(ctx, overrides = {}) {
  const net = {
    ctx, polls: 0, batches: [], afterPoll: [], workflows: [], tickets: null,
    sent: [], answered: [], edited: [], transitions: [], github: null, ...overrides,
  };
  net.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : null;
    if (u.startsWith("https://api.github.com/")) {
      if (u.includes("/pulls")) return jsonRes(net.github?.pulls ?? []);
      if (u.includes("/commits/")) return jsonRes(net.github?.commit ?? {});
      return jsonRes({});
    }
    if (u === `${HUB}/api/workflow/list`) return jsonRes({ workflows: net.workflows });
    if (u.endsWith("/tickets/transition")) { net.transitions.push(body); return jsonRes({ success: true }); }
    if (/\/api\/workflow\/[^/]+\/tickets$/.test(u)) {
      return net.tickets ? jsonRes({ tickets: net.tickets }) : jsonRes({}, false, 404);
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
const makeCtx = (startMs = 100_000) => ({ remainingMs: startMs, getRemainingTimeInMillis() { return this.remainingMs; } });

const ENV = {
  TELEGRAM_BOT_TOKEN: TG_TOKEN, JIRA_SITE_URL: "example.atlassian.net", JIRA_EMAIL: "bot@example.com",
  JIRA_API_TOKEN: "t", JIRA_PROJECT_KEY: "TEAM", GITHUB_TOKEN: "t", GITHUB_USER: "test-user",
  PENDING_TABLE: "test-pending-table", HUB_API_URL: HUB, ALLOWED_CHAT_IDS: String(CHAT),
  AWS_REGION: "us-east-1", CHAT_SETTLE_MS: "0",
};
async function loadModule({ pipeline } = {}) {
  vi.resetModules();
  Object.assign(process.env, ENV);
  delete process.env.ARTIFACT_BUCKET;
  if (pipeline == null) delete process.env.DEPLOY_PIPELINE_NAME;
  else process.env.DEPLOY_PIPELINE_NAME = pipeline;
  return import("../index.mjs");
}

const realFetch = global.fetch;
beforeEach(() => {
  db.items.clear(); db.puts.length = 0; db.deletes.length = 0;
  cp.state = null; cp.sends.length = 0;
  db.items.set(`chat#${CHAT}`, { id: { S: `chat#${CHAT}` }, chatId: { N: String(CHAT) } });
});
afterAll(() => {
  global.fetch = realFetch;
  for (const k of [...Object.keys(ENV), "DEPLOY_PIPELINE_NAME"]) delete process.env[k];
});

// ─── fixtures ────────────────────────────────────────────────────────────────

const notif = (id, ts, extra = {}) => ({
  type: "review_needed", acknowledged: false, ticketId: GATE, reviewer: "engineer",
  id, timestamp: ts, ...extra,
});
const wf = (humanNotifications) => ({
  workflowId: WF, phase: "ship", input: { title: RUN_TITLE }, humanNotifications,
});
const rmGateTicket = (createdAt = "2026-09-14T09:00:00.000Z") => ({
  ticketId: GATE, title: RM_TITLE, description: RM_RUNBOOK, status: "in_review",
  assignee: "human:engineer", blockedBy: [], labels: ["deploy-gate"], createdAt,
});
const run = async (handler, overrides) => {
  const ctx = makeCtx();
  const net = makeNet(ctx, overrides);
  global.fetch = net.fetch;
  await handler({}, ctx);
  return net;
};

describe("approval pings are built from structured inputs, never from ticket prose", () => {
  it("a release-manager deploy-gate ticket pings with the enum kicker and no runbook, ids or SHAs", async () => {
    const mod = await loadModule();
    const net = await run(mod.handler, {
      batches: [[]],
      workflows: [wf([notif(`notif_${GATE}_2026-09-14T10:00:00.000Z`, "2026-09-14T10:00:00.000Z")])],
      tickets: [rmGateTicket(), { ticketId: "TEAM-4600", title: "Pipeline arg contract", createdAt: "2026-09-12T09:00:00.000Z" }],
    });

    expect(net.sent).toHaveLength(1);
    const { text, reply_markup: kb } = net.sent[0];

    // 1. the kicker is a table entry keyed off the title PREFIX, nothing more
    expect(text).toMatch(mod.APPROVAL_KICKER_RE);
    expect(text).toMatch(/^\*🚦 DEPLOY REVIEW GATE — approval needed\*/);
    // 2. the body is the RUN, not the ticket
    expect(text).toContain(RUN_TITLE);
    // 3. nothing the release manager wrote leaks — ids, SHAs, console steps,
    //    pipeline state, the attempt count, or any description sentence
    for (const leak of ["347b9bcb", "19688946", "9f6a9e0d", "InProgress", "CODEPIPELINE CONSOLE", "(3×)", "Stage:"]) {
      expect(text, `must not leak ${leak}`).not.toContain(leak);
    }
    expect(text, "esc() would render Approve_deploy as Approve\\_deploy").not.toMatch(/Approve\\?_deploy/);
    expect(text).not.toContain("Two deploys are queued behind this gate");
    expect(text).not.toContain("ManualApproval action is human-only");
    // 4. bounded
    expect(text.length).toBeLessThanOrEqual(mod.APPROVAL_TEXT_MAX);
    // 5. first cycle → no Attempt line
    expect(text).not.toMatch(/Attempt/);
    // 6. the preserved contracts: reply routing (REVIEW GATE + 🎫 handle) …
    expect(text).toContain("REVIEW GATE");
    expect(text).toContain(`🎫 [${GATE}]`);
    // … and the buttons
    const btns = kb.inline_keyboard.flat();
    expect(btns.some((b) => b.callback_data === `gok|${GATE}|${WF}`)).toBe(true);
    expect(btns.some((b) => b.callback_data === `gno|${GATE}|${WF}`)).toBe(true);
    expect(btns.some((b) => b.text === "📱 Open approval in hub")).toBe(true);
  });

  it("a re-parked gate says Attempt 2 ONCE, with the note the bridge delivered", async () => {
    const mod = await loadModule();
    const cycle1 = notif(`notif_${GATE}_2026-09-14T10:00:00.000Z`, "2026-09-14T10:00:00.000Z");
    const cycle2 = notif(`notif_${GATE}_2026-09-14T18:00:00.000Z`, "2026-09-14T18:00:00.000Z");
    const tickets = [rmGateTicket()];

    // Cycle 1 pages.
    const first = await run(mod.handler, { batches: [[]], workflows: [wf([cycle1])], tickets });
    expect(first.sent).toHaveLength(1);
    expect(first.sent[0].text).not.toMatch(/Attempt/);

    // ❌ Request changes, then the note itself → the bridge records the reason.
    const ping = first.sent[0].text;
    await run(mod.handler, {
      batches: [[{
        update_id: 1,
        callback_query: { id: "cb-1", data: `gno|${GATE}|${WF}`, message: { message_id: 7, chat: { id: CHAT }, text: ping } },
      }]],
    });
    const noted = await run(mod.handler, {
      batches: [[{ update_id: 2, message: { message_id: 2, chat: { id: CHAT }, from: { id: CHAT }, text: "the deploy gate must name one execution, not three" } }]],
      afterPoll: [100_000],
    });
    expect(noted.transitions).toHaveLength(1);
    expect(noted.transitions[0]).toMatchObject({ ticketId: GATE, targetStatus: "blocked" });

    // The orchestrator re-parks the same gate: cycle 1 acked, cycle 2 fresh.
    const second = await run(mod.handler, {
      batches: [[]],
      workflows: [wf([{ ...cycle1, acknowledged: true }, cycle2])],
      tickets,
    });

    expect(second.sent).toHaveLength(1);
    const text = second.sent[0].text;
    const attemptLines = text.match(/^Attempt .*$/gm) || [];
    expect(attemptLines).toHaveLength(1);
    expect(attemptLines[0]).toMatch(/^Attempt 2 — previous issue: the deploy gate must name one execution, not three$/);
    expect(text).not.toContain("Attempt 3");
    expect(text.length).toBeLessThanOrEqual(mod.APPROVAL_TEXT_MAX);
    // Still the same clean ping otherwise.
    expect(text).toMatch(mod.APPROVAL_KICKER_RE);
    expect(text).not.toContain("347b9bcb");
  });

  it("a release manager who files a NEW gate ticket per attempt gets the attempt counted", async () => {
    const mod = await loadModule();
    const net = await run(mod.handler, {
      batches: [[]],
      workflows: [wf([notif(`notif_${GATE}_2026-09-14T10:00:00.000Z`, "2026-09-14T10:00:00.000Z")])],
      tickets: [
        rmGateTicket("2026-09-14T09:00:00.000Z"),
        // The two earlier follow-ups for the same execution (TEAM-4656/4657).
        { ticketId: "TEAM-4656", title: "Deploy gate: approve the queued deploy", status: "done", labels: ["deploy-gate"], createdAt: "2026-09-13T09:00:00.000Z" },
        { ticketId: "TEAM-4657", title: "Deploy gate: approve it in the console", status: "done", labels: ["deploy-gate"], createdAt: "2026-09-13T17:00:00.000Z" },
        // Same run, not a gate → must not inflate the count.
        { ticketId: "TEAM-4601", title: "Dev: pipeline arg contract", status: "done", labels: ["dev"], createdAt: "2026-09-12T09:00:00.000Z" },
      ],
    });

    const text = net.sent[0].text;
    expect(text).toMatch(/^Attempt 3 — previous issue: changes requested on the previous attempt$/m);
    expect((text.match(/^Attempt .*$/gm) || [])).toHaveLength(1);
    expect(text.length).toBeLessThanOrEqual(mod.APPROVAL_TEXT_MAX);
  });

  it("the CodePipeline deploy ping keeps its brief, and the terse fallback is builder-stamped", async () => {
    const mod = await loadModule({ pipeline: PIPELINE });
    cp.state = {
      stageStates: [
        { stageName: "Build", actionStates: [{ actionName: "Build", latestExecution: { status: "Succeeded" }, currentRevision: { revisionId: "0cf3f09abc123" } }] },
        { stageName: "Approval", actionStates: [{ actionName: "Approve_deploy", latestExecution: { status: "InProgress", token: TOKEN } }] },
      ],
    };
    const brief = await run(mod.handler, {
      batches: [[]],
      github: {
        commit: { commit: { message: "fix(pipeline): arg contract (TEAM-4563)" }, stats: { additions: 120, deletions: 8 }, files: new Array(6).fill({}) },
        pulls: [{
          number: 593, title: "fix(pipeline): arg contract + CI guard (TEAM-4563)",
          html_url: "https://github.com/o/r/pull/593",
          body: ["## Summary", "Blocks a PR whose buildspec reads a setting the pipeline does not provide."].join("\n"),
        }],
      },
    });

    expect(brief.sent).toHaveLength(1);
    expect(brief.sent[0].text).toMatch(mod.APPROVAL_KICKER_RE);
    expect(brief.sent[0].text).toMatch(/^\*🚀 PRODUCTION DEPLOY — approval needed\*/);
    expect(brief.sent[0].text).toMatch(/Workflow: TEAM-4563/);
    expect(brief.sent[0].text).toMatch(/Scope: 6 files \(\+120\/-8\)/);

    // No commit SHA on the wait → no brief → the terse shape, same builder.
    // A fresh token, or the dep# claim from the brief ping above dedupes it.
    const mod2 = await loadModule({ pipeline: PIPELINE });
    cp.state = {
      stageStates: [
        { stageName: "Approval", actionStates: [{ actionName: "Approve_deploy", latestExecution: { status: "InProgress", token: `${TOKEN}-terse` } }] },
      ],
    };
    const terse = await run(mod2.handler, { batches: [[]] });

    expect(terse.sent).toHaveLength(1);
    const text = terse.sent[0].text;
    expect(text).toMatch(mod2.APPROVAL_KICKER_RE);
    expect(text).toContain(PIPELINE);
    expect(text).not.toMatch(/Workflow:/);
    expect(text).not.toMatch(/Scope:/);
    // A deploy ping must NOT look like a review gate: a reply to it would
    // otherwise be filed as a rework note against whatever key it mentions.
    expect(text).not.toContain("REVIEW GATE");
    expect(text).not.toContain("Changes requested");
  });
});
