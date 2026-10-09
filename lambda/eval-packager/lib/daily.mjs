/**
 * Per-UTC-day metric buckets (TEAM-4688 extracted this from index.mjs).
 *
 * ONE table (EVAL_DAILY_TABLE, PK agentId / SK day) carries both the packager's
 * sessions/evalScores and lambda/token-aggregator's token+cost fields, with flat
 * attribute names (`sessions`, `e|<evaluator>|sum`, `e|<evaluator>|count`,
 * `m|<model>|<field>`) so ONE atomic ADD creates-or-increments everything — no
 * read-modify-write, no CAS, no contention between the two writers.
 *
 * TWO changes here versus the pre-TEAM-4688 version:
 *
 * 1. No `expiresAt`. The buckets used to carry a 14-day TTL, which is why the
 *    dashboard could not offer a 30/90/all-time window: the history was deleted.
 *    Buckets are now permanent (TTL is disabled on the table by
 *    deploy/continuous-improvement/deploy-all.sh). Rows written before the
 *    change keep a stale `expiresAt` attribute; with TTL off it is inert.
 * 2. Persona rows. Every pipeline persona shares one runtime, so the runtime's
 *    row is a rollup that cannot answer "how is the code reviewer scoring?".
 *    The packager now ALSO increments `PK ${agentId}#${persona}` with the same
 *    attributes, leaving the runtime row exactly as it was (tokens and cost stay
 *    runtime-only — they are not attributable per persona).
 */

import { personaFor, RUNTIME_PERSONA } from './session-id.mjs';

export { RUNTIME_PERSONA };

export const DAILY_TABLE = process.env.EVAL_DAILY_TABLE || 'agentcore-hub-eval-daily';

/** UTC day key (`YYYY-MM-DD`) for an epoch-ms timestamp. */
export function dayKeyOf(ms) {
  const n = Number(ms);
  return new Date(Number.isFinite(n) && n > 0 ? n : Date.now()).toISOString().slice(0, 10);
}

export function evaluatorAttr(evaluator, field) {
  return `e|${evaluator}|${field}`;
}

/** Partition key of a persona's daily row. */
export function personaDailyKey(agentId, persona) {
  return `${agentId}#${persona}`;
}

/**
 * Does this row contribute to an evaluator average?
 *
 * The same eligibility the all-time scorecard uses: an evaluator name, a finite
 * score (extractSessionData already nulls NaN garbage that would poison a
 * rolling sum) and no error signal (`error.type` or the raw `error === 1` flag).
 * Shared so the push path, the persona rows and the reconcile recompute can
 * never drift apart on what "scored" means.
 */
export function isScoredRow(r) {
  const hasError = r?.errorFlag === 1 || r?.errorType;
  return Boolean(r?.evaluatorName) && Number.isFinite(r?.score) && !hasError;
}

/**
 * Fold classified evaluator rows into `{ day: { sessions:Set, evalScores } }`.
 *
 * `parseError` rows carry no session and no score, so they are skipped exactly
 * as aggregateScoresToDdb skips them.
 */
export function dailyDeltasFrom(entries = []) {
  const deltas = {};
  const dayOf = (r) => (deltas[dayKeyOf(r.timestamp)] ||= { sessions: new Set(), evalScores: {} });
  for (const r of entries) {
    if (r.parseError) continue;
    if (r.sessionId) dayOf(r).sessions.add(r.sessionId);
    if (isScoredRow(r)) {
      const scores = dayOf(r).evalScores;
      (scores[r.evaluatorName] ||= { sum: 0, count: 0 });
      scores[r.evaluatorName].sum += r.score;
      scores[r.evaluatorName].count += 1;
    }
  }
  return deltas;
}

/**
 * Same fold, split by persona: `{ persona: { day: { sessions, evalScores } } }`.
 *
 * `_runtime` is deliberately EXCLUDED — those sessions already land on the
 * runtime's own row via dailyDeltasFrom, and emitting them again under
 * `<agentId>#_runtime` would double-count the rollup.
 */
export function dailyDeltasByPersona(agentId, entries = []) {
  const byPersona = {};
  for (const r of entries) {
    if (r.parseError || !r.sessionId) continue;
    const persona = personaFor(r.sessionId, agentId);
    if (persona === RUNTIME_PERSONA) continue;
    (byPersona[persona] ||= []).push(r);
  }
  return Object.fromEntries(
    Object.entries(byPersona).map(([persona, rows]) => [persona, dailyDeltasFrom(rows)])
  );
}

/**
 * Build the atomic ADD for one day bucket. `delta` is
 * `{ sessions:<number>, evalScores:{ name:{sum,count} } }`.
 */
export function buildDailyEvalExpression(day, delta, now) {
  const names = { '#updatedAt': 'updatedAt' };
  const values = { ':now': now };
  const adds = [];
  if (delta.sessions > 0) {
    names['#sessions'] = 'sessions';
    values[':sessions'] = delta.sessions;
    adds.push('#sessions :sessions');
  }
  Object.entries(delta.evalScores).forEach(([evaluator, d], i) => {
    names[`#e${i}s`] = evaluatorAttr(evaluator, 'sum');
    names[`#e${i}c`] = evaluatorAttr(evaluator, 'count');
    values[`:e${i}s`] = d.sum;
    values[`:e${i}c`] = d.count;
    adds.push(`#e${i}s :e${i}s`, `#e${i}c :e${i}c`);
  });
  return {
    UpdateExpression: `SET #updatedAt = :now ADD ${adds.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    empty: adds.length === 0,
  };
}
