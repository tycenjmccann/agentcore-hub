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
    // Let the final completions/*.json S3 writes land before the dossier pull.
    await sleep(ANALYZE_DELAY_MS);
  }

  const defId = workflow.workflowDefId || "software-delivery";
  const phase = TERMINAL_PHASES.has(workflow.phase) ? workflow.phase : "complete";
  const prompt =
    `ANALYZE ${workflowId} (defId=${defId}, outcome=${phase}, trigger=${trigger})\n` +
    `Title: ${workflow.input?.title || "(untitled)"}`;

  const result = await invokeHarness(prompt, sessionId("wm", workflowId));
  console.log(`[analyzer] ANALYZE ${workflowId} stopReason=${result.stopReason} chars=${result.text.length}`);
  return { workflowId, trigger, stopReason: result.stopReason, summary: result.text.slice(0, 500) };
}

// ─── WATCH ─────────────────────────────────────────────────────────────────────

async function watchScan() {
  const now = Date.now();
  const active = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: WORKFLOWS_TABLE,
      ProjectionExpression: "workflowId, phase, archived, managerWatch, wmLastWatchAt, startedAt, workflowDefId",
      ExclusiveStartKey,
    }));
    active.push(...(page.Items || []).filter(
      (w) => !TERMINAL_PHASES.has(w.phase) && !w.archived && w.managerWatch !== false
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
