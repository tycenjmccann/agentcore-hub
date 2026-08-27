/**
 * lambda/eval-packager/lib/classify.test.mjs
 *
 * Hermetic tests for the eval-record classifiers. classify.mjs has zero AWS
 * imports precisely so this file can import it directly — no mocks, no
 * credentials, no network. Runs under the repo-standard `npm run test:unit`
 * (vitest) via the include glob in vitest.config.ts.
 *
 * What these tests are really protecting: the difference between "this agent
 * scored badly" and "this run was never scored because the runtime never
 * exported the invoke_agent span". Collapsing those two is what made a broken
 * telemetry pipeline read as a 0/10 quality regression.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyEntry,
  computeBatchSummary,
  emfRecord,
  isMissingSpanError,
  sessionsMissingSpan,
} from './classify.mjs';

// The literal message the evaluator emits when the agent invocation span is absent.
const MISSING_SPAN_MESSAGE =
  'Evaluation failed because none of the spans contain the required agent invocation ' +
  '(gen_ai.operation.name=invoke_agent)';

/** A well-formed, successfully scored record as extractSessionData would build it. */
const scored = (over = {}) => ({
  timestamp: 1_700_000_000_000,
  sessionId: 'sess-healthy',
  evaluatorName: 'builtin.correctness',
  score: 8,
  scoreLabel: 'pass',
  evidence: 'The agent addressed the ticket.',
  errorType: null,
  errorMessage: null,
  ...over,
});

describe('classifyEntry', () => {
  it('classifies an unparseable record as skipped', () => {
    // Shape produced by extractSessionData's catch branch for a non-JSON message.
    const entry = { timestamp: 1, rawMessage: 'START RequestId: abc  Version: $LATEST', parseError: true };
    expect(classifyEntry(entry)).toEqual({
      status: 'skipped',
      statusReason: 'unparseable log record',
    });
  });

  it('classifies a record with no identity and no error as skipped', () => {
    expect(classifyEntry({ sessionId: null, evaluatorName: null, errorType: null, errorMessage: null }).status).toBe(
      'skipped'
    );
  });

  it('classifies an errored record as error with "<type>: <message>"', () => {
    const result = classifyEntry(
      scored({ score: null, errorType: 'ValidationException', errorMessage: MISSING_SPAN_MESSAGE })
    );
    expect(result.status).toBe('error');
    expect(result.statusReason).toBe(`ValidationException: ${MISSING_SPAN_MESSAGE}`);
  });

  it('truncates a pathological error message to 500 chars', () => {
    const result = classifyEntry(scored({ score: null, errorMessage: 'x'.repeat(5000) }));
    expect(result.status).toBe('error');
    expect(result.statusReason).toHaveLength(500);
  });

  it('lets error win over a delivered score', () => {
    // A record can carry both; an error must never be counted as a success.
    expect(classifyEntry(scored({ score: 7, errorType: 'ThrottlingException' })).status).toBe('error');
  });

  it('classifies a scored record as success', () => {
    expect(classifyEntry(scored())).toEqual({ status: 'success', statusReason: 'scored' });
  });

  it('treats a score of 0 as success, not as a missing score', () => {
    // The bug this guards: `if (entry.score)` would bucket a real 0/10 as pending
    // and quietly drop the fleet's worst results out of the average.
    expect(classifyEntry(scored({ score: 0 })).status).toBe('success');
  });

  it('classifies a well-formed record with no score yet as pending', () => {
    expect(classifyEntry(scored({ score: null, scoreLabel: null, evidence: null }))).toEqual({
      status: 'pending',
      statusReason: 'no score in delivered records yet',
    });
  });
});

describe('isMissingSpanError', () => {
  it('matches the evaluator\'s real missing-span message', () => {
    expect(isMissingSpanError({ errorMessage: MISSING_SPAN_MESSAGE, score: null })).toBe(true);
  });

  it('matches regardless of case', () => {
    expect(isMissingSpanError({ errorMessage: 'None Of The Spans Contain The Required Agent Invocation' })).toBe(true);
  });

  it('matches a bare ValidationException with no score', () => {
    expect(isMissingSpanError({ errorType: 'ValidationException', score: null })).toBe(true);
  });

  it('does not match a ValidationException that still produced a score', () => {
    expect(isMissingSpanError({ errorType: 'ValidationException', score: 4 })).toBe(false);
  });

  it('does not match a healthy scored entry', () => {
    expect(isMissingSpanError(scored())).toBe(false);
  });

  it('does not match an unrelated error', () => {
    expect(isMissingSpanError({ errorType: 'ThrottlingException', errorMessage: 'Rate exceeded', score: null })).toBe(
      false
    );
  });
});

describe('sessionsMissingSpan', () => {
  it('flags a session whose record carries the explicit missing-span error', () => {
    const affected = sessionsMissingSpan([
      { sessionId: 'sess-a', score: null, errorType: 'ValidationException', errorMessage: MISSING_SPAN_MESSAGE },
    ]);
    expect(affected).toHaveLength(1);
    expect(affected[0].sessionId).toBe('sess-a');
    expect(affected[0].reason).toBe(MISSING_SPAN_MESSAGE);
  });

  it('flags an all-null session that reported at least one errorType', () => {
    const affected = sessionsMissingSpan([
      { sessionId: 'sess-b', score: null, errorType: 'InternalServerException', errorMessage: 'evaluator crashed' },
      { sessionId: 'sess-b', score: null, errorType: null, errorMessage: null, evaluatorName: 'builtin.helpfulness' },
    ]);
    expect(affected.map((a) => a.sessionId)).toEqual(['sess-b']);
    expect(affected[0].reason).toBe('evaluator crashed');
  });

  it('does not flag a healthy scored session', () => {
    expect(sessionsMissingSpan([scored(), scored({ evaluatorName: 'builtin.helpfulness', score: 9 })])).toEqual([]);
  });

  it('does not flag an all-null session with no errorType (still pending)', () => {
    // Eval results stream in across deliveries — "no score yet" is not a failure.
    expect(sessionsMissingSpan([{ sessionId: 'sess-pending', score: null, evaluatorName: 'builtin.correctness' }])).toEqual(
      []
    );
  });

  it('flags only the affected sessions in a mixed delivery', () => {
    const affected = sessionsMissingSpan([
      { sessionId: 'sess-broken', score: null, errorType: 'ValidationException', errorMessage: MISSING_SPAN_MESSAGE },
      scored({ sessionId: 'sess-ok' }),
      scored({ sessionId: 'sess-ok', evaluatorName: 'builtin.helpfulness', score: 6 }),
      { sessionId: 'sess-rejected', score: null, errorType: 'ValidationException', errorMessage: null },
      { sessionId: 'sess-waiting', score: null, evaluatorName: 'builtin.correctness' },
    ]);
    expect(affected.map((a) => a.sessionId).sort()).toEqual(['sess-broken', 'sess-rejected']);
  });

  it('ignores records with no sessionId — nothing to attribute them to', () => {
    expect(sessionsMissingSpan([{ sessionId: null, score: null, errorType: 'ValidationException' }])).toEqual([]);
  });

  it('tolerates empty and missing input', () => {
    expect(sessionsMissingSpan([])).toEqual([]);
    expect(sessionsMissingSpan(undefined)).toEqual([]);
  });
});

describe('non-JSON log records', () => {
  it('classifies extractSessionData\'s parseError shape as skipped without crashing', () => {
    // Lambda platform lines ("REPORT RequestId: …") land in the same subscription
    // stream as eval results; they must be inert, not fatal.
    const entries = [
      { timestamp: 1, rawMessage: 'REPORT RequestId: 1-2-3 Duration: 42 ms', parseError: true },
      { timestamp: 2, rawMessage: 'not json at all', parseError: true },
    ].map((e) => ({ ...e, ...classifyEntry(e) }));

    expect(entries.every((e) => e.status === 'skipped')).toBe(true);
    expect(() => sessionsMissingSpan(entries)).not.toThrow();
    expect(sessionsMissingSpan(entries)).toEqual([]);
    expect(computeBatchSummary(entries)).toMatchObject({ skippedCount: 2, totalCount: 2, nullOrErrorRate: 0 });
  });
});

describe('computeBatchSummary', () => {
  it('reports 100% when every record is pending or errored', () => {
    const entries = [
      ...Array.from({ length: 6 }, () => ({ status: 'pending' })),
      ...Array.from({ length: 4 }, () => ({ status: 'error' })),
    ];
    expect(computeBatchSummary(entries)).toEqual({
      successCount: 0,
      errorCount: 4,
      nullCount: 6,
      skippedCount: 0,
      totalCount: 10,
      nullOrErrorRate: 100,
    });
  });

  it('reports 10% for 1 pending out of 10', () => {
    const entries = [{ status: 'pending' }, ...Array.from({ length: 9 }, () => ({ status: 'success' }))];
    expect(computeBatchSummary(entries)).toMatchObject({
      successCount: 9,
      nullCount: 1,
      totalCount: 10,
      nullOrErrorRate: 10,
    });
  });

  it('returns zeroed counts and rate 0 for an empty batch (no divide-by-zero)', () => {
    expect(computeBatchSummary([])).toEqual({
      successCount: 0,
      errorCount: 0,
      nullCount: 0,
      skippedCount: 0,
      totalCount: 0,
      nullOrErrorRate: 0,
    });
  });

  it('derives status itself for entries that were never classified', () => {
    expect(computeBatchSummary([scored(), scored({ score: null, evidence: null })])).toMatchObject({
      successCount: 1,
      nullCount: 1,
      nullOrErrorRate: 50,
    });
  });

  it('rounds the rate to a whole percent', () => {
    // 1 of 3 → 33.33… → 33
    expect(computeBatchSummary([{ status: 'error' }, { status: 'success' }, { status: 'success' }]).nullOrErrorRate).toBe(
      33
    );
  });
});

describe('emfRecord', () => {
  it('builds a CloudWatch EMF payload CloudWatch will actually ingest', () => {
    const record = emfRecord('eval.batch.null_or_error_rate', 75, 'Percent', 'agentcore_hub_backend_dev', {
      totalCount: 8,
      errorCount: 6,
    });

    expect(record._aws.CloudWatchMetrics).toHaveLength(1);
    const [metricDirective] = record._aws.CloudWatchMetrics;
    expect(metricDirective.Namespace).toBe('AgentCoreHub/Evaluations');
    // Per-agent series AND the dimensionless fleet aggregate the alarms watch.
    expect(metricDirective.Dimensions).toEqual([['agentId'], []]);
    expect(metricDirective.Metrics).toEqual([{ Name: 'eval.batch.null_or_error_rate', Unit: 'Percent' }]);

    // The dimension value and the metric value must be top-level fields.
    expect(record.agentId).toBe('agentcore_hub_backend_dev');
    expect(record['eval.batch.null_or_error_rate']).toBe(75);
    expect(typeof record._aws.Timestamp).toBe('number');

    // Extra fields ride along for Logs Insights without becoming metrics.
    expect(record.totalCount).toBe(8);
    expect(record.errorCount).toBe(6);
  });

  it('builds the missing-span Count metric with its alert fields', () => {
    const record = emfRecord('eval.preflight.missing_span', 1, 'Count', 'agentcore_hub_qa_verifier', {
      level: 'error',
      event: 'eval.preflight.missing_span',
      sessionId: 'sess-broken',
      statusReason: MISSING_SPAN_MESSAGE,
    });

    expect(record._aws.CloudWatchMetrics[0].Metrics).toEqual([
      { Name: 'eval.preflight.missing_span', Unit: 'Count' },
    ]);
    expect(record['eval.preflight.missing_span']).toBe(1);
    expect(record.level).toBe('error');
    expect(record.event).toBe('eval.preflight.missing_span');
    expect(record.sessionId).toBe('sess-broken');
    expect(record.statusReason).toBe(MISSING_SPAN_MESSAGE);
    // Survives JSON round-trip — it's emitted via console.log(JSON.stringify(…)).
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });

  it('defaults extraFields to empty', () => {
    const record = emfRecord('eval.preflight.missing_span', 1, 'Count', 'agentcore_hub_ci_agent');
    expect(Object.keys(record).sort()).toEqual(['_aws', 'agentId', 'eval.preflight.missing_span']);
  });
});
