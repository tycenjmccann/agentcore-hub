/**
 * lambda/eval-packager/index.mjs
 *
 * Eval Packager Lambda — processes CloudWatch Logs events for fleet agents,
 * applies per-agent evaluation controls (enabled flag, sample rate), buffers
 * sessions in DynamoDB, and flushes batches to S3 when the buffer reaches
 * the configured batchSize.
 *
 * On flush it ALSO invokes the Fleet Improver runtime to synthesize an
 * improvement PRD from the batch, then writes that PRD to the prd/ prefix —
 * which triggers prd-submitter → the 14-agent workflow → a fix PR. This is the
 * synthesis step the loop was missing: without it, raw batches reached
 * prd-submitter with no title/description and produced "[SI] undefined" runs.
 *
 * Environment Variables:
 *   EVAL_CONFIG_TABLE       — DynamoDB table name (default: agentcore-hub-eval-config)
 *   ARTIFACTS_BUCKET        — S3 bucket for batch + PRD output
 *   IMPROVEMENT_AGENT_ARN   — Fleet Improver runtime ARN (preferred). If unset,
 *                             flush archives the raw batch but skips synthesis.
 *   IMPROVEMENT_AGENT_ID    — legacy name-only fallback (combined with
 *                             AWS_ACCOUNT_ID + region to build an ARN)
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
// Raw eval batches are archived here (NOT the prd/ prefix that prd-submitter
// watches — keeping them separate stops un-synthesized batches from triggering
// a workflow). The synthesized PRD goes to PRD_PREFIX.
const BATCH_PREFIX = 'fleet-imp-agent/batches';
const PRD_PREFIX = 'fleet-imp-agent/prd';
const AGENTS_CONFIG_KEY = 'config/agents.json';
const REGION = process.env.AWS_REGION || 'us-east-1';

// Fleet Improver runtime: prefer an explicit ARN, else build one from the
// legacy name + account id. Empty → synthesis is skipped (batch archived only).
const IMPROVER_ARN =
  process.env.IMPROVEMENT_AGENT_ARN ||
  (process.env.IMPROVEMENT_AGENT_ID && process.env.AWS_ACCOUNT_ID
    ? `arn:aws:bedrock-agentcore:${REGION}:${process.env.AWS_ACCOUNT_ID}:runtime/${process.env.IMPROVEMENT_AGENT_ID}`
    : '');

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

  // Extract session data from log events (enriched with parsed evaluator results).
  // Done BEFORE the sample-rate gate below: telemetry health (span_missing) must
  // be measured on ALL deliveries, not just the sampled subset that gets buffered.
  const sessionData = extractSessionData(parsed);

  const { statuses, total, spanMissing } = classifySessions(sessionData);
  if (total > 0) {
    emitEvalMetrics(agentId, { total, spanMissing });
    sessionData.sessionStatus = Object.fromEntries(statuses);
    if (spanMissing > 0) sessionData.status = 'span_missing';
    console.log(`[eval-packager] ${agentId}: sessions=${total} span_missing=${spanMissing}`);
  }

  // 4. Sample rate check
  const sampleRate = config.sampleRate ?? 100;
  if (Math.random() * 100 >= sampleRate) {
    console.log(`[eval-packager] Agent ${agentId} sample-rate miss (rate=${sampleRate}%). Skipping.`);
    return { statusCode: 200, body: 'sampled-out' };
  }

  // 5. Aggregate eval scores into DDB (for instant dashboard loads)
  await aggregateScoresToDdb(agentId, parsed);

  // 6. Append to sessionBuffer, counting distinct runs toward batchSize
  const batchSize = config.batchSize || 10;
  const appended = await appendToBuffer(agentId, sessionData, batchSize);

  if (appended.shouldFlush) {
    // Flush cooldown: batchSize alone doesn't bound PRD rate — every persona
    // on the shared runtime counts toward the same agent's batch, and each
    // synthesized PRD starts a 14-agent workflow whose runs feed the NEXT
    // batch. During a busy stretch that produced a PRD (and a workflow) every
    // ~10 minutes, self-sustaining. Hold the full buffer until the cooldown
    // elapses; runs keep accumulating and flush in one bigger batch.
    const cooldownMin = config.flushCooldownMinutes ?? 60;
    const lastFlushed = config.lastFlushedAt ? Date.parse(config.lastFlushedAt) : 0;
    const sinceMin = (Date.now() - lastFlushed) / 60000;
    if (sinceMin < cooldownMin) {
      console.log(
        `[eval-packager] Agent ${agentId}: batch full but cooling down ` +
          `(${sinceMin.toFixed(1)}/${cooldownMin} min since last flush) — holding.`
      );
      return { statusCode: 200, body: 'cooldown' };
    }
    // 7. Batch is full → flush to S3 + synthesize PRD
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
export function extractSessionData(parsed) {
  const logEvents = parsed.logEvents || [];
  const sessionBuffer = [];
  const sessionIds = new Set();

  for (const event of logEvents) {
    try {
      const parsedMessage = JSON.parse(event.message);
      // session.id identifies the run (one workflow agent invocation). A single
      // CW Logs delivery can carry several runs; we track distinct ids so the
      // batch counts RUNS, not log deliveries.
      const attrs = parsedMessage.attributes || {};
      const sid = attrs['session.id'] || parsedMessage['session.id'] || null;
      if (sid) sessionIds.add(sid);
      // Eval results are OTEL log records: everything lives in attributes under
      // gen_ai.* keys, NOT top-level fields. Reading parsedMessage.score/.evidence
      // produced all-null batches the improver couldn't synthesize from.
      const rawScore = attrs['gen_ai.evaluation.score.value'];
      const numericScore = rawScore !== undefined && rawScore !== null ? Number(rawScore) : null;
      sessionBuffer.push({
        timestamp: event.timestamp,
        sessionId: sid,
        evaluatorName: attrs['gen_ai.evaluation.name'] || parsedMessage.evaluatorName || null,
        // Number(rawScore) coerces non-numeric garbage (e.g. "not-a-number") to
        // NaN, and NaN !== null — that defeated classifySessions' allNull check
        // and marked span_missing sessions as "scored". Store null instead so
        // malformed scores participate in null/error/span_missing classification.
        score: Number.isFinite(numericScore) ? numericScore : null,
        scoreLabel: attrs['gen_ai.evaluation.score.label'] || null,
        evidence: attrs['gen_ai.evaluation.explanation'] || parsedMessage.evidence || null,
        errorType: attrs['error.type'] || null,
        errorMessage: attrs['error.message'] || null,
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
    sessionIds: [...sessionIds],
    evaluatorResults: sessionBuffer,
  };
}

/**
 * Classify each distinct session in this delivery.
 * Returns { statuses: Map<sessionId, 'scored'|'span_missing'|'error'>, total, spanMissing }
 */
export function classifySessions(sessionData) {
  const bySession = new Map();
  for (const r of sessionData.evaluatorResults) {
    if (r.parseError || !r.sessionId) continue;      // unattributable rows
    if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, []);
    bySession.get(r.sessionId).push(r);
  }
  const statuses = new Map();
  for (const [sid, rows] of bySession) {
    const allNull = rows.every((r) => r.score === null);
    const hasError = rows.some((r) => r.errorType);
    statuses.set(sid, !allNull ? 'scored' : hasError ? 'error' : 'span_missing');
  }
  return {
    statuses,
    total: bySession.size,
    spanMissing: [...statuses.values()].filter((s) => s === 'span_missing').length,
  };
}

/**
 * Emit fleet span_missing health metrics as a single EMF log record.
 * CloudWatch Logs auto-extracts these into the AgentCoreHub/Evaluations
 * namespace — no CloudWatch SDK call, no new dependency.
 */
export function emitEvalMetrics(agentName, { total, spanMissing }) {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'AgentCoreHub/Evaluations',
        Dimensions: [['AgentName']],
        Metrics: [
          { Name: 'EvalSessionsTotal', Unit: 'Count' },
          { Name: 'EvalSessionsSpanMissing', Unit: 'Count' },
        ],
      }],
    },
    AgentName: agentName,
    EvalSessionsTotal: total,
    EvalSessionsSpanMissing: spanMissing,
  }));
}

/**
 * Append eval data to the buffer and track DISTINCT runs (session ids).
 *
 * batchSize is a count of RUNS, not log deliveries: one CloudWatch Logs delivery
 * can carry several runs, and one run can span several deliveries. We accumulate
 * the run's eval data in `sessionBuffer` and the distinct run ids in the
 * `bufferSessions` string set, flushing only when batchSize distinct runs have
 * been seen. (The old code flushed per `sessionBuffer.length`, i.e. per delivery,
 * so it fired after ~1-2 runs instead of 10.)
 *
 * Returns { shouldFlush: boolean, buffer: array | null }
 */
async function appendToBuffer(agentId, sessionData, batchSize) {
  const sids = (sessionData.sessionIds || []).filter(Boolean);

  const expr = ['sessionBuffer = list_append(sessionBuffer, :new)', 'lastUpdatedAt = :now'];
  const values = { ':new': [sessionData], ':now': new Date().toISOString() };
  let updateExpression = 'SET ' + expr.join(', ');
  if (sids.length > 0) {
    // ADD into a string set → distinct run ids only.
    updateExpression += ' ADD bufferSessions :sids';
    values[':sids'] = new Set(sids);
  }

  const result = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { agentId },
      UpdateExpression: updateExpression,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    })
  );

  const buffer = result.Attributes.sessionBuffer || [];
  const runIds = result.Attributes.bufferSessions; // DynamoDBDocument unmarshals a Set
  const runCount = runIds ? (runIds.size ?? (Array.isArray(runIds) ? runIds.length : 0)) : 0;
  const shouldFlush = runCount >= batchSize;

  console.log(
    `[eval-packager] Agent ${agentId}: distinct runs=${runCount}/${batchSize} ` +
      `(buffer entries=${buffer.length})` + (shouldFlush ? ' → FLUSH' : '')
  );

  return { shouldFlush, buffer };
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
      const numericScore = score !== undefined && score !== null ? Number(score) : null;
      // Number.isFinite gate: non-numeric garbage coerces to NaN, which would
      // otherwise poison the rolling sum/count in the DDB scorecard.
      if (evaluator && Number.isFinite(numericScore) && !hasError) {
        if (!scoreDeltas[evaluator]) scoreDeltas[evaluator] = { sum: 0, count: 0 };
        scoreDeltas[evaluator].sum += numericScore;
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
 * Flush the session buffer. ORDER MATTERS:
 *   1. Reset the DDB buffer FIRST (the batch is already captured in memory).
 *   2. Archive the raw batch to batches/.
 *   3. Synthesize a PRD via the Fleet Improver and write it to prd/.
 *
 * The reset must happen before the (60–240s) synthesis call, not after. If it
 * came last, the run set would stay at batchSize for the whole synthesis
 * window — any concurrent invocation for the same agent would see
 * shouldFlush=true, re-read the SAME batch, and flush it again → duplicate
 * PRD + duplicate workflow. Resetting first keeps the duplicate window at one
 * DDB write (~100ms).
 */
async function flushBuffer(agentId, buffer, batchSize) {
  const timestamp = new Date().toISOString();

  const batchPayload = {
    agentId,
    batchSize,
    flushedAt: timestamp,
    sessions: buffer,
  };

  // 1. Reset sessionBuffer AND the distinct-run set in DDB FIRST — claim the
  //    batch so concurrent invocations append into a fresh buffer instead of
  //    re-flushing this one.
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { agentId },
      UpdateExpression:
        'SET sessionBuffer = :empty, lastFlushedAt = :ts, lastUpdatedAt = :ts REMOVE bufferSessions',
      ExpressionAttributeValues: {
        ':empty': [],
        ':ts': timestamp,
      },
    })
  );
  console.log(`[eval-packager] Agent ${agentId}: buffer + run set reset (batch claimed for flush).`);

  // 2. Archive the raw batch (batches/ prefix — does NOT trigger prd-submitter)
  const batchKey = `${BATCH_PREFIX}/batch-${agentId}-${timestamp}.json`;
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: batchKey,
      Body: JSON.stringify(batchPayload, null, 2),
      ContentType: 'application/json',
    })
  );
  console.log(
    `[eval-packager] FLUSHED | agent=${agentId} | batchSize=${buffer.length} | archived=${batchKey}`
  );

  // 3. Synthesize a PRD from the batch and write it to prd/ (triggers the loop).
  //    Best-effort: a transient improver failure leaves the batch archived and
  //    the buffer already reset, so the flush never wedges.
  try {
    await synthesizeAndWritePrd(agentId, batchPayload, timestamp);
  } catch (err) {
    console.error(
      `[eval-packager] ${agentId}: PRD synthesis failed (batch archived at ${batchKey}, no workflow triggered):`,
      err.message
    );
  }
}

/**
 * Invoke the Fleet Improver runtime with the batch, read its JSON PRD
 * ({ title, description }), and write the result to the prd/ prefix.
 * prd-submitter (S3 → EventBridge) picks it up and enters the 14-agent pipeline.
 */
async function synthesizeAndWritePrd(agentId, batchPayload, timestamp) {
  if (!IMPROVER_ARN) {
    console.warn(
      `[eval-packager] ${agentId}: IMPROVEMENT_AGENT_ARN/ID not set — skipping PRD synthesis. ` +
        `Set it so flush can invoke the improver.`
    );
    return;
  }

  const prompt =
    'Analyze this batch of agent evaluation sessions and produce an improvement PRD ' +
    'following your output format.\n\nBatch:\n' +
    JSON.stringify(batchPayload);

  console.log(`[eval-packager] ${agentId}: invoking improver ${IMPROVER_ARN.split('/').pop()}`);
  const raw = await invokeImprover(IMPROVER_ARN, prompt, agentId);

  if (!raw || raw.trim().length === 0) {
    throw new Error('improver returned empty output');
  }

  const { title, description } = extractPrd(raw, agentId);
  const prd = {
    title,
    description,
    agentId,
    generatedAt: timestamp,
    // IntakeSource shape: { type, value, label } — NOT a bare string. The
    // workflow-start validator reads source.value; a string crashes it.
    sources: [
      {
        type: 's3',
        value: `s3://${BUCKET}/${BATCH_PREFIX}/batch-${agentId}-${timestamp}.json`,
        label: `eval batch for ${agentId}`,
      },
    ],
  };

  const prdKey = `${PRD_PREFIX}/prd-${agentId}-${timestamp}.json`;
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: prdKey,
      Body: JSON.stringify(prd, null, 2),
      ContentType: 'application/json',
    })
  );
  console.log(
    `[eval-packager] ${agentId}: PRD synthesized (${description.length} chars) → ${prdKey}`
  );
}

/**
 * Read the improver's JSON PRD into a PR-ready { title, description }.
 * The improver is instructed to return a single JSON object {title, description}.
 * We tolerate a leading/trailing code fence or stray prose by extracting the
 * outermost {...} before parsing. Title/description fall back to safe defaults
 * so a malformed response degrades gracefully instead of wedging the flush.
 */
function extractPrd(raw, agentId) {
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Strip a ```json fence or surrounding prose, then take the outermost object.
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        parsed = JSON.parse(raw.slice(start, end + 1));
      } catch {
        /* fall through to defaults */
      }
    }
  }

  let title = (parsed?.title || '').toString().trim();
  let description = (parsed?.description || '').toString().trim();

  // Graceful degradation: never drop the batch just because the model drifted
  // from the JSON contract. Use the raw text as the body, derive a generic title.
  if (!description) description = raw.trim();
  if (!title) title = `Improve ${agentId} based on evaluation findings`;

  title = title.replace(/`/g, '').replace(/\*\*/g, '').slice(0, 120).trim();

  return { title, description };
}

/**
 * Invoke an AgentCore Runtime via SigV4-signed HTTPS and return the assembled
 * text. The runtime streams SSE "data: {event:{contentBlockDelta:{delta:{text}}}}"
 * frames; we concatenate every delta.text. Mirrors the orchestrator's invoker.
 */
async function invokeImprover(runtimeArn, prompt, agentId) {
  const https = await import('https');
  const { SignatureV4 } = await import('@smithy/signature-v4');
  const { Sha256 } = await import('@aws-crypto/sha256-js');
  const { defaultProvider } = await import('@aws-sdk/credential-provider-node');

  const payload = JSON.stringify({
    prompt,
    workflow_id: 'self-improvement',
    agent_id: agentId,
  });

  const runtimeId = runtimeArn.split('/').pop();
  const accountId = runtimeArn.split(':')[4];
  const host = `bedrock-agentcore.${REGION}.amazonaws.com`;
  const urlPath = `/runtimes/${encodeURIComponent(runtimeId)}/invocations`;
  // Session id must be >= 33 chars per AgentCore; pad deterministically.
  const sessionId = `si-${agentId}-${Date.now()}`.padEnd(33, '-').slice(0, 80);

  const signer = new SignatureV4({
    service: 'bedrock-agentcore',
    region: REGION,
    credentials: defaultProvider(),
    sha256: Sha256,
  });

  const signed = await signer.sign({
    method: 'POST',
    protocol: 'https:',
    hostname: host,
    path: urlPath,
    query: { accountId },
    headers: {
      host,
      'content-type': 'application/json',
      'x-amzn-bedrock-agentcore-runtime-session-id': sessionId,
    },
    body: payload,
  });

  return new Promise((resolve, reject) => {
    // Improver runs ~60-90s; allow 240s (under the Lambda's 300s ceiling).
    const timer = setTimeout(() => reject(new Error('improver invoke timed out after 240s')), 240_000);

    const req = https.default.request(
      {
        hostname: host,
        path: `${urlPath}?accountId=${accountId}`,
        method: 'POST',
        headers: { ...signed.headers },
        timeout: 240_000,
      },
      (res) => {
        let buffer = '';
        let text = '';

        const consume = (line) => {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) return;
          try {
            const ev = JSON.parse(trimmed.slice(5).trim());
            const t = ev?.event?.contentBlockDelta?.delta?.text;
            if (t) text += t;
            // Non-SSE fallback shapes
            if (!t && ev?.text) text += ev.text;
          } catch {
            /* non-JSON frame */
          }
        };

        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) consume(line);
        });

        res.on('end', () => {
          clearTimeout(timer);
          if (buffer) consume(buffer);
          if (res.statusCode >= 400) {
            reject(new Error(`improver returned ${res.statusCode}: ${text.slice(0, 300)}`));
          } else {
            resolve(text);
          }
        });

        res.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      }
    );

    req.on('socket', (socket) => {
      socket.setKeepAlive(true, 30_000);
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.write(payload);
    req.end();
  });
}
