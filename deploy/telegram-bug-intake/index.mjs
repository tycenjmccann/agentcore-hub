/**
 * Telegram Bug Intake Lambda (local/account-specific, not part of OSS core)
 *
 * Screenshot(s) + description sent to a Telegram bot → structured Jira Bug →
 * hub pipeline (bootstrapBugWorkflow). See docs/workflow/bug-intake-jira.md for the
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
import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand, DeleteItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { TranscribeStreamingClient, StartStreamTranscriptionCommand } from "@aws-sdk/client-transcribe-streaming";
import { CodePipelineClient, GetPipelineStateCommand, PutApprovalResultCommand, GetPipelineExecutionCommand } from "@aws-sdk/client-codepipeline";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
// PutObject is for ONE object shape only: the ship-approval REJECTION marker
// (SEC-1). The bridge writes no other S3 key, and its IAM grant says so.
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
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
// Don't START the periodic gate/escalation/deploy scans with less runway than
// this on top of POLL_RESERVE_MS (TEAM-4663). The three scans run serially and
// each does network work (hub fetches, GetPipelineState, GitHub, Telegram), so
// the old `> POLL_RESERVE_MS` loop guard could begin one with 30s left and die
// between a claim and its ping — which is exactly how a claim gets stranded.
const SCAN_BUDGET_MS = 90_000;
// How long a claim row's holder is trusted to still be sending. Past this, an
// UNDELIVERED claim (no deliveredAt) is re-takeable and the ping is re-sent —
// the one rule that makes "claimed" stop meaning "silently parked" on all three
// ping paths (deploy approvals, review gates, manager escalations).
const PING_LEASE_MS = parseInt(process.env.PING_LEASE_MS || "300000", 10);
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
// Cross-account deploy gates (TEAM-4338 Part A): a registered repo can own its
// pipeline in its OWN account. The registry entry then carries a
// hub-cd-trigger-<slug> roleArn + externalId; we assume that role (SDK v3 creds
// provider, cached until ~1min before expiry) to read state and to
// PutApprovalResult there. Same-account entries carry no roleArn, so the client
// keeps ambient creds unchanged. Mirrors the assumeRoleProvider in
// lambda/agentcore-hub-pipeline-tools (the ONE other place that assumes these).
let _sts = null;
function sts() {
  if (!_sts) _sts = new STSClient({ region: DEFAULT_REGION });
  return _sts;
}
function assumeRoleProvider(roleArn, externalId) {
  let cached = null;
  return async () => {
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.creds;
    const out = await sts().send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: "telegram-deploy-gate",
      ...(externalId ? { ExternalId: externalId } : {}),
      DurationSeconds: 900,
    }));
    const c = out.Credentials;
    cached = {
      creds: {
        accessKeyId: c.AccessKeyId,
        secretAccessKey: c.SecretAccessKey,
        sessionToken: c.SessionToken,
        expiration: c.Expiration,
      },
      expiresAt: c.Expiration ? new Date(c.Expiration).getTime() : Date.now() + 900_000,
    };
    return cached.creds;
  };
}

// CodePipeline is per-REGION and, for cross-account entries, per assumed-role,
// memoized so a warm container builds each client once. There is deliberately no
// module-level default instance: with nothing configured the deploy-approval
// path must construct no client at all.
const _cpByKey = new Map();
function codepipelineFor(region, roleArn = null, externalId = null) {
  const r = region || DEFAULT_REGION;
  // externalId is part of the identity so a rotated id forces a fresh client.
  const key = `${r}|${roleArn || ""}|${externalId || ""}`;
  let client = _cpByKey.get(key);
  if (!client) {
    const cfg = { region: r };
    if (roleArn) cfg.credentials = assumeRoleProvider(roleArn, externalId);
    client = new CodePipelineClient(cfg);
    _cpByKey.set(key, client);
  }
  return client;
}

// S3 is used for exactly two objects, both in the ONE artifact bucket in this
// Lambda's own region — so one lazy client, not one per region: the CD registry
// (read) and the ship-approval REJECTION marker (write, see writeShipRejection).
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
    // TEAM-4663: only START a scan round with real runway. lastGateScan is left
    // UN-stamped when the guard blocks, so the next loop iteration — or the next
    // invocation, on a fresh clock — scans as soon as there is budget rather
    // than waiting out another 60s window.
    if (Date.now() - lastGateScan > 60_000 &&
        context.getRemainingTimeInMillis() > POLL_RESERVE_MS + SCAN_BUDGET_MS) {
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
//
// `plain` renders the SAME lines with no Markdown at all, for sendApprovalPing's
// fallback send (TEAM-4663 F2): Telegram's legacy parse_mode rejects the WHOLE
// message on one unbalanced entity, so without it a brief that happens to
// contain one silences a prod gate (release → re-claim → identical 400, every
// 60s, forever). It is a post-pass over the composed text rather than a second
// template, so the two renderings cannot drift apart.
function execPing({
  kicker, subject, summary, shipping = [], shippingMore = 0,
  bullets = [], bulletsLabel = "What changed", meta = [], ask, plain = false,
}) {
  const lines = [`*${kicker}*`];
  if (subject) lines.push(esc(String(subject)));
  if (summary && String(summary).trim()) lines.push("", esc(String(summary).trim()));
  // WHAT is under review, one item per line (TEAM-4885). It used to be glued
  // onto the subject as "<run> — shipping: A, B, C +19 more", one unreadable
  // paragraph on a phone. The count of un-rendered items is its own line.
  const sh = (shipping || []).filter((x) => typeof x === "string" && x.trim());
  if (sh.length) {
    lines.push("", "*Shipping*");
    for (const x of sh) lines.push(`• ${esc(x.trim())}`);
    if (shippingMore > 0) lines.push(`• +${shippingMore} more`);
  }
  const bl = (bullets || []).filter((b) => typeof b === "string" && b.trim()).slice(0, 6);
  if (bl.length) {
    lines.push("", `*${esc(bulletsLabel)}*`);
    for (const b of bl) lines.push(`• ${esc(b.trim().slice(0, 200))}`);
  }
  const ml = (meta || []).filter(Boolean);
  if (ml.length) lines.push("", ml.join("  ·  "));
  if (ask) lines.push("", `_${esc(String(ask))}_`);
  const text = lines.join("\n");
  return plain ? stripMd(text) : text;
}

/**
 * Legacy-Markdown text → the same facts as plain text: flatten `[label](url)` to
 * "label url" (the 🎫 handle and the console link must survive as reachable
 * URLs), undo esc()'s backslashes, then drop the emphasis characters.
 */
function stripMd(s) {
  return String(s)
    .replace(/\[([^\]]*)\]\((\S+?)\)/g, "$1 $2")
    .replace(/\\([_*`[\]])/g, "$1")
    .replace(/[*_`]/g, "");
}

// ─── The ONE approval-ping content builder (TEAM-4660) ───────────────────────
// execPing above is the shared RENDERER; this is the shared CONTENT builder.
// Before it, every approval site picked its own inputs, and two of them
// (scanReviewGates, repageIfWindowOpened) accepted an agent-written gate ticket
// as content: the title became the kicker (via gateLabel's slice(0,24) fallback)
// and up to 400 chars of the description became the summary. A release-manager
// deploy-gate ticket therefore paged as
//   🚦 DEPLOY GATE: APPROVE APP REVIEW GATE — approval needed
// followed by a console runbook full of execution ids and SHAs, while the
// CodePipeline deploy ping — templated from buildDeployBrief — read cleanly.
//
// Rules encoded here, so no call site can re-litigate them:
//   * the kicker comes from APPROVAL_KICKERS keyed by an ENUM. A freeform
//     ticket title is never a kicker, in whole or in part.
//   * the body is a subject (the RUN's title) + what is shipping + at most one
//     curated summary line. A gate ticket's DESCRIPTION is not an input at all.
//   * a re-paged gate says so once: "Attempt N — previous issue: …".
//   * one hard length cap, enforced in one place.
export const APPROVAL_TEXT_MAX = 900; // gate/approval pings — phone-readable
const APPROVAL_SUBJECT_MAX = 120;
const APPROVAL_SHIP_MAX = 3;        // shipping items rendered
const APPROVAL_SHIP_ITEM_MAX = 60;
const APPROVAL_REASON_MAX = 120;
// Manager/dead-session pages carry orchestrator-authored evidence (details are
// already clipped at ESC_DETAIL_MAX = 700) and are not the bug this fixes, so
// they keep a wider budget rather than losing asserted body lines.
const ESCALATION_TEXT_MAX = 1600;

// gateKind → the EXACT kicker string. Two substrings are load-bearing for the
// reply-to-ping rework router (gateFromReply): "REVIEW GATE" and
// "SHIP-REVIEW ESCALATION". A reply to a ping carrying either, plus the 🎫
// handle, is filed as a rework note — which is why `manager` and `dead-session`
// deliberately contain NEITHER (a reply to those must not transition a gate).
const APPROVAL_KICKERS = {
  spec:              { kicker: "🚦 SPEC REVIEW GATE — approval needed",       max: APPROVAL_TEXT_MAX },
  plan:              { kicker: "🚦 PLAN REVIEW GATE — approval needed",       max: APPROVAL_TEXT_MAX },
  design:            { kicker: "🚦 DESIGN REVIEW GATE — approval needed",     max: APPROVAL_TEXT_MAX },
  code:              { kicker: "🚦 CODE REVIEW GATE — approval needed",       max: APPROVAL_TEXT_MAX },
  qa:                { kicker: "🚦 QA REVIEW GATE — approval needed",         max: APPROVAL_TEXT_MAX },
  ship:              { kicker: "🚦 SHIP REVIEW GATE — approval needed",       max: APPROVAL_TEXT_MAX },
  merge:             { kicker: "🚦 MERGE REVIEW GATE — approval needed",      max: APPROVAL_TEXT_MAX },
  deploy:            { kicker: "🚦 DEPLOY REVIEW GATE — approval needed",     max: APPROVAL_TEXT_MAX },
  review:            { kicker: "🚦 REVIEW GATE — approval needed",            max: APPROVAL_TEXT_MAX },
  // A ticket an agent hands to a human to DO (Handoff / Escalation titles): not
  // an approval, so the ping carries the ticket's own ask and no shipping list
  // (TEAM-4885). Deliberately contains neither reply-router phrase.
  handoff:           { kicker: "🙋 HANDOFF — a human has to do this",         max: APPROVAL_TEXT_MAX },
  escalation:        { kicker: "🚨 SHIP-REVIEW ESCALATION — decision needed", max: APPROVAL_TEXT_MAX },
  "deploy-pipeline": { kicker: "🚀 PRODUCTION DEPLOY — approval needed",      max: APPROVAL_TEXT_MAX },
  // The bounded re-ping (TEAM-4663 F3) is its own KIND, not the `repage`
  // modifier: `repage` renders "business-hours reminder", which a 2-hourly nag
  // on an already-open prod gate is not.
  "deploy-pipeline-reminder":
                     { kicker: "⏰ PRODUCTION DEPLOY — still waiting on your approval", max: APPROVAL_TEXT_MAX },
  manager:           { kicker: "🚨 WORKFLOW MANAGER ESCALATION",              max: ESCALATION_TEXT_MAX },
  "dead-session":    { kicker: "🚨 DEAD SESSION",                             max: ESCALATION_TEXT_MAX },
};

/** The business-hours reminder variant of a kicker (a modifier, not a kind). */
function repageKicker(kicker) {
  return /—/.test(kicker)
    ? kicker.replace(/\s*—\s*(?:(?:approval|decision|input) needed|a human has to do this)$/, " · business-hours reminder")
    : `${kicker} · business-hours reminder`;
}

const reLit = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Shape stamp for builder-emitted approval text: line 1 is `*<a kicker from the
 * table>*`. sendApprovalPing refuses anything else, so "this ping came from the
 * builder" is true by construction and the guardrail test can assert it.
 */
export const APPROVAL_KICKER_RE = new RegExp(
  `^\\*(?:${Object.values(APPROVAL_KICKERS).flatMap((k) => [k.kicker, repageKicker(k.kicker)]).map(reLit).join("|")})\\*`
);

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** The rendered shipping items (clipped) and how many were left out. */
function shippingBlock(shipping, n) {
  const items = shipping.slice(0, Math.max(0, n)).map((s) => clipText(s, APPROVAL_SHIP_ITEM_MAX));
  return { items, more: shipping.length - items.length };
}

/**
 * Compose an approval/gate ping. Structured inputs only.
 * @param {object} o
 * @param {string} o.gateKind      key of APPROVAL_KICKERS (an enum, not free text)
 * @param {boolean} [o.repage]     business-hours reminder variant
 * @param {string} o.subject       the RUN's title (never the gate ticket's title)
 * @param {string[]} [o.shipping]  what is under review (upstream titles / brief lines)
 * @param {string} [o.summary]     ONE curated line (review package / PR body) — never a description
 * @param {string[]} [o.bullets]   curated bullets only
 * @param {string} [o.bulletsLabel] heading over the bullets (default "What changed")
 * @param {number} [o.attempt]     review cycle, 1-based
 * @param {string} [o.previousIssue] why the last attempt came back
 * @param {string[]} [o.meta]      pre-built, pre-escaped meta (the 🎫 handle lives here)
 * @param {string} [o.ask]         the decision to make
 * @returns {string} MarkdownV1 text, kicker-stamped and length-capped
 */
function buildApprovalMessage({
  gateKind, repage = false, subject, shipping = [], summary,
  bullets = [], bulletsLabel, attempt = 1, previousIssue, meta = [], ask, plain = false,
}) {
  const entry = APPROVAL_KICKERS[gateKind] || APPROVAL_KICKERS.review;
  const kicker = repage ? repageKicker(entry.kicker) : entry.kicker;
  const subj = clipText(oneLine(subject), APPROVAL_SUBJECT_MAX);
  const ship = (shipping || []).filter((s) => typeof s === "string" && s.trim()).map(oneLine);
  const n = Math.floor(Number(attempt) || 1);
  // ONE line, no history: the reviewer needs "this came back before, for this",
  // not a changelog. Reason clamped to a single short line — and when no reason
  // was RECORDED the line states the count and nothing else (TEAM-4671 F1). It
  // used to assert "previous issue: changes requested on the previous attempt",
  // which is a claim about a human's verdict that the bridge cannot make up.
  const reason = clipText(oneLine(previousIssue), APPROVAL_REASON_MAX);
  const attemptLine = n >= 2
    ? (reason ? `Attempt ${n} — previous issue: ${reason}` : `Attempt ${n}`)
    : "";

  let bl = (bullets || []).filter((b) => typeof b === "string" && b.trim());
  let sum = oneLine(summary);
  let shipN = Math.min(ship.length, APPROVAL_SHIP_MAX);

  const render = () => {
    const { items, more } = shippingBlock(ship, shipN);
    return execPing({
      kicker,
      subject: subj,
      summary: [sum, attemptLine].filter(Boolean).join("\n"),
      shipping: items,
      shippingMore: more,
      bullets: bl,
      bulletsLabel,
      meta,
      ask,
      plain,
    });
  };

  // Over budget: shed the least decision-critical content first. The kicker,
  // the subject, the meta (🎫 handle → reply routing), the attempt line and the
  // ask are never truncated.
  const shrink = () => {
    if (bl.length) { bl = bl.slice(0, -1); return true; }
    if (sum) { sum = ""; return true; }
    if (shipN > 0) { shipN -= 1; return true; }
    return false;
  };
  let text = render();
  while (text.length > entry.max && shrink()) text = render();
  return text;
}

// Test seam (same convention as _resetBusinessWindowForTests): the guardrail
// test renders each kicker directly to prove the escalation kinds stay out of
// the reply-to-ping vocabulary and that the cap sheds the right content.
export const _buildApprovalMessageForTests = buildApprovalMessage;

/**
 * Build + deliver a gate/approval ping. The ONLY sender the approval scans are
 * allowed to use (asserted by __tests__/approval-builder-guardrail.test.mjs), so
 * no site can hand Telegram text it composed itself.
 *
 * Two sends per chat, one message (TEAM-4663 F2): the builder's Markdown, and on
 * a retryable rejection the SAME builder's plain rendering of the SAME inputs.
 * Deliberately not a second sender — a formatting problem must be able to
 * degrade a page, never to compose one.
 *
 * @returns {Promise<{delivered:number, text:string, messageIds:string[]}>}
 *   `delivered === 0` → the caller must release its claim, exactly as before.
 *   `messageIds` are `<chatId>:<messageId>` for the CONFIRMED sends only: the
 *   proof a human really has this page, and the handles a later edit needs.
 */
async function sendApprovalPing(chats, { keyboard, label = "approval", ...msgOpts }) {
  const text = buildApprovalMessage(msgOpts);
  if (!APPROVAL_KICKER_RE.test(text)) {
    throw new Error(`approval ping text is not builder-stamped (gateKind=${msgOpts.gateKind})`);
  }
  let plainText = null;   // built once, and only if Telegram ever rejects the Markdown
  let delivered = 0;
  const messageIds = [];
  const record = (chatId, res) => {
    delivered++;
    if (res?.message_id) messageIds.push(`${chatId}:${res.message_id}`);
  };
  for (const chatId of chats) {
    try {
      record(chatId, await tgSend(chatId, text, { reply_markup: keyboard }));
      continue;
    } catch (err) {
      if (hopelessTelegramError(err)) {
        console.error(`[telegram-bug-intake] ${label} ping to ${chatId} (not retryable)`, err.message);
        continue;
      }
      console.warn(`[telegram-bug-intake] ${label} ping to ${chatId} rejected the formatted message (${err.message}) — retrying as plain text`);
    }
    if (plainText === null) plainText = buildApprovalMessage({ ...msgOpts, plain: true });
    try {
      record(chatId, await tgSendPlain(chatId, plainText, { reply_markup: keyboard }));
    } catch (err) {
      console.error(`[telegram-bug-intake] ${label} ping to ${chatId} failed as plain text too`, err.message);
    }
  }
  return { delivered, text, messageIds };
}

// review-package phase → gateKind. Keys are matched as SUBSTRINGS of notif.gate,
// which is the review package's `gate` — an agents.json `phase`
// (lambda/orchestrator/index.mjs loadReviewPackage), else "plan"/"intake" from
// fallbackReviewPackagePhase (lambda/orchestrator/artifact-chain.mjs). So these
// must be the phase strings that actually ship: QA's phase is "verification",
// never "qa" (the dead "qa" key is why a QA gate paged as a generic REVIEW GATE
// — TEAM-4673), and "plan" is reachable only via fallbackReviewPackagePhase.
// Unlisted phases fall through to the gate title's prefix, then to "review".
const GATE_PHASE_KINDS = [
  ["requirement", "spec"], ["spec", "spec"], ["plan", "plan"],
  ["design", "design"], ["dev", "code"], ["verification", "qa"], ["ship", "ship"],
];
// Gate-ticket title PREFIX (before the first ":") → gateKind. A CLOSED table:
// the old fallback sliced 24 chars off whatever the agent wrote, so ids, SHAs
// and "(3×)" landed in the kicker. Anything not listed here is just "review".
const GATE_TITLE_KINDS = new Map([
  ["deploy gate", "deploy"], ["deploy approval", "deploy"], ["deploy", "deploy"],
  ["merge approval", "merge"], ["merge", "merge"],
  ["handoff", "handoff"], ["escalation", "handoff"], ["ci unavailable", "handoff"], ["review", "review"],
  ["spec approval", "spec"], ["spec", "spec"],
  ["plan approval", "plan"], ["plan", "plan"],
  ["design approval", "design"], ["design", "design"],
  ["code review", "code"], ["dev", "code"],
  ["qa approval", "qa"], ["qa", "qa"], ["qa verification", "qa"],
  ["ship approval", "ship"], ["ship", "ship"],
]);
// Never let an identifier-bearing prefix through, even if it matched the table.
const UNSAFE_KICKER_RE = /\d{4}|\b[0-9a-f]{7,}\b|arn:/i;

/**
 * Which kicker does this gate get? The review-package phase wins; otherwise the
 * ticket title's prefix is looked up in the closed table above; otherwise the
 * generic review kicker. No path returns a substring of a freeform title.
 */
function gateKindOf(gate, title) {
  const g = String(gate || "").toLowerCase();
  for (const [k, v] of GATE_PHASE_KINDS) if (g.includes(k)) return v;
  // "Handoff (QA probe TEAM-4876): …" — the parenthetical is the agent's
  // context, not the kind; strip it before the table lookup (TEAM-4885).
  const prefix = oneLine(String(title || "").split(":")[0]).replace(/\s*\(.*$/, "").trim().toLowerCase();
  if (prefix && prefix.length <= 32 && !UNSAFE_KICKER_RE.test(prefix)) {
    const hit = GATE_TITLE_KINDS.get(prefix);
    if (hit) return hit;
  }
  return "review";
}

// ─── gate:deploy-approval — ONE artefact per deploy decision (TEAM-4706) ─────
// A production deploy used to produce TWO Telegram messages: the pipeline's own
// 🚀 page (which really does call PutApprovalResult) and a release-manager
// "Deploy gate" ticket whose ✅ only moved Jira while CodePipeline stayed
// parked. On 2026-09-14 a human tapped the inert one and a release stalled 29h.
//
// So a gate ticket LABELLED `gate:deploy-approval` becomes the one artefact: it
// pages with the 🚀 kicker and the same brief, and its ✅ releases the pipeline
// BEFORE the ticket moves. The LABEL decides — never the agent-written title,
// which is why GATE_TITLE_KINDS is left alone.
//
// Labels arrive in two shapes and must classify identically: agents write the
// canonical colon form, and the ticket Lambdas' sanitizeUserLabels rewrites
// [^a-z0-9._-] → "-", so the SAME gate can be stored as
// `gate-deploy-approval` / `pipeline-<name>` / `exec-<uuid>`.
const DEPLOY_APPROVAL_LABEL_RE = /^gate[:-]deploy-approval$/;
const DEPLOY_PIPELINE_LABEL_RE = /^pipeline[:-](.+)$/;
const DEPLOY_EXEC_LABEL_RE = /^exec[:-]([0-9a-f-]{36})$/;
// TEAM-4751 C2: the two labels the awaiting-console consumer's dedupe key needs.
// `head:` is written by the twins' gateHeadOf as a 40-hex sha
// (lambda/agentcore-hub-{tickets,jira}/gate-contract.mjs HEAD_LABEL_RE); read it
// tolerantly, because the key only needs the value to be STABLE and a short sha
// costs nothing to accept. `gate:<kind>` is the closed vocabulary in
// fix-contract.mjs GATE_KINDS.
// WP2's refusal stamp. A probed gate whose `→ done` was refused because its
// condition is not verified stays in `in_review`, gains `gate:awaiting-console`,
// and gets ONE comment carrying the check's finding (and, for a deploy approval,
// the console deep link). The bridge reads the label so its page says what the
// human must actually do.
const AWAITING_CONSOLE_LABEL_RE = /^gate[:-]awaiting-console$/;
const GATE_HEAD_LABEL_RE = /^head[:-]([0-9a-f]{7,40})$/;
const GATE_KIND_LABEL_RE = /^gate[:-]([a-z0-9-]+)$/;
// The guard's own bookkeeping labels — never a ticket's KIND.
const GATE_BOOKKEEPING_KINDS = new Set(["awaiting-console", "loop-broken"]);
// The kinds whose close asserts something a read can contradict, in the twins'
// own precedence order (gate-contract.mjs PROBED_GATE_KINDS): the kind that
// earned the refusal is the one that belongs in the dedupe key.
const PROBED_GATE_KIND_ORDER = ["deploy-approval", "ci-unavailable", "blocker"];

/**
 * Classify a gate ticket's labels. Pure — the one place either label shape is
 * read, so the colon and hyphen forms can never diverge.
 * @param {string[]|string} labels ticket labels (an array on the wire; a
 *   comma-joined string is tolerated the way normalizeBlockedBy tolerates one)
 * @returns {{isDeployApproval: boolean, pipeline: string|null, executionId: string|null,
 *   awaitingConsole: boolean, headSha: string|null, gateKind: string}}
 */
function parseDeployApprovalLabels(labels) {
  const list = Array.isArray(labels)
    ? labels
    : typeof labels === "string" ? labels.split(",") : [];
  const out = {
    isDeployApproval: false, pipeline: null, executionId: null,
    awaitingConsole: false, headSha: null, gateKind: "gate",
  };
  const kinds = [];
  for (const raw of list) {
    const l = String(raw ?? "").trim().toLowerCase();
    if (!l) continue;
    if (DEPLOY_APPROVAL_LABEL_RE.test(l)) { out.isDeployApproval = true; }
    if (AWAITING_CONSOLE_LABEL_RE.test(l)) { out.awaitingConsole = true; continue; }
    const g = GATE_KIND_LABEL_RE.exec(l);
    if (g) { if (!GATE_BOOKKEEPING_KINDS.has(g[1])) kinds.push(g[1]); continue; }
    const p = DEPLOY_PIPELINE_LABEL_RE.exec(l);
    if (p) { out.pipeline = out.pipeline || p[1]; continue; }
    const e = DEPLOY_EXEC_LABEL_RE.exec(l);
    if (e) { out.executionId = out.executionId || e[1]; continue; }
    const h = GATE_HEAD_LABEL_RE.exec(l);
    if (h) out.headSha = out.headSha || h[1];
  }
  out.gateKind = PROBED_GATE_KIND_ORDER.find((k) => kinds.includes(k)) || kinds[0] || "gate";
  return out;
}

/**
 * The kicker enum for a gate ping, in ONE place so the request-time page
 * (scanReviewGates) and the business-hours reminder (repageIfWindowOpened) can
 * never disagree about what a gate IS: the deploy-approval label wins, then the
 * escalation title, then the phase/title table (gateKindOf, unchanged).
 * @param {string|undefined} gate      notif.gate (the review-package phase)
 * @param {string} title               the gate ticket's title
 * @param {object|null|undefined} gateTicket  the gate ticket, for its labels
 * @returns {string} a key of APPROVAL_KICKERS
 */
function gateKindFor(gate, title, gateTicket) {
  if (parseDeployApprovalLabels(gateTicket?.labels).isDeployApproval) return "deploy-pipeline";
  if (ESCALATION_GATE_TITLE.test(String(title || ""))) return "escalation";
  return gateKindOf(gate, title);
}

const HANDOFF_SUBJECT_MAX = 200;
const HANDOFF_SUMMARY_MAX = 240;
/**
 * Copy for a `handoff` ping (TEAM-4885). A Handoff/Escalation ticket is a task
 * an agent hands to a human, so — unlike an approval gate, whose copy is the
 * closing agent's curated review package — the ticket's own title IS the ask
 * and its first sentence IS the context. Nothing else is rendered: no shipping
 * list (the run's ticket titles are not what the human is being asked to do),
 * no runbook body. The run title moves to a Context bullet.
 */
function handoffCopy(gateTicket, wf) {
  const rawTitle = oneLine(gateTicket?.title || "");
  // Drop the "Handoff (…):" / "Escalation:" classifier prefix — the kicker says it.
  const ask = rawTitle.replace(/^[^:]{0,80}:\s*/, "") || rawTitle;
  const firstSentence = oneLine(
    String(gateTicket?.description || "").split(/\n+/).map((l) => l.trim()).find(Boolean) || ""
  ).split(/(?<=[.!?])\s+/)[0] || "";
  const runTitle = oneLine(wf?.input?.title || wf?.workflowId || "");
  return {
    subject: clipText(ask, HANDOFF_SUBJECT_MAX),
    summary: clipText(firstSentence, HANDOFF_SUMMARY_MAX),
    bullets: runTitle ? [`Run: ${clipText(runTitle, 120)}`] : [],
    bulletsLabel: "Context",
  };
}

/**
 * Is this gate stamped as refused by the typed-gate guard? Pure — a delegate, so
 * label reading stays in exactly ONE place (parseDeployApprovalLabels).
 */
function gateAwaitingConsole(gateTicket) {
  return parseDeployApprovalLabels(gateTicket?.labels).awaitingConsole;
}

/**
 * The pipeline's console view — where the human deploy gate is answered.
 *
 * A deliberate, byte-identical MIRROR of consoleApprovalUrl() in
 * lambda/agentcore-hub-{tickets,jira}/gate-contract.mjs, asserted by
 * __tests__/console-url-parity.test.mjs. It is copied rather than imported
 * because check-fix-kinds-parity.sh §1b pins gate-contract.mjs at exactly TWO
 * copies (tickets canonical, jira mirror) — a third would fail CI — and the
 * bridge is not a ticket Lambda.
 */
function pipelineConsoleUrl({ pipeline, region } = {}, _waitingOn = {}) {
  const name = String(pipeline || "").trim();
  if (!name) return "";
  const r = String(region || process.env.AWS_REGION || "us-east-1").trim();
  return (
    "https://console.aws.amazon.com/codesuite/codepipeline/pipelines/" +
    `${encodeURIComponent(name)}/view?region=${encodeURIComponent(r)}`
  );
}

/**
 * The watched deploy target whose pipeline the `pipeline:` label names, from the
 * SAME allow-list the pipeline poller uses (loadDeployTargets → the CD
 * registry). A label naming an unregistered pipeline resolves to nothing: the
 * registry is the allow-list, and a ticket label is not a way around it.
 */
async function deployTargetNamed(pipeline) {
  if (!pipeline) return null;
  const want = String(pipeline).toLowerCase();
  const targets = await loadDeployTargets();
  return targets.find((t) => String(t.pipeline).toLowerCase() === want) || null;
}

/**
 * Is this gate ticket THE deploy decision, and against which target? null for
 * every other gate — so an unlabelled gate reaches not one CodePipeline call.
 * Never throws: a registry read problem must not cost the gate its ping/tap.
 */
async function deployApprovalGate(gateTicket) {
  const labels = parseDeployApprovalLabels(gateTicket?.labels);
  if (!labels.isDeployApproval) return null;
  let target = null;
  try {
    target = await deployTargetNamed(labels.pipeline);
    if (!target) {
      console.warn(`[telegram-bug-intake] deploy-approval gate names pipeline "${labels.pipeline || "(none)"}" which no CD-registry entry watches`);
    }
  } catch (err) {
    console.warn(`[telegram-bug-intake] deploy target lookup for "${labels.pipeline}": ${err.message}`);
  }
  return { ...labels, target };
}

/** Every ManualApproval action currently holding a wait on this pipeline. */
function pendingApprovals(state) {
  const out = [];
  for (const stage of state?.stageStates || []) {
    for (const action of stage.actionStates || []) {
      const ex = action.latestExecution || {};
      if (ex.token && ex.status === "InProgress") {
        out.push({
          stageName: stage.stageName,
          actionName: action.actionName,
          token: ex.token,
          executionId: ex.pipelineExecutionId || null,
        });
      }
    }
  }
  return out;
}

/**
 * The commit this execution is deploying (TEAM-4663 D3): the revision recorded
 * against a stage of the SAME execution, else the execution's own artifact
 * revision. Best-effort — the brief is enrichment, never a gate blocker, and a
 * revision from a DIFFERENT execution would describe the wrong commit to a
 * human about to irreversibly ship.
 *
 * The match is scoped by STAGE first: `StageState.latestExecution` is the one
 * place the API states which execution a stage's revision belongs to
 * (`ActionState.latestExecution` is an ActionExecution, which has no execution
 * id at all). The action-level comparison is kept behind it because the rest of
 * this module reads an action-level `pipelineExecutionId` too (pendingApprovals),
 * so where one is present it is the same evidence. Without an executionId there
 * is nothing to scope to, and the first revision in the state is the best (and
 * historical) answer.
 */
// One warn per pipeline+execution whose commit could not be resolved — this runs
// every 60s while a gate waits, and the ping still goes out without the brief.
const _revisionWarned = new Set();

async function executionRevision(cp, state, pipeline, executionId) {
  const actions = (state?.stageStates || []).flatMap((s) => s.actionStates || []);
  if (!executionId) return actions.map((a) => a.currentRevision?.revisionId).find(Boolean) || null;
  for (const stage of state?.stageStates || []) {
    if (stage.latestExecution?.pipelineExecutionId !== executionId) continue;
    const rev = (stage.actionStates || []).map((a) => a.currentRevision?.revisionId).find(Boolean);
    if (rev) return rev;
  }
  const sameExec = actions.find((a) =>
    a.currentRevision?.revisionId && a.latestExecution?.pipelineExecutionId === executionId);
  if (sameExec) return sameExec.currentRevision.revisionId;
  try {
    const out = await cp.send(new GetPipelineExecutionCommand({
      pipelineName: pipeline, pipelineExecutionId: executionId,
    }));
    return (out?.pipelineExecution?.artifactRevisions || [])
      .map((r) => r.revisionId).find(Boolean) || null;
  } catch (err) {
    const seen = `${pipeline}#${executionId}`;
    if (!_revisionWarned.has(seen)) {
      _revisionWarned.add(seen);
      console.warn(`[telegram-bug-intake] could not resolve the commit for ${pipeline} execution ${executionId}: ${err.message} — pinging without the brief`);
    }
    return null;
  }
}

/**
 * The same "what's shipping" brief the pipeline's own 🚀 page carries, for a
 * deploy-approval gate ticket. Best-effort per field and never throws: a
 * CodePipeline or GitHub hiccup must still page the human, just with today's
 * plain gate content under the 🚀 kicker.
 */
async function deployApprovalBrief(deploy) {
  if (!deploy?.target) return null;
  try {
    const cp = codepipelineFor(deploy.target.region, deploy.target.roleArn, deploy.target.externalId);
    const state = await cp.send(new GetPipelineStateCommand({ name: deploy.target.pipeline }));
    const sha = await executionRevision(cp, state, deploy.target.pipeline, deploy.executionId);
    return await buildDeployBrief(sha, deploy.target.repo);
  } catch (err) {
    console.warn(`[telegram-bug-intake] deploy-approval gate brief failed: ${err.message}`);
    return null;
  }
}

// The ask on a deploy-approval gate: the buttons are the review-gate pair, but
// the decision is the irreversible production act.
const DEPLOY_GATE_ASK =
  "This releases the pipeline's production deploy gate — the merge is already approved. " +
  "Approve to ship, or Request changes to stop it.";
const DEPLOY_GATE_TERSE =
  "The build passed every gate and is waiting on you to ship it to prod.";

// ─── The local decision ledger (SEC-9) ───────────────────────────────────────
// ONE writer (recordGateApproved) and ONE reader (wasGateApprovedLocally) over
// two key shapes, both rows in PENDING_TABLE:
//
//   approved#<ticketId>                the decision on a gate TICKET — the
//                                      gok/gno taps, which always have one
//   resolved#<pipeline>#<executionId>  the tokenless dok/dno page, which has no
//                                      ticket at all: only the claim row's
//                                      pipeline and the execution it waits on
//
// The row is written BEFORE the approval call, never after. The failure it
// closes is the one where CodePipeline TOOK the decision and this Lambda then
// died — the tap is retried, the pipeline has already moved on, and the second
// attempt cannot tell "already answered by me" from "answered by someone else"
// or from a real error. A row with no matching pipeline change is harmless (the
// gate is simply still open and the next tap decides it); a pipeline change with
// no row is the 29h stall.
//
// TTL is DEPLOY_CLAIM_TTL_SEC — the same window as the claim row it shadows, so
// the memo can never outlive the thing it remembers.
const GATE_APPROVED_PREFIX = "approved#";
const GATE_RESOLVED_PREFIX = "resolved#";

/**
 * The ledger id for a decision. Accepts #607's bare ticket id, or a
 * `{pipeline, executionId}` ref for the tokenless path.
 * @returns {string|null} null when neither shape is identifiable — the caller
 *   then simply keeps no memo, which is the pre-ledger behaviour.
 */
function gateLedgerKey(ref) {
  if (typeof ref === "string") return ref.trim() ? `${GATE_APPROVED_PREFIX}${ref.trim()}` : null;
  if (ref?.ticketId) return `${GATE_APPROVED_PREFIX}${String(ref.ticketId).trim()}`;
  const pipeline = String(ref?.pipeline || "").trim();
  const executionId = String(ref?.executionId || "").trim();
  return pipeline && executionId ? `${GATE_RESOLVED_PREFIX}${pipeline}#${executionId}` : null;
}

/** Record that THIS bridge is about to answer a gate. Best-effort, never throws. */
async function recordGateApproved(ref, { approve = true, chatId = "" } = {}) {
  const id = gateLedgerKey(ref);
  if (!id) return false;
  try {
    await ddb.send(new PutItemCommand({
      TableName: PENDING_TABLE,
      Item: {
        id: { S: id },
        decision: { S: approve ? "Approved" : "Rejected" },
        decidedAt: { N: String(Date.now()) },
        ...(chatId ? { chatId: { S: String(chatId) } } : {}),
        ttl: { N: String(Math.floor(Date.now() / 1000) + DEPLOY_CLAIM_TTL_SEC) },
      },
    }));
    return true;
  } catch (err) {
    console.warn(`[telegram-bug-intake] gate ledger write ${id}: ${err.message}`);
    return false;
  }
}

/**
 * WHICH decision this bridge recorded for that gate, or null if it recorded
 * none. The row has always carried `decision` (above); TEAM-4781 SR2 is what
 * first needed to read it, because "we already answered this gate" and "we
 * already answered it the SAME way" are different facts and only the second one
 * licenses re-running the ❌ half.
 *
 * Best-effort: an unreadable ledger returns null, i.e. "we know nothing", which
 * is what keeps every caller on its pre-ledger behaviour.
 *
 * @returns {Promise<"Approved"|"Rejected"|null>} the raw recorded decision. A
 *   row written by an older build with no `decision` attribute reads as null -
 *   unknown, not "Rejected" - so a pre-existing row never gains a meaning it
 *   was not written with.
 */
async function gateDecisionRecorded(ref) {
  const id = gateLedgerKey(ref);
  if (!id) return null;
  try {
    const { Item } = await ddb.send(new GetItemCommand({
      TableName: PENDING_TABLE, Key: { id: { S: id } },
    }));
    const decision = String(Item?.decision?.S || "");
    return decision === "Approved" || decision === "Rejected" ? decision : null;
  } catch (err) {
    console.warn(`[telegram-bug-intake] gate ledger read ${id}: ${err.message}`);
    return null;
  }
}

/**
 * Did this bridge already answer that gate? Used to tell an ALREADY-RESOLVED
 * gate from a broken one, so a retried tap finishes the ticket half instead of
 * reporting a failure. Best-effort: an unreadable ledger returns false, i.e.
 * exactly today's behaviour.
 */
async function wasGateApprovedLocally(ref) {
  return Boolean(await gateDecisionRecorded(ref));
}

// A superseded build has to be cleared off the gate before this execution can
// reach it; CodePipeline needs a moment to move. 3 tries at ~10s ≈ 30s.
const DEPLOY_GATE_RETRY_TRIES = 3;
let _deployGateRetryMs = 10_000;
/** Test seam (same convention as _resetBusinessWindowForTests): shorten the wait. */
export function _setDeployGateRetryMsForTests(ms) {
  _deployGateRetryMs = Number.isFinite(ms) && ms >= 0 ? ms : 10_000;
}

// The outcome of the approval WRITE — not of the human's decision (that is
// `approve`). The caller transitions the ticket on `decided` and on
// `alreadyResolved`, and on `failed` leaves the ticket completely untouched.
const DEPLOY_GATE_DECIDED = "decided";
const DEPLOY_GATE_ALREADY = "alreadyResolved";
const DEPLOY_GATE_FAILED = "failed";
// The pipeline says the wait is over: someone else answered it, the wait timed
// out, or this is a retry of the very tap that answered it.
const APPROVAL_ALREADY_RE = /ApprovalAlreadyCompleted|already been (?:completed|approved)|not currently in a pending/i;

/**
 * Record the human's decision on the PIPELINE for a gate:deploy-approval
 * ticket. Tri-state (SEC-8), about the WRITE:
 *
 *   "decided"          CodePipeline took the decision on this call
 *   "alreadyResolved"  the gate was already answered — by someone else, or by a
 *                      retry of this same tap (the ledger proves the latter).
 *                      The pipeline is where the human wants it, so the TICKET
 *                      half must still run; refusing here is what leaves a
 *                      resolved gate parked in `in_review` forever.
 *   "failed"           anything else. Nothing was recorded; the ticket is left
 *                      exactly as it was and the tap stays retryable.
 *
 * Approval TOKENS never leave this function: they are scrubbed out of anything
 * user-visible, and only their presence is ever reported.
 *
 * TEAM-4781: on a ❌ the SEC-1 rejection marker is part of the WRITE. A rejection
 * recorded on the pipeline but not in S3 still lets a later run of the same commit
 * skip this gate, so a marker that will not land downgrades the outcome to
 * "failed" — the ticket stays open and a re-tap retries the marker.
 */
async function decideDeployGate(cb, chatId, ticketId, deploy, approve, workflowId) {
  const secrets = new Set();
  const scrub = (s) => {
    let t = String(s ?? "");
    for (const v of secrets) if (v) t = t.split(v).join("[REDACTED]");
    return t;
  };
  try {
    if (!deploy.target) {
      throw new Error(`pipeline "${deploy.pipeline || "(unlabelled)"}" is not watched by any CD-registry entry`);
    }
    const name = deploy.target.pipeline;
    const cp = codepipelineFor(deploy.target.region, deploy.target.roleArn, deploy.target.externalId);
    // `state` is kept, not discarded: the rejection marker (SEC-1) needs the
    // commit THIS execution would have shipped, and that read is a pure function
    // of the state we already fetched.
    const readGate = async () => {
      const state = await cp.send(new GetPipelineStateCommand({ name }));
      const waits = pendingApprovals(state);
      for (const w of waits) secrets.add(w.token);
      const mine = deploy.executionId
        ? waits.find((w) => w.executionId === deploy.executionId) || null
        : waits[0] || null;
      return { mine, holder: mine ? null : waits[0] || null, state };
    };

    let { mine, holder, state } = await readGate();
    // A DIFFERENT execution is parked at the gate — an older build the human is
    // not looking at. Reject THAT one, then wait for this execution to arrive.
    if (!mine && holder && deploy.executionId) {
      await tgAnswer(cb.id,
        `An older build (${holder.executionId || "unknown"}) holds the gate; rejecting it first.`).catch(() => {});
      await cp.send(new PutApprovalResultCommand({
        pipelineName: name, stageName: holder.stageName, actionName: holder.actionName,
        token: holder.token,
        result: { status: "Rejected", summary: `Superseded by ${deploy.executionId}` },
      }));
      for (let i = 0; i < DEPLOY_GATE_RETRY_TRIES && !mine; i++) {
        await sleep(_deployGateRetryMs);
        ({ mine, state } = await readGate());
      }
    }
    if (!mine) {
      // Nothing is waiting. If the ledger says this bridge already answered THIS
      // gate, the wait is gone because we closed it — a retried tap, whose only
      // remaining work is the ticket half.
      const recorded = await gateDecisionRecorded({ ticketId });
      if (recorded) {
        // TEAM-4781 SR2: a ❌ arriving after OUR OWN ✅ is not a retry of this tap,
        // it is the opposite decision on a gate that is already approved. The
        // window is real: a ✅ that lands on the pipeline and then fails its ticket
        // transition (answerDeployGateTicketStuck) leaves the gate `in_review`
        // with an "Approved" row, so the caller's isTicketDone guard does not
        // catch it. Writing a rejection marker there would only add a human gate
        // (fail-toward-gate, harmless), but parking a rework note and telling the
        // human "changes requested" for a deploy they APPROVED is a lie in the
        // one direction that costs a re-run. Record nothing and run no half.
        if (!approve && recorded === "Approved") {
          console.warn(`[telegram-bug-intake] deploy gate ${ticketId}: ❌ tap after our own recorded ✅ on ${name} - no rejection marker, no rework`);
          // No tgEdit, matching the caller's own already-approved branch: that
          // edit text carries "Changes requested", which is gateFromReply's
          // routing vocabulary and would mis-route the human's next message.
          await tgAnswer(cb.id, "Already approved on the pipeline — nothing to reject.").catch(() => {});
          // The only outcome the caller treats as "run no ticket half".
          return DEPLOY_GATE_FAILED;
        }
        await tgAnswer(cb.id, "Already recorded on the pipeline — finishing the ticket.").catch(() => {});
        // TEAM-4781: the marker write is exactly what an earlier tap may have died
        // on, so a ❌ re-tap retries it (idempotent) before the ticket half runs.
        if (!approve) {
          return await settleShipRejection({
            cb, chatId, ticketId, workflowId, outcome: DEPLOY_GATE_ALREADY,
            state, cp, pipeline: name, executionId: deploy.executionId,
          });
        }
        return DEPLOY_GATE_ALREADY;
      }
      throw new Error(`no approval action is waiting for execution ${deploy.executionId || "(unlabelled)"} on ${name}`);
    }
    // Ledger BEFORE the pipeline call (SEC-9): if this invocation dies between
    // the two, the memo is what tells the retry that the gate is already ours.
    await recordGateApproved({ ticketId }, { approve, chatId });
    try {
      await cp.send(new PutApprovalResultCommand({
        pipelineName: name, stageName: mine.stageName, actionName: mine.actionName,
        token: mine.token,
        result: {
          status: approve ? "Approved" : "Rejected",
          summary: `${approve ? "Approved" : "Rejected"} via Telegram by chat ${chatId} (gate ${ticketId})`,
        },
      }));
    } catch (err) {
      // Answered in the gap between the state read and this call. The pipeline
      // is where the human wants it, so this is not a failure of the decision.
      if (!APPROVAL_ALREADY_RE.test(`${err.name || ""} ${err.message || ""}`)) throw err;
      console.warn(`[telegram-bug-intake] deploy gate ${ticketId} was already resolved on ${name}: ${scrub(err.message)}`);
      // The rejection stands on the pipeline, so the marker is the only half that
      // may still be missing — attempt it here too (TEAM-4781).
      //
      // TEAM-4781 SR2 deliberately does NOT condition this arm on the ledger. An
      // approval action WAS waiting for this execution a moment ago, so whoever
      // answered it in the gap is unknowable from here - and the ledger cannot
      // help, because the SEC-9 write above (BEFORE the pipeline call, which is
      // the invariant that closes the 29h stall) has already stamped this tap's
      // own "Rejected" over any earlier row. Unknown means conservative: the
      // marker only ever ADDS a human gate, so writing it costs a re-approval at
      // worst, while skipping it risks a rejected commit deploying unattended.
      if (!approve) {
        return await settleShipRejection({
          cb, chatId, ticketId, workflowId, outcome: DEPLOY_GATE_ALREADY,
          state, cp, pipeline: name,
          executionId: mine.executionId || deploy.executionId,
        });
      }
      return DEPLOY_GATE_ALREADY;
    }
    // SEC-1: a REJECTED ship is recorded where the pipeline's own preapproval
    // check looks, so a later run cannot read a stale approval for this commit.
    // TEAM-4781: and if it cannot be recorded, this is not a completed decision.
    if (!approve) {
      return await settleShipRejection({
        cb, chatId, ticketId, workflowId, outcome: DEPLOY_GATE_DECIDED,
        state, cp, pipeline: name,
        executionId: mine.executionId || deploy.executionId,
      });
    }
    return DEPLOY_GATE_DECIDED;
  } catch (err) {
    console.error(`[telegram-bug-intake] deploy gate ${ticketId} (${deploy.pipeline || "?"})`, scrub(err.message));
    await tgAnswer(cb.id, `Could not ${approve ? "approve" : "reject"} the deploy — nothing changed.`).catch(() => {});
    const body =
      `${cb.message.text}\n\n⚠️ ${esc(scrub(err.name || "Error"))}: ${esc(scrub(err.message || ""))}\n` +
      `The pipeline was NOT ${approve ? "approved" : "rejected"} and ${esc(ticketId)} is untouched — tap again to retry.`;
    await tgEdit(chatId, cb.message.message_id, body.slice(0, 4000)).catch(() => {});
    return DEPLOY_GATE_FAILED;
  }
}

/**
 * The ship-approval REJECTION marker (SEC-1) — the bridge's ONE S3 write.
 *
 * The pipeline's Build stage decides whether the human deploy gate may be
 * skipped by reading `pipeline-artifacts/ship-approvals/<merge_commit>.json`
 * (deploy/pipeline/preapproved-check.sh). An approval recorded for a commit is
 * therefore durable, and a rejection that leaves no trace next to it lets a
 * re-run of the SAME commit read the stale approval and skip the gate the human
 * just closed. This writes the counterpart.
 *
 * TEAM-4781 (SR1-2): it used to be best-effort — a swallowed PutObject error, and
 * the caller returned "decided" regardless, which is why DL-031's "durable fact"
 * was not one. It still never THROWS, but it now retries once and REPORTS, so the
 * caller can keep the gate open for a re-tap:
 *
 *   { ok: true,  key }                    the marker is in S3
 *   { ok: true,  key: null, skipped }     nothing could be written and no retry
 *                                         can change that (see below)
 *   { ok: false, key, reason }            both PutObject attempts failed
 *
 * The two `skipped` cases are deliberately NOT failures:
 *   "artifact_bucket_unset"  — an install with no ARTIFACT_BUCKET has no
 *     ship-approval RECORD either, so nothing can skip the gate on it:
 *     preapproved-check.sh prints 0 with no bucket and refuses on the empty path.
 *     There is nothing to record and nothing to retry.
 *   "commit_unresolved"      — the state carries no source revision, so there is
 *     no key to write, name or retry (it is a pure function of the state already
 *     fetched). Pre-existing behaviour, logged loudly, out of SR1-2's scope.
 */
async function writeShipRejection({ state, cp, pipeline, executionId, chatId }) {
  if (!ARTIFACT_BUCKET) {
    console.warn(`[telegram-bug-intake] ship rejection for ${pipeline}: ARTIFACT_BUCKET is unset — no marker to write`);
    return { ok: true, key: null, skipped: "artifact_bucket_unset" };
  }
  let mergeCommit = null;
  try {
    mergeCommit = await executionRevision(cp, state, pipeline, executionId);
  } catch (err) {
    console.error(`[telegram-bug-intake] ship rejection for ${pipeline}: commit lookup failed: ${err.message}`);
  }
  if (!mergeCommit) {
    console.warn(`[telegram-bug-intake] ship rejection for ${pipeline} execution ${executionId || "(unknown)"}: no commit resolved — no marker written`);
    return { ok: true, key: null, skipped: "commit_unresolved" };
  }
  const key = `pipeline-artifacts/ship-approvals/${mergeCommit}.rejected.json`;
  const body = JSON.stringify({
    executionId: executionId || null,
    pipeline,
    rejectedAt: new Date().toISOString(),
    chatId: String(chatId ?? ""),
  });
  let last = "";
  // Two attempts: the overwhelmingly common failure here is transient (throttle,
  // a credential refresh, a blip), and one retry is the difference between a
  // recoverable stall and paging the human.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await s3Client().send(new PutObjectCommand({
        Bucket: ARTIFACT_BUCKET, Key: key, Body: body, ContentType: "application/json",
      }));
      return { ok: true, key };
    } catch (err) {
      last = err?.message || String(err);
      console.error(`[telegram-bug-intake] ship rejection marker ${key} attempt ${attempt}/2: ${last}`);
      if (attempt < 2) await sleep(_deployGateRetryMs);
    }
  }
  return { ok: false, key, reason: last };
}

/**
 * A ❌ whose rejection is now recorded on the PIPELINE, settled against the
 * marker (TEAM-4781). Returns the outcome the caller should return: `outcome`
 * when the marker is in place, DEPLOY_GATE_FAILED when it is not — and "failed"
 * already means, everywhere in this module, "the ticket is not touched at all and
 * the tap is the retry" (SEC-8).
 */
async function settleShipRejection({
  cb, chatId, ticketId, workflowId, outcome, state, cp, pipeline, executionId,
}) {
  const marker = await writeShipRejection({ state, cp, pipeline, executionId, chatId });
  if (marker.ok) return outcome;
  await reportMissingRejectionMarker({ cb, chatId, ticketId, workflowId, marker });
  return DEPLOY_GATE_FAILED;
}

/**
 * Say what actually happened when the pipeline took the ❌ but the marker did not
 * land: the rejection is IRREVERSIBLE and the gate is still guardable, which is
 * the opposite of the generic "the pipeline was NOT rejected" text.
 *
 * Patterned on answerDeployGateTicketStuck: never throws, and preserves the
 * keyboard so the ❌ re-tap that retries the marker is possible. The comment names
 * the KEY and nothing else — no bucket, no ARNs, no credentials, no S3 error text
 * (that stays in CloudWatch).
 */
async function reportMissingRejectionMarker({ cb, chatId, ticketId, workflowId, marker }) {
  const key = marker?.key || "(unresolved)";
  console.error(`[telegram-bug-intake] gate ${ticketId || "(tokenless)"}: rejection recorded on the pipeline but marker ${key} is MISSING: ${redactText(String(marker?.reason || ""))}`);
  await tgAnswer(cb.id, "Rejected on the pipeline — the marker did not save.").catch(() => {});
  if (workflowId && ticketId) {
    await postGateComment(workflowId, ticketId,
      `🛑 The deploy was REJECTED on the pipeline, but the ship-rejection marker could not be written after a retry.\n\n` +
      `Missing object key: ${key}\n\n` +
      `Until that key exists, a later run of the same commit could read an earlier ship-approval record and skip this gate. ` +
      `This gate is deliberately left open: tap ❌ again on the Telegram page to retry the marker — the pipeline will not be rejected twice.`,
    ).catch(() => {});
  }
  const body =
    `${cb.message.text}\n\n` +
    `🛑 The deploy IS rejected on the pipeline — that part is done.\n` +
    `⚠️ The rejection marker could not be saved: ${esc(key)}\n` +
    `${esc(ticketId || "The gate")} is untouched — tap ❌ again to retry the marker only; the pipeline will not be rejected twice.`;
  await tgEdit(chatId, cb.message.message_id, body.slice(0, 4000),
    cb.message.reply_markup ? { reply_markup: cb.message.reply_markup } : {}).catch(() => {});
}

/**
 * Comment on a gate ticket WITHOUT transitioning it. The transition route's
 * VALID_TRANSITIONS has no in_review → in_review edge, so the comment-only
 * endpoint is the one that can say something on a ticket that must stay put.
 */
async function postGateComment(workflowId, ticketId, content) {
  const res = await fetch(`${HUB_API_URL}/api/workflow/${encodeURIComponent(workflowId)}/tickets/comment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticketId, author: "telegram-deploy-gate", content }),
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    throw new Error(`comment ${res.status}: ${raw.slice(0, 300)}`);
  }
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

/**
 * The gate's own ticket row AND the run's whole ticket set, from ONE fetch.
 *
 * Both paging paths need both: the row for classification and the resolved
 * check, the set for the attempt count (sibling gates) and the shipping list.
 * The reminder path used to take the row and throw the set away, so it counted
 * attempts from an empty list and a re-filed gate's reminder contradicted its
 * own request-time page (TEAM-4671 F2). Never throws.
 *
 * FAILS CLOSED: an unavailable tickets view returns `{indeterminate:true}`, not
 * an empty set. `{gateTicket:null, tickets:[]}` is indistinguishable from "this
 * is an ordinary review gate", and *that* read is what let a
 * `gate:deploy-approval` ticket be transitioned as a plain gate while the
 * pipeline's approval was never touched. On `indeterminate` a caller must
 * transition NOTHING, write no ledger row, and say so — the tap stays retryable.
 */
async function gateTicketOf(wf, notif) {
  try {
    const res = await fetch(`${HUB_API_URL}/api/workflow/${wf.workflowId}/tickets`);
    if (!res.ok) return { gateTicket: null, tickets: [], indeterminate: true };
    const { tickets = [] } = await res.json();
    return { gateTicket: tickets.find((t) => t.ticketId === notif.ticketId) || null, tickets };
  } catch {
    return { gateTicket: null, tickets: [], indeterminate: true };
  }
}

/**
 * Is this ticket row already closed? Both gate branches ask it, and the two
 * providers spell the status differently ("in review" vs "In Review", "Done"),
 * so the lowercase compare is the only safe form.
 */
function isTicketDone(t) {
  return String(t?.status || "").toLowerCase() === "done";
}

/**
 * `blockedBy` is an ARRAY in dynamodb mode and a comma-joined STRING in jira
 * mode (src/lib/workflow/jira-read.ts:145, despite JiraTicket.blockedBy being
 * typed string[]). Calling .map() on the string form threw a TypeError that the
 * caller's catch swallowed, so every Jira-mode gate lost its shipping list.
 * The UI carries the same workaround inline (src/components/workflow/
 * TicketDetailModal.tsx:320) — keep the three in step.
 */
function normalizeBlockedBy(x) {
  if (Array.isArray(x)) return x.filter(Boolean);
  if (typeof x === "string") return x.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

/**
 * What this run has already landed, for a gate whose `blockedBy` says nothing.
 * `wf.agentTasks[ticketId].prUrl` is the ONLY pre-completion PR signal on the
 * wire: neither ticket provider puts a PR url on a ticket row, and `wf.delivery`
 * is written by completeWorkflow AFTER the phase goes terminal — which
 * scanReviewGates skips — so the old `wf.delivery?.prUrl` fallback here was
 * unreachable. Titles come from the ticket rows; an agentTasks entry has none.
 * Newest first, so the builder's render cap keeps the work closest to this
 * review. The list is returned WHOLE and capped only at render time: the ping's
 * "+N more" is `shipping.length - rendered` (shippingSubject), so a cap here
 * silently undercounts what the reviewer is approving (TEAM-4673).
 */
function shippedTitles(wf, tickets) {
  const tasks = wf?.agentTasks && typeof wf.agentTasks === "object" ? wf.agentTasks : {};
  return (tickets || [])
    .filter((t) => t && String(t.status || "").toLowerCase() === "done" && tasks[t.ticketId]?.prUrl)
    .map((t) => ({ title: oneLine(t.title), at: Date.parse(tasks[t.ticketId]?.completedAt || t.updatedAt || t.createdAt || "") }))
    .filter((x) => x.title)
    .sort((a, b) => (Number.isFinite(b.at) ? b.at : 0) - (Number.isFinite(a.at) ? a.at : 0))
    .map((x) => x.title);
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

/** The ✅/❌ + hub keyboard every gate page and re-page carries. */
function gateDecisionKeyboard(wf, notif) {
  return { inline_keyboard: [
    [
      { text: "✅ Approve", callback_data: `gok|${notif.ticketId}|${wf.workflowId}` },
      { text: "❌ Request changes", callback_data: `gno|${notif.ticketId}|${wf.workflowId}` },
    ],
    [{
      text: "📱 Open approval in hub",
      url: `${HUB_API_URL}/workflow?id=${encodeURIComponent(wf.workflowId)}&ticket=${encodeURIComponent(notif.ticketId)}`,
    }],
  ] };
}

/**
 * The COPY for a gate the typed-gate guard refused (`gate:awaiting-console`) —
 * ONE construction with two callers (TEAM-4751 C2): the out-of-hours reminder
 * (repageIfWindowOpened) and the in-hours consumer (repageAwaitingConsole). A
 * second copy of this wording is exactly how the two would drift into telling a
 * human two different things about one stall.
 *
 * It is NOT an ordinary "still waiting on you" page: an agent already tried to
 * close the gate and was told no. So the copy names the place the condition is
 * actually cleared, and drops the "your window is open" line, which would
 * describe the wrong reason for the wait.
 *
 * Kind-aware, because the twins stamp this label on ANY probed gate
 * (gate-contract.mjs PROBED_GATE_KINDS — deploy-approval, ci-unavailable,
 * blocker). Only a deploy approval has a console the human answers; for the rest
 * the remedy is in the ticket's own gate-guard comment, so no console URL is
 * claimed and no console button is offered (the meta line is omitted with it).
 *
 * `keyboard` is mutated in place — the console button is pushed onto it — which
 * is what keeps the send in the caller (the approval-builder guardrail requires
 * that the sender be an APPROVAL_SITE). Best-effort, like every other lookup on
 * these paths: deployApprovalGate never throws.
 *
 * @returns {Promise<{consoleUrl:string, label:string, summary:string, meta:string[], ask:string}>}
 */
async function awaitingConsolePage(gateTicket, keyboard) {
  const { gateKind } = parseDeployApprovalLabels(gateTicket?.labels);
  const g = await deployApprovalGate(gateTicket);
  const consoleUrl = g
    ? pipelineConsoleUrl({ pipeline: g.target?.pipeline || g.pipeline, region: g.target?.region })
    : "";
  if (consoleUrl) {
    keyboard.inline_keyboard.push([{ text: "🔗 Open the deploy gate in the console", url: consoleUrl }]);
  }
  const deployKind = Boolean(g);
  return {
    consoleUrl,
    label: "awaiting-console reminder",
    summary: deployKind
      ? "Still parked on the pipeline's own deploy approval — an agent tried to close this gate and was refused, because the approval has not been given yet."
      : `An agent tried to close this gate and was refused, because its gate:${gateKind} condition has not been verified. The ticket's own gate-guard comment says what the check found and how to clear it.`,
    meta: deployKind && consoleUrl ? [`🖥 [deploy gate in the console](${consoleUrl})`] : [],
    ask: !deployKind
      ? "Clear the condition the gate names — the ticket comment has the remedy — or Request changes here to stop it."
      : consoleUrl
        ? "Approve the deploy in the console (the button above), or Request changes here to stop it."
        : "Approve the deploy in the pipeline's own console, or Request changes here to stop it.",
  };
}

/**
 * The gate# claim already exists (this notification was paged on an earlier
 * scan). If that page landed outside the window and the window has since
 * opened, send exactly ONE reminder, deduped on repage#<notif>. Never throws:
 * a failure here must not cost the remaining pending gates their pages.
 *
 * @returns {Promise<boolean>} true only when a reminder was DELIVERED. The
 *   caller uses that to keep one stall to one page per scan (TEAM-4751 C2).
 */
async function repageIfWindowOpened(wf, notif, w) {
  let holding = null;
  try {
    if (isOutsideHours(notif.timestamp, w) !== true) return false;
    const openAt = nextBusinessOpenAt(notif.timestamp, w);
    if (!openAt || Date.now() < openAt.getTime()) return false;

    // TEAM-4461: the request-time page itself may have landed INSIDE the window —
    // a gate requested 08:59 and paged by the 09:00 scan, or a page delayed past
    // the opening by a notifier outage. The human already has it, in hours; a
    // "your window is open now" nudge 60s later is noise. A claim with no
    // pagedAt was written by an older deployment → fall through as before.
    const { Item: claim } = await ddb.send(new GetItemCommand({
      TableName: PENDING_TABLE, Key: { id: { S: gateClaimKey(notif) } },
    }));
    const pagedAt = Date.parse(claim?.pagedAt?.S || "");
    if (Number.isFinite(pagedAt) && pagedAt >= openAt.getTime()) return false;

    const key = `${REPAGE_KEY_PREFIX}${notif.id || notif.ticketId}`;
    if (!(await claimKey(key))) return false; // already reminded
    holding = key;

    // gateTicketOf fails CLOSED, but "closed" is about the WRITE paths: a caller
    // that would transition a ticket or answer a tap must touch nothing. This
    // path writes nothing — it only reminds — and going quiet because the hub's
    // tickets view blipped is the silent park this whole change exists to end.
    // So the reminder still goes out on an unverifiable read, on exactly the
    // information the request-time page had (scanReviewGates does the same at the
    // gateTicketOf call above): the id as the title, no awaiting-console branch.
    const { gateTicket, tickets, indeterminate } = await gateTicketOf(wf, notif);
    if (indeterminate) {
      console.warn(`[telegram-bug-intake] business-hours reminder for ${notif.ticketId}: gate type unverifiable — reminding on the request-time facts`);
    }
    // Resolved in the meantime → keep the claim: there is nothing to remind
    // about and re-checking on every later scan would be pure noise.
    const status = String(gateTicket?.status || "").toLowerCase();
    if (REPAGE_SKIP_STATUSES.has(status)) return false;

    const chats = (await listChats()).filter((c) => ALLOWED_CHAT_IDS.includes(String(c)));
    if (!chats.length) {
      console.warn("[telegram-bug-intake] business-hours reminder but no allowlisted chats to notify");
      return false; // the request-time page already went out; do not retry forever
    }

    const title = gateTicket?.title || notif.ticketId;
    const reviewer = notif.reviewer || "reviewer";
    const keyboard = gateDecisionKeyboard(wf, notif);

    // A gate the ticket Lambdas refused to close because its typed-gate
    // condition is not verified (WP2's gate:awaiting-console stamp). Its copy —
    // and the console button, when there is a console to send anyone to — is
    // built by awaitingConsolePage, shared with the in-hours consumer.
    const page = gateAwaitingConsole(gateTicket) ? await awaitingConsolePage(gateTicket, keyboard) : null;

    // Same content rules as the request-time page (TEAM-4660): the gate
    // ticket's title/description never reach the reminder either. Same INPUTS
    // too (TEAM-4671 F2) — the reminder and the page must agree on the attempt.
    const { attempt, previousIssue } = await approvalAttempt({ wf, notif, tickets });
    // Shared classification (TEAM-4706): a deploy-approval gate reminds with
    // the same 🚀 kicker it paged with, without a second rule living here. A
    // handoff reminds with its own ask, like its page (TEAM-4885).
    let reminderKind = gateKindFor(notif.gate, title, gateTicket);
    if (reminderKind === "review" && !page && gateTicket?.title && !oneLine(notif.summary)) reminderKind = "handoff";
    const handoff = reminderKind === "handoff" ? handoffCopy(gateTicket, wf) : null;
    const { delivered } = await sendApprovalPing(chats, {
      label: page ? page.label : "business-hours reminder",
      gateKind: reminderKind,
      repage: true,
      subject: handoff ? handoff.subject : (wf.input?.title || wf.workflowId),
      summary: page ? page.summary : "Sent for review outside working hours and still open — your window is open now.",
      bullets: handoff ? handoff.bullets : [],
      bulletsLabel: handoff ? handoff.bulletsLabel : undefined,
      attempt,
      previousIssue,
      meta: [
        `👤 ${esc(reviewer)}`,
        `🎫 [${notif.ticketId}](https://${JIRA_SITE_URL}/browse/${notif.ticketId})`,
        handoff ? "⏸ the agent is parked until you close this" : "⏸ pipeline paused on you",
        ...(page ? page.meta : []),
      ],
      ask: page ? page.ask : "Approve to continue, or Request changes to send it back.",
      keyboard,
    });
    if (!delivered) await releaseKey(holding);
    return delivered > 0;
  } catch (err) {
    console.error(`[telegram-bug-intake] business-hours reminder for ${notif.ticketId}`, err.message);
    if (holding) {
      await releaseKey(holding).catch((relErr) =>
        console.error("[telegram-bug-intake] releaseKey after reminder failure", relErr.message));
    }
    return false;
  }
}

// Rate limiter, NOT a ledger: the awaiting-console consumer's trigger is a LABEL,
// so without this it would cost one /tickets GET per open gate per 60s scan. The
// console# row is what makes the paging exactly-once; this only bounds the read.
const AWAITING_CONSOLE_POLL_MS = parseInt(process.env.AWAITING_CONSOLE_POLL_MS || "120000", 10);
const AWAITING_CONSOLE_SEEN_MAX = 500;
const _awaitingConsoleSeen = new Map(); // gate claim key → lastCheckedAt (per container)

const CONSOLE_KEY_PREFIX = "console#";

/**
 * NFR-5's idempotency tuple: console#<ticketId>|<gateKind>|<headSha|->|<hash(consoleUrl|->)>.
 * hashToken keeps the URL itself out of the key while making a RE-TARGETED gate
 * (new head sha, or a different pipeline) a different row — which is the point:
 * the human owes a fresh answer, so it must not be deduped against the old one.
 */
function awaitingConsoleKey({ ticketId, gateKind, headSha, consoleUrl }) {
  return `${CONSOLE_KEY_PREFIX}${ticketId}|${gateKind || "gate"}|${headSha || "-"}|${hashToken(consoleUrl || "-")}`;
}

/**
 * TEAM-4751 C2 — page the human about a gate the twins' typed-gate guard parked
 * (`gate:awaiting-console`), REGARDLESS of business hours.
 *
 * The label's only previous reader was repageIfWindowOpened, which needs the
 * notification to have been requested out of hours AND its window to have since
 * opened — so an in-hours refusal paged nobody at all and the human learned of
 * the stall from a Jira comment. Here the LABEL is the trigger, not the clock.
 *
 * Bounded by the ledger the deploy re-ping already uses: one first page, then at
 * most DEPLOY_REPING_MAX reminders at DEPLOY_REPING_INTERVAL_MS, keyed on the
 * NFR-5 tuple. Never throws — a failure here must not cost the remaining pending
 * gates their pages.
 *
 * Interplay with C1: the callback handler and this scan run serially inside one
 * invocation (reserved concurrency 1), and the twins clear the label in the SAME
 * write that moves the gate to `done`, so a label left by a lagging-read refusal
 * that C1's retry then clears is never observed by a scan.
 *
 * @returns {Promise<boolean>} true only when a page was DELIVERED.
 */
async function repageAwaitingConsole(wf, notif, w) {
  let holding = null;
  try {
    // Stamp the memo BEFORE the read, so a throwing read still rate-limits.
    const memoKey = gateClaimKey(notif);
    const now = Date.now();
    const lastChecked = _awaitingConsoleSeen.get(memoKey);
    if (Number.isFinite(lastChecked) && now - lastChecked < AWAITING_CONSOLE_POLL_MS) return false;
    if (_awaitingConsoleSeen.size > AWAITING_CONSOLE_SEEN_MAX) _awaitingConsoleSeen.clear();
    _awaitingConsoleSeen.set(memoKey, now);

    // Fails CLOSED, unlike repageIfWindowOpened: there the reminder was already
    // owed and the request-time facts were enough to send it, whereas here the
    // label IS the trigger, so a read that proved nothing must page nothing and
    // claim nothing. The next scan past the memo tries again.
    const { gateTicket, tickets, indeterminate } = await gateTicketOf(wf, notif);
    if (indeterminate) {
      console.warn(`[telegram-bug-intake] awaiting-console check for ${notif.ticketId}: tickets unreadable — nothing paged`);
      return false;
    }
    const labels = parseDeployApprovalLabels(gateTicket?.labels);
    if (!labels.awaitingConsole) return false;
    // Resolved in the meantime → nothing to page about.
    if (REPAGE_SKIP_STATUSES.has(String(gateTicket?.status || "").toLowerCase())) return false;

    const keyboard = gateDecisionKeyboard(wf, notif);
    const page = await awaitingConsolePage(gateTicket, keyboard);
    const key = awaitingConsoleKey({
      ticketId: notif.ticketId, gateKind: labels.gateKind,
      headSha: labels.headSha, consoleUrl: page.consoleUrl,
    });

    // claimKey writes claimedAt + a 30-day TTL, which is exactly the row shape
    // decideDeployPingMode reads — so the first page and every bounded reminder
    // share one row, with no second ledger and no change to any existing caller.
    const first = await claimKey(key);
    const mode = first ? { kind: "first" } : await decideDeployPingMode(key);
    if (!mode) return false; // too soon, or the reminder budget is spent
    if (first) holding = key;

    const chats = (await listChats()).filter((c) => ALLOWED_CHAT_IDS.includes(String(c)));
    if (!chats.length) {
      console.warn("[telegram-bug-intake] awaiting-console page but no allowlisted chats to notify");
      if (holding) await releaseKey(holding);
      return false;
    }

    const title = gateTicket?.title || notif.ticketId;
    // A deploy approval nags with its OWN kind (APPROVAL_KICKERS
    // "deploy-pipeline-reminder", TEAM-4663 F3); any other probed kind keeps the
    // kicker it was paged with. Never `repage: true` on either: this page fires
    // whenever the label appears, in hours as often as not, and "·
    // business-hours reminder" would state the wrong reason for the wait — the
    // reason is in the summary, and it is a refused close, not the clock.
    const isDeploy = labels.isDeployApproval;
    const { attempt, previousIssue } = await approvalAttempt({ wf, notif, tickets });
    const { delivered, messageIds } = await sendApprovalPing(chats, {
      label: page.label,
      gateKind: isDeploy ? "deploy-pipeline-reminder" : gateKindFor(notif.gate, title, gateTicket),
      repage: false,
      subject: wf.input?.title || wf.workflowId,
      summary: page.summary,
      attempt,
      previousIssue,
      meta: [
        `👤 ${esc(notif.reviewer || "reviewer")}`,
        `🎫 [${notif.ticketId}](https://${JIRA_SITE_URL}/browse/${notif.ticketId})`,
        "⏸ pipeline paused on you",
        ...page.meta,
      ],
      ask: page.ask,
      keyboard,
    });
    if (!delivered) {
      if (holding) await releaseKey(holding);
      return false;
    }
    await markPingDelivered(key, {
      now: Date.now(),
      pingCount: mode.kind === "reminder" ? mode.n + 1 : 1,
      messageIds,
    }).catch((err) => console.error(`[telegram-bug-intake] markPingDelivered ${key}`, err.message));
    return true;
  } catch (err) {
    console.error(`[telegram-bug-intake] awaiting-console page for ${notif.ticketId}`, err.message);
    if (holding) {
      await releaseKey(holding).catch((relErr) =>
        console.error("[telegram-bug-intake] releaseKey after awaiting-console failure", relErr.message));
    }
    return false;
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
  let recovered = 0;
  for (const { wf, notif } of pending) {
    // TEAM-4663: "already claimed" is not the same as "already delivered". A
    // claim with no deliveredAt, older than the lease, was stranded — nobody was
    // ever paged, and because a re-parked gate only mints a new notif.id AFTER
    // someone reviews it, nothing would ever re-mint this one. Re-send.
    // No TTL fallback here on purpose: a row with no claimedAt predates this
    // change, so deploying it re-pages nobody (claimedAtOf).
    const mode = (await claimGate(notif))
      ? "first"
      : await consultClaimForRecovery(gateClaimKey(notif), { label: "review gate" });
    if (!mode) {
      // Already paged, and the page is accounted for. Two things can still be
      // owed: the once-per-notification business-hours reminder, and — TEAM-4751
      // C2 — a page for a gate the twins' guard parked on its unmet condition.
      // At most ONE page per scan: the two are keyed differently (repage# vs
      // console#) and would both fire for a labelled gate whose window just
      // opened, which is two messages about one stall. The out-of-hours reminder
      // wins (it is once-per-notification and already carries the
      // awaiting-console copy); the consumer's console# row is untouched, so it
      // pages on a later scan if the gate is still parked.
      if (!(await repageIfWindowOpened(wf, notif, window))) {
        await repageAwaitingConsole(wf, notif, window);
      }
      continue;
    }
    if (mode === "first") pinged++; else recovered++;

    // The claim is written before delivery is proven, so ANY throw between here
    // and a delivered ping (e.g. a transient listChats Scan failure) must
    // release it — a stranded claim silences this gate for 30 days. In RECOVERY
    // mode the row is kept instead: its lease was just refreshed, so the next
    // scan past PING_LEASE_MS retries on its own, and deleting a row we did not
    // create would lose the delivery history it carries.
    try {
      // The chat registry is historical — chat# rows outlive de-allowlisting.
      // Gate pings must respect the same allowlist as inbound messages, or the
      // ping leaks workflow titles/links to revoked chats AND their delivery
      // counts toward `delivered`, suppressing the retry for real reviewers.
      chats = chats || (await listChats()).filter((c) => ALLOWED_CHAT_IDS.includes(String(c)));
      if (!chats.length) {
        console.warn("[telegram-bug-intake] gate ticket but no allowlisted chats to notify");
        if (mode === "first") await releaseGate(notif); // nobody was pinged — let a later scan retry
        continue;
      }

      // Pull the whole ticket set so the ping is SELF-CONTAINED — the reviewer
      // decides from Telegram without opening the hub. From it we take: the gate
      // ticket's title (for CLASSIFICATION only — never rendered, TEAM-4660), the
      // titles of the UPSTREAM work it blocks on (blockedBy) — i.e. exactly what
      // is being reviewed — and the sibling gates that came before it.
      // One fetch, shared with the reminder path (gateTicketOf); it never throws,
      // so an unavailable tickets view just leaves the id as the title.
      const { gateTicket, tickets: allTickets } = await gateTicketOf(wf, notif);
      const title = gateTicket?.title || notif.ticketId;
      const byId = new Map(allTickets.map((x) => [x.ticketId, x]));
      // Whole list, not a slice: the builder renders APPROVAL_SHIP_MAX of them
      // and counts the rest as "+N more" (TEAM-4673).
      const upstreamTitles = normalizeBlockedBy(gateTicket?.blockedBy)
        .map((id) => byId.get(id)?.title)
        .filter(Boolean);

      const reviewer = notif.reviewer || "reviewer";
      const isEscalation = ESCALATION_GATE_TITLE.test(title);
      const ticketLink = `🎫 [${notif.ticketId}](https://${JIRA_SITE_URL}/browse/${notif.ticketId})`;
      // TEAM-4706: the LABEL decides. A gate:deploy-approval ticket IS the
      // production-deploy decision, so it pages with the 🚀 kicker and the same
      // brief the pipeline's own page carries — its ✅ really approves the
      // pipeline (handleGateCallback). Both are best-effort: neither the target
      // lookup nor the brief throws, so a registry/GitHub/CodePipeline hiccup
      // still pages the human with today's plain gate content.
      const deploy = await deployApprovalGate(gateTicket);
      const brief = deploy ? await deployApprovalBrief(deploy) : null;
      // WHAT is being reviewed: the upstream work this gate blocks on, else the
      // work the run has already landed a PR for. Never the gate's own prose.
      const shipping = upstreamTitles.length ? upstreamTitles : shippedTitles(wf, allTickets);
      // Only the closing agent's CURATED review package may speak here — a gate
      // ticket description is a runbook for the human, not ping copy.
      const { attempt, previousIssue } = await approvalAttempt({ wf, notif, tickets: allTickets });
      // TEAM-3971: a ship-review escalation needs a DECISION, not a bare approve
      // (a bare approve used to park the release manager forever). Offer the
      // three decisions as buttons; each records a `DECISION:` line on the gate.
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
      // Same links the pipeline's own 🚀 page offers: what is actually shipping.
      if (brief?.prUrl) keyboard.inline_keyboard.push([{ text: "🔗 View PR", url: brief.prUrl }]);
      else if (brief?.commitUrl) keyboard.inline_keyboard.push([{ text: "🔗 View commit", url: brief.commitUrl }]);
      for (const l of (Array.isArray(notif.links) ? notif.links : []).slice(0, 4)) {
        if (!l || !l.label) continue;
        const url = l.url
          ? l.url
          : l.artifactKey
            ? `${HUB_API_URL}/workflow?id=${encodeURIComponent(wf.workflowId)}&artifact=${encodeURIComponent(l.artifactKey)}`
            : null;
        if (url) keyboard.inline_keyboard.push([{ text: `📄 ${l.label}`.slice(0, 60), url }]);
      }

      const deployMeta = deploy
        ? [
            deploy.target?.pipeline ? `🏷 ${esc(deploy.target.pipeline)}` : "",
            deploy.target?.repo ? `📦 ${esc(deploy.target.repo)}` : "",
          ].filter(Boolean)
        : [];
      // messageIds is what phase 2 records on the claim row (TEAM-4663): the
      // proof a human really has this page, and the handles a later edit needs.
      // A gate the table cannot name AND that no closing agent wrote a review
      // package for is, by elimination, a task for a human (TEAM-4908: "CI
      // unavailable: …"). Rendering it as an approval would show the run title and
      // a ticket dump with no ask — so it pages as a handoff, with its own ask.
      let gateKind = gateKindFor(notif.gate, title, gateTicket);
      // (Only when the ticket itself is known — an unreadable tickets view leaves a
      // bare review gate, as before.)
      if (gateKind === "review" && !deploy && gateTicket?.title && !oneLine(notif.summary)) gateKind = "handoff";
      const handoff = gateKind === "handoff" ? handoffCopy(gateTicket, wf) : null;
      const { delivered, messageIds } = await sendApprovalPing(chats, {
        label: deploy ? "deploy-approval gate" : handoff ? "handoff" : "gate",
        gateKind,
        subject: handoff
          ? handoff.subject
          : (brief && (brief.prTitle || brief.commitSubject)) || wf.input?.title || wf.workflowId,
        // With a brief the subject already names the PR/commit; the upstream
        // titles would only repeat it. A handoff is not shipping anything.
        shipping: brief || handoff ? [] : shipping,
        summary: deploy
          ? (brief?.summary || oneLine(notif.summary) || DEPLOY_GATE_TERSE)
          : isEscalation
            ? (oneLine(notif.summary) || "The ship-review loop hit its round cap and needs a human call.")
            : handoff
              ? (oneLine(notif.summary) || handoff.summary)
              : oneLine(notif.summary),
        bullets: brief
          ? [
              brief.workflowLine,                               // "Workflow: TEAM-3721 (bug-fix)"
              brief.scopeLine,                                  // "Scope: 8 files (+147/-4)"
              brief.commitLine && brief.commitLine.replace(/`/g, ""), // "Commit: a1b2c3d"
            ].filter(Boolean)
          : handoff
            ? handoff.bullets
            : Array.isArray(notif.bullets) ? notif.bullets : [],
        bulletsLabel: handoff ? handoff.bulletsLabel : undefined,
        attempt,
        previousIssue,
        meta: deploy
          ? [`👤 ${esc(reviewer)}`, ...deployMeta, ticketLink, "⏸ pipeline paused on you"]
          : isEscalation
            ? [`👤 ${esc(reviewer)}`, ticketLink]
            : handoff
              ? [`👤 ${esc(reviewer)}`, ticketLink, "⏸ the agent is parked until you close this"]
              : [`👤 ${esc(reviewer)}`, ticketLink, "⏸ pipeline paused on you"],
        ask: deploy
          ? DEPLOY_GATE_ASK
          : isEscalation
            ? "Pick ONE decision below — it is recorded as a DECISION line and the release manager resumes on its own."
            : handoff
              ? "Do it, then tap ✅ to release the agent — or ❌ with a note to send it back."
              : "Approve to continue, or Request changes to send it back.",
        keyboard,
      });
      // The claim was written before delivery was proven; if every send failed,
      // keeping it would silently skip this gate for 30 days. A recovery keeps
      // the row and retries on the next lease expiry (see the try comment).
      if (!delivered) { if (mode === "first") await releaseGate(notif); }
      else {
        // Phase 2 — record that a human actually has it, so a later scan can
        // tell this row apart from a stranded claim. Never fatal: a failed write
        // costs one duplicate page a lease later, while letting it throw would
        // hit the catch below and release a claim whose ping DID land.
        await markPingDelivered(gateClaimKey(notif), { pingCount: 1, messageIds }).catch((err) =>
          console.error("[telegram-bug-intake] markPingDelivered (gate)", err.message));
        // Exactly one gate.requested per notification, and only for a page that
        // actually landed — it is the metrics record of "the human was asked".
        // A recovery publishes too: nothing was ever delivered before it, so
        // nothing was ever published, and the recovery IS when the human was asked.
        await publishGateRequested(wf, notif, window);
      }
    } catch (err) {
      if (mode === "first") {
        await releaseGate(notif).catch((relErr) =>
          console.error("[telegram-bug-intake] releaseGate after gate failure", relErr.message));
      }
      throw err;
    }
  }
  if (pinged || recovered) {
    console.log(`[telegram-bug-intake] review gates: ${pending.length} open, ${pinged} newly pinged` +
      (recovered ? `, ${recovered} re-sent after an unconfirmed ping` : ""));
  }
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
        // TEAM-4461: the claim is written milliseconds before delivery in the same
        // scan (and released when nobody received it), so this IS the page time.
        // Untouched by TEAM-4663: the repage window check keys off it, and a
        // lease recovery deliberately does NOT refresh it.
        pagedAt: { S: new Date().toISOString() },
        // TEAM-4663 phase 1 — see the two-phase claim block near claimKey().
        claimedAt: { N: String(Date.now()) },
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

// ─── Attempt / previous issue (TEAM-4660, tightened by TEAM-4671) ─────────────
// Nothing upstream counts review cycles: gate-state.mjs has no attempt counter
// (and its ledger is off by default), and the notification carries no
// attempt/reason field, which is why a release manager resorted to writing
// "(3×)" into the ticket TITLE. Both signals are therefore derived here, from
// data already on the wire, and no orchestrator field is invented — but only
// from evidence that a cycle actually concluded. An UNEVIDENCED guess is not
// rendered at all: this text tells a human "you rejected this before", so a
// false positive costs more than a missing line.
const GATE_REWORK_PREFIX = "gaterework#";

/** ms sort key for a review cycle: explicit timestamp, else the ISO minted into notif.id. */
function notifOrderKey(n) {
  const t = Date.parse(n?.timestamp || "");
  if (Number.isFinite(t)) return t;
  const m = String(n?.id || "").match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/);
  const fromId = m ? Date.parse(m[0]) : NaN;
  return Number.isFinite(fromId) ? fromId : null; // null → fall back to array position
}

const titlePrefix = (s) => oneLine(String(s || "").split(":")[0]).toLowerCase();

/**
 * Identity of the WORK a gate guards, from its title: everything before the
 * first " — " / " - " / "—". A release manager files one ticket per attempt at
 * the same target and appends the specifics ("Deploy gate: pipeline-a — PR
 * #593"), so two attempts at pipeline-a share a key while pipeline-b — a
 * DIFFERENT deploy running in parallel — does not. The old signal was the title
 * PREFIX alone ("deploy gate"), which made every gate in a multi-target run a
 * previous attempt at every other one.
 */
const GATE_KEY_SEP_RE = / — | - |—/;
const gateKey = (s) => oneLine(s).split(GATE_KEY_SEP_RE)[0].trim().toLowerCase();

/**
 * Both ack shapes the hub writes: the orchestrator sets `acknowledged: true`
 * (workflow-store.mjs ackNotifications, on approve AND on rejection), and the
 * escalations route additionally stamps `acknowledgedAt`.
 */
const notifAcked = (n) => n?.acknowledged === true || Boolean(n?.acknowledgedAt);

/** Bounded sibling lookups: one GetItem each, so cap the candidate set. */
const GATE_SIBLING_MAX = 5;

/**
 * Which review cycle is this, and why did the last one come back? Both are
 * derived from EVIDENCE only — a count we cannot evidence renders no attempt
 * line at all, because "Attempt 2 — previous issue: changes requested" in front
 * of a human who never rejected anything is worse than no line (TEAM-4671 F1).
 *
 * Two sources, both defensive — an unparseable row must never cost the ping:
 *  1. earlier ACKNOWLEDGED review_needed rows for the SAME gate ticket. The
 *     orchestrator mints a fresh notif per park and acks the old one when the
 *     review concludes either way (index.mjs ackApprovedGateNotification /
 *     handleReviewRejection), so an acked earlier row IS a concluded cycle.
 *     Ordered by timestamp, else by the id's ISO, else by array position.
 *  2. release-manager follow-ups, which are a NEW ticket per attempt rather
 *     than a re-park. A candidate is an earlier ticket in the same run with the
 *     same gate key; it only COUNTS if the bridge recorded a rejection against
 *     it (gaterework#<id>, written by the ❌ tap and overwritten with the
 *     delivered note). Ticket status is deliberately NOT evidence: a gate
 *     created with blockers sits in `blocked`, which is the "sibling still open
 *     in parallel" false positive, and a rejected-then-approved gate ends at
 *     `done` like any other.
 *
 * @returns {Promise<{attempt:number, previousIssue?:string}>}
 */
async function approvalAttempt({ wf, notif, tickets = [] }) {
  try {
    const all = Array.isArray(wf?.humanNotifications) ? wf.humanNotifications : [];
    const selfIdx = all.indexOf(notif);
    const selfKey = notifOrderKey(notif);
    let earlier = 0;
    all.forEach((n, i) => {
      if (!n || n === notif || i === selfIdx) return;
      if (n.id && notif.id && n.id === notif.id) return;
      if (n.type !== "review_needed" || n.ticketId !== notif.ticketId) return;
      if (!notifAcked(n)) return; // an open twin is a duplicate, not a past cycle
      const k = notifOrderKey(n);
      const before = k !== null && selfKey !== null ? k < selfKey : selfIdx >= 0 && i < selfIdx;
      if (before) earlier++;
    });

    // A gate with a review package is re-parked, never re-filed, so the sibling
    // count only applies to the package-less (release-manager-authored) case.
    const self = tickets.find((t) => t?.ticketId === notif.ticketId);
    const prefix = titlePrefix(self?.title);
    const key = gateKey(self?.title);
    const selfAt = Date.parse(self?.createdAt || "");
    let siblingReason;
    if (!notif.gate && key && prefix && GATE_TITLE_KINDS.has(prefix) && Number.isFinite(selfAt)) {
      const candidates = tickets
        .filter((t) => t && t.ticketId !== notif.ticketId && gateKey(t.title) === key)
        .map((t) => ({ ticketId: t.ticketId, at: Date.parse(t.createdAt || "") }))
        .filter((c) => Number.isFinite(c.at) && c.at < selfAt)
        .sort((a, b) => b.at - a.at) // newest first: the reason we quote is the latest
        .slice(0, GATE_SIBLING_MAX);
      for (const c of candidates) {
        const reason = await readGateRework(c.ticketId);
        if (!reason) continue; // no recorded rejection → not an evidenced attempt
        earlier++;
        if (!siblingReason) siblingReason = reason;
      }
    }

    const attempt = 1 + earlier;
    if (attempt < 2) return { attempt, previousIssue: undefined };
    // The gate's own row wins (a re-park's reason is about THIS ticket); the
    // latest evidenced sibling's is the fallback for the re-filed case.
    return { attempt, previousIssue: (await readGateRework(notif.ticketId)) || siblingReason };
  } catch {
    return { attempt: 1, previousIssue: undefined };
  }
}

/**
 * Remember WHY a gate came back, so the next page can say it in one line. The
 * note lives in a ticket comment, and neither ticket provider puts comments on
 * the /tickets wire, so the bridge records what it delivered itself. Overwrites:
 * the latest rejection is the one the next attempt has to answer.
 */
async function recordGateRework(ticketId, reason) {
  if (!ticketId) return;
  try {
    await ddb.send(new PutItemCommand({
      TableName: PENDING_TABLE,
      Item: {
        id: { S: `${GATE_REWORK_PREFIX}${ticketId}` },
        reason: { S: clipText(oneLine(reason) || "changes requested", APPROVAL_REASON_MAX) },
        at: { S: new Date().toISOString() },
        ttl: { N: String(Math.floor(Date.now() / 1000) + 30 * 86400) },
      },
    }));
  } catch (err) {
    console.warn(`[telegram-bug-intake] rework reason for ${ticketId} not recorded:`, err.message);
  }
}

/** Best-effort: a missing row just means the Attempt line carries no reason. */
async function readGateRework(ticketId) {
  if (!ticketId) return undefined;
  try {
    const { Item } = await ddb.send(new GetItemCommand({
      TableName: PENDING_TABLE, Key: { id: { S: `${GATE_REWORK_PREFIX}${ticketId}` } },
    }));
    return Item?.reason?.S || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A ❌ that never became a rejection is not evidence. The placeholder written by
 * the tap (recordGateRework below) must not outlive the cycle: an approved gate,
 * or a dropped undelivered note, would otherwise read to approvalAttempt as an
 * evidenced previous attempt and page the next same-target gate with a verdict
 * the human never gave (TEAM-4671's invariant). Best-effort, like the rej#
 * marker deletes: a failed retraction must not cost the tap its answer.
 */
async function deleteGateRework(ticketId) {
  if (!ticketId) return;
  try {
    await ddb.send(new DeleteItemCommand({
      TableName: PENDING_TABLE, Key: { id: { S: `${GATE_REWORK_PREFIX}${ticketId}` } },
    }));
  } catch (err) {
    console.warn(`[telegram-bug-intake] rework reason for ${ticketId} not cleared:`, err.message);
  }
}

/**
 * The one answer for "the gate's type could not be verified". No transition, no
 * ledger row, no pipeline call, and the keyboard is left in place — the tap is
 * the retry. Deliberately says nothing about approve/reject: the bridge does not
 * know which kind of gate it is looking at, which is the whole point.
 */
async function answerGateUnverifiable(cb, ticketId) {
  console.warn(`[telegram-bug-intake] gate ${ticketId}: could not verify gate type — nothing was touched`);
  await tgAnswer(cb.id, "Could not verify gate type, retry.").catch(() => {});
}

// How much of the hub's refusal text the stuck-gate edit carries. Enough to name
// the condition, short enough that the three sentences around it stay readable.
const GATE_STUCK_DETAIL_MAX = 300;

/**
 * The one answer for "the PIPELINE is decided and the ticket is not" (TEAM-4751
 * C1). The generic "⚠️ Failed to process" is a lie on this path: it reads as
 * "nothing happened" about the single write that cannot be undone, and it sends
 * the human — who just approved — off to the console the gate comment names.
 *
 * So say exactly what landed, what did not, and that a re-tap costs no second
 * approval: `wasGateApprovedLocally` → DEPLOY_GATE_ALREADY is what guarantees
 * that (SEC-8/SEC-9). The keyboard is preserved so the re-tap is possible, and
 * the text deliberately avoids gateFromReply's routing vocabulary ("REVIEW
 * GATE" / "SHIP-REVIEW ESCALATION" / "Changes requested") so a reply to it is
 * not laundered into a rework note. Never throws, never rethrows.
 */
async function answerDeployGateTicketStuck(cb, chatId, ticketId, err) {
  console.error(`[telegram-bug-intake] gate ${ticketId}: deploy decided but the ticket did not close`, err?.message);
  const detail = clipText(redactText(String(err?.detail || err?.message || "")), GATE_STUCK_DETAIL_MAX);
  await tgAnswer(cb.id, `Deploy approved — ${ticketId} still open.`).catch(() => {});
  const body =
    `${cb.message.text}\n\n` +
    `✅ The deploy IS approved on the pipeline — it is resuming.\n` +
    `⚠️ ${esc(ticketId)} could not be marked done yet: ${esc(detail)}\n` +
    `Tap ✅ again to finish the ticket only — the pipeline will not be approved twice.`;
  await tgEdit(chatId, cb.message.message_id, body.slice(0, 4000),
    cb.message.reply_markup ? { reply_markup: cb.message.reply_markup } : {}).catch(() => {});
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
    // TEAM-4706: on a gate:deploy-approval ticket the PIPELINE moves first —
    // this ✅ used to transition Jira only, leaving CodePipeline parked (a
    // release stalled 29h on 2026-09-14). One fetch, and it never throws; an
    // unlabelled gate reaches not one CodePipeline call and behaves as before.
    const { gateTicket: approving, indeterminate } = await gateTicketOf({ workflowId }, { ticketId });
    // Could not read the ticket → could not read its LABELS, so we cannot tell a
    // deploy-approval gate from a plain one. Falling through would transition a
    // deploy gate while CodePipeline stayed parked — the exact 29h stall. Touch
    // nothing and let the human tap again.
    if (indeterminate) return await answerGateUnverifiable(cb, ticketId);
    let res = null;
    // TEAM-4753 N1: the pre-read above ALREADY says whether this gate is closed,
    // and an already-`done` gate has no half left to run. WP2's typed-gate guard
    // is what makes that conclusive: a `gate:deploy-approval` ticket cannot reach
    // `done` unless the pipeline's own approval was verified. Firing either half
    // anyway lies in both directions — decideDeployGate finds no waiting action
    // and reports "Could not approve the deploy", and the close comes back
    // done→done and reports "could not be marked done yet — tap ✅ again",
    // forever, on every re-tap. Fall through to the same ✅ artefact the lost or
    // earlier tap produced: no PutApprovalResult, no transition POST.
    if (!isTicketDone(approving)) {
      const deploy = await deployApprovalGate(approving);
      // Only `failed` stops the ticket half: it already answered + edited the
      // message, and the ticket stays put so the human can tap again once the
      // cause is fixed. `alreadyResolved` means the pipeline is where the human
      // wants it, so the ticket must still move (SEC-8).
      const decided = deploy ? await decideDeployGate(cb, chatId, ticketId, deploy, true, workflowId) : null;
      if (decided === DEPLOY_GATE_FAILED) return;
      if (decided) {
        // TEAM-4751 C1: a pipeline decision LANDED (`decided` or `alreadyResolved`),
        // so the ticket half is all that is left — and it must not be surfaced as a
        // total failure. WP2's guard reads CodePipeline ONCE with no tolerance, so
        // the close we fire immediately after our own PutApprovalResult can still
        // see the Approval action InProgress and be refused. Retry that refusal;
        // on a real one, say what is true rather than "⚠️ Failed to process".
        const out = await transitionGateAfterDecision(
          workflowId, ticketId, "done", `Approved via Telegram by chat ${chatId}`);
        if (out.error) return await answerDeployGateTicketStuck(cb, chatId, ticketId, out.error);
        res = out.res;
      } else {
        // A plain gate: no irreversible write preceded this tap, so a refusal is
        // still allowed to throw to the update loop exactly as it always has.
        res = await transitionGate(workflowId, ticketId, "done", `Approved via Telegram by chat ${chatId}`);
      }
    }
    // A ❌ tapped by mistake before this ✅ left a marker that would turn the
    // chat's next message into a rework note for a gate that is now done.
    const stale = await getPendingRejection(chatId);
    if (stale?.ticketId === ticketId) await deletePendingRejection(chatId);
    // …and the ❌'s rework row, so a later gate at the same target is not paged
    // with a "previous issue" for a cycle the human APPROVED (TEAM-4675).
    await deleteGateRework(ticketId);
    await tgAnswer(cb.id, `Approved ${ticketId}`);
    // TEAM-3971: the API records a bare approve on an escalation gate as
    // DECISION: merge-with-known-findings — say so, the human should know.
    const note = res?.decisionDefaulted
      ? `✅ Approved — recorded as DECISION: ${res.decisionDefaulted}; release manager resuming.`
      : `✅ Approved — pipeline resuming.`;
    await tgEdit(chatId, cb.message.message_id, `${cb.message.text}\n\n${note}`);
    return;
  }
  // ✅ then ❌ in the same batch (both callbacks land before the ✅ edit drops the
  // keyboard): gok already moved the gate to done, so writing the placeholder
  // again would hand approvalAttempt rejection evidence for a cycle the human
  // APPROVED (TEAM-4677). Ask the hub rather than a local marker — a gate
  // approved from the board counts too. TEAM-4675's deleteGateRework in the gok
  // branch above covers the reverse order.
  //
  // An UNREADABLE tickets view is not "not done": the labels are unreadable too,
  // so a deploy gate here would be rejected as a plain gate and CodePipeline
  // would stay parked. Touch nothing (SEC-8/gateTicketOf) — a rejection is not
  // lost, it is retried by the same buttons.
  const { gateTicket, indeterminate: unreadable } = await gateTicketOf({ workflowId }, { ticketId });
  if (unreadable) return await answerGateUnverifiable(cb, ticketId);
  if (isTicketDone(gateTicket)) {
    // No tgEdit: the ✅ edit already states the truth, and this branch's edit
    // text carries "Changes requested" — gateFromReply's routing vocabulary.
    await tgAnswer(cb.id, "Already approved — nothing to reject.");
    return;
  }
  // TEAM-4706: on a deploy-approval gate the pipeline is STOPPED first, from the
  // fetch above (no second call), and only then does the ticket half run. A
  // failed rejection leaves the ticket untouched, exactly like the ✅ path.
  const rejecting = await deployApprovalGate(gateTicket);
  // TEAM-4781: `failed` now also covers "the pipeline took the ❌ but the SEC-1
  // marker did not land" — the rework plumbing below must not run then either, or
  // the gate leaves `in_review` with nothing left to retry the marker.
  if (rejecting && (await decideDeployGate(cb, chatId, ticketId, rejecting, false, workflowId)) === DEPLOY_GATE_FAILED) return;
  // Request changes: the ticket needs a rework note. Park the intent; the
  // chat's next plain message — or a reply to this ping, any time — becomes
  // the note (resolveReworkTarget → deliverReworkNote).
  await putPendingRejection(chatId, ticketId, workflowId);
  // Placeholder reason NOW, so the re-park page carries an Attempt line even if
  // the note never arrives; deliverReworkNote overwrites it with the real note,
  // and ✅ / 🗑 Drop retract it — an unrejected cycle is not evidence (TEAM-4675).
  await recordGateRework(ticketId, "changes requested");
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
  // The note IS the previous issue for whatever this gate becomes next cycle.
  await recordGateRework(ticketId, text);
  await deletePendingRejection(chatId);
  await tgSend(chatId, `❌ *${esc(ticketId)}* — changes requested. Your note is on the ticket; upstream work re-opens for rework.`);
  return true;
}

// Parked-note buttons: rjr|<ticketId>|<workflowId> re-sends the saved note;
// rjx|<ticketId> drops it (the gate stays parked on the human either way).
async function handleReworkRetryCallback(cb, chatId, action, ticketId, workflowId) {
  if (action === "rjx") {
    await deletePendingRejection(chatId);
    // The note was never delivered (deliverReworkNote threw before recording it),
    // so the ❌'s placeholder is all that is left and it evidences nothing.
    await deleteGateRework(ticketId);
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
    // TEAM-4753 N1: the close we are asking for is already the ticket's state.
    // That is not a failure of a ✅ — it IS the ✅ that already landed (a lost
    // response, two taps racing, or the human tapping again). Every `done`
    // caller gets this, which is the point: the same tap used to be reported as
    // "could not be marked done yet" here and as "⚠️ Failed to process" from
    // handleDecisionCallback.
    if (targetStatus === "done" && isAlreadyDoneRefusal(res.status, detail)) {
      console.log(`[telegram-bug-intake] ${ticketId} is already done — treating the close as landed: ${detail}`);
      return { alreadyDone: true };
    }
    const err = new Error(`transition ${res.status}: ${detail}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  // Body is informational (e.g. decisionDefaulted, TEAM-3971) — never required.
  try { return await res.json(); } catch { return {}; }
}

// WP2's typed-gate guard refused the close. The hub route surfaces the ticket
// Lambda's refusal TEXT only (src/app/api/workflow/[id]/tickets/transition/
// route.ts sends `details: gateRefusal().message`), never the machine reason —
// so the match is on the message gateRefusal() builds ("…its `gate:<kind>`
// condition is not met. <hint>"). `gate_condition_unmet` is the defensive arm
// for the day the route starts forwarding `payload.reason` as well.
const GATE_GUARD_REFUSAL_RE = /condition is not met|gate_condition_unmet/i;

/**
 * Is this a RETRYABLE typed-gate refusal, as opposed to a real 409? A refusal is
 * a lagging read; "No transition to \"Done\" found" is an answer, and a 5xx is
 * neither. Both of those must fail fast.
 */
function isGateGuardRefusal(err) {
  return err?.status === 409 && GATE_GUARD_REFUSAL_RE.test(String(err?.detail ?? err?.message ?? ""));
}

// TEAM-4753 N1 — the two phrasings a done→done can come back as. The bridge
// talks to the HUB ROUTE, not to the twins, so which layer answers first depends
// on the provider:
//
//   dynamodb  the route's own pre-check answers, and it is a 400 with the reason
//             in `error`: "Invalid transition from done to done"
//             (src/app/api/workflow/[id]/tickets/transition/route.ts,
//             VALID_TRANSITIONS.done = ["todo"]).
//   the twin  409 with the reason in `details`: 'Invalid transition "done" from
//             status "done". Available: …' (lambda/agentcore-hub-tickets
//             transitionIssue) — reachable if the route ever stops pre-checking.
//
// The trailing "Available: …" list is deliberately not part of either match.
// Jira's own refusal ('No transition to "Done" found. Available: …',
// lambda/agentcore-hub-jira) is deliberately NOT here and stays a failure: it is
// the SAME text a genuinely stuck, not-done ticket produces, so it proves
// nothing about the current status. The gok branch's pre-read short-circuit is
// what covers that provider — it fires before any POST.
const ALREADY_DONE_RES = [
  /Invalid transition\s+"?done"?\s+from status\s+"?done"?/i,
  /Invalid transition from\s+"?done"?\s+to\s+"?done"?/i,
];

/**
 * Is this refusal "the close you asked for is already the ticket's state"? The
 * caller gates on `targetStatus === "done"` as well, so a rework note's
 * done→blocked refusal (deliverReworkNote) can never be read as a success.
 */
function isAlreadyDoneRefusal(status, detail) {
  return (status === 409 || status === 400) &&
    ALREADY_DONE_RES.some((re) => re.test(String(detail ?? "")));
}

// 4 attempts ⇒ 3 sleeps at _deployGateRetryMs ≈ 30s, the same budget
// decideDeployGate already spends waiting for a superseded build to clear the
// gate — so the invocation's tolerance for this callback is unchanged.
export const DEPLOY_GATE_TRANSITION_TRIES = 4;

/**
 * Transition a gate whose PIPELINE decision has ALREADY landed (TEAM-4751 C1).
 *
 * Never throws: the caller must not let the top-level "⚠️ Failed to process"
 * become the surface for a deploy that IS approved. Retries ONLY the guard's
 * lagging-read refusal — the decision ledger row (`approved#<ticketId>`) is
 * written before the pipeline call, so a retried close is idempotent — and
 * treats every other failure as final.
 *
 * @returns {Promise<{res: object|null, error: Error|null, attempts: number, refusals: number}>}
 */
async function transitionGateAfterDecision(workflowId, ticketId, targetStatus, comment) {
  let refusals = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await transitionGate(workflowId, ticketId, targetStatus, comment);
      return { res, error: null, attempts: attempt, refusals };
    } catch (err) {
      if (!isGateGuardRefusal(err) || attempt >= DEPLOY_GATE_TRANSITION_TRIES) {
        return { res: null, error: err, attempts: attempt, refusals };
      }
      refusals++;
      console.warn(`[telegram-bug-intake] gate ${ticketId}: the gate guard refused the close (attempt ${attempt}/${DEPLOY_GATE_TRANSITION_TRIES}) — ${err.detail || err.message}`);
      await sleep(_deployGateRetryMs);
    }
  }
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
 * The dead-session page's inputs for buildApprovalMessage. Legacy rows (the
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
  return {
    gateKind: "dead-session",
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
  };
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
    const escKey = `${ESC_KEY_PREFIX}${notif.id}`;
    // TEAM-4663, same rule as review gates: a claim with no deliveredAt older
    // than the lease was stranded before its ping, and an open escalation PARKS
    // the run — so a stranded claim here is the 9h TEAM-3938 stall with nobody
    // paged. No TTL fallback: pre-upgrade rows are not recovery-eligible.
    const mode = (await claimKey(escKey))
      ? "first"
      : await consultClaimForRecovery(escKey, { label: "manager escalation" });
    if (!mode) continue;

    // Same claim-before-delivery contract as review gates: any throw before a
    // delivered ping must release a FIRST claim or this escalation stays silent.
    // A recovery keeps the row — its lease was just refreshed, so the next scan
    // past PING_LEASE_MS retries.
    try {
      chats = chats || (await listChats()).filter((c) => ALLOWED_CHAT_IDS.includes(String(c)));
      if (!chats.length) {
        console.warn("[telegram-bug-intake] manager escalation but no allowlisted chats to notify");
        if (mode === "first") await releaseKey(escKey);
        continue;
      }

      const details = String(notif.details || notif.message || "").trim();
      const clipped = details.length > ESC_DETAIL_MAX ? `${details.slice(0, ESC_DETAIL_MAX)}…` : details;
      const msg = DEAD_SESSION_REVIEWERS.has(String(notif.reviewer || ""))
        ? deadSessionPing(wf, notif, clipped)
        : {
            gateKind: "manager",
            subject: wf.input?.title || wf.workflowId,
            summary: clipped,
            meta: ["⏸ run parked until you resolve"],
            ask: "Tap Resolved once handled — the watch scheduler skips this run while the escalation is open.",
          };
      // The keyboard + claim keys are deliberately IDENTICAL for both shapes:
      // resolving is the same action whichever page you are looking at.
      const keyboard = { inline_keyboard: [
        [{ text: "✅ Resolved — resume watching", callback_data: `eok|${wf.workflowId}` }],
        [{ text: "📱 Open run in hub", url: `${HUB_API_URL}/workflow?id=${encodeURIComponent(wf.workflowId)}` }],
      ] };

      const { delivered, messageIds } = await sendApprovalPing(chats, { ...msg, label: "escalation", keyboard });
      // A FIRST claim with nothing delivered is dropped so the next scan retries;
      // a RECOVERY keeps its (now fresh) lease and retries past PING_LEASE_MS.
      if (!delivered) { if (mode === "first") await releaseKey(escKey); }
      // Phase 2, best-effort for the same reason as the gate path.
      else await markPingDelivered(escKey, { pingCount: 1, messageIds }).catch((err) =>
        console.error("[telegram-bug-intake] markPingDelivered (escalation)", err.message));
    } catch (err) {
      if (mode === "first") {
        await releaseKey(escKey).catch((relErr) =>
          console.error("[telegram-bug-intake] releaseKey after escalation failure", relErr.message));
      }
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
      Item: {
        id: { S: id },
        ttl: { N: String(Math.floor(Date.now() / 1000) + 30 * 86400) },
        // TEAM-4663 phase 1 of the two-phase claim: when this row was taken. The
        // matching deliveredAt is written only once a send is CONFIRMED, so an
        // invocation that dies in between leaves a row that can be told apart
        // from a delivered one and re-taken past the lease.
        claimedAt: { N: String(Date.now()) },
      },
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

// ─── Two-phase claim: claim, then PROVE delivery (TEAM-4663) ─────────────────
// Every ping path claims a dedupe row BEFORE it sends — that row is what makes
// "ping exactly once" true. But the claim on its own records nothing about
// delivery, so an invocation killed between the PutItem and the send strands the
// row, and every later scan bails on "already claimed": the page is silently
// parked for the row's whole TTL (7 days for a production deploy gate, 30 for a
// review gate). TEAM-4663 was 8h45m of an unpinged prod deploy behind exactly
// that.
//
// Phase 2 closes it. `claimedAt` goes on the row at claim time; `deliveredAt`
// (plus lastPingAt/pingCount/messageIds) only after a send is confirmed. A claim
// with no deliveredAt older than PING_LEASE_MS is re-takeable, so the next scan
// re-sends instead of returning. These primitives are id-keyed and deliberately
// path-agnostic — dep#, gate# and esc# all use them.

async function getClaimRow(id) {
  const { Item } = await ddb.send(new GetItemCommand({
    TableName: PENDING_TABLE, Key: { id: { S: id } },
  }));
  return Item || null;
}

/**
 * When this claim/lease was taken, in ms — or null when that cannot be
 * established. `ttlFallbackSec` is the row's TTL HORIZON (the row's ttl is claim
 * time + horizon), and passing it is what makes a PRE-UPGRADE row — written
 * before this change, so carrying no claimedAt — recovery-eligible.
 *
 * Whether a path passes it is a real policy decision, not a detail:
 *   dep#         passes the 7-day horizon, so the row stranded by the incident
 *                this fixes gets its one recovery ping when the fix deploys.
 *   gate#, esc#  pass nothing, so a pre-upgrade row is ineligible and the deploy
 *                of this fix cannot re-page every currently-open gate.
 */
function claimedAtOf(row, ttlFallbackSec = null) {
  const claimedAt = Number(row?.claimedAt?.N);
  if (Number.isFinite(claimedAt) && claimedAt > 0) return claimedAt;
  if (ttlFallbackSec == null) return null;
  const ttl = Number(row?.ttl?.N);
  if (!Number.isFinite(ttl) || ttl <= 0) return null;
  return (ttl - ttlFallbackSec) * 1000;
}

/**
 * Take over an undelivered claim: refresh claimedAt so THIS invocation owns the
 * lease. Conditional, so two pollers can never both re-send — and it refuses
 * outright once deliveredAt exists, which is what stops a lease re-take from
 * re-paging a human who already has the message. False = someone else won.
 */
async function retakeLease(id, seenClaimedAt, now) {
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: PENDING_TABLE,
      Key: { id: { S: id } },
      UpdateExpression: "SET claimedAt = :now",
      ConditionExpression:
        "attribute_exists(id) AND attribute_not_exists(deliveredAt) AND (claimedAt = :seen OR attribute_not_exists(claimedAt))",
      ExpressionAttributeValues: {
        ":now": { N: String(now) },
        ":seen": { N: String(seenClaimedAt) },
      },
    }));
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/**
 * Phase 2: at least one chat confirmed the send. deliveredAt is if_not_exists so
 * it keeps meaning "when the human FIRST had it" across reminders; lastPingAt /
 * pingCount move. Best-effort at every call site: losing this write costs at
 * most one duplicate page a lease later, whereas treating it as fatal would
 * release a claim whose ping already landed.
 */
async function markPingDelivered(id, { now = Date.now(), pingCount = 1, messageIds = [] } = {}) {
  await ddb.send(new UpdateItemCommand({
    TableName: PENDING_TABLE,
    Key: { id: { S: id } },
    UpdateExpression:
      "SET deliveredAt = if_not_exists(deliveredAt, :now), lastPingAt = :now, pingCount = :n, messageIds = :m",
    ExpressionAttributeValues: {
      ":now": { N: String(now) },
      ":n": { N: String(pingCount) },
      ":m": { S: JSON.stringify(messageIds.slice(0, 20)) },
    },
  }));
}

/**
 * Claim the right to send reminder #nextCount, conditional on nobody else having
 * moved the counter. Reserved concurrency is 1 today, so this is belt and braces
 * — but a reminder that double-fires is a page a human already read, and the
 * condition costs nothing. False = another invocation took this slot.
 */
async function takeReminderSlot(id, { seenLastPingAt, seenCount, nextCount, now }) {
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: PENDING_TABLE,
      Key: { id: { S: id } },
      UpdateExpression: "SET lastPingAt = :now, pingCount = :next",
      ConditionExpression: "lastPingAt = :seen AND pingCount = :seenCount",
      ExpressionAttributeValues: {
        ":now": { N: String(now) },
        ":next": { N: String(nextCount) },
        ":seen": { N: String(seenLastPingAt) },
        ":seenCount": { N: String(seenCount) },
      },
    }));
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/**
 * The ONE recovery rule, called whenever a claim's conditional Put loses: does
 * this existing row prove a ping was delivered, or was it stranded? Returns
 * "recovery" (the lease is now ours — re-send) or null (leave it alone).
 *
 * `row` may be passed in by a caller that already read it, so consulting costs
 * one GetItem per scan and not two.
 */
async function consultClaimForRecovery(id, { ttlFallbackSec = null, label = "ping", row = undefined } = {}) {
  const claim = row === undefined ? await getClaimRow(id) : row;
  if (!claim) return null;                  // TTL'd or actioned between reads
  if (claim.deliveredAt?.N) return null;    // a human has the page
  const claimedAt = claimedAtOf(claim, ttlFallbackSec);
  if (claimedAt == null) return null;       // pre-upgrade row (see claimedAtOf)
  const now = Date.now();
  if (now - claimedAt < PING_LEASE_MS) return null;   // a send may be in flight
  if (!(await retakeLease(id, claimedAt, now))) return null;
  console.warn(`[telegram-bug-intake] ${label} ping never confirmed — re-sending`, id);
  return "recovery";
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
// The claim row's TTL horizon. Also the fallback used to date a PRE-TEAM-4663
// row, whose ttl IS claim time + this (claimedAtOf).
const DEPLOY_CLAIM_TTL_SEC = 7 * 86400;
// A DELIVERED deploy ping still waiting on a human earns a bounded re-page: the
// approval is an irreversible prod act and the pipeline is stopped on it, so
// "the human scrolled past it" must not be a 7-day silence either. Bounded on
// purpose — nagging a reviewer forever trains them to ignore the bot.
const DEPLOY_REPING_INTERVAL_MS = parseInt(process.env.DEPLOY_REPING_INTERVAL_MS || "7200000", 10);
const DEPLOY_REPING_MAX = parseInt(process.env.DEPLOY_REPING_MAX || "6", 10);

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
      // null on a same-account entry → ambient creds; set only for a validated
      // cross-account triple, so the poller/callback assume the trigger role.
      roleArn: projects.roleArn || null,
      externalId: projects.externalId || null,
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

/** "8h 45m" / "12m" — how long a human has kept a prod deploy waiting. */
function formatPending(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.floor(ms / 60_000);
  const h = Math.floor(mins / 60);
  return h ? `${h}h ${mins % 60}m` : `${mins}m`;
}

async function scanDeployApprovalsForTarget(target) {
  // One client for the whole scan: the state read AND the commit lookup must go
  // to the same account, which for a cross-account target means the same assumed
  // hub-cd-trigger role (#611). Building a second, bare client for the commit
  // lookup is how that read silently AccessDenies on every registered repo whose
  // pipeline lives elsewhere.
  const cp = codepipelineFor(target.region, target.roleArn, target.externalId);
  let state;
  try {
    state = await cp.send(new GetPipelineStateCommand({ name: target.pipeline }));
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
  for (const stage of state.stageStates || []) {
    for (const action of stage.actionStates || []) {
      const token = action.latestExecution?.token;
      const status = action.latestExecution?.status;
      if (token && status === "InProgress") {
        pending = { stageName: stage.stageName, actionName: action.actionName, token,
          revisionUrl: action.entityUrl || action.revisionUrl,
          // WHICH execution is parked here. The stage carries it; the action
          // does not. Everything about the commit hangs off this (D3).
          executionId: stage.latestExecution?.pipelineExecutionId || null };
        break;
      }
    }
    if (pending) break;
  }
  if (!pending) return;

  // Claim on the pipeline + token: a new pipeline execution mints a fresh token,
  // so this naturally re-pings each run while never double-pinging the same wait.
  // A LOST claim is no longer the end of it (TEAM-4663) — the existing row is
  // consulted, because "someone claimed this" used to be indistinguishable from
  // "a human was actually paged".
  const key = deployClaimKey(pending, target);
  const claimed = await claimDeployApproval(pending, target, key);
  const mode = claimed
    ? { kind: "first" }
    : await decideDeployPingMode(`${DEPLOY_KEY_PREFIX}${key}`);
  if (!mode) return;

  try {
    const chats = (await listChats()).filter((c) => ALLOWED_CHAT_IDS.includes(String(c)));
    if (!chats.length) {
      console.warn("[telegram-bug-intake] deploy approval but no allowlisted chats to notify");
      if (mode.kind === "first") await releaseDeployApproval(key);
      return;
    }

    // The commit THIS execution would ship (never the newest one in the
    // pipeline — GetPipelineState reports a revision per STAGE, so with two
    // executions in flight the Source stage's revision belongs to the newer one,
    // and quoting it would describe the run BEHIND this gate to a human about to
    // irreversibly ship). Then what's in it: subject, PR title/epic/summary, file
    // scope. Best-effort at both steps — an unresolved commit or a GitHub hiccup
    // degrades the ping to the terse body, which still carries working buttons.
    const commitSha = await executionRevision(cp, state, target.pipeline, pending.executionId);
    const brief = await buildDeployBrief(commitSha, target.repo).catch((e) => {
      console.warn("[telegram-bug-intake] deploy brief enrich failed:", e.message);
      return null;
    });

    const deployAsk =
      "This is the irreversible production deploy — the merge is already approved. " +
      "Approve to ship, or Reject to stop.";
    const isReminder = mode.kind === "reminder";
    // Which pipeline, and which REPO's pipeline: with several registered repos a
    // bare pipeline name is not enough for a human to know what they are
    // shipping. The execution id is what lets them find it in the console — and
    // what proves WHICH of two in-flight runs this ping is about.
    const meta = [`🏷 ${esc(target.pipeline)}`];
    if (target.repo) meta.push(`📦 ${esc(target.repo)}`);
    if (pending.executionId) meta.push(`🆔 ${esc(String(pending.executionId).slice(0, 8))}`);
    if (isReminder) {
      const pendingFor = formatPending(mode.pendingMs);
      meta.push(`⏳ ${pendingFor ? `Pending ${pendingFor} · ` : ""}reminder ${mode.n} of ${DEPLOY_REPING_MAX}`);
    }
    const fallbackSummary = isReminder
      ? "This deploy is still parked on your approval — the pipeline cannot proceed without it."
      : "The build passed every gate and is waiting on you to ship it to prod.";
    // Both shapes go through the same builder as every other approval ping
    // (TEAM-4660) — this path was already templated, so only the seam changes.
    // The reminder is its own kind rather than the `repage` modifier: `repage`
    // renders "business-hours reminder", which a 2-hourly nag is not.
    const gateKind = isReminder ? "deploy-pipeline-reminder" : "deploy-pipeline";
    const msg = brief
      ? {
          gateKind,
          subject: brief.prTitle || brief.commitSubject || target.pipeline,
          summary: brief.summary || (isReminder ? fallbackSummary : ""), // one-line what/why from the PR body
          bullets: [
            brief.workflowLine,                               // "Workflow: TEAM-3721 (bug-fix)"
            brief.scopeLine,                                  // "Scope: 8 files (+147/-4)"
            brief.commitLine && brief.commitLine.replace(/`/g, ""), // "Commit: a1b2c3d"
          ].filter(Boolean),
          meta,
          ask: deployAsk,
        }
      : {
          gateKind,
          subject: target.pipeline,
          summary: fallbackSummary,
          meta,
          ask: deployAsk,
        };

    const rows = [[
      { text: "🚀 Approve deploy", callback_data: `dok|${key}` },
      { text: "🛑 Reject", callback_data: `dno|${key}` },
    ]];
    const linkRow = [];
    if (brief?.prUrl) linkRow.push({ text: "🔗 View PR", url: brief.prUrl });
    if (pending.revisionUrl) linkRow.push({ text: "🔗 View commit", url: pending.revisionUrl });
    else if (brief?.commitUrl) linkRow.push({ text: "🔗 View commit", url: brief.commitUrl });
    if (linkRow.length) rows.push(linkRow);
    const keyboard = { inline_keyboard: rows };

    const { delivered, messageIds } = await sendApprovalPing(chats, {
      ...msg, label: "deploy approval", keyboard,
    });
    if (delivered) {
      // pingCount 1 == the original ping; a reminder advances it. Best-effort:
      // see markPingDelivered. On a reminder the slot was already consumed by
      // takeReminderSlot, so a failure here costs a repeat, not a lost bound.
      await markPingDelivered(`${DEPLOY_KEY_PREFIX}${key}`, {
        pingCount: isReminder ? mode.n + 1 : 1, messageIds,
      }).catch((err) => console.error("[telegram-bug-intake] markPingDelivered (deploy)", err.message));
    } else if (mode.kind === "first") {
      // Nobody got it and we created the row — drop it so the next scan (60s)
      // retries immediately rather than waiting out a lease.
      await releaseDeployApproval(key);
    } else if (mode.kind === "recovery") {
      // Keep the row: the lease is ours and now fresh, so the next scan past
      // PING_LEASE_MS tries again — indefinitely, while the approval is pending.
      // This is the invariant-critical path; it must never go quiet.
      console.error(`[telegram-bug-intake] deploy approval re-send still undelivered for ${target.pipeline} — retrying after the lease`);
    } else {
      // A reminder that failed: the slot is burned and the next one is an
      // interval away. Deliberate — the original ping DID land, and rolling the
      // counter back would need a second conditional write to buy very little.
      console.error(`[telegram-bug-intake] deploy approval reminder ${mode.n} undelivered for ${target.pipeline}`);
    }
  } catch (err) {
    if (mode.kind === "first") {
      await releaseDeployApproval(key).catch((relErr) =>
        console.error("[telegram-bug-intake] releaseDeployApproval after failure", relErr.message));
    }
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
 * the file scope (count + additions/deletions). Each GitHub lookup is
 * best-effort and independently caught, so a failing API returns a PARTIAL
 * brief: commitLine/commitUrl are seeded from the SHA alone and are all the
 * caller gets. Returns null — the caller's terse message — only when no commit
 * SHA is known, or the target's repo path is unsafe.
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
 * The claim key for one pipeline wait — a short, callback_data-safe hash of the
 * target + the approval TOKEN (the token alone can exceed Telegram's 64-byte
 * callback_data budget; it stays in the DDB item). Hashing the PIPELINE in means
 * two targets can never collide on one claim row, whatever their tokens look
 * like. Split out of claimDeployApproval by TEAM-4663: the caller needs the key
 * even when the claim LOSES, to consult the existing row.
 *
 * MIGRATION (TEAM-4347): before TEAM-4338 the key was hash(token) alone, and that
 * code watched exactly ONE pipeline — DEPLOY_PIPELINE_NAME. So legacy-shaped rows
 * can only ever exist for that pipeline; keeping the legacy shape for it means an
 * approval already paused on the gate when this zip lands still hashes to the row
 * that claimed it, instead of claiming a second row and pinging twice. Matching on
 * the pipeline NAME (not on "came from the env fallback") is deliberate: the hub is
 * normally in the registry too, so its target is a REGISTRY target that happens to
 * name DEPLOY_PIPELINE_NAME — the exact configuration the double-ping would hit.
 */
function deployClaimKey(pending, target) {
  return DEPLOY_PIPELINE_NAME && target.pipeline === DEPLOY_PIPELINE_NAME
    ? `dp${hashToken(pending.token)}`
    : `dp${hashToken(`${target.pipeline} ${pending.token}`)}`;
}

/**
 * Atomically claim a deploy approval for notification, keyed by deployClaimKey().
 * Returns { key, ... } on first claim, false if the row already exists. The DDB
 * row stores the pipeline/region/repo/stage/action/token the button callback
 * needs, since callback_data can't carry the token itself — plus, since
 * TEAM-4663, claimedAt (phase 1) and the executionId the wait belongs to.
 */
async function claimDeployApproval(pending, target, key) {
  try {
    await ddb.send(new PutItemCommand({
      TableName: PENDING_TABLE,
      Item: {
        id: { S: `${DEPLOY_KEY_PREFIX}${key}` },
        pipelineName: { S: target.pipeline },
        // The region to send PutApprovalResult to. Claim rows written before
        // TEAM-4338 have no region; the callback falls back to DEFAULT_REGION.
        region: { S: target.region },
        // Cross-account trigger role for the callback's PutApprovalResult; absent
        // on same-account rows (and on legacy rows), which approve with ambient creds.
        ...(target.roleArn ? { roleArn: { S: target.roleArn } } : {}),
        ...(target.externalId ? { externalId: { S: target.externalId } } : {}),
        ...(target.repo ? { repo: { S: target.repo } } : {}),
        stageName: { S: pending.stageName },
        actionName: { S: pending.actionName },
        token: { S: pending.token },
        ttl: { N: String(Math.floor(Date.now() / 1000) + DEPLOY_CLAIM_TTL_SEC) },
        // TEAM-4663 phase 1 (see the two-phase claim block near claimKey), plus
        // WHICH execution is waiting — the ping quotes it so a human can
        // correlate with the console, and it is what makes the commit
        // attribution execution-aware rather than "the newest Source revision".
        claimedAt: { N: String(Date.now()) },
        ...(pending.executionId ? { executionId: { S: pending.executionId } } : {}),
      },
      ConditionExpression: "attribute_not_exists(id)",
    }));
    return { key, ...pending };
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/**
 * A claim row already exists for this wait — so what, if anything, do we send?
 *   null                  nothing (a delivered ping inside its reminder window,
 *                         a live lease, or an exhausted reminder budget)
 *   {kind:"recovery"}     the row proves NOTHING was ever delivered and its lease
 *                         expired — re-send the full ping (lease now ours)
 *   {kind:"reminder", n}  a delivered ping the human hasn't actioned and the
 *                         interval has passed — send reminder n of the budget
 * Reminders are deploy-only by design: this is the one gate that stops an
 * irreversible act, and unlike a review gate nothing else re-mints its id.
 */
async function decideDeployPingMode(id, now = Date.now()) {
  const row = await getClaimRow(id);
  if (!row) return null;   // TTL'd or actioned between the failed Put and here
  if (await consultClaimForRecovery(id, {
    ttlFallbackSec: DEPLOY_CLAIM_TTL_SEC, label: "deploy approval", row,
  })) return { kind: "recovery" };
  if (!row.deliveredAt?.N) return null;   // undelivered, but the lease is live

  const pingCount = Number(row.pingCount?.N || "1");
  const lastPingAt = Number(row.lastPingAt?.N || row.deliveredAt.N);
  if (!Number.isFinite(lastPingAt) || !Number.isFinite(pingCount)) return null;
  if (now - lastPingAt < DEPLOY_REPING_INTERVAL_MS) return null;
  // pingCount 1 is the original ping, so reminders sent so far == pingCount - 1.
  if (pingCount - 1 >= DEPLOY_REPING_MAX) return null;
  if (!(await takeReminderSlot(id, {
    seenLastPingAt: lastPingAt, seenCount: pingCount, nextCount: pingCount + 1, now,
  }))) return null;
  const claimedAt = claimedAtOf(row, DEPLOY_CLAIM_TTL_SEC);
  return { kind: "reminder", n: pingCount, pendingMs: claimedAt == null ? null : now - claimedAt };
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
  const cp = codepipelineFor(
    item.Item.region?.S || DEFAULT_REGION,
    item.Item.roleArn?.S || null,
    item.Item.externalId?.S || null,
  );
  const pipelineName = item.Item.pipelineName.S;
  const executionId = item.Item.executionId?.S || "";
  // The ledger's tokenless key shape (SEC-9): this page has no gate ticket, only
  // the claim row's pipeline + execution. Written BEFORE the pipeline call, for
  // the same reason as the ticket-keyed half.
  const ledgerRef = { pipeline: pipelineName, executionId };
  // TEAM-4781 SR2: read the PRIOR decision before the write below stamps this
  // tap's own over it. That ordering is the only way this page can tell "my own
  // ❌ re-tap" from "a ❌ landing on a gate I already ✅'d", and both the marker
  // and the wording below turn on the difference. null = no prior row, or a row
  // from a build that wrote none: unknown, never assumed.
  const priorDecision = await gateDecisionRecorded(ledgerRef);
  await recordGateApproved(ledgerRef, { approve, chatId });
  // Did CodePipeline refuse our call because the wait was already over? Hoisted
  // because the closing edit's wording turns on it (TEAM-4781 SR2): only a call
  // that actually LANDED lets this page claim it stopped the deploy.
  let putAlreadyCompleted = false;
  try {
    await cp.send(new PutApprovalResultCommand({
      pipelineName,
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
    // ApprovalAlreadyCompletedException.
    //
    // TEAM-4781: on a ❌ this is the shape of a RE-TAP of the very tap that
    // rejected this execution, so the rejection already stands and the MARKER is
    // the half that may still be missing. Fall through to the shared marker step
    // below rather than bailing: dropping the claim row is what makes this page
    // unactionable, and the row is the only thing left that can retry the marker.
    //
    // TEAM-4781 SR2: unless the prior row says we ✅'d it. Then this is the
    // opposite decision on a gate this page already approved, not a re-tap of a
    // rejection, and neither the marker nor a "deploy stopped" edit would be true.
    const alreadyRejected =
      !approve && APPROVAL_ALREADY_RE.test(`${err.name || ""} ${err.message || ""}`);
    if (alreadyRejected && priorDecision === "Approved") {
      console.warn(`[telegram-bug-intake] tokenless deploy gate on ${pipelineName}: ❌ tap after our own recorded ✅ - no rejection marker`);
      // The token is spent either way, so there is nothing left for this page to
      // retry: drop the claim exactly as the success path does.
      await ddb.send(new DeleteItemCommand({
        TableName: PENDING_TABLE, Key: { id: { S: `${DEPLOY_KEY_PREFIX}${key}` } },
      })).catch(() => {});
      await tgAnswer(cb.id, "Already approved — nothing to reject.");
      await tgEdit(chatId, cb.message.message_id,
        `${cb.message.text}\n\n🚀 Already approved on the pipeline — this ❌ changed nothing.`.slice(0, 4000));
      return;
    }
    if (!alreadyRejected) {
      // Anything else: nothing was recorded, so clear the claim as before.
      await ddb.send(new DeleteItemCommand({
        TableName: PENDING_TABLE, Key: { id: { S: `${DEPLOY_KEY_PREFIX}${key}` } },
      })).catch(() => {});
      await tgAnswer(cb.id, "Could not record — it may already be actioned.");
      await tgEdit(chatId, cb.message.message_id,
        `${cb.message.text}\n\n⚠️ ${esc(err.name || "Error")}: ${esc(err.message || "")}`.slice(0, 4000));
      return;
    }
    putAlreadyCompleted = true;
    console.warn(`[telegram-bug-intake] tokenless deploy gate on ${pipelineName} was already rejected: ${err.message} — retrying the marker only`);
  }
  // SEC-1: record the REJECTION where the pipeline's own preapproval check looks,
  // so a re-run of this commit cannot read a stale approval and skip the gate the
  // human just closed. TEAM-4781: no longer best-effort — if the marker will not
  // land, KEEP the claim row so this page's ❌ can retry it, and say so.
  if (!approve) {
    const marker = await writeShipRejection({
      state: await cp.send(new GetPipelineStateCommand({ name: pipelineName })).catch(() => null),
      cp, pipeline: pipelineName, executionId, chatId,
    });
    if (!marker.ok) {
      await reportMissingRejectionMarker({ cb, chatId, ticketId: null, workflowId: null, marker });
      return;
    }
  }
  // One-shot: the token is now spent. Drop the claim so the row can't linger.
  await ddb.send(new DeleteItemCommand({
    TableName: PENDING_TABLE, Key: { id: { S: `${DEPLOY_KEY_PREFIX}${key}` } },
  })).catch(() => {});
  await tgAnswer(cb.id, approve ? "Deploy approved" : "Deploy rejected");
  // TEAM-4781 SR2: "deploy stopped" is a claim about what OUR call did, so only
  // say it when our call landed, or when the prior ledger row proves the earlier
  // tap that consumed the token was also ours and was also a ❌ (the re-tap that
  // exists only to retry the marker). Otherwise the token was spent by a decision
  // we cannot attribute - it may have been an approval - and the honest statement
  // is that the gate is already actioned and the marker is recorded.
  const weStoppedIt = !putAlreadyCompleted || priorDecision === "Rejected";
  const verdict = approve
    ? "🚀 Approved — deploying to prod."
    : weStoppedIt
      ? "🛑 Rejected — deploy stopped."
      : "🛑 Already actioned on the pipeline — rejection marker recorded, so this commit cannot skip its deploy gate.";
  await tgEdit(chatId, cb.message.message_id, `${cb.message.text}\n\n${verdict}`);
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
  if (!data.ok) {
    const err = new Error(`Telegram ${method}: ${data.description || res.status}`);
    // TEAM-4663: callers that must decide "retry differently" vs "give up" need
    // the reason, not just a message string. Additive — nothing else reads these.
    err.status = res.status;
    err.description = data.description || "";
    throw err;
  }
  return data.result;
}

const tgSend = (chatId, text, extra = {}) =>
  tgCall("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true, ...extra });
const tgSendPlain = (chatId, text, extra = {}) =>
  tgCall("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...extra });
// Telegram failures a retry cannot fix: the chat is gone/blocked, or we are
// being rate-limited (a second immediate send makes that worse). Anything
// else — above all a legacy-Markdown "can't parse entities" 400 — is worth one
// plain-text retry, because the alternative is a human never seeing the page.
const HOPELESS_TG_ERROR =
  /Too Many Requests|retry after|bot was blocked|chat not found|user is deactivated|deactivated|bot was kicked|have no rights/i;
function hopelessTelegramError(err) {
  return HOPELESS_TG_ERROR.test(`${err?.description || ""} ${err?.message || ""}`);
}

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
