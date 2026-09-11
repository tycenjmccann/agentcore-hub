/**
 * Review-gate "Request changes" → rework note routing (2026-09-10 incident).
 *
 * A reviewer tapped ❌ on the TEAM-4343 Merge Approval ping and typed the
 * rework note. The hub 409'd the in_review → blocked transition (the Jira
 * workflow had no → Blocked transition from In Review); the bot had ALREADY
 * deleted the rej# marker, so the error surfaced as "Failed to process" and
 * the reviewer's re-typed note went through bug intake as a brand-new report.
 *
 * Invariants pinned here:
 *   1. A note for a pending ❌ is delivered as the gate's rework comment and
 *      never reaches bug intake / workflow start.
 *   2. A multi-part note (Telegram splits long pastes) lands as ONE comment.
 *   3. A failed delivery keeps the marker + saves the note, tells the reviewer
 *      with Retry / Drop buttons, and files nothing. Retry re-sends the saved
 *      note; Drop clears it.
 *   4. A reply to a gate ping routes to that gate with no marker at all —
 *      workflow id from the ping's buttons, else the ticket's `wf:` label.
 *   5. An expired marker (lazy DDB TTL) is ignored; a DECISION line with no
 *      gate waiting gets a hint instead of being filed.
 *   6. ✅ Approve clears a stale ❌ marker for the same gate.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TG_TOKEN = "111111:test-bot-token";
const HUB = "https://hub.example.invalid";
const JIRA = "https://example.atlassian.net";
const CHAT = 12345;
const GATE = "TEST-77";
const WF = "wf_1700000000000_abc123";

// ─── AWS SDK mocks (hoisted, shared state) ───────────────────────────────────

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
  TranscribeStreamingClient: class {
    async send() { return { TranscriptResultStream: (async function* () {})() }; }
  },
}));

// The classifier is what would turn a misrouted note into a filed bug.
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: class {
    async send() {
      return { output: { message: { content: [{ toolUse: { input: {
        intent: "bug", title: "Misrouted note", description: "It broke.",
        repo: "test-user/app", confidence: 0.99, severity: "normal",
      } } }] } } };
    }
  },
  ConverseCommand: class { constructor(input) { this.input = input; } },
}));

// ─── fetch router / Lambda context fakes ─────────────────────────────────────

const jsonRes = (body, ok = true, status = 200) => ({
  ok, status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/**
 * net.batches[i] = what the i-th getUpdates returns; after each poll the fake
 * clock is set to net.afterPoll[i] (default 20s → under the 30s poll reserve,
 * so the loop terminates once the batches run out). A settled buffer flushes
 * at the top of the NEXT loop iteration only if ≥60s remain, so tests that
 * need a flush give the first poll a 100s clock.
 */
function makeNet(ctx, overrides = {}) {
  const net = {
    ctx, polls: 0, batches: [], afterPoll: [],
    workflows: [],
    transitionStatus: 200,
    transitionBody: null,
    jiraLabels: {},
    sent: [], answered: [], edited: [], transitions: [], jiraIssues: [], workflowStarts: [], jiraGets: [],
    ...overrides,
  };
  net.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : null;
    if (u === `${HUB}/api/workflow/list`) return jsonRes({ workflows: net.workflows });
    if (u.endsWith("/tickets/transition")) {
      net.transitions.push(body);
      if (net.transitionStatus !== 200) {
        return jsonRes(net.transitionBody || { error: "Ticket transition rejected" }, false, net.transitionStatus);
      }
      return jsonRes({ success: true });
    }
    if (/\/api\/workflow\/[^/]+\/tickets$/.test(u)) return jsonRes({}, false, 404);
    if (u.includes("/api/workflow/artifacts")) return jsonRes({}, false, 404);
    if (u.endsWith("/api/workflow/start")) {
      net.workflowStarts.push(body);
      return jsonRes({ epicId: `EPIC-${net.workflowStarts.length}` });
    }
    if (u.startsWith("https://api.github.com/user/repos")) {
      return jsonRes([{ full_name: "test-user/app", private: false, description: "app", language: "JS" }]);
    }
    if (u.endsWith("/rest/api/3/issue")) {
      net.jiraIssues.push(body);
      return jsonRes({ key: `TEST-${100 + net.jiraIssues.length}` });
    }
    const labels = u.match(/\/rest\/api\/3\/issue\/([^/?]+)\?fields=labels$/);
    if (labels) {
      net.jiraGets.push(labels[1]);
      const l = net.jiraLabels[labels[1]];
      return l ? jsonRes({ fields: { labels: l } }) : jsonRes({}, false, 404);
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
  ALLOWED_CHAT_IDS: String(CHAT),
  // Settle immediately so a buffered note flushes on the next loop iteration.
  CHAT_SETTLE_MS: "0",
};

async function loadHandler() {
  vi.resetModules();
  Object.assign(process.env, ENV);
  const mod = await import("../index.mjs");
  return mod.handler;
}

const realFetch = global.fetch;

beforeEach(() => {
  db.items.clear();
  db.puts.length = 0;
  db.deletes.length = 0;
});

afterAll(() => {
  global.fetch = realFetch;
  for (const k of Object.keys(ENV)) delete process.env[k];
});

// ─── update builders ─────────────────────────────────────────────────────────

const GATE_PING_TEXT =
  `🚦 SHIP REVIEW GATE — approval needed\nMulti-CD\n\nPR #484 …\n\n👤 engineer  ·  🎫 ${GATE}  ·  ⏸ pipeline paused on you\n\nApprove to continue, or Request changes to send it back.`;

const gateKeyboard = {
  inline_keyboard: [[
    { text: "✅ Approve", callback_data: `gok|${GATE}|${WF}` },
    { text: "❌ Request changes", callback_data: `gno|${GATE}|${WF}` },
  ], [{ text: "📱 Open approval in hub", url: `${HUB}/workflow?id=${WF}&ticket=${GATE}` }]],
};

const cbUpdate = (updateId, data, messageText = GATE_PING_TEXT) => ({
  update_id: updateId,
  callback_query: {
    id: `cb-${updateId}`,
    data,
    message: { message_id: 7, chat: { id: CHAT }, text: messageText },
  },
});

const msgUpdate = (updateId, text, extra = {}) => ({
  update_id: updateId,
  message: { message_id: updateId, chat: { id: CHAT }, from: { id: CHAT }, text, ...extra },
});

const REJ_KEY = `rej#${CHAT}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const seedMarker = (ttlSec, note) => db.items.set(REJ_KEY, {
  id: { S: REJ_KEY },
  ticketId: { S: GATE },
  workflowId: { S: WF },
  ...(note ? { note: { S: note } } : {}),
  ttl: { N: String(ttlSec) },
});

const nothingFiled = (net) => {
  expect(net.jiraIssues, "no Jira Bug may be filed from a rework note").toHaveLength(0);
  expect(net.workflowStarts, "no workflow may be started from a rework note").toHaveLength(0);
};

// ─── 1 + 2: ❌ → note → ONE gate comment ────────────────────────────────────

describe("❌ Request changes → rework note", () => {
  it("parks a 24h marker on ❌ and tells the reviewer a reply works too", async () => {
    const handler = await loadHandler();
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { batches: [[cbUpdate(1, `gno|${GATE}|${WF}`)]] });
    global.fetch = net.fetch;

    await handler({}, ctx);

    const marker = db.items.get(REJ_KEY);
    expect(marker?.ticketId?.S).toBe(GATE);
    expect(marker?.workflowId?.S).toBe(WF);
    const ttl = Number(marker.ttl.N);
    expect(ttl, "marker must outlive a reviewer who writes the note later").toBeGreaterThan(nowSec() + 23 * 3600);
    expect(net.edited[0].text).toMatch(/reply to this message later/i);
    expect(net.transitions).toHaveLength(0);
  });

  it("delivers the next message as the gate's rework comment, clears the marker, files nothing", async () => {
    const handler = await loadHandler();
    seedMarker(nowSec() + 3600);
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, {
      batches: [[msgUpdate(2, "DECISION: REQUEST CHANGES — fix the default target.")]],
      afterPoll: [100_000],
    });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(net.transitions).toHaveLength(1);
    expect(net.transitions[0]).toMatchObject({ ticketId: GATE, targetStatus: "blocked" });
    expect(net.transitions[0].comment).toBe("Changes requested via Telegram: DECISION: REQUEST CHANGES — fix the default target.");
    expect(db.items.has(REJ_KEY), "marker is consumed only after the transition landed").toBe(false);
    expect(net.sent.some((m) => /changes requested\./i.test(m.text) && m.text.includes(GATE))).toBe(true);
    nothingFiled(net);
  });

  it("joins a multi-part note into ONE transition comment", async () => {
    const handler = await loadHandler();
    seedMarker(nowSec() + 3600);
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, {
      batches: [[
        msgUpdate(3, "DECISION: REQUEST CHANGES — part one."),
        msgUpdate(4, "B. In-diff defects — part two."),
      ]],
      afterPoll: [100_000],
    });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(net.transitions, "two Telegram messages, one gate comment").toHaveLength(1);
    expect(net.transitions[0].comment).toContain("part one.");
    expect(net.transitions[0].comment).toContain("part two.");
    nothingFiled(net);
  });
});

// ─── 3: failed delivery keeps the note ───────────────────────────────────────

describe("failed delivery keeps the note out of bug intake", () => {
  const REFUSAL = {
    error: "Ticket transition rejected",
    details: 'No transition to "Blocked" found. Available: To Do (-> To Do), In Review (-> In Review)',
    ticketId: GATE, targetStatus: "blocked",
  };

  it("409 → marker kept WITH the note, reviewer told the Jira reason, Retry/Drop offered, nothing filed", async () => {
    const handler = await loadHandler();
    seedMarker(nowSec() + 3600);
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, {
      batches: [[msgUpdate(5, "DECISION: REQUEST CHANGES — the note.")]],
      afterPoll: [100_000],
      transitionStatus: 409,
      transitionBody: REFUSAL,
    });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(net.transitions).toHaveLength(1);
    const marker = db.items.get(REJ_KEY);
    expect(marker, "marker must survive a failed delivery").toBeTruthy();
    expect(marker.note.S).toBe("DECISION: REQUEST CHANGES — the note.");
    const warn = net.sent.find((m) => /Couldn't send/.test(m.text));
    expect(warn, "the reviewer is told, not left with a generic failure").toBeTruthy();
    expect(warn.text).toContain("No transition to");
    expect(warn.text).toMatch(/NOT filed as a bug/);
    const buttons = warn.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(buttons).toEqual([`rjr|${GATE}|${WF}`, `rjx|${GATE}`]);
    expect(net.sent.some((m) => /Failed to process/.test(m.text)), "no generic failure message").toBe(false);
    nothingFiled(net);
  });

  it("a re-typed note while the marker is parked is STILL a rework note, not a bug", async () => {
    const handler = await loadHandler();
    seedMarker(nowSec() + 3600, "first attempt");
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, {
      batches: [[msgUpdate(6, "DECISION: REQUEST CHANGES — typed again.")]],
      afterPoll: [100_000],
    });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(net.transitions).toHaveLength(1);
    expect(net.transitions[0].comment).toContain("typed again.");
    nothingFiled(net);
  });

  it("Retry re-sends the saved note and clears the marker once it lands", async () => {
    const handler = await loadHandler();
    seedMarker(nowSec() + 3600, "the saved note");
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { batches: [[cbUpdate(7, `rjr|${GATE}|${WF}`, "⚠️ Couldn't send…")]] });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(net.transitions).toHaveLength(1);
    expect(net.transitions[0].comment).toBe("Changes requested via Telegram: the saved note");
    expect(db.items.has(REJ_KEY)).toBe(false);
    expect(net.edited[0].text).toMatch(/Delivered on retry/);
    nothingFiled(net);
  });

  it("Retry that fails again keeps the marker and re-offers the buttons", async () => {
    const handler = await loadHandler();
    seedMarker(nowSec() + 3600, "the saved note");
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, {
      batches: [[cbUpdate(8, `rjr|${GATE}|${WF}`, "⚠️ Couldn't send…")]],
      transitionStatus: 409, transitionBody: REFUSAL,
    });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(db.items.get(REJ_KEY)?.note?.S).toBe("the saved note");
    expect(net.edited[0].text).toMatch(/Retry failed/);
    expect(net.sent.some((m) => m.reply_markup?.inline_keyboard)).toBe(true);
  });

  it("Drop clears the marker without touching the gate", async () => {
    const handler = await loadHandler();
    seedMarker(nowSec() + 3600, "the saved note");
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { batches: [[cbUpdate(9, `rjx|${GATE}`, "⚠️ Couldn't send…")]] });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(db.items.has(REJ_KEY)).toBe(false);
    expect(net.transitions).toHaveLength(0);
    expect(net.edited[0].text).toMatch(/dropped/i);
  });
});

// ─── 4: replying to the ping needs no marker ─────────────────────────────────

describe("reply to a gate ping", () => {
  it("routes to the gate using the workflow id from the ping's buttons", async () => {
    const handler = await loadHandler();
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, {
      batches: [[msgUpdate(10, "Please split the IAM change out.", {
        reply_to_message: { message_id: 7, chat: { id: CHAT }, text: GATE_PING_TEXT, reply_markup: gateKeyboard },
      })]],
      afterPoll: [100_000],
    });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(net.transitions).toHaveLength(1);
    expect(net.transitions[0]).toMatchObject({ ticketId: GATE, targetStatus: "blocked" });
    expect(net.jiraGets, "buttons carried the workflow id — no Jira lookup needed").toHaveLength(0);
    nothingFiled(net);
  });

  it("routes to the 🎫 handle, not the first key mentioned in the ping's title", async () => {
    const handler = await loadHandler();
    const ctx = makeCtx(100_000);
    const upstream = "TEST-12";
    const pingText = GATE_PING_TEXT.replace("Multi-CD", `Multi-CD (follow-up to ${upstream})`);
    const net = makeNet(ctx, {
      batches: [[msgUpdate(10, "Please split the IAM change out.", {
        reply_to_message: { message_id: 7, chat: { id: CHAT }, text: pingText, reply_markup: gateKeyboard },
      })]],
      afterPoll: [100_000],
    });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(net.transitions).toHaveLength(1);
    expect(net.transitions[0]).toMatchObject({ ticketId: GATE, targetStatus: "blocked" });
    expect(net.transitions[0].ticketId).not.toBe(upstream);
    nothingFiled(net);
  });

  it("falls back to the ticket's wf: label when the ping's keyboard is gone", async () => {
    const handler = await loadHandler();
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, {
      batches: [[msgUpdate(11, "Split the IAM change out.", {
        reply_to_message: { message_id: 7, chat: { id: CHAT }, text: `${GATE_PING_TEXT}\n\n❌ Changes requested — reply with a note…` },
      })]],
      afterPoll: [100_000],
      jiraLabels: { [GATE]: ["human-review", "reviewer:engineer", `wf:${WF}`] },
    });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(net.jiraGets).toEqual([GATE]);
    expect(net.transitions).toHaveLength(1);
    expect(net.transitions[0]).toMatchObject({ ticketId: GATE, targetStatus: "blocked" });
    nothingFiled(net);
  });

  it("a reply to an ordinary bot message is NOT a rework note", async () => {
    const handler = await loadHandler();
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, {
      batches: [[msgUpdate(12, "The button is broken", {
        reply_to_message: { message_id: 3, chat: { id: CHAT }, text: `🐛 Something\n🎫 ${GATE} — pipeline started` },
      })]],
      afterPoll: [100_000],
    });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(net.transitions).toHaveLength(0);
    expect(net.jiraIssues, "ordinary report goes through intake as before").toHaveLength(1);
  });
});

// ─── 5 + 6: stale markers and stray decisions ────────────────────────────────

describe("stale markers and stray DECISION lines", () => {
  it("ignores an expired marker (lazy DDB TTL) and hints instead of filing a DECISION line", async () => {
    const handler = await loadHandler();
    seedMarker(nowSec() - 60);
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, {
      batches: [[msgUpdate(13, "DECISION: REQUEST CHANGES — where does this go?")]],
      afterPoll: [100_000],
    });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(net.transitions).toHaveLength(0);
    expect(net.sent.some((m) => /no gate is waiting/i.test(m.text))).toBe(true);
    nothingFiled(net);
  });

  it("with an expired marker an ordinary report still goes through intake", async () => {
    const handler = await loadHandler();
    seedMarker(nowSec() - 60);
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { batches: [[msgUpdate(14, "The save button is broken")]], afterPoll: [100_000] });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(net.transitions).toHaveLength(0);
    expect(net.jiraIssues).toHaveLength(1);
  });

  it("✅ Approve clears a stale ❌ marker for the same gate", async () => {
    const handler = await loadHandler();
    seedMarker(nowSec() + 3600);
    const ctx = makeCtx(100_000);
    const net = makeNet(ctx, { batches: [[cbUpdate(15, `gok|${GATE}|${WF}`)]] });
    global.fetch = net.fetch;

    await handler({}, ctx);

    expect(net.transitions[0]).toMatchObject({ ticketId: GATE, targetStatus: "done" });
    expect(db.items.has(REJ_KEY), "a later plain message must not become a rework note").toBe(false);
  });
});
