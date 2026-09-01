/**
 * Workflow Analyzer trigger Lambda — thin dispatcher for the Workflow Manager
 * harness (agentcore_hub_workflow_manager). All analysis, persistence, and
 * intervention logic lives in the harness + its toolkit; this Lambda only
 * decides WHEN to invoke it.
 *
 * Trigger shapes:
 *   1. EventBridge {source: "agentcore-hub.orchestrator", detail-type:
 *      "workflow.complete"} → ANALYZE (auto, idempotent)
 *   2. Direct invoke {workflowId, trigger: "manual"} → ANALYZE (re-runs allowed)
 *   3. EventBridge schedule {action: "watch"} → scan live runs, WATCH stale ones
 *
 * Env: WORKFLOW_MANAGER_ARN (harness ARN), ANALYSES_TABLE, WORKFLOWS_TABLE,
 *      EVENTS_TABLE, WM_STALE_MINUTES (default 10), WM_WATCH_COOLDOWN_MINUTES
 *      (default 15), WM_ANALYZE_DELAY_MS (default 30000).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-1";
const WORKFLOW_MANAGER_ARN = process.env.WORKFLOW_MANAGER_ARN;
const ANALYSES_TABLE = process.env.ANALYSES_TABLE || "agentcore-hub-workflow-analyses";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";
const STALE_MS = Number(process.env.WM_STALE_MINUTES || 10) * 60_000;
const COOLDOWN_MS = Number(process.env.WM_WATCH_COOLDOWN_MINUTES || 15) * 60_000;
const ANALYZE_DELAY_MS = Number(process.env.WM_ANALYZE_DELAY_MS || 30_000);

const TERMINAL_PHASES = new Set(["complete", "cancelled", "error"]);
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

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

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
    const result = await invokeHarness(prompt, sessionId("wm", workflowId));
    console.log(`[analyzer] ANALYZE ${workflowId} stopReason=${result.stopReason} chars=${result.text.length}`);
    // System-SI check rides the ANALYZE that just persisted a new analysis.
    // Failures are logged, never thrown: a synthesis hiccup must not release
    // the auto-claim and re-run a completed analysis.
    let synthesis = null;
    try {
      synthesis = await maybeSynthesize();
    } catch (err) {
      console.error(`[analyzer] SI synthesis check failed:`, err.message);
    }
    return { workflowId, trigger, stopReason: result.stopReason, synthesis, summary: result.text.slice(0, 500) };
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
      ProjectionExpression: "workflowId, phase, archived, managerWatch, wmLastWatchAt, startedAt, workflowDefId, humanNotifications",
      ExclusiveStartKey,
    }));
    active.push(...(page.Items || []).filter(
      (w) => !TERMINAL_PHASES.has(w.phase) && !w.archived && w.managerWatch !== false && !parkedOnHuman(w)
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
async function lastSignificantEventAge(workflowId, now) {
  const page = await ddb.send(new QueryCommand({
    TableName: EVENTS_TABLE,
    KeyConditionExpression: "workflowId = :w",
    ExpressionAttributeValues: { ":w": workflowId },
    ScanIndexForward: false,
    Limit: 25,
  }));
  const item = (page.Items || []).find((e) => e.type !== "agent.streaming") || (page.Items || [])[0];
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
