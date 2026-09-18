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
 *   3. EventBridge schedule {action: "watch"} → scan live runs, WATCH stale ones
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

export const handler = async (event) => {
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
  return analyze(workflowId, trigger);
};

// ─── ANALYZE ───────────────────────────────────────────────────────────────────

async function analyze(workflowId, trigger) {
  const workflow = (await ddb.send(new GetCommand({
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
  // The claim is an IN-PROGRESS marker, not a success marker: if the invocation
  // (or the delay) throws, we RELEASE it so a retry can re-run. Otherwise a
  // transient failure would leave wmAutoAnalyzedAt set forever and every retry
  // would take the "already analyzed" branch — silently disabling auto-analysis
  // for that run even though nothing was ever persisted.
  if (trigger === "auto") {
    try {
      await ddb.send(new UpdateCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
        UpdateExpression: "SET wmAutoAnalyzedAt = :t",
        ConditionExpression: "attribute_not_exists(wmAutoAnalyzedAt)",
        ExpressionAttributeValues: { ":t": new Date().toISOString() },
      }));
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") {
        console.log(`[analyzer] auto analysis already claimed for ${workflowId} — skipping`);
        return { skipped: "already analyzed" };
      }
      throw err;
    }
  }

  const defId = workflow.workflowDefId || "software-delivery";
  const phase = TERMINAL_PHASES.has(workflow.phase) ? workflow.phase : "complete";
  const fixTickets = await countFixTickets(workflowId);
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

  try {
    // Let the final completions/*.json S3 writes land before the dossier pull.
    if (trigger === "auto") await sleep(ANALYZE_DELAY_MS);
    // The analysis ids as they stand BEFORE this session, so "did this ANALYZE
    // persist anything?" is a set difference rather than a count (a concurrent
    // manual re-analysis must not be able to satisfy it). null = read failed.
    const before = await analysisIdsFor(workflowId);
    const result = await invokeHarness(prompt, sessionId("wm", workflowId));
    console.log(`[analyzer] ANALYZE ${workflowId} stopReason=${result.stopReason} chars=${result.text.length}`);

    // Close out the SI attempt this run was carrying (TEAM-4760). Deliberately
    // BEFORE the D5 check below: the stamp is what hands a cancelled or errored
    // run's patterns back to `open`, and a run whose analysis keeps failing to
    // persist must not ALSO leave those patterns wedged at `in-run` —
    // dedupeBlocked suppresses an `in-run` key from every future PRD and has no
    // staleness escape, so that state is permanent until someone re-stamps it.
    const si = await stampSiAttempt(workflow, phase);

    // D5: a harness session can end "successfully" (stopReason=end_turn) having
    // written NOTHING — the failure mode that made auto-analysis look healthy
    // while the analyses table stayed empty for the run. The claim is an
    // in-progress marker, so throw and let the catch release it: re-running the
    // analysis is the only way that row ever appears.
    const added = analysisDelta(before, await analysisIdsFor(workflowId));
    if (added && added.length === 0) {
      throw new Error(
        `ANALYZE ${workflowId} persisted no analysis (stopReason=${result.stopReason}, ` +
        `${result.text.length} chars replied) — save_analysis.py never wrote a row`,
      );
    }

    // System-SI check rides the ANALYZE that just persisted a new analysis.
    // Failures are logged, never thrown: a synthesis hiccup must not release
    // the auto-claim and re-run a completed analysis.
    let synthesis = null;
    try {
      synthesis = await maybeSynthesize();
    } catch (err) {
      console.error(`[analyzer] SI synthesis check failed:`, err.message);
    }
    return {
      workflowId,
      trigger,
      stopReason: result.stopReason,
      analysisIds: added,
      si,
      synthesis,
      summary: result.text.slice(0, 500),
    };
  } catch (err) {
    if (trigger === "auto") await releaseAutoClaim(workflowId);
    throw err; // let EventBridge retry a released run
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
  return { batched: pairs.length, critical, stopReason: result.stopReason };
}

/**
 * Count "Fix:" tickets created during a run. Paged full read of the run's
 * events — bounded (a few hundred items) and only at completion time. A read
 * failure returns 0: the analysis still runs, just without the loop directive.
 */
async function countFixTickets(workflowId) {
  try {
    // Unique ticket ids: ticket.created lands twice per ticket (direct write +
    // EventBridge relay), and agents vary the title ("Fix:", "Fix (review):",
    // "Fix ship-review-r4 …") — match the leading word, dedupe by id.
    const fixIds = new Set();
    let ExclusiveStartKey;
    do {
      const page = await ddb.send(new QueryCommand({
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

/** Release the in-progress auto-analysis claim so a retry can re-run. */
async function releaseAutoClaim(workflowId) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
      UpdateExpression: "REMOVE wmAutoAnalyzedAt",
    }));
    console.log(`[analyzer] released auto-analysis claim for ${workflowId} after failure`);
  } catch (err) {
    console.error(`[analyzer] failed to release claim for ${workflowId}:`, err.message);
  }
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

async function watchScan() {
  const now = Date.now();
  const active = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new ScanCommand({
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

    const lastEventAge = await lastSignificantEventAge(wf.workflowId, now);
    // Age used to decide staleness AND to report in the prompt: event age when we
    // have events, else time since the run started (0 if we know neither).
    const staleAge = lastEventAge ?? (wf.startedAt ? now - Date.parse(wf.startedAt) : 0);
    if (staleAge < STALE_MS) continue;

    // Claim the watch slot BEFORE invoking — prevents intervention loops even
    // if the harness invocation itself is slow or this Lambda retries.
    await ddb.send(new UpdateCommand({
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
      const result = await invokeHarness(prompt, sessionId("wmwatch", wf.workflowId));
      console.log(`[analyzer] WATCH ${wf.workflowId} stopReason=${result.stopReason}`);
      watched.push(wf.workflowId);
    } catch (err) {
      console.error(`[analyzer] WATCH ${wf.workflowId} failed:`, err.message);
    }
  }
  console.log(`[analyzer] watch scan: ${active.length} active, ${watched.length} watched`);
  return { active: active.length, watched };
}

/** Age in ms of the newest non-streaming event, or null if none. */
// Not agent activity: streaming chunks are too chatty to mean anything alone,
// and orchestrator.nudge is a housekeeping event the orchestrator publishes
// itself (a live lease it chose not to steal) — counting either keeps a run
// looking fresh no matter what the agent is doing (TEAM-3969).
const NON_SIGNIFICANT_EVENT_TYPES = new Set(["agent.streaming", "orchestrator.nudge"]);

async function lastSignificantEventAge(workflowId, now) {
  const page = await ddb.send(new QueryCommand({
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

async function invokeHarness(prompt, runtimeSessionId) {
  const { BedrockAgentCoreClient, InvokeHarnessCommand } = await import("@aws-sdk/client-bedrock-agentcore");
  const { NodeHttpHandler } = await import("@smithy/node-http-handler");
  const client = new BedrockAgentCoreClient({
    region: REGION,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 30_000,
      requestTimeout: 840_000, // 14 min read — ANALYZE sessions run long
    }),
  });

  const response = await client.send(new InvokeHarnessCommand({
    harnessArn: WORKFLOW_MANAGER_ARN,
    runtimeSessionId,
    actorId: "workflow-manager",
    timeoutSeconds: 900,
    maxIterations: 75,
    messages: [{ role: "user", content: [{ text: prompt }] }],
  }));

  let text = "";
  let stopReason = "unknown";
  for await (const event of response.stream || []) {
    if (event.contentBlockDelta?.delta?.text) text += event.contentBlockDelta.delta.text;
    if (event.messageStop?.stopReason) stopReason = event.messageStop.stopReason;
    if (event.runtimeClientError) {
      throw new Error(`Harness error: ${event.runtimeClientError.message}`);
    }
  }
  return { text, stopReason };
}
