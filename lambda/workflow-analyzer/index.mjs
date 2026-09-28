/**
 * Workflow Analyzer trigger Lambda — thin dispatcher for the Workflow Manager
 * harness (agentcore_hub_workflow_manager). All analysis, persistence, and
 * intervention logic lives in the harness + its toolkit; this Lambda only
 * decides WHEN to invoke it.
 *
 * Trigger shapes:
 *   1. EventBridge {source: "agentcore-hub.orchestrator", detail-type: any
 *      TERMINAL workflow outcome — "workflow.complete",
 *      "workflow.deploy_blocked", "workflow.static_ci_only" (TEAM-3755 F5; the
 *      rule pattern lives in deploy/workflow-manager/deploy.sh)} → ANALYZE
 *      (auto, idempotent). Only source + detail.workflowId are read, so the
 *      detail-type set is a deploy-time concern, not a code branch.
 *   2. Direct invoke {workflowId, trigger: "manual"} → ANALYZE (re-runs allowed)
 *   3. EventBridge schedule {action: "watch"} → close out SI attempts whose run
 *      already ended (cancelled/error never reach shape 1 — TEAM-4760 AC4), then
 *      scan live runs and WATCH stale ones
 *   4. EventBridge schedule {action: "si-verify"} → daily SI verdict sweep
 *      (TEAM-4760; the harness runs toolkit/si_verify.py, this Lambda does no
 *      metric arithmetic of its own)
 *
 * Env: WORKFLOW_MANAGER_ARN (harness ARN), ANALYSES_TABLE, WORKFLOWS_TABLE,
 *      EVENTS_TABLE, SI_LEDGER_TABLE, ARTIFACT_BUCKET, WM_STALE_MINUTES
 *      (default 10), WM_WATCH_COOLDOWN_MINUTES (default 15),
 *      WM_ANALYZE_DELAY_MS (default 30000).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import { SiLedger, SI_LEDGER_TABLE_DEFAULT, normalizeKey } from "./si-ledger.mjs";

const REGION = process.env.AWS_REGION || "us-east-1";
const WORKFLOW_MANAGER_ARN = process.env.WORKFLOW_MANAGER_ARN;
const ANALYSES_TABLE = process.env.ANALYSES_TABLE || "agentcore-hub-workflow-analyses";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";
const STALE_MS = Number(process.env.WM_STALE_MINUTES || 10) * 60_000;
const COOLDOWN_MS = Number(process.env.WM_WATCH_COOLDOWN_MINUTES || 15) * 60_000;
const ANALYZE_DELAY_MS = Number(process.env.WM_ANALYZE_DELAY_MS || 30_000);

// TEAM-3747 D2: includes the lifecycle-integrity ship outcomes so a blocked run
// is recorded HONESTLY (the dossier carries phase deploy-blocked / static-ci-only,
// which save_analysis.py maps straight through RUN_OUTCOMES) instead of the line
// ~126 fallback rewriting it to "complete", and so the watch loop treats it as
// terminal. Additive; parity with completion.mjs SHIP_BLOCKED_OUTCOMES.
const TERMINAL_PHASES = new Set(["complete", "cancelled", "error", "deploy-blocked", "static-ci-only"]);
/** 1-2 rework loops are normal; the 3rd fix ticket marks a loop anomaly. */
const LOOP_ANOMALY_FIX_TICKETS = Number(process.env.WM_LOOP_ANOMALY_FIX_TICKETS || 3);

// ─── System-SI batching (mirrors the agent SI loop's eval batching) ───────────
// Analyses accumulate with no siBatchedAt; at SI_BATCH_SIZE pending — or
// immediately when any pending analysis carries a critical finding / P0
// recommendation — a SYNTHESIZE session batches them into one [SI] PRD.
const SI_BATCH_SIZE = Number(process.env.SI_BATCH_SIZE || 5);
const SI_COOLDOWN_MS = Number(process.env.SI_COOLDOWN_HOURS || 12) * 3_600_000;
/** Hub repo the system-SI PRD targets (agent SI targets the fleet repo). */
const HUB_REPO_URL = process.env.HUB_REPO_URL || "";
/** Claim row keys inside the analyses table — excluded from pending scans. */
const SI_CLAIM_PK = "#si-synthesis";
const SI_CLAIM_SK = "claim";
/** Cap the pairs listed in one SYNTHESIZE prompt; the rest ride the next batch. */
const SI_MAX_BATCH = 20;

// ─── SI ledger (TEAM-4760) ────────────────────────────────────────────────────
const SI_LEDGER_TABLE = process.env.SI_LEDGER_TABLE || SI_LEDGER_TABLE_DEFAULT;
/** Artifact bucket — read-only here, for workflows/<id>/shared/cd-ledger.json. */
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";
/**
 * Terminal phases where the run is CLOSED but the change was NOT delivered: a
 * human rejected the deploy gate, or CI certified nothing past static checks.
 * They must never read as "deployed" even when the cd-ledger carries an
 * execution id — the id is written the moment start_deploy returns, i.e. before
 * the gate the human then refused.
 */
const SHIP_BLOCKED_PHASES = new Set(["deploy-blocked", "static-ci-only"]);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

let ledgerClient;
function siLedger() {
  return (ledgerClient ||= new SiLedger({ ddb, table: SI_LEDGER_TABLE }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Session IDs must be ≥33 chars for AgentCore. */
function sessionId(prefix, key) {
  return `${prefix}-${key}-${Date.now()}`.padEnd(33, "x");
}

export const handler = async (event, context) => {
  if (!WORKFLOW_MANAGER_ARN) {
    throw new Error("WORKFLOW_MANAGER_ARN not set");
  }

  // Shape 3: scheduled watch scan
  if (event?.action === "watch") {
    return watchScan();
  }

  // Shape 4: scheduled SI verdict sweep. A plain action branch, NOT a mode flag:
  // it selects which prompt the harness gets, it does not change how anything
  // else behaves (DL-009's no-new-*_MODE-flag rule).
  if (event?.action === "si-verify") {
    return siVerify();
  }

  // Shapes 1 + 2: analyze one workflow
  const isEventBridge = event?.source === "agentcore-hub.orchestrator";
  const workflowId = isEventBridge ? event?.detail?.workflowId : event?.workflowId;
  const trigger = isEventBridge ? "auto" : event?.trigger || "manual";
  if (!workflowId) {
    throw new Error(`No workflowId in event: ${JSON.stringify(event).slice(0, 300)}`);
  }
  return analyze(workflowId, trigger, {
    remainingMs: () => context?.getRemainingTimeInMillis?.() ?? Infinity,
  });
};

// ─── ANALYZE ───────────────────────────────────────────────────────────────────

/**
 * TEAM-5226: continuations after a max-tokens stop. The harness (Strands) aborts
 * the whole invocation with MaxTokensReachedException when one model response
 * hits the output cap, typically mid-way through a large `shell` heredoc.
 *
 * TEAM-5238: re-invoking the SAME session is a best-effort fast path, not a
 * guarantee. No evidence of Strands orphan-toolUse repair exists in-repo (the
 * harness's Strands version is not pinned or visible here), so the truncated
 * toolUse may still sit unanswered in the session history and the model call
 * may then be rejected. When a same-session continuation fails for any reason
 * other than another max-tokens stop or the time budget, we rotate ONCE to a
 * fresh session: /mnt/workspace is per-session storage, so it starts empty and
 * the prompt says so. The fresh session is the assumption-free path. Bounded
 * either way: at most 1 + MAX_CONTINUATIONS invocations per ANALYZE.
 */
export const MAX_CONTINUATIONS = 3;
/**
 * TEAM-5238 F1: time budget applied to EVERY attempt, including the first.
 * reserveMs is kept back from the Lambda's remaining time for the
 * analysis_failed write and the claim release; an attempt needs at least
 * minAttemptMs of budget to start; harnessSlackS keeps the harness's own
 * timeout inside the JS deadline so the soft bound normally fires first.
 */
export const ANALYZE_LIMITS = Object.freeze({ reserveMs: 60_000, minAttemptMs: 120_000, harnessSlackS: 15 });
/** Same retention as the journey events (gate-contract.mjs JOURNEY_EVENT_TTL_SEC). */
const ANALYSIS_FAILED_TTL_SEC = 90 * 24 * 60 * 60;

/** Both HarnessStopReason values that mean "a model response hit the output cap". */
const MAX_TOKENS_STOP_REASONS = new Set(["max_tokens", "max_output_tokens_exceeded"]);
const MAX_TOKENS_TEXT = /MaxTokensReached|maximum token limit|max_tokens limit/i;

/**
 * The harness's max-tokens abort, whether reported as a stopReason or thrown.
 * Checks name as well as message: the SDK turns an event-stream error frame into
 * an Error named after its :error-code, whose message can be anything.
 */
export function isMaxTokensError(errOrResult) {
  if (!errOrResult) return false;
  if (MAX_TOKENS_STOP_REASONS.has(errOrResult.stopReason)) return true;
  return MAX_TOKENS_TEXT.test(`${errOrResult.name || ""} ${errOrResult.message || ""}`);
}

/** The ANALYZE header line with a note spliced in, so the harness still routes it to ANALYZE mode. */
function analyzeHeader(workflowId, prompt, note) {
  const first = prompt.split("\n")[0];
  return first.replace(`ANALYZE ${workflowId} (`, `ANALYZE ${workflowId} (${note}, `);
}

export function continuationPrompt(workflowId, prompt, n = 1) {
  return (
    `${analyzeHeader(workflowId, prompt, `continuation ${n}/${MAX_CONTINUATIONS}`)}\n` +
    `Your last tool call was truncated by the output limit and did not run. Continue the ANALYZE ` +
    `from where you stopped — files already in /mnt/workspace/${workflowId}/ persist. Write files in ` +
    `smaller pieces: one analysis.d/<key>.json section per tool call (split long lists into ` +
    `<key>.1.json, <key>.2.json, …). Finish by writing analysis.d/manifest.json = {"parts": [...]} ` +
    `listing exactly the current part files (unlisted, superseded parts are ignored), then run ` +
    `save_analysis.py as the run-analysis skill says.`
  );
}

/** First prompt of the fresh session a failed same-session continuation rotates to (TEAM-5238 F4). */
export function restartPrompt(workflowId, prompt) {
  const rest = prompt.split("\n").slice(1).join("\n");
  return (
    `${analyzeHeader(workflowId, prompt, "restart after output-limit stop, fresh session — workspace is empty")}\n` +
    (rest ? `${rest}\n` : "") +
    `A previous session hit the model output limit and could not be resumed. This is a NEW session: ` +
    `nothing from it exists in /mnt/workspace/${workflowId}/. Run the full run-analysis skill from the ` +
    `start, writing analysis.d/ in small pieces from the first section: one analysis.d/<key>.json ` +
    `section per tool call (split long lists into <key>.1.json, <key>.2.json, …).`
  );
}

/** Thrown when the Lambda has too little time left to start, or to finish, a harness attempt. */
function budgetExceeded(message) {
  return Object.assign(new Error(message), { name: "AnalyzeBudgetExceeded" });
}

/**
 * Race an attempt against the Lambda's own deadline. On expiry, abort the
 * request (destroys the HTTP stream) and reject, so the catch still runs and
 * writes analysis_failed before the platform kills the function.
 */
async function withDeadline(promise, ms, controller) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = budgetExceeded(`harness attempt exceeded its ${Math.round(ms / 1000)}s budget`);
      // Reject first: abort listeners run synchronously, and the invoke's own
      // AbortError must not win the race and hide why we aborted.
      reject(err);
      controller.abort(err);
    }, Math.max(0, ms));
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Record a failed ANALYZE on the run's event stream so the UI (analysis GET
 * `?since=`) and the timeline can show it. Schema mirrors publishJourneyEvent
 * (lambda/agentcore-hub-jira/gate-contract.mjs): the `<ms>-` eventId prefix is
 * load-bearing — the stream route's cursor is `eventId > lastEventId`. Best
 * effort: never throws, a failed write must not mask the real error.
 */
export async function publishAnalysisFailed(client, table, workflowId, detail) {
  if (!client || !table || !workflowId) return false;
  try {
    await client.send(new PutCommand({
      TableName: table,
      Item: {
        workflowId,
        eventId: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: "workflow.analysis_failed",
        detail,
        timestamp: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + ANALYSIS_FAILED_TTL_SEC,
      },
    }));
    return true;
  } catch (err) {
    console.error(`[analyzer] analysis_failed event write failed for ${workflowId}:`, err?.message || err);
    return false;
  }
}

/**
 * Collaborators are parameters with real defaults (like watchScan) so the suite
 * can drive the continuation loop and the failure event offline.
 */
export async function analyze(workflowId, trigger, {
  client = ddb,
  invoke = invokeHarness,
  remainingMs = () => Infinity,
  eventsTable = EVENTS_TABLE,
  limits = ANALYZE_LIMITS,
  releaseSleep = sleep,
} = {}) {
  let attempts = 0;
  let lastStopReason;
  // TEAM-5238 F6: the lookup and the claim sit inside the try, so a DynamoDB
  // error there still leaves an analysis_failed row; `stage` says where it died.
  let stage = "lookup";
  let claimed = false;
  let succeeded = false;
  try {
    const workflow = (await client.send(new GetCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
    }))).Item;
    if (!workflow) {
      console.warn(`[analyzer] workflow ${workflowId} not found — skipping`);
      return { skipped: "workflow not found" };
    }

    // EventBridge is at-least-once. A query-then-write check races (two deliveries
    // both read "none" before either writes). Claim the run atomically instead: a
    // conditional UpdateItem that only the first delivery can win. The loser skips
    // before spending the analyze delay or a harness invocation.
    //
    // The claim is an IN-PROGRESS marker, not a success marker: if anything after
    // it throws, the finally RELEASES it so a retry can re-run. Otherwise a
    // transient failure would leave wmAutoAnalyzedAt set forever and every retry
    // would take the "already analyzed" branch — silently disabling auto-analysis
    // for that run even though nothing was ever persisted.
    if (trigger === "auto") {
      stage = "claim";
      try {
        await client.send(new UpdateCommand({
          TableName: WORKFLOWS_TABLE,
          Key: { workflowId },
          UpdateExpression: "SET wmAutoAnalyzedAt = :t",
          ConditionExpression: "attribute_not_exists(wmAutoAnalyzedAt)",
          ExpressionAttributeValues: { ":t": new Date().toISOString() },
        }));
        claimed = true;
      } catch (err) {
        if (err.name === "ConditionalCheckFailedException") {
          console.log(`[analyzer] auto analysis already claimed for ${workflowId} — skipping`);
          return { skipped: "already analyzed" };
        }
        throw err;
      }
    }

    stage = "prepare";
    const defId = workflow.workflowDefId || "software-delivery";
    const phase = TERMINAL_PHASES.has(workflow.phase) ? workflow.phase : "complete";
    const fixTickets = await countFixTickets(workflowId, client);
    // One rework loop (review/QA/CI sends work back once) is expected; a third
    // "Fix:" ticket means the same work bounced repeatedly — that run gets the
    // deep loop root-cause directive instead of the standard rubric alone.
    const loopDirective =
      fixTickets >= LOOP_ANOMALY_FIX_TICKETS
        ? `\nLOOP ANOMALY: this run created ${fixTickets} fix tickets. Trace the full ` +
          `rework chain start to finish: for EACH fix loop, identify what was rejected, ` +
          `by whom (review/CI/QA/release), whether it was a new defect or the same one ` +
          `resurfacing, and the root cause of why it took multiple loops. Lead the ` +
          `analysis with this.`
        : "";
    const prompt =
      `ANALYZE ${workflowId} (defId=${defId}, outcome=${phase}, trigger=${trigger})\n` +
      `Title: ${workflow.input?.title || "(untitled)"}${loopDirective}`;

    // Let the final completions/*.json S3 writes land before the dossier pull.
    if (trigger === "auto") await sleep(ANALYZE_DELAY_MS);
    // The analysis ids as they stand BEFORE this session, so "did this ANALYZE
    // persist anything?" is a set difference rather than a count (a concurrent
    // manual re-analysis must not be able to satisfy it). null = read failed.
    const before = await analysisIdsFor(workflowId, { client });

    // One session for the first attempt and every continuation (TEAM-5226),
    // unless a continuation fails and we rotate to a fresh one (TEAM-5238 F4).
    stage = "invoke";
    let sid = sessionId("wm", workflowId);
    let rotated = false;
    let nextPrompt = prompt;
    let result;
    for (;;) {
      const budgetMs = remainingMs() - limits.reserveMs;
      if (budgetMs < limits.minAttemptMs) {
        throw budgetExceeded(
          `ANALYZE ${workflowId}: ${Math.max(0, Math.round(budgetMs / 1000))}s of Lambda budget left before ` +
          `attempt ${attempts + 1}, need ${Math.round(limits.minAttemptMs / 1000)}s`,
        );
      }
      const timeoutSeconds = Math.max(1, Math.min(900, Math.floor(budgetMs / 1000) - limits.harnessSlackS));
      attempts++;
      const controller = new AbortController();
      let maxTokensErr;
      try {
        result = await withDeadline(
          invoke(nextPrompt, sid, { timeoutSeconds, abortSignal: controller.signal }),
          budgetMs,
          controller,
        );
        lastStopReason = result.stopReason;
        if (isMaxTokensError(result)) {
          maxTokensErr = new Error(`MaxTokensReachedException: stopReason=${result.stopReason}`);
        }
      } catch (err) {
        if (isMaxTokensError(err)) {
          lastStopReason = err.stopReason || "max_tokens";
          maxTokensErr = err;
        } else if (attempts > 1 && !rotated && err?.name !== "AnalyzeBudgetExceeded" && attempts <= MAX_CONTINUATIONS) {
          // The same-session continuation was rejected: likely the orphaned
          // toolUse from the truncated response. Start over in a fresh session.
          console.warn(
            `[analyzer] ANALYZE ${workflowId}: continuation in ${sid} failed (${err?.name}: ${err?.message}) — restarting in a fresh session`,
          );
          rotated = true;
          // Own prefix: Date.now() alone can repeat within a millisecond.
          sid = sessionId("wmr", workflowId);
          nextPrompt = restartPrompt(workflowId, prompt);
          continue;
        } else {
          throw err;
        }
      }
      if (!maxTokensErr) break;
      if (attempts > MAX_CONTINUATIONS) throw maxTokensErr;
      console.warn(`[analyzer] ANALYZE ${workflowId}: max tokens (${lastStopReason}) on attempt ${attempts} — continuing session ${sid}`);
      nextPrompt = continuationPrompt(workflowId, prompt, attempts);
    }
    console.log(`[analyzer] ANALYZE ${workflowId} stopReason=${result.stopReason} chars=${result.text.length} attempts=${attempts}`);

    // Close out the SI attempt this run was carrying (TEAM-4760). Deliberately
    // BEFORE the D5 check below: the stamp is what hands a cancelled or errored
    // run's patterns back to `open`, and a run whose analysis keeps failing to
    // persist must not ALSO leave those patterns wedged at `in-run` —
    // dedupeBlocked suppresses an `in-run` key from every future PRD and has no
    // staleness escape, so that state is permanent until someone re-stamps it.
    stage = "persist";
    const si = await stampSiAttempt(workflow, phase);

    // D5: a harness session can end "successfully" (stopReason=end_turn) having
    // written NOTHING — the failure mode that made auto-analysis look healthy
    // while the analyses table stayed empty for the run. The claim is an
    // in-progress marker, so throw and let the finally release it: re-running
    // the analysis is the only way that row ever appears.
    const added = analysisDelta(before, await analysisIdsFor(workflowId, { client }));
    if (added && added.length === 0) {
      throw new Error(
        `ANALYZE ${workflowId} persisted no analysis (stopReason=${result.stopReason}, ` +
        `${result.text.length} chars replied) — save_analysis.py never wrote a row`,
      );
    }
    succeeded = true;

    // System-SI check rides the ANALYZE that just persisted a new analysis.
    // Failures are logged, never thrown: a synthesis hiccup must not release
    // the auto-claim and re-run a completed analysis.
    let synthesis = null;
    try {
      synthesis = await maybeSynthesize();
    } catch (err) {
      console.error(`[analyzer] SI synthesis check failed (maxTokens=${isMaxTokensError(err)}):`, err.message);
    }
    return {
      workflowId,
      trigger,
      stopReason: result.stopReason,
      attempts,
      analysisIds: added,
      si,
      synthesis,
      summary: result.text.slice(0, 500),
    };
  } catch (err) {
    // TEAM-5226: a failed ANALYZE used to leave no trace anywhere the UI could
    // see. The catch runs before the finally, so this row exists by the time
    // the claim release lets a re-run start.
    await publishAnalysisFailed(client, eventsTable, workflowId, {
      errorClass: isMaxTokensError(err) ? "MaxTokensReachedException" : err?.name || "Error",
      message: String(err?.message || err).slice(0, 500),
      attempts,
      trigger,
      stage,
      ...(lastStopReason ? { stopReason: lastStopReason } : {}),
    });
    // Async retries are off (deploy.sh event-invoke-config): a retry re-runs up
    // to 15 min of the model; the failure is now visible and Re-run is manual.
    throw err;
  } finally {
    if (claimed && !succeeded) await releaseAutoClaim(workflowId, client, { sleep: releaseSleep });
  }
}

// ─── System-SI synthesis trigger ───────────────────────────────────────────────

/** True when an analysis carries a critical finding or a P0 recommendation. */
function isCriticalAnalysis(item) {
  return (
    (item.findings || []).some((f) => f?.severity === "critical") ||
    (item.recommendations || []).some((r) => r?.priority === "P0")
  );
}

/**
 * Batch pending analyses into one SYNTHESIZE session when SI_BATCH_SIZE have
 * accumulated, or immediately when any pending one is critical. Cooldown +
 * conditional claim (a row inside the analyses table) keep concurrent ANALYZE
 * completions from double-firing; the skill stamps siBatchedAt on each row.
 */
async function maybeSynthesize() {
  if (!HUB_REPO_URL) return { skipped: "HUB_REPO_URL not set" };

  const pending = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: ANALYSES_TABLE,
      FilterExpression: "attribute_not_exists(siBatchedAt) AND workflowId <> :claim",
      ExpressionAttributeValues: { ":claim": SI_CLAIM_PK },
      ExclusiveStartKey,
    }));
    pending.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  const critical = pending.some(isCriticalAnalysis);
  if (pending.length < SI_BATCH_SIZE && !critical) {
    return { skipped: `pending ${pending.length}/${SI_BATCH_SIZE}, no critical` };
  }

  // Conditional claim: one synthesis per cooldown window, fleet-wide.
  const now = Date.now();
  try {
    await ddb.send(new UpdateCommand({
      TableName: ANALYSES_TABLE,
      Key: { workflowId: SI_CLAIM_PK, analysisId: SI_CLAIM_SK },
      UpdateExpression: "SET claimedAt = :now",
      ConditionExpression: "attribute_not_exists(claimedAt) OR claimedAt < :cutoff",
      ExpressionAttributeValues: {
        ":now": now,
        ":cutoff": now - SI_COOLDOWN_MS,
      },
    }));
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return { skipped: "cooldown/claim held" };
    }
    throw err;
  }

  const batch = pending
    .sort((a, b) => (isCriticalAnalysis(b) ? 1 : 0) - (isCriticalAnalysis(a) ? 1 : 0))
    .slice(0, SI_MAX_BATCH);
  const pairs = batch.map((i) => `${i.workflowId}/${i.analysisId}`);
  const prompt =
    `SYNTHESIZE system-improvement PRD (trigger=${critical ? "critical" : "batch"})\n` +
    `Hub repo: ${HUB_REPO_URL}\n` +
    `Pending analyses (workflowId/analysisId):\n` +
    pairs.map((p) => `- ${p}`).join("\n") +
    (pending.length > batch.length ? `\n(${pending.length - batch.length} more ride the next batch)` : "");

  console.log(`[analyzer] SYNTHESIZE: ${pairs.length} analyses (critical=${critical})`);
  const result = await invokeHarness(prompt, sessionId("wmsi", String(now)));
  console.log(`[analyzer] SYNTHESIZE stopReason=${result.stopReason}`);
  if (isMaxTokensError(result)) console.warn(`[analyzer] SYNTHESIZE hit the output limit (stopReason=${result.stopReason})`);
  return { batched: pairs.length, critical, stopReason: result.stopReason };
}

/**
 * Count "Fix:" tickets created during a run. Paged full read of the run's
 * events — bounded (a few hundred items) and only at completion time. A read
 * failure returns 0: the analysis still runs, just without the loop directive.
 */
async function countFixTickets(workflowId, client = ddb) {
  try {
    // Unique ticket ids: ticket.created lands twice per ticket (direct write +
    // EventBridge relay), and agents vary the title ("Fix:", "Fix (review):",
    // "Fix ship-review-r4 …") — match the leading word, dedupe by id.
    const fixIds = new Set();
    let ExclusiveStartKey;
    do {
      const page = await client.send(new QueryCommand({
        TableName: EVENTS_TABLE,
        KeyConditionExpression: "workflowId = :w",
        ExpressionAttributeValues: { ":w": workflowId },
        ExclusiveStartKey,
      }));
      for (const e of page.Items || []) {
        const ticket = e.detail?.ticket;
        if (e.type !== "ticket.created" || !/^Fix\b/i.test(ticket?.title || "")) continue;
        fixIds.add(ticket.id || ticket.title);
      }
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return fixIds.size;
  } catch (err) {
    console.warn(`[analyzer] fix-ticket count failed for ${workflowId}:`, err.message);
    return 0;
  }
}

/**
 * Release the in-progress auto-analysis claim so a retry can re-run. Retried:
 * a claim left set silently disables auto-analysis for the run, so a final
 * failure gets its own log line an operator can alarm on.
 */
export async function releaseAutoClaim(workflowId, client = ddb, { sleep: wait = sleep, attempts = 3 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await client.send(new UpdateCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
        UpdateExpression: "REMOVE wmAutoAnalyzedAt",
      }));
      console.log(`[analyzer] released auto-analysis claim for ${workflowId} after failure`);
      return true;
    } catch (err) {
      if (i === attempts) {
        console.error(
          `[analyzer] CLAIM RELEASE FAILED for ${workflowId} after ${attempts} attempts (${err?.message}): ` +
          `wmAutoAnalyzedAt left set; auto-analysis disabled for this run until cleared`,
        );
        return false;
      }
      await wait(200 * i);
    }
  }
  return false;
}

// ─── SI ledger: closing out the attempt a run was carrying (TEAM-4760) ────────

/**
 * WHY THIS LIVES HERE. prd-submitter flips a pattern's row to `in-run` when it
 * starts the run that carries the fix. Something has to close that attempt when
 * the run ends, and this Lambda is the only component told about EVERY terminal
 * outcome (the EventBridge rule covers complete / deploy_blocked /
 * static_ci_only, a manual invoke covers the rest).
 *
 * So the UNHAPPY paths matter most here. A cancelled or errored SI run that was
 * never stamped leaves its keys at `in-run`, and `dedupeBlocked` then suppresses
 * that recommendation from every future PRD — "asked 8 times, never tracked"
 * inverted into "asked once, never askable again". Every outcome below therefore
 * carries a NOTE naming what the run actually did, and the ones that delivered
 * nothing hand the key back to `open`.
 *
 * Nothing in this section is allowed to fail an ANALYZE: the analysis is the
 * expensive artifact (a full harness session) and the ledger is a mirror that
 * the next analysis or the daily si_verify sweep re-converges.
 */

/** The `si` block prd-submitter put on the run, normalised — or null. */
export function siBlock(workflow) {
  const si = workflow?.input?.si;
  if (!si || typeof si !== "object") return null;
  const patternKeys = [];
  for (const raw of Array.isArray(si.patternKeys) ? si.patternKeys : []) {
    // normalizeKey is the single arbiter of "is this a key" (si-ledger.mjs) —
    // every ledger read normalises, so a key this rejects names no row at all.
    try {
      const key = normalizeKey(raw);
      if (!patternKeys.includes(key)) patternKeys.push(key);
    } catch {
      console.warn(`[analyzer] si: ignoring unusable patternKey ${JSON.stringify(raw)}`);
    }
  }
  if (!patternKeys.length) return null;
  return { prdKey: String(si.prdKey || ""), patternKeys };
}

/**
 * Every PR this run produced, as numbers. Read from the per-ticket
 * `agentTasks[*].prUrl` (each ship/dev ticket records its own) AND from
 * `delivery.prUrl` (the unified PR the completer opens, which on a handoff run
 * is the ONLY place a PR appears). Unioned because a run that opened a second PR
 * must not erase the first — applyAttempt unions again on top.
 */
export function prNumbersFrom(workflow) {
  const out = [];
  for (const url of [
    ...Object.values(workflow?.agentTasks || {}).map((t) => t?.prUrl),
    workflow?.delivery?.prUrl,
  ]) {
    const m = /\/pull\/(\d+)/.exec(String(url || ""));
    const n = m ? Number(m[1]) : NaN;
    if (Number.isFinite(n) && !out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

/** A Date or date-ish string → ISO-8601, or null. Never throws. */
function iso(value) {
  if (!value) return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * When did this attempt merge, and when did it deploy?
 *
 * The cd-ledger carries NO timestamps — it is exactly
 * `{pipeline, executionId, mergeCommit, prUrl, approvedHeadSha, gateTicketId}`
 * (blueprints/release-manager.md, "The CD ledger"). So the time is taken from an
 * explicit field if one is ever added, else from the S3 object's LastModified —
 * the release manager writes that object the instant `Pipeline___start_deploy`
 * returns, which is the closest real record of the deploy trigger — else from
 * the caller's fallback (the run's completion time). Each stamp is only set when
 * the ledger holds the EVIDENCE for it: no mergeCommit, no mergedAt. A guessed
 * mergedAt would start dedupeBlocked's 14-day freshness window on a merge that
 * never happened.
 */
export function cdStamps(cd, { lastModified, fallbackAt } = {}) {
  if (!cd || typeof cd !== "object") return { mergedAt: null, deployedAt: null };
  const at = iso(lastModified) || iso(fallbackAt);
  return {
    mergedAt: cd.mergeCommit ? iso(cd.mergedAt) || at : null,
    deployedAt: cd.executionId ? iso(cd.deployedAt) || at : null,
  };
}

/**
 * What did this run DO for the pattern? → `{ outcome, note }`, where outcome is
 * one of si-ledger's ATTEMPT_OUTCOMES and note is the evidence sentence a human
 * (or the next synthesis) reads off the row.
 *
 * Evidence-ordered, and the default is pessimistic: a run that reached a
 * terminal phase with no merge and no handoff PR delivered nothing, so it is
 * recorded as `error` — which returns the key to `open`, keeping the ask owed.
 * Claiming `landed` on a completed-but-unmerged run is how the ledger would
 * start lying in the direction that silences the backlog.
 */
export function siOutcome({ phase, workflow, cd } = {}) {
  const mode = workflow?.delivery?.mode || "";
  const prs = prNumbersFrom(workflow);
  const evidence =
    `phase=${phase}, delivery=${mode || "none"}, ` +
    `PRs=${prs.length ? prs.map((n) => `#${n}`).join(" ") : "none"}, ` +
    `cd-ledger=${cd ? `execution ${cd.executionId || "none"} / merge ${String(cd.mergeCommit || "none").slice(0, 12)}` : "absent"}`;

  if (phase === "cancelled") return { outcome: "cancelled", note: `run cancelled before the fix shipped (${evidence})` };
  if (phase === "error") return { outcome: "error", note: `run ended in error (${evidence})` };
  if (SHIP_BLOCKED_PHASES.has(phase)) {
    return cd?.mergeCommit
      ? { outcome: "landed", note: `merged but never deployed — run closed ${phase} (${evidence})` }
      : { outcome: "error", note: `run closed ${phase} with nothing merged (${evidence})` };
  }
  if (cd?.executionId) return { outcome: "deployed", note: `deployed via ${cd.pipeline || "pipeline"} (${evidence})` };
  if (cd?.mergeCommit) return { outcome: "landed", note: `merged, no deploy execution recorded (${evidence})` };
  if (mode === "handoff" && prs.length) {
    return { outcome: "handoff", note: `PR left open for the owning team — repo is outside the CD registry (${evidence})` };
  }
  return {
    outcome: "error",
    note: `run reached ${phase} with no merge evidence — nothing shipped, the ask is still owed (${evidence})`,
  };
}

/**
 * Read `workflows/<id>/shared/cd-ledger.json` → `{ cd, lastModified }`, or
 * `{ cd: null }` when there is none (or it could not be read — an unreadable
 * ledger must degrade to "no merge evidence", never to a fabricated deploy).
 *
 * The S3 client is imported lazily and NOT declared in package.json: the
 * nodejs20.x managed runtime provides the v3 clients, which is how
 * lambda/prd-submitter runs with no package.json at all. Keeping it out of the
 * zip avoids ~10MB of bundle for one GetObject. No IAM change either — this
 * Lambda's role already holds s3:GetObject on the whole artifact bucket
 * (deploy/setup-lambda-role.sh, Sid "ObjectRW").
 */
export async function readCdLedger(workflowId, { s3, bucket = ARTIFACT_BUCKET } = {}) {
  if (!bucket || !workflowId) {
    console.warn(`[analyzer] si: cd-ledger not read (${bucket ? "no workflowId" : "ARTIFACT_BUCKET unset"})`);
    return { cd: null, lastModified: null };
  }
  const Key = `workflows/${workflowId}/shared/cd-ledger.json`;
  try {
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = s3 || new S3Client({ region: REGION });
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key }));
    const cd = JSON.parse(await out.Body.transformToString());
    return { cd: cd && typeof cd === "object" ? cd : null, lastModified: out.LastModified || null };
  } catch (err) {
    const missing = err?.name === "NoSuchKey" || err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404;
    if (!missing) console.warn(`[analyzer] si: cd-ledger read failed for ${Key} (${err?.name}): ${err?.message}`);
    return { cd: null, lastModified: null };
  }
}

/**
 * Stamp this run's attempt onto every pattern it was carrying. Never throws.
 *
 * One attempt object for all the run's keys — it IS one attempt, and
 * applyAttempt dedupes on (prdKey, workflowId), so a manual re-analysis
 * re-stamps the same entry instead of adding a second one. A per-key write that
 * fails (the row was deleted between submission and completion) is logged and
 * skipped so the other keys still close out; re-running ANALYZE manually for the
 * run re-stamps whatever was missed.
 */
export async function stampSiAttempt(workflow, phase, { ledger = siLedger(), s3, bucket, at } = {}) {
  const si = siBlock(workflow);
  if (!si) return { skipped: "run carried no input.si" };
  const workflowId = workflow.workflowId;
  try {
    const { cd, lastModified } = await readCdLedger(workflowId, { s3, bucket });
    const { outcome, note } = siOutcome({ phase, workflow, cd });
    const { mergedAt, deployedAt } = cdStamps(cd, {
      lastModified,
      fallbackAt: workflow.completedAt || workflow.cancelledAt || at || new Date().toISOString(),
    });
    const attempt = {
      prdKey: si.prdKey,
      workflowId,
      epicId: workflow.epicId,
      prNumbers: prNumbersFrom(workflow),
      mergedAt,
      deployedAt,
      outcome,
      note,
    };

    const stamped = [];
    const failed = [];
    for (const patternKey of si.patternKeys) {
      try {
        const row = await ledger.stampAttempt(patternKey, attempt);
        stamped.push(patternKey);
        console.log(`[analyzer] si-ledger: ${patternKey} → ${row.status} (${outcome}, PRD ${si.prdKey}, run ${workflowId})`);
      } catch (err) {
        failed.push(patternKey);
        console.error(`[analyzer] si-ledger: ${patternKey} NOT stamped (${outcome}) — ${err?.message || err}`);
      }
    }
    return { prdKey: si.prdKey, outcome, stamped, failed };
  } catch (err) {
    console.error(`[analyzer] si-ledger: attempt stamp failed for ${workflowId}: ${err?.message || err}`);
    return { prdKey: si.prdKey, error: String(err?.message || err), stamped: [], failed: si.patternKeys };
  }
}

/**
 * Which terminal phase this row is in, or null while it is still live.
 *
 * `cancelledAt` is the cancel route's FIRST stamp and the phase can lag behind it
 * (TEAM-4577, the same reason watchScan filters on it), so a row carrying it is
 * read as cancelled whatever its phase says — that is the truth the attempt has
 * to record.
 */
export function terminalPhaseOf(workflow) {
  if (!workflow) return null;
  if (workflow.cancelledAt || workflow.phase === "cancelled") return "cancelled";
  return TERMINAL_PHASES.has(workflow.phase) ? workflow.phase : null;
}

/**
 * Close out attempts whose run is already over (TEAM-4760 AC4).
 *
 * ANALYZE stamps the attempt for a run that ends through one of the orchestrator's
 * terminal EventBridge outcomes — but a CANCELLED run emits none of them: the
 * cancel route writes a single events-table row and nothing else, and the watch
 * loop skips terminal rows by design. So nothing would ever stamp that attempt,
 * and since dedupeBlocked blocks an `in-run` key UNCONDITIONALLY (no staleness
 * escape) while si_verify.py skips `in-run` rows entirely, the run's patterns
 * would be wedged out of the backlog forever — the exact inverse of what this
 * ledger exists to do. Same for a run that died in `error`.
 *
 * The sweep therefore starts from the LEDGER rather than the workflows table: for
 * every row the ledger still believes is `in-run`, ask whether the run it named
 * has ended. That is one Scan of a tens-of-rows table plus one GetItem per open
 * attempt instead of a full workflows Scan, it needs no marker attribute because
 * the stamp itself clears the `in-run` status, and it also repairs a per-key stamp
 * that failed earlier. Idempotent by construction: a stamped row is no longer
 * `in-run`, so the next sweep does not look at it.
 *
 * Only rows whose STATUS is `in-run` are touched, and only their newest attempt —
 * exactly the (row, attempt) pair dedupeBlocked cites. Closing an OLDER in-run
 * attempt on a row that has since landed would drag that row's status backwards.
 */
export async function siReapScan({ ledger = siLedger(), client = ddb, table = WORKFLOWS_TABLE, s3, bucket } = {}) {
  const reaped = [];
  let rows;
  try {
    rows = await ledger.list();
  } catch (err) {
    console.error(`[analyzer] si-reap: ledger scan failed: ${err?.message || err}`);
    return { candidates: 0, live: 0, reaped };
  }

  const candidates = rows.filter((row) => row?.status === "in-run");
  const closed = new Set();
  let live = 0;
  for (const row of candidates) {
    const attempts = Array.isArray(row.attempts) ? row.attempts : [];
    const workflowId = attempts.length ? attempts[attempts.length - 1]?.workflowId : null;
    if (!workflowId) {
      console.warn(`[analyzer] si-reap: ${row.patternKey} is in-run with no attempt workflowId — skipped`);
      continue;
    }
    // stampSiAttempt closes EVERY key its run carried, so the run's other rows in
    // this same snapshot are already done — re-stamping them would be harmless
    // (applyAttempt dedupes) but would re-read the cd-ledger once per key.
    if (closed.has(workflowId)) continue;
    try {
      const wf = (await client.send(new GetCommand({ TableName: table, Key: { workflowId } }))).Item;
      if (!wf) {
        // Do NOT invent an outcome for a run we cannot see. Rows are not deleted
        // by any code path (archiving sets a flag), so this is an operator action
        // and an operator's call to resolve.
        console.warn(`[analyzer] si-reap: ${row.patternKey} names run ${workflowId}, which no longer exists — left in-run`);
        continue;
      }
      const phase = terminalPhaseOf(wf);
      if (!phase) {
        live++;
        continue;
      }
      const result = await stampSiAttempt(wf, phase, { ledger, s3, bucket });
      closed.add(workflowId);
      reaped.push({ patternKey: row.patternKey, workflowId, phase, outcome: result.outcome, stamped: result.stamped || [] });
    } catch (err) {
      console.error(`[analyzer] si-reap: ${row.patternKey} (run ${workflowId}) failed: ${err?.message || err}`);
    }
  }
  if (candidates.length) {
    console.log(`[analyzer] si-reap: ${candidates.length} in-run, ${live} still running, ${reaped.length} closed out`);
  }
  return { candidates: candidates.length, live, reaped };
}

/**
 * The analysis ids on record for a run, or null when the read failed — null and
 * "none" are different answers, and only the D5 check below is allowed to decide
 * what to do about the difference.
 */
export async function analysisIdsFor(workflowId, { client = ddb, table = ANALYSES_TABLE } = {}) {
  try {
    const ids = new Set();
    let ExclusiveStartKey;
    do {
      const page = await client.send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: "workflowId = :w",
        ExpressionAttributeValues: { ":w": workflowId },
        ProjectionExpression: "analysisId",
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }));
      for (const item of page.Items || []) if (item?.analysisId) ids.add(String(item.analysisId));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return ids;
  } catch (err) {
    console.warn(`[analyzer] analyses read failed for ${workflowId}: ${err?.message || err}`);
    return null;
  }
}

/**
 * Which analysis ids this session added → `[]` when it added none, or null when
 * we genuinely do not know (either read failed). `analysisId` is minted per save
 * as `<epoch-ms>-<4 random chars>` (toolkit/save_analysis.py), so a re-analysis
 * always produces a NEW id and the growth check cannot be satisfied by an
 * existing row.
 *
 * null must never be treated as failure: a throttled Query would then release
 * the claim and re-run a perfectly good, already-persisted analysis — burning a
 * harness session to fix a problem that does not exist.
 */
export function analysisDelta(before, after) {
  if (!before || !after) return null;
  return [...after].filter((id) => !before.has(id));
}

// ─── SI-VERIFY (daily) ─────────────────────────────────────────────────────────

/**
 * The daily "did the fixes work?" sweep. This Lambda computes NOTHING: the
 * verdict rule is arithmetic that lives in one place, toolkit/si_verify.py, and
 * the harness's only job is to run it and report what it printed. A verdict an
 * LLM can reword is a verdict the loop can talk itself past, which is how the
 * old loop re-filed asks it had already tried.
 */
export const SI_VERIFY_PROMPT =
  "SI-VERIFY (daily sweep)\n" +
  "Run the session bootstrap, then `python3 /mnt/workspace/toolkit/si_verify.py --apply` " +
  "and report its output VERBATIM (the full Prior-attempts / verdict table, unedited).\n" +
  "The script is the only judge: do not rule on any expectation yourself, do not re-word " +
  "or summarise its verdicts, do not write to the si-ledger by any other route, and do not " +
  "file, batch or synthesise anything in this session. If it exits non-zero, report the " +
  "error output and stop.";

export async function siVerify({ invoke = invokeHarness, now = Date.now() } = {}) {
  const result = await invoke(SI_VERIFY_PROMPT, sessionId("wmverify", String(now)));
  console.log(`[analyzer] SI-VERIFY stopReason=${result.stopReason} chars=${result.text.length}`);
  if (isMaxTokensError(result)) console.warn(`[analyzer] SI-VERIFY hit the output limit (stopReason=${result.stopReason})`);
  return { action: "si-verify", stopReason: result.stopReason, summary: result.text.slice(0, 2000) };
}

// ─── WATCH ─────────────────────────────────────────────────────────────────────

/**
 * Parked on a human: an unacknowledged review gate or manager escalation.
 * These are HUMAN gates — the watchdog must not burn WM sessions re-diagnosing
 * them (the failure mode that led to permanent mutes). The skip is self-healing:
 * review_needed is acknowledged by the orchestrator when the gate ticket
 * transitions, manager_escalation by the human via the Telegram resolve button
 * (PATCH /api/workflow/[id]/escalations) — watching resumes on the ack.
 */
function parkedOnHuman(wf) {
  return (wf.humanNotifications || []).some(
    (n) => !n?.acknowledged && (n?.type === "review_needed" || n?.type === "manager_escalation")
  );
}

/**
 * The 5-minute scan. Two jobs, in this order: close out SI attempts whose run has
 * already ended (cheap, bounded, no model call), then WATCH the stale live runs.
 * The sweep goes FIRST because the watch loop can spend the whole 900s budget on
 * harness invocations, and a wedged `in-run` key must not wait on that.
 *
 * Collaborators are parameters with real defaults so the suite can drive this
 * whole path over an in-memory table — nodejs20 has no `mock.module`.
 */
export async function watchScan({ client = ddb, ledger, s3, bucket, invoke = invokeHarness, now = Date.now() } = {}) {
  const si = await siReapScan({ ledger, client, s3, bucket });

  const active = [];
  let ExclusiveStartKey;
  do {
    const page = await client.send(new ScanCommand({
      TableName: WORKFLOWS_TABLE,
      ProjectionExpression: "workflowId, phase, archived, managerWatch, wmLastWatchAt, startedAt, workflowDefId, humanNotifications, cancelledAt",
      ExclusiveStartKey,
    }));
    // cancelledAt is the cancel route's first stamp; a row carrying it is dead
    // even if its phase lags (TEAM-4577 — the watchdog re-woke on such rows).
    active.push(...(page.Items || []).filter(
      (w) => !TERMINAL_PHASES.has(w.phase) && !w.cancelledAt && !w.archived && w.managerWatch !== false && !parkedOnHuman(w)
    ));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  const watched = [];
  for (const wf of active) {
    const lastWatch = wf.wmLastWatchAt ? Date.parse(wf.wmLastWatchAt) : 0;
    if (now - lastWatch < COOLDOWN_MS) continue;

    const lastEventAge = await lastSignificantEventAge(wf.workflowId, now, client);
    // Age used to decide staleness AND to report in the prompt: event age when we
    // have events, else time since the run started (0 if we know neither).
    const staleAge = lastEventAge ?? (wf.startedAt ? now - Date.parse(wf.startedAt) : 0);
    if (staleAge < STALE_MS) continue;

    // Claim the watch slot BEFORE invoking — prevents intervention loops even
    // if the harness invocation itself is slow or this Lambda retries.
    await client.send(new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId: wf.workflowId },
      UpdateExpression: "SET wmLastWatchAt = :t",
      ExpressionAttributeValues: { ":t": new Date(now).toISOString() },
    }));

    const prompt =
      `WATCH ${wf.workflowId} (defId=${wf.workflowDefId || "software-delivery"}, phase=${wf.phase})\n` +
      `No significant events for ${Math.round(staleAge / 60000)} minutes. ` +
      `Diagnose and unstick if warranted.`;
    try {
      const result = await invoke(prompt, sessionId("wmwatch", wf.workflowId));
      console.log(`[analyzer] WATCH ${wf.workflowId} stopReason=${result.stopReason}`);
      if (isMaxTokensError(result)) console.warn(`[analyzer] WATCH ${wf.workflowId} hit the output limit (stopReason=${result.stopReason})`);
      watched.push(wf.workflowId);
    } catch (err) {
      console.error(`[analyzer] WATCH ${wf.workflowId} failed (maxTokens=${isMaxTokensError(err)}):`, err.message);
    }
  }
  console.log(`[analyzer] watch scan: ${active.length} active, ${watched.length} watched`);
  return { active: active.length, watched, si };
}

/** Age in ms of the newest non-streaming event, or null if none. */
// Not agent activity: streaming chunks are too chatty to mean anything alone,
// and orchestrator.nudge is a housekeeping event the orchestrator publishes
// itself (a live lease it chose not to steal) — counting either keeps a run
// looking fresh no matter what the agent is doing (TEAM-3969).
// workflow.analysis_failed is the analyzer's own post-run record (TEAM-5226).
const NON_SIGNIFICANT_EVENT_TYPES = new Set(["agent.streaming", "orchestrator.nudge", "workflow.analysis_failed"]);

async function lastSignificantEventAge(workflowId, now, client = ddb) {
  const page = await client.send(new QueryCommand({
    TableName: EVENTS_TABLE,
    KeyConditionExpression: "workflowId = :w",
    ExpressionAttributeValues: { ":w": workflowId },
    ScanIndexForward: false,
    Limit: 25,
  }));
  const item = (page.Items || []).find((e) => !NON_SIGNIFICANT_EVENT_TYPES.has(e.type)) || (page.Items || [])[0];
  if (!item?.timestamp) return null;
  return now - Date.parse(item.timestamp);
}

// ─── Harness invoke ────────────────────────────────────────────────────────────

async function invokeHarness(prompt, runtimeSessionId, { timeoutSeconds = 900, abortSignal } = {}) {
  const { BedrockAgentCoreClient, InvokeHarnessCommand } = await import("@aws-sdk/client-bedrock-agentcore");
  const { NodeHttpHandler } = await import("@smithy/node-http-handler");
  const client = new BedrockAgentCoreClient({
    region: REGION,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 30_000,
      // Bounds time-to-response-headers ONLY: the timer is cleared once headers
      // arrive, so it never limits a streamed body. The per-attempt deadline is
      // timeoutSeconds (harness side) plus abortSignal (analyze's withDeadline).
      requestTimeout: 840_000,
      throwOnRequestTimeout: true,
    }),
  });

  const response = await client.send(new InvokeHarnessCommand({
    harnessArn: WORKFLOW_MANAGER_ARN,
    runtimeSessionId,
    actorId: "workflow-manager",
    timeoutSeconds,
    maxIterations: 75,
    messages: [{ role: "user", content: [{ text: prompt }] }],
  }), { abortSignal });

  let text = "";
  let stopReason = "unknown";
  try {
    for await (const event of response.stream || []) {
      if (event.contentBlockDelta?.delta?.text) text += event.contentBlockDelta.delta.text;
      if (event.messageStop?.stopReason) stopReason = event.messageStop.stopReason;
      if (event.runtimeClientError) {
        throw new Error(`Harness error: ${event.runtimeClientError.message}`);
      }
    }
  } catch (err) {
    // An abort after the headers surfaces as a bare socket "aborted" error;
    // report the reason the caller aborted with instead.
    if (abortSignal?.aborted) throw abortSignal.reason ?? err;
    throw err;
  }
  return { text, stopReason };
}
