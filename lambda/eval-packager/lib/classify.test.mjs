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
  it('classifies an unparseable record as error("unparseable_message")', () => {
    // Shape produced by extractSessionData's catch branch for a non-JSON message.
    // NOT skipped: as a skip it left the rate's denominator, so a delivery of
    // 100% unreadable records read as a perfectly healthy batch.
    const entry = { timestamp: 1, rawMessage: 'START RequestId: abc  Version: $LATEST', parseError: true };
    expect(classifyEntry(entry)).toEqual({
      status: 'error',
      statusReason: 'unparseable_message',
    });
  });

  it('classifies a record with no identity and no error as error("unparseable_message")', () => {
    expect(classifyEntry({ sessionId: null, evaluatorName: null, errorType: null, errorMessage: null })).toEqual({
      status: 'error',
      statusReason: 'unparseable_message',
    });
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

  it('classifies a judge-declined score label as skipped', () => {
    // `skipped` means exactly one thing now: the judge itself declined to score.
    const result = classifyEntry(scored({ score: null, scoreLabel: 'skipped' }));
    expect(result.status).toBe('skipped');
    expect(result.statusReason).toBe('judge declined to score (label=skipped)');
  });

  it.each(['skip', 'SKIPPED', 'skipped_no_input', 'declined', 'not_applicable', 'N/A', 'unable to evaluate'])(
    'treats score label %s as a judge decline',
    (label) => {
      expect(classifyEntry(scored({ score: null, scoreLabel: label })).status).toBe('skipped');
    }
  );

  it.each(['pass', 'fail', 'partially_correct', 'skipworthy_pass', ''])(
    'does not treat score label %s as a judge decline',
    (label) => {
      // A real verdict must never be read as a decline — anchoring the label
      // regex is what keeps "partially_correct" and friends out of the bucket.
      expect(classifyEntry(scored({ score: null, scoreLabel: label })).status).toBe('pending');
    }
  );

  it('lets a decline label win over a delivered score', () => {
    // If the judge says it skipped, its accompanying 0 is not a quality datum —
    // averaging it in is the "broken pipeline reads as a 0/10 regression" bug.
    expect(classifyEntry(scored({ score: 0, scoreLabel: 'skipped' })).status).toBe('skipped');
  });

  it('lets error win over a decline label', () => {
    expect(classifyEntry(scored({ score: null, scoreLabel: 'skipped', errorType: 'ThrottlingException' })).status).toBe(
      'error'
    );
  });

  it('does not read a decline label off a record with no evaluator behind it', () => {
    // No evaluator → no verdict to decline; this is the unparseable shape.
    expect(classifyEntry({ sessionId: 'sess-x', evaluatorName: null, scoreLabel: 'skipped', score: null }).status).toBe(
      'pending'
    );
  });
});

describe('isMissingSpanError', () => {
  it('matches the evaluator\'s real missing-span message', () => {
    expect(isMissingSpanError({ errorMessage: MISSING_SPAN_MESSAGE, score: null })).toBe(true);
  });

  it('matches regardless of case', () => {
    expect(isMissingSpanError({ errorMessage: 'None Of The Spans Contain The Required Agent Invocation' })).toBe(true);
  });

  it('does NOT match a bare ValidationException with no score — but still classifies as error', () => {
    // Any ValidationException used to qualify, so an unrelated validation failure
    // (bad eval config, oversized payload) paged as "missing invoke_agent span"
    // and sent whoever answered to the wrong runtime. It must still count toward
    // nullOrErrorRate — it just must not fire the missing-span pager.
    const entry = { sessionId: 'sess-v', errorType: 'ValidationException', errorMessage: null, score: null };
    expect(isMissingSpanError(entry)).toBe(false);
    expect(classifyEntry(entry).status).toBe('error');
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

  it('flags an all-null session that reported at least one errorType, marked as SUSPECTED', () => {
    // The heuristic stays, but its reason must be distinguishable from a
    // confirmed missing span — the page says which one it is.
    const affected = sessionsMissingSpan([
      { sessionId: 'sess-b', score: null, errorType: 'InternalServerException', errorMessage: 'evaluator crashed' },
      { sessionId: 'sess-b', score: null, errorType: null, errorMessage: null, evaluatorName: 'builtin.helpfulness' },
    ]);
    expect(affected.map((a) => a.sessionId)).toEqual(['sess-b']);
    expect(affected[0].reason).toBe('missing_span_suspected: evaluator crashed');
  });

  it('does not prefix the reason when the missing span is confirmed by the evaluator', () => {
    const affected = sessionsMissingSpan([
      { sessionId: 'sess-c', score: null, errorType: 'ValidationException', errorMessage: MISSING_SPAN_MESSAGE },
    ]);
    expect(affected[0].reason).toBe(MISSING_SPAN_MESSAGE);
    expect(affected[0].reason).not.toMatch(/^missing_span_suspected/);
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
  it('classifies extractSessionData\'s parseError shape as error without crashing', () => {
    // Lambda platform lines ("REPORT RequestId: …") land in the same subscription
    // stream as eval results; they must be non-fatal — but NOT invisible. A
    // delivery we can't read means the evaluator's log format moved under us, so
    // it raises the rate to 100 instead of diluting it to 0.
    const entries = [
      { timestamp: 1, rawMessage: 'REPORT RequestId: 1-2-3 Duration: 42 ms', parseError: true },
      { timestamp: 2, rawMessage: 'not json at all', parseError: true },
    ].map((e) => ({ ...e, ...classifyEntry(e) }));

    expect(entries.every((e) => e.status === 'error')).toBe(true);
    expect(() => sessionsMissingSpan(entries)).not.toThrow();
    expect(sessionsMissingSpan(entries)).toEqual([]);
    expect(computeBatchSummary(entries)).toMatchObject({
      errorCount: 2,
      skippedCount: 0,
      scoredTotal: 2,
      totalCount: 2,
      nullOrErrorRate: 100,
    });
  });
});

describe('computeBatchSummary', () => {
  it('reports 100% when every attempted record errored', () => {
    const entries = [
      ...Array.from({ length: 6 }, () => ({ status: 'pending' })),
      ...Array.from({ length: 4 }, () => ({ status: 'error' })),
    ];
    expect(computeBatchSummary(entries)).toEqual({
      successCount: 0,
      errorCount: 4,
      nullCount: 6,
      skippedCount: 0,
      // pending is in NEITHER the numerator nor the denominator: 4 of 4
      // evaluator-attempted entries failed.
      scoredTotal: 4,
      totalCount: 10,
      nullOrErrorRate: 100,
    });
  });

  it('reports 100% when every attempted record was declined by the judge', () => {
    // A decline is a null score with a label on it — an attempt that produced
    // nothing, so it belongs in the numerator alongside errors.
    expect(computeBatchSummary(Array.from({ length: 5 }, () => ({ status: 'skipped' })))).toMatchObject({
      skippedCount: 5,
      scoredTotal: 5,
      nullOrErrorRate: 100,
    });
  });

  it('reports 10% for 1 error out of 10 attempts', () => {
    const entries = [{ status: 'error' }, ...Array.from({ length: 9 }, () => ({ status: 'success' }))];
    expect(computeBatchSummary(entries)).toMatchObject({
      successCount: 9,
      errorCount: 1,
      scoredTotal: 10,
      totalCount: 10,
      nullOrErrorRate: 10,
    });
  });

  it('leaves the rate healthy when 1 of 10 records is merely pending', () => {
    // 9 scored, 1 score still in flight. Eval results stream in across CW Logs
    // deliveries, so a late score is not a failure — it is excluded from both
    // sides of the ratio rather than counted against the batch.
    const entries = [{ status: 'pending' }, ...Array.from({ length: 9 }, () => ({ status: 'success' }))];
    expect(computeBatchSummary(entries)).toMatchObject({
      successCount: 9,
      nullCount: 1,
      scoredTotal: 9,
      totalCount: 10,
      nullOrErrorRate: 0,
    });
  });

  it('never exceeds 100 even when pending dwarfs the scored entries', () => {
    // The invariant that forced pending out of the numerator: with a scoredTotal
    // denominator, 5 pending over 1 success would have reported 500%.
    const entries = [{ status: 'success' }, ...Array.from({ length: 5 }, () => ({ status: 'pending' }))];
    const summary = computeBatchSummary(entries);
    expect(summary.scoredTotal).toBe(1);
    expect(summary.nullOrErrorRate).toBe(0);
    expect(summary.nullOrErrorRate).toBeLessThanOrEqual(100);
  });

  it('reports rate 100 for an empty batch — nothing scored is the WORST case', () => {
    // Not a divide-by-zero fallback to "healthy": an evaluator that produced
    // nothing is the worst outcome there is, and it must page rather than pass.
    expect(computeBatchSummary([])).toEqual({
      successCount: 0,
      errorCount: 0,
      nullCount: 0,
      skippedCount: 0,
      scoredTotal: 0,
      totalCount: 0,
      nullOrErrorRate: 100,
    });
  });

  it('reports rate 100 when scoredTotal is 0 but records were delivered', () => {
    // An all-pending batch: the evaluator attempted nothing. Same worst case.
    expect(computeBatchSummary(Array.from({ length: 8 }, () => ({ status: 'pending' })))).toMatchObject({
      nullCount: 8,
      scoredTotal: 0,
      totalCount: 8,
      nullOrErrorRate: 100,
    });
  });

  it('derives status itself for entries that were never classified', () => {
    expect(computeBatchSummary([scored(), scored({ score: null, scoreLabel: null, evidence: null })])).toMatchObject({
      successCount: 1,
      nullCount: 1,
      scoredTotal: 1,
      totalCount: 2,
      nullOrErrorRate: 0,
    });
  });

  it('counts unparseable records against the rate instead of diluting it', () => {
    // The dilution bug: as `skipped` these left the denominator, so 3 garbage
    // records + 1 good score read as 0%. Now they are errors: 3 of 4.
    const summary = computeBatchSummary([
      scored(),
      ...Array.from({ length: 3 }, (_, i) => ({ timestamp: i, rawMessage: 'not json', parseError: true })),
    ]);
    expect(summary).toMatchObject({ successCount: 1, errorCount: 3, scoredTotal: 4, nullOrErrorRate: 75 });
  });

  it('rounds the rate to a whole percent', () => {
    // 1 of 3 → 33.33… → 33
    expect(computeBatchSummary([{ status: 'error' }, { status: 'success' }, { status: 'success' }]).nullOrErrorRate).toBe(
      33
    );
  });

  it('keeps scoredTotal = success + error + skipped and totalCount = every entry', () => {
    const summary = computeBatchSummary([
      { status: 'success' },
      { status: 'error' },
      { status: 'skipped' },
      { status: 'pending' },
    ]);
    expect(summary.scoredTotal).toBe(summary.successCount + summary.errorCount + summary.skippedCount);
    expect(summary.scoredTotal).toBe(3);
    // totalCount stays in the output for the dashboard/improver prompt that read it.
    expect(summary.totalCount).toBe(4);
    expect(summary.nullOrErrorRate).toBe(67);
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
