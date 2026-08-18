/**
 * Routines Runner Lambda
 *
 * Trigger: EventBridge Scheduler — one schedule per routine, target = this Lambda,
 * input = {"routineId": "rt-..."}. Scheduler → Lambda is IAM-internal; this
 * function has NO public URL and NO open resource policy.
 *
 * On each fire: load the routine from DynamoDB, build the workflow-start payload
 * from its input template, POST it to the workflow API, and write lastRun back.
 * Mirrors lambda/prd-submitter/index.mjs (EventBridge → POST /api/workflow/start).
 *
 * Environment:
 *   ROUTINES_TABLE   - DynamoDB routines table (default agentcore-hub-routines)
 *   WORKFLOW_API_URL - workflow API base URL (App Runner / ECS)
 *   AWS_REGION       - region
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE = process.env.ROUTINES_TABLE || "agentcore-hub-routines";
const WORKFLOW_API = process.env.WORKFLOW_API_URL;

if (!WORKFLOW_API) throw new Error("WORKFLOW_API_URL env var required");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

/**
 * Build the /api/workflow/start payload from a routine input template.
 * Keep in sync with src/lib/routines/payload.ts::buildStartPayload.
 */
function buildPayload(input, firedAt) {
  const date = firedAt.toISOString().slice(0, 10);
  const title = String(input.titleTemplate || "Scheduled routine").replace(/\{date\}/g, date);
  const payload = {
    title,
    description: input.description || "",
    workflowDefId: input.workflowDefId,
    sources: input.sources || [],
  };
  if (input.repoConfig) payload.repoConfig = input.repoConfig;
  if (input.modelOverride) payload.modelOverride = input.modelOverride;
  if (Array.isArray(input.connectors) && input.connectors.length) payload.connectors = input.connectors;
  return payload;
}

async function recordLastRun(routineId, lastRun) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { routineId },
    UpdateExpression: "SET lastRun = :lr, updatedAt = :now",
    ExpressionAttributeValues: { ":lr": lastRun, ":now": new Date().toISOString() },
  }));
}

export async function handler(event) {
  const routineId = event?.routineId || event?.detail?.routineId;
  if (!routineId) {
    console.error("[routines-runner] no routineId in event", JSON.stringify(event));
    return { statusCode: 400, body: "routineId required" };
  }

  console.log(`[routines-runner] firing ${routineId}`);

  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { routineId } }));
  const routine = res.Item;
  if (!routine) {
    console.error(`[routines-runner] routine ${routineId} not found — skipping`);
    return { statusCode: 404, body: "routine not found" };
  }
  if (routine.enabled === false) {
    console.log(`[routines-runner] routine ${routineId} disabled — skipping`);
    return { statusCode: 200, body: "disabled" };
  }

  const payload = buildPayload(routine.input || {}, new Date());
  const firedAt = new Date().toISOString();

  // Timeout the POST well under the Lambda's 30s so a hung workflow API surfaces as
  // one clean failure — not a Lambda timeout that leaves Scheduler retrying blind.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);

  try {
    const resp = await fetch(`${WORKFLOW_API}/api/workflow/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const error = data.error || `HTTP ${resp.status}`;
      console.error(`[routines-runner] API ${resp.status}: ${JSON.stringify(data)}`);
      await recordLastRun(routineId, { at: firedAt, status: "failed", error });
      // 4xx = permanent client error (bad def, validation). Return 200 so Scheduler
      // does NOT retry it 185× — a retry can't fix a malformed routine. 5xx is
      // transient → throw so Scheduler retries (bounded) then DLQs.
      if (resp.status >= 400 && resp.status < 500) {
        return { statusCode: 200, body: `terminal client error (not retried): ${error}` };
      }
      throw new Error(`workflow API ${resp.status}: ${error}`);
    }
    const workflowId = data.workflowId || data.id;
    console.log(`[routines-runner] ${routineId} → workflow ${workflowId}`);
    await recordLastRun(routineId, { at: firedAt, status: "started", workflowId });
    return { statusCode: 200, body: JSON.stringify({ routineId, workflowId }) };
  } catch (err) {
    console.error(`[routines-runner] ${routineId} error:`, err);
    await recordLastRun(routineId, { at: firedAt, status: "failed", error: String(err?.message || err) });
    // Re-throw so Scheduler counts a failed invoke → bounded retry → DLQ.
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
