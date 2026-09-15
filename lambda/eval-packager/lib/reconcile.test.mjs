/**
 * Reconcile entry point (TEAM-4688).
 *
 * The reconcile is the safety net under a push pipe that provably drops things,
 * so the properties worth pinning are the ones that make it safe to run daily
 * and over six weeks of history at once:
 *   - a window push already covered writes NOTHING (and rewrites no bucket),
 *   - a gap writes exactly the missing row and fixes that day's buckets,
 *   - --dry-run writes nothing at all but still reports what it would write,
 *   - the legacy group map beats name-based resolution,
 *   - it never touches the eval-config item, the seen-set or the improver.
 *
 * The DynamoDB and CloudWatch Logs clients are fakes keyed on the real command
 * classes, so the SDK's own shapes are exercised without a network.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MAX_EVENTS_PER_PASS,
  RESULTS_GROUP_PREFIX,
  agentIdForGroup,
  bucketFromRows,
  buildDailySetExpression,
  legacyGroupMap,
  listResultsGroups,
  reconcile,
  windowDays,
} from './reconcile.mjs';
// The REAL extract → dedup → role-guard chain, imported from the handler module:
// a fixture copy could drift, and "one code path" is the property under test.
import { extractSessionData } from '../index.mjs';

const RESULTS_TABLE = 'agentcore-hub-eval-results';
const DAILY_TABLE = process.env.EVAL_DAILY_TABLE || 'agentcore-hub-eval-daily';
const RUNTIME = 'agentcore_hub_agent';
const LIVE_GROUP = `${RESULTS_GROUP_PREFIX}eval_agentcore_hub_agent-AbC123`;
const LEGACY_GROUP = `${RESULTS_GROUP_PREFIX}eval_agentcore_hub_requirements_analyst-HbkURg7M1P`;

const AGENTS = [
  { agentId: RUNTIME, evalConfigName: 'eval_agentcore_hub_agent' },
  {
    agentId: 'agentcore_hub_requirements_analyst',
    evalConfigName: 'eval_agentcore_hub_requirements_analyst',
  },
];

// The real deploy/evaluations/legacy-results-groups.json, base64 of compact JSON.
const LEGACY_B64 = Buffer.from(
  JSON.stringify({
    _note: 'metadata — must be ignored',
    'eval_agentcore_hub_requirements_analyst-HbkURg7M1P': RUNTIME,
  })
).toString('base64');

/** One evaluator result log record, in the OTEL shape the judge emits. */
function logEvent({
  sessionId = `TEAM-1_wf_1_a-agentcore_hub_backend_dev-1757900123456`,
  evaluator = 'Builtin.Correctness',
  score = 0.5,
  requestId = 'req-1',
  timestamp = Date.UTC(2026, 8, 14, 12, 0, 0),
} = {}) {
  return {
    timestamp,
    message: JSON.stringify({
      requestId,
      attributes: {
        'session.id': sessionId,
        'gen_ai.evaluation.name': evaluator,
        'gen_ai.evaluation.score.value': score,
        'gen_ai.evaluation.explanation': 'because',
      },
    }),
  };
}

/** CloudWatch Logs fake: a group → events map, with pagination on request. */
function fakeLogs({ groups = [LIVE_GROUP], events = {}, paginateGroups = false } = {}) {
  const calls = { describe: 0, filter: [] };
  return {
    calls,
    async send(cmd) {
      const name = cmd.constructor.name;
      if (name === 'DescribeLogGroupsCommand') {
        calls.describe += 1;
        expect(cmd.input.logGroupNamePrefix).toBe(RESULTS_GROUP_PREFIX);
        if (!paginateGroups) return { logGroups: groups.map((g) => ({ logGroupName: g })) };
        // one group per page, to prove the pagination loop
        const idx = cmd.input.nextToken ? Number(cmd.input.nextToken) : 0;
        return {
          logGroups: [{ logGroupName: groups[idx] }],
          nextToken: idx + 1 < groups.length ? String(idx + 1) : undefined,
        };
      }
      if (name === 'FilterLogEventsCommand') {
        calls.filter.push({ ...cmd.input });
        const day = new Date(cmd.input.startTime).toISOString().slice(0, 10);
        const all = events[`${cmd.input.logGroupName} ${day}`] || [];
        // Page the events one at a time when there is more than one, so the
        // nextToken loop is exercised on every non-trivial group-day.
        const idx = cmd.input.nextToken ? Number(cmd.input.nextToken) : 0;
        if (all.length <= 1) return { events: all };
        return {
          events: all.slice(idx, idx + 1),
          nextToken: idx + 1 < all.length ? String(idx + 1) : undefined,
        };
      }
      throw new Error(`unexpected logs command ${name}`);
    },
  };
}

/** DynamoDB fake with real conditional-put and begins_with query semantics. */
function fakeDdb({ seed = [] } = {}) {
  const rows = new Map(); // `${agentId}#${sk}` → item
  for (const r of seed) rows.set(`${r.agentId}#${r.sk}`, r);
  const state = { rows, updates: [], puts: [], queries: [], batchGets: [], tables: new Set() };
  return {
    state,
    async send(cmd) {
      const name = cmd.constructor.name;
      state.tables.add(cmd.input.TableName || Object.keys(cmd.input.RequestItems || {})[0]);
      if (name === 'PutCommand') {
        state.puts.push(cmd.input);
        const key = `${cmd.input.Item.agentId}#${cmd.input.Item.sk}`;
        if (cmd.input.ConditionExpression === 'attribute_not_exists(sk)' && rows.has(key)) {
          const err = new Error('conditional request failed');
          err.name = 'ConditionalCheckFailedException';
          throw err;
        }
        rows.set(key, cmd.input.Item);
        return {};
      }
      if (name === 'QueryCommand') {
        state.queries.push(cmd.input);
        const { ':pk': pk, ':day': day } = cmd.input.ExpressionAttributeValues;
        return {
          Items: [...rows.values()].filter((r) => r.agentId === pk && r.sk.startsWith(day)),
        };
      }
      if (name === 'BatchGetCommand') {
        state.batchGets.push(cmd.input);
        const table = Object.keys(cmd.input.RequestItems)[0];
        const keys = cmd.input.RequestItems[table].Keys;
        return {
          Responses: {
            [table]: keys.filter((k) => rows.has(`${k.agentId}#${k.sk}`)).map((k) => ({ sk: k.sk })),
          },
        };
      }
      if (name === 'UpdateCommand') {
        state.updates.push(cmd.input);
        return {};
      }
      throw new Error(`unexpected ddb command ${name}`);
    },
  };
}

function deps(over = {}) {
  return {
    loadAgents: async () => AGENTS,
    resolveAgentId: (logGroup, list) =>
      list.find((a) => a.evalConfigName && logGroup.includes(a.evalConfigName))?.agentId || null,
    extractSessionData,
    table: RESULTS_TABLE,
    dailyTable: DAILY_TABLE,
    legacy: {},
    now: () => '2026-09-15T00:00:00.000Z',
    ...over,
  };
}

describe('windowDays', () => {
  const NOW = Date.parse('2026-09-15T04:00:00Z');

  it('takes the last N days ENDING TODAY, so days:2 closes an overnight gap', () => {
    expect(windowDays({ days: 2 }, NOW)).toEqual(['2026-09-14', '2026-09-15']);
  });

  it('defaults to today when no window is given', () => {
    expect(windowDays({}, NOW)).toEqual(['2026-09-15']);
  });

  it('walks an inclusive from/to range in UTC', () => {
    expect(windowDays({ from: '2026-08-30', to: '2026-09-02' }, NOW)).toEqual([
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
    ]);
  });

  it('treats a lone from as a single day', () => {
    expect(windowDays({ from: '2026-09-01' }, NOW)).toEqual(['2026-09-01']);
  });

  it('rejects a malformed or inverted range instead of sweeping something else', () => {
    expect(() => windowDays({ from: '01/09/2026' }, NOW)).toThrow(/invalid from\/to/);
    expect(() => windowDays({ from: '2026-09-05', to: '2026-09-01' }, NOW)).toThrow(/is after/);
  });
});

describe('legacyGroupMap', () => {
  it('decodes base64 compact JSON and drops _ metadata keys', () => {
    expect(legacyGroupMap(LEGACY_B64)).toEqual({
      'eval_agentcore_hub_requirements_analyst-HbkURg7M1P': RUNTIME,
    });
  });

  it('is empty when unset, and survives garbage rather than failing the sweep', () => {
    expect(legacyGroupMap(undefined)).toEqual({});
    expect(legacyGroupMap('')).toEqual({});
    expect(legacyGroupMap('not-base64-json')).toEqual({});
    expect(legacyGroupMap(Buffer.from('[1,2]').toString('base64'))).toEqual({});
  });
});

describe('agentIdForGroup', () => {
  const legacy = legacyGroupMap(LEGACY_B64);
  const resolve = deps().resolveAgentId;

  it('lets the legacy map beat name-based resolution', () => {
    // resolveAgentId would file this whole group under the analyst persona's
    // agentId, because the group NAME is what is stale.
    expect(resolve(LEGACY_GROUP, AGENTS)).toBe('agentcore_hub_requirements_analyst');
    expect(agentIdForGroup(LEGACY_GROUP, AGENTS, legacy, resolve)).toBe(RUNTIME);
  });

  it('falls back to name resolution for a group with no entry', () => {
    expect(agentIdForGroup(LIVE_GROUP, AGENTS, legacy, resolve)).toBe(RUNTIME);
  });

  it('matches a legacy entry by distinguishing substring too', () => {
    expect(agentIdForGroup(LEGACY_GROUP, AGENTS, { HbkURg7M1P: 'agentcore_hub_ci_agent' }, resolve)).toBe(
      'agentcore_hub_ci_agent'
    );
  });

  it('returns null for an unrecognised group rather than guessing', () => {
    expect(agentIdForGroup(`${RESULTS_GROUP_PREFIX}eval_unknown-XYZ`, AGENTS, {}, resolve)).toBeNull();
  });
});

describe('listResultsGroups', () => {
  it('paginates DescribeLogGroups under the results prefix', async () => {
    const logs = fakeLogs({ groups: [LIVE_GROUP, LEGACY_GROUP], paginateGroups: true });
    await expect(listResultsGroups(logs)).resolves.toEqual([LIVE_GROUP, LEGACY_GROUP]);
    expect(logs.calls.describe).toBe(2);
  });

  it('honours a group filter given as a full name or a leaf', async () => {
    const logs = fakeLogs({ groups: [LIVE_GROUP, LEGACY_GROUP] });
    await expect(listResultsGroups(logs, LEGACY_GROUP)).resolves.toEqual([LEGACY_GROUP]);
    await expect(
      listResultsGroups(logs, 'eval_agentcore_hub_requirements_analyst-HbkURg7M1P')
    ).resolves.toEqual([LEGACY_GROUP]);
  });
});

describe('bucketFromRows / buildDailySetExpression', () => {
  const rows = [
    { sessionId: 's1', evaluator: 'Builtin.Correctness', score: 0.5, errorType: null },
    { sessionId: 's1', evaluator: 'Builtin.Correctness', score: 1, errorType: null },
    { sessionId: 's2', evaluator: 'Builtin.Correctness', score: 0.25, errorType: null },
    { sessionId: 's3', evaluator: 'Builtin.Correctness', score: null, errorType: 'ThrottlingException' },
  ];

  it('counts distinct sessions and averages only scored rows', () => {
    expect(bucketFromRows(rows)).toEqual({
      sessions: 3,
      evalScores: { 'Builtin.Correctness': { sum: 1.75, count: 3 } },
    });
  });

  it('ASSIGNS rather than adds, so a re-run cannot double a bucket', () => {
    const e = buildDailySetExpression(bucketFromRows(rows), 'NOW');
    expect(e.UpdateExpression).toBe(
      'SET #updatedAt = :now, #sessions = :sessions, #e0s = :e0s, #e0c = :e0c'
    );
    expect(e.UpdateExpression).not.toContain('ADD');
    expect(e.ExpressionAttributeValues).toEqual({
      ':now': 'NOW',
      ':sessions': 3,
      ':e0s': 1.75,
      ':e0c': 3,
    });
    expect(e.ExpressionAttributeNames['#e0s']).toBe('e|Builtin.Correctness|sum');
  });

  it('names no token attribute, so the token-aggregator’s fields survive', () => {
    const e = buildDailySetExpression(bucketFromRows(rows), 'NOW');
    const named = Object.values(e.ExpressionAttributeNames).join(' ');
    expect(named).not.toContain('m|');
    expect(named).not.toContain('expiresAt');
  });
});

describe('reconcile', () => {
  let logs;
  let ddb;

  const oneEvent = { [`${LIVE_GROUP} 2026-09-14`]: [logEvent()] };

  beforeEach(() => {
    logs = fakeLogs({ events: oneEvent });
    ddb = fakeDdb();
  });

  it('writes the missing row and rewrites that day’s runtime + persona buckets', async () => {
    const res = await reconcile({ mode: 'reconcile', from: '2026-09-14', to: '2026-09-14' }, { ...deps(), ddb, logs });

    expect(res).toMatchObject({
      mode: 'reconcile',
      dryRun: false,
      days: ['2026-09-14'],
      rowsWritten: 1,
      duplicates: 0,
      failed: 0,
    });
    expect(res.perDay['2026-09-14']).toMatchObject({ rows: 1, dupes: 0, sessions: 1 });

    // The stored row is a reconcile row, keyed exactly as a pushed one.
    const [put] = ddb.state.puts;
    expect(put.TableName).toBe(RESULTS_TABLE);
    expect(put.ConditionExpression).toBe('attribute_not_exists(sk)');
    expect(put.Item).toMatchObject({
      agentId: RUNTIME,
      persona: 'agentcore_hub_backend_dev',
      source: 'reconcile',
      logGroup: LIVE_GROUP,
      day: '2026-09-14',
      workflowId: 'wf_1_a',
    });

    // Two bucket items: the runtime rollup and the persona row, same day, SET.
    expect(ddb.state.updates.map((u) => [u.TableName, u.Key.agentId, u.Key.day])).toEqual([
      [DAILY_TABLE, RUNTIME, '2026-09-14'],
      [DAILY_TABLE, `${RUNTIME}#agentcore_hub_backend_dev`, '2026-09-14'],
    ]);
    expect(ddb.state.updates.every((u) => u.UpdateExpression.startsWith('SET '))).toBe(true);
  });

  it('writes NOTHING and rewrites no bucket when push already covered the window', async () => {
    // First pass stores the row; the second sees the same log events again.
    await reconcile({ mode: 'reconcile', from: '2026-09-14', to: '2026-09-14' }, { ...deps(), ddb, logs });
    ddb.state.updates.length = 0;

    const res = await reconcile({ mode: 'reconcile', from: '2026-09-14', to: '2026-09-14' }, { ...deps(), ddb, logs });

    expect(res).toMatchObject({ rowsWritten: 0, duplicates: 1, failed: 0, bucketsUpdated: 0 });
    expect(ddb.state.updates).toEqual([]);
  });

  it('reports what a dry run WOULD write, and writes nothing', async () => {
    const res = await reconcile(
      { mode: 'reconcile', from: '2026-09-14', to: '2026-09-14', dryRun: true },
      { ...deps(), ddb, logs }
    );

    expect(res).toMatchObject({ dryRun: true, rowsWritten: 1, duplicates: 0, bucketsUpdated: 0 });
    expect(ddb.state.puts).toEqual([]);
    expect(ddb.state.updates).toEqual([]);
    // It read the keys it would have written, and only those.
    expect(ddb.state.batchGets).toHaveLength(1);
    expect(ddb.state.batchGets[0].RequestItems[RESULTS_TABLE].Keys).toHaveLength(1);
  });

  it('counts an already-stored row as a duplicate in a dry run', async () => {
    await reconcile({ mode: 'reconcile', from: '2026-09-14', to: '2026-09-14' }, { ...deps(), ddb, logs });
    const res = await reconcile(
      { mode: 'reconcile', from: '2026-09-14', to: '2026-09-14', dryRun: true },
      { ...deps(), ddb, logs }
    );
    expect(res).toMatchObject({ rowsWritten: 0, duplicates: 1 });
  });

  it('files a legacy group’s rows under the agent that really produced them', async () => {
    logs = fakeLogs({
      groups: [LEGACY_GROUP],
      events: { [`${LEGACY_GROUP} 2026-09-14`]: [logEvent()] },
    });
    const res = await reconcile(
      { mode: 'reconcile', from: '2026-09-14', to: '2026-09-14' },
      { ...deps({ legacy: legacyGroupMap(LEGACY_B64) }), ddb, logs }
    );

    expect(res.rowsWritten).toBe(1);
    expect(ddb.state.puts[0].Item.agentId).toBe(RUNTIME);
  });

  it('skips a group no rule can attribute, and keeps sweeping the rest', async () => {
    logs = fakeLogs({
      groups: [`${RESULTS_GROUP_PREFIX}eval_unknown-XYZ`, LIVE_GROUP],
      events: oneEvent,
    });
    const res = await reconcile({ mode: 'reconcile', days: 1 }, { ...deps({ now: () => '2026-09-14T06:00:00.000Z' }), ddb, logs });

    expect(res).toMatchObject({ groups: 2, skippedGroups: 1, rowsWritten: 1, failed: 0 });
  });

  it('restricts the sweep to one group when asked', async () => {
    logs = fakeLogs({ groups: [LIVE_GROUP, LEGACY_GROUP], events: oneEvent });
    await reconcile(
      { mode: 'reconcile', from: '2026-09-14', to: '2026-09-14', group: LEGACY_GROUP },
      { ...deps({ legacy: legacyGroupMap(LEGACY_B64) }), ddb, logs }
    );
    expect([...new Set(logs.calls.filter.map((f) => f.logGroupName))]).toEqual([LEGACY_GROUP]);
  });

  it('asks CloudWatch for exactly the UTC bounds of each day in the window', async () => {
    await reconcile({ mode: 'reconcile', from: '2026-09-13', to: '2026-09-14' }, { ...deps(), ddb, logs });
    expect(logs.calls.filter.map((f) => [f.startTime, f.endTime])).toEqual([
      [Date.parse('2026-09-13T00:00:00Z'), Date.parse('2026-09-13T23:59:59.999Z')],
      [Date.parse('2026-09-14T00:00:00Z'), Date.parse('2026-09-14T23:59:59.999Z')],
    ]);
  });

  it('paginates a day’s events and dedups them like one delivery', async () => {
    // Same evaluation attempt logged twice (a judge retry) plus a distinct one:
    // the in-delivery dedup keeps one of the pair, so 2 rows land, not 3.
    logs = fakeLogs({
      events: {
        [`${LIVE_GROUP} 2026-09-14`]: [
          logEvent(),
          logEvent(),
          logEvent({ requestId: 'req-2', evaluator: 'Builtin.Helpfulness', score: 1 }),
        ],
      },
    });
    const res = await reconcile({ mode: 'reconcile', from: '2026-09-14', to: '2026-09-14' }, { ...deps(), ddb, logs });

    expect(logs.calls.filter).toHaveLength(3); // three pages, one event each
    expect(res.rowsWritten).toBe(2);
    expect(res.perDay['2026-09-14'].events).toBe(3);
  });

  it('recomputes a day’s buckets from ALL stored rows, not just the ones it wrote', async () => {
    // A row from an earlier pass (or the other results group) is already stored.
    ddb = fakeDdb({
      seed: [
        {
          agentId: RUNTIME,
          sk: '2026-09-14T09:00:00.000Z#req-0|Builtin.Correctness',
          sessionId: 'TEAM-9_wf_9_z-agentcore_hub_qa_engineer-1757900123456',
          persona: 'agentcore_hub_qa_engineer',
          evaluator: 'Builtin.Correctness',
          score: 1,
          errorType: null,
          day: '2026-09-14',
        },
      ],
    });
    await reconcile({ mode: 'reconcile', from: '2026-09-14', to: '2026-09-14' }, { ...deps(), ddb, logs });

    const runtimeUpdate = ddb.state.updates.find((u) => u.Key.agentId === RUNTIME);
    expect(runtimeUpdate.ExpressionAttributeValues).toMatchObject({
      ':sessions': 2,
      ':e0s': 1.5,
      ':e0c': 2,
    });
    // Both personas get their own row; neither is the `_runtime` rollup.
    expect(ddb.state.updates.map((u) => u.Key.agentId).sort()).toEqual([
      RUNTIME,
      `${RUNTIME}#agentcore_hub_backend_dev`,
      `${RUNTIME}#agentcore_hub_qa_engineer`,
    ]);
  });

  it('gives a session with no persona no persona row — it IS the rollup', async () => {
    logs = fakeLogs({
      events: {
        [`${LIVE_GROUP} 2026-09-14`]: [logEvent({ sessionId: 'cc-3f7a1b9c4d2e4f8a9b0c1d2e3f4a5b6c' })],
      },
    });
    await reconcile({ mode: 'reconcile', from: '2026-09-14', to: '2026-09-14' }, { ...deps(), ddb, logs });

    expect(ddb.state.puts[0].Item.persona).toBe('_runtime');
    expect(ddb.state.updates.map((u) => u.Key.agentId)).toEqual([RUNTIME]);
  });

  it('survives an unreadable group-day and still sweeps the next one', async () => {
    const good = fakeLogs({ events: oneEvent });
    logs = {
      calls: good.calls,
      async send(cmd) {
        if (cmd.constructor.name === 'FilterLogEventsCommand' && cmd.input.startTime === Date.parse('2026-09-13T00:00:00Z')) {
          throw new Error('ThrottlingException');
        }
        return good.send(cmd);
      },
    };
    const res = await reconcile({ mode: 'reconcile', from: '2026-09-13', to: '2026-09-14' }, { ...deps(), ddb, logs });

    expect(res).toMatchObject({ rowsWritten: 1, failed: 1 });
  });

  it('touches only the results and daily tables — never eval-config or the seen-set', async () => {
    await reconcile({ mode: 'reconcile', from: '2026-09-14', to: '2026-09-14' }, { ...deps(), ddb, logs });
    expect([...ddb.state.tables].sort()).toEqual([DAILY_TABLE, RESULTS_TABLE].sort());
  });

  it('is a no-op on a window with no events at all', async () => {
    logs = fakeLogs({ events: {} });
    const res = await reconcile({ mode: 'reconcile', days: 3 }, { ...deps(), ddb, logs });

    expect(res).toMatchObject({ rowsWritten: 0, duplicates: 0, failed: 0, bucketsUpdated: 0 });
    expect(ddb.state.puts).toEqual([]);
    expect(ddb.state.updates).toEqual([]);
    expect(res.days).toEqual(['2026-09-13', '2026-09-14', '2026-09-15']);
  });

  it('keeps the in-memory pass bounded', () => {
    // A pathological day is chunked rather than held whole; the constant is the
    // contract the flush loop relies on.
    expect(MAX_EVENTS_PER_PASS).toBeGreaterThan(1000);
  });
});
