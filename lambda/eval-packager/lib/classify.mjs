/**
 * lambda/eval-packager/lib/classify.mjs
 *
 * Pure classification helpers for eval log records. ZERO AWS imports and zero
 * side effects on purpose — this module is imported directly by unit tests, so
 * it must be loadable without credentials, env vars, or a Lambda context.
 *
 * The problem it exists to solve: an eval delivery whose records carry
 * `error.type=ValidationException` / "none of the spans contain the required
 * agent invocation" is NOT a low-scoring run — it's a run that never got
 * scored, because the runtime never exported the `invoke_agent` span. Folding
 * those into the score average makes a broken telemetry pipeline look like a
 * 0/10 quality problem. Everything here keeps the two apart.
 */

/** Cap a string at `max` chars so a pathological error message can't blow up a DDB item or a log line. */
function truncate(value, max) {
  const s = value === null || value === undefined ? '' : String(value);
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * The evaluator's own words when the `invoke_agent` span never reached the
 * unified telemetry destination. Matched case-insensitively because the
 * evaluator service has capitalized this differently across versions.
 */
const MISSING_SPAN_RE = /none of the spans contain the required agent invocation/i;

/**
 * True when this record is the eval service telling us the agent invocation
 * span was missing (i.e. a telemetry failure, not a quality failure).
 *
 * The second arm — ValidationException with no score — is the same condition
 * surfaced without the descriptive message, which is how it arrives when the
 * evaluator rejects the session before scoring.
 */
export function isMissingSpanError(entry) {
  if (!entry) return false;
  if (MISSING_SPAN_RE.test(entry.errorMessage || '')) return true;
  return entry.errorType === 'ValidationException' && entry.score === null;
}

/**
 * Classify one extracted evaluator-result entry.
 *
 * Ordered — first match wins:
 *   skipped — unparseable, or a record with no identity and no error at all
 *   error   — the eval service reported an error for this record
 *   success — a real score, no error
 *   pending — a well-formed record whose score hasn't been delivered yet
 *             (eval results arrive across several CW Logs deliveries)
 *
 * @returns {{status: 'skipped'|'error'|'success'|'pending', statusReason: string}}
 */
export function classifyEntry(entry) {
  const e = entry || {};
  const hasError = Boolean(e.errorType || e.errorMessage);

  // 1. skipped — nothing here to reason about.
  if (e.parseError === true) {
    return { status: 'skipped', statusReason: 'unparseable log record' };
  }
  if (!e.sessionId && !e.evaluatorName && !hasError) {
    return { status: 'skipped', statusReason: 'unparseable log record' };
  }

  // 2. error — surfaced verbatim so the batch (and the dashboard) can show why.
  if (hasError) {
    const reason =
      e.errorType && e.errorMessage
        ? `${e.errorType}: ${e.errorMessage}`
        : String(e.errorType || e.errorMessage);
    return { status: 'error', statusReason: truncate(reason, 500) };
  }

  // 3. success — a delivered score.
  if (e.score !== null && e.score !== undefined) {
    return { status: 'success', statusReason: 'scored' };
  }

  // 4. pending — the score may still be coming.
  return { status: 'pending', statusReason: 'no score in delivered records yet' };
}

/**
 * Find the sessions in a delivery whose agent invocation span never arrived.
 *
 * A session is affected when either:
 *   - any of its records matches isMissingSpanError(), or
 *   - none of its records scored AND at least one reported an errorType
 *     (the generic shape of "this session was rejected before scoring")
 *
 * Records with no sessionId are ignored — there's nothing to attribute them to.
 *
 * @returns {Array<{agentId: string|null, sessionId: string, reason: string}>}
 */
export function sessionsMissingSpan(entries) {
  const bySession = new Map();
  for (const entry of entries || []) {
    const sid = entry?.sessionId;
    if (!sid) continue;
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push(entry);
  }

  const affected = [];
  for (const [sessionId, group] of bySession) {
    const explicit = group.find((e) => isMissingSpanError(e));
    const allNull = group.every((e) => e.score === null || e.score === undefined);
    const anyErrorType = group.some((e) => Boolean(e.errorType));

    if (!explicit && !(allNull && anyErrorType)) continue;

    const source = explicit || group.find((e) => e.errorType) || group[0];
    const reason =
      source.errorMessage ||
      (source.errorType
        ? `${source.errorType} (no score delivered for this session)`
        : 'no score delivered for this session');

    affected.push({
      agentId: source.agentId ?? null,
      sessionId,
      reason: truncate(reason, 500),
    });
  }

  return affected;
}

/**
 * Roll a set of entries up into the counts that ride along with a flushed batch.
 * `nullCount` is the pending bucket — kept under that name because it's what the
 * improver prompt and the dashboard already read.
 *
 * nullOrErrorRate is the health signal we alarm on: a high rate means the batch
 * is full of un-scored runs, which is a pipeline problem, not a quality problem.
 */
export function computeBatchSummary(entries) {
  const list = entries || [];
  let successCount = 0;
  let errorCount = 0;
  let nullCount = 0;
  let skippedCount = 0;

  for (const entry of list) {
    const status = entry?.status || classifyEntry(entry).status;
    if (status === 'success') successCount += 1;
    else if (status === 'error') errorCount += 1;
    else if (status === 'skipped') skippedCount += 1;
    else nullCount += 1;
  }

  const totalCount = list.length;
  return {
    successCount,
    errorCount,
    nullCount,
    skippedCount,
    totalCount,
    nullOrErrorRate: totalCount ? Math.round((100 * (errorCount + nullCount)) / totalCount) : 0,
  };
}

/**
 * Build a CloudWatch Embedded Metric Format payload. console.log(JSON.stringify(...))
 * of the result publishes `metricName` with no PutMetricData call and no extra IAM.
 *
 * Dimensions [["agentId"], []] publishes BOTH the per-agent series and the
 * dimensionless fleet aggregate — the alarms in
 * deploy/continuous-improvement/deploy.sh watch the aggregate.
 */
export function emfRecord(metricName, value, unit, agentId, extraFields = {}) {
  return {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'AgentCoreHub/Evaluations',
          Dimensions: [['agentId'], []],
          Metrics: [{ Name: metricName, Unit: unit }],
        },
      ],
    },
    agentId,
    [metricName]: value,
    ...extraFields,
  };
}
