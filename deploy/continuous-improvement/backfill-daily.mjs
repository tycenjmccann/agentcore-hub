#!/usr/bin/env node
/**
 * deploy/continuous-improvement/backfill-daily.mjs
 *
 * Rebuilds the per-UTC-day `daily[YYYY-MM-DD]` buckets on agentcore-hub-eval-config
 * rows from CloudWatch Logs Insights, so the Evaluations tab's rolling window is
 * populated right after the token-aggregator / eval-packager Lambdas start
 * writing buckets (or after an outage). Idempotent: each day bucket is
 * OVERWRITTEN with the Insights totals for that day (today included — the live
 * Lambdas keep adding on top after the query instant).
 *
 * Same three emitter shapes as lambda/token-aggregator/index.mjs:
 *   Strands runtimes  -> strands.telemetry.tracer `chat` spans (cache-inclusive input)
 *   managed harnesses -> EMF gen_ai.client.token.usage records
 *   coding runtime    -> claude_code.api_request events
 * plus evaluator results groups for sessions + evalScores (approximate: no
 * cross-delivery dedup, no role guard — it is a dashboard tally).
 *
 * Usage (from repo root, root node_modules provide the AWS SDK):
 *   node deploy/continuous-improvement/backfill-daily.mjs [--days 7] [--region us-east-1]
 *        [--agent agentcore_hub_agent] [--dry-run]
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  CloudWatchLogsClient, DescribeLogGroupsCommand, StartQueryCommand, GetQueryResultsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const DAYS = Math.min(14, Math.max(1, Number(opt('days', 7)) || 7));
const REGION = opt('region', process.env.AWS_REGION || 'us-east-1');
const ONLY_AGENT = opt('agent', null);
const DRY_RUN = args.includes('--dry-run');
const TABLE = process.env.EVAL_CONFIG_TABLE || 'agentcore-hub-eval-config';

const here = dirname(fileURLToPath(import.meta.url));
const agentsFile = resolve(here, '../../src/config/agents.json');
const agents = JSON.parse(readFileSync(agentsFile, 'utf8')).agents
  .filter((a) => a.evaluationsEnabled && (!ONLY_AGENT || a.agentId === ONLY_AGENT));
const agentIds = agents.map((a) => a.agentId).sort((a, b) => b.length - a.length);

const logs = new CloudWatchLogsClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

const now = Date.now();
const startSec = Math.floor((now - DAYS * 86400_000) / 1000) - 3600; // an hour of slack before the first day starts
const endSec = Math.ceil(now / 1000);
const firstDay = new Date(now); firstDay.setUTCDate(firstDay.getUTCDate() - (DAYS - 1));
const dayFloor = firstDay.toISOString().slice(0, 10);

const zeroBucket = () => ({
  tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0,
  calls: 0, costUsd: 0, sessions: 0, evalScores: {}, byModel: {},
});
const zeroModel = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd: 0, calls: 0 });

// ─── discovery ──────────────────────────────────────────────────────────────
async function listGroups(prefix) {
  const out = [];
  let nextToken;
  do {
    const r = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix, nextToken }));
    out.push(...(r.logGroups || []).map((g) => g.logGroupName));
    nextToken = r.nextToken;
  } while (nextToken);
  return out;
}

function resolveAgent(leaf) {
  return agentIds.find((id) => leaf === id || leaf.startsWith(`${id}-`) || leaf.startsWith(`harness_${id}-`)) || null;
}

// ─── Insights ───────────────────────────────────────────────────────────────
async function query(logGroupName, queryString) {
  const { queryId } = await logs.send(new StartQueryCommand({
    logGroupName, queryString, startTime: startSec, endTime: endSec, limit: 10000,
  }));
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await logs.send(new GetQueryResultsCommand({ queryId }));
    if (res.status === 'Complete') {
      return (res.results || []).map((row) => Object.fromEntries(row.map((f) => [f.field, f.value])));
    }
    if (['Failed', 'Cancelled', 'Timeout'].includes(res.status)) {
      throw new Error(`Insights query ${res.status} on ${logGroupName}`);
    }
  }
  throw new Error(`Insights query timed out on ${logGroupName}`);
}

const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const dayOf = (bin) => String(bin).slice(0, 10);

const Q_SPANS = `filter scope.name = "strands.telemetry.tracer" and attributes.gen_ai.operation.name = "chat"
| stats sum(attributes.gen_ai.usage.input_tokens) as tokIn, sum(attributes.gen_ai.usage.output_tokens) as tokOut,
        sum(attributes.gen_ai.usage.cache_read_input_tokens) as cacheRead, sum(attributes.gen_ai.usage.cache_write_input_tokens) as cacheWrite,
        count(*) as calls
  by bin(1d) as day, attributes.gen_ai.request.model as model, attributes.hub.cache_ttl as ttl`;

const Q_METRIC = `filter ispresent(gen_ai.client.token.usage.Sum)
| stats sum(gen_ai.client.token.usage.Sum) as n, sum(gen_ai.client.token.usage.Count) as c
  by bin(1d) as day, gen_ai.request.model as model, gen_ai.token.type as t`;

const Q_CLAUDE = `filter body = "claude_code.api_request"
| stats sum(attributes.input_tokens) as tokIn, sum(attributes.output_tokens) as tokOut,
        sum(attributes.cache_read_tokens) as cacheRead, sum(attributes.cache_creation_tokens) as cacheWrite,
        sum(attributes.cost_usd) as costUsd, count(*) as calls
  by bin(1d) as day, attributes.model as model`;

const Q_SCORES = `filter ispresent(attributes.gen_ai.evaluation.name) and ispresent(attributes.gen_ai.evaluation.score.value)
  and not ispresent(attributes.error.type) and (not ispresent(attributes.error) or attributes.error != 1)
  and (not ispresent(attributes.session.id) or not (attributes.session.id like /^battery-/))
| stats sum(attributes.gen_ai.evaluation.score.value) as s, count(*) as c
  by bin(1d) as day, attributes.gen_ai.evaluation.name as ev`;

const Q_SESSIONS = `filter ispresent(attributes.session.id) and not (attributes.session.id like /^battery-/)
| stats count_distinct(attributes.session.id) as sess by bin(1d) as day`;

function bucketFor(perAgent, agentId, day) {
  const days = (perAgent[agentId] ||= {});
  return (days[day] ||= zeroBucket());
}
function modelFor(bucket, model) {
  return (bucket.byModel[model] ||= zeroModel());
}
function addModel(bucket, model, d) {
  const m = modelFor(bucket, model || 'unknown');
  for (const k of Object.keys(d)) m[k] += d[k];
  bucket.tokensIn += d.input; bucket.tokensOut += d.output;
  bucket.cacheRead += d.cacheRead; bucket.cacheWrite += d.cacheWrite; bucket.cacheWrite1h += d.cacheWrite1h;
  bucket.costUsd += d.costUsd; bucket.calls += d.calls;
}

// ─── main ───────────────────────────────────────────────────────────────────
const perAgent = {};
const runtimeGroups = await listGroups('/aws/bedrock-agentcore/runtimes/');
const evalGroups = await listGroups('/aws/bedrock-agentcore/evaluations/results/');

console.log(`Backfill ${DAYS}d (${dayFloor} → today UTC) region=${REGION} table=${TABLE}${DRY_RUN ? ' [dry-run]' : ''}`);

for (const lg of runtimeGroups) {
  const leaf = lg.split('/').pop();
  if (leaf.includes('container')) continue;
  const agentId = resolveAgent(leaf);
  if (!agentId) continue;
  const kind = leaf.startsWith('harness_') ? 'metric' : agentId.includes('coding_runtime') ? 'claude' : 'spans';
  process.stdout.write(`  ${leaf.slice(0, 60).padEnd(60)} ${kind.padEnd(6)} `);
  try {
    if (kind === 'spans') {
      const rows = await query(lg, Q_SPANS);
      for (const r of rows) {
        const day = dayOf(r.day); if (day < dayFloor) continue;
        const cacheWrite = num(r.cacheWrite);
        const cacheRead = num(r.cacheRead);
        let input = num(r.tokIn);
        if (input < cacheRead + cacheWrite) input += cacheRead + cacheWrite;
        addModel(bucketFor(perAgent, agentId, day), r.model, {
          input, output: num(r.tokOut), cacheRead, cacheWrite,
          cacheWrite1h: r.ttl === '1h' ? cacheWrite : 0, costUsd: 0, calls: num(r.calls),
        });
      }
      console.log(`${rows.length} rows`);
    } else if (kind === 'metric') {
      const rows = await query(lg, Q_METRIC);
      for (const r of rows) {
        const day = dayOf(r.day); if (day < dayFloor) continue;
        if (r.t !== 'input' && r.t !== 'output') continue;
        addModel(bucketFor(perAgent, agentId, day), r.model, {
          input: r.t === 'input' ? num(r.n) : 0, output: r.t === 'output' ? num(r.n) : 0,
          cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd: 0, calls: r.t === 'input' ? num(r.c) : 0,
        });
      }
      console.log(`${rows.length} rows`);
    } else {
      const rows = await query(lg, Q_CLAUDE);
      for (const r of rows) {
        const day = dayOf(r.day); if (day < dayFloor) continue;
        const cacheRead = num(r.cacheRead), cacheWrite = num(r.cacheWrite);
        addModel(bucketFor(perAgent, agentId, day), r.model, {
          input: num(r.tokIn) + cacheRead + cacheWrite, output: num(r.tokOut), cacheRead, cacheWrite,
          cacheWrite1h: 0, costUsd: num(r.costUsd), calls: num(r.calls),
        });
      }
      console.log(`${rows.length} rows`);
    }
  } catch (err) {
    console.log(`ERR ${err.message}`);
  }
}

for (const lg of evalGroups) {
  const leaf = lg.split('/').pop(); // eval_<agentId>-<id>
  const agentId = agentIds.find((id) => leaf.startsWith(`eval_${id}-`) || leaf === `eval_${id}`);
  if (!agentId) continue;
  process.stdout.write(`  ${leaf.slice(0, 60).padEnd(60)} evals  `);
  try {
    const [scores, sessions] = await Promise.all([query(lg, Q_SCORES), query(lg, Q_SESSIONS)]);
    for (const r of scores) {
      const day = dayOf(r.day); if (day < dayFloor || !r.ev) continue;
      const b = bucketFor(perAgent, agentId, day);
      const cur = (b.evalScores[r.ev] ||= { sum: 0, count: 0 });
      cur.sum += num(r.s); cur.count += num(r.c);
    }
    for (const r of sessions) {
      const day = dayOf(r.day); if (day < dayFloor) continue;
      bucketFor(perAgent, agentId, day).sessions += num(r.sess);
    }
    console.log(`${scores.length} score rows, ${sessions.length} session rows`);
  } catch (err) {
    console.log(`ERR ${err.message}`);
  }
}

// ─── write ──────────────────────────────────────────────────────────────────
let written = 0;
for (const [agentId, days] of Object.entries(perAgent)) {
  const dayKeys = Object.keys(days).sort();
  const summary = dayKeys.map((d) => `${d.slice(5)}:${Math.round(days[d].tokensIn / 1000)}K/${days[d].sessions}s`).join(' ');
  console.log(`${agentId}: ${summary}`);
  if (DRY_RUN) continue;
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { agentId },
    UpdateExpression: 'SET daily = if_not_exists(daily, :emptyDaily)',
    ExpressionAttributeValues: { ':emptyDaily': {} },
  }));
  for (const day of dayKeys) {
    const b = days[day];
    for (const k of ['tokensIn', 'tokensOut', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'costUsd', 'sessions']) b[k] = Math.round(b[k] * 1e4) / 1e4;
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: { agentId },
      UpdateExpression: 'SET daily.#d = :bucket, tokenLastBackfillAt = :now',
      ExpressionAttributeNames: { '#d': day },
      ExpressionAttributeValues: { ':bucket': b, ':now': new Date().toISOString() },
    }));
    written++;
  }
}
console.log(DRY_RUN ? 'dry-run: nothing written' : `wrote ${written} day bucket(s) across ${Object.keys(perAgent).length} agent(s)`);
