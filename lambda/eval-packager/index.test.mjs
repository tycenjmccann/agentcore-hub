/**
 * Unit tests for span_missing classification + EMF metric emission
 * (TEAM-3103 AC4.1–4.4).
 *   node --test    (from lambda/eval-packager/, after npm ci)
 *
 * index.mjs throws at import when no bucket env var is set, so default it
 * before the dynamic import (static imports would hoist above the assignment).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ARTIFACTS_BUCKET ??= 'test-bucket';
const { classifySessions, emitEvalMetrics, extractSessionData } = await import('./index.mjs');

// Minimal evaluatorResults row as extractSessionData produces it.
const row = (sessionId, score, extra = {}) => ({
  timestamp: 1756250000000,
  sessionId,
  evaluatorName: 'Builtin.Correctness',
  score,
  scoreLabel: null,
  evidence: null,
  errorType: null,
  errorMessage: null,
  ...extra,
});

const data = (evaluatorResults) => ({ evaluatorResults });

// Minimal parsed CW Logs delivery, as extractSessionData consumes it: each
// logEvent.message is a JSON OTEL log record with gen_ai.* attributes.
const delivery = (logEvents) => ({
  logGroup: '/aws/bedrock-agentcore/evaluations/results/eval_requirements_analyst-test',
  logStream: 'test-stream',
  logEvents,
});

const logEvent = (sessionId, scoreValue, extraAttrs = {}) => ({
  timestamp: 1756250000000,
  message: JSON.stringify({
    attributes: {
      'session.id': sessionId,
      'gen_ai.evaluation.name': 'Builtin.Correctness',
      'gen_ai.evaluation.score.value': scoreValue,
      ...extraAttrs,
    },
  }),
});

test('all-null scores with no errorType → span_missing', () => {
  const { statuses, total, spanMissing } = classifySessions(
    data([row('s1', null), row('s1', null), row('s1', null)])
  );
  assert.equal(statuses.get('s1'), 'span_missing');
  assert.equal(total, 1);
  assert.equal(spanMissing, 1);
});

test('numeric scores → scored, spanMissing=0', () => {
  const { statuses, total, spanMissing } = classifySessions(
    data([row('s1', 1.0), row('s1', 0.5), row('s2', 0.75)])
  );
  assert.equal(statuses.get('s1'), 'scored');
  assert.equal(statuses.get('s2'), 'scored');
  assert.equal(total, 2);
  assert.equal(spanMissing, 0);
});

test('score of 0 is a real score, not missing', () => {
  const { statuses, spanMissing } = classifySessions(data([row('s1', 0)]));
  assert.equal(statuses.get('s1'), 'scored');
  assert.equal(spanMissing, 0);
});

test('mixed batch: scored / span_missing / error classified per session', () => {
  const { statuses, total, spanMissing } = classifySessions(
    data([
      row('a', 0.9),
      row('a', null),
      row('b', null),
      row('b', null),
      row('c', null, { errorType: 'JudgeTimeout' }),
      row('c', null),
    ])
  );
  assert.equal(statuses.get('a'), 'scored');
  assert.equal(statuses.get('b'), 'span_missing');
  assert.equal(statuses.get('c'), 'error');
  // The error session counts toward total but NOT toward spanMissing.
  assert.equal(total, 3);
  assert.equal(spanMissing, 1);
});

test('all-null WITH errorType → error, excluded from spanMissing', () => {
  const { statuses, total, spanMissing } = classifySessions(
    data([row('s1', null, { errorType: 'AccessDenied' })])
  );
  assert.equal(statuses.get('s1'), 'error');
  assert.equal(total, 1);
  assert.equal(spanMissing, 0);
});

test('empty evaluatorResults → total=0, spanMissing=0, no throw', () => {
  const { statuses, total, spanMissing } = classifySessions(data([]));
  assert.equal(total, 0);
  assert.equal(spanMissing, 0);
  assert.equal(statuses.size, 0);
});

test('parseError rows and rows without sessionId are ignored', () => {
  const { total, spanMissing } = classifySessions(
    data([
      { timestamp: 1, rawMessage: 'not json', parseError: true },
      row(null, null),
      row('', 0.9),
    ])
  );
  assert.equal(total, 0);
  assert.equal(spanMissing, 0);
});

test('non-numeric garbage score with no errorType → span_missing, not scored (TEAM-3315)', () => {
  const sessionData = extractSessionData(
    delivery([logEvent('s1', 'not-a-number'), logEvent('s1', 'NaN')])
  );
  const { statuses, total, spanMissing } = classifySessions(sessionData);
  assert.equal(statuses.get('s1'), 'span_missing');
  assert.equal(total, 1);
  assert.equal(spanMissing, 1);
});

test('session with some null and some numeric scores → scored', () => {
  const { statuses, spanMissing } = classifySessions(
    data([row('s1', null), row('s1', 0.8), row('s1', null)])
  );
  assert.equal(statuses.get('s1'), 'scored');
  assert.equal(spanMissing, 0);
});

test('emitEvalMetrics emits a single EMF record with both metrics', () => {
  const logs = [];
  const original = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    emitEvalMetrics('agentcore_hub_backend_dev', { total: 4, spanMissing: 0 });
  } finally {
    console.log = original;
  }

  assert.equal(logs.length, 1);
  const record = JSON.parse(logs[0]);
  const emf = record._aws.CloudWatchMetrics;
  assert.equal(emf.length, 1);
  assert.equal(emf[0].Namespace, 'AgentCoreHub/Evaluations');
  assert.deepEqual(emf[0].Dimensions, [['AgentName']]);
  assert.deepEqual(
    emf[0].Metrics.map((m) => m.Name).sort(),
    ['EvalSessionsSpanMissing', 'EvalSessionsTotal']
  );
  assert.equal(typeof record._aws.Timestamp, 'number');
  assert.equal(record.AgentName, 'agentcore_hub_backend_dev');
  assert.equal(record.EvalSessionsTotal, 4);
  // Explicit 0 must be emitted (healthy fleet still writes a datapoint).
  assert.equal(record.EvalSessionsSpanMissing, 0);
});

test('emitEvalMetrics carries non-zero spanMissing through', () => {
  const logs = [];
  const original = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    emitEvalMetrics('agentcore_hub_qa_verifier', { total: 7, spanMissing: 3 });
  } finally {
    console.log = original;
  }
  const record = JSON.parse(logs[0]);
  assert.equal(record.EvalSessionsTotal, 7);
  assert.equal(record.EvalSessionsSpanMissing, 3);
});
