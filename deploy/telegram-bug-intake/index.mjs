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
 * rework context. Dedupe is per REVIEW CYCLE, not per ticket: the orchestrator
 * acks a gate's review_needed when the review concludes and appends a fresh
 * notification (new notif.id) when the gate is re-parked after rework, so the
 * claim lives in PENDING_TABLE as gate#<notif.id> (legacy gate#<ticketId> when
 * a notification carries no id). Chat registry in chat#<chatId> (any chat that
 * ever messaged the bot). Each delivered page also publishes a `gate.requested`
 * EventBridge event tagged with business-hours context, and a page that landed
 * outside WM_BUSINESS_HOURS earns ONE reminder when the window opens
 * (repage#<notif.id>) — see "Working-hours gate paging".
 *
 * MANAGER ESCALATIONS: the same scan also pages every allowlisted chat when the
 * Workflow Manager records an unacknowledged manager_escalation. An open
 * escalation PARKS the run (the watch scheduler skips it), so without a ping
 * the run stays parked until someone happens to open the UI — the 9h
 * TEAM-3938 stall. The ✅ Resolved button PATCHes /api/workflow/[id]/escalations
 * (acknowledge all open), which is the only thing that puts the run back
 * under watch. Dedupe per escalation lives in PENDING_TABLE (esc#<notif.id>).
 */

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { TranscribeStreamingClient, StartStreamTranscriptionCommand } from "@aws-sdk/client-transcribe-streaming";
import { CodePipelineClient, GetPipelineStateCommand, PutApprovalResultCommand } from "@aws-sdk/client-codepipeline";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { parseCdRegistry, pipelineProjects } from "./cd-registry.mjs";

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
// Optional: the CI/CD deploy pipeline whose ManualApproval gate this bot bridges
// to Telegram. Unset (OSS / accounts without the pipeline) = no deploy pings.
// With ARTIFACT_BUCKET set this is only the FALLBACK target — the CD registry
// names the rest (see "CD registry deploy targets" below).
const DEPLOY_PIPELINE_NAME = process.env.DEPLOY_PIPELINE_NAME || "";
// Optional: the artifact bucket holding config/cd-registry.json, the list of
// repos the hub may merge + deploy. Set → the deploy-approval bridge watches
// EVERY registered repo's pipeline, in that repo's region. Unset → the single
// DEPLOY_PIPELINE_NAME target only, exactly as before.
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";
// The region every legacy client used implicitly (AWS_REGION is always set in
// Lambda). Registry entries carry their own region; this is the fallback for
// the env target, the registry read and pre-multi-target claim rows.
const DEFAULT_REGION = process.env.AWS_REGION || "us-east-1";
const MODEL_ID = process.env.BEDROCK_MODEL_ID || "us.anthropic.claude-sonnet-5";
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
// Paced transcription (TEAM-3464) costs ~the note's own duration in wall clock;
// this margin covers Transcribe connect/latency overhead on top of that.
const TRANSCRIBE_OVERHEAD_MS = 30_000;
// When Telegram omits the duration, transcribeVoice paces by FILE SIZE at this
// assumed byte rate (~32kbps OGG/Opus). The pre-flight budget estimate must use
// the SAME assumption, or a no-duration note bypasses the check and the paced
// stream dies mid-invocation.
const VOICE_FALLBACK_BYTE_RATE = 4000;
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

// CodePipeline is per-REGION now (a registered repo's pipeline can live
// anywhere), memoized so a warm container builds each client once. There is
// deliberately no module-level default instance: with nothing configured the
// deploy-approval path must construct no client at all.
const _cpByRegion = new Map();
function codepipelineFor(region) {
  const key = region || DEFAULT_REGION;
  let client = _cpByRegion.get(key);
  if (!client) {
    client = new CodePipelineClient({ region: key });
    _cpByRegion.set(key, client);
  }
  return client;
}

// S3 is only ever used to read the CD registry, which lives in the ONE artifact
// bucket in this Lambda's own region — so one lazy client, not one per region.
// Lazy on purpose: unconfigured installs (and the sibling test suites, which
// mock only the four SDK packages the intake paths use) never construct it.
let _s3 = null;
function s3Client() {
  if (!_s3) _s3 = new S3Client({ region: DEFAULT_REGION });
  return _s3;
}

// EventBridge carries ONE event out of this function: gate.requested (TEAM-4453
// D3). Lazy for the same reason as S3 — an install that never opens a gate
// constructs no client, and the sibling suites need not mock the package.
let _events = null;
function eventsClient() {
  if (!_events) _events = new EventBridgeClient({ region: DEFAULT_REGION });
  return _events;
}

// ─── Entry: poll loop ────────────────────────────────────────────────────────

// Sentinel: routeMessage had no runtime budget left for this update. The poll
// loop must stop BEFORE it — offset not advanced past it — so Telegram
// redelivers into the next invocation, which starts with a fresh clock.
const DEFER_UPDATE = Symbol("defer-update");

// Remaining time observed at handler entry ≈ the configured function timeout.
// Used to tell "no budget left THIS invocation" (defer) apart from "would not
// fit in ANY invocation" (reject), so a defer can never loop forever.
let invocationBudgetMs = 15 * 60_000;

export const handler = async (event, context) => {
  invocationBudgetMs = context.getRemainingTimeInMillis();
  let offset = await loadOffset();
  const buffers = await loadBuffers(); // chatId -> { chatId, parts, firstAt, lastAt }

  // Ping reviewers about any newly-parked human-review gate tickets. Errors
  // never block the poll loop — the next invocation retries (dedupe in DDB).
  // Re-scan every 60s INSIDE the loop too: one invocation long-polls ~14.5 min,
  // so a start-only scan made gate pings lag up to 15 min behind the gate.
  try { await scanReviewGates(); } catch (err) { console.error("[telegram-bug-intake] gate scan", err); }
  try { await scanManagerEscalations(); } catch (err) { console.error("[telegram-bug-intake] escalation scan", err); }
  try { await scanDeployApprovals(); } catch (err) { console.error("[telegram-bug-intake] deploy approval scan", err); }
  let lastGateScan = Date.now();

  while (context.getRemainingTimeInMillis() > POLL_RESERVE_MS) {
    if (Date.now() - lastGateScan > 60_000) {
      lastGateScan = Date.now();
      try { await scanReviewGates(); } catch (err) { console.error("[telegram-bug-intake] gate scan", err); }
      try { await scanManagerEscalations(); } catch (err) { console.error("[telegram-bug-intake] escalation scan", err); }
      try { await scanDeployApprovals(); } catch (err) { console.error("[telegram-bug-intake] deploy approval scan", err); }
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

    let deferred = false;
    for (const u of updates) {
      try {
        if (u.callback_query) await handleCallback(u.callback_query);
        else if (u.message) {
          if ((await routeMessage(u.message, buffers, context)) === DEFER_UPDATE) {
            deferred = true;
            break; // offset stays BEFORE this update → next invocation retries it
          }
        }
      } catch (err) {
        console.error("[telegram-bug-intake]", err);
        const chatId = u.message?.chat?.id || u.callback_query?.message?.chat?.id;
        if (chatId) await tgSend(chatId, `⚠️ Failed to process: ${err.message}`).catch(() => {});
      }
      offset = Math.max(offset, u.update_id);
    }
    if (updates.length) await saveOffset(offset);
    if (deferred) break;
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

  // Fail closed: an empty/unset allowlist authorizes NOBODY, not everybody.
  if (!ALLOWED_CHAT_IDS.includes(String(chatId))) {
    await tgSend(chatId, `Not authorized. Your chat id is \`${chatId}\` — add it to ALLOWED_CHAT_IDS.`);
    return;
  }

  await registerChat(chatId);

  let text = msg.text || msg.caption || "";

  // Native voice note → transcribe, echo what was heard, then treat the
  // transcript exactly like typed text (classification, buffering, wm relay).
  if (msg.voice) {
    let durationSec = msg.voice.duration;
    // Pre-flight getFile result, handed to transcribeVoice so the metadata
    // lookup happens ONCE per note — a second call could transiently fail and
    // drop a note that already passed the budget check.
    let voiceMeta = null;
    // Telegram can omit/zero the duration. transcribeVoice then paces by file
    // size, so the budget below must estimate the SAME wall clock from the
    // same byte rate — a zero here would collapse the estimate to overhead
    // only, let a huge note pass pre-flight, and die mid-stream before
    // saveOffset (redelivery loop).
    if (!(Number.isFinite(durationSec) && durationSec > 0)) {
      let fileSize = Number.isFinite(msg.voice.file_size) && msg.voice.file_size > 0
        ? msg.voice.file_size : 0;
      if (!fileSize) {
        try {
          voiceMeta = await tgCall("getFile", { file_id: msg.voice.file_id });
          if (Number.isFinite(voiceMeta?.file_size) && voiceMeta.file_size > 0) fileSize = voiceMeta.file_size;
        } catch (err) {
          console.error("[telegram-bug-intake] voice size lookup", err.message);
        }
      }
      if (!fileSize) {
        // Neither duration nor size — unbudgetable, so it must never be
        // replayed. Reject; the offset advances past it.
        await tgSend(chatId, "🎙️ Couldn't determine that voice note's length to transcribe it — try sending it again, or type the report.");
        return;
      }
      durationSec = fileSize / VOICE_FALLBACK_BYTE_RATE;
    }
    if (durationSec > 600) {
      await tgSend(chatId, "🎙️ That voice note is over 10 minutes — send a shorter one.");
      return;
    }
    // Paced streaming (TEAM-3464) means transcription takes ~the note's own
    // duration in wall clock. Budget it against the Lambda clock BEFORE
    // starting, or the invocation dies mid-transcription, the offset is never
    // saved, and Telegram redelivers the note forever (duplicate Transcribe
    // cost each round).
    const transcribeEstMs = durationSec * 1000 + TRANSCRIBE_OVERHEAD_MS;
    if (transcribeEstMs > invocationBudgetMs - POLL_RESERVE_MS) {
      // Would not fit even in a fresh invocation — reject, offset advances.
      await tgSend(chatId, "🎙️ That voice note is too long to transcribe in one run — send a shorter one.");
      return;
    }
    if (transcribeEstMs > context.getRemainingTimeInMillis() - POLL_RESERVE_MS) {
      // Fits in a fresh invocation, just not in what's left of this one.
      return DEFER_UPDATE;
    }
    await tgAction(chatId, "typing");
    const transcript = await transcribeVoice(msg.voice.file_id, msg.voice.duration || 0, voiceMeta);
    if (!transcript) {
      await tgSend(chatId, "🎙️ Couldn't make out any speech in that voice note — try again?");
      return;
    }
    await tgSendPlain(chatId, `🎙️ "${transcript}"`);
    text = text ? `${text}\n\n${transcript}` : transcript;
  }

  // A pending "Request changes" (or a reply to a gate ping) makes this message
  // the gate's rework note, not a bug report. Notes buffer like reports do:
  // Telegram splits a long paste into several messages, and a note that
  // arrives in parts must reach the gate as ONE comment — the old
  // consume-first-message path delivered part 1 and filed part 2 as a bug.
  if (text && !text.startsWith("/") && stripWmPrefix(text) == null) {
    const target = await resolveReworkTarget(chatId, text, msg);
    if (target === REWORK_HINTED) return;
    if (target) {
      const isNew = bufferPart(buffers, chatId, text, null);
      const b = buffers.get(chatId);
      b.rework = target;
      if (isNew) await tgAction(chatId, "typing");
      await persistBuffer(b);
      return;
    }
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
      if (b.rework) {
        await deliverReworkNote(b.chatId, b.rework, text);
      } else if (wmDirect != null && !fileIds.length) {
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

  // Fail closed, same as routeMessage: an empty/unset allowlist authorizes
  // NOBODY. Inline buttons outlive de-allowlisting — a revoked chat tapping an
  // old repo-picker button must not file tickets or cancel pending bugs. Ack
  // the tap (or Telegram re-sends the callback query) without acting on it.
  if (!ALLOWED_CHAT_IDS.includes(String(chatId))) {
    console.warn(`[telegram-bug-intake] unauthorized callback from chat ${chatId}: ${cb.data}`);
    await tgAnswer(cb.id, "Not authorized.");
    return;
  }

  // Deploy-approval buttons: dok|<approvalKey> / dno|<approvalKey>
  // (approvalKey indexes the CodePipeline token stashed in DDB — the token is
  // too long for Telegram's 64-byte callback_data limit.)
  if (action === "dok" || action === "dno") {
    await handleDeployApprovalCallback(cb, chatId, action, id);
    return;
  }

  // Review-gate buttons: gok|<ticketId>|<workflowId> / gno|<ticketId>|<workflowId>
  if (action === "gok" || action === "gno") {
    await handleGateCallback(cb, chatId, action, id, idx);
    return;
  }

  // Escalation-gate decision buttons: gdc|<m|c|x>|<ticketId>|<workflowId> (TEAM-3971)
  if (action === "gdc") {
    const [, opt, gateTicketId, gateWorkflowId] = (cb.data || "").split("|");
    await handleDecisionCallback(cb, chatId, opt, gateTicketId, gateWorkflowId);
    return;
  }

  // Parked rework-note buttons: rjr|<ticketId>|<workflowId> / rjx|<ticketId>
  if (action === "rjr" || action === "rjx") {
    await handleReworkRetryCallback(cb, chatId, action, id, idx);
    return;
  }

  // Manager-escalation button: eok|<workflowId> (resolves every open escalation
  // on the run — the notification id alone overflows Telegram's 64-byte
  // callback_data cap, and one open escalation is enough to park the run).
  if (action === "eok") {
    await handleEscalationCallback(cb, chatId, id);
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
// Runs in a terminal phase can still carry unacknowledged review_needed rows
// (legacy runs pre-date the approve-time ack). Nobody can act on those gates,
// so neither the gate nor the escalation scan pings for them.
const TERMINAL_PHASES = new Set(["complete", "completed", "cancelled", "canceled", "failed", "deploy-blocked", "static-ci-only"]);
// Release-manager convergence escalation gate — summary shape fixed by
// blueprints/release-manager.md ("Escalation gate ticket"); the orchestrator
// and the transition API match the same shape (TEAM-3971).
const ESCALATION_GATE_TITLE = /^Escalation #\d+: ship-review not converging/i;
const CHAT_KEY_PREFIX = "chat#";
const REJECT_KEY_PREFIX = "rej#";
// How long a ❌ tap waits for its note. Was 1h: a reviewer who tapped, then
// wrote the note later, lost the routing and the note was filed as a bug. DDB
// TTL deletion is lazy, so getPendingRejection checks the stamp itself.
const REJECT_TTL_SEC = 24 * 3600;
// Gate pings carry "🎫 <KEY>-<n>" — the handle a reply is matched on.
const JIRA_KEY_SRC = JIRA_PROJECT_KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TICKET_KEY_RE = new RegExp(`\\b${JIRA_KEY_SRC}-\\d+\\b`);
// A gate ping's subject and bullets can carry OTHER keys (workflow title,
// upstream tickets) before the 🎫 handle, so "first key in the text" can route a
// rework note to the wrong ticket. Anchor on the handle; first match is the
// fallback for pings without one.
const GATE_HANDLE_RE = new RegExp(`🎫\\s*\\[?(${JIRA_KEY_SRC}-\\d+)\\b`);
function gateKeyFromPing(text) {
  return text.match(GATE_HANDLE_RE)?.[1] || text.match(TICKET_KEY_RE)?.[0] || null;
}
// resolveReworkTarget: "told the reviewer how to attach it; do not file this".
const REWORK_HINTED = Symbol("rework-hinted");

// ─── Executive gate-ping formatting ──────────────────────────────────────────
// Every human decision ping (review gate, ship-review escalation, manager
// escalation, deploy approval) renders through ONE shape so Telegram reads at
// the same altitude as the hub's review view — verdict first, then substance,
// then the ask:
//   *KICKER*            what decision is this
//   subject             which run / PR
//   summary             one line: what changed & why
//   *What changed*      optional bullet list (key changes / findings / scope)
//   • …
//   meta                compact status line (reviewer · ticket · scope)
//   _ask_               the decision to make
// Free text (subject/summary/bullets) is esc()'d for legacy Markdown. `meta`
// entries are pre-built, link-safe strings and are NOT re-escaped.
function execPing({ kicker, subject, summary, bullets = [], meta = [], ask }) {
  const lines = [`*${kicker}*`];
  if (subject) lines.push(esc(String(subject)));
  if (summary && String(summary).trim()) lines.push("", esc(String(summary).trim()));
  const bl = (bullets || []).filter((b) => typeof b === "string" && b.trim()).slice(0, 6);
  if (bl.length) {
    lines.push("", "*What changed*");
    for (const b of bl) lines.push(`• ${esc(b.trim().slice(0, 200))}`);
  }
  const ml = (meta || []).filter(Boolean);
  if (ml.length) lines.push("", ml.join("  ·  "));
  if (ask) lines.push("", `_${esc(String(ask))}_`);
  return lines.join("\n");
}

// Flatten an agent-written ticket description into one phone-readable line:
// drop code fences, turn [label](url) into label, strip bare workflows/…md
// paths and Markdown syntax noise, collapse whitespace, clip. (The old code
// dropped the description entirely because those raw paths rendered as broken
// links — cleaning them lets us keep the actual prose.)
function cleanDesc(s) {
  if (typeof s !== "string") return "";
  return s
    .replace(/```[\s\S]*?```/g, " ")         // fenced code blocks
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")  // [label](url) → label
    .replace(/\bworkflows\/\S+/g, "")         // bare in-run artifact paths
    .replace(/[#>*_`]/g, "")                  // residual Markdown syntax
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

// Short executive label for a review-gate kicker. Prefer the review-package
// phase (spec/plan/design/dev/qa/ship); fall back to the gate ticket title.
function gateLabel(gate, title) {
  const g = String(gate || "").toLowerCase();
  const map = [
    ["requirement", "SPEC"], ["spec", "SPEC"], ["plan", "PLAN"],
    ["design", "DESIGN"], ["dev", "CODE"], ["qa", "QA"], ["ship", "SHIP"],
  ];
  for (const [k, v] of map) if (g.includes(k)) return v;
  return String(title || "REVIEW").toUpperCase().slice(0, 24);
}

// ─── Working-hours gate paging (TEAM-4453 D3) ────────────────────────────────
// A gate page fires the moment the gate opens, including 02:00 on a Saturday.
// Two things follow from that: (1) every page is tagged with business-hours
// context and published as `gate.requested`, so the metrics side can tell "the
// reviewer was asleep" from "the reviewer was slow"; (2) a gate first paged
// outside the window gets ONE reminder when the window opens.
//
// The request-time page is NEVER suppressed or delayed by any of this — a gate
// that opens at 02:00 still pages at 02:00. The window only adds a reminder.
//
// Window semantics are the WM's: half-open [start, end) LOCAL hours, 24h clock,
// Sat/Sun always outside, same WM_BUSINESS_HOURS / WM_BUSINESS_TZ vars and the
// same HH-HH regex as compute_metrics.business_window(). The DEFAULTS differ on
// purpose: paging a human is a push, so it assumes the operator's own working
// day (09-18 America/Los_Angeles) rather than the analyzer's 08-18 UTC.
const BUSINESS_WINDOW_DEFAULTS = { timeZone: "America/Los_Angeles", start: 9, end: 18, days: [1, 2, 3, 4, 5] };
const BUSINESS_HOURS_RE = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/;
const DAY_MS = 24 * 3600 * 1000;
const WEEKDAY_NUM = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

let _businessWindow = null;
/**
 * The configured window, resolved once per container on the FIRST scan (not at
 * module load: a bad value must not break the import for the intake paths that
 * never look at it). Anything unparseable falls back to the documented defaults
 * with exactly one warn — a typo'd zone must not silently re-page every gate.
 */
function businessWindow(env = process.env) {
  if (_businessWindow) return _businessWindow;
  const w = { ...BUSINESS_WINDOW_DEFAULTS };
  try {
    const tz = env.WM_BUSINESS_TZ;
    if (tz !== undefined && tz !== null) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: String(tz) });
        w.timeZone = String(tz);
      } catch {
        console.warn(`[telegram-bug-intake] WM_BUSINESS_TZ="${tz}" is not a known time zone — using ${w.timeZone} for the business-hours reminder; request-time gate pages are unaffected`);
      }
    }
    const spec = env.WM_BUSINESS_HOURS;
    if (spec !== undefined && spec !== null) {
      const m = BUSINESS_HOURS_RE.exec(String(spec));
      const start = m ? Number(m[1]) : NaN;
      const end = m ? Number(m[2]) : NaN;
      if (m && start >= 0 && start < end && end <= 24) {
        w.start = start;
        w.end = end;
      } else {
        console.warn(`[telegram-bug-intake] WM_BUSINESS_HOURS="${spec}" is not HH-HH — using ${w.start}-${w.end} for the business-hours reminder; request-time gate pages are unaffected`);
      }
    }
  } catch (err) {
    console.warn(`[telegram-bug-intake] business window fell back to defaults: ${err.message}; request-time gate pages are unaffected`);
    Object.assign(w, BUSINESS_WINDOW_DEFAULTS);
  }
  _businessWindow = w;
  return w;
}

/** Test seam: drop the memo so a suite can re-evaluate the env. */
export function _resetBusinessWindowForTests() {
  _businessWindow = null;
}

/** Wall-clock parts of `date` in `timeZone` (dow: 0 = Sunday). */
function localParts(date, timeZone) {
  const parts = {};
  for (const { type, value } of new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false, weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date)) parts[type] = value;
  return {
    y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day),
    // Some ICU builds render local midnight as hour "24" under hour12:false.
    h: Number(parts.hour) % 24, mi: Number(parts.minute), s: Number(parts.second),
    dow: WEEKDAY_NUM[parts.weekday],
  };
}

/**
 * Was the human ASKED outside their window? `null` when there is no usable
 * timestamp — an unknown answer must never read as "inside" (which would emit a
 * misleading outsideHours:false) nor as "outside" (which would re-page).
 */
export function isOutsideHours(ts, w = businessWindow()) {
  const t = ts ? new Date(ts) : null;
  if (!t || Number.isNaN(t.getTime())) return null;
  const p = localParts(t, w.timeZone);
  return !(w.days.includes(p.dow) && p.h >= w.start && p.h < w.end);
}

/**
 * The UTC instant of local wall time `hour:00` on y-mo-d in `timeZone`.
 * DST-safe by MEASURING the zone's offset instead of assuming one: take the
 * offset at the naive instant, correct, then re-measure at the corrected
 * instant (one iteration is enough for every real zone, including a jump).
 */
function zonedInstant(y, mo, d, hour, timeZone) {
  const target = Date.UTC(y, mo - 1, d, hour, 0, 0);
  const offsetAt = (ms) => {
    const p = localParts(new Date(ms), timeZone);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - ms;
  };
  return new Date(target - offsetAt(target - offsetAt(target)));
}

/**
 * The earliest window OPEN at or after `ts` — `ts` itself when it is already
 * in-hours. Walks forward a local day at a time so a weekend hops to Monday.
 * Fail-safe: anything unexpected yields ts+24h, which delays a reminder by a
 * day rather than firing it at the wrong hour or crashing the scan.
 */
export function nextBusinessOpenAt(ts, w = businessWindow()) {
  const t = ts ? new Date(ts) : null;
  if (!t || Number.isNaN(t.getTime())) return null;
  try {
    const here = localParts(t, w.timeZone);
    if (w.days.includes(here.dow) && here.h >= w.start && here.h < w.end) return t;
    for (let i = 0; i < 8; i++) {
      const day = i === 0 ? here : localParts(new Date(t.getTime() + i * DAY_MS), w.timeZone);
      if (!w.days.includes(day.dow)) continue;
      const open = zonedInstant(day.y, day.mo, day.d, w.start, w.timeZone);
      if (open.getTime() >= t.getTime()) return open;
    }
  } catch (err) {
    console.warn(`[telegram-bug-intake] nextBusinessOpenAt(${ts}) failed: ${err.message} — deferring the reminder 24h`);
  }
  return new Date(t.getTime() + DAY_MS);
}

// One re-page per NOTIFICATION (not per ticket, and not per scan): a gate
// re-parked after rework mints a fresh notif.id and earns its own reminder.
const REPAGE_KEY_PREFIX = "repage#";
// The gate is only acked at approve time, so a gate resolved from the board
// still looks pending here. Ask the ticket itself before nagging about it.
const REPAGE_SKIP_STATUSES = new Set(["done", "blocked", "cancelled", "canceled"]);

/** The gate's own ticket row, or null when the tickets view is unavailable. */
async function gateTicketOf(wf, notif) {
  try {
    const res = await fetch(`${HUB_API_URL}/api/workflow/${wf.workflowId}/tickets`);
    if (!res.ok) return null;
    const { tickets = [] } = await res.json();
    return tickets.find((t) => t.ticketId === notif.ticketId) || null;
  } catch {
    return null; // a reminder is cheap; a missed one is not
  }
}

/**
 * Publish `gate.requested` for a page that has just gone out. Best-effort by
 * construction: the page is already delivered and the gate# claim is already
 * held, so a publish failure is logged and nothing else — it must never release
 * the claim (that would re-send the page) and never re-send by itself.
 */
async function publishGateRequested(wf, notif, w) {
  try {
    const outsideHours = isOutsideHours(notif.timestamp, w);
    const openAt = outsideHours === null ? null : nextBusinessOpenAt(notif.timestamp, w);
    await eventsClient().send(new PutEventsCommand({
      Entries: [{
        EventBusName: process.env.EVENT_BUS || "default",
        Source: "agentcore-hub.orchestrator",
        DetailType: "gate.requested",
        Detail: JSON.stringify({
          ticketId: notif.ticketId,
          workflowId: wf.workflowId,
          reviewer: notif.reviewer || null,
          requestedAt: notif.timestamp ?? null,
          outsideHours,
          nextBusinessOpenAt: openAt ? openAt.toISOString() : null,
          producer: "telegram-bug-intake",
          timestamp: new Date().toISOString(),
        }),
      }],
    }));
  } catch (err) {
    console.error("[telegram-bug-intake] gate.requested publish", err.message);
  }
}

/**
 * The gate# claim already exists (this notification was paged on an earlier
 * scan). If that page landed outside the window and the window has since
 * opened, send exactly ONE reminder, deduped on repage#<notif>. Never throws:
 * a failure here must not cost the remaining pending gates their pages.
 */
async function repageIfWindowOpened(wf, notif, w) {
  let holding = null;
  try {
    if (isOutsideHours(notif.timestamp, w) !== true) return;
    const openAt = nextBusinessOpenAt(notif.timestamp, w);
    if (!openAt || Date.now() < openAt.getTime()) return;

    const key = `${REPAGE_KEY_PREFIX}${notif.id || notif.ticketId}`;
    if (!(await claimKey(key))) return; // already reminded
    holding = key;

    // Resolved in the meantime → keep the claim: there is nothing to remind
    // about and re-checking on every later scan would be pure noise.
    const gateTicket = await gateTicketOf(wf, notif);
    const status = String(gateTicket?.status || "").toLowerCase();
    if (REPAGE_SKIP_STATUSES.has(status)) return;

    const chats = (await listChats()).filter((c) => ALLOWED_CHAT_IDS.includes(String(c)));
    if (!chats.length) {
      console.warn("[telegram-bug-intake] business-hours reminder but no allowlisted chats to notify");
      return; // the request-time page already went out; do not retry forever
    }

    const title = gateTicket?.title || notif.ticketId;
    const reviewer = notif.reviewer || "reviewer";
    const text = execPing({
      kicker: `${gateLabel(notif.gate, title)} REVIEW · business-hours reminder`,
      subject: wf.input?.title || wf.workflowId,
      summary: `${title} was sent for review outside working hours and is still open. Your window is open now.`,
      meta: [
        `👤 ${esc(reviewer)}`,
        `🎫 [${notif.ticketId}](https://${JIRA_SITE_URL}/browse/${notif.ticketId})`,
        "⏸ pipeline paused on you",
      ],
      ask: "Approve to continue, or Request changes to send it back.",
    });
    const keyboard = { inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `gok|${notif.ticketId}|${wf.workflowId}` },
        { text: "❌ Request changes", callback_data: `gno|${notif.ticketId}|${wf.workflowId}` },
      ],
      [{
        text: "📱 Open approval in hub",
        url: `${HUB_API_URL}/workflow?id=${encodeURIComponent(wf.workflowId)}&ticket=${encodeURIComponent(notif.ticketId)}`,
      }],
    ] };

    let delivered = 0;
    for (const chatId of chats) {
      await tgSend(chatId, text, { reply_markup: keyboard });
      delivered++;
    }
    if (!delivered) await releaseKey(holding);
  } catch (err) {
    console.error(`[telegram-bug-intake] business-hours reminder for ${notif.ticketId}`, err.message);
    if (holding) {
      await releaseKey(holding).catch((relErr) =>
        console.error("[telegram-bug-intake] releaseKey after reminder failure", relErr.message));
    }
  }
}

async function scanReviewGates() {
  const res = await fetch(`${HUB_API_URL}/api/workflow/list`);
  if (!res.ok) throw new Error(`workflow/list ${res.status}`);
  const { workflows = [] } = await res.json();

  const pending = [];
  for (const wf of workflows) {
    if (TERMINAL_PHASES.has(String(wf.phase || wf.status || "").toLowerCase())) continue;
    for (const n of wf.humanNotifications || []) {
      if (n.type === "review_needed" && !n.acknowledged) {
        pending.push({ wf, notif: n });
      }
    }
  }
  if (!pending.length) return;

  const window = businessWindow(); // resolved once per container, on the first scan
  let chats = null; // fetched lazily — most scans find nothing new
  let pinged = 0;
  for (const { wf, notif } of pending) {
    const claimed = await claimGate(notif);
    if (!claimed) {
      // Already paged. The only thing left to do for this gate is the
      // once-per-notification reminder, if its page landed out of hours.
      await repageIfWindowOpened(wf, notif, window);
      continue;
    }
    pinged++;

    // The claim is written before delivery is proven, so ANY throw between
    // here and a delivered ping (e.g. a transient listChats Scan failure)
    // must release it — a stranded claim silences this gate for 30 days.
    try {
      // The chat registry is historical — chat# rows outlive de-allowlisting.
      // Gate pings must respect the same allowlist as inbound messages, or the
      // ping leaks workflow titles/links to revoked chats AND their delivery
      // counts toward `delivered`, suppressing the retry for real reviewers.
      chats = chats || (await listChats()).filter((c) => ALLOWED_CHAT_IDS.includes(String(c)));
      if (!chats.length) {
        console.warn("[telegram-bug-intake] gate ticket but no allowlisted chats to notify");
        await releaseGate(notif); // nobody was pinged — let a later scan retry
        continue;
      }

      // Pull the whole ticket set so the ping is SELF-CONTAINED — the reviewer
      // decides from Telegram without opening the hub. From it we take: the gate
      // ticket's title + cleaned description, and the titles of the UPSTREAM work
      // it blocks on (blockedBy) — i.e. exactly what is being reviewed.
      let title = notif.ticketId;
      let gateTicket = null;
      let upstreamTitles = [];
      try {
        const tRes = await fetch(`${HUB_API_URL}/api/workflow/${wf.workflowId}/tickets`);
        if (tRes.ok) {
          const { tickets = [] } = await tRes.json();
          gateTicket = tickets.find((x) => x.ticketId === notif.ticketId) || null;
          if (gateTicket?.title) title = gateTicket.title;
          const byId = new Map(tickets.map((x) => [x.ticketId, x]));
          upstreamTitles = (gateTicket?.blockedBy || [])
            .map((id) => byId.get(id)?.title)
            .filter(Boolean)
            .slice(0, 5);
        }
      } catch { /* ping still goes out with the id */ }

      const reviewer = notif.reviewer || "reviewer";
      const isEscalation = ESCALATION_GATE_TITLE.test(title);
      const gateName = gateLabel(notif.gate, title);
      const ticketLink = `🎫 [${notif.ticketId}](https://${JIRA_SITE_URL}/browse/${notif.ticketId})`;
      // Body content, best source first: the closing agent's curated review
      // package (summary/bullets), else the gate ticket's own description, else
      // the list of upstream items under review. The ping is never empty.
      const pkgSummary = typeof notif.summary === "string" ? notif.summary.trim() : "";
      const desc = cleanDesc(gateTicket?.description);
      const summary =
        pkgSummary ||
        desc ||
        (upstreamTitles.length
          ? `Reviewing ${upstreamTitles.length} completed item${upstreamTitles.length === 1 ? "" : "s"} before this phase proceeds.`
          : `${title} is ready for your review.`);
      const bullets =
        (Array.isArray(notif.bullets) && notif.bullets.length)
          ? notif.bullets
          : upstreamTitles; // the actual work under review = "What changed"
      // TEAM-3971: a ship-review escalation needs a DECISION, not a bare approve
      // (a bare approve used to park the release manager forever). Offer the
      // three decisions as buttons; each records a `DECISION:` line on the gate.
      const text = isEscalation
        ? execPing({
            kicker: `🚨 SHIP-REVIEW ESCALATION — ${gateName}`,
            subject: wf.input?.title || wf.workflowId,
            summary: summary || "The ship-review loop hit its round cap and needs a human call.",
            bullets,
            meta: [`👤 ${esc(reviewer)}`, ticketLink],
            ask: "Pick ONE decision below — it is recorded as a DECISION line and the release manager resumes on its own.",
          })
        : execPing({
            kicker: `🚦 ${gateName} REVIEW GATE — approval needed`,
            subject: wf.input?.title || wf.workflowId,
            summary: summary || `${title} is ready for your review.`,
            bullets,
            meta: [`👤 ${esc(reviewer)}`, ticketLink, "⏸ pipeline paused on you"],
            ask: "Approve to continue, or Request changes to send it back.",
          });
      const keyboard = { inline_keyboard: isEscalation
        ? [
            [{ text: "✅ Merge with known findings", callback_data: `gdc|m|${notif.ticketId}|${wf.workflowId}` }],
            [
              { text: "🔁 Continue rework", callback_data: `gdc|c|${notif.ticketId}|${wf.workflowId}` },
              { text: "🛑 Cancel run", callback_data: `gdc|x|${notif.ticketId}|${wf.workflowId}` },
            ],
          ]
        : [[
            { text: "✅ Approve", callback_data: `gok|${notif.ticketId}|${wf.workflowId}` },
            { text: "❌ Request changes", callback_data: `gno|${notif.ticketId}|${wf.workflowId}` },
          ]] };

      // Consistent artifact set for EVERY review gate: the hub approval view is
      // always the primary link (the one screen with the full review package +
      // Merge Brief and the approve controls), followed by the review package's
      // CURATED deliverables. Those links are authored by the agent that closed
      // the phase (loadReviewPackage), so they are deterministic and gate-scoped
      // — unlike the old "freshest 3 markdown files" scan, which surfaced a
      // different, often-irrelevant set on every ping.
      keyboard.inline_keyboard.push([{
        text: "📱 Open approval in hub",
        url: `${HUB_API_URL}/workflow?id=${encodeURIComponent(wf.workflowId)}&ticket=${encodeURIComponent(notif.ticketId)}`,
      }]);
      for (const l of (Array.isArray(notif.links) ? notif.links : []).slice(0, 4)) {
        if (!l || !l.label) continue;
        const url = l.url
          ? l.url
          : l.artifactKey
            ? `${HUB_API_URL}/workflow?id=${encodeURIComponent(wf.workflowId)}&artifact=${encodeURIComponent(l.artifactKey)}`
            : null;
        if (url) keyboard.inline_keyboard.push([{ text: `📄 ${l.label}`.slice(0, 60), url }]);
      }

      let delivered = 0;
      for (const chatId of chats) {
        try { await tgSend(chatId, text, { reply_markup: keyboard }); delivered++; }
        catch (err) { console.error(`[telegram-bug-intake] gate ping to ${chatId}`, err.message); }
      }
      // The claim was written before delivery was proven; if every send failed,
      // keeping it would silently skip this gate for 30 days.
      if (!delivered) await releaseGate(notif);
      // Exactly one gate.requested per notification, and only for a page that
      // actually landed — it is the metrics record of "the human was asked".
      else await publishGateRequested(wf, notif, window);
    } catch (err) {
      await releaseGate(notif).catch((relErr) =>
        console.error("[telegram-bug-intake] releaseGate after gate failure", relErr.message));
      throw err;
    }
  }
  if (pinged) console.log(`[telegram-bug-intake] review gates: ${pending.length} open, ${pinged} newly pinged`);
}

/**
 * Dedupe key for ONE review cycle. The orchestrator mints a new notif.id every
 * time it parks a gate (notif_<ticket>_<ISO>) and acks the old one when the
 * review concludes; keying on the ticket alone silenced every cycle after the
 * first (a rework → re-park of the same gate never pinged, TEAM-4343 Merge
 * Approval). Notifications without an id (older runs) fall back to the ticket.
 */
function gateClaimKey(notif) {
  return `${GATE_KEY_PREFIX}${notif.id || notif.ticketId}`;
}

/** Atomically claim a review cycle for notification. False = already pinged. */
async function claimGate(notif) {
  try {
    await ddb.send(new PutItemCommand({
      TableName: PENDING_TABLE,
      Item: {
        id: { S: gateClaimKey(notif) },
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

/** Drop a review cycle's claim so a later scan can retry the ping. */
async function releaseGate(notif) {
  await ddb.send(new DeleteItemCommand({
    TableName: PENDING_TABLE,
    Key: { id: { S: gateClaimKey(notif) } },
  }));
}

async function handleGateCallback(cb, chatId, action, ticketId, workflowId) {
  // Gate pings go to every registered chat, but only allowlisted chats may
  // transition tickets. Ack the tap (or Telegram re-sends the callback query)
  // without acting on it.
  if (!ALLOWED_CHAT_IDS.includes(String(chatId))) {
    console.warn(`[telegram-bug-intake] unauthorized gate callback from chat ${chatId} for ${ticketId}`);
    await tgAnswer(cb.id, "Not authorized to review gates.");
    return;
  }
  if (action === "gok") {
    const res = await transitionGate(workflowId, ticketId, "done", `Approved via Telegram by chat ${chatId}`);
    // A ❌ tapped by mistake before this ✅ left a marker that would turn the
    // chat's next message into a rework note for a gate that is now done.
    const stale = await getPendingRejection(chatId);
    if (stale?.ticketId === ticketId) await deletePendingRejection(chatId);
    await tgAnswer(cb.id, `Approved ${ticketId}`);
    // TEAM-3971: the API records a bare approve on an escalation gate as
    // DECISION: merge-with-known-findings — say so, the human should know.
    const note = res?.decisionDefaulted
      ? `✅ Approved — recorded as DECISION: ${res.decisionDefaulted}; release manager resuming.`
      : `✅ Approved — pipeline resuming.`;
    await tgEdit(chatId, cb.message.message_id, `${cb.message.text}\n\n${note}`);
    return;
  }
  // Request changes: the ticket needs a rework note. Park the intent; the
  // chat's next plain message — or a reply to this ping, any time — becomes
  // the note (resolveReworkTarget → deliverReworkNote).
  await putPendingRejection(chatId, ticketId, workflowId);
  await tgAnswer(cb.id, "Reply with what needs to change.");
  await tgEdit(chatId, cb.message.message_id,
    `${cb.message.text}\n\n❌ Changes requested — reply with a note describing what to change (your next message here, or a reply to this message later). It goes to the agents as rework context. ` +
    `(On an escalated gate, a line reading exactly "DECISION: continue" authorizes more rework rounds.)`);
}

// Escalation-gate decisions (TEAM-3971). Same vocabulary as the release-manager
// blueprint and lambda/orchestrator/review-cap.mjs DECISIONS.
const GATE_DECISIONS = { m: "merge-with-known-findings", c: "continue", x: "cancel" };

async function handleDecisionCallback(cb, chatId, opt, ticketId, workflowId) {
  if (!ALLOWED_CHAT_IDS.includes(String(chatId))) {
    console.warn(`[telegram-bug-intake] unauthorized decision callback from chat ${chatId} for ${ticketId}`);
    await tgAnswer(cb.id, "Not authorized to decide gates.");
    return;
  }
  const decision = GATE_DECISIONS[opt];
  if (!decision || !ticketId || !workflowId) {
    await tgAnswer(cb.id, "Unknown decision — use the buttons on a current escalation ping.");
    return;
  }
  // The DECISION line is what the release manager parses (last well-formed
  // line wins); Done is what wakes the orchestrator, which re-drives the RM.
  await transitionGate(workflowId, ticketId, "done",
    `Decided via Telegram by chat ${chatId}\nDECISION: ${decision}`);
  let tail = "";
  if (decision === "cancel") {
    try {
      const res = await fetch(`${HUB_API_URL}/api/workflow/${encodeURIComponent(workflowId)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: `DECISION: cancel via Telegram by chat ${chatId}` }),
      });
      tail = res.ok ? " Workflow cancelled." : ` Workflow cancel returned ${res.status} — cancel it from the console.`;
    } catch (err) {
      tail = ` Workflow cancel failed (${err.message}) — cancel it from the console.`;
    }
  } else {
    tail = " Release manager resuming.";
  }
  await tgAnswer(cb.id, `Recorded DECISION: ${decision}`);
  await tgEdit(chatId, cb.message.message_id,
    `${cb.message.text}\n\n✅ DECISION: ${decision} recorded on ${ticketId}.${tail}`);
}

/**
 * Which gate, if any, is this chat's plain message a rework note for?
 *  (a) a pending ❌ tap (rej#<chatId>), or
 *  (b) a Telegram reply to a gate ping — the ping carries the ticket key; the
 *      workflow id comes from its buttons, or from the ticket's `wf:` label once
 *      the buttons are gone (the ❌ edit drops the keyboard).
 * Returns REWORK_HINTED for a DECISION line with no gate waiting: the reviewer
 * was told how to attach it, and the message must not be filed.
 */
async function resolveReworkTarget(chatId, text, msg) {
  const pending = await getPendingRejection(chatId);
  if (pending) return { ticketId: pending.ticketId, workflowId: pending.workflowId };
  const replied = await gateFromReply(msg);
  if (replied) return replied;
  // "DECISION:" is the gate vocabulary this bot itself teaches. Filing one as a
  // bug/feature launders a review verdict into a brand-new pipeline run.
  if (/^\s*DECISION:\s*\S/im.test(text)) {
    await tgSend(chatId,
      "That reads like a review decision, but no gate is waiting on this chat. " +
      "Tap ❌ Request changes on the gate ping first, or send the note as a reply to that ping.");
    return REWORK_HINTED;
  }
  return null;
}

async function gateFromReply(msg) {
  const r = msg?.reply_to_message;
  if (!r) return null;
  const rtext = String(r.text || r.caption || "");
  if (!/REVIEW GATE|SHIP-REVIEW ESCALATION|Changes requested/i.test(rtext)) return null;
  const ticketId = gateKeyFromPing(rtext);
  if (!ticketId) return null;
  let workflowId = null;
  for (const row of r.reply_markup?.inline_keyboard || []) {
    for (const btn of row) {
      const p = String(btn.callback_data || "").split("|");
      if ((p[0] === "gok" || p[0] === "gno") && p[1] === ticketId) workflowId = p[2];
      else if (p[0] === "gdc" && p[2] === ticketId) workflowId = p[3];
    }
  }
  if (!workflowId) workflowId = await workflowIdFromTicket(ticketId);
  return workflowId ? { ticketId, workflowId } : null;
}

/** The gate ticket's `wf:<id>` label — the hub's own workflow pointer. */
async function workflowIdFromTicket(ticketId) {
  try {
    const res = await fetch(`https://${JIRA_SITE_URL}/rest/api/3/issue/${encodeURIComponent(ticketId)}?fields=labels`, {
      headers: { Authorization: JIRA_AUTH, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const { fields } = await res.json();
    const label = (fields?.labels || []).find((l) => typeof l === "string" && l.startsWith("wf:"));
    return label ? label.slice(3) : null;
  } catch (err) {
    console.error(`[telegram-bug-intake] wf label lookup ${ticketId}`, err.message);
    return null;
  }
}

async function getPendingRejection(chatId) {
  const { Item: item } = await ddb.send(new GetItemCommand({
    TableName: PENDING_TABLE, Key: { id: { S: `${REJECT_KEY_PREFIX}${chatId}` } },
  }));
  if (!item?.ticketId?.S || !item?.workflowId?.S) return null;
  const ttl = Number(item.ttl?.N);
  if (Number.isFinite(ttl) && ttl > 0 && ttl <= Math.floor(Date.now() / 1000)) return null;
  return { ticketId: item.ticketId.S, workflowId: item.workflowId.S, note: item.note?.S || null };
}

async function putPendingRejection(chatId, ticketId, workflowId, note = null) {
  await ddb.send(new PutItemCommand({
    TableName: PENDING_TABLE,
    Item: {
      id: { S: `${REJECT_KEY_PREFIX}${chatId}` },
      ticketId: { S: ticketId },
      workflowId: { S: workflowId },
      ...(note ? { note: { S: note } } : {}),
      ttl: { N: String(Math.floor(Date.now() / 1000) + REJECT_TTL_SEC) },
    },
  }));
}

async function deletePendingRejection(chatId) {
  await ddb.send(new DeleteItemCommand({
    TableName: PENDING_TABLE, Key: { id: { S: `${REJECT_KEY_PREFIX}${chatId}` } },
  }));
}

/**
 * Send the rework note to the gate: in_review → blocked, note as the comment
 * the orchestrator hands to the re-opened agents. The marker is cleared only
 * AFTER the transition lands. On failure the note is parked ON the marker with
 * Retry / Drop buttons. (2026-09-10: the Jira workflow had no In Review →
 * Blocked transition, the hub 409'd, and because the marker had already been
 * deleted the reviewer's re-typed note went through bug intake as a new report.)
 */
async function deliverReworkNote(chatId, { ticketId, workflowId }, text) {
  try {
    await transitionGate(workflowId, ticketId, "blocked", `Changes requested via Telegram: ${text}`);
  } catch (err) {
    console.error(`[telegram-bug-intake] rework note for ${ticketId} not delivered:`, err.message);
    await putPendingRejection(chatId, ticketId, workflowId, text);
    await tgSend(chatId,
      `⚠️ Couldn't send *${esc(ticketId)}* back for rework: ${esc(err.detail || err.message)}\n\n` +
      `Your note is saved here — it was NOT filed as a bug. Fix the cause and tap Retry, or Drop it.`,
      { reply_markup: { inline_keyboard: [[
        { text: "🔁 Retry", callback_data: `rjr|${ticketId}|${workflowId}` },
        { text: "🗑 Drop note", callback_data: `rjx|${ticketId}` },
      ]] } });
    return false;
  }
  await deletePendingRejection(chatId);
  await tgSend(chatId, `❌ *${esc(ticketId)}* — changes requested. Your note is on the ticket; upstream work re-opens for rework.`);
  return true;
}

// Parked-note buttons: rjr|<ticketId>|<workflowId> re-sends the saved note;
// rjx|<ticketId> drops it (the gate stays parked on the human either way).
async function handleReworkRetryCallback(cb, chatId, action, ticketId, workflowId) {
  if (action === "rjx") {
    await deletePendingRejection(chatId);
    await tgAnswer(cb.id, "Dropped");
    await tgEdit(chatId, cb.message.message_id,
      `${cb.message.text}\n\n🗑 Note dropped. ${ticketId} is still waiting on you.`);
    return;
  }
  const pending = await getPendingRejection(chatId);
  if (!pending || pending.ticketId !== ticketId || !pending.note) {
    await tgAnswer(cb.id, "Nothing saved to retry — send the note again.");
    return;
  }
  await tgAnswer(cb.id, "Retrying…");
  const ok = await deliverReworkNote(chatId, { ticketId, workflowId: workflowId || pending.workflowId }, pending.note);
  await tgEdit(chatId, cb.message.message_id,
    `${cb.message.text}\n\n${ok ? "✅ Delivered on retry." : "↻ Retry failed — see below."}`);
}

async function transitionGate(workflowId, ticketId, targetStatus, comment) {
  const res = await fetch(`${HUB_API_URL}/api/workflow/${workflowId}/tickets/transition`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticketId, targetStatus, comment }),
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    // A hub refusal carries the ticket Lambda's reason in `details` (e.g. "No
    // transition to \"Blocked\" found…") — that is what the human needs to see.
    let detail = raw;
    try { const j = JSON.parse(raw); detail = j.details || j.error || raw; } catch { /* not JSON */ }
    const err = new Error(`transition ${res.status}: ${detail}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  // Body is informational (e.g. decisionDefaulted, TEAM-3971) — never required.
  try { return await res.json(); } catch { return {}; }
}

// ─── Workflow Manager escalations ────────────────────────────────────────────
// intervene.py `escalate` appends an unacknowledged manager_escalation to the
// workflow's humanNotifications and the watch scheduler (workflow-analyzer)
// skips the run while one is open. Nothing else surfaces it, so a run parked
// this way is invisible until a human opens the UI. Page every allowlisted
// chat once per escalation with a Resolved button that acknowledges it.

const ESC_KEY_PREFIX = "esc#";
const ESC_DETAIL_MAX = 700;
// A finished run cannot be "parked" — its leftover escalations are history, not
// work. Paging them would only flood the chat (first rollout pinged ~40 stale
// ones from completed runs). Terminal phases per the orchestrator's
// claimTerminalOutcome: complete / cancelled / deploy-blocked / static-ci-only.

// TEAM-4120 FR-3 — a dead-session escalation is a different DECISION from a
// Workflow Manager escalation: the run is not asking "what should I do", it is
// telling you an agent died, what evidence survived, and what it did about it.
// These three reviewers are the emitters of that page (the two exhausted-retry
// emitters kept their legacy reviewer strings, so old rows still land here).
const DEAD_SESSION_REVIEWERS = new Set(["dead-session-detector", "reconcile-sweep", "dead-session-escalation"]);

// ─── byte-identical copy — parity test in deploy/telegram-bug-intake/redact-parity.test.mjs ───
// Copied VERBATIM from lambda/orchestrator/dead-session-escalation.mjs. The page
// already carries a redacted `lastText`, but this Lambda re-redacts before it
// leaves the account: a legacy row (written before FR-3) is raw, and Telegram is
// off-account, so the last line of defense belongs here. Do NOT "improve" one
// copy — the parity test asserts the two function bodies are byte-equal.
function clipText(s, n) {
  const str = typeof s === "string" ? s : "";
  if (n <= 0) return "";
  return str.length > n ? `${str.slice(0, Math.max(0, n - 1))}…` : str;
}

function redactText(s) {
  let t = typeof s === "string" ? s : "";
  if (!t) return "";
  const R = "[REDACTED]";

  // Private keys first — the multi-line blob would otherwise be shredded by the
  // whitespace collapse below and never match.
  t = t.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, R);

  // Presigned-URL query strings: keep the path (it identifies the artifact),
  // redact every value (SigV4 signature/credential live here).
  t = t.replace(/([a-zA-Z][\w+.-]*:\/\/[^\s?]+\?)([^\s]*)/g, (_m, head, qs) =>
    head + qs.replace(/([^&=]+)=([^&]*)/g, (__, k) => `${k}=${R}`)
  );
  // …and bare SigV4 params that arrive without a host (log lines, curl echoes).
  // The value stops at `&` so a param list keeps every KEY NAME visible instead
  // of a single greedy match swallowing the rest of the query.
  t = t.replace(/X-Amz-(Signature|Credential|Security-Token|Algorithm|Date|Expires|SignedHeaders)=[^\s&]+/gi,
    (_m, p) => `X-Amz-${p}=${R}`);

  // Provider tokens — longest/most specific patterns first.
  t = t.replace(/github_pat_[A-Za-z0-9_]{20,}/g, R);
  t = t.replace(/ghp_[A-Za-z0-9]{36}/g, R);
  t = t.replace(/gh[osur]_[A-Za-z0-9]{36}/g, R);
  t = t.replace(/(?:AKIA|ASIA)[0-9A-Z]{16}/g, R);
  t = t.replace(/aws_secret_access_key\s*[=:]\s*\S+/gi, `aws_secret_access_key=${R}`);
  t = t.replace(/xox[abprs]-[A-Za-z0-9-]+/g, R);
  t = t.replace(/hooks\.slack\.com\/services\/\S+/g, `hooks.slack.com/services/${R}`);
  t = t.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, R);              // JWT
  t = t.replace(/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, R);          // Telegram bot token
  t = t.replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, R);
  t = t.replace(/sk-[A-Za-z0-9]{20,}/g, R);
  t = t.replace(/ATATT[A-Za-z0-9_-]{20,}/g, R);                 // Jira API token
  t = t.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, `Bearer ${R}`);
  // `Authorization: <scheme> <credential>` — the scheme name is not the secret,
  // so step OVER a known one and redact what follows. A bare `Authorization: xyz`
  // (no scheme) still matches via the optional group.
  t = t.replace(/Authorization:\s*(?:(Bearer|Basic|Token|Digest|AWS4-HMAC-SHA256)\s+)?\S+/gi,
    (_m, scheme) => `Authorization: ${scheme ? `${scheme} ` : ""}${R}`);

  // Generic key=value — keep the KEY NAME (it tells the human what leaked) and
  // redact the value. Runs last so the specific patterns above win.
  t = t.replace(/(api[_-]?key|password|passwd|secret|token)(\s*[=:]\s*)(\S+)/gi,
    (_m, k, sep) => `${k}${sep}${R}`);

  // Emails: a page goes to a chat channel, so PII gets a placeholder, not [REDACTED].
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>");

  // Finally make it one readable line: drop ANSI + code fences/backticks, collapse
  // whitespace. (After redaction, so a fence can't hide a pattern boundary.)
  // eslint-disable-next-line no-control-regex
  t = t.replace(/\[[0-9;]*[A-Za-z]/g, "");
  t = t.replace(/```+/g, " ").replace(/`/g, "");
  return t.replace(/\s+/g, " ").trim();
}

/** One line per disposition: what the tree DID, in the imperative the human needs. */
const DEAD_SESSION_SUMMARY = {
  parked: (n) => `Parked on gate ${n.gateTicketId || "(unknown)"} — approve it to re-run`,
  synthesized_children: () => "Waiting on children; auto-resumes when they finish",
  synthesized_completion: () => "Completion record found; marked done",
  shadow: (n) => `Observe-only (shadow) — would have ${n.wouldSynthesize ? "synthesized" : "parked"}`,
};

/**
 * Render a dead-session page through the ONE exec shape. Legacy rows (the
 * pre-FR-3 evidence-free notification, and anything written while the flag is
 * off) carry no disposition/evidence — they fall back to their own details text
 * and still get the DEAD SESSION kicker, because the DECISION is the same.
 */
function deadSessionPing(wf, notif, legacyDetails) {
  const disposition = String(notif.disposition || "");
  const summary = DEAD_SESSION_SUMMARY[disposition]?.(notif) || legacyDetails;
  const lastText = redactText(notif.lastText || "");
  const children = Array.isArray(notif.children) ? notif.children : [];
  const artifacts = notif.artifacts || {};
  const tid = notif.ticketId || "";
  return execPing({
    kicker: "🚨 DEAD SESSION",
    subject: `${tid || wf.workflowId} · ${clipText(notif.ticketTitle || notif.title || wf.input?.title || "", 80)}`,
    summary,
    bullets: [
      `🤖 ${notif.agentId || "unknown agent"} (${notif.source || notif.reviewer || "unknown"})`,
      lastText ? `💬 Last said: "${clipText(lastText, 240)}"` : "💬 Last said: (nothing streamed)",
      `👶 Children: ${children.length ? children.join(", ") : "none"}`,
      `📦 Artifacts: ${artifacts.completionRecord ? "completion record ✓" : "no completion record"}${artifacts.prUrl ? ` · PR ${artifacts.prUrl}` : ""}`,
    ],
    meta: [
      tid
        ? (JIRA_SITE_URL
            ? `🎫 [${tid}](https://${JIRA_SITE_URL}/browse/${tid})`
            : `🎫 [${tid}](${HUB_API_URL}/workflow?id=${encodeURIComponent(wf.workflowId)})`)
        : "",
      disposition === "parked" ? "⏸ run parked until you resolve" : "",
    ],
    ask: disposition === "parked"
      ? "Approve the escalation gate to re-run the agent, then tap Resolved."
      : "Tap Resolved once handled — the watch scheduler skips this run while the escalation is open.",
  });
}

async function scanManagerEscalations() {
  const res = await fetch(`${HUB_API_URL}/api/workflow/list`);
  if (!res.ok) throw new Error(`workflow/list ${res.status}`);
  const { workflows = [] } = await res.json();

  const pending = [];
  for (const wf of workflows) {
    if (TERMINAL_PHASES.has(String(wf.phase || wf.status || "").toLowerCase())) continue;
    for (const n of wf.humanNotifications || []) {
      if (n.type === "manager_escalation" && !n.acknowledged && n.id) {
        pending.push({ wf, notif: n });
      }
    }
  }
  if (!pending.length) return;

  let chats = null;
  for (const { wf, notif } of pending) {
    const claimed = await claimKey(`${ESC_KEY_PREFIX}${notif.id}`);
    if (!claimed) continue;

    // Same claim-before-delivery contract as review gates: any throw before a
    // delivered ping must release the claim or this escalation stays silent.
    try {
      chats = chats || (await listChats()).filter((c) => ALLOWED_CHAT_IDS.includes(String(c)));
      if (!chats.length) {
        console.warn("[telegram-bug-intake] manager escalation but no allowlisted chats to notify");
        await releaseKey(`${ESC_KEY_PREFIX}${notif.id}`);
        continue;
      }

      const details = String(notif.details || notif.message || "").trim();
      const clipped = details.length > ESC_DETAIL_MAX ? `${details.slice(0, ESC_DETAIL_MAX)}…` : details;
      const text = DEAD_SESSION_REVIEWERS.has(String(notif.reviewer || ""))
        ? deadSessionPing(wf, notif, clipped)
        : execPing({
            kicker: "🚨 WORKFLOW MANAGER ESCALATION",
            subject: wf.input?.title || wf.workflowId,
            summary: clipped,
            meta: ["⏸ run parked until you resolve"],
            ask: "Tap Resolved once handled — the watch scheduler skips this run while the escalation is open.",
          });
      // The keyboard + claim keys are deliberately IDENTICAL for both shapes:
      // resolving is the same action whichever page you are looking at.
      const keyboard = { inline_keyboard: [
        [{ text: "✅ Resolved — resume watching", callback_data: `eok|${wf.workflowId}` }],
        [{ text: "📱 Open run in hub", url: `${HUB_API_URL}/workflow?id=${encodeURIComponent(wf.workflowId)}` }],
      ] };

      let delivered = 0;
      for (const chatId of chats) {
        try { await tgSend(chatId, text, { reply_markup: keyboard }); delivered++; }
        catch (err) { console.error(`[telegram-bug-intake] escalation ping to ${chatId}`, err.message); }
      }
      if (!delivered) await releaseKey(`${ESC_KEY_PREFIX}${notif.id}`);
    } catch (err) {
      await releaseKey(`${ESC_KEY_PREFIX}${notif.id}`).catch((relErr) =>
        console.error("[telegram-bug-intake] releaseKey after escalation failure", relErr.message));
      throw err;
    }
  }
}

async function handleEscalationCallback(cb, chatId, workflowId) {
  if (!ALLOWED_CHAT_IDS.includes(String(chatId))) {
    console.warn(`[telegram-bug-intake] unauthorized escalation callback from chat ${chatId} for ${workflowId}`);
    await tgAnswer(cb.id, "Not authorized to resolve escalations.");
    return;
  }
  const res = await fetch(`${HUB_API_URL}/api/workflow/${encodeURIComponent(workflowId)}/escalations`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    await tgAnswer(cb.id, `Resolve failed (${res.status}) — try again or use the hub.`);
    return;
  }
  const { resolved = [] } = await res.json().catch(() => ({}));
  await tgAnswer(cb.id, resolved.length ? "Resolved — run is back under watch." : "Already resolved.");
  await tgEdit(chatId, cb.message.message_id,
    `${cb.message.text}\n\n✅ Resolved via Telegram (${resolved.length} escalation${resolved.length === 1 ? "" : "s"}) — watching resumes.`);
}

/** Atomically claim an arbitrary dedupe key (30-day TTL). False = already claimed. */
async function claimKey(id) {
  try {
    await ddb.send(new PutItemCommand({
      TableName: PENDING_TABLE,
      Item: { id: { S: id }, ttl: { N: String(Math.floor(Date.now() / 1000) + 30 * 86400) } },
      ConditionExpression: "attribute_not_exists(id)",
    }));
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

async function releaseKey(id) {
  await ddb.send(new DeleteItemCommand({ TableName: PENDING_TABLE, Key: { id: { S: id } } }));
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
  const items = await scanAllPages({
    TableName: PENDING_TABLE,
    FilterExpression: "begins_with(id, :p)",
    ExpressionAttributeValues: { ":p": { S: CHAT_KEY_PREFIX } },
  });
  return items.map((i) => Number(i.chatId.N)).filter(Boolean);
}

// Scan returns at most 1MB per page; rows past the first page are invisible
// without following LastEvaluatedKey (a chat#/buf# row landing there would
// silently drop gate pings / buffered messages).
async function scanAllPages(input) {
  const items = [];
  let lastKey;
  do {
    const res = await ddb.send(new ScanCommand(
      lastKey ? { ...input, ExclusiveStartKey: lastKey } : input,
    ));
    items.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

// ─── CI/CD deploy approval bridge ────────────────────────────────────────────
// A hub-managed deploy pipeline pauses on a ManualApproval action — the
// irreversible production act. The account blocks public Lambda endpoints, so an
// SNS→HTTPS subscription is out; instead this poller reuses the review-gate
// pattern: it polls each pipeline's state for an approval action stuck "in
// progress", pings Telegram with Approve / Reject buttons, and maps the tap back
// to codepipeline:PutApprovalResult. The claim key (dep#<hash>) both dedupes the
// ping and carries the token the button callback needs (callback_data can't hold
// the full token).
//
// TARGETS (TEAM-4338): every repo in the CD registry that names a pipeline, in
// that repo's own region, PLUS the DEPLOY_PIPELINE_NAME fallback. Both
// ARTIFACT_BUCKET and DEPLOY_PIPELINE_NAME unset (OSS / no pipeline) makes this
// a total no-op — not one AWS call.

const DEPLOY_KEY_PREFIX = "dep#";

// ─── CD registry deploy targets ──────────────────────────────────────────────
// The same document the orchestrator and the Pipeline___* tools Lambda read
// (lambda/orchestrator/index.mjs loadCdRegistry), with the same TTL cache and
// the same failure directions. Registry write access equals deploy-trigger
// authority, which is exactly why this bridge — the only holder of
// PutApprovalResult — reads the SAME allow-list rather than its own list.

const CD_REGISTRY_KEY = "config/cd-registry.json";
const CD_REGISTRY_TTL_MS = 60_000;
// Sanity bound on the fan-out: each target costs a GetPipelineState per 60s
// scan, and a runaway registry must not eat the poll loop's budget.
const MAX_DEPLOY_TARGETS = 25;

let _registry = { version: 1, repos: [] };
let _registryLoadedAt = 0;

/**
 * The CD registry, cached for CD_REGISTRY_TTL_MS per warm container. Every
 * failure is non-fatal — a registry problem must never stop deploy pings:
 *   no ARTIFACT_BUCKET → the empty registry, with NO S3 command constructed.
 *   NoSuchKey / 404    → empty registry (nothing registered yet).
 *   MALFORMED body     → the LAST GOOD copy (TEAM-4377): the tolerant parser
 *                        would turn it into an EMPTY registry and un-watch every
 *                        registered gate for a whole TTL.
 *   any other error    → the LAST GOOD copy, so a transient S3 error cannot
 *                        silently stop watching a live pipeline mid-deploy.
 * Every path that ATTEMPTED a read opens the TTL window, failures included.
 */
async function loadDeployRegistry() {
  if (!ARTIFACT_BUCKET) return _registry;
  const now = Date.now();
  if (_registryLoadedAt && now - _registryLoadedAt < CD_REGISTRY_TTL_MS) return _registry;
  try {
    const res = await s3Client().send(
      new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: CD_REGISTRY_KEY }),
    );
    // JSON.parse HERE rather than letting parseCdRegistry do it (TEAM-4377,
    // mirroring lambda/agentcore-hub-pipeline-tools/index.mjs loadRegistry from
    // TEAM-4358). parseCdRegistry is tolerant BY DESIGN — a malformed document
    // becomes an EMPTY registry — and assigning that would DISCARD the last good
    // copy and cache "nothing registered" for the whole TTL: one truncated S3
    // read stops watching every registered pipeline's deploy gate. Parsing first
    // turns a malformed body into a SyntaxError the catch treats like any other
    // read failure. parseCdRegistry takes the already-parsed object
    // (cd-registry.mjs:52-56), so tolerant per-ENTRY handling is unchanged.
    const doc = JSON.parse(await res.Body.transformToString());
    _registry = parseCdRegistry(doc);
    if (!_registryLoadedAt) {
      console.log(`[telegram-bug-intake] CD registry: ${_registry.repos.length} repo(s) registered`);
    }
  } catch (err) {
    if (/NoSuchKey|NotFound|404/i.test(String(err?.name || err?.message))) {
      _registry = { version: 1, repos: [] };
    } else {
      console.warn(`[telegram-bug-intake] CD registry read failed: ${err.message} — keeping ${_registryLoadedAt ? "last good copy" : "empty registry"}`);
    }
  }
  // Stamped on EVERY path that attempted a read, failures included (TEAM-4377),
  // same as the orchestrator (lambda/orchestrator/index.mjs:259) and the tools
  // Lambda. Without it a persistent AccessDenied or network fault meant an S3
  // GetObject on every 60s scan for the life of the container.
  _registryLoadedAt = now;
  return _registry;
}

/**
 * Every pipeline whose deploy gate this bridge watches:
 * `[{ pipeline, region, repo }]` — one per registry entry that names a pipeline
 * (expanded by the shared pipelineProjects(), never by re-deriving names here),
 * then the DEPLOY_PIPELINE_NAME fallback unless the registry already named it.
 * Registry order is preserved so the output is deterministic.
 */
async function loadDeployTargets() {
  const registry = await loadDeployRegistry();
  const targets = [];
  const seen = new Set();
  for (const entry of registry?.repos || []) {
    const projects = pipelineProjects(entry);
    // No pipeline → a DEPLOY.md-mode CD repo: nothing here has a gate to watch.
    if (!projects || seen.has(projects.pipeline)) continue;
    seen.add(projects.pipeline);
    targets.push({
      pipeline: projects.pipeline,
      region: projects.region || DEFAULT_REGION,
      repo: entry.repo || null,
    });
  }
  if (DEPLOY_PIPELINE_NAME && !seen.has(DEPLOY_PIPELINE_NAME)) {
    targets.push({
      pipeline: DEPLOY_PIPELINE_NAME,
      region: DEFAULT_REGION,
      repo: `${GITHUB_USER}/agentcore-hub`,
    });
  }
  if (targets.length > MAX_DEPLOY_TARGETS) {
    console.warn(`[telegram-bug-intake] ${targets.length} deploy targets — watching the first ${MAX_DEPLOY_TARGETS}`);
    return targets.slice(0, MAX_DEPLOY_TARGETS);
  }
  return targets;
}

async function scanDeployApprovals() {
  const targets = await loadDeployTargets();
  if (!targets.length) return;
  // One target's problem is that target's problem: a torn-down pipeline, a
  // GitHub hiccup or a failed ping must not stop the OTHER repos' deploy gates
  // from being surfaced this scan.
  for (const target of targets) {
    try {
      await scanDeployApprovalsForTarget(target);
    } catch (err) {
      console.error(`[telegram-bug-intake] deploy approval scan ${target.pipeline}`, err);
    }
  }
}

async function scanDeployApprovalsForTarget(target) {
  let state;
  try {
    state = await codepipelineFor(target.region).send(
      new GetPipelineStateCommand({ name: target.pipeline }),
    );
  } catch (err) {
    // A missing pipeline (wrong account, torn down, registry typo) must not spam
    // the log every 60s — bail quietly. Any other error propagates to the
    // per-target catch, which logs it and moves on to the next target.
    if (err.name === "PipelineNotFoundException") return;
    throw err;
  }

  // Find the ManualApproval action currently awaiting a decision. CodePipeline
  // marks the *stage* InProgress and the action has a latestExecution.token
  // only while it waits; the token is required by PutApprovalResult.
  let pending = null;
  // The commit being deployed — the Source stage's currentRevision. Used to
  // enrich the ping with the actual commit / PR / scope (esbuild the SHA once).
  const sourceRevisionId = (state.stageStates || [])
    .flatMap((s) => s.actionStates || [])
    .map((a) => a.currentRevision?.revisionId)
    .find(Boolean);
  for (const stage of state.stageStates || []) {
    for (const action of stage.actionStates || []) {
      const token = action.latestExecution?.token;
      const status = action.latestExecution?.status;
      if (token && status === "InProgress") {
        pending = { stageName: stage.stageName, actionName: action.actionName, token,
          revisionUrl: action.entityUrl || action.revisionUrl,
          commitSha: sourceRevisionId || null };
        break;
      }
    }
    if (pending) break;
  }
  if (!pending) return;

  // Claim on the pipeline + token: a new pipeline execution mints a fresh token,
  // so this naturally re-pings each run while never double-pinging the same wait.
  const claimed = await claimDeployApproval(pending, target);
  if (!claimed) return;

  try {
    const chats = (await listChats()).filter((c) => ALLOWED_CHAT_IDS.includes(String(c)));
    if (!chats.length) {
      console.warn("[telegram-bug-intake] deploy approval but no allowlisted chats to notify");
      await releaseDeployApproval(claimed.key);
      return;
    }

    // Enrich the ping with what's actually shipping: the commit subject, the PR
    // (title + workflow/epic + one-line summary from the body), and the file
    // scope. Best-effort — a GitHub hiccup falls back to the terse message.
    const brief = await buildDeployBrief(pending.commitSha, target.repo).catch((e) => {
      console.warn("[telegram-bug-intake] deploy brief enrich failed:", e.message);
      return null;
    });

    const deployAsk =
      "This is the irreversible production deploy — the merge is already approved. " +
      "Approve to ship, or Reject to stop.";
    // Which pipeline, and which REPO's pipeline: with several registered repos a
    // bare pipeline name is not enough for a human to know what they are shipping.
    const meta = [`🏷 ${esc(target.pipeline)}`];
    if (target.repo) meta.push(`📦 ${esc(target.repo)}`);
    const text = brief
      ? execPing({
          kicker: "🚀 PRODUCTION DEPLOY — approval needed",
          subject: brief.prTitle || brief.commitSubject || target.pipeline,
          summary: brief.summary || "",                       // one-line what/why from the PR body
          bullets: [
            brief.workflowLine,                               // "Workflow: TEAM-3721 (bug-fix)"
            brief.scopeLine,                                  // "Scope: 8 files (+147/-4)"
            brief.commitLine && brief.commitLine.replace(/`/g, ""), // "Commit: a1b2c3d"
          ].filter(Boolean),
          meta,
          ask: deployAsk,
        })
      : execPing({
          kicker: "🚀 PRODUCTION DEPLOY — approval needed",
          subject: target.pipeline,
          summary: "The build passed every gate and is waiting on you to ship it to prod.",
          meta,
          ask: deployAsk,
        });

    const rows = [[
      { text: "🚀 Approve deploy", callback_data: `dok|${claimed.key}` },
      { text: "🛑 Reject", callback_data: `dno|${claimed.key}` },
    ]];
    const linkRow = [];
    if (brief?.prUrl) linkRow.push({ text: "🔗 View PR", url: brief.prUrl });
    if (pending.revisionUrl) linkRow.push({ text: "🔗 View commit", url: pending.revisionUrl });
    else if (brief?.commitUrl) linkRow.push({ text: "🔗 View commit", url: brief.commitUrl });
    if (linkRow.length) rows.push(linkRow);
    const keyboard = { inline_keyboard: rows };

    let delivered = 0;
    for (const chatId of chats) {
      try { await tgSend(chatId, text, { reply_markup: keyboard }); delivered++; }
      catch (err) { console.error(`[telegram-bug-intake] deploy approval ping to ${chatId}`, err.message); }
    }
    if (!delivered) await releaseDeployApproval(claimed.key);
  } catch (err) {
    await releaseDeployApproval(claimed.key).catch((relErr) =>
      console.error("[telegram-bug-intake] releaseDeployApproval after failure", relErr.message));
    throw err;
  }
}

// An agent-run PR body LEADS with process chatter — the ship-review round, a
// "Do NOT merge by hand" warning, CD-ticket instructions — before it ever says
// what the change does. Those lines are noise to a human approving the deploy.
// Skip them; pull the actual Summary section instead. (This is why the old
// "first non-heading line" grabbed "Status: SHIP REVIEW ROUND 3 …".)
const PROCESS_LINE =
  /^(status\b|do not\b|don't\b|note:|warning:|caution:|awaiting\b|cd ticket\b|ship review\b|merge approval\b|round\b|head\b|[-*] \[[ x]\]|🤖|co-authored|generated with|(closes?|fixes?|resolves?)\s+#\d)/i;
const SUMMARY_HEADING =
  /^\s*(?:#{1,4}\s*|\*\*)?(?:summary|what(?:'s| is| this does| changed)?|overview|why|problem|the change|tl;?dr)\b/i;

function isProseLine(l) {
  if (!l) return false;
  if (/^[#|>]|^<!--|^!\[/.test(l)) return false;          // heading / table / quote / comment / image
  if (PROCESS_LINE.test(l)) return false;                 // status / instruction boilerplate
  if (/^\[?[A-Z][A-Z0-9]+-\d+\]?[:.\s]*$/.test(l)) return false; // bare ticket ref
  if (/^https?:\/\/\S+$/.test(l)) return false;           // bare url
  return true;
}

// One-line "what this does" from a PR body: prose under a Summary/What/Overview
// heading if present, else the first prose line that isn't process boilerplate.
// Strips leading bullet/emphasis markers. null if the body is all boilerplate.
function extractPrSummary(body) {
  const lines = String(body || "").split("\n").map((l) => l.trim());
  const clean = (l) => l.replace(/^[*\-•\s>]+/, "").replace(/\*\*/g, "").trim().slice(0, 220);
  for (let i = 0; i < lines.length; i++) {
    if (!SUMMARY_HEADING.test(lines[i])) continue;
    const inline = lines[i].replace(SUMMARY_HEADING, "").replace(/^[:\s*#]+/, "").trim();
    if (inline && isProseLine(inline)) return clean(inline);
    for (let j = i + 1; j < lines.length && j < i + 8; j++) {
      if (!lines[j]) continue;
      if (/^#{1,4}\s/.test(lines[j])) break;              // hit next heading, no prose here
      if (isProseLine(lines[j])) return clean(lines[j]);
    }
  }
  const first = lines.find(isProseLine);
  return first ? clean(first) : null;
}

// PR/commit titles carry a trailing " (TEAM-1234)" workflow key we already show
// as its own bullet — and slicing raw at 140 chars kept cutting it mid-token
// ("… (TEAM-"). Drop the trailing key, then clip on a word boundary.
function cleanSubject(title) {
  let t = String(title || "").replace(/\s*\(([A-Z][A-Z0-9]+-\d+)\)\s*$/, "").trim();
  if (t.length > 140) t = t.slice(0, 140).replace(/\s+\S*$/, "").trimEnd() + "…";
  return t || null;
}

// A registry `repo` reaches the GitHub API as a URL PATH SEGMENT. normalizeRepoKey
// (cd-registry.mjs) only guarantees two non-empty "/"-separated segments, so
// "owner/repo?per_page=1", "owner/repo#x", "owner/re po" and "owner/.." all survive
// parsing — and each one changes the REQUEST rather than the repo it describes
// ("?" adds a query, "#" truncates, ".." walks the path up, all with GITHUB_TOKEN
// attached). Registry write access must not be a way to steer an authenticated
// GitHub call, so anything outside GitHub's own owner/name charset is refused here,
// at the point of use. NOTE: the regex alone allows ".." (a dot is a legal repo-name
// char) — dot-only segments are rejected separately because fetch NORMALISES them.
const SAFE_REPO_PATH = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;
const DOT_SEGMENT = /^\.+$/;
function isSafeRepoPath(repo) {
  if (!SAFE_REPO_PATH.test(String(repo || ""))) return false;
  return !String(repo).split("/").some((seg) => DOT_SEGMENT.test(seg));
}
// One warning per bad repo per warm container: the scan runs every 60s, and a
// registry typo must not turn into a log flood.
const _unsafeRepoWarned = new Set();

/**
 * Build a rich "what's shipping" brief for the deploy-approval ping from the
 * commit being deployed: the commit subject, its associated PR (title + body),
 * the workflow/epic key parsed from the PR body/title, a one-line summary, and
 * the file scope (count + additions/deletions). All best-effort against the
 * GitHub API with GITHUB_TOKEN; any failure returns partial/null and the caller
 * falls back to the terse message. Returns null if no commit SHA is known.
 *
 * `repo` is the TARGET's repo ("owner/name") — a registered repo's pipeline
 * deploys that repo, not the hub, so enriching from the hub would describe the
 * wrong commit entirely. Falls back to the hub only when the target has no repo.
 */
async function buildDeployBrief(commitSha, targetRepo = null) {
  if (!commitSha) return null;
  const repo = targetRepo || `${GITHUB_USER}/agentcore-hub`;
  if (!isSafeRepoPath(repo)) {
    if (!_unsafeRepoWarned.has(repo)) {
      _unsafeRepoWarned.add(repo);
      console.warn(`[telegram-bug-intake] deploy brief skipped: unsafe repo "${repo}" (not owner/name) — fix the CD registry entry`);
    }
    return null;                 // terse ping still goes out; the gate must reach a human
  }
  const gh = async (path) => {
    const r = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "agentcore-hub-telegram-intake",
      },
    });
    if (!r.ok) throw new Error(`GitHub ${path} ${r.status}`);
    return r.json();
  };

  const short = String(commitSha).slice(0, 7);
  const brief = {
    commitLine: `Commit: \`${short}\``,
    commitUrl: `https://github.com/${repo}/commit/${commitSha}`,
    commitSubject: null, prTitle: null, prUrl: null,
    workflowLine: null, summary: null, scopeLine: null,
  };

  // Commit → subject + file scope.
  try {
    const commit = await gh(`/commits/${commitSha}`);
    brief.commitSubject = cleanSubject((commit.commit?.message || "").split("\n")[0]);
    const stats = commit.stats || {};
    const files = Array.isArray(commit.files) ? commit.files.length : null;
    if (files != null) {
      brief.scopeLine = `Scope: ${files} file${files === 1 ? "" : "s"}` +
        (stats.additions != null ? ` (+${stats.additions}/-${stats.deletions})` : "");
    }
  } catch (e) { /* keep going — subject/scope optional */ }

  // Commit → its PR (title + body). The body carries the epic/workflow + summary.
  try {
    const prs = await gh(`/commits/${commitSha}/pulls`);
    const pr = Array.isArray(prs) && prs[0];
    if (pr) {
      brief.prTitle = cleanSubject(pr.title);
      brief.prUrl = pr.html_url || null;
      // Workflow/epic key: TEAM-#### from the PR title or body.
      const key = (pr.title + " " + (pr.body || "")).match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
      // Workflow type hint (bug-fix / SDLC / dead-code) from title prefix.
      const typeHint = /bug|fix\(/i.test(pr.title) ? "bug-fix"
        : /dead.?code|sweep/i.test(pr.title) ? "dead-code"
        : "SDLC";
      if (key) brief.workflowLine = `Workflow: ${key[1]} (${typeHint})`;
      // One-line "what this does" — the Summary section, not the ship-review
      // status line the body opens with.
      brief.summary = extractPrSummary(pr.body);
    }
  } catch (e) { /* PR optional — commit subject already covers the headline */ }

  return brief;
}

/**
 * Atomically claim a deploy approval for notification, keyed by the target
 * pipeline + the approval TOKEN (unique per pipeline wait). Returns { key, ... }
 * on first claim, false if already pinged. The DDB row stores the
 * pipeline/region/repo/stage/action/token the button callback needs, since
 * callback_data can't carry the token itself.
 */
async function claimDeployApproval(pending, target) {
  // A short, callback_data-safe key derived from the target + the approval TOKEN
  // (the token alone can exceed Telegram's 64-byte callback_data budget). The token
  // stays in the DDB item. Hashing the PIPELINE in means two targets can never
  // collide on one claim row, whatever their tokens look like.
  //
  // MIGRATION (TEAM-4347): before TEAM-4338 the key was hash(token) alone, and that
  // code watched exactly ONE pipeline — DEPLOY_PIPELINE_NAME. So legacy-shaped rows
  // can only ever exist for that pipeline; keeping the legacy shape for it means an
  // approval already paused on the gate when this zip lands still hashes to the row
  // that claimed it, instead of claiming a second row and pinging twice. Matching on
  // the pipeline NAME (not on "came from the env fallback") is deliberate: the hub is
  // normally in the registry too, so its target is a REGISTRY target that happens to
  // name DEPLOY_PIPELINE_NAME — the exact configuration the double-ping would hit.
  const key = DEPLOY_PIPELINE_NAME && target.pipeline === DEPLOY_PIPELINE_NAME
    ? `dp${hashToken(pending.token)}`
    : `dp${hashToken(`${target.pipeline} ${pending.token}`)}`;
  try {
    await ddb.send(new PutItemCommand({
      TableName: PENDING_TABLE,
      Item: {
        id: { S: `${DEPLOY_KEY_PREFIX}${key}` },
        pipelineName: { S: target.pipeline },
        // The region to send PutApprovalResult to. Claim rows written before
        // TEAM-4338 have no region; the callback falls back to DEFAULT_REGION.
        region: { S: target.region },
        ...(target.repo ? { repo: { S: target.repo } } : {}),
        stageName: { S: pending.stageName },
        actionName: { S: pending.actionName },
        token: { S: pending.token },
        ttl: { N: String(Math.floor(Date.now() / 1000) + 7 * 86400) },
      },
      ConditionExpression: "attribute_not_exists(id)",
    }));
    return { key, ...pending };
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

async function releaseDeployApproval(key) {
  await ddb.send(new DeleteItemCommand({
    TableName: PENDING_TABLE,
    Key: { id: { S: `${DEPLOY_KEY_PREFIX}${key}` } },
  }));
}

/** Small non-crypto hash → short stable key for a claim (pipeline + token). */
function hashToken(token) {
  let h = 5381;
  for (let i = 0; i < token.length; i++) h = ((h << 5) + h + token.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

async function handleDeployApprovalCallback(cb, chatId, action, key) {
  if (!ALLOWED_CHAT_IDS.includes(String(chatId))) {
    console.warn(`[telegram-bug-intake] unauthorized deploy approval callback from chat ${chatId}`);
    await tgAnswer(cb.id, "Not authorized to approve deploys.");
    return;
  }
  const item = await ddb.send(new GetItemCommand({
    TableName: PENDING_TABLE, Key: { id: { S: `${DEPLOY_KEY_PREFIX}${key}` } },
  }));
  if (!item.Item) {
    await tgAnswer(cb.id, "This approval expired or was already actioned.");
    await tgEdit(chatId, cb.message.message_id, `${cb.message.text}\n\n⏱️ Expired / already actioned.`);
    return;
  }
  const approve = action === "dok";
  // The pipeline's own region, from the claim row. A row written before
  // TEAM-4338 carries no region attribute — those approve via the default
  // region, which is where the only pipeline was.
  const cp = codepipelineFor(item.Item.region?.S || DEFAULT_REGION);
  try {
    await cp.send(new PutApprovalResultCommand({
      pipelineName: item.Item.pipelineName.S,
      stageName: item.Item.stageName.S,
      actionName: item.Item.actionName.S,
      token: item.Item.token.S,
      result: {
        status: approve ? "Approved" : "Rejected",
        summary: `${approve ? "Approved" : "Rejected"} via Telegram by chat ${chatId}`,
      },
    }));
  } catch (err) {
    // Token already consumed (approved elsewhere, or the wait timed out) →
    // ApprovalAlreadyCompletedException. Report it and clear the claim.
    await ddb.send(new DeleteItemCommand({
      TableName: PENDING_TABLE, Key: { id: { S: `${DEPLOY_KEY_PREFIX}${key}` } },
    })).catch(() => {});
    await tgAnswer(cb.id, "Could not record — it may already be actioned.");
    await tgEdit(chatId, cb.message.message_id,
      `${cb.message.text}\n\n⚠️ ${esc(err.name || "Error")}: ${esc(err.message || "")}`.slice(0, 4000));
    return;
  }
  // One-shot: the token is now spent. Drop the claim so the row can't linger.
  await ddb.send(new DeleteItemCommand({
    TableName: PENDING_TABLE, Key: { id: { S: `${DEPLOY_KEY_PREFIX}${key}` } },
  })).catch(() => {});
  await tgAnswer(cb.id, approve ? "Deploy approved" : "Deploy rejected");
  await tgEdit(chatId, cb.message.message_id,
    `${cb.message.text}\n\n${approve ? "🚀 Approved — deploying to prod." : "🛑 Rejected — deploy stopped."}`);
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
      // TEAM-3832: workflowDefId is the pipeline selector (workflowType is a
      // deprecated alias). Explicitly pin the default software-delivery def.
      workflowDefId: "software-delivery",
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

export async function transcribeVoice(fileId, durationSec, fileMeta = null) {
  // fileMeta is the caller's pre-flight getFile result (no-duration notes);
  // reuse it rather than asking Telegram twice. Fetched lazily otherwise.
  const meta = fileMeta?.file_path ? fileMeta : await tgCall("getFile", { file_id: fileId });
  const res = await fetch(`${TG_FILE}/${meta.file_path}`);
  if (!res.ok) throw new Error(`Telegram voice download ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  // Amazon Transcribe streaming is a REAL-TIME service: audio must arrive in
  // uniform ~50-200ms chunks at ~real-time pace, and the audio stream must be
  // terminated with an explicit empty AudioEvent. Blasting the whole file and
  // closing (the old behavior) trips the service's ~20s insufficient-audio
  // watchdog regardless of clip length (TEAM-3460).
  //   https://docs.aws.amazon.com/transcribe/latest/dg/streaming.html
  //   https://docs.aws.amazon.com/transcribe/latest/dg/streaming-setting-up.html (step 6)
  const CHUNK_MS = 200;
  const byteRate = durationSec > 0 ? bytes.length / durationSec : VOICE_FALLBACK_BYTE_RATE;
  const chunkBytes = Math.max(256, Math.min(16 * 1024, Math.ceil((byteRate * CHUNK_MS) / 1000)));

  async function* audioStream() {
    for (let i = 0; i < bytes.length; i += chunkBytes) {
      yield { AudioEvent: { AudioChunk: bytes.subarray(i, i + chunkBytes) } };
      if (i + chunkBytes < bytes.length) await sleep(CHUNK_MS);
    }
    yield { AudioEvent: { AudioChunk: new Uint8Array(0) } }; // end-of-audio signal
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
  const items = await scanAllPages({
    TableName: PENDING_TABLE,
    FilterExpression: "begins_with(id, :p)",
    ExpressionAttributeValues: { ":p": { S: BUFFER_KEY_PREFIX } },
  });
  for (const item of items) {
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
