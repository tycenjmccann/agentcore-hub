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
    sent: [], answered: [], edited: [], transitions: [], github: null,
    transitionStatus: 200, transitionBody: null, ...overrides,
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
    if (u.endsWith("/tickets/transition")) {
      net.transitions.push(body);
      if (net.transitionStatus !== 200) {
        return jsonRes(net.transitionBody || { error: "Ticket transition rejected" }, false, net.transitionStatus);
      }
      return jsonRes({ success: true });
    }
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
const wf = (humanNotifications, extra = {}) => ({
  workflowId: WF, phase: "ship", input: { title: RUN_TITLE }, humanNotifications, ...extra,
});
// The only pre-completion PR signal on the wire: what the dev agent landed.
// `wf.delivery` is written by completeWorkflow, i.e. after the phase this scan
// skips, so it can never be the source here.
const AGENT_TASKS = {
  "TEAM-4600": { ticketId: "TEAM-4600", agentId: "developer", status: "complete", prUrl: "https://github.com/o/r/pull/593", completedAt: "2026-09-13T12:00:00.000Z" },
};
const shipped = (extra = {}) => ({ ticketId: "TEAM-4600", title: "Pipeline arg contract", status: "done", createdAt: "2026-09-12T09:00:00.000Z", ...extra });
// N upstream tickets under one gate. Neutral titles on purpose: a title whose
// prefix is in GATE_TITLE_KINDS would be read as a sibling gate attempt.
const upstreamN = (n) => Array.from({ length: n }, (_, i) => ({
  ticketId: `TEAM-46${String(i).padStart(2, "0")}`, title: `Upstream work ${i}`,
  status: "done", createdAt: `2026-09-12T09:${String(i).padStart(2, "0")}:00.000Z`,
}));
const landedTasks = (tickets) => Object.fromEntries(tickets.map((t, i) => [t.ticketId, {
  ticketId: t.ticketId, agentId: "developer", status: "complete",
  prUrl: `https://github.com/o/r/pull/${500 + i}`,
  completedAt: `2026-09-13T12:${String(i).padStart(2, "0")}:00.000Z`,
}]));
// The rendered items, with the "+N more" tail stripped off first (a lazy regex
// group can't do this reliably — `$` pulls it to end-of-line).
const shippingItemsOf = (text) => {
  const m = text.match(/shipping: (.*)$/m);
  return m ? m[1].replace(/ \+\d+ more$/, "").split(", ").filter(Boolean) : [];
};
const rmGateTicket = (createdAt = "2026-09-14T09:00:00.000Z") => ({
  ticketId: GATE, title: RM_TITLE, description: RM_RUNBOOK, status: "in_review",
  assignee: "human:engineer", blockedBy: [], labels: ["deploy-gate"], createdAt,
});
/**
 * A release-manager deploy gate for ONE target. The target is the gate key:
 * the specifics (execution, PR, SHA) go after the em dash, so two attempts at
 * the same target share a key and a parallel deploy of a different target does
 * not. Defaults to a resolved earlier sibling.
 */
const dgate = (ticketId, target, createdAt, extra = {}) => ({
  ticketId, title: `Deploy gate: ${target} — ${ticketId} (PR #593, main @ 9f6a9e0d)`,
  description: RM_RUNBOOK, status: "done", assignee: "human:engineer",
  blockedBy: [], labels: ["deploy-gate"], createdAt, ...extra,
});
/** What the bridge itself records when it delivers a ❌ + note (gaterework#<id>). */
const REJECTION = "the deploy gate must name one execution, not three";
const seedRework = (ticketId, reason = REJECTION) =>
  db.items.set(`gaterework#${ticketId}`, {
    id: { S: `gaterework#${ticketId}` }, reason: { S: reason }, at: { S: "2026-09-13T18:00:00.000Z" },
  });
const attemptLinesOf = (text) => text.match(/^Attempt .*$/gm) || [];
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
      workflows: [wf([notif(`notif_${GATE}_2026-09-14T10:00:00.000Z`, "2026-09-14T10:00:00.000Z")], { agentTasks: AGENT_TASKS })],
      tickets: [rmGateTicket(), shipped()],
    });

    expect(net.sent).toHaveLength(1);
    const { text, reply_markup: kb } = net.sent[0];

    // 1. the kicker is a table entry keyed off the title PREFIX, nothing more
    expect(text).toMatch(mod.APPROVAL_KICKER_RE);
    expect(text).toMatch(/^\*🚦 DEPLOY REVIEW GATE — approval needed\*/);
    // 2. the body is the RUN, not the ticket — plus WHAT is shipping, which for
    //    a gate with no blockedBy comes from the run's landed PRs (TEAM-4671 F3)
    expect(text).toContain(RUN_TITLE);
    expect(text).toContain("shipping: Pipeline arg contract");
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

  /**
   * TEAM-4671 F3. `blockedBy` is an array in dynamodb mode and a comma-joined
   * STRING in jira mode (jira-read.ts:145), so .map() threw a TypeError the
   * caller's catch swallowed — every Jira-mode gate paged with no shipping list
   * at all, silently. The upstream work is the whole point of the line: it is
   * what the reviewer is being asked to approve.
   */
  it("the upstream work is listed whether blockedBy is an array or a comma-joined string", async () => {
    const upstream = [
      shipped(),
      { ticketId: "TEAM-4601", title: "CI guard for buildspec args", status: "done", createdAt: "2026-09-12T10:00:00.000Z" },
    ];
    for (const blockedBy of [["TEAM-4600", "TEAM-4601"], "TEAM-4600,TEAM-4601", "TEAM-4600, TEAM-4601"]) {
      db.items.clear();
      db.items.set(`chat#${CHAT}`, { id: { S: `chat#${CHAT}` }, chatId: { N: String(CHAT) } });
      const mod = await loadModule();
      const text = (await run(mod.handler, {
        batches: [[]],
        workflows: [wf([notif(`notif_${GATE}_2026-09-14T10:00:00.000Z`, "2026-09-14T10:00:00.000Z")])],
        tickets: [{ ...rmGateTicket(), blockedBy }, ...upstream],
      })).sent[0].text;

      expect(text, `blockedBy=${JSON.stringify(blockedBy)}`).toContain("shipping: Pipeline arg contract, CI guard for buildspec args");
      expect(text.length).toBeLessThanOrEqual(mod.APPROVAL_TEXT_MAX);
    }
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

  /**
   * TEAM-4671 robustness. `oneLine(s) = String(s ?? "").replace(...).trim()`
   * never throws and always returns a string, so `gateKey(self?.title)` is
   * safe even when `self` is undefined — but prove the OUTCOME that matters:
   * a tickets-view outage must not fall through to the try/catch's `attempt: 1`
   * and silently wipe out the notif-derived count, which needs no ticket at
   * all (it only walks `wf.humanNotifications`).
   */
  it("a tickets-view outage does not reset the notif-derived attempt count", async () => {
    const mod = await loadModule();
    const cycle1 = notif(`notif_${GATE}_2026-09-14T10:00:00.000Z`, "2026-09-14T10:00:00.000Z", { acknowledged: true });
    const cycle2 = notif(`notif_${GATE}_2026-09-14T18:00:00.000Z`, "2026-09-14T18:00:00.000Z");
    // No `tickets` override → the /tickets endpoint 404s (net.tickets is null),
    // so gateTicketOf degrades to { gateTicket: null, tickets: [] }. The ping
    // must still go out, keyed on the notif's own ticketId as the title.
    const { sent } = await run(mod.handler, { batches: [[]], workflows: [wf([cycle1, cycle2])] });

    expect(sent).toHaveLength(1);
    expect(attemptLinesOf(sent[0].text)).toEqual(["Attempt 2"]);
  });

  /**
   * TEAM-4671 F1. A release manager files a NEW ticket per attempt, so the
   * sibling tickets ARE the cycle history — but only where a rejection was
   * actually recorded. The counter used to match on the title PREFIX alone
   * ("deploy gate") with no evidence at all, and then asserted a reason it had
   * invented, so a first-ever page for one deploy claimed the human had
   * rejected it because a DIFFERENT deploy existed in the same run.
   */
  const pagedNotif = () => notif(`notif_${GATE}_2026-09-14T10:00:00.000Z`, "2026-09-14T10:00:00.000Z");
  const pageGate = async (mod, tickets) => (await run(mod.handler, {
    batches: [[]], workflows: [wf([pagedNotif()])], tickets,
  })).sent[0].text;

  it("counts an earlier attempt at the SAME target only when a rejection was recorded, and quotes it", async () => {
    const mod = await loadModule();
    seedRework("TEAM-4657"); // the ❌ + note the bridge delivered on that ticket
    const text = await pageGate(mod, [
      dgate(GATE, "the queued deploy", "2026-09-14T09:00:00.000Z", { status: "in_review" }),
      dgate("TEAM-4657", "the queued deploy", "2026-09-13T17:00:00.000Z"),
      // A different deploy in the same run, and a non-gate ticket: neither is an
      // attempt at THIS gate, evidence or not.
      dgate("TEAM-4656", "the staging deploy", "2026-09-13T09:00:00.000Z"),
      { ticketId: "TEAM-4601", title: "Dev: pipeline arg contract", status: "done", labels: ["dev"], createdAt: "2026-09-12T09:00:00.000Z" },
    ]);

    expect(attemptLinesOf(text)).toEqual([`Attempt 2 — previous issue: ${REJECTION}`]);
    expect(text.length).toBeLessThanOrEqual(mod.APPROVAL_TEXT_MAX);
  });

  it("an earlier same-target gate that was never rejected is NOT an attempt (TEAM-4656/57/58)", async () => {
    const mod = await loadModule();
    const text = await pageGate(mod, [
      dgate(GATE, "the queued deploy", "2026-09-14T09:00:00.000Z", { status: "in_review" }),
      // Resolved, earlier, same target — but no gaterework row: it was approved,
      // or it was never presented at all. `status: "done"` is not a verdict.
      dgate("TEAM-4657", "the queued deploy", "2026-09-13T17:00:00.000Z"),
      dgate("TEAM-4656", "the queued deploy", "2026-09-13T09:00:00.000Z"),
    ]);

    expect(attemptLinesOf(text)).toEqual([]);
    expect(text).not.toContain("previous issue");
  });

  it("a parallel deploy of a DIFFERENT target is never a previous attempt", async () => {
    const mod = await loadModule();
    const text = await pageGate(mod, [
      dgate(GATE, "pipeline-b", "2026-09-14T09:00:00.000Z", { status: "in_review" }),
      dgate("TEAM-4657", "pipeline-a", "2026-09-13T17:00:00.000Z"),
    ]);

    expect(attemptLinesOf(text)).toEqual([]);
  });

  it("a rejection recorded against a DIFFERENT target does not count, and its reason is never quoted", async () => {
    const mod = await loadModule();
    seedRework("TEAM-4657", "pipeline-a rolled back the migration");
    const text = await pageGate(mod, [
      dgate(GATE, "pipeline-b", "2026-09-14T09:00:00.000Z", { status: "in_review" }),
      dgate("TEAM-4657", "pipeline-a", "2026-09-13T17:00:00.000Z"),
    ]);

    expect(attemptLinesOf(text)).toEqual([]);
    expect(text).not.toContain("rolled back the migration");
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

/**
 * TEAM-4675 (ship-review F1 on PR #603). recordGateRework's placeholder
 * ("changes requested", written the instant ❌ is tapped, before any note
 * exists — see the ❌-branch comment in index.mjs) used to have no exit: ✅
 * Approve and 🗑 Drop each cleared only the rej#<chatId> marker, so a ❌
 * tapped by mistake and then approved — or a note whose delivery failed and
 * was dropped — left `gaterework#<ticketId>` standing forever (well, 30
 * days). approvalAttempt's sibling scan (index.mjs ~1443) treats that row as
 * an evidenced rejection for the next same-target gate, so a human who
 * APPROVED gate A got told, on gate B, that they had rejected it.
 */
describe("a ❌ that never became a rejection is not a previous attempt (TEAM-4675)", () => {
  const GATE_B = "TEAM-4659";
  const REWORK_KEY = `gaterework#${GATE}`;
  const tapGno = (updateId = 1) => ({
    update_id: updateId,
    callback_query: { id: `cb-${updateId}`, data: `gno|${GATE}|${WF}`, message: { message_id: 7, chat: { id: CHAT }, text: "ping" } },
  });
  const tapGok = (updateId = 2) => ({
    update_id: updateId,
    callback_query: { id: `cb-${updateId}`, data: `gok|${GATE}|${WF}`, message: { message_id: 7, chat: { id: CHAT }, text: "ping" } },
  });
  const tapDrop = (updateId = 3) => ({
    update_id: updateId,
    callback_query: { id: `cb-${updateId}`, data: `rjx|${GATE}`, message: { message_id: 8, chat: { id: CHAT }, text: "⚠️ Couldn't send…" } },
  });
  // Gate B: same target as GATE, filed later in the run — the RM-authored,
  // new-ticket-per-attempt shape the sibling scan exists for.
  const pageGateB = async (mod) => (await run(mod.handler, {
    batches: [[]],
    workflows: [wf([notif(`notif_${GATE_B}_2026-09-14T18:30:00.000Z`, "2026-09-14T18:30:00.000Z", { ticketId: GATE_B })])],
    tickets: [
      dgate(GATE_B, "the queued deploy", "2026-09-14T18:00:00.000Z", { status: "in_review" }),
      dgate(GATE, "the queued deploy", "2026-09-14T09:00:00.000Z"),
    ],
  })).sent[0].text;

  it("❌ then ✅ on gate A leaves no evidence for a later same-target gate B", async () => {
    const mod = await loadModule();

    await run(mod.handler, { batches: [[tapGno()]] });
    expect(db.items.has(REWORK_KEY), "the ❌ tap writes the placeholder").toBe(true);

    // …tapped by mistake — ✅ Approve the same ticket.
    const approved = await run(mod.handler, { batches: [[tapGok()]] });
    expect(approved.transitions[0]).toMatchObject({ ticketId: GATE, targetStatus: "done" });

    // Behavioural symptom first: gate B must not read A's ❌ as an attempt.
    const text = await pageGateB(mod);
    expect(attemptLinesOf(text)).toEqual([]);
    expect(text).not.toContain("previous issue");
    expect(text).not.toContain("changes requested");
    expect(text).toMatch(mod.APPROVAL_KICKER_RE);
    expect(text.length).toBeLessThanOrEqual(mod.APPROVAL_TEXT_MAX);

    // Mechanism second: ✅ actually retracted the placeholder.
    expect(db.deletes).toContain(REWORK_KEY);
    expect(db.items.has(REWORK_KEY), "✅ retracts the placeholder").toBe(false);
  });

  it("❌ → failed note delivery → 🗑 Drop leaves no evidence for a later same-target gate B", async () => {
    const mod = await loadModule();

    await run(mod.handler, { batches: [[tapGno()]] });
    expect(db.items.has(REWORK_KEY)).toBe(true);

    // The note is typed, but the hub refuses the transition — parked with
    // Retry/Drop, same shape as gate-rework-note.test.mjs's 409 case.
    const failed = await run(mod.handler, {
      batches: [[{ update_id: 2, message: { message_id: 2, chat: { id: CHAT }, from: { id: CHAT }, text: "the fix broke the smoke test" } }]],
      afterPoll: [100_000],
      transitionStatus: 409,
      transitionBody: { error: "Ticket transition rejected", details: 'No transition to "Blocked" found.' },
    });
    expect(failed.transitions).toHaveLength(1);
    const warn = failed.sent.find((m) => /Couldn't send/.test(m.text));
    expect(warn?.reply_markup?.inline_keyboard.flat().map((b) => b.callback_data)).toEqual([`rjr|${GATE}|${WF}`, `rjx|${GATE}`]);
    expect(db.items.has(REWORK_KEY), "no rework was ever delivered — only the placeholder exists").toBe(true);

    const dropped = await run(mod.handler, { batches: [[tapDrop()]] });
    expect(dropped.edited[0].text).toMatch(/dropped/i);

    // Behavioural symptom first: gate B must not read A's ❌ as an attempt.
    const text = await pageGateB(mod);
    expect(attemptLinesOf(text)).toEqual([]);
    expect(text).not.toContain("previous issue");

    // Mechanism second: Drop actually retracted the placeholder.
    expect(db.deletes).toContain(REWORK_KEY);
    expect(db.items.has(REWORK_KEY), "Drop retracts the placeholder").toBe(false);
  });

  it("the pre-existing Attempt-2 case is unaffected: a delivered note still counts", async () => {
    const mod = await loadModule();
    const cycle1 = notif(`notif_${GATE}_2026-09-14T10:00:00.000Z`, "2026-09-14T10:00:00.000Z");
    const cycle2 = notif(`notif_${GATE}_2026-09-14T18:00:00.000Z`, "2026-09-14T18:00:00.000Z");
    const tickets = [rmGateTicket()];

    const first = await run(mod.handler, { batches: [[]], workflows: [wf([cycle1])], tickets });
    expect(first.sent[0].text).not.toMatch(/Attempt/);

    await run(mod.handler, { batches: [[tapGno()]] });
    const noted = await run(mod.handler, {
      batches: [[{ update_id: 2, message: { message_id: 2, chat: { id: CHAT }, from: { id: CHAT }, text: "the deploy gate must name one execution, not three" } }]],
      afterPoll: [100_000],
    });
    expect(noted.transitions[0]).toMatchObject({ ticketId: GATE, targetStatus: "blocked" });
    expect(db.items.get(REWORK_KEY)?.reason?.S).toBe("the deploy gate must name one execution, not three");

    const second = await run(mod.handler, {
      batches: [[]],
      workflows: [wf([{ ...cycle1, acknowledged: true }, cycle2])],
      tickets,
    });
    expect(attemptLinesOf(second.sent[0].text)).toEqual(["Attempt 2 — previous issue: the deploy gate must name one execution, not three"]);
  });
});

// TEAM-4673 — the two producers of the shipping list each pre-sliced to 5
// before handing it to the builder, so shippingSubject's "+N more" (computed
// from the array it was GIVEN) undercounted whatever ran past 5.
describe("the shipping list counts what it does not render (TEAM-4673)", () => {
  const gateNotif = () => notif(`notif_${GATE}_2026-09-14T10:00:00.000Z`, "2026-09-14T10:00:00.000Z");

  it("a gate blocking on 8 upstream tickets renders 3 and counts the other 5", async () => {
    const mod = await loadModule();
    const upstream = upstreamN(8);
    const text = (await run(mod.handler, {
      batches: [[]],
      workflows: [wf([gateNotif()])],
      tickets: [{ ...rmGateTicket(), blockedBy: upstream.map((t) => t.ticketId) }, ...upstream],
    })).sent[0].text;

    expect(text).toContain("+5 more");
    expect(shippingItemsOf(text)).toHaveLength(3);
    // A neutral-titled upstream ticket must not be read as a sibling attempt.
    expect(attemptLinesOf(text)).toEqual([]);
  });

  it("the landed-PR fallback counts every landed ticket, not the first five", async () => {
    const mod = await loadModule();
    const upstream = upstreamN(8);
    const text = (await run(mod.handler, {
      batches: [[]],
      workflows: [wf([gateNotif()], { agentTasks: landedTasks(upstream) })],
      tickets: [{ ...rmGateTicket(), blockedBy: [] }, ...upstream],
    })).sent[0].text;

    expect(text).toContain("+5 more");
    const items = shippingItemsOf(text);
    expect(items).toHaveLength(3);
    // shippedTitles sorts newest-first by completedAt.
    expect(items).toEqual(["Upstream work 7", "Upstream work 6", "Upstream work 5"]);
  });

  it("40 upstream tickets: 3 rendered, 37 counted, still under the cap", async () => {
    const mod = await loadModule();
    const upstream = upstreamN(40);
    const text = (await run(mod.handler, {
      batches: [[]],
      workflows: [wf([gateNotif()])],
      tickets: [{ ...rmGateTicket(), blockedBy: upstream.map((t) => t.ticketId) }, ...upstream],
    })).sent[0].text;

    expect(text).toContain("+37 more");
    expect(shippingItemsOf(text)).toHaveLength(3);
    expect(text.length).toBeLessThanOrEqual(mod.APPROVAL_TEXT_MAX);
    expect(text).toMatch(mod.APPROVAL_KICKER_RE);
  });
});

// TEAM-4673 — GATE_PHASE_KINDS had no key matching the real QA phase
// ("verification"); the dead ["qa","qa"] key made a QA gate page as the
// generic REVIEW GATE instead of APPROVAL_KICKERS.qa.
describe("the QA gate pages with the QA kicker (TEAM-4673)", () => {
  // A title whose prefix is NOT in GATE_TITLE_KINDS, so only notif.gate can
  // produce a specific kicker — proving the phase table itself, not the title
  // fallback.
  const neutralGateTicket = () => ({ ...rmGateTicket(), title: "Some neutral title: blah" });
  // Distinct notif id per gate: the claim key is gate#<notif.id>, and this test
  // pages several gate values in a row without clearing PENDING_TABLE between
  // them, so a shared id would dedupe every call after the first.
  const pageWithGate = async (mod, gate) => (await run(mod.handler, {
    batches: [[]],
    workflows: [wf([notif(`notif_${GATE}_${gate}_2026-09-14T10:00:00.000Z`, "2026-09-14T10:00:00.000Z", { gate })])],
    tickets: [neutralGateTicket()],
  })).sent[0].text;

  it('gate="verification" pages QA, and the other phases keep their kickers', async () => {
    const mod = await loadModule();

    const qaText = await pageWithGate(mod, "verification");
    expect(qaText).toMatch(/^\*🚦 QA REVIEW GATE — approval needed\*/);
    expect(qaText).toMatch(mod.APPROVAL_KICKER_RE);
    expect(qaText).toContain("REVIEW GATE");
    expect(qaText).toContain(`🎫 [${GATE}]`);

    // Collision guard: the new "verification" key must not shadow the others.
    expect(await pageWithGate(mod, "development")).toMatch(/^\*🚦 CODE REVIEW GATE — approval needed\*/);
    expect(await pageWithGate(mod, "ship")).toMatch(/^\*🚦 SHIP REVIEW GATE — approval needed\*/);
    expect(await pageWithGate(mod, "plan")).toMatch(/^\*🚦 PLAN REVIEW GATE — approval needed\*/);
  });
});
