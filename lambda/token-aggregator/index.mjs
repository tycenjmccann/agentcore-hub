/**
 * Token Aggregator Lambda
 *
 * Triggered by CW Logs subscription filters on all runtime log groups.
 * Filter pattern: "gen_ai.client.token.usage"
 *
 * Parses token usage from OTEL metric records and atomically increments
 * counters in the agentcore-hub-eval-config DynamoDB table.
 *
 * Also handles a weekly "reset" event from EventBridge to zero counters.
 *
 * Environment Variables:
 *   EVAL_CONFIG_TABLE — DynamoDB table (default: agentcore-hub-eval-config)
 *   ARTIFACTS_BUCKET  — S3 bucket for agents.json lookup
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { gunzipSync } from 'zlib';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});

const TABLE = process.env.EVAL_CONFIG_TABLE || 'agentcore-hub-eval-config';
const BUCKET = process.env.ARTIFACTS_BUCKET || process.env.ARTIFACT_BUCKET;
if (!BUCKET) {
  throw new Error(
    'ARTIFACTS_BUCKET (or ARTIFACT_BUCKET) env var is required. ' +
      'Convention: agentcore-hub-artifacts-{ACCOUNT_ID}-{REGION}'
  );
}
const AGENTS_KEY = 'config/agents.json';

// ─── Agent resolution (cached per warm start) ──────────────────────────────
let agentsCache = null;

async function loadAgents() {
  if (agentsCache) return agentsCache;
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: AGENTS_KEY }));
  const body = await resp.Body.transformToString();
  agentsCache = JSON.parse(body).agents || [];
  return agentsCache;
}

function resolveAgentId(logGroup, agents) {
  // Log group: /aws/bedrock-agentcore/runtimes/agentcore_hub_requirements_analyst-QGqEkp772T-DEFAULT
  const match = agents.find(a => a.agentId && logGroup.includes(a.agentId));
  return match?.agentId || null;
}

// ─── Handler ────────────────────────────────────────────────────────────────
export const handler = async (event) => {
  // Weekly reset from EventBridge
  if (event.action === 'reset' || event['detail-type'] === 'token-reset') {
    return await resetAllCounters();
  }

  // CW Logs subscription payload
  if (!event.awslogs?.data) {
    console.log('[token-agg] No awslogs data, skipping');
    return { statusCode: 200 };
  }

  const payload = Buffer.from(event.awslogs.data, 'base64');
  const parsed = JSON.parse(gunzipSync(payload).toString());
  const logGroup = parsed.logGroup || '';

  const agents = await loadAgents();
  const agentId = resolveAgentId(logGroup, agents);
  if (!agentId) {
    console.log('[token-agg] No agent match for:', logGroup);
    return { statusCode: 200 };
  }

  // Parse token events
  let deltaIn = 0;
  let deltaOut = 0;
  const modelDeltas = {}; // { modelId: { input: N, output: N } }

  for (const logEvent of parsed.logEvents || []) {
    try {
      const msg = logEvent.message || '';
      const braceIdx = msg.indexOf('{');
      if (braceIdx < 0) continue;
      const record = JSON.parse(msg.slice(braceIdx));

      const tokenType = record['gen_ai.token.type'];
      const usage = Number(record['gen_ai.client.token.usage']?.Sum) || 0;
      const model = record['gen_ai.request.model'] || 'unknown';

      if (!usage) continue;
      if (!modelDeltas[model]) modelDeltas[model] = { input: 0, output: 0 };

      if (tokenType === 'input') {
        deltaIn += usage;
        modelDeltas[model].input += usage;
      } else if (tokenType === 'output') {
        deltaOut += usage;
        modelDeltas[model].output += usage;
      }
    } catch { /* skip malformed */ }
  }

  if (deltaIn === 0 && deltaOut === 0) {
    return { statusCode: 200, body: 'no-tokens' };
  }

  // Atomic increment totals + merge byModel map
  const now = new Date().toISOString();
  try {
    // Step 1: ADD the atomic totals
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { agentId },
      UpdateExpression: `
        ADD tokenTotalInput :di, tokenTotalOutput :do
        SET tokenLastEventAt = :now,
            tokenWindowStart = if_not_exists(tokenWindowStart, :now)
      `,
      ExpressionAttributeValues: {
        ':di': deltaIn,
        ':do': deltaOut,
        ':now': now,
      },
    }));

    // Step 2: Merge byModel (read-modify-write; low contention so safe)
    if (Object.keys(modelDeltas).length > 0) {
      const { Item } = await ddb.send(
        new (await import('@aws-sdk/lib-dynamodb')).GetCommand({
          TableName: TABLE,
          Key: { agentId },
          ProjectionExpression: 'tokenByModel',
        })
      );
      const existing = Item?.tokenByModel || {};
      for (const [model, delta] of Object.entries(modelDeltas)) {
        if (!existing[model]) existing[model] = { input: 0, output: 0 };
        existing[model].input += delta.input;
        existing[model].output += delta.output;
      }
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { agentId },
        UpdateExpression: 'SET tokenByModel = :bm',
        ExpressionAttributeValues: { ':bm': existing },
      }));
    }

    console.log(`[token-agg] ${agentId}: +${deltaIn} in / +${deltaOut} out`);
  } catch (err) {
    console.error(`[token-agg] ${agentId} DDB update failed:`, err.message);
  }

  return { statusCode: 200, body: 'ok' };
};

// ─── Weekly Reset ───────────────────────────────────────────────────────────
async function resetAllCounters() {
  const now = new Date().toISOString();
  let lastKey;
  let reset = 0;
  do {
    const result = await ddb.send(new ScanCommand({
      TableName: TABLE,
      ExclusiveStartKey: lastKey,
      ProjectionExpression: 'agentId',
    }));
    for (const item of result.Items || []) {
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { agentId: item.agentId },
        UpdateExpression: `
          SET tokenTotalInput = :z, tokenTotalOutput = :z,
              tokenByModel = :empty, tokenWindowStart = :now,
              tokenLastResetAt = :now
        `,
        ExpressionAttributeValues: { ':z': 0, ':empty': {}, ':now': now },
      }));
      reset++;
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  console.log(`[token-agg] Reset ${reset} agents`);
  return { statusCode: 200, body: `reset ${reset} agents` };
}
