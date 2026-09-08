/**
 * Token Aggregator Lambda
 *
 * Triggered by CW Logs subscription filters on every agent log group. Parses
 * LLM token usage out of three record shapes and increments PER-UTC-DAY
 * buckets on the agent's row in the agentcore-hub-eval-config table:
 *
 *   1. Strands `chat` spans (Strands runtimes, e.g. the shared fleet runtime).
 *      Scope `strands.telemetry.tracer`, `gen_ai.operation.name = chat`. The
 *      only record whose input count INCLUDES prompt-cache reads/writes — the
 *      botocore `chat <model>` span and the EMF `gen_ai.client.token.usage`
 *      metric both carry only the UNCACHED input (a few tokens per call once
 *      caching is on), which is how the dashboard came to show 3K in / 2M out.
 *      `invoke_agent` spans repeat the same usage rolled up and are skipped.
 *   2. EMF metric records `gen_ai.client.token.usage` (managed harnesses —
 *      Workflow Manager, Builder, Routine Builder, Personal Assistant). No
 *      spans are emitted there, and the metric's input is the full prompt.
 *   3. Claude Code `claude_code.api_request` events (the coding runtime).
 *      Claude Code never emits the gen_ai metric; its per-request event carries
 *      input/output/cache_read/cache_creation tokens and its own cost_usd.
 *
 * Buckets live in their OWN table (EVAL_DAILY_TABLE, PK agentId / SK day =
 * YYYY-MM-DD UTC of the record) — one small item per agent per day. They used
 * to be a `daily` map on the eval-config row, but that row also carries the
 * eval-packager's sessionBuffer and sits at the 400KB item cap for the busy
 * agents, so every bucket write failed with "Item size to update has exceeded".
 *
 * Item shape (flat, so ONE atomic UpdateItem with ADD needs no path set-up):
 *   tokensIn tokensOut cacheRead cacheWrite cacheWrite1h calls costUsd
 *   m|<model>|<field>          per-model counters (field = one of the above,
 *                              with input/output for tokensIn/tokensOut)
 *   sessions, e|<evaluator>|sum, e|<evaluator>|count   (written by eval-packager)
 *   expiresAt                  TTL = day + DAILY_RETAIN_DAYS
 * tokensIn is the FULL input (cache read + cache write + uncached) for every
 * shape. The dashboard (src/lib/eval-metrics.ts) applies ONE rolling window
 * to every row. No weekly reset; TTL retires old days.
 *
 * Environment Variables:
 *   EVAL_DAILY_TABLE  — per-day bucket table (default: agentcore-hub-eval-daily)
 *   ARTIFACTS_BUCKET  — S3 bucket for agents.json lookup
 *   DAILY_RETAIN_DAYS — days of buckets to keep, via TTL (default 14)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { gunzipSync } from 'zlib';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});

const DAILY_TABLE = process.env.EVAL_DAILY_TABLE || 'agentcore-hub-eval-daily';
const BUCKET = process.env.ARTIFACTS_BUCKET || process.env.ARTIFACT_BUCKET;
if (!BUCKET) {
  throw new Error(
    'ARTIFACTS_BUCKET (or ARTIFACT_BUCKET) env var is required. ' +
      'Convention: agentcore-hub-artifacts-{ACCOUNT_ID}-{REGION}'
  );
}
const AGENTS_KEY = 'config/agents.json';
export const RETAIN_DAYS = Math.max(7, Number(process.env.DAILY_RETAIN_DAYS) || 14);

// ─── Agent resolution (cached per warm start) ──────────────────────────────
let agentsCache = null;

async function loadAgents() {
  if (agentsCache) return agentsCache;
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: AGENTS_KEY }));
  const body = await resp.Body.transformToString();
  agentsCache = JSON.parse(body).agents || [];
  return agentsCache;
}

export function resolveAgentId(logGroup, agents) {
  // /aws/bedrock-agentcore/runtimes/agentcore_hub_agent-ITPP0eBToO-DEFAULT
  // /aws/bedrock-agentcore/runtimes/harness_agentcore_hub_builder-D1N3piDbfO-DEFAULT
  // Longest id first so `agentcore_hub_agent` can't shadow `agentcore_hub_agent_x`.
  const leaf = String(logGroup).split('/').pop() || '';
  const ids = agents.map((a) => a.agentId).filter(Boolean).sort((a, b) => b.length - a.length);
  return ids.find((id) => leaf === id || leaf.startsWith(`${id}-`) || leaf.startsWith(`harness_${id}-`)) || null;
}

// ─── Record parsing (pure; unit-tested) ─────────────────────────────────────
export function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Every shape ends up with the FULL prompt as `input`: Strands already sums the
// cache tokens in (input >= cacheRead + cacheWrite), Claude Code reports the
// uncached remainder (input < cacheRead + cacheWrite).
function fullInput(input, cacheRead, cacheWrite) {
  const cached = cacheRead + cacheWrite;
  return input >= cached ? input : input + cached;
}

/**
 * Parse one log line into a usage delta, or null when it is not a usage record.
 * @returns {null | {kind:'span'|'metric'|'cc', ts:number, model:string, input:number,
 *   output:number, cacheRead:number, cacheWrite:number, cacheWrite1h:number,
 *   costUsd:number, calls:number}}
 */
export function parseUsageRecord(message, fallbackTs = Date.now()) {
  const braceIdx = message.indexOf('{');
  if (braceIdx < 0) return null;
  let r;
  try {
    r = JSON.parse(message.slice(braceIdx));
  } catch {
    return null;
  }
  const attrs = r.attributes || {};

  // 3. Claude Code per-request event
  if (r.body === 'claude_code.api_request' || attrs['event.name'] === 'api_request') {
    const cacheRead = num(attrs.cache_read_tokens ?? attrs['gen_ai.usage.cache_read_input_tokens']);
    const cacheWrite = num(attrs.cache_creation_tokens ?? attrs['gen_ai.usage.cache_write_input_tokens']);
    const input = fullInput(num(attrs.input_tokens ?? attrs['gen_ai.usage.input_tokens']), cacheRead, cacheWrite);
    const output = num(attrs.output_tokens ?? attrs['gen_ai.usage.output_tokens']);
    if (!input && !output) return null;
    const ts = r.timeUnixNano ? Number(r.timeUnixNano) / 1e6
      : attrs['event.timestamp'] ? Date.parse(attrs['event.timestamp']) : fallbackTs;
    return {
      kind: 'cc',
      ts: Number.isFinite(ts) && ts > 0 ? ts : fallbackTs,
      model: String(attrs.model || attrs['gen_ai.request.model'] || 'unknown'),
      input, output, cacheRead, cacheWrite,
      // Claude Code uses the 5-minute cache; the 1h surcharge never applies.
      cacheWrite1h: 0,
      costUsd: num(attrs.cost_usd ?? attrs['gen_ai.usage.cost']),
      calls: 1,
    };
  }

  // 1. Strands model-call span (the only cache-inclusive input count)
  if (r.scope?.name === 'strands.telemetry.tracer') {
    if (attrs['gen_ai.operation.name'] !== 'chat' && r.name !== 'chat') return null;
    const cacheRead = num(attrs['gen_ai.usage.cache_read_input_tokens']);
    const cacheWrite = num(
      attrs['gen_ai.usage.cache_write_input_tokens'] ?? attrs['gen_ai.usage.cache_creation.input_tokens']
    );
    const input = fullInput(
      num(attrs['gen_ai.usage.input_tokens'] ?? attrs['gen_ai.usage.prompt_tokens']), cacheRead, cacheWrite
    );
    const output = num(attrs['gen_ai.usage.output_tokens'] ?? attrs['gen_ai.usage.completion_tokens']);
    if (!input && !output) return null;
    const ts = r.endTimeUnixNano ? Number(r.endTimeUnixNano) / 1e6
      : attrs['gen_ai.event.end_time'] ? Date.parse(attrs['gen_ai.event.end_time']) : fallbackTs;
    return {
      kind: 'span',
      ts: Number.isFinite(ts) && ts > 0 ? ts : fallbackTs,
      model: String(attrs['gen_ai.request.model'] || 'unknown'),
      input, output, cacheRead, cacheWrite,
      cacheWrite1h: attrs['hub.cache_ttl'] === '1h' ? cacheWrite : 0,
      costUsd: 0,
      calls: 1,
    };
  }
  // Any other span (botocore `chat <model>`, invoke_agent roll-ups, tool spans)
  if (r.scope || r.spanId) return null;

  // 2. EMF metric record (managed harnesses)
  const usage = r['gen_ai.client.token.usage'];
  if (usage && typeof usage === 'object') {
    const sum = num(usage.Sum);
    if (!sum) return null;
    const type = r['gen_ai.token.type'];
    if (type !== 'input' && type !== 'output') return null;
    const ts = num(r._aws?.Timestamp) || fallbackTs;
    return {
      kind: 'metric',
      ts,
      model: String(r['gen_ai.request.model'] || 'unknown'),
      input: type === 'input' ? sum : 0,
      output: type === 'output' ? sum : 0,
      cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd: 0,
      // One EMF record per (type, flush window); count model calls once, on the
      // input record, so `calls` stays comparable to the span/CC shapes.
      calls: type === 'input' ? num(usage.Count) : 0,
    };
  }
  return null;
}

/**
 * Fold a delivery's log events into { day: { model: delta } }.
 * If a batch carries Strands spans AND EMF metrics for the same calls (a log
 * group whose filter still matches both), the spans win — counting both would
 * double the output tokens.
 */
export function aggregateLogEvents(logEvents) {
  const parsed = [];
  for (const e of logEvents || []) {
    const rec = parseUsageRecord(e.message || '', num(e.timestamp) || Date.now());
    if (rec) parsed.push(rec);
  }
  const hasSpans = parsed.some((p) => p.kind === 'span');
  const byDay = {};
  for (const p of parsed) {
    if (hasSpans && p.kind === 'metric') continue;
    const day = dayKey(p.ts);
    const models = (byDay[day] ||= {});
    const m = (models[p.model] ||= zeroModel());
    m.input += p.input;
    m.output += p.output;
    m.cacheRead += p.cacheRead;
    m.cacheWrite += p.cacheWrite;
    m.cacheWrite1h += p.cacheWrite1h;
    m.costUsd += p.costUsd;
    m.calls += p.calls;
  }
  return byDay;
}

export function zeroModel() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd: 0, calls: 0 };
}

// ─── DynamoDB write ─────────────────────────────────────────────────────────
// Flat attribute names so a single atomic ADD creates-or-increments every
// counter with no `if_not_exists` path set-up and no read-modify-write. Every
// name goes through a placeholder: `input` is a DynamoDB reserved word, and
// model ids carry dots/colons.
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'costUsd', 'calls'];
const BUCKET_FIELD = { input: 'tokensIn', output: 'tokensOut' };
export const MODEL_ATTR_PREFIX = 'm|';

export function modelAttr(model, field) {
  return `${MODEL_ATTR_PREFIX}${model}|${field}`;
}

export function expiresAtFor(day, retainDays = RETAIN_DAYS) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + retainDays + 1);
  return Math.floor(d.getTime() / 1000);
}

export function buildAddExpression(day, models, now) {
  const names = { '#expiresAt': 'expiresAt', '#updatedAt': 'updatedAt' };
  const values = { ':now': now, ':ttl': expiresAtFor(day) };
  const adds = [];
  const total = zeroModel();
  Object.entries(models).forEach(([model, delta], i) => {
    for (const f of FIELDS) {
      if (!delta[f]) continue;
      total[f] += delta[f];
      names[`#m${i}_${f}`] = modelAttr(model, f);
      values[`:m${i}_${f}`] = delta[f];
      adds.push(`#m${i}_${f} :m${i}_${f}`);
    }
  });
  for (const f of FIELDS) {
    if (!total[f]) continue;
    names[`#t_${f}`] = BUCKET_FIELD[f] || f;
    values[`:t_${f}`] = total[f];
    adds.push(`#t_${f} :t_${f}`);
  }
  return {
    UpdateExpression: `SET #updatedAt = :now, #expiresAt = if_not_exists(#expiresAt, :ttl) ADD ${adds.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    empty: adds.length === 0,
  };
}

// ─── Handler ────────────────────────────────────────────────────────────────
export const handler = async (event) => {
  // The weekly EventBridge reset is gone (rolling window replaces it). A stale
  // rule that still fires must not zero anything.
  if (event?.action === 'reset' || event?.['detail-type'] === 'token-reset') {
    console.log('[token-agg] ignoring legacy reset event — day buckets expire via TTL');
    return { statusCode: 200, body: 'reset-ignored' };
  }

  if (!event?.awslogs?.data) {
    console.log('[token-agg] No awslogs data, skipping');
    return { statusCode: 200 };
  }

  const payload = Buffer.from(event.awslogs.data, 'base64');
  const parsed = JSON.parse(gunzipSync(payload).toString());
  const logGroup = parsed.logGroup || '';

  const agents = await loadAgents();
  const agentId = resolveAgentId(logGroup, agents);
  if (!agentId) {
    console.log('[token-agg] No agent match for:', logGroup);
    return { statusCode: 200 };
  }

  const byDay = aggregateLogEvents(parsed.logEvents);
  const days = Object.keys(byDay);
  if (days.length === 0) return { statusCode: 200, body: 'no-tokens' };

  const now = new Date().toISOString();
  for (const day of days) {
    const models = byDay[day];
    const expr = buildAddExpression(day, models, now);
    if (expr.empty) continue;
    try {
      await ddb.send(new UpdateCommand({
        TableName: DAILY_TABLE,
        Key: { agentId, day },
        UpdateExpression: expr.UpdateExpression,
        ExpressionAttributeNames: expr.ExpressionAttributeNames,
        ExpressionAttributeValues: expr.ExpressionAttributeValues,
      }));
      const t = Object.values(models).reduce((acc, m) => {
        acc.input += m.input; acc.output += m.output; acc.cacheRead += m.cacheRead; return acc;
      }, { input: 0, output: 0, cacheRead: 0 });
      console.log(`[token-agg] ${agentId} ${day}: +${t.input} in (${t.cacheRead} cached) / +${t.output} out`);
    } catch (err) {
      console.error(`[token-agg] ${agentId} ${day} DDB update failed:`, err.message);
    }
  }

  return { statusCode: 200, body: 'ok' };
};
