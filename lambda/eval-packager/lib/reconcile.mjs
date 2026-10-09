/**
 * Reconcile: the packager's SECOND entry point (TEAM-4688).
 *
 * The CloudWatch Logs subscription filter is a push pipe, and a push pipe drops
 * things — a Lambda throttle, a filter that was detached for an afternoon, a
 * results group that only existed before the fleet was consolidated. The
 * evaluator results LOG GROUPS remain the system of record; the results table is
 * a queryable mirror of them. This module re-reads the groups for a window of
 * UTC days and writes whatever the mirror is missing.
 *
 *   { mode: "reconcile", days: 2 }                       ← daily EventBridge rule
 *   { mode: "reconcile", from: "2026-09-01", to: "…" }    ← backfill-results.mjs
 *   … plus optional { group, dryRun }
 *
 * ONE CODE PATH, TWO ENTRY POINTS: the events are wrapped in exactly the shape a
 * subscription delivery has and pushed through the SAME
 * extractSessionData → dedupeResults → applyRoleGuard → toResultRows → putResults
 * chain the push path uses, so a backfilled row is indistinguishable from a
 * pushed one and the conditional put makes overlap free.
 *
 * What it deliberately does NOT touch: the eval-config item (all-time
 * scorecard, sessionBuffer, lastFlushedAt), the seen-set, and the improver. A
 * reconcile must never flush a batch or synthesize a PRD — re-reading six weeks
 * of history would otherwise start six weeks of workflows.
 *
 * Day buckets ARE rewritten, with SET rather than the push path's ADD: after a
 * day has been re-ingested, the stored rows for that (agentId, day) are the
 * authoritative count, so recomputing and assigning is idempotent where a
 * second ADD would double it. Token/cost attributes on the same item are
 * written by lambda/token-aggregator and are never named here, so they survive
 * untouched. A stale `e|<evaluator>|*` pair from a RENAMED evaluator is left in
 * place (SET only assigns the attributes it computed).
 */

import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { BatchGetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DAILY_TABLE, evaluatorAttr, isScoredRow, RUNTIME_PERSONA, personaDailyKey } from './daily.mjs';
import { putResults, resultsTable, toResultRows } from './results-store.mjs';

/** Every AgentCore online-evaluation results group lives under this prefix. */
export const RESULTS_GROUP_PREFIX = '/aws/bedrock-agentcore/evaluations/results/';

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Cap on the events held in memory before they are pushed through the pipeline.
 *
 * A group-day is normally a few hundred records, so the common case is one pass
 * per group-day with exactly the push path's in-delivery dedup semantics. The cap
 * only splits a pathologically busy day, at the cost of dedup running per chunk
 * instead of per day — harmless, because the conditional put collapses identical
 * rows anyway.
 */
export const MAX_EVENTS_PER_PASS = 20_000;

/**
 * Decode LEGACY_RESULTS_GROUPS_B64 (base64 of the compact JSON in
 * deploy/evaluations/legacy-results-groups.json).
 *
 * The map ships base64-encoded because `aws lambda update-function-configuration
 * --environment` takes a `Variables={K=V,...}` shell list, which raw JSON cannot
 * survive. Keys beginning with `_` are metadata (`_note`) and are dropped here so
 * the consumer can never match one. A malformed value must not take the whole
 * reconcile down — a missing legacy map means legacy groups resolve by name, the
 * behaviour that existed before this file.
 */
export function legacyGroupMap(b64 = process.env.LEGACY_RESULTS_GROUPS_B64) {
  if (!b64) return {};
  try {
    const parsed = JSON.parse(Buffer.from(String(b64), 'base64').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([k, v]) => !k.startsWith('_') && typeof v === 'string')
    );
  } catch (err) {
    console.error(`[eval-packager] LEGACY_RESULTS_GROUPS_B64 is not valid base64 JSON: ${err.message}`);
    return {};
  }
}

/**
 * Which agent produced the sessions in this results group?
 *
 * The legacy map is consulted FIRST — exact leaf match, then distinguishing
 * substring — because `resolveAgentId` derives the agent from the group NAME, and
 * for a pre-consolidation group the name is exactly what lies: the group called
 * `…/eval_agentcore_hub_requirements_analyst-HbkURg7M1P` holds sessions from
 * every persona on the shared runtime, so name resolution would file the whole
 * history under one persona's agentId.
 */
export function agentIdForGroup(logGroup, agentList, legacyMap, resolveAgentId) {
  const leaf = String(logGroup || '').split('/').pop();
  if (legacyMap[leaf]) return legacyMap[leaf];
  for (const [key, agentId] of Object.entries(legacyMap)) {
    if (logGroup.includes(key)) return agentId;
  }
  return resolveAgentId(logGroup, agentList) || null;
}

/**
 * The UTC days to sweep: `{from,to}` (inclusive, from the CLI) or the last
 * `days` days ENDING TODAY (`days: 2` = yesterday + today, which is what the
 * daily rule needs to close an overnight gap around midnight UTC).
 */
export function windowDays(event = {}, now = Date.now()) {
  const { from, to, days } = event;
  if (from || to) {
    const a = DAY_RE.test(from || '') ? from : null;
    const b = DAY_RE.test(to || '') ? to : a;
    if (!a) throw new Error(`reconcile: invalid from/to (${from} → ${to}), expected YYYY-MM-DD`);
    if (b < a) throw new Error(`reconcile: from (${a}) is after to (${b})`);
    const out = [];
    for (let t = Date.parse(`${a}T00:00:00Z`); t <= Date.parse(`${b}T00:00:00Z`); t += DAY_MS) {
      out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
  }
  const n = Number.isFinite(Number(days)) && Number(days) > 0 ? Math.floor(Number(days)) : 1;
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(today - (n - 1 - i) * DAY_MS).toISOString().slice(0, 10));
}

/** List the results groups, honouring an optional `group` filter (name or leaf). */
export async function listResultsGroups(logs, filter = null) {
  const names = [];
  let nextToken;
  do {
    const res = await logs.send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: RESULTS_GROUP_PREFIX, nextToken })
    );
    for (const g of res.logGroups || []) if (g.logGroupName) names.push(g.logGroupName);
    nextToken = res.nextToken;
  } while (nextToken);
  if (!filter) return names;
  const wanted = names.filter((n) => n === filter || n.endsWith(filter) || n.includes(filter));
  return wanted;
}

/** Every event in one UTC day of one group, paginated. */
async function* dayEvents(logs, logGroupName, day) {
  const startTime = Date.parse(`${day}T00:00:00Z`);
  const endTime = startTime + DAY_MS - 1;
  let nextToken;
  do {
    const res = await logs.send(
      new FilterLogEventsCommand({ logGroupName, startTime, endTime, nextToken })
    );
    for (const e of res.events || []) yield e;
    nextToken = res.nextToken;
  } while (nextToken);
}

/**
 * Dry-run classification: which of these rows does the mirror already hold?
 *
 * BatchGetItem in chunks of 100 (the API cap), projecting only the sort key. A
 * dry run that reported zero rows would be useless for sizing a backfill, so it
 * reads instead of writing — and reads exactly the keys the live run would have
 * conditional-put.
 */
export async function countExisting(ddb, rows, TableName) {
  let present = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const res = await ddb.send(
      new BatchGetCommand({
        RequestItems: {
          [TableName]: {
            Keys: chunk.map((r) => ({ agentId: r.agentId, sk: r.sk })),
            ProjectionExpression: 'sk',
          },
        },
      })
    );
    present += (res?.Responses?.[TableName] || []).length;
  }
  return { present, missing: rows.length - present };
}

/** Every stored result row for one (agentId, day), paginated. */
export async function queryDayRows(ddb, TableName, agentId, day) {
  const rows = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName,
        KeyConditionExpression: 'agentId = :pk AND begins_with(sk, :day)',
        ExpressionAttributeValues: { ':pk': agentId, ':day': day },
        ExclusiveStartKey,
      })
    );
    rows.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return rows;
}

/**
 * Fold stored rows into `{ sessions, evalScores }` — the same shape the push
 * path's daily delta has, so the two writers agree on what a bucket means.
 *
 * `isScoredRow` (lib/daily.mjs) decides eligibility, fed the stored row adapted
 * back to the classified-entry field names, so "scored" can never drift between
 * the push path and the reconcile.
 */
export function bucketFromRows(rows = []) {
  const sessions = new Set();
  const evalScores = {};
  for (const r of rows) {
    if (r.sessionId) sessions.add(r.sessionId);
    const adapted = { evaluatorName: r.evaluator, score: r.score, errorType: r.errorType };
    if (!isScoredRow(adapted)) continue;
    (evalScores[r.evaluator] ||= { sum: 0, count: 0 });
    evalScores[r.evaluator].sum += r.score;
    evalScores[r.evaluator].count += 1;
  }
  return { sessions: sessions.size, evalScores };
}

/**
 * The SET counterpart of buildDailyEvalExpression's ADD: assign a recomputed
 * bucket. Only the attributes this function computed are named, so the
 * token-aggregator's `m|<model>|<field>` attributes on the same item are not
 * disturbed.
 */
export function buildDailySetExpression(bucket, now) {
  const names = { '#updatedAt': 'updatedAt', '#sessions': 'sessions' };
  const values = { ':now': now, ':sessions': bucket.sessions };
  const sets = ['#updatedAt = :now', '#sessions = :sessions'];
  Object.entries(bucket.evalScores).forEach(([evaluator, d], i) => {
    names[`#e${i}s`] = evaluatorAttr(evaluator, 'sum');
    names[`#e${i}c`] = evaluatorAttr(evaluator, 'count');
    values[`:e${i}s`] = d.sum;
    values[`:e${i}c`] = d.count;
    sets.push(`#e${i}s = :e${i}s`, `#e${i}c = :e${i}c`);
  });
  return {
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

/**
 * Recompute the runtime row and every persona row for one (agentId, day) from
 * the stored rows.
 *
 * Reads the WHOLE (agentId, day) partition, not just the group that was
 * re-ingested, so a day whose rows arrived from two results groups (a legacy
 * group plus the live one) still ends up with one correct total. `_runtime` rows
 * are the rollup and get no separate item, exactly as on the push path.
 */
export async function rewriteDayBuckets(ddb, agentId, day, { table, dailyTable, now }) {
  const rows = await queryDayRows(ddb, table, agentId, day);
  const byPersona = new Map();
  for (const r of rows) {
    const persona = r.persona || RUNTIME_PERSONA;
    if (persona === RUNTIME_PERSONA) continue;
    if (!byPersona.has(persona)) byPersona.set(persona, []);
    byPersona.get(persona).push(r);
  }

  const runtimeBucket = bucketFromRows(rows);
  const writes = [[agentId, runtimeBucket]];
  for (const [persona, personaRows] of byPersona) {
    writes.push([personaDailyKey(agentId, persona), bucketFromRows(personaRows)]);
  }

  let updated = 0;
  for (const [pk, bucket] of writes) {
    const expr = buildDailySetExpression(bucket, now);
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: dailyTable,
          Key: { agentId: pk, day },
          UpdateExpression: expr.UpdateExpression,
          ExpressionAttributeNames: expr.ExpressionAttributeNames,
          ExpressionAttributeValues: expr.ExpressionAttributeValues,
        })
      );
      updated += 1;
    } catch (err) {
      // Non-fatal, exactly as on the push path: a failed bucket write leaves the
      // windowed dashboard stale for a day; tomorrow's reconcile fixes it, and
      // the per-result rows (the thing that cannot be recomputed) are already in.
      console.error(`[eval-packager] reconcile ${pk} ${day}: bucket SET failed: ${err.message}`);
    }
  }
  return { sessions: runtimeBucket.sessions, bucketsUpdated: updated, storedRows: rows.length };
}

/**
 * Run a reconcile pass.
 *
 * `deps` is fully injectable so the tests drive the whole thing with fakes:
 *   ddb                — DynamoDBDocumentClient (results + daily tables)
 *   logs               — CloudWatchLogsClient (defaults to a fresh client)
 *   loadAgents         — index.mjs's S3-cached agents.json loader
 *   resolveAgentId     — index.mjs's name-based resolver (legacy map wins over it)
 *   extractSessionData — index.mjs's extract → dedup → role-guard chain
 */
export async function reconcile(event = {}, deps = {}) {
  const {
    ddb,
    logs = new CloudWatchLogsClient({}),
    loadAgents,
    resolveAgentId,
    extractSessionData,
    table = resultsTable(),
    dailyTable = DAILY_TABLE,
    legacy = legacyGroupMap(),
    now = () => new Date().toISOString(),
  } = deps;

  const dryRun = event.dryRun === true;
  const days = windowDays(event, Date.parse(typeof now === 'function' ? now() : now) || Date.now());
  const agentList = await loadAgents();
  const groups = await listResultsGroups(logs, event.group || null);

  const perDay = {};
  const touched = new Set(); // `${agentId} ${day}`
  let rowsWritten = 0;
  let duplicates = 0;
  let failed = 0;
  let skippedGroups = 0;

  const dayEntry = (day) => (perDay[day] ||= { day, rows: 0, dupes: 0, sessions: 0, events: 0 });

  for (const logGroup of groups) {
    const agentId = agentIdForGroup(logGroup, agentList, legacy, resolveAgentId);
    if (!agentId) {
      skippedGroups += 1;
      console.log(`[eval-packager] reconcile: no agent for results group ${logGroup} — skipped`);
      continue;
    }

    for (const day of days) {
      let batch = [];
      const flush = async () => {
        if (batch.length === 0) return;
        const events = batch;
        batch = [];
        dayEntry(day).events += events.length;
        const sessionData = extractSessionData({ logGroup, logStream: 'reconcile', logEvents: events });
        const rows = toResultRows(agentId, sessionData.evaluatorResults, {
          source: 'reconcile',
          logGroup,
        });
        if (rows.length === 0) return;
        if (dryRun) {
          const { present, missing } = await countExisting(ddb, rows, table);
          rowsWritten += missing;
          duplicates += present;
          dayEntry(day).rows += missing;
          dayEntry(day).dupes += present;
          return;
        }
        const put = await putResults(ddb, rows, table);
        rowsWritten += put.written;
        duplicates += put.duplicate;
        failed += put.failed;
        dayEntry(day).rows += put.written;
        dayEntry(day).dupes += put.duplicate;
        if (put.written > 0) touched.add(`${agentId} ${day}`);
      };

      try {
        for await (const e of dayEvents(logs, logGroup, day)) {
          batch.push({ timestamp: e.timestamp, message: e.message });
          if (batch.length >= MAX_EVENTS_PER_PASS) await flush();
        }
        await flush();
      } catch (err) {
        // One unreadable group-day must not abandon the rest of the window.
        failed += 1;
        console.error(`[eval-packager] reconcile ${logGroup} ${day}: read failed: ${err.message}`);
      }
    }
  }

  // Recompute buckets only for the (agentId, day) pairs that actually gained
  // rows: a no-op reconcile (the normal case, when push kept up) must not rewrite
  // a single bucket. A dry run rewrites nothing at all.
  let bucketsUpdated = 0;
  if (!dryRun) {
    const stamp = typeof now === 'function' ? now() : now;
    for (const key of touched) {
      const [agentId, day] = key.split(' ');
      const res = await rewriteDayBuckets(ddb, agentId, day, { table, dailyTable, now: stamp });
      bucketsUpdated += res.bucketsUpdated;
      dayEntry(day).sessions += res.sessions;
    }
  }

  const summary = {
    mode: 'reconcile',
    dryRun,
    days,
    groups: groups.length,
    skippedGroups,
    rowsWritten,
    duplicates,
    failed,
    bucketsUpdated,
    perDay,
  };
  console.log(JSON.stringify({ level: 'info', event: 'eval.reconcile.done', ...summary }));
  return summary;
}
