/**
 * Per-result row mapper + conditional writer (TEAM-4688).
 *
 * These rows are the drilldown: if the mapper drops a field or the put is not
 * idempotent, the UI either cannot explain a score or shows the same judge
 * verdict several times. The DDB fake below implements real
 * `attribute_not_exists(sk)` semantics so the duplicate path is exercised for
 * what it is — the EXPECTED outcome of a re-delivery, not an error.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  EXPLANATION_MAX_BYTES,
  putResults,
  resultsTable,
  toResultRow,
  toResultRows,
  truncateExplanation,
} from './results-store.mjs';

const AGENT = 'agentcore_hub_agent';
const SID = 'TEAM-4123_wf_1757900000000_k3j9xq-agentcore_hub_backend_dev-1757900123456';

/** A classified row shaped exactly as extractSessionData emits one. */
function entry(over = {}) {
  return {
    sessionId: SID,
    evaluatorName: 'Builtin.Correctness',
    score: 0.42,
    scoreLabel: 'fail',
    evidence: 'The agent skipped the failing test.',
    errorType: null,
    errorMessage: null,
    errorFlag: 0,
    status: 'COMPLETED',
    statusReason: null,
    requestId: 'req-1',
    dedupKey: 'req-1|Builtin.Correctness',
    timestamp: Date.UTC(2026, 8, 14, 23, 30, 0),
    ...over,
  };
}

describe('toResultRow — keys and dimensions', () => {
  it('maps a pipeline result to keys the four access patterns need', () => {
    const row = toResultRow(AGENT, entry(), { source: 'push', logGroup: '/lg', ingestedAt: 'T0' });

    expect(row.agentId).toBe(AGENT);
    expect(row.sk).toBe('2026-09-14T23:30:00.000Z#req-1|Builtin.Correctness');
    expect(row.gsi1pk).toBe(SID);
    expect(row.gsi1sk).toBe('Builtin.Correctness#2026-09-14T23:30:00.000Z');
    expect(row.gsi2pk).toBe(`${AGENT}#agentcore_hub_backend_dev`);
    expect(row.gsi3pk).toBe('wf_1757900000000_k3j9xq');
    expect(row).toMatchObject({
      persona: 'agentcore_hub_backend_dev',
      workflowId: 'wf_1757900000000_k3j9xq',
      ticketId: 'TEAM-4123',
      evaluator: 'Builtin.Correctness',
      day: '2026-09-14',
      score: 0.42,
      scoreLabel: 'fail',
      explanation: 'The agent skipped the failing test.',
      source: 'push',
      logGroup: '/lg',
      ingestedAt: 'T0',
    });
    expect(row.explanationTruncated).toBeUndefined();
  });

  it('keeps the UTC day of the evaluation, not of ingest', () => {
    // 23:30 on the 14th UTC is still the 14th even when the packager runs on the
    // 15th — otherwise a nightly reconcile would re-file rows onto the wrong day.
    expect(toResultRow(AGENT, entry()).day).toBe('2026-09-14');
  });

  it('carries an un-prefixed workflow id with no ticket', () => {
    const row = toResultRow(
      AGENT,
      entry({ sessionId: 'wf_1757900000000_k3j9xq-agentcore_hub_qa_engineer-1757900123456' })
    );
    expect(row.workflowId).toBe('wf_1757900000000_k3j9xq');
    expect(row.ticketId).toBeUndefined();
    expect(row.persona).toBe('agentcore_hub_qa_engineer');
  });

  it('carries a wf_bug_ workflow id', () => {
    const row = toResultRow(
      AGENT,
      entry({ sessionId: 'TEAM-4577_wf_bug_TEAM-4577-agentcore_hub_bug_fixer-1757900123456' })
    );
    expect(row.workflowId).toBe('wf_bug_TEAM-4577');
    expect(row.gsi3pk).toBe('wf_bug_TEAM-4577');
    expect(row.ticketId).toBe('TEAM-4577');
  });

  it.each([
    ['si-agentcore_hub_agent-1757900123456', 'self-improvement, persona IS the runtime'],
    ['cc-3f7a1b9c4d2e4f8a9b0c1d2e3f4a5b6c', 'cloud code'],
    ['canary-eval-1757900123-agentcore_hub_agent', 'canary'],
    ['wmchat-conv-42000000000000000000000000', 'workflow-manager chat'],
  ])('files %s under the runtime with no workflow (%s)', (sessionId) => {
    const row = toResultRow(AGENT, entry({ sessionId }));
    expect(row.persona).toBe('_runtime');
    expect(row.gsi2pk).toBe(`${AGENT}#_runtime`);
    // gsi3 is SPARSE — a non-pipeline row must not appear in byWorkflow at all.
    expect(row.gsi3pk).toBeUndefined();
    expect(row.workflowId).toBeUndefined();
    expect(row.ticketId).toBeUndefined();
    // still queryable by session and by agent
    expect(row.gsi1pk).toBe(sessionId);
    expect(row.sk).toContain('#req-1|Builtin.Correctness');
  });

  it('passes trace/span ids through for the trace deep link', () => {
    const row = toResultRow(AGENT, entry({ traceId: 'tr-1', spanId: 'sp-1' }));
    expect(row).toMatchObject({ traceId: 'tr-1', spanId: 'sp-1' });
  });

  it('keeps an error verdict with a null score rather than dropping it', () => {
    const row = toResultRow(
      AGENT,
      entry({ score: NaN, scoreLabel: null, errorType: 'ThrottlingException', errorMessage: 'slow down', errorFlag: 1 })
    );
    expect(row.score).toBeNull();
    expect(row).toMatchObject({ errorType: 'ThrottlingException', errorMessage: 'slow down' });
  });

  it('falls back to ingest time when the record has no usable timestamp', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-15T12:00:00.000Z'));
      const row = toResultRow(AGENT, entry({ timestamp: 0 }));
      expect(row.day).toBe('2026-09-15');
      expect(row.sk.startsWith('2026-09-15T12:00:00.000Z#')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('toResultRow — rows with nothing to persist', () => {
  it('drops battery fixtures (hermetic config-eval runs, never real traffic)', () => {
    expect(toResultRow(AGENT, entry({ sessionId: 'battery-run7-case3' }))).toBeNull();
  });

  it('drops parseError placeholders', () => {
    expect(toResultRow(AGENT, { parseError: true, timestamp: Date.now() })).toBeNull();
  });

  it('drops rows with no dedupKey, which have no idempotent sort key to give', () => {
    expect(toResultRow(AGENT, entry({ dedupKey: null }))).toBeNull();
    expect(toResultRow(AGENT, null)).toBeNull();
  });

  it('toResultRows filters the dropped rows out of a delivery', () => {
    const rows = toResultRows(AGENT, [
      entry(),
      entry({ sessionId: 'battery-x' }),
      { parseError: true },
      entry({ dedupKey: 'req-2|Builtin.Correctness', requestId: 'req-2' }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.requestId)).toEqual(['req-1', 'req-2']);
  });
});

describe('truncateExplanation', () => {
  it('leaves an ordinary explanation alone', () => {
    expect(truncateExplanation('short')).toEqual({ explanation: 'short', truncated: false });
  });

  it('flags and bounds an over-long explanation', () => {
    const { explanation, truncated } = truncateExplanation('a'.repeat(EXPLANATION_MAX_BYTES + 500));
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(explanation, 'utf8')).toBeLessThanOrEqual(EXPLANATION_MAX_BYTES);
  });

  it('never emits a broken UTF-8 sequence when the cut lands mid-codepoint', () => {
    // 3-byte chars do not divide the cap evenly, so the naive slice would split one.
    const text = '★'.repeat(EXPLANATION_MAX_BYTES);
    const { explanation, truncated } = truncateExplanation(text);
    expect(truncated).toBe(true);
    expect(explanation).not.toContain('�');
    expect(Buffer.byteLength(explanation, 'utf8')).toBeLessThanOrEqual(EXPLANATION_MAX_BYTES);
  });

  it('normalises a missing explanation to null', () => {
    expect(truncateExplanation(undefined)).toEqual({ explanation: null, truncated: false });
    expect(toResultRow(AGENT, entry({ evidence: undefined })).explanation).toBeNull();
  });

  it('marks the stored row when it truncated', () => {
    const row = toResultRow(AGENT, entry({ evidence: 'x'.repeat(EXPLANATION_MAX_BYTES + 1) }));
    expect(row.explanationTruncated).toBe(true);
  });
});

describe('putResults', () => {
  let stored;
  let ddb;

  beforeEach(() => {
    stored = new Map();
    ddb = {
      sent: [],
      async send(cmd) {
        ddb.sent.push(cmd.input);
        const key = `${cmd.input.Item.agentId}#${cmd.input.Item.sk}`;
        if (cmd.input.ConditionExpression === 'attribute_not_exists(sk)' && stored.has(key)) {
          const err = new Error('The conditional request failed');
          err.name = 'ConditionalCheckFailedException';
          throw err;
        }
        stored.set(key, cmd.input.Item);
        return {};
      },
    };
  });

  it('writes each row once, conditionally, to the configured table', async () => {
    const rows = toResultRows(AGENT, [entry(), entry({ requestId: 'req-2', dedupKey: 'req-2|c' })]);
    const res = await putResults(ddb, rows, 'tbl');

    expect(res).toEqual({ written: 2, duplicate: 0, failed: 0 });
    expect(ddb.sent.map((i) => i.TableName)).toEqual(['tbl', 'tbl']);
    expect(ddb.sent.every((i) => i.ConditionExpression === 'attribute_not_exists(sk)')).toBe(true);
  });

  it('counts a re-delivery as a duplicate, not an error', async () => {
    const rows = toResultRows(AGENT, [entry()]);
    await putResults(ddb, rows, 'tbl');
    const again = await putResults(ddb, toResultRows(AGENT, [entry()]), 'tbl');

    expect(again).toEqual({ written: 0, duplicate: 1, failed: 0 });
    expect(stored.size).toBe(1);
  });

  it('counts and logs a real failure but keeps going and never throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const failing = {
        async send(cmd) {
          if (cmd.input.Item.requestId === 'req-1') throw new Error('ProvisionedThroughputExceeded');
          return {};
        },
      };
      const rows = toResultRows(AGENT, [entry(), entry({ requestId: 'req-2', dedupKey: 'req-2|c' })]);
      await expect(putResults(failing, rows, 'tbl')).resolves.toEqual({
        written: 1,
        duplicate: 0,
        failed: 1,
      });
      expect(err).toHaveBeenCalledTimes(1);
    } finally {
      err.mockRestore();
    }
  });

  it('defaults to the env-configured table name', async () => {
    const prev = process.env.EVAL_RESULTS_TABLE;
    process.env.EVAL_RESULTS_TABLE = 'other-results';
    try {
      expect(resultsTable()).toBe('other-results');
      await putResults(ddb, toResultRows(AGENT, [entry()]));
      expect(ddb.sent[0].TableName).toBe('other-results');
    } finally {
      if (prev === undefined) delete process.env.EVAL_RESULTS_TABLE;
      else process.env.EVAL_RESULTS_TABLE = prev;
    }
  });

  it('is a no-op for an empty delivery', async () => {
    await expect(putResults(ddb, [], 'tbl')).resolves.toEqual({
      written: 0,
      duplicate: 0,
      failed: 0,
    });
    expect(ddb.sent).toHaveLength(0);
  });
});
