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
 * Judge-declined markers seen in `gen_ai.evaluation.score.label` (the field
 * extractSessionData lands in `scoreLabel`). The judge sometimes answers "I'm
 * not scoring this one" instead of erroring — that's an evaluation that
 * produced no score, and it must not be mistaken for a pending delivery.
 *
 * Anchored at the start, and the marker must end the word — `(?![a-z0-9])`
 * rather than `\b`, so a suffixed variant ("skipped_no_input") still matches
 * while a label that merely starts with the letters ("skipworthy_pass") and
 * real verdicts ("pass", "fail", "partially_correct") never do.
 */
const JUDGE_DECLINED_LABEL_RE =
  /^\s*(skip|skipped|declined?|not[_\s-]?applicable|n\/?a|unable[_\s-]?to[_\s-]?evaluate)(?![a-z0-9])/i;

/** True when a score.label says the judge declined to score this record. */
function isJudgeDeclinedLabel(label) {
  return typeof label === 'string' && JUDGE_DECLINED_LABEL_RE.test(label);
}

/**
 * True when this record is the eval service telling us the agent invocation
 * span was missing (i.e. a telemetry failure, not a quality failure).
 *
 * ONLY the descriptive message counts. A bare `ValidationException` with no
 * score used to qualify too, which meant every unrelated validation failure
 * (bad eval config, oversized payload, malformed judge request) paged as
 * "missing invoke_agent span" and sent whoever answered to the wrong runtime.
 * Those records still classify as `error` — they count toward
 * nullOrErrorRate — they just don't fire the missing-span pager.
 */
export function isMissingSpanError(entry) {
  if (!entry) return false;
  return MISSING_SPAN_RE.test(entry.errorMessage || '');
}

/**
 * Classify one extracted evaluator-result entry.
 *
 * Ordered — first match wins:
 *   error   — unparseable record, a record with no identity and no error at
 *             all, or the eval service reporting an error for this record
 *   success — a real score, no error
 *   skipped — the judge itself declined to score (score.label says so)
 *   pending — a well-formed record whose score hasn't been delivered yet
 *             (eval results arrive across several CW Logs deliveries)
 *
 * Two ordering choices worth stating outright:
 *
 * 1. Unparseable is an ERROR, not a skip. A record we can't read is the
 *    evaluator (or its log format) having changed under us — the one shape
 *    where the pipeline is broken and we have the least evidence of it. As a
 *    `skipped` it left the denominator and *diluted* nullOrErrorRate, so a
 *    delivery of 100% garbage read as a perfectly healthy batch.
 * 2. A delivered score does NOT beat a decline label. If the judge says it
 *    skipped, its accompanying value (often 0) is not a quality datum, and
 *    folding it into the average is exactly the "broken pipeline reads as a
 *    0/10 regression" failure this module exists to prevent.
 *
 * @returns {{status: 'skipped'|'error'|'success'|'pending', statusReason: string}}
 */
export function classifyEntry(entry) {
  const e = entry || {};
  const hasError = Boolean(e.errorType || e.errorMessage);

  // 1. error — we could not read this record at all.
  if (e.parseError === true) {
    return { status: 'error', statusReason: 'unparseable_message' };
  }
  if (!e.sessionId && !e.evaluatorName && !hasError) {
    return { status: 'error', statusReason: 'unparseable_message' };
  }

  // 2. error — surfaced verbatim so the batch (and the dashboard) can show why.
  if (hasError) {
    const reason =
      e.errorType && e.errorMessage
        ? `${e.errorType}: ${e.errorMessage}`
        : String(e.errorType || e.errorMessage);
    return { status: 'error', statusReason: truncate(reason, 500) };
  }

  // 3. skipped — the judge declined by label. Only ever an evaluator-bearing
  //    record: a decline label with no evaluator behind it is not a verdict.
  if (e.evaluatorName && isJudgeDeclinedLabel(e.scoreLabel)) {
    return {
      status: 'skipped',
      statusReason: truncate(`judge declined to score (label=${e.scoreLabel})`, 500),
    };
  }

  // 4. success — a delivered score.
  if (e.score !== null && e.score !== undefined) {
    return { status: 'success', statusReason: 'scored' };
  }

  // 5. pending — the score may still be coming.
  return { status: 'pending', statusReason: 'no score in delivered records yet' };
}

/**
 * Find the sessions in a delivery whose agent invocation span never arrived.
 *
 * A session is affected when either:
 *   - any of its records matches isMissingSpanError() — CONFIRMED by the
 *     evaluator's own message, reason reported verbatim; or
 *   - none of its records scored AND at least one reported an errorType — the
 *     generic shape of "this session was rejected before scoring", which is
 *     usually but not always a missing span. That reason is prefixed
 *     `missing_span_suspected: ` so a page is never misread as confirmed.
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
    const detail =
      source.errorMessage ||
      (source.errorType
        ? `${source.errorType} (no score delivered for this session)`
        : 'no score delivered for this session');
    // Confirmed → the evaluator's words verbatim. Suspected → labelled as such,
    // so an unrelated rejection can't be paged as a confirmed missing span.
    const reason = explicit ? detail : `missing_span_suspected: ${detail}`;

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
 * nullOrErrorRate is the health signal we alarm on (0–100 percent scale; the
 * alarms in deploy/continuous-improvement/deploy.sh fire above 50). A high rate
 * means the batch is full of un-scored runs, which is a pipeline problem, not a
 * quality problem.
 *
 *   scoredTotal = successCount + errorCount + skippedCount
 *                 — the entries the evaluator actually ATTEMPTED. `nullCount`
 *                   (pending) is excluded: eval results stream in across several
 *                   CW Logs deliveries, so "no score yet" is not an attempt.
 *   numerator   = errorCount + skippedCount
 *                 — every attempted entry that yielded NO usable score: errors,
 *                   plus judge-declined records (a decline is a null score with
 *                   a label on it). Success is the only bucket with a score, so
 *                   this is equivalently `scoredTotal - successCount`.
 *   rate        = 100 * numerator / scoredTotal, or 100 when scoredTotal === 0.
 *
 * Why pending is in NEITHER side: with a scoredTotal denominator, counting
 * pending in the numerator can exceed 100 (1 success + 5 pending → 500) and
 * would page on the ordinary case of a batch flushed mid-delivery. The failure
 * it used to catch — a batch where nothing was ever scored — is caught more
 * directly by the scoredTotal === 0 rule below.
 *
 * scoredTotal === 0 is the WORST case, not a healthy one: the evaluator produced
 * nothing at all. It reports 100, not 0. (It used to report 0, which is how an
 * empty or entirely-unparseable delivery passed as a perfectly healthy batch and
 * still triggered a PRD synthesis off zero evidence.)
 *
 * `totalCount` stays in the output — it's every entry seen, including pending —
 * for the dashboard and improver prompt that already read it.
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
  const scoredTotal = successCount + errorCount + skippedCount;
  return {
    successCount,
    errorCount,
    nullCount,
    skippedCount,
    scoredTotal,
    totalCount,
    nullOrErrorRate: scoredTotal
      ? Math.round((100 * (errorCount + skippedCount)) / scoredTotal)
      : 100,
  };
}

/**
 * Build a CloudWatch Embedded Metric Format payload. console.log(JSON.stringify(...))
 * of the result publishes `metricName` with no PutMetricData call and no extra IAM.
 *
 * Dimensions [["agentId"], []] publishes BOTH the per-agent series and the
 * dimensionless fleet aggregate. deploy/continuous-improvement/deploy.sh alarms
 * on both: one alarm per known agentId (so a single broken agent pages instead
 * of being averaged away by its healthy peers) plus the dimensionless rollup as
 * a backstop for agents that aren't in fleet-runtime-ids.json yet.
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
