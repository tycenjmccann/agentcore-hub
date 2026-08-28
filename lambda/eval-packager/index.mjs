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
// Cross-delivery dedup seen-set (TEAM-3376). Set EVAL_SEEN_TABLE='' to disable
// the persistent check entirely (in-memory per-delivery dedup still applies).
const SEEN_TABLE = process.env.EVAL_SEEN_TABLE ?? 'agentcore-hub-eval-seen';
const SEEN_TTL_SECONDS = 24 * 60 * 60;
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

  // TEAM-3376: cross-delivery/concurrent dedup runs BEFORE classification,
  // aggregation and buffering — everything downstream sees the filtered view.
  await dedupeAgainstSeenSet(sessionData, agentId);

  const { statuses, total, spanMissing, errors, throttled, validationErrors } =
    classifySessions(sessionData);
  // duplicatesDropped > 0 with total 0 still emits: a delivery whose every row
  // was a cross-delivery duplicate must surface in EvalDuplicateResultCount.
  if (total > 0 || (sessionData.duplicatesDropped || 0) > 0) {
    emitEvalMetrics(agentId, {
      total,
      spanMissing,
      errors,
      throttles: countThrottles(sessionData.evaluatorResults),
      duplicates: sessionData.duplicatesDropped,
      depChainExcluded: sessionData.depChainExcluded,
      throttledSessions: throttled,
      validationSessions: validationErrors,
    });
    sessionData.sessionStatus = Object.fromEntries(statuses);
    if (spanMissing > 0) sessionData.status = 'span_missing';
    console.log(`[eval-packager] ${agentId}: sessions=${total} span_missing=${spanMissing}`);
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
  //
  // Cross-delivery protection (TEAM-3381 §2.2 gap, closed by TEAM-3376):
  // this runs on rows already filtered by BOTH dedup layers — the in-memory
  // per-delivery pass in extractSessionData and the `agentcore-hub-eval-seen`
  // conditional-write seen-set above (dedupeAgainstSeenSet: PK dedupKey,
  // attribute_not_exists, TTL 24h, FAIL-OPEN) — so the rolling aggregates
  // (evalScores / evalSessionCount / evalStatusCounts) no longer double-count
  // a duplicate that spans two CloudWatch Logs deliveries. The flush-time
  // dedupeBufferedSessions pass remains as defense-in-depth for the batch
  // payload (it also covers records the seen-set failed OPEN on). NOTE from
  // §2.2 still holds: EvalDuplicateResultCount now includes seen-set drops,
  // but to VERIFY the seen-set is working use the §2.2 Logs Insights query
  // grouped by logStream (docs/eval-infrastructure-reliability-design.md).
  await aggregateScoresToDdb(agentId, sessionData.evaluatorResults);

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
 * TEAM-3367: per-record request identity, for dedup. CloudWatch Logs
 * subscription delivery is at-least-once, and the evaluator itself retries —
 * either way the SAME evaluation attempt can land in a delivery several times
 * and double-count scores/sessions downstream. Ranked candidates (live
 * verification of which one production carries was IAM-blocked, so all three
 * are wired as a fallback chain):
 *   (a) the OTEL log-record envelope traceId+spanId — duplicates of one
 *       evaluation attempt share the evaluated span's ids;
 *   (b) attributes['aws.request_id'];
 *   (c) attributes['gen_ai.response.id'].
 * Returns null when none is present (dedupeResults then falls back to a
 * content key).
 */
function extractRequestId(parsedMessage, attrs) {
  const traceId = parsedMessage.traceId || parsedMessage.trace_id;
  const spanId = parsedMessage.spanId || parsedMessage.span_id;
  if (traceId && spanId) return `${traceId}:${spanId}`;
  if (attrs['aws.request_id']) return String(attrs['aws.request_id']);
  if (attrs['gen_ai.response.id']) return String(attrs['gen_ai.response.id']);
  return null;
}

/**
 * Short content fingerprint of a raw log message, used by the no-request-id
 * content key below (TEAM-3381). `timestamp` is logEvent.timestamp, which is a
 * millisecond value shared by every record CloudWatch batched into the same ms
 * — so metadata + timestamp alone cannot tell two distinct results apart.
 * Truncated to 16 hex chars: enough to separate distinct payloads, small enough
 * to ride along in the DDB buffer / S3 batch without bloating it.
 */
export function contentFingerprint(rawMessage) {
  return createHash('sha256').update(String(rawMessage)).digest('hex').slice(0, 16);
}

const isBlankKeyField = (v) => v === null || v === undefined || v === '';

/**
 * TEAM-3381 (AC-1 fail-open): a record with NO usable dedup key at all —
 * no requestId and every content-key discriminator (sessionId, evaluatorName,
 * evaluationName, score) null/absent. Two such records are indistinguishable by
 * key, so deduping them would silently destroy one AND mis-report it as a
 * duplicate. They are always retained instead. Unparseable rows are excluded:
 * they DO have a key (their raw text, see below).
 */
export function hasNoDedupKey(r) {
  return (
    !r.requestId &&
    !r.parseError &&
    isBlankKeyField(r.sessionId) &&
    isBlankKeyField(r.evaluatorName) &&
    isBlankKeyField(r.evaluationName) &&
    isBlankKeyField(r.score)
  );
}

/**
 * TEAM-3376: the stable dedup key for one evaluator-result row — the single
 * keying rule shared by the in-memory pass (dedupeResults), the flush-time
 * re-dedup (dedupeBufferedSessions), and the cross-delivery DynamoDB seen-set
 * (dedupeAgainstSeenSet), whose partition key it is — so it must be stable
 * across deliveries (contentFingerprint is byte-derived, so it is).
 *
 * Keyed by requestId when the record carried one; unparseable rows key on
 * their raw text; everything else takes the content key, whose trailing
 * contentHash separates two distinct results that share metadata AND the
 * delivery's millisecond timestamp (TEAM-3381) while a genuine retry write
 * re-sends the same bytes and still collapses.
 *
 * Returns null for a row with no usable identity at all (hasNoDedupKey above)
 * — such rows FAIL OPEN through every dedup layer: retaining a possible
 * duplicate beats discarding real data.
 */
export function dedupKeyFor(r) {
  if (hasNoDedupKey(r)) return null; // FAIL-OPEN: no identity → never deduped
  if (r.requestId) {
    // evaluatorName rides along with the request id: every metric record an
    // eval run emits about ONE evaluated span (correctness, helpfulness, …)
    // can share that span's trace/span ids, and those are distinct results,
    // not duplicates. Retries of the same record share both fields.
    return `req|${r.requestId}|${r.evaluatorName ?? ''}`;
  }
  if (r.parseError) return `raw|${r.timestamp}|${r.rawMessage}`;
  return `content|${r.sessionId}|${r.evaluatorName}|${r.evaluationName ?? ''}|${r.score}|${r.timestamp}|${r.contentHash ?? ''}`;
}

/**
 * TEAM-3367: drop duplicate evaluator-result rows (first occurrence wins).
 * Keyed by requestId when the record carried one; otherwise by a content key —
 * timestamp inclusion keeps genuinely distinct same-score evaluations apart,
 * while identical retry writes share all the fields. Unparseable rows key on
 * their raw text so two different platform lines that happen to share a
 * timestamp never collapse into one.
 *
 * TEAM-3381: pass `seen` to dedupe ACROSS calls — flushBuffer reuses one set
 * over every buffered delivery so a request id split across two CloudWatch
 * deliveries reaches the flushed payload once (see dedupeBufferedSessions).
 * TEAM-3376 layers the cross-INVOCATION DynamoDB seen-set on top
 * (dedupeAgainstSeenSet), which also protects the DDB rolling aggregates.
 */
export function dedupeResults(records, seen = new Set()) {
  const out = [];
  for (const r of records || []) {
    // Rows carry their key pre-stamped by extractSessionData (the seen-set
    // needs it persisted); hand-built rows in tests compute it on the fly.
    // A null key means hasNoDedupKey → fail open: no key exists, so no
    // duplicate can be proven.
    const key = r.dedupKey !== undefined ? r.dedupKey : dedupKeyFor(r);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(r);
  }
  return out;
}

/**
 * TEAM-3381 (FR-2.1 AC-1/AC-2): re-dedupe a CLAIMED flush buffer across all the
 * deliveries it accumulated. dedupeResults already ran per delivery inside
 * extractSessionData, so every drop here is a CROSS-DELIVERY duplicate: the same
 * request id delivered twice by at-least-once CloudWatch Logs delivery, which
 * pre-fix appeared twice in the flushed batch payload and double-counted in the
 * batch summary the improver reads.
 *
 * Race-free by construction: it runs on the ALL_NEW snapshot flushBuffer already
 * owns, purely in memory, so no DDB read-modify-write is involved.
 *
 * Buffer-entry shape is PRESERVED (the improver payload reads `sessions[].*`,
 * and callers flatMap `evaluatorResults`): an entry whose rows were all dropped
 * stays in place with an empty `evaluatorResults`, keeping its logStream /
 * sessionIds provenance instead of silently vanishing from the batch.
 */
export function dedupeBufferedSessions(buffer) {
  const seen = new Set();
  const sessions = [];
  let crossDeliveryDuplicatesDropped = 0;

  for (const entry of buffer || []) {
    if (!entry || !Array.isArray(entry.evaluatorResults)) {
      sessions.push(entry);
      continue;
    }
    const kept = dedupeResults(entry.evaluatorResults, seen);
    crossDeliveryDuplicatesDropped += entry.evaluatorResults.length - kept.length;
    sessions.push({ ...entry, evaluatorResults: kept });
  }

  return { sessions, crossDeliveryDuplicatesDropped };
}

/**
 * TEAM-3368 §3.2: role scoping for the custom dependency-chain evaluator.
 * The eval configs (setup-evaluations.sh) attach it to requirements_analyst
 * only, but live configs drift — an account may still carry the old
 * qa_verifier/ci_agent configs until the next setup run. Those rows are
 * rubric-mismatch zeros, not quality signal, so drop them here too (defense
 * in depth). The role comes from the session id the orchestrator constructs
 * (lambda/orchestrator/index.mjs): `${ticketPrefix}${workflow.id}-<agentId>-<ms>`
 * — agent ids contain '_' never '-', and the trailing timestamp is a 13-digit
 * millisecond value, so `-(agentcore_hub_...)-<13 digits>$` is unambiguous.
 *
 * FAIL-OPEN by design: a session id we can't parse (absent, malformed, or a
 * non-workflow id like si-…/cc-…) must never cost us a record, and rows for
 * any evaluator other than the dependency-chain family are never touched.
 */
export const ROLE_RE = /-(agentcore_hub_[a-z0-9_]+)-\d{13}$/;
export const DEP_CHAIN_ROLES = new Set(['agentcore_hub_requirements_analyst']);
export const DEP_CHAIN_RE = /^dependency_chain_compliance/;

export function roleFromSessionId(sid) {
  if (typeof sid !== 'string') return null;
  const match = ROLE_RE.exec(sid);
  return match ? match[1] : null;
}

export function isOutOfScopeDepChain(row) {
  if (!DEP_CHAIN_RE.test(row?.evaluatorName ?? '')) return false;
  const role = roleFromSessionId(row.sessionId);
  if (role === null) return false; // fail-open: unattributable → keep
  return !DEP_CHAIN_ROLES.has(role);
}

/**
 * Drop out-of-scope dep-chain rows. Other evaluators' records are never
 * affected, whatever the role parse says. Returns { records, excluded }.
 */
export function applyRoleGuard(records) {
  const kept = [];
  let excluded = 0;
  for (const row of records || []) {
    if (isOutOfScopeDepChain(row)) excluded += 1;
    else kept.push(row);
  }
  return { records: kept, excluded };
}

/**
 * Extract session data from parsed CW Logs event.
 * Parses each logEvent.message as JSON to extract evaluator scores,
 * evaluator name, and evidence. Stores parsed results (not raw event metadata)
 * so the improver agent can synthesize actionable insights from batch payloads.
 *
 * evaluatorResults comes back DEDUPED (TEAM-3367) and role-scoped (TEAM-3368,
 * see isOutOfScopeDepChain above) so classifySessions, the score aggregation,
 * and the buffered batch all see one row per in-scope evaluation attempt;
 * `duplicatesDropped` counts dedup removals and `depChainExcluded` counts
 * scope removals (both feed the handler's emitEvalMetrics EMF record).
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
      const requestId = extractRequestId(parsedMessage, attrs);
      const entry = {
        timestamp: event.timestamp,
        requestId,
        // TEAM-3381: only the content-key path needs a fingerprint, and only
        // records without a request id take it. undefined (like errorFlag below)
        // so it vanishes from JSON/DDB for the common request-id case.
        contentHash: requestId ? undefined : contentFingerprint(event.message),
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
        // Raw OTEL error flag (attributes.error === 1) — some records carry it
        // with no error.type; the score aggregation excludes those from the
        // rolling average. undefined (not null) so it vanishes from JSON/DDB.
        errorFlag: attrs['error'] === 1 ? 1 : undefined,
      };
      // status/statusReason let the improver (and the dashboard) tell an un-scored
      // run apart from a badly-scored one instead of averaging nulls into zeros.
      const row = { ...entry, ...classifyEntry(entry) };
      // dedupKey stamped onto the row (TEAM-3376): the in-memory pass below and
      // the cross-delivery seen-set (dedupeAgainstSeenSet) both key off it.
      row.dedupKey = dedupKeyFor(row);
      sessionBuffer.push(row);
    } catch {
      // If message is not valid JSON, include it as raw text with a flag
      const entry = {
        timestamp: event.timestamp,
        rawMessage: event.message,
        parseError: true,
      };
      const row = { ...entry, ...classifyEntry(entry) };
      row.dedupKey = dedupKeyFor(row);
      sessionBuffer.push(row);
    }
  }

  const deduped = dedupeResults(sessionBuffer);
  const guarded = applyRoleGuard(deduped);
  const evaluatorResults = guarded.records;
  const depChainExcluded = guarded.excluded;
  if (depChainExcluded > 0) {
    console.log(JSON.stringify({
      level: 'warn',
      event: 'eval.depchain.out_of_scope_excluded',
      logGroup: parsed.logGroup,
      excluded: depChainExcluded,
    }));
  }

  return {
    logGroup: parsed.logGroup,
    logStream: parsed.logStream,
    timestamp: new Date().toISOString(),
    sessionIds: [...sessionIds],
    evaluatorResults,
    duplicatesDropped: sessionBuffer.length - deduped.length,
    // Rows that failed OPEN through dedup (no request id and no usable content
    // key) — a rising count means the evaluator's log shape changed under us.
    dedupMissingKeyCount: sessionBuffer.filter((r) => r.dedupKey === null).length,
    depChainExcluded,
  };
}

// Injectable DynamoDB client for the seen-set (tests swap in a fake without
// touching the buffer/config client above). Defaults to the module's doc client.
let seenSetClient = null;
export function setSeenSetClient(client) {
  seenSetClient = client;
}

/**
 * Cross-delivery + concurrent-invocation dedup (TEAM-3376). CW Logs can
 * re-deliver the same log events in a second subscription batch, and two
 * concurrent Lambda invocations can each see a copy — the in-memory pass in
 * extractSessionData can't catch either. Persistent seen-set: one conditional
 * PutItem per keyed record; ConditionalCheckFailedException means another
 * delivery already claimed this dedupKey → drop the row before classification,
 * aggregation and buffering. TTL'd at 24h so the table self-cleans.
 *
 * FAIL-OPEN throughout, matching aggregateScoresToDdb's non-fatal posture:
 * table unset/missing, SDK unavailable, or any non-conditional DDB error →
 * the record is treated as fresh (double-count beats data loss).
 *
 * Mutates sessionData in place: filters evaluatorResults and adds the drops to
 * duplicatesDropped so the EMF duplicate count covers both dedup layers.
 */
export async function dedupeAgainstSeenSet(sessionData, agentId = '') {
  const records = sessionData?.evaluatorResults || [];
  const keyed = records.filter((r) => r.dedupKey);
  if (!SEEN_TABLE || keyed.length === 0) return sessionData;

  let PutCommand;
  try {
    ({ PutCommand } = await import('@aws-sdk/lib-dynamodb'));
  } catch {
    PutCommand = undefined;
  }
  if (!PutCommand) return sessionData; // SDK unavailable → skip gracefully

  const client = seenSetClient || ddb;
  const expiresAt = Math.floor(Date.now() / 1000) + SEEN_TTL_SECONDS;
  const duplicateKeys = new Set();
  let failedOpen = 0;

  for (const record of keyed) {
    try {
      await client.send(
        new PutCommand({
          TableName: SEEN_TABLE,
          Item: { dedupKey: record.dedupKey, expiresAt },
          ConditionExpression: 'attribute_not_exists(dedupKey)',
        })
      );
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') {
        duplicateKeys.add(record.dedupKey);
      } else {
        failedOpen += 1; // any other error → fresh
      }
    }
  }

  if (failedOpen > 0) {
    console.warn(
      `[eval-packager] ${agentId}: seen-set check failed open for ${failedOpen} record(s) ` +
        `(table=${SEEN_TABLE}) — retained; duplicates may double-count.`
    );
  }
  if (duplicateKeys.size > 0) {
    const before = records.length;
    sessionData.evaluatorResults = records.filter((r) => !duplicateKeys.has(r.dedupKey));
    sessionData.duplicatesDropped =
      (sessionData.duplicatesDropped || 0) + (before - sessionData.evaluatorResults.length);
    console.log(
      `[eval-packager] ${agentId}: dropped ${before - sessionData.evaluatorResults.length} ` +
        'cross-delivery duplicate record(s) via seen-set.'
    );
  }
  return sessionData;
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
 * Classify each distinct session in this delivery.
 * Returns { statuses: Map<sessionId, 'scored'|'span_missing'|'error'>, total,
 * spanMissing, errors, throttled, validationErrors, genericErrors }.
 *
 * TEAM-3376: throttled/validationErrors/genericErrors partition the `errors`
 * sessions by error.type suffix — throttle first (a throttled judge often also
 * reports a validation-shaped message downstream), then validation, then
 * everything else. The statuses map keeps the coarse 'error' value: nothing
 * downstream (buffer, dashboard) may flip on the subtype; only the EMF rates
 * read the partition.
 */
export function classifySessions(sessionData) {
  const bySession = new Map();
  for (const r of sessionData.evaluatorResults) {
    if (r.parseError || !r.sessionId) continue;      // unattributable rows
    if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, []);
    bySession.get(r.sessionId).push(r);
  }
  const statuses = new Map();
  let throttled = 0;
  let validationErrors = 0;
  let genericErrors = 0;
  for (const [sid, rows] of bySession) {
    const allNull = rows.every((r) => r.score === null);
    const hasError = rows.some((r) => r.errorType);
    statuses.set(sid, !allNull ? 'scored' : hasError ? 'error' : 'span_missing');
    if (statuses.get(sid) === 'error') {
      if (rows.some((r) => THROTTLE_RE.test(r.errorType ?? ''))) throttled += 1;
      else if (rows.some((r) => VALIDATION_ERROR_RE.test(r.errorType ?? ''))) validationErrors += 1;
      else genericErrors += 1;
    }
  }
  return {
    statuses,
    total: bySession.size,
    spanMissing: [...statuses.values()].filter((s) => s === 'span_missing').length,
    errors: throttled + validationErrors + genericErrors,
    throttled,
    validationErrors,
    genericErrors,
  };
}

/**
 * TEAM-3368 §4.1: judge-quota throttling signature. OTel semconv error.type
 * carries the exception class name, so the exact form is 'ThrottlingException'
 * — but live verification of what the evaluations service writes was
 * IAM-blocked, so match on the suffix to also tolerate a namespaced form
 * (e.g. 'com.amazonaws#ThrottlingException') rather than miss throttles on a
 * prefix we guessed wrong.
 */
export const THROTTLE_RE = /ThrottlingException$/;
// Same suffix-matching rationale as THROTTLE_RE (TEAM-3376): tolerate a
// namespaced error.type rather than miss validation failures on a bad guess.
export const VALIDATION_ERROR_RE = /ValidationException$/;

export function countThrottles(entries) {
  return (entries || []).filter((r) => THROTTLE_RE.test(r?.errorType ?? '')).length;
}

/**
 * Emit fleet eval health metrics as a single EMF log record.
 * CloudWatch Logs auto-extracts these into the AgentCoreHub/Evaluations
 * namespace — no CloudWatch SDK call, no new dependency.
 *
 * TEAM-3368 §4.1 extends the TEAM-3103 record (Total/SpanMissing) with
 * EvalSessionsError, EvalThrottleCount, EvalDuplicateResultCount, plus
 * EvalDepChainExcludedCount (the Part A scope filter's removals). Still ONE
 * record: the eval-health dashboard and the success-rate alarm SEARCH this
 * namespace, and healthy batches must write explicit 0 datapoints (a metric
 * that goes silent is indistinguishable from a broken emitter).
 */
export function emitEvalMetrics(
  agentName,
  {
    total,
    spanMissing,
    errors = 0,
    throttles = 0,
    duplicates = 0,
    depChainExcluded = 0,
    // TEAM-3376: SESSION-level partitions of `errors`, for the rate metrics
    // below (rates over sessions, not records — a single throttled session
    // retried 8 times must read as one throttled session, not eight).
    throttledSessions = 0,
    validationSessions = 0,
  }
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
          { Name: 'EvalSessionsError', Unit: 'Count' },
          { Name: 'EvalThrottleCount', Unit: 'Count' },
          { Name: 'EvalThrottleRate', Unit: 'None' },
          { Name: 'EvalValidationExceptionRate', Unit: 'None' },
          { Name: 'EvalDuplicateResultCount', Unit: 'Count' },
          { Name: 'EvalDepChainExcludedCount', Unit: 'Count' },
        ],
      }],
    },
    AgentName: agentName,
    EvalSessionsTotal: total,
    EvalSessionsSpanMissing: spanMissing,
    EvalSessionsError: errors,
    EvalThrottleCount: throttles,
    EvalThrottleRate: total > 0 ? throttledSessions / total : 0,
    EvalValidationExceptionRate: total > 0 ? validationSessions / total : 0,
    EvalDuplicateResultCount: duplicates,
    EvalDepChainExcludedCount: depChainExcluded,
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
 *
 * Additionally maintains a rolling { success, error, pending, skipped } tally
 * (evalStatusCounts) plus the last error's timestamp/reason, so a dashboard can
 * say "8 of 10 runs never scored" instead of showing an average built from two
 * data points. The score aggregation above is deliberately untouched: a run that
 * errored still must not contribute to evalScores.
 *
 * TEAM-3367: consumes the already-DEDUPED evaluator-result entries from
 * extractSessionData instead of independently re-parsing the raw logEvents —
 * the second raw parse was where duplicate records re-entered and
 * double-counted the rolling sum/count and the session tally.
 *
 * TEAM-3381 flagged the remaining PER-DELIVERY exposure (duplicates spanning
 * two deliveries); TEAM-3376 closes it — the handler runs dedupeAgainstSeenSet
 * (DynamoDB conditional-write seen-set, fail-open) before this call, so the
 * entries are cross-delivery-deduped too. Details at the call site.
 *
 * @param {Array<object>} [entries] classified evaluator-result entries for this
 *   delivery (from extractSessionData, deduped). Optional — omitted or empty
 *   leaves the status tally alone.
 */
async function aggregateScoresToDdb(agentId, entries = []) {
  const sessions = new Set();
  const scoreDeltas = {}; // { evaluatorName: { sum, count } }

  for (const r of entries) {
    if (r.parseError) continue;
    if (r.sessionId) sessions.add(r.sessionId);
    // Same eligibility as the old raw parse: an evaluator name, a finite score
    // (extractSessionData already nulls NaN garbage that would poison the
    // rolling sum), and no error signal (error.type or the raw error===1 flag).
    const hasError = r.errorFlag === 1 || r.errorType;
    if (r.evaluatorName && Number.isFinite(r.score) && !hasError) {
      if (!scoreDeltas[r.evaluatorName]) scoreDeltas[r.evaluatorName] = { sum: 0, count: 0 };
      scoreDeltas[r.evaluatorName].sum += r.score;
      scoreDeltas[r.evaluatorName].count += 1;
    }
  }

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
 *   0. Re-dedupe the merged buffer in memory (TEAM-3381) — pure computation on
 *      the already-claimed batch, so it changes nothing about the ordering below.
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

  // TEAM-3381 (FR-2.1 AC-1/AC-2): re-dedupe the MERGED buffer before anything
  // reads it. Per-delivery dedup (extractSessionData) cannot see a request id
  // that arrived in two separate CloudWatch Logs deliveries; without this the
  // flushed payload carried that record twice and the summary counted it twice.
  // Runs on the already-claimed in-memory batch, so it is race-free, and it is
  // NOT silent: the drop count is logged and rides along in the payload.
  const { sessions, crossDeliveryDuplicatesDropped } = dedupeBufferedSessions(buffer);
  if (crossDeliveryDuplicatesDropped > 0) {
    console.log(JSON.stringify({
      level: 'warn',
      event: 'eval.batch.cross_delivery_duplicates_dropped',
      agentId,
      crossDeliveryDuplicatesDropped,
      bufferEntries: sessions.length,
    }));
  }

  // Roll the whole batch up so the improver prompt leads with "how much of this
  // batch actually got scored" instead of having to infer it from raw records.
  // Pure computation — nothing here touches DDB, so the claim below stays first.
  const summary = computeBatchSummary(
    sessions.flatMap((s) => s?.evaluatorResults || [])
  );

  const batchPayload = {
    agentId,
    batchSize,
    flushedAt: timestamp,
    summary,
    crossDeliveryDuplicatesDropped,
    sessions,
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
    `[eval-packager] FLUSHED | agent=${agentId} | batchSize=${sessions.length} | ` +
      `crossDeliveryDuplicatesDropped=${crossDeliveryDuplicatesDropped} | archived=${batchKey}`
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

// ─── Improver invoke retry policy (TEAM-3367) ───────────────────────────────
// One transient throttle/5xx/socket-reset used to lose the whole synthesis (the
// batch stayed archived but no PRD, no workflow). Bounded retry with full
// jitter, deadline-aware under the Lambda's 600s timeout: each attempt can run
// up to ATTEMPT_TIMEOUT, so a retry is only started while it can still finish
// inside RETRY_DEADLINE.
const IMPROVER_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
  attemptTimeoutMs: 240_000,
  deadlineMs: 520_000,
};

/**
 * FULL-jitter backoff: random(0, min(cap, base * 2**attempt)), attempt 0-based
 * per failed attempt (first retry ≤2s, second ≤4s, capped at 60s). `random`
 * injectable so tests are deterministic.
 */
export function improverBackoffDelayMs(attempt, random = Math.random) {
  return random() * Math.min(IMPROVER_RETRY.maxDelayMs, IMPROVER_RETRY.baseDelayMs * 2 ** attempt);
}

/**
 * Retry ONLY transient failures: throttling (429/ThrottlingException), server
 * errors (5xx) and connection-level socket failures. A 4xx validation error is
 * deterministic — retrying it just burns the deadline.
 */
export function isRetryableImproverError(err) {
  if (typeof err?.statusCode === 'number') {
    return err.statusCode === 429 || err.statusCode >= 500;
  }
  if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN'].includes(err?.code)) {
    return true;
  }
  return /ThrottlingException/i.test(String(err?.message || ''));
}

// TEAM-3376: module-level default timing hooks, below the per-call `deps`
// override. Two injection styles for the same knobs: setRetryHooks() suits
// callers that can't thread deps through (and tests written against it);
// per-call deps win when both are set.
let retryHooks = {};
export function setRetryHooks({ sleep, random, now } = {}) {
  if (sleep) retryHooks.sleep = sleep;
  if (random) retryHooks.random = random;
  if (now) retryHooks.now = now;
}

/**
 * Invoke the improver with bounded, deadline-aware retries (TEAM-3367).
 * `deps` exists for tests: { sleep, random, now } all default to the hooks
 * installed via setRetryHooks(), then to the real thing.
 */
export async function invokeImprover(runtimeArn, prompt, agentId, deps = {}) {
  const sleep = deps.sleep || retryHooks.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = deps.random || retryHooks.random || Math.random;
  const now = deps.now || retryHooks.now || Date.now;

  const start = now();
  let lastErr = null;
  for (let attempt = 0; attempt < IMPROVER_RETRY.maxAttempts; attempt += 1) {
    if (attempt > 0) {
      const elapsed = now() - start;
      if (elapsed + IMPROVER_RETRY.attemptTimeoutMs > IMPROVER_RETRY.deadlineMs) {
        throw new Error(
          `improver retry abandoned after ${attempt} attempt(s): ${Math.round(elapsed / 1000)}s elapsed, ` +
            `another ${IMPROVER_RETRY.attemptTimeoutMs / 1000}s attempt would exceed the ` +
            `${IMPROVER_RETRY.deadlineMs / 1000}s deadline. Last error: ${lastErr?.message}`
        );
      }
      const delayMs = improverBackoffDelayMs(attempt - 1, random);
      console.warn(
        `[eval-packager] ${agentId}: improver attempt ${attempt}/${IMPROVER_RETRY.maxAttempts} failed ` +
          `(${lastErr?.message}) — retrying in ${Math.round(delayMs)}ms`
      );
      await sleep(delayMs);
    }
    try {
      return await invokeImproverOnce(runtimeArn, prompt, agentId);
    } catch (err) {
      lastErr = err;
      if (!isRetryableImproverError(err)) throw err;
    }
  }
  throw lastErr;
}

/**
 * Invoke an AgentCore Runtime via SigV4-signed HTTPS and return the assembled
 * text. The runtime streams SSE "data: {event:{contentBlockDelta:{delta:{text}}}}"
 * frames; we concatenate every delta.text. Mirrors the orchestrator's invoker.
 * Signed per attempt (see invokeImprover): a SigV4 signature is only valid for
 * ~5 minutes, which a backed-off retry can outlive.
 */
async function invokeImproverOnce(runtimeArn, prompt, agentId) {
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
    // Improver runs ~60-90s; allow attemptTimeoutMs (240s) per attempt — the
    // retry loop's deadline math assumes this bound.
    const timer = setTimeout(
      () => reject(new Error(`improver invoke timed out after ${IMPROVER_RETRY.attemptTimeoutMs / 1000}s`)),
      IMPROVER_RETRY.attemptTimeoutMs
    );

    const req = https.default.request(
      {
        hostname: host,
        path: `${urlPath}?accountId=${accountId}`,
        method: 'POST',
        headers: { ...signed.headers },
        timeout: IMPROVER_RETRY.attemptTimeoutMs,
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
            const err = new Error(`improver returned ${res.statusCode}: ${text.slice(0, 300)}`);
            err.statusCode = res.statusCode; // lets isRetryableImproverError tell 429/5xx from 4xx
            reject(err);
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
