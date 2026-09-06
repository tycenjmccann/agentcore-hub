/**
 * TEAM-4120 FR-3 — the DEAD SESSION page.
 *
 * A dead-session escalation is a different DECISION from a Workflow Manager
 * escalation: the run is telling you an agent died, what evidence survived, and
 * what it did about it. So it gets its own kicker, per-disposition summary, and
 * an evidence bullet list — while resolving stays the same action (same keyboard,
 * same esc# claim key). Pinned here:
 *   - the enriched notification renders the DEAD SESSION kicker with the last
 *     streamed words REDACTED and clipped, the children, and a ticket link;
 *   - a LEGACY row (reviewer dead-session-detector, no disposition/evidence —
 *     what both emitters wrote before FR-3, and what they still write with the
 *     flag off) lands under the same kicker with its own details text;
 *   - any other reviewer (runtime-health, workflow-manager, …) keeps the generic
 *     WORKFLOW MANAGER ESCALATION shape.
 *
 * Same module-seam mocks / harness as manager-escalation-ping.test.mjs.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TG_TOKEN = "111111:test-bot-token";
const HUB = "https://hub.example.invalid";

const db = vi.hoisted(() => ({ items: new Map(), puts: [], deletes: [] }));
vi.mock("@aws-sdk/client-dynamodb", () => {
  const cmd = (op) => class { constructor(input) { this.input = input; this.op = op; } };
  const GetItemCommand = cmd("get");
  const PutItemCommand = cmd("put");
  const DeleteItemCommand = cmd("del");
  const ScanCommand = cmd("scan");
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
      if (c.op === "del") {
        db.deletes.push(c.input.Key.id.S);
        db.items.delete(c.input.Key.id.S);
        return {};
      }
      if (c.op === "scan") {
        const p = c.input.ExpressionAttributeValues[":p"].S;
        return { Items: [...db.items.values()].filter((i) => i.id.S.startsWith(p)) };
      }
      throw new Error(`unexpected ddb op ${c.op}`);
    }
  }
  return { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand, ScanCommand };
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
  PutApprovalResultCommand: class { constructor(input) { this.input = input; } },
}));

const jsonRes = (body, ok = true, status = 200) => ({
  ok, status, json: async () => body, text: async () => JSON.stringify(body),
});

function makeNet(ctx, overrides = {}) {
  const net = {
    ctx, polls: 0, batches: [], afterPoll: [], workflows: [],
    sent: [], answered: [], edited: [], transitions: [], patches: [],
    ...overrides,
  };
  net.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : null;
    if (u === `${HUB}/api/workflow/list`) return jsonRes({ workflows: net.workflows });
    if (u.endsWith("/tickets/transition")) { net.transitions.push(body); return jsonRes({}); }
    if (/\/api\/workflow\/[^/]+\/escalations$/.test(u)) {
      net.patches.push({ url: u, method: opts?.method, body });
      return jsonRes({ workflowId: "wf-1", resolved: ["notif_wm_1"] });
    }
    if (/\/api\/workflow\/[^/]+\/tickets$/.test(u)) return jsonRes({}, false, 404);
    if (u.includes("/api/workflow/artifacts")) return jsonRes({}, false, 404);
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

function makeCtx(startMs) {
  return { remainingMs: startMs, getRemainingTimeInMillis() { return this.remainingMs; } };
}

const ENV = {
  TELEGRAM_BOT_TOKEN: TG_TOKEN,
  JIRA_SITE_URL: "example.atlassian.net",
  JIRA_EMAIL: "bot@example.com",
  JIRA_API_TOKEN: "test-jira-token",
  JIRA_PROJECT_KEY: "TEST",
  GITHUB_TOKEN: "test-github-token",
  GITHUB_USER: "test-user",
  PENDING_TABLE: "test-pending-table",
  HUB_API_URL: HUB,
};

async function loadHandler(allowedChatIds) {
  vi.resetModules();
  Object.assign(process.env, ENV);
  if (allowedChatIds == null) delete process.env.ALLOWED_CHAT_IDS;
  else process.env.ALLOWED_CHAT_IDS = allowedChatIds;
  const mod = await import("../index.mjs");
  return mod.handler;
}

const realFetch = global.fetch;
beforeEach(() => { db.items.clear(); db.puts.length = 0; db.deletes.length = 0; });
afterAll(() => {
  global.fetch = realFetch;
  for (const k of [...Object.keys(ENV), "ALLOWED_CHAT_IDS"]) delete process.env[k];
});

const registerChat = (id) => db.items.set(`chat#${id}`, { id: { S: `chat#${id}` }, chatId: { N: String(id) } });


const registerChat2 = registerChat; // keep the helper name symmetric with the sibling test

const SECRET = `ghp_${"a".repeat(36)}`;

/** What dead-session-escalation.mjs appends in enforce with children evidence. */
const ENRICHED = {
  id: "notif_dead_session_TEAM-7_2026-09-05T07:00:00.000Z",
  type: "manager_escalation",
  acknowledged: false,
  reviewer: "dead-session-escalation",
  source: "dead-session-detector",
  disposition: "synthesized_children",
  ticketId: "TEAM-7",
  agentId: "agentcore_hub_backend_dev",
  ticketTitle: "Ship the dead-session escalation tree",
  lastText: `pushing with ${SECRET} to origin`,
  children: ["TEAM-50", "TEAM-51"],
  artifacts: { completionRecord: false, prUrl: "https://github.com/o/r/pull/7" },
  details: "Agent agentcore_hub_backend_dev went silent on TEAM-7; auto-retry exhausted.",
  timestamp: "2026-09-05T07:00:00.000Z",
};

/** The pre-FR-3 page: reviewer only, no evidence, no disposition. */
const LEGACY = {
  id: "notif_dead_session_TEAM-9_2026-09-05T07:00:00.000Z",
  type: "manager_escalation",
  acknowledged: false,
  reviewer: "dead-session-detector",
  ticketId: "TEAM-9",
  details: "Agent dev died twice on TEAM-9 (last heartbeat unknown). Auto-retry is exhausted — needs a human.",
};

const runWith = (notif, extra = {}) => [{
  workflowId: "wf-1",
  input: { title: "Music video journey" },
  phase: "development",
  humanNotifications: [notif],
  ...extra,
}];

const pings = (net) => net.sent.map((m) => String(m.text));
const deadPings = (net) => pings(net).filter((t) => t.includes("DEAD SESSION"));

describe("dead-session escalations get their own page", () => {
  it("renders the DEAD SESSION kicker with redacted evidence, children and a ticket link", async () => {
    const handler = await loadHandler("12345");
    registerChat(12345);
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { workflows: runWith(ENRICHED) });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(deadPings(net)).toHaveLength(1);
    const text = deadPings(net)[0];
    expect(text).not.toContain("WORKFLOW MANAGER ESCALATION");
    // Subject = the ticket the agent died on, then its title.
    expect(text).toContain("TEAM-7 · Ship the dead-session escalation tree");
    // Per-disposition summary: what the tree DID, not what the human must reconstruct.
    expect(text).toContain("Waiting on children; auto-resumes when they finish");
    // Bullets are esc()'d for legacy Markdown, so underscores/brackets arrive escaped.
    expect(text).toContain("agentcore\\_hub\\_backend\\_dev (dead-session-detector)");
    expect(text).toContain("Last said:");
    expect(text).toContain("pushing with");
    expect(text).toContain("TEAM-50, TEAM-51");
    expect(text).toContain("no completion record");
    expect(text).toContain("PR https://github.com/o/r/pull/7");
    expect(text).toContain("browse/TEAM-7");
    // THE point of re-redacting on the way out of the account.
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("ghp_");
    expect(text).toContain("\\[REDACTED\\]");
    // A children-synthesis is NOT parked — do not tell the human the run is stuck.
    expect(text).not.toContain("run parked until you resolve");
    // Resolving is unchanged: same keyboard, same claim key.
    const sent = net.sent.find((m) => String(m.text).includes("DEAD SESSION"));
    const buttons = sent.reply_markup.inline_keyboard.flat();
    expect(buttons.find((b) => b.callback_data === "eok|wf-1")).toBeTruthy();
    expect(buttons.find((b) => b.url === `${HUB}/workflow?id=wf-1`)).toBeTruthy();
    expect(db.items.has(`esc#${ENRICHED.id}`)).toBe(true);
  });

  it("a parked disposition names the gate to approve and says the run is held", async () => {
    const handler = await loadHandler("12345");
    registerChat(12345);
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { workflows: runWith({
      ...ENRICHED, disposition: "parked", gateTicketId: "TEAM-900", children: [], lastText: "",
    }) });
    global.fetch = net.fetch;

    await handler({}, ctx);

    const text = deadPings(net)[0];
    expect(text).toContain("Parked on gate TEAM-900 — approve it to re-run");
    expect(text).toContain("run parked until you resolve");
    expect(text).toContain("Last said: (nothing streamed)");
    expect(text).toContain("Children: none");
    expect(text).toContain("Approve the escalation gate to re-run the agent");
  });

  it("shadow says it took no action and which way it would have gone", async () => {
    const handler = await loadHandler("12345");
    registerChat(12345);
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { workflows: runWith({
      ...ENRICHED, disposition: "shadow", wouldSynthesize: true,
    }) });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(deadPings(net)[0]).toContain("Observe-only (shadow) — would have synthesized");
  });

  it("a LEGACY evidence-free row still pages under the DEAD SESSION kicker", async () => {
    const handler = await loadHandler("12345");
    registerChat(12345);
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { workflows: runWith(LEGACY) });
    global.fetch = net.fetch;

    await handler({}, ctx);

    const text = deadPings(net)[0];
    // No disposition → its own details text is the summary.
    expect(text).toContain("Auto-retry is exhausted");
    expect(text).toContain("TEAM-9");
    expect(text).toContain("Last said: (nothing streamed)");
    expect(text).toContain("Children: none");
  });

  it("the reconcile-sweep twin is a dead session too", async () => {
    const handler = await loadHandler("12345");
    registerChat(12345);
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { workflows: runWith({ ...LEGACY, reviewer: "reconcile-sweep" }) });
    global.fetch = net.fetch;

    await handler({}, ctx);
    expect(deadPings(net)).toHaveLength(1);
  });

  it("every OTHER reviewer keeps the generic Workflow Manager shape", async () => {
    const handler = await loadHandler("12345");
    registerChat(12345);
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { workflows: [
      ...runWith({ ...LEGACY, id: "notif_rh_1", reviewer: "runtime-health", details: "Runtime 5xx spike on the fleet." }),
      { workflowId: "wf-2", phase: "development", input: { title: "Other run" },
        humanNotifications: [{ ...LEGACY, id: "notif_wm_9", reviewer: "workflow-manager", details: "Deterministic crash-loop." }] },
      { workflowId: "wf-3", phase: "development", input: { title: "No reviewer" },
        humanNotifications: [{ ...LEGACY, id: "notif_x_1", reviewer: undefined, details: "Nobody set a reviewer." }] },
    ] });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(deadPings(net)).toHaveLength(0);
    expect(pings(net).filter((t) => t.includes("WORKFLOW MANAGER ESCALATION"))).toHaveLength(3);
  });
});
