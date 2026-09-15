/**
 * agentcore-hub-eval-results: one row per judge result, kept forever (TEAM-4688).
 *
 * The AgentCore online-evaluation results log groups remain the system of
 * record; this table is the QUERYABLE MIRROR of them. Before TEAM-4688 the hub
 * kept only aggregates (an all-time sum/count per evaluator plus 14 days of
 * per-day buckets), so a score could be seen but never explained: no way to ask
 * "which session scored 0.4, and what did the judge say about it?".
 *
 * Table shape (created by deploy/continuous-improvement/deploy-all.sh):
 *   PK  agentId
 *   SK  sk        = `${evaluatedAt}#${dedupKey}`
 *   GSI bySession  (gsi1pk = sessionId,               gsi1sk = `${evaluator}#${evaluatedAt}`)
 *   GSI byPersona  (gsi2pk = `${agentId}#${persona}`, sk)
 *   GSI byWorkflow (gsi3pk = workflowId,              sk)
 * No TTL — every result ever judged stays.
 *
 * `gsi3pk` is SPARSE: only pipeline sessions parse into a workflowId, so a
 * canary/invoke/si- row simply never appears in the byWorkflow index.
 *
 * Idempotency is the whole design: `sk` embeds the SAME `dedupKey` the
 * cross-delivery seen-set uses, so re-delivery, the daily reconcile and the
 * one-off backfill all converge on one row per evaluation attempt via a
 * conditional put. That is what makes "one code path, two entry points" safe.
 */

import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { dayKeyOf } from './daily.mjs';
import { parseSessionId, personaFor, RUNTIME_PERSONA } from './session-id.mjs';

/**
 * A judge explanation is free text and DynamoDB caps an item at 400 KB. 8 KB is
 * far more than any observed explanation and still leaves a delivery of rows
 * comfortably inside the write-unit budget; over-long text is truncated with a
 * flag so the UI can say so instead of silently showing a clipped verdict.
 */
export const EXPLANATION_MAX_BYTES = 8192;

export function resultsTable() {
  return process.env.EVAL_RESULTS_TABLE || 'agentcore-hub-eval-results';
}

/**
 * Byte-bounded truncation that never emits a broken UTF-8 sequence: slice at the
 * byte cap, decode, and drop a trailing replacement char if the cut landed
 * mid-codepoint.
 */
export function truncateExplanation(text, maxBytes = EXPLANATION_MAX_BYTES) {
  if (typeof text !== 'string' || text === '') return { explanation: text || null, truncated: false };
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { explanation: text, truncated: false };
  let sliced = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  if (sliced.endsWith('�')) sliced = sliced.slice(0, -1);
  return { explanation: sliced, truncated: true };
}

/**
 * Map ONE classified evaluator row (as extractSessionData already produces it —
 * deduped and role-guarded) to a results row.
 *
 * Returns null for rows that carry nothing to persist:
 *  - battery sessions (hermetic config-eval fixtures, never real traffic),
 *  - unparseable platform lines (`parseError` — no session, no evaluator, no
 *    score; they exist only so the dedup layers can count them),
 *  - rows with no `dedupKey` at all (hasNoDedupKey fails them OPEN through
 *    dedup precisely because they have no identity — and with no identity there
 *    is no idempotent sort key to give them).
 */
export function toResultRow(agentId, entry, { source = 'push', logGroup = '', ingestedAt } = {}) {
  if (!entry || entry.parseError || !entry.dedupKey) return null;
  const sessionId = entry.sessionId || null;
  if (typeof sessionId === 'string' && sessionId.startsWith('battery-')) return null;

  const evaluatedAt = new Date(
    Number.isFinite(Number(entry.timestamp)) && Number(entry.timestamp) > 0
      ? Number(entry.timestamp)
      : Date.now()
  ).toISOString();
  const parsed = sessionId ? parseSessionId(sessionId) : null;
  const persona = sessionId ? personaFor(sessionId, agentId) : RUNTIME_PERSONA;
  const evaluator = entry.evaluatorName || 'unknown';
  const { explanation, truncated } = truncateExplanation(entry.evidence);

  return {
    // ── keys ──
    agentId,
    sk: `${evaluatedAt}#${entry.dedupKey}`,
    gsi1pk: sessionId ?? undefined, // sparse: rows with no session id
    gsi1sk: sessionId ? `${evaluator}#${evaluatedAt}` : undefined,
    gsi2pk: `${agentId}#${persona}`,
    gsi3pk: parsed?.workflowId ?? undefined, // sparse: non-pipeline sessions
    // ── dimensions ──
    persona,
    sessionId: sessionId ?? undefined,
    workflowId: parsed?.workflowId ?? undefined,
    ticketId: parsed?.ticketId ?? undefined,
    evaluator,
    day: dayKeyOf(entry.timestamp),
    evaluatedAt,
    // ── verdict ──
    score: Number.isFinite(entry.score) ? entry.score : null,
    scoreLabel: entry.scoreLabel ?? null,
    explanation,
    explanationTruncated: truncated ? true : undefined,
    errorType: entry.errorType ?? null,
    errorMessage: entry.errorMessage ?? null,
    status: entry.status ?? null,
    statusReason: entry.statusReason ?? null,
    // ── provenance ──
    traceId: entry.traceId ?? undefined,
    spanId: entry.spanId ?? undefined,
    requestId: entry.requestId ?? undefined,
    logGroup: logGroup || undefined,
    source,
    ingestedAt: ingestedAt || new Date().toISOString(),
  };
}

/** Map a whole delivery, dropping the rows toResultRow rejects. */
export function toResultRows(agentId, entries = [], opts = {}) {
  return entries.map((e) => toResultRow(agentId, e, opts)).filter(Boolean);
}

/**
 * Conditional-put every row. `attribute_not_exists(sk)` makes the write
 * idempotent, so a ConditionalCheckFailed is the EXPECTED outcome for a row we
 * already stored (a re-delivery, or a reconcile pass over a window that push
 * already covered) — counted as a duplicate, never logged as an error.
 *
 * Failures are counted and logged but never thrown: persisting results is a
 * mirror of CloudWatch, and losing a delivery's aggregates because the mirror
 * had a bad minute would be a worse trade. The daily reconcile re-writes
 * whatever a failure dropped.
 */
export async function putResults(ddb, rows, table = null) {
  const TableName = table || resultsTable();
  let written = 0;
  let duplicate = 0;
  let failed = 0;
  for (const Item of rows) {
    try {
      await ddb.send(
        new PutCommand({ TableName, Item, ConditionExpression: 'attribute_not_exists(sk)' })
      );
      written += 1;
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') {
        duplicate += 1;
      } else {
        failed += 1;
        console.error(
          `[eval-packager] results row write failed (${Item.agentId} ${Item.sk}): ${err?.message}`
        );
      }
    }
  }
  return { written, duplicate, failed };
}
