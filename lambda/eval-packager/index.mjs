/**
 * lambda/eval-packager/index.mjs
 *
 * Eval Packager Lambda — processes CloudWatch Logs events for fleet agents,
 * applies per-agent evaluation controls (enabled flag, sample rate), buffers
 * sessions in DynamoDB, and flushes batches to S3 when the buffer reaches
 * the configured batchSize.
 *
 * Environment Variables:
 *   EVAL_CONFIG_TABLE  — DynamoDB table name (default: agentcore-hub-eval-config)
 *   ARTIFACTS_BUCKET   — S3 bucket for batch output
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { gunzipSync } from 'zlib';

// ─── Clients ────────────────────────────────────────────────────────────────
const ddbRaw = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbRaw, {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});

// ─── Config ─────────────────────────────────────────────────────────────────
const TABLE = process.env.EVAL_CONFIG_TABLE || 'agentcore-hub-eval-config';
const BUCKET = process.env.ARTIFACTS_BUCKET || process.env.ARTIFACT_BUCKET;
if (!BUCKET) {
  throw new Error(
    'ARTIFACTS_BUCKET (or ARTIFACT_BUCKET) env var is required. ' +
      'Convention: agentcore-hub-artifacts-{ACCOUNT_ID}-{REGION}'
  );
}
const S3_PREFIX = 'fleet-imp-agent/prd';
const AGENTS_CONFIG_KEY = 'config/agents.json';

// ─── Agent ID Resolution (loaded from S3, cached for warm starts) ───────────
let agents = null;

/**
 * Load agents.json from S3 once per warm start.
 */
async function loadAgents() {
  if (agents) return agents;

  const response = await s3.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: AGENTS_CONFIG_KEY })
  );
  const body = await response.Body.transformToString();
  agents = JSON.parse(body).agents || [];
  console.log(`[eval-packager] Loaded ${agents.length} agents from agents.json`);
  return agents;
}

/**
 * Resolve canonical agent id by matching the log group against each agent's
 * evalConfigName (e.g., "eval_requirements_analyst" appears as a substring
 * of "/aws/bedrock-agentcore/evaluations/results/eval_requirements_analyst-FO0D1sFZfY").
 */
function resolveAgentId(logGroup, agentList) {
  const match = agentList.find(
    (a) => a.evalConfigName && logGroup.includes(a.evalConfigName)
  );
  return match?.agentId || null;
}

// ─── Handler ────────────────────────────────────────────────────────────────
export const handler = async (event) => {
  // Decode CloudWatch Logs payload
  const payload = Buffer.from(event.awslogs.data, 'base64');
  const parsed = JSON.parse(gunzipSync(payload).toString());
  const logGroup = parsed.logGroup || '';

  // 1. Resolve agentId from the log group via agents.json evalConfigName
  const agentList = await loadAgents();
  const agentId = resolveAgentId(logGroup, agentList);
  if (!agentId) {
    console.log('[eval-packager] No matching agent for log group:', logGroup);
    return { statusCode: 200, body: 'no-match' };
  }
  console.log(`[eval-packager] Processing event for agent: ${agentId}`);

  // 2. Read agent config from DynamoDB
  const config = await getAgentConfig(agentId);
  if (!config) {
    console.log(`[eval-packager] No config found for agent: ${agentId}. Skipping.`);
    return { statusCode: 200, body: 'no-config' };
  }

  // 3. Check enabled flag
  if (config.enabled === false) {
    console.log(`[eval-packager] Agent ${agentId} is disabled. Skipping.`);
    return { statusCode: 200, body: 'disabled' };
  }

  // 4. Sample rate check
  const sampleRate = config.sampleRate ?? 100;
  if (Math.random() * 100 >= sampleRate) {
    console.log(`[eval-packager] Agent ${agentId} sample-rate miss (rate=${sampleRate}%). Skipping.`);
    return { statusCode: 200, body: 'sampled-out' };
  }

  // Extract session data from log events (enriched with parsed evaluator results)
  const sessionData = extractSessionData(parsed);

  // 5. Aggregate eval scores into DDB (for instant dashboard loads)
  await aggregateScoresToDdb(agentId, parsed);

  // 6. Atomic append to sessionBuffer with size guard
  const batchSize = config.batchSize || 10;
  const appended = await appendToBuffer(agentId, sessionData, batchSize);

  if (appended.shouldFlush) {
    // 7. Buffer is full → flush to S3
    await flushBuffer(agentId, appended.buffer, batchSize);
  }

  return { statusCode: 200, body: 'ok' };
};

// ─── Helper Functions ───────────────────────────────────────────────────────

/**
 * Read agent eval config from DynamoDB.
 */
async function getAgentConfig(agentId) {
  const result = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { agentId },
    })
  );
  return result.Item || null;
}

/**
 * Extract session data from parsed CW Logs event.
 * Parses each logEvent.message as JSON to extract evaluator scores,
 * evaluator name, and evidence. Stores parsed results (not raw event metadata)
 * so the improver agent can synthesize actionable insights from batch payloads.
 */
function extractSessionData(parsed) {
  const logEvents = parsed.logEvents || [];
  const sessionBuffer = [];

  for (const event of logEvents) {
    try {
      const parsedMessage = JSON.parse(event.message);
      sessionBuffer.push({
        timestamp: event.timestamp,
        evaluatorName: parsedMessage.evaluatorName || parsedMessage.name || null,
        score: parsedMessage.score ?? parsedMessage.evaluatorScore ?? null,
        evidence: parsedMessage.evidence || parsedMessage.reasoning || null,
        metadata: parsedMessage.metadata || null,
        result: parsedMessage.result || null,
      });
    } catch {
      // If message is not valid JSON, include it as raw text with a flag
      sessionBuffer.push({
        timestamp: event.timestamp,
        rawMessage: event.message,
        parseError: true,
      });
    }
  }

  return {
    logGroup: parsed.logGroup,
    logStream: parsed.logStream,
    timestamp: new Date().toISOString(),
    evaluatorResults: sessionBuffer,
  };
}

/**
 * Atomic append to the sessionBuffer in DDB.
 * Uses ConditionExpression to prevent exceeding batchSize.
 * Returns { shouldFlush: boolean, buffer: array | null }
 */
async function appendToBuffer(agentId, sessionData, batchSize) {
  try {
    const result = await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { agentId },
        UpdateExpression:
          'SET sessionBuffer = list_append(sessionBuffer, :new), lastUpdatedAt = :now',
        ConditionExpression: 'size(sessionBuffer) < :max',
        ExpressionAttributeValues: {
          ':new': [sessionData],
          ':max': batchSize,
          ':now': new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      })
    );

    const buffer = result.Attributes.sessionBuffer || [];
    const shouldFlush = buffer.length >= batchSize;

    console.log(
      `[eval-packager] Agent ${agentId}: buffer size=${buffer.length}/${batchSize}` +
        (shouldFlush ? ' → FLUSH' : '')
    );

    return { shouldFlush, buffer };
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      // 7. Buffer was already full (race condition) — flush then retry
      console.log(
        `[eval-packager] Agent ${agentId}: ConditionalCheckFailedException — buffer full. Flushing and retrying.`
      );
      await handleOverflow(agentId, sessionData, batchSize);
      return { shouldFlush: false, buffer: null };
    }
    throw err;
  }
}

/**
 * Handle overflow: read current buffer, flush it, reset, then retry append.
 */
async function handleOverflow(agentId, sessionData, batchSize) {
  // Read current buffer
  const config = await getAgentConfig(agentId);
  const currentBuffer = config?.sessionBuffer || [];

  // Flush the full buffer
  if (currentBuffer.length > 0) {
    await flushBuffer(agentId, currentBuffer, batchSize);
  }

  // Retry the append (buffer has been reset by flushBuffer)
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { agentId },
        UpdateExpression:
          'SET sessionBuffer = list_append(sessionBuffer, :new), lastUpdatedAt = :now',
        ConditionExpression: 'size(sessionBuffer) < :max',
        ExpressionAttributeValues: {
          ':new': [sessionData],
          ':max': batchSize,
          ':now': new Date().toISOString(),
        },
      })
    );
    console.log(`[eval-packager] Agent ${agentId}: retry append succeeded after overflow flush.`);
  } catch (retryErr) {
    console.error(
      `[eval-packager] Agent ${agentId}: retry append failed after overflow flush:`,
      retryErr.message
    );
    throw retryErr;
  }
}

/**
 * Aggregate evaluation scores into DDB for instant dashboard reads.
 * Maintains a rolling scorecard: { evaluatorName: { sum, count } }
 * and a session count. Read-modify-write with low contention.
 */
async function aggregateScoresToDdb(agentId, parsed) {
  const logEvents = parsed.logEvents || [];
  const sessions = new Set();
  const scoreDeltas = {}; // { evaluatorName: { sum, count } }

  for (const event of logEvents) {
    try {
      const record = JSON.parse(event.message);
      const attrs = record.attributes || {};
      const evaluator = attrs['gen_ai.evaluation.name'];
      const score = attrs['gen_ai.evaluation.score.value'];
      const sessionId = attrs['session.id'] || '';
      const hasError = attrs['error'] === 1 || attrs['error.type'];

      if (sessionId) sessions.add(sessionId);
      if (evaluator && score !== undefined && score !== null && !hasError) {
        if (!scoreDeltas[evaluator]) scoreDeltas[evaluator] = { sum: 0, count: 0 };
        scoreDeltas[evaluator].sum += Number(score);
        scoreDeltas[evaluator].count += 1;
      }
    } catch { /* skip */ }
  }

  if (Object.keys(scoreDeltas).length === 0 && sessions.size === 0) return;

  try {
    // Read current scorecard
    const { Item } = await ddb.send(new GetCommand({
      TableName: TABLE,
      Key: { agentId },
      ProjectionExpression: 'evalScores, evalSessionCount',
    }));

    const existing = Item?.evalScores || {};
    const existingSessions = Item?.evalSessionCount || 0;

    // Merge deltas
    for (const [evaluator, delta] of Object.entries(scoreDeltas)) {
      if (!existing[evaluator]) existing[evaluator] = { sum: 0, count: 0 };
      existing[evaluator].sum += delta.sum;
      existing[evaluator].count += delta.count;
    }

    // Write merged scorecard
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { agentId },
      UpdateExpression: 'SET evalScores = :scores, evalSessionCount = :sc, evalLastScoredAt = :now',
      ExpressionAttributeValues: {
        ':scores': existing,
        ':sc': existingSessions + sessions.size,
        ':now': new Date().toISOString(),
      },
    }));

    console.log(`[eval-packager] ${agentId}: aggregated ${Object.keys(scoreDeltas).length} evaluators, ${sessions.size} sessions`);
  } catch (err) {
    // Non-fatal — don't break the buffer/flush pipeline
    console.error(`[eval-packager] ${agentId} score aggregation failed:`, err.message);
  }
}

/**
 * Flush the session buffer to S3 and reset the DDB buffer.
 */
async function flushBuffer(agentId, buffer, batchSize) {
  const timestamp = new Date().toISOString();
  const s3Key = `${S3_PREFIX}/batch-${agentId}-${timestamp}.json`;

  const batchPayload = {
    agentId,
    batchSize,
    flushedAt: timestamp,
    sessions: buffer,
  };

  // Write batch to S3
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: s3Key,
      Body: JSON.stringify(batchPayload, null, 2),
      ContentType: 'application/json',
    })
  );

  console.log(
    `[eval-packager] FLUSHED | agent=${agentId} | batchSize=${buffer.length} | s3Key=${s3Key}`
  );

  // Reset sessionBuffer in DDB
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { agentId },
      UpdateExpression: 'SET sessionBuffer = :empty, lastFlushedAt = :ts, lastUpdatedAt = :ts',
      ExpressionAttributeValues: {
        ':empty': [],
        ':ts': timestamp,
      },
    })
  );

  console.log(`[eval-packager] Agent ${agentId}: buffer reset after flush.`);
}
