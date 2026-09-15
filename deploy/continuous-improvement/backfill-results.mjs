#!/usr/bin/env node
/**
 * deploy/continuous-improvement/backfill-results.mjs
 *
 * Backfills the per-result rows in agentcore-hub-eval-results (PK agentId / SK
 * sk) for a range of UTC days by driving the eval-packager's `reconcile` mode —
 * the SAME code path the daily agentcore-hub-eval-reconcile EventBridge rule
 * uses, so a backfill can never disagree with the live reconcile. This script
 * holds no parsing, no dedup and no DDB writes of its own: it is a loop with a
 * progress report.
 *
 * One invoke per UTC day (rather than one invoke for the whole range) so a single
 * day's Lambda timeout or throttle only loses that day, and so the per-day
 * counters below are real rather than interpolated.
 *
 * Idempotent by construction: the packager writes each result with a conditional
 * PutItem keyed on the result's identity, so a re-run of an already-backfilled
 * day reports duplicates and writes nothing.
 *
 * Usage (from repo root, root node_modules provide the AWS SDK):
 *   node deploy/continuous-improvement/backfill-results.mjs --from 2026-09-01 --to 2026-09-14
 *        [--dry-run] [--group <log-group-name>] [--region us-east-1]
 *        [--function agentcore-hub-eval-packager]
 *
 * Exits non-zero if any day's invoke returns a FunctionError.
 */

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};

const FROM = opt('from', null);
const TO = opt('to', null);
const GROUP = opt('group', null);
const REGION = opt('region', process.env.AWS_REGION || 'us-east-1');
const FUNCTION = opt('function', process.env.EVAL_PACKAGER_FUNCTION || 'agentcore-hub-eval-packager');
const DRY_RUN = args.includes('--dry-run');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
if (!FROM || !TO || !DAY_RE.test(FROM) || !DAY_RE.test(TO)) {
  console.error('usage: backfill-results.mjs --from YYYY-MM-DD --to YYYY-MM-DD [--dry-run] [--group <name>] [--region <r>]');
  process.exit(2);
}
if (FROM > TO) {
  console.error(`--from (${FROM}) is after --to (${TO})`);
  process.exit(2);
}

// Inclusive UTC day range. Date arithmetic in UTC only — a local-time walk would
// skip or repeat a day either side of a DST boundary.
function daysBetween(from, to) {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

const lambda = new LambdaClient({ region: REGION });
const days = daysBetween(FROM, TO);

console.log(
  `Backfill eval results ${FROM} → ${TO} (${days.length} day(s)) ` +
    `region=${REGION} fn=${FUNCTION}${GROUP ? ` group=${GROUP}` : ''}${DRY_RUN ? ' [dry-run]' : ''}`
);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// The reconcile response's per-day map is keyed by day; a single-day invoke has
// at most one entry, but read it defensively so a shape change degrades to 0.
function sessionsFrom(body, day) {
  const perDay = body?.perDay;
  if (!perDay) return 0;
  const entry = Array.isArray(perDay) ? perDay.find((d) => d?.day === day) : perDay[day];
  if (entry == null) return 0;
  if (typeof entry === 'number') return entry;
  return num(entry.sessions ?? entry.sessionCount);
}

let totalRows = 0;
let totalDupes = 0;
let totalSessions = 0;
let failures = 0;

for (const day of days) {
  const payload = { mode: 'reconcile', from: day, to: day, group: GROUP, dryRun: DRY_RUN };
  process.stdout.write(`  ${day}  `);
  let res;
  try {
    res = await lambda.send(new InvokeCommand({
      FunctionName: FUNCTION,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(payload)),
    }));
  } catch (err) {
    console.log(`INVOKE FAILED ${err.message}`);
    failures++;
    continue;
  }

  const raw = res.Payload ? Buffer.from(res.Payload).toString('utf8') : '';
  if (res.FunctionError) {
    console.log(`FunctionError ${res.FunctionError}: ${raw.slice(0, 300)}`);
    failures++;
    continue;
  }

  // A Lambda may answer either the bare result object or an API-Gateway-ish
  // {statusCode, body:"<json>"} envelope; unwrap whichever arrived.
  let body;
  try {
    body = JSON.parse(raw);
    if (typeof body?.body === 'string') body = JSON.parse(body.body);
  } catch {
    console.log(`unparseable response: ${raw.slice(0, 200)}`);
    failures++;
    continue;
  }

  const rows = num(body?.rowsWritten);
  const dupes = num(body?.duplicates);
  const sessions = sessionsFrom(body, day);
  totalRows += rows;
  totalDupes += dupes;
  totalSessions += sessions;
  console.log(`${rows} row(s) written, ${dupes} duplicate(s), ${sessions} session(s)`);
}

console.log(
  `TOTAL ${totalRows} row(s) written, ${totalDupes} duplicate(s), ${totalSessions} session(s) ` +
    `over ${days.length} day(s)${DRY_RUN ? ' [dry-run: the Lambda wrote nothing]' : ''}`
);

if (failures) {
  console.error(`${failures} of ${days.length} day(s) failed — re-run those days (safe: writes are conditional).`);
  process.exit(1);
}
