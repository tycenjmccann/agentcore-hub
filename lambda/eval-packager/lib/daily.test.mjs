/**
 * Per-UTC-day buckets: persona split and the removal of the 14-day TTL (TEAM-4688).
 *
 * The whole point of the change is that these rows now answer "how has the code
 * reviewer scored over 90 days", so the two things worth pinning are (a) a
 * persona row is incremented WITHOUT double-counting the runtime rollup and
 * (b) nothing writes an expiry ever again.
 */

import { describe, it, expect } from 'vitest';
import {
  RUNTIME_PERSONA,
  buildDailyEvalExpression,
  dailyDeltasByPersona,
  dailyDeltasFrom,
  dayKeyOf,
  evaluatorAttr,
  isScoredRow,
  personaDailyKey,
} from './daily.mjs';

const AGENT = 'agentcore_hub_agent';
const DAY = Date.UTC(2026, 8, 14, 23, 30, 0); // 2026-09-14 UTC
const NEXT_DAY = Date.UTC(2026, 8, 15, 0, 30, 0); // 2026-09-15 UTC

function row(over = {}) {
  return {
    sessionId: `TEAM-1_wf_1_a-agentcore_hub_backend_dev-1757900123456`,
    evaluatorName: 'Builtin.Correctness',
    score: 0.5,
    errorFlag: 0,
    errorType: null,
    timestamp: DAY,
    ...over,
  };
}

describe('dayKeyOf', () => {
  it('keys by UTC day, not local time', () => {
    expect(dayKeyOf(DAY)).toBe('2026-09-14');
    expect(dayKeyOf(NEXT_DAY)).toBe('2026-09-15');
  });

  it('falls back to now for a missing or nonsense timestamp', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(dayKeyOf(undefined)).toBe(today);
    expect(dayKeyOf(0)).toBe(today);
    expect(dayKeyOf('nope')).toBe(today);
  });
});

describe('isScoredRow', () => {
  it('accepts a finite score from a named evaluator', () => {
    expect(isScoredRow(row())).toBe(true);
    expect(isScoredRow(row({ score: 0 }))).toBe(true);
  });

  it('rejects rows that would poison a rolling average', () => {
    expect(isScoredRow(row({ score: NaN }))).toBe(false);
    expect(isScoredRow(row({ score: undefined }))).toBe(false);
    expect(isScoredRow(row({ evaluatorName: null }))).toBe(false);
    expect(isScoredRow(row({ errorFlag: 1 }))).toBe(false);
    expect(isScoredRow(row({ errorType: 'ThrottlingException' }))).toBe(false);
    expect(isScoredRow(undefined)).toBe(false);
  });
});

describe('dailyDeltasFrom', () => {
  it('counts distinct sessions and sums scores per evaluator per day', () => {
    const deltas = dailyDeltasFrom([
      row(),
      row({ score: 1, evaluatorName: 'Builtin.Helpfulness' }),
      row({ sessionId: 'TEAM-2_wf_2_b-agentcore_hub_qa_engineer-1757900123456', score: 0.5 }),
      row({ timestamp: NEXT_DAY, score: 0.25 }),
    ]);

    expect(Object.keys(deltas).sort()).toEqual(['2026-09-14', '2026-09-15']);
    const d14 = deltas['2026-09-14'];
    expect(d14.sessions.size).toBe(2);
    expect(d14.evalScores).toEqual({
      'Builtin.Correctness': { sum: 1, count: 2 },
      'Builtin.Helpfulness': { sum: 1, count: 1 },
    });
    expect(deltas['2026-09-15'].evalScores['Builtin.Correctness']).toEqual({ sum: 0.25, count: 1 });
  });

  it('counts an errored session but not its score', () => {
    const deltas = dailyDeltasFrom([row({ errorFlag: 1, score: 0.9 })]);
    expect(deltas['2026-09-14'].sessions.size).toBe(1);
    expect(deltas['2026-09-14'].evalScores).toEqual({});
  });

  it('skips parseError placeholders entirely', () => {
    expect(dailyDeltasFrom([{ parseError: true, timestamp: DAY }])).toEqual({});
  });
});

describe('dailyDeltasByPersona', () => {
  it('splits pipeline sessions by the persona that ran them', () => {
    const byPersona = dailyDeltasByPersona(AGENT, [
      row(),
      row({ sessionId: 'TEAM-2_wf_2_b-agentcore_hub_code_reviewer-1757900123456', score: 1 }),
    ]);

    expect(Object.keys(byPersona).sort()).toEqual([
      'agentcore_hub_backend_dev',
      'agentcore_hub_code_reviewer',
    ]);
    expect(byPersona.agentcore_hub_backend_dev['2026-09-14'].evalScores).toEqual({
      'Builtin.Correctness': { sum: 0.5, count: 1 },
    });
    expect(byPersona.agentcore_hub_code_reviewer['2026-09-14'].sessions.size).toBe(1);
  });

  it('excludes _runtime so the rollup row is never double-counted', () => {
    // These sessions DO land on the runtime's own row via dailyDeltasFrom; a
    // `<agentId>#_runtime` row would count them a second time.
    const byPersona = dailyDeltasByPersona(AGENT, [
      row({ sessionId: 'cc-3f7a1b9c4d2e4f8a9b0c1d2e3f4a5b6c' }),
      row({ sessionId: `si-${AGENT}-1757900123456` }),
      row({ sessionId: 'canary-eval-1757900123-agentcore_hub_agent' }),
    ]);
    expect(byPersona).toEqual({});
    expect(RUNTIME_PERSONA).toBe('_runtime');
  });

  it('ignores rows with no session id', () => {
    expect(dailyDeltasByPersona(AGENT, [row({ sessionId: null }), { parseError: true }])).toEqual({});
  });

  it('namespaces a persona row under the runtime that hosts it', () => {
    expect(personaDailyKey(AGENT, 'agentcore_hub_backend_dev')).toBe(
      'agentcore_hub_agent#agentcore_hub_backend_dev'
    );
  });
});

describe('buildDailyEvalExpression', () => {
  const delta = {
    sessions: 2,
    evalScores: { 'Builtin.Correctness': { sum: 1.5, count: 3 } },
  };

  it('builds ONE atomic ADD that creates-or-increments every counter', () => {
    const e = buildDailyEvalExpression('2026-09-14', delta, 'NOW');

    expect(e.empty).toBe(false);
    expect(e.UpdateExpression).toBe('SET #updatedAt = :now ADD #sessions :sessions, #e0s :e0s, #e0c :e0c');
    expect(e.ExpressionAttributeNames).toEqual({
      '#updatedAt': 'updatedAt',
      '#sessions': 'sessions',
      '#e0s': evaluatorAttr('Builtin.Correctness', 'sum'),
      '#e0c': evaluatorAttr('Builtin.Correctness', 'count'),
    });
    expect(e.ExpressionAttributeValues).toEqual({
      ':now': 'NOW',
      ':sessions': 2,
      ':e0s': 1.5,
      ':e0c': 3,
    });
  });

  it('never writes an expiry — buckets are kept forever so 30/90/all can be asked', () => {
    const e = buildDailyEvalExpression('2026-09-14', delta, 'NOW');
    expect(e.UpdateExpression).not.toContain('expiresAt');
    expect(e.ExpressionAttributeNames['#expiresAt']).toBeUndefined();
    expect(e.ExpressionAttributeValues[':ttl']).toBeUndefined();
  });

  it('reports an empty delta instead of emitting a dangling ADD', () => {
    const e = buildDailyEvalExpression('2026-09-14', { sessions: 0, evalScores: {} }, 'NOW');
    expect(e.empty).toBe(true);
  });

  it('escapes evaluator names through attribute names, so `|` and `.` are safe', () => {
    const e = buildDailyEvalExpression(
      '2026-09-14',
      { sessions: 0, evalScores: { 'Custom.My Judge': { sum: 1, count: 1 } } },
      'NOW'
    );
    expect(e.ExpressionAttributeNames['#e0s']).toBe('e|Custom.My Judge|sum');
    expect(e.UpdateExpression).toBe('SET #updatedAt = :now ADD #e0s :e0s, #e0c :e0c');
  });
});
