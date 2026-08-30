/**
 * Telegram Bug Intake Lambda (local/account-specific, not part of OSS core)
 *
 * Screenshot(s) + description sent to a Telegram bot → structured Jira Bug →
 * hub pipeline (bootstrapBugWorkflow). See docs/bug-intake-jira.md for the
 * downstream contract this feeds.
 *
 * POLLING architecture — no public endpoint (account blocks public Lambdas,
 * and an open webhook URL is a sec issue anyway):
 *
 *   EventBridge rate(1 minute) → this Lambda
 *     → long-polls Telegram getUpdates (~50s per invocation, offset in DDB)
 *     → per bug: download photo(s), Bedrock vision call structures the bug +
 *       classifies target repo against the live GitHub repo list
 *     → confident: create Jira Bug (repo:<owner>/<name> label) + attach
 *       screenshots + reply with the issue link
 *     → unsure: inline-keyboard repo picker; pending bug parked in DynamoDB,
 *       created on button tap
 *
 * Reserved concurrency = 1 so only one poller holds getUpdates at a time
 * (Telegram 409s on concurrent getUpdates).
 *
 * BATCHING: Telegram delivers every message separately — albums arrive as
 * one update per photo, multi-message pastes as one update per chunk. All
 * content from a chat is buffered (per-chat, persisted in DDB so bursts
 * spanning invocation boundaries survive) and only processed after
 * CHAT_SETTLE_MS of silence from that chat → ONE combined LLM call → ONE
 * ticket. Without this, a 20-message paste files 20 tickets (2026-08-15
 * flood incident).
 *
 * Telegram file_ids are stable, so pending bugs store file_ids and
 * re-download screenshots at confirmation time — no image bytes in DDB.
 *
 * VOICE: native Telegram voice notes (OGG/Opus) are downloaded and transcribed
 * with Amazon Transcribe streaming; the transcript joins the text flow like a
 * typed message (and is echoed back so the user can verify what was heard).
 *
 * WORKFLOW MANAGER RELAY: a third intent, "chat", routes anything that isn't a
 * bug/feature report (questions, run status, "stop that run and restart it
 * with X") to the Workflow Manager harness via the hub's
 * /api/workflow-manager/chat SSE endpoint. conversationId = tg-{chatId}, so
 * the conversation persists across messages via WM memory. `wm: ...` or
 * `/wm ...` prefixes skip classification and relay directly.
 *
 * REVIEW GATES: each invocation also scans the hub's workflow list for
 * unacknowledged review_needed notifications (human-review gate tickets the
 * orchestrator parked in in_review). Every registered chat gets a ping with
 * inline ✅ Approve / ❌ Request changes buttons. Approve transitions the gate
 * ticket to done (downstream phases unblock); Request changes asks for a note
 * in the next message, then transitions to blocked with that note as the
 * rework context. Dedupe per gate ticket lives in PENDING_TABLE (gate#<id>),
 * chat registry in chat#<chatId> (any chat that ever messaged the bot).
 */

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { TranscribeStreamingClient, StartStreamTranscriptionCommand } from "@aws-sdk/client-transcribe-streaming";

const TELEGRAM_BOT_TOKEN = requireEnv("TELEGRAM_BOT_TOKEN");
const ALLOWED_CHAT_IDS   = (process.env.ALLOWED_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

const JIRA_SITE_URL    = requireEnv("JIRA_SITE_URL");
const JIRA_EMAIL       = requireEnv("JIRA_EMAIL");
const JIRA_API_TOKEN   = requireEnv("JIRA_API_TOKEN");
const JIRA_PROJECT_KEY = requireEnv("JIRA_PROJECT_KEY");
const JIRA_AUTH = "Basic " + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");

const GITHUB_TOKEN = requireEnv("GITHUB_TOKEN");
const GITHUB_USER  = requireEnv("GITHUB_USER");

const PENDING_TABLE = requireEnv("PENDING_TABLE");
const HUB_API_URL = requireEnv("HUB_API_URL"); // e.g. https://ag-....ecs.us-east-1.on.aws
const MODEL_ID = process.env.BEDROCK_MODEL_ID || "us.anthropic.claude-sonnet-4-6";
const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD || "0.75");
const TRANSCRIBE_LANGUAGE = process.env.TRANSCRIBE_LANGUAGE || "en-US";

// Workflow Manager relay budgets. A WM harness turn can take minutes, so a
// relay only starts when this invocation still has real runway; otherwise the
// buffer is left persisted and the next poller invocation (fresh clock) does it.
const WM_MIN_BUDGET_MS = parseInt(process.env.WM_MIN_BUDGET_MS || "300000", 10);
const WM_RELAY_TIMEOUT_MS = parseInt(process.env.WM_RELAY_TIMEOUT_MS || "480000", 10);
// Don't start ANY buffer flush (LLM classify + file) with less runway than this.
const FLUSH_MIN_MS = 60_000;

// Stop long-polling when this much runtime remains for in-flight processing.
const POLL_RESERVE_MS = 30_000;
// A chat's buffered messages are processed only after this much silence from
// that chat. Telegram splits albums AND long pastes into separate messages;
// one burst must become one ticket.
const CHAT_SETTLE_MS = parseInt(process.env.CHAT_SETTLE_MS || "20000", 10);
// Hard cap: never buffer a chat longer than this even if messages keep coming.
const CHAT_BUFFER_MAX_MS = parseInt(process.env.CHAT_BUFFER_MAX_MS || "120000", 10);
const BUFFER_KEY_PREFIX = "buf#";

const TG = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const TG_FILE = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}`;
const OFFSET_KEY = "tg#offset";

const bedrock = new BedrockRuntimeClient({});
const ddb = new DynamoDBClient({});
const transcribe = new TranscribeStreamingClient({});

// ─── Entry: poll loop ────────────────────────────────────────────────────────

export const handler = async (event, context) => {
  let offset = await loadOffset();
  const buffers = await loadBuffers(); // chatId -> { chatId, parts, firstAt, lastAt }

  // Ping reviewers about any newly-parked human-review gate tickets. Errors
  // never block the poll loop — the next invocation retries (dedupe in DDB).
  // Re-scan every 60s INSIDE the loop too: one invocation long-polls ~14.5 min,
  // so a start-only scan made gate pings lag up to 15 min behind the gate.
  try { await scanReviewGates(); } catch (err) { console.error("[telegram-bug-intake] gate scan", err); }
  let lastGateScan = Date.now();

  while (context.getRemainingTimeInMillis() > POLL_RESERVE_MS) {
    if (Date.now() - lastGateScan > 60_000) {
      lastGateScan = Date.now();
      try { await scanReviewGates(); } catch (err) { console.error("[telegram-bug-intake] gate scan", err); }
    }
    await flushSettledBuffers(buffers, context);

    // Wake up in time for the earliest buffer deadline instead of sleeping a
    // full long-poll while a chat sits settled.
    let timeout = Math.min(25, Math.floor((context.getRemainingTimeInMillis() - POLL_RESERVE_MS) / 1000));
    const deadline = nextBufferDeadline(buffers);
    if (deadline != null) timeout = Math.min(timeout, Math.max(1, Math.ceil((deadline - Date.now()) / 1000)));
    if (timeout < 1) break;

    let updates;
    try {
      updates = await tgCall("getUpdates", {
        offset: offset + 1,
        timeout,
        allowed_updates: ["message", "callback_query"],
      });
    } catch (err) {
      if (String(err.message).includes("409")) return { done: "another poller active" };
      throw err;
    }

    for (const u of updates) {
      offset = Math.max(offset, u.update_id);
      try {
        if (u.callback_query) await handleCallback(u.callback_query);
        else if (u.message) await routeMessage(u.message, buffers, context);
      } catch (err) {
        console.error("[telegram-bug-intake]", err);
        const chatId = u.message?.chat?.id || u.callback_query?.message?.chat?.id;
        if (chatId) await tgSend(chatId, `⚠️ Failed to process: ${err.message}`).catch(() => {});
      }
    }
    if (updates.length) await saveOffset(offset);
  }

  // Unsettled buffers survive in DDB; the next invocation (≤1 min away)
  // picks them up. CHAT_BUFFER_MAX_MS bounds the total wait.
  await flushSettledBuffers(buffers, context);
  await saveOffset(offset);
  return { done: true, offset, buffered: buffers.size };
};

// ─── Message flow ────────────────────────────────────────────────────────────
// Everything non-command from a chat is buffered; a burst (album, multi-part
// paste, rapid-fire messages) becomes ONE ticket once the chat goes quiet.

async function routeMessage(msg, buffers, context) {
  const chatId = msg.chat.id;

  if (ALLOWED_CHAT_IDS.length && !ALLOWED_CHAT_IDS.includes(String(chatId))) {
    await tgSend(chatId, `Not authorized. Your chat id is \`${chatId}\` — add it to ALLOWED_CHAT_IDS.`);
    return;
  }

  await registerChat(chatId);

  let text = msg.text || msg.caption || "";

  // Native voice note → transcribe, echo what was heard, then treat the
  // transcript exactly like typed text (classification, buffering, wm relay).
  if (msg.voice) {
    if ((msg.voice.duration || 0) > 600) {
      await tgSend(chatId, "🎙️ That voice note is over 10 minutes — send a shorter one.");
      return;
    }
    await tgAction(chatId, "typing");
    const transcript = await transcribeVoice(msg.voice.file_id);
    if (!transcript) {
      await tgSend(chatId, "🎙️ Couldn't make out any speech in that voice note — try again?");
      return;
    }
    await tgSendPlain(chatId, `🎙️ "${transcript}"`);
    text = text ? `${text}\n\n${transcript}` : transcript;
  }

  // A pending "request changes" is waiting for this chat's next message — it
  // becomes the rework note for the gate ticket, not a bug report.
  if (text && !text.startsWith("/")) {
    const consumed = await consumeRejectionNote(chatId, text);
    if (consumed) return;
  }

  if (text.startsWith("/start") || text.startsWith("/help")) {
    await tgSend(chatId,
      "Send me a screenshot (or several — an album works) with a description of a bug OR a feature idea and I'll file it. " +
      "Voice notes work too — I transcribe them first.\n\n" +
      "Multi-message reports are fine — I wait ~20s after your last message and file everything as ONE ticket. " +
      "I detect bug vs feature automatically and figure out which of your repos it belongs to; if I'm unsure I'll ask. " +
      "Force a repo with `repo:owner/name` anywhere in the message. " +
      "The ticket kicks off the automated dev pipeline — you'll get the Jira link back.\n\n" +
      "Anything that isn't a bug/feature report — run status, questions, \"stop that run and restart it with X\" — " +
      "goes to the Workflow Manager, which can inspect, cancel, dispatch, and start runs. " +
      "Prefix with `wm:` to skip the 20s wait and talk to it directly.");
    return;
  }

  // Explicit WM address → relay immediately, no settle wait, no classifier.
  const wmDirect = stripWmPrefix(text);
  if (wmDirect != null && !pickPhoto(msg)) {
    if (context.getRemainingTimeInMillis() > WM_MIN_BUDGET_MS) {
      await relayToWorkflowManager(chatId, wmDirect, context);
    } else {
      // Not enough runway this invocation — buffer it (prefix kept so the
      // flush path also detects it) and let the next poller relay.
      bufferPart(buffers, chatId, text, null);
      await persistBuffer(buffers.get(chatId));
    }
    return;
  }

  const photo = pickPhoto(msg);
  if (!text && !photo) {
    await tgSend(chatId, "Send a screenshot and/or a description of the bug.");
    return;
  }

  const isNew = bufferPart(buffers, chatId, text, photo?.file_id || null);
  if (isNew) await tgAction(chatId, "typing");
  await persistBuffer(buffers.get(chatId));
}

function bufferPart(buffers, chatId, text, fileId) {
  const now = Date.now();
  let b = buffers.get(chatId);
  const isNew = !b;
  if (!b) {
    b = { chatId, parts: [], firstAt: now };
    buffers.set(chatId, b);
  }
  b.lastAt = now;
  b.parts.push({ text, fileId });
  return isNew;
}

function stripWmPrefix(text) {
  const m = text.match(/^\s*(?:\/wm\b|wm:)\s*/i);
  return m ? text.slice(m[0].length).trim() : null;
}

function bufferDeadline(b) {
  return Math.min(b.lastAt + CHAT_SETTLE_MS, b.firstAt + CHAT_BUFFER_MAX_MS);
}

function nextBufferDeadline(buffers) {
  let min = null;
  for (const b of buffers.values()) {
    const d = bufferDeadline(b);
    if (min == null || d < min) min = d;
  }
  return min;
}

async function flushSettledBuffers(buffers, context) {
  const now = Date.now();
  for (const [chatId, b] of buffers) {
    if (now < bufferDeadline(b)) continue;
    // A flush costs an LLM classify (+ maybe a long WM relay). If the clock is
    // nearly out, leave the buffer persisted for the next invocation instead
    // of starting work we can't finish.
    if (context.getRemainingTimeInMillis() < FLUSH_MIN_MS) continue;
    const text = b.parts.map((p) => p.text).filter(Boolean).join("\n\n");
    const fileIds = b.parts.map((p) => p.fileId).filter(Boolean);
    const wmDirect = stripWmPrefix(text);
    // An explicit WM relay needs a real time budget — defer to the next
    // invocation (fresh clock) rather than starting a turn we'd abort.
    if (wmDirect != null && !fileIds.length &&
        context.getRemainingTimeInMillis() < WM_MIN_BUDGET_MS) continue;
    buffers.delete(chatId);
    await deleteBuffer(chatId);
    try {
      if (wmDirect != null && !fileIds.length) {
        await relayToWorkflowManager(chatId, wmDirect, context);
      } else {
        await processBug(b.chatId, text, fileIds, context);
      }
    } catch (err) {
      console.error("[telegram-bug-intake] buffer flush", err);
      await tgSend(b.chatId, `⚠️ Failed to process: ${err.message}`).catch(() => {});
    }
  }
}

async function processBug(chatId, text, fileIds, context) {
  await tgAction(chatId, "typing");

  const [images, repos] = await Promise.all([
    Promise.all(fileIds.map(downloadTelegramFile)),
    fetchRepos(),
  ]);

  const explicit = text.match(/repo:\s*([\w.-]+\/[\w.-]+)/i)?.[1];
  const bug = await structureBug(text, images, repos, explicit);

  // Not a report at all — a question / run-management request. Hand the raw
  // message to the Workflow Manager, which has the tools and the memory.
  if (bug.intent === "chat" && !explicit) {
    await relayToWorkflowManager(chatId, text, context);
    return;
  }

  const repoValid = repos.some((r) => r.full_name.toLowerCase() === (bug.repo || "").toLowerCase());
  if (repoValid && (explicit || bug.confidence >= CONFIDENCE_THRESHOLD)) {
    const key = await fileTicket(bug, fileIds);
    await tgSend(chatId,
      `${icon(bug)} *${esc(bug.title)}*\n📁 \`${bug.repo}\`\n🎫 [${key}](https://${JIRA_SITE_URL}/browse/${key}) — pipeline started`);
    return;
  }

  // Unsure → park it and ask.
  const id = randomId();
  const candidates = rankCandidates(bug, repos).slice(0, 3);
  await ddb.send(new PutItemCommand({
    TableName: PENDING_TABLE,
    Item: {
      id: { S: id },
      bug: { S: JSON.stringify(bug) },
      fileIds: { S: JSON.stringify(fileIds) },
      candidates: { S: JSON.stringify(candidates) },
      ttl: { N: String(Math.floor(Date.now() / 1000) + 86400) },
    },
  }));

  const rows = candidates.map((slug, i) => [{ text: `📁 ${slug}`, callback_data: `pick|${id}|${i}` }]);
  rows.push([{ text: "❌ Cancel", callback_data: `cancel|${id}` }]);
  await tgSend(chatId,
    `${icon(bug)} *${esc(bug.title)}*\n\n${esc(truncate(bug.description, 300))}\n\nWhich repo?` +
    (bug.repo ? `\n_(best guess: ${esc(bug.repo)} @ ${Math.round(bug.confidence * 100)}%)_` : ""),
    { reply_markup: { inline_keyboard: rows } });
}

async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const [action, id, idx] = (cb.data || "").split("|");

  // Review-gate buttons: gok|<ticketId>|<workflowId> / gno|<ticketId>|<workflowId>
  if (action === "gok" || action === "gno") {
    await handleGateCallback(cb, chatId, action, id, idx);
    return;
  }

  const item = await ddb.send(new GetItemCommand({ TableName: PENDING_TABLE, Key: { id: { S: id } } }));
  if (!item.Item) {
    await tgAnswer(cb.id, "Expired — send the bug again.");
    return;
  }

  if (action === "cancel") {
    await ddb.send(new DeleteItemCommand({ TableName: PENDING_TABLE, Key: { id: { S: id } } }));
    await tgAnswer(cb.id, "Cancelled");
    await tgEdit(chatId, cb.message.message_id, "❌ Cancelled.");
    return;
  }

  const bug = JSON.parse(item.Item.bug.S);
  const candidates = JSON.parse(item.Item.candidates.S);
  bug.repo = candidates[parseInt(idx, 10)];
  const fileIds = item.Item.fileIds?.S ? JSON.parse(item.Item.fileIds.S) : [];

  const key = await fileTicket(bug, fileIds);
  await ddb.send(new DeleteItemCommand({ TableName: PENDING_TABLE, Key: { id: { S: id } } }));
  await tgAnswer(cb.id, `Filed ${key}`);
  await tgEdit(chatId, cb.message.message_id,
    `${icon(bug)} *${esc(bug.title)}*\n📁 \`${bug.repo}\`\n🎫 [${key}](https://${JIRA_SITE_URL}/browse/${key}) — pipeline started`,
    { parse_mode: "Markdown" });
}

// ─── Human review gates ──────────────────────────────────────────────────────
// The orchestrator parks gate tickets (assignee "human:<who>") in in_review and
// records an unacknowledged review_needed notification on the workflow. This
// module turns those into Telegram pings with Approve / Request changes
// buttons, and maps the taps back onto the hub's transition endpoint — the
// same write path a human clicking the board uses.

const GATE_KEY_PREFIX = "gate#";
const CHAT_KEY_PREFIX = "chat#";
const REJECT_KEY_PREFIX = "rej#";

async function scanReviewGates() {
  const res = await fetch(`${HUB_API_URL}/api/workflow/list`);
  if (!res.ok) throw new Error(`workflow/list ${res.status}`);
  const { workflows = [] } = await res.json();

  const pending = [];
  for (const wf of workflows) {
    for (const n of wf.humanNotifications || []) {
      if (n.type === "review_needed" && !n.acknowledged) {
        pending.push({ wf, notif: n });
      }
    }
  }
  if (!pending.length) return;

  let chats = null; // fetched lazily — most scans find nothing new
  for (const { wf, notif } of pending) {
    const claimed = await claimGate(notif.ticketId);
    if (!claimed) continue;

    chats = chats || (await listChats());
    if (!chats.length) {
      console.warn("[telegram-bug-intake] gate ticket but no registered chats to notify");
      continue;
    }

    // Pull the gate ticket for its title only — it names the gate (e.g.
    // "Spec Approval"). We deliberately do NOT surface the ticket description:
    // agents write ad-hoc prose with raw workflows/…md paths that render as
    // broken links in Telegram. The canonical link to the deliverable is the
    // doc button below; the ping stays on a fixed template.
    let title = notif.ticketId;
    try {
      const tRes = await fetch(`${HUB_API_URL}/api/workflow/${wf.workflowId}/tickets`);
      if (tRes.ok) {
        const { tickets = [] } = await tRes.json();
        const t = tickets.find((x) => x.ticketId === notif.ticketId);
        if (t?.title) title = t.title;
      }
    } catch { /* ping still goes out with the id */ }

    const reviewer = notif.reviewer || "reviewer";
    const text =
      `🚦 *Review gate — ${esc(title)}*\n` +
      `📋 Run: ${esc(wf.input?.title || wf.workflowId)}\n` +
      `👤 Awaiting: \`${reviewer}\`\n` +
      `🎫 [${notif.ticketId}](https://${JIRA_SITE_URL}/browse/${notif.ticketId})\n\n` +
      `Open the document below to review, then *Approve* or *Request changes*. ` +
      `The pipeline is paused on you.`;
    const keyboard = { inline_keyboard: [[
      { text: "✅ Approve", callback_data: `gok|${notif.ticketId}|${wf.workflowId}` },
      { text: "❌ Request changes", callback_data: `gno|${notif.ticketId}|${wf.workflowId}` },
    ]] };

    // Deep-link the deliverables under review: the freshest markdown artifacts
    // open straight into the hub's artifact viewer (read/edit/save), so the
    // reviewer can read the actual spec/plan from their phone before tapping
    // Approve. Best-effort — the ping goes out without buttons if the list 404s.
    try {
      const aRes = await fetch(
        `${HUB_API_URL}/api/workflow/artifacts?workflowId=${encodeURIComponent(wf.workflowId)}`
      );
      if (aRes.ok) {
        const { artifacts = [] } = await aRes.json();
        const docs = artifacts
          .filter((a) => a.filename?.toLowerCase().endsWith(".md"))
          .sort((a, b) => new Date(b.lastModified || 0) - new Date(a.lastModified || 0))
          .slice(0, 3);
        for (const doc of docs) {
          keyboard.inline_keyboard.push([{
            text: `📄 ${doc.filename}`,
            url: `${HUB_API_URL}/workflow?id=${encodeURIComponent(wf.workflowId)}&artifact=${encodeURIComponent(doc.key)}`,
          }]);
        }
      }
    } catch { /* buttons are a bonus, never block the ping */ }

    for (const chatId of chats) {
      try { await tgSend(chatId, text, { reply_markup: keyboard }); }
      catch (err) { console.error(`[telegram-bug-intake] gate ping to ${chatId}`, err.message); }
    }
  }
}

/** Atomically claim a gate ticket for notification. False = already pinged. */
async function claimGate(ticketId) {
  try {
    await ddb.send(new PutItemCommand({
      TableName: PENDING_TABLE,
      Item: {
        id: { S: `${GATE_KEY_PREFIX}${ticketId}` },
        ttl: { N: String(Math.floor(Date.now() / 1000) + 30 * 86400) },
      },
      ConditionExpression: "attribute_not_exists(id)",
    }));
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

async function handleGateCallback(cb, chatId, action, ticketId, workflowId) {
  if (action === "gok") {
    await transitionGate(workflowId, ticketId, "done", `Approved via Telegram by chat ${chatId}`);
    await tgAnswer(cb.id, `Approved ${ticketId}`);
    await tgEdit(chatId, cb.message.message_id,
      `${cb.message.text}\n\n✅ Approved — pipeline resuming.`);
    return;
  }
  // Request changes: the ticket needs a rework note. Park the intent; the
  // chat's next plain message becomes the note (consumeRejectionNote).
  await ddb.send(new PutItemCommand({
    TableName: PENDING_TABLE,
    Item: {
      id: { S: `${REJECT_KEY_PREFIX}${chatId}` },
      ticketId: { S: ticketId },
      workflowId: { S: workflowId },
      ttl: { N: String(Math.floor(Date.now() / 1000) + 3600) },
    },
  }));
  await tgAnswer(cb.id, "Reply with what needs to change.");
  await tgEdit(chatId, cb.message.message_id,
    `${cb.message.text}\n\n❌ Changes requested — reply with a note describing what to change. It goes to the agents as rework context.`);
}

/** If this chat has a pending rejection, the message is its rework note. */
async function consumeRejectionNote(chatId, text) {
  const key = `${REJECT_KEY_PREFIX}${chatId}`;
  const item = await ddb.send(new GetItemCommand({ TableName: PENDING_TABLE, Key: { id: { S: key } } }));
  if (!item.Item) return false;
  const ticketId = item.Item.ticketId.S;
  const workflowId = item.Item.workflowId.S;
  await ddb.send(new DeleteItemCommand({ TableName: PENDING_TABLE, Key: { id: { S: key } } }));
  await transitionGate(workflowId, ticketId, "blocked", `Changes requested via Telegram: ${text}`);
  await tgSend(chatId, `❌ *${ticketId}* — changes requested. Your note is on the ticket; upstream work re-opens for rework.`);
  return true;
}

async function transitionGate(workflowId, ticketId, targetStatus, comment) {
  const res = await fetch(`${HUB_API_URL}/api/workflow/${workflowId}/tickets/transition`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticketId, targetStatus, comment }),
  });
  if (!res.ok) throw new Error(`transition ${res.status}: ${await res.text().catch(() => "")}`);
}

// Chat registry — every chat that ever messaged the bot gets gate pings.
// (Solo-operator scale; a real org would key this on the reviewer identity.)
const _knownChats = new Set();
async function registerChat(chatId) {
  if (_knownChats.has(chatId)) return;
  _knownChats.add(chatId);
  await ddb.send(new PutItemCommand({
    TableName: PENDING_TABLE,
    Item: { id: { S: `${CHAT_KEY_PREFIX}${chatId}` }, chatId: { N: String(chatId) } },
  })).catch((err) => console.error("[telegram-bug-intake] registerChat", err.message));
}

async function listChats() {
  const res = await ddb.send(new ScanCommand({
    TableName: PENDING_TABLE,
    FilterExpression: "begins_with(id, :p)",
    ExpressionAttributeValues: { ":p": { S: CHAT_KEY_PREFIX } },
  }));
  return (res.Items || []).map((i) => Number(i.chatId.N)).filter(Boolean);
}

// ─── LLM structuring ─────────────────────────────────────────────────────────

const FILE_BUG_TOOL = {
  toolSpec: {
    name: "file_ticket",
    description: "File the structured ticket (bug fix or feature request).",
    inputSchema: { json: {
      type: "object",
      properties: {
        intent: { type: "string", enum: ["bug", "feature", "chat"], description: "bug = something is broken/wrong; feature = new capability, enhancement, or change request ('add', 'I want', 'it would be nice if'); chat = NOT a report — a question, status check, or a request to manage/inspect/stop/restart workflow runs ('what's the status of…', 'stop that run', 'why did X fail') that should go to the Workflow Manager instead of filing a ticket" },
        title: { type: "string", description: "Concise imperative title, <=100 chars. For chat intent: a short paraphrase of the request." },
        description: { type: "string", description: "For bugs: what's wrong, where (screen/feature), expected vs actual, repro steps if inferable. For features: what to build, where it lives, acceptance criteria. Reference the screenshots by number when they inform the report. For chat: leave brief." },
        repo: { type: "string", description: "owner/name of the repo this belongs to, chosen from the catalog. For chat intent: repeat any repo mentioned or pick the closest, it is not used." },
        branch: { type: "string", description: "Base branch if the user named one, else omit" },
        confidence: { type: "number", description: "0-1 confidence in the repo choice" },
        severity: { type: "string", enum: ["minor", "normal", "major"] },
      },
      required: ["intent", "title", "description", "repo", "confidence"],
      additionalProperties: false,
    } },
  },
};

async function structureBug(text, images, repos, explicitRepo) {
  const catalog = repos.map((r) =>
    `- ${r.full_name}${r.private ? " (private)" : ""} [${r.language || "?"}] — ${r.description || "no description"}`
  ).join("\n");

  const content = [];
  images.forEach((image, i) => {
    if (images.length > 1) content.push({ text: `Screenshot ${i + 1} of ${images.length}:` });
    content.push({ image: { format: image.format, source: { bytes: image.bytes } } });
  });
  content.push({ text:
    `User's bug report:\n${text || "(screenshots only, no text)"}\n\n` +
    (explicitRepo ? `The user explicitly named the repo: ${explicitRepo}. Use it.\n\n` : "") +
    `Repo catalog (pick exactly one full_name):\n${catalog}` });

  const resp = await bedrock.send(new ConverseCommand({
    modelId: MODEL_ID,
    system: [{ text:
      "You turn a user's quick report (text and/or app screenshots) into a structured ticket for an automated dev pipeline. " +
      "First decide intent: BUG (something is broken — errors, crashes, wrong behavior), FEATURE (new capability, enhancement, 'add X', 'I want Y'), " +
      "or CHAT (not a report at all: a question, a status check, or a request to inspect/stop/restart/manage workflow runs — this gets relayed to the Workflow Manager agent, not filed). " +
      "When in doubt between filing a ticket and chat, prefer chat — a wrongly-filed ticket kicks off a whole dev pipeline. " +
      "Read every screenshot carefully — UI text, error messages, and app branding identify which app/repo it is; multiple screenshots often show a sequence (before/after, steps to reproduce). " +
      "Write the description for a coding agent that will implement it: concrete, specific, no filler. " +
      "Pick the repo strictly from the catalog. Confidence reflects the repo choice only." }],
    messages: [{ role: "user", content }],
    toolConfig: { tools: [FILE_BUG_TOOL], toolChoice: { tool: { name: "file_ticket" } } },
    inferenceConfig: { maxTokens: 1500 },
  }));

  const input = resp.output?.message?.content?.find((b) => b.toolUse)?.toolUse?.input;
  if (!input?.title) throw new Error("model returned no structured ticket");
  if (!["bug", "feature", "chat"].includes(input.intent)) input.intent = "bug";
  if (explicitRepo) { input.repo = explicitRepo; input.confidence = 1; }
  return input;
}

function rankCandidates(bug, repos) {
  const names = repos.map((r) => r.full_name);
  const first = bug.repo && names.find((n) => n.toLowerCase() === bug.repo.toLowerCase());
  const rest = names.filter((n) => n !== first);
  return first ? [first, ...rest] : rest;
}

// ─── Ticket filing ───────────────────────────────────────────────────────────
// bug     → top-level Jira Bug with repo: label → bootstrapBugWorkflow path
// feature → POST /api/workflow/start (the canonical feature entry point; it
//           creates the epic + intake ticket and returns the epic key)

async function fileTicket(bug, fileIds = []) {
  return bug.intent === "feature" ? fileFeature(bug, fileIds) : fileBug(bug, fileIds);
}

async function fileFeature(bug, fileIds = []) {
  const res = await fetch(`${HUB_API_URL}/api/workflow/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: bug.title,
      description: bug.description +
        (fileIds.length ? `\n\n${fileIds.length} screenshot(s) are attached to the epic.` : "") +
        "\n\nSource: Telegram intake.",
      workflowType: "feature",
      sources: [],
      repoConfig: { layout: "multi-repo",
        repos: [{ url: `https://github.com/${bug.repo}`, defaultBranch: bug.branch || "main" }] },
    }),
  });
  if (!res.ok) throw new Error(`workflow/start ${res.status}: ${await res.text().catch(() => "")}`);
  const { epicId } = await res.json();

  for (let i = 0; i < fileIds.length; i++) {
    try { await attachScreenshot(epicId, fileIds[i], i + 1); }
    catch (err) { console.error(`[telegram-bug-intake] attach ${i + 1} failed for ${epicId}:`, err.message); }
  }
  return epicId;
}

async function fileBug(bug, fileIds = []) {
  const labels = [`repo:${bug.repo}`];
  if (bug.branch) labels.push(`branch:${bug.branch}`);

  const paragraphs = [
    bug.description,
    fileIds.length ? `${fileIds.length} screenshot(s) of the bug are attached to this ticket.` : "",
    "Source: Telegram bug intake.",
  ].filter(Boolean);

  const res = await fetch(`https://${JIRA_SITE_URL}/rest/api/3/issue`, {
    method: "POST",
    headers: { Authorization: JIRA_AUTH, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ fields: {
      project: { key: JIRA_PROJECT_KEY },
      issuetype: { name: "Bug" },
      summary: bug.title.slice(0, 250),
      labels,
      description: { type: "doc", version: 1,
        content: paragraphs.map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] })) },
    } }),
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${await res.text().catch(() => "")}`);
  const { key } = await res.json();

  for (let i = 0; i < fileIds.length; i++) {
    try { await attachScreenshot(key, fileIds[i], i + 1); }
    catch (err) { console.error(`[telegram-bug-intake] attach ${i + 1} failed for ${key}:`, err.message); }
  }
  return key;
}

async function attachScreenshot(issueKey, fileId, n) {
  const image = await downloadTelegramFile(fileId);
  const form = new FormData();
  form.append("file", new Blob([image.bytes], { type: `image/${image.format}` }), `screenshot-${n}.${image.format}`);
  const res = await fetch(`https://${JIRA_SITE_URL}/rest/api/3/issue/${issueKey}/attachments`, {
    method: "POST",
    headers: { Authorization: JIRA_AUTH, "X-Atlassian-Token": "no-check" },
    body: form,
  });
  if (!res.ok) throw new Error(`Jira attach ${res.status}`);
}

// ─── Voice transcription ─────────────────────────────────────────────────────
// Telegram voice notes are OGG/Opus @48kHz — Transcribe streaming takes that
// container natively, so no transcoding layer is needed.

export async function transcribeVoice(fileId) {
  const meta = await tgCall("getFile", { file_id: fileId });
  const res = await fetch(`${TG_FILE}/${meta.file_path}`);
  if (!res.ok) throw new Error(`Telegram voice download ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  async function* audioStream() {
    const CHUNK = 16 * 1024;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      yield { AudioEvent: { AudioChunk: bytes.subarray(i, i + CHUNK) } };
    }
  }

  const out = await transcribe.send(new StartStreamTranscriptionCommand({
    LanguageCode: TRANSCRIBE_LANGUAGE,
    MediaEncoding: "ogg-opus",
    MediaSampleRateHertz: 48000,
    AudioStream: audioStream(),
  }));

  const parts = [];
  for await (const ev of out.TranscriptResultStream) {
    for (const r of ev.TranscriptEvent?.Transcript?.Results || []) {
      if (!r.IsPartial && r.Alternatives?.[0]?.Transcript) parts.push(r.Alternatives[0].Transcript);
    }
  }
  return parts.join(" ").trim();
}

// ─── Workflow Manager relay ──────────────────────────────────────────────────
// Streams the WM harness (via the hub app's SSE chat endpoint) back into the
// Telegram chat. conversationId is stable per chat, so WM memory carries the
// thread across messages — "stop that run" can refer to the previous message.

async function relayToWorkflowManager(chatId, message, context) {
  await tgAction(chatId, "typing");

  const budget = Math.min(
    WM_RELAY_TIMEOUT_MS,
    Math.max(30_000, context.getRemainingTimeInMillis() - 15_000),
  );
  const abort = new AbortController();
  const killer = setTimeout(() => abort.abort(), budget);
  // Telegram's typing indicator lasts ~5s; keep it alive for the whole turn.
  const typer = setInterval(() => tgAction(chatId, "typing"), 5000);

  let sentAnything = false;
  let pending = "";

  const flushParagraphs = async (final = false) => {
    let toSend = "";
    if (final) {
      toSend = pending; pending = "";
    } else {
      const cut = pending.lastIndexOf("\n\n");
      if (cut < 0 || pending.length < 400) return;
      toSend = pending.slice(0, cut); pending = pending.slice(cut + 2);
    }
    toSend = toSend.trim();
    if (!toSend) return;
    // Plain text (no parse_mode): WM markdown routinely breaks Telegram's parser.
    for (let i = 0; i < toSend.length; i += 4000) {
      await tgSendPlain(chatId, toSend.slice(i, i + 4000));
      sentAnything = true;
    }
  };

  try {
    const res = await fetch(`${HUB_API_URL}/api/workflow-manager/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: `tg-${chatId}`,
        message: `Context: via Telegram (mobile chat — plain text replies, no markdown tables/headers)\n\n${message}`,
      }),
      signal: abort.signal,
    });
    if (!res.ok) throw new Error(`workflow-manager/chat ${res.status}: ${await res.text().catch(() => "")}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sse = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sse += decoder.decode(value, { stream: true });
      const lines = sse.split("\n");
      sse = lines.pop(); // keep the trailing partial line
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        let payload;
        try { payload = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (payload.type === "text" && payload.content) {
          pending += payload.content;
          await flushParagraphs();
        } else if (payload.type === "error" && payload.content) {
          pending += `\n\n⚠️ ${payload.content}`;
        }
      }
    }
    await flushParagraphs(true);
    if (!sentAnything) await tgSendPlain(chatId, "🤖 Workflow Manager returned no reply.");
  } catch (err) {
    await flushParagraphs(true).catch(() => {});
    const reason = abort.signal.aborted
      ? "🤖 Workflow Manager is still working — this turn ran past my window. Ask again in a minute; it remembers the conversation."
      : `⚠️ Workflow Manager relay failed: ${err.message}`;
    await tgSendPlain(chatId, reason).catch(() => {});
    if (!abort.signal.aborted) console.error("[telegram-bug-intake] wm relay", err);
  } finally {
    clearTimeout(killer);
    clearInterval(typer);
  }
}

// ─── GitHub ──────────────────────────────────────────────────────────────────

let _repoCache = { at: 0, repos: [] };
async function fetchRepos() {
  if (Date.now() - _repoCache.at < 10 * 60 * 1000) return _repoCache.repos;
  const repos = [];
  for (let page = 1; page <= 3; page++) {
    const res = await fetch(`https://api.github.com/user/repos?per_page=100&page=${page}&affiliation=owner&sort=pushed`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const batch = await res.json();
    repos.push(...batch.map((r) => ({
      full_name: r.full_name, private: r.private,
      description: r.description, language: r.language,
    })));
    if (batch.length < 100) break;
  }
  _repoCache = { at: Date.now(), repos };
  return repos;
}

// ─── Telegram ────────────────────────────────────────────────────────────────

function pickPhoto(msg) {
  if (msg.photo?.length) return msg.photo[msg.photo.length - 1]; // largest rendition last
  if (msg.document?.mime_type?.startsWith("image/")) return msg.document;
  return null;
}

async function downloadTelegramFile(fileId) {
  const meta = await tgCall("getFile", { file_id: fileId });
  const res = await fetch(`${TG_FILE}/${meta.file_path}`);
  if (!res.ok) throw new Error(`Telegram file download ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const ext = meta.file_path.split(".").pop().toLowerCase();
  const format = ext === "jpg" ? "jpeg" : ["png", "gif", "webp", "jpeg"].includes(ext) ? ext : "jpeg";
  return { bytes, format };
}

async function tgCall(method, body) {
  const res = await fetch(`${TG}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  return data.result;
}

const tgSend = (chatId, text, extra = {}) =>
  tgCall("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true, ...extra });
const tgSendPlain = (chatId, text) =>
  tgCall("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
const tgEdit = (chatId, messageId, text, extra = {}) =>
  tgCall("editMessageText", { chat_id: chatId, message_id: messageId, text, ...extra });
const tgAnswer = (cbId, text) => tgCall("answerCallbackQuery", { callback_query_id: cbId, text });
const tgAction = (chatId, action) => tgCall("sendChatAction", { chat_id: chatId, action }).catch(() => {});

// ─── Chat buffer persistence ─────────────────────────────────────────────────
// Buffers must survive invocation boundaries: a burst can span the ~50s poll
// window, and the settle deadline may land in the next invocation.

async function loadBuffers() {
  const buffers = new Map();
  const res = await ddb.send(new ScanCommand({
    TableName: PENDING_TABLE,
    FilterExpression: "begins_with(id, :p)",
    ExpressionAttributeValues: { ":p": { S: BUFFER_KEY_PREFIX } },
  }));
  for (const item of res.Items || []) {
    const b = JSON.parse(item.buffer.S);
    buffers.set(b.chatId, b);
  }
  return buffers;
}

async function persistBuffer(b) {
  await ddb.send(new PutItemCommand({
    TableName: PENDING_TABLE,
    Item: {
      id: { S: `${BUFFER_KEY_PREFIX}${b.chatId}` },
      buffer: { S: JSON.stringify(b) },
      ttl: { N: String(Math.floor(Date.now() / 1000) + 3600) },
    },
  }));
}

async function deleteBuffer(chatId) {
  await ddb.send(new DeleteItemCommand({
    TableName: PENDING_TABLE,
    Key: { id: { S: `${BUFFER_KEY_PREFIX}${chatId}` } },
  }));
}

// ─── Offset persistence ──────────────────────────────────────────────────────

async function loadOffset() {
  const item = await ddb.send(new GetItemCommand({ TableName: PENDING_TABLE, Key: { id: { S: OFFSET_KEY } } }));
  return item.Item?.offset?.N ? Number(item.Item.offset.N) : 0;
}
async function saveOffset(offset) {
  await ddb.send(new PutItemCommand({
    TableName: PENDING_TABLE,
    Item: { id: { S: OFFSET_KEY }, offset: { N: String(offset) } },
  }));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
function icon(bug) { return bug.intent === "feature" ? "✨" : "🐛"; }
function esc(s) { return String(s).replace(/([_*`[\]])/g, "\\$1"); }
function truncate(s, n) { return s.length > n ? s.slice(0, n) + "…" : s; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
}
