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
import { createHash } from 'node:crypto';
import {
  classifyEntry,
  computeBatchSummary,
  emfRecord,
  sessionsMissingSpan,
} from './lib/classify.mjs';

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

  const { statuses, total, spanMissing, throttled, na, resultsTotal, resultsThrottled } =
    classifySessions(sessionData);
  if (total > 0) {
    emitEvalMetrics(agentId, { total, spanMissing, resultsTotal, resultsThrottled });
    sessionData.sessionStatus = Object.fromEntries(statuses);
    if (spanMissing > 0) sessionData.status = 'span_missing';
    console.log(
      `[eval-packager] ${agentId}: sessions=${total} span_missing=${spanMissing} ` +
        `throttled=${throttled} na=${na} results=${resultsTotal} results_throttled=${resultsThrottled}`
    );
  }

  // Preflight alert: any session whose invoke_agent span never arrived is a
  // telemetry failure, not a quality failure. Surface it at INGEST time (and,
  // like the session tally above, before the sample-rate gate) — waiting for
  // the flush hides a broken runtime for a whole batch.
  emitMissingSpanAlerts(agentId, sessionData.evaluatorResults);

  // 4. Sample rate check
  const sampleRate = config.sampleRate ?? 100;
  if (Math.random() * 100 >= sampleRate) {
    console.log(`[eval-packager] Agent ${agentId} sample-rate miss (rate=${sampleRate}%). Skipping.`);
    return { statusCode: 200, body: 'sampled-out' };
  }

  // 5. Aggregate eval scores into DDB (for instant dashboard loads)
  await aggregateScoresToDdb(agentId, parsed, sessionData.evaluatorResults);

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
 * Classify the evaluator-service error on one result entry. Evaluated top-down,
 * first match wins. The string shapes are the VERIFIED live ones from the
 * results log groups (TEAM-3359):
 *   - throttled:                error.type "ThrottlingException",
 *                               error.message "Request <uuid> is being throttled"
 *   - span_missing_validation:  error.type "ValidationException", message names
 *                               the missing gen_ai.operation.name=invoke_agent span
 *   - tool_span_mapping:        error.type "ToolSpanMappingException"
 *   - other:                    any other non-null error.type
 *   - null:                     no error attributes at all
 */
export function classifyError(errorType, errorMessage) {
  if (/throttl/i.test(errorType ?? '') || /ThrottlingException/i.test(errorMessage ?? '')) {
    return 'throttled';
  }
  if (errorType === 'ValidationException' && /invoke_agent/i.test(errorMessage ?? '')) {
    return 'span_missing_validation';
  }
  if (
    /ToolSpanMappingException/i.test(errorType ?? '') ||
    /ToolSpanMappingException/i.test(errorMessage ?? '')
  ) {
    return 'tool_span_mapping';
  }
  if (errorType !== null && errorType !== undefined) return 'other';
  return null;
}

/**
 * True when the evaluator's verdict for this entry is "not applicable" — the
 * rubric had nothing to judge (e.g. dependency_chain on a run with no
 * dependencies). Covers the three shapes we expect to see:
 *   - a categorical label ("NotApplicable" / "not_applicable" / "Not Applicable"),
 *   - the numerical rubric's 4th entry value 2.0 labelled "NotApplicable"
 *     (verified accepted by the live online-evaluations service), and
 *   - the NOT_APPLICABLE sentinel prefix in the explanation text.
 * N/A is a verdict, not a failure: it must never enter sum/count and never
 * count toward error rates.
 */
export function isNotApplicable(entry) {
  const e = entry || {};
  if (typeof e.scoreLabel === 'string' && /^not[\s_-]?applicable$/i.test(e.scoreLabel.trim())) {
    return true;
  }
  if (e.score === 2) return true;
  const explanation = e.evidence ?? e.explanation;
  if (typeof explanation === 'string' && explanation.startsWith('NOT_APPLICABLE')) return true;
  return false;
}

/** The throttled evaluator's own message carries the request UUID — the one
 *  stable identity shared by every duplicate in a throttle cluster. */
const THROTTLE_REQUEST_RE = /Request\s+([0-9a-fA-F-]{36})\s+is being throttled/;

/**
 * Drop duplicate evaluator results WITHIN one CloudWatch Logs delivery.
 *
 * The observed defect (TEAM-3359 F4): one throttled evaluator call emits ~10
 * near-identical entries — one per tool call — in a SINGLE delivery. Within a
 * cluster they share traceId, timeUnixNano and the error.message (one request
 * UUID embedded); only spanIds differ. Left alone they inflate every count
 * (buffer entries, status tallies, resultsThrottled) tenfold.
 *
 * Identity, in preference order:
 *   1. requestId — gen_ai.response.id when present (~27% of entries), else the
 *      UUID embedded in the throttle message. Distinct evaluator invocations
 *      have distinct request UUIDs, so this never collapses separate calls.
 *   2. content hash — sha1 over (sessionId, evaluator, timestamp, errorMessage,
 *      score, scoreLabel, explanation). The explanation is MANDATORY in the
 *      hash: legitimate distinct TOOL_CALL results for the same (session,
 *      evaluator) — e.g. 10 ToolSelectionAccuracy verdicts, one per tool call —
 *      share ONE timeUnixNano and often an identical score/label ("Yes"/1.0),
 *      differing only in explanation. Hashing without it would wrongly collapse
 *      real results (verified against the live results log group, 2026-08-27).
 *
 * Per-delivery ONLY, deliberately: the observed duplication is per-tool-call
 * within one delivery, so this is where the defect lives. A flush-time dedupe
 * (re-scanning the accumulated DDB buffer) was considered and rejected — the
 * reset-first flush path is kept intentionally small so the concurrent-flush
 * duplicate window stays at one DDB write, and scanning the whole buffer there
 * would grow it for a failure mode we have never observed across deliveries.
 *
 * Every entry gets its dedupeKey stamped on it (survivors included) so a
 * buffered batch is auditable: you can see WHY an entry was kept.
 */
export function dedupeEntries(entries) {
  const seen = new Set();
  const deduped = [];
  for (const entry of entries || []) {
    // Unparseable rows have no identity to hash — never drop them, they're the
    // "log format changed under us" signal and are excluded from result counts.
    if (entry.parseError) {
      deduped.push(entry);
      continue;
    }
    const requestId =
      entry.requestId ?? entry.errorMessage?.match(THROTTLE_REQUEST_RE)?.[1] ?? null;
    const timestamp = entry.timeUnixNano ?? entry.timestamp;
    entry.dedupeKey = requestId
      ? `${entry.sessionId}|${entry.evaluatorName}|req:${requestId}`
      : 'sha1:' +
        createHash('sha1')
          .update(
            `${entry.sessionId}|${entry.evaluatorName}|${timestamp}|${entry.errorMessage ?? ''}|` +
              `${entry.score ?? ''}|${entry.scoreLabel ?? ''}|${entry.evidence ?? ''}`
          )
          .digest('hex');
    if (seen.has(entry.dedupeKey)) continue;
    seen.add(entry.dedupeKey);
    deduped.push(entry);
  }
  return deduped;
}

/**
 * Parse one CW logEvent into an evaluator-result entry. Shared by
 * extractSessionData (buffer path) and computeScoreDeltas (scorecard path) so
 * the two consumers see identical entries — and identical dedupe decisions.
 */
function parseLogEvent(event) {
  try {
    const parsedMessage = JSON.parse(event.message);
    // Eval results are OTEL log records: everything lives in attributes under
    // gen_ai.* keys, NOT top-level fields. Reading parsedMessage.score/.evidence
    // produced all-null batches the improver couldn't synthesize from.
    const attrs = parsedMessage.attributes || {};
    const sid = attrs['session.id'] || parsedMessage['session.id'] || null;
    const rawScore = attrs['gen_ai.evaluation.score.value'];
    const numericScore = rawScore !== undefined && rawScore !== null ? Number(rawScore) : null;
    const errorType = attrs['error.type'] || null;
    const errorMessage = attrs['error.message'] || null;
    return {
      timestamp: event.timestamp,
      // Dedupe needs the RECORD's timestamp: duplicates in a throttle cluster
      // share one timeUnixNano even when CW assigns them distinct event times.
      timeUnixNano: parsedMessage.timeUnixNano ?? event.timestamp ?? null,
      sessionId: sid,
      evaluatorName: attrs['gen_ai.evaluation.name'] || parsedMessage.evaluatorName || null,
      // Number(rawScore) coerces non-numeric garbage (e.g. "not-a-number") to
      // NaN, and NaN !== null — that defeated classifySessions' allNull check
      // and marked span_missing sessions as "scored". Store null instead so
      // malformed scores participate in null/error/span_missing classification.
      score: Number.isFinite(numericScore) ? numericScore : null,
      scoreLabel: attrs['gen_ai.evaluation.score.label'] || null,
      evidence: attrs['gen_ai.evaluation.explanation'] || parsedMessage.evidence || null,
      errorType,
      errorMessage,
      errorClass: classifyError(errorType, errorMessage),
      // The numeric error flag (0|1) the evaluator sets alongside error.type —
      // the scorecard's hasError gate reads both.
      errorFlag: attrs['error'] === 1,
      requestId: attrs['gen_ai.response.id'] || null,
    };
  } catch {
    // If message is not valid JSON, include it as raw text with a flag
    return {
      timestamp: event.timestamp,
      rawMessage: event.message,
      parseError: true,
    };
  }
}

/**
 * Extract session data from parsed CW Logs event.
 * Parses each logEvent.message as JSON to extract evaluator scores,
 * evaluator name, and evidence. Stores parsed results (not raw event metadata)
 * so the improver agent can synthesize actionable insights from batch payloads.
 * Entries are deduped (see dedupeEntries) BEFORE anything downstream — the
 * buffer, classifySessions and the missing-span preflight all consume the
 * deduped list, so a throttle cluster counts once everywhere.
 */
export function extractSessionData(parsed) {
  const logEvents = parsed.logEvents || [];
  const sessionIds = new Set();

  const entries = logEvents.map((event) => {
    const entry = parseLogEvent(event);
    // session.id identifies the run (one workflow agent invocation). A single
    // CW Logs delivery can carry several runs; we track distinct ids so the
    // batch counts RUNS, not log deliveries.
    if (entry.sessionId) sessionIds.add(entry.sessionId);
    return entry;
  });

  // status/statusReason let the improver (and the dashboard) tell an un-scored
  // run apart from a badly-scored one instead of averaging nulls into zeros.
  const sessionBuffer = dedupeEntries(entries).map((entry) => ({
    ...entry,
    ...classifyEntry(entry),
  }));

  return {
    logGroup: parsed.logGroup,
    logStream: parsed.logStream,
    timestamp: new Date().toISOString(),
    sessionIds: [...sessionIds],
    evaluatorResults: sessionBuffer,
  };
}

/**
 * Emit one combined structured-log + EMF record per session whose agent
 * invocation span never reached the evaluator.
 *
 * Deliberately narrower than classifySessions below: this fires only on a
 * CONFIRMED missing-span error (or all-null scores alongside an errorType),
 * feeding the per-session agentcore-hub-eval-missing-span alarm, while
 * classifySessions tallies every session for the fleet-level
 * EvalSessionsSpanMissing metric.
 *
 * The single JSON line is doing two jobs: it's greppable in CloudWatch Logs
 * Insights (level/event/agentId/sessionId) AND it publishes the
 * `eval.preflight.missing_span` metric via EMF, which the
 * agentcore-hub-eval-missing-span alarm watches. No PutMetricData call, so no
 * extra IAM and no added latency on the ingest path.
 *
 * Non-fatal by construction: an alerting failure must never cost us the batch.
 */
function emitMissingSpanAlerts(agentId, entries) {
  try {
    const affected = sessionsMissingSpan(entries);
    for (const session of affected) {
      console.log(
        JSON.stringify(
          emfRecord('eval.preflight.missing_span', 1, 'Count', agentId, {
            level: 'error',
            event: 'eval.preflight.missing_span',
            sessionId: session.sessionId,
            statusReason: session.reason,
          })
        )
      );
    }
    if (affected.length > 0) {
      console.warn(
        `[eval-packager] ${agentId}: ${affected.length} session(s) missing the invoke_agent span ` +
          '— these runs were never scored (check runtime telemetry, not agent quality).'
      );
    }
  } catch (err) {
    console.error(`[eval-packager] ${agentId} missing-span alert failed:`, err.message);
  }
}

/**
 * Classify each distinct session in this delivery (post-dedupe entries).
 *
 * First-match-wins matrix, top to bottom:
 *   1. ≥1 finite numeric score that is not N/A            → 'scored'
 *   2. no numeric scores, ≥1 throttled entry              → 'throttled'
 *      (mixed throttled + N/A → throttled: the throttle hid real work)
 *   3. no numeric scores, ≥1 N/A verdict, no non-throttle
 *      errors                                             → 'na'
 *   4. no numeric scores, ≥1 span_missing_validation      → 'span_missing'
 *   5. no numeric scores, ≥1 tool_span_mapping/other error → 'error'
 *   6. all null, no errors (results still streaming in)   → 'span_missing'
 *
 * Returns { statuses: Map<sessionId, status>, total, spanMissing, throttled,
 * na, resultsTotal, resultsThrottled }. resultsTotal/resultsThrottled are
 * ENTRY counts over the deduped delivery (rows with both an evaluator name and
 * a session id; parseError rows excluded) — the denominators the
 * EvalResultsThrottled ratio alarm needs.
 */
export function classifySessions(sessionData) {
  const bySession = new Map();
  let resultsTotal = 0;
  let resultsThrottled = 0;
  for (const r of sessionData.evaluatorResults) {
    if (r.parseError) continue;
    // Rows may come from extractSessionData (errorClass pre-set) or straight
    // from tests/older buffers — classify on the fly when it's absent.
    const errorClass =
      r.errorClass !== undefined ? r.errorClass : classifyError(r.errorType, r.errorMessage);
    if (r.evaluatorName && r.sessionId) {
      resultsTotal += 1;
      if (errorClass === 'throttled') resultsThrottled += 1;
    }
    if (!r.sessionId) continue;                      // unattributable rows
    if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, []);
    bySession.get(r.sessionId).push({ ...r, errorClass });
  }
  const statuses = new Map();
  for (const [sid, rows] of bySession) {
    const hasNumeric = rows.some((r) => Number.isFinite(r.score) && !isNotApplicable(r));
    const hasThrottle = rows.some((r) => r.errorClass === 'throttled');
    const hasNa = rows.some((r) => isNotApplicable(r));
    const hasSpanMissing = rows.some((r) => r.errorClass === 'span_missing_validation');
    const hasOtherError = rows.some(
      (r) => r.errorClass === 'tool_span_mapping' || r.errorClass === 'other'
    );
    let status;
    if (hasNumeric) status = 'scored';
    else if (hasThrottle) status = 'throttled';
    else if (hasNa && !hasSpanMissing && !hasOtherError) status = 'na';
    else if (hasSpanMissing) status = 'span_missing';
    else if (hasOtherError) status = 'error';
    else status = 'span_missing';
    statuses.set(sid, status);
  }
  const tally = (wanted) => [...statuses.values()].filter((s) => s === wanted).length;
  return {
    statuses,
    total: bySession.size,
    spanMissing: tally('span_missing'),
    throttled: tally('throttled'),
    na: tally('na'),
    resultsTotal,
    resultsThrottled,
  };
}

/**
 * Emit fleet eval health metrics as a single EMF log record.
 * CloudWatch Logs auto-extracts these into the AgentCoreHub/Evaluations
 * namespace — no CloudWatch SDK call, no new dependency.
 *
 * Session-level (EvalSessionsTotal/SpanMissing) and entry-level
 * (EvalResultsTotal/Throttled) live in the SAME record: throttling shreds one
 * session into many failed entries, so the throttle alarm needs entry counts
 * while the telemetry alarm needs session counts. Zeros are emitted
 * explicitly — a healthy delivery still writes a datapoint, keeping the
 * alarms' missing-data handling out of the picture.
 */
export function emitEvalMetrics(
  agentName,
  { total, spanMissing, resultsTotal = 0, resultsThrottled = 0 }
) {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'AgentCoreHub/Evaluations',
        Dimensions: [['AgentName']],
        Metrics: [
          { Name: 'EvalSessionsTotal', Unit: 'Count' },
          { Name: 'EvalSessionsSpanMissing', Unit: 'Count' },
          { Name: 'EvalResultsTotal', Unit: 'Count' },
          { Name: 'EvalResultsThrottled', Unit: 'Count' },
        ],
      }],
    },
    AgentName: agentName,
    EvalSessionsTotal: total,
    EvalSessionsSpanMissing: spanMissing,
    EvalResultsTotal: resultsTotal,
    EvalResultsThrottled: resultsThrottled,
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

/** Future categorical rubrics may score by label only. Mapped ONLY when
 *  score.value is absent — and deliberately NOT Yes/No, whose numeric meaning
 *  is evaluator-specific. */
const CATEGORICAL_LABEL_SCORES = { correct: 1.0, partial: 0.5, failed: 0.0 };

/**
 * Pure per-delivery scorecard aggregation — the loop aggregateScoresToDdb
 * merges into DDB, extracted so tests can exercise the deltas without a
 * DynamoDB client (the read-modify-write around it stays untested, matching
 * the rest of this file).
 *
 * Consumes raw logEvents and runs the SAME parse + dedupe as
 * extractSessionData (shared parseLogEvent/dedupeEntries), so a throttle
 * cluster that was collapsed to one buffered entry also counts once — never
 * ten times — here.
 *
 * Per entry, in order:
 *   1. no evaluator name → skip (nothing to attribute the score to)
 *   2. N/A verdict → naCount, BEFORE the score gate: the rubric encodes N/A as
 *      score 2.0 / label "NotApplicable", which is a verdict of "nothing to
 *      judge", not a datum — it must never enter sum/count and never read as a
 *      failure.
 *   3. errored entry (numeric error flag or error.type) → skip; a throttled
 *      call sometimes carries a numeric-looking score.value and must still
 *      never enter the scorecard.
 *   4. finite numeric score → sum/count. When score.value is null, a
 *      categorical Correct/Partial/Failed label maps to 1.0/0.5/0.0.
 *
 * @returns {{ scoreDeltas: Record<string, {sum:number,count:number,naCount?:number}>,
 *             sessions: Set<string> }}
 */
export function computeScoreDeltas(logEvents) {
  const sessions = new Set();
  const scoreDeltas = {}; // { evaluatorName: { sum, count, naCount } }
  const delta = (evaluator) =>
    (scoreDeltas[evaluator] ??= { sum: 0, count: 0, naCount: 0 });

  for (const entry of dedupeEntries((logEvents || []).map(parseLogEvent))) {
    if (entry.parseError) continue;
    if (entry.sessionId) sessions.add(entry.sessionId);
    if (!entry.evaluatorName) continue;

    if (isNotApplicable(entry)) {
      delta(entry.evaluatorName).naCount += 1;
      continue;
    }

    const hasError = entry.errorFlag || entry.errorType;
    // Number.isFinite gate: non-numeric garbage coerces to NaN, which would
    // otherwise poison the rolling sum/count in the DDB scorecard.
    let numericScore = Number.isFinite(entry.score) ? entry.score : null;
    if (numericScore === null && typeof entry.scoreLabel === 'string') {
      numericScore = CATEGORICAL_LABEL_SCORES[entry.scoreLabel.trim().toLowerCase()] ?? null;
    }
    if (Number.isFinite(numericScore) && !hasError) {
      const d = delta(entry.evaluatorName);
      d.sum += numericScore;
      d.count += 1;
    }
  }

  return { scoreDeltas, sessions };
}

/**
 * Aggregate evaluation scores into DDB for instant dashboard reads.
 * Maintains a rolling scorecard: { evaluatorName: { sum, count, naCount } }
 * and a session count. Read-modify-write with low contention. naCount is an
 * additive field — the dashboard route reads only sum/count, so older rows
 * without it stay readable.
 *
 * Additionally maintains a rolling { success, error, pending, skipped } tally
 * (evalStatusCounts) plus the last error's timestamp/reason, so a dashboard can
 * say "8 of 10 runs never scored" instead of showing an average built from two
 * data points. The score aggregation above is deliberately untouched: a run that
 * errored still must not contribute to evalScores.
 *
 * @param {Array<object>} [entries] classified evaluator-result entries for this
 *   delivery (from extractSessionData). Optional — omitted or empty leaves the
 *   status tally alone.
 */
async function aggregateScoresToDdb(agentId, parsed, entries = []) {
  const { scoreDeltas, sessions } = computeScoreDeltas(parsed.logEvents || []);

  if (Object.keys(scoreDeltas).length === 0 && sessions.size === 0) return;

  try {
    // Read current scorecard
    const { Item } = await ddb.send(new GetCommand({
      TableName: TABLE,
      Key: { agentId },
      ProjectionExpression: 'evalScores, evalSessionCount, evalStatusCounts',
    }));

    const existing = Item?.evalScores || {};
    const existingSessions = Item?.evalSessionCount || 0;

    // Merge deltas
    for (const [evaluator, delta] of Object.entries(scoreDeltas)) {
      if (!existing[evaluator]) existing[evaluator] = { sum: 0, count: 0 };
      existing[evaluator].sum += delta.sum;
      existing[evaluator].count += delta.count;
      if (delta.naCount) {
        existing[evaluator].naCount = (existing[evaluator].naCount || 0) + delta.naCount;
      }
    }

    // Merge this delivery's status tally on top of the stored one. Same
    // read-modify-write shape as evalScores above, and it can't fail on a
    // first write the way a nested `evalStatusCounts.success` path update would.
    const deliverySummary = computeBatchSummary(entries);
    const statusCounts = {
      success: 0,
      error: 0,
      pending: 0,
      skipped: 0,
      ...(Item?.evalStatusCounts || {}),
    };
    statusCounts.success += deliverySummary.successCount;
    statusCounts.error += deliverySummary.errorCount;
    statusCounts.pending += deliverySummary.nullCount;
    statusCounts.skipped += deliverySummary.skippedCount;

    const now = new Date().toISOString();
    const updateExpr = [
      'evalScores = :scores',
      'evalSessionCount = :sc',
      'evalLastScoredAt = :now',
      'evalStatusCounts = :statusCounts',
    ];
    const values = {
      ':scores': existing,
      ':sc': existingSessions + sessions.size,
      ':now': now,
      ':statusCounts': statusCounts,
    };

    // Only stamp the last-error fields when this delivery actually errored —
    // otherwise a clean delivery would erase the breadcrumb we need to debug.
    if (deliverySummary.errorCount > 0) {
      const firstError = (entries || []).find((e) => e.status === 'error');
      updateExpr.push('evalLastErrorAt = :errAt', 'evalLastErrorReason = :errReason');
      values[':errAt'] = now;
      values[':errReason'] = String(firstError?.statusReason || 'unknown eval error').slice(0, 200);
    }

    // Write merged scorecard
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { agentId },
      UpdateExpression: 'SET ' + updateExpr.join(', '),
      ExpressionAttributeValues: values,
    }));

    console.log(
      `[eval-packager] ${agentId}: aggregated ${Object.keys(scoreDeltas).length} evaluators, ${sessions.size} sessions ` +
        `(delivery: ${deliverySummary.successCount} success / ${deliverySummary.errorCount} error / ` +
        `${deliverySummary.nullCount} pending / ${deliverySummary.skippedCount} skipped)`
    );
  } catch (err) {
    // Non-fatal — don't break the buffer/flush pipeline
    console.error(`[eval-packager] ${agentId} score aggregation failed:`, err.message);
  }
}

/**
 * Flush the session buffer. ORDER MATTERS:
 *   1. Reset the DDB buffer FIRST (the batch is already captured in memory).
 *   2. Archive the raw batch to batches/.
 *   3. Synthesize a PRD via the Fleet Improver and write it to prd/ — UNLESS the
 *      batch carries no evidence (see the evidence guard below), in which case
 *      the batch is archived and the loop stops here.
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

  // Roll the whole batch up so the improver prompt leads with "how much of this
  // batch actually got scored" instead of having to infer it from raw records.
  // Pure computation — nothing here touches DDB, so the claim below stays first.
  const summary = computeBatchSummary(
    (buffer || []).flatMap((s) => s?.evaluatorResults || [])
  );

  const batchPayload = {
    agentId,
    batchSize,
    flushedAt: timestamp,
    summary,
    sessions: buffer,
  };

  // Batch health metric — the agentcore-hub-eval-null-or-error-rate-high alarm
  // watches this. Non-fatal: never lose a batch over a metric line.
  try {
    console.log(
      JSON.stringify(
        emfRecord('eval.batch.null_or_error_rate', summary.nullOrErrorRate, 'Percent', agentId, {
          successCount: summary.successCount,
          errorCount: summary.errorCount,
          nullCount: summary.nullCount,
          skippedCount: summary.skippedCount,
          scoredTotal: summary.scoredTotal,
          totalCount: summary.totalCount,
        })
      )
    );
  } catch (err) {
    console.error(`[eval-packager] ${agentId} batch metric emit failed:`, err.message);
  }

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

  // 3. Evidence guard — do NOT synthesize a PRD from a batch that contains no
  //    evidence. Two shapes qualify: nothing was ever scored (scoredTotal === 0)
  //    or everything the evaluator attempted failed (rate at the 100 maximum).
  //    Both mean the runtime/telemetry pipeline is broken, and a PRD built from
  //    them is the improver hallucinating quality findings out of zero data —
  //    which then starts a 14-agent workflow and opens a PR against a phantom.
  //    The archive above is deliberately untouched: the batch stays on S3 for
  //    debugging, we just don't act on it. Checked here rather than inside
  //    synthesizeAndWritePrd so the suppression is logged whether or not
  //    IMPROVER_ARN is configured.
  if (summary.scoredTotal === 0 || summary.nullOrErrorRate >= 100) {
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'eval.prd.synthesis_suppressed',
        agentId,
        reason:
          summary.scoredTotal === 0
            ? 'no evaluator-attempted entries in batch (scoredTotal=0)'
            : 'every evaluator-attempted entry failed (nullOrErrorRate at maximum)',
        scoredTotal: summary.scoredTotal,
        nullOrErrorRate: summary.nullOrErrorRate,
        successCount: summary.successCount,
        errorCount: summary.errorCount,
        nullCount: summary.nullCount,
        skippedCount: summary.skippedCount,
        totalCount: summary.totalCount,
        archivedKey: batchKey,
      })
    );
    console.warn(
      `[eval-packager] ${agentId}: PRD synthesis SUPPRESSED — scoredTotal=${summary.scoredTotal}, ` +
        `nullOrErrorRate=${summary.nullOrErrorRate}%. Batch archived at ${batchKey}; no workflow triggered. ` +
        'Fix the eval/telemetry pipeline, not the agent.'
    );
    return;
  }

  // 4. Synthesize a PRD from the batch and write it to prd/ (triggers the loop).
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
