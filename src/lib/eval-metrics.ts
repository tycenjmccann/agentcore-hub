/**
 * Rolling-window math for the Evaluations tab's Operational Metrics.
 *
 * The token-aggregator and eval-packager Lambdas write one item per agent per
 * UTC day to the agentcore-hub-eval-daily table (PK agentId / SK day). Items
 * are FLAT so the Lambdas can create-or-increment with a single atomic ADD:
 *   tokensIn tokensOut cacheRead cacheWrite cacheWrite1h calls costUsd sessions
 *   m|<model>|<field>           per-model token counters (token-aggregator)
 *   e|<evaluator>|sum / |count  evaluator score sums (eval-packager)
 * `bucketFromDailyItem` lifts an item into the nested DailyBucket shape and
 * `summarizeDaily` folds the buckets inside ONE window (default 7 days, today
 * inclusive) into the numbers the dashboard shows, so sessions, evaluator
 * scores, tokens and cost all describe the same period. Pure — no AWS.
 */

export interface DailyModelUsage {
  input: number;      // full prompt: uncached + cache read + cache write
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number; // subset of cacheWrite written with the 1h TTL (2x surcharge)
  costUsd: number;      // engine-reported cost when available (Claude Code); informational
  calls: number;
}

export interface DailyBucket {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  calls: number;
  costUsd: number;
  sessions: number;
  evalScores: Record<string, { sum: number; count: number }>;
  byModel: Record<string, Partial<DailyModelUsage>>;
}

export interface Pricing {
  models: Record<string, { input: number; output: number; cacheReadInput?: number }>;
  default: { input: number; output: number };
  cachedInputDiscount?: number;
  cacheWriteMultiplier?: Record<string, number | string>;
}

export interface ModelWindowUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  calls: number;
  cost: number;
}

export interface AgentWindowSummary {
  sessions: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  calls: number;
  cost: number;
  costPerSession: number;
  models: ModelWindowUsage[];
  evalScores: Record<string, { sum: number; count: number }>;
}

export const DEFAULT_WINDOW_DAYS = 7;
export const MODEL_ATTR_PREFIX = "m|";
export const EVALUATOR_ATTR_PREFIX = "e|";

const MODEL_FIELDS = new Set<keyof DailyModelUsage>(["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "costUsd", "calls"]);

/** Lift one flat daily-table item into the nested bucket shape. */
export function bucketFromDailyItem(item: Record<string, unknown>): Partial<DailyBucket> {
  const bucket: Partial<DailyBucket> = {
    tokensIn: n(item.tokensIn),
    tokensOut: n(item.tokensOut),
    cacheRead: n(item.cacheRead),
    cacheWrite: n(item.cacheWrite),
    cacheWrite1h: n(item.cacheWrite1h),
    calls: n(item.calls),
    costUsd: n(item.costUsd),
    sessions: n(item.sessions),
    evalScores: {},
    byModel: {},
  };
  for (const [key, raw] of Object.entries(item)) {
    if (key.startsWith(MODEL_ATTR_PREFIX)) {
      const sep = key.lastIndexOf("|");
      const model = key.slice(MODEL_ATTR_PREFIX.length, sep);
      const field = key.slice(sep + 1) as keyof DailyModelUsage;
      if (!model || !MODEL_FIELDS.has(field)) continue;
      const m = (bucket.byModel![model] ||= {});
      m[field] = n(raw);
    } else if (key.startsWith(EVALUATOR_ATTR_PREFIX)) {
      const sep = key.lastIndexOf("|");
      const evaluator = key.slice(EVALUATOR_ATTR_PREFIX.length, sep);
      const field = key.slice(sep + 1);
      if (!evaluator || (field !== "sum" && field !== "count")) continue;
      const e = (bucket.evalScores![evaluator] ||= { sum: 0, count: 0 });
      e[field] = n(raw);
    }
  }
  return bucket;
}

/** Group daily-table items by agentId → day → bucket. */
export function groupDailyItems(items: Array<Record<string, unknown>>): Record<string, Record<string, Partial<DailyBucket>>> {
  const out: Record<string, Record<string, Partial<DailyBucket>>> = {};
  for (const item of items) {
    const agentId = typeof item.agentId === "string" ? item.agentId : null;
    const day = typeof item.day === "string" ? item.day : null;
    if (!agentId || !day) continue;
    (out[agentId] ||= {})[day] = bucketFromDailyItem(item);
  }
  return out;
}
export const MAX_WINDOW_DAYS = 14; // matches the Lambdas' DAILY_RETAIN_DAYS default

export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Ascending list of UTC day keys: today and the (days - 1) days before it. */
export function windowDays(days: number, now: Date = new Date()): string[] {
  const n = Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.floor(days) || DEFAULT_WINDOW_DAYS));
  const out: string[] = [];
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  cursor.setUTCDate(cursor.getUTCDate() - (n - 1));
  for (let i = 0; i < n; i++) {
    out.push(dayKey(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

function multiplier(pricing: Pricing, key: string, fallback: number): number {
  const v = pricing.cacheWriteMultiplier?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** USD for one model's window usage. Cache reads are discounted, cache writes surcharged. */
export function modelCost(model: string, u: Partial<DailyModelUsage>, pricing: Pricing): number {
  const p = pricing.models[model] || pricing.default;
  const input = n(u.input);
  const cacheRead = Math.min(n(u.cacheRead), input);
  const cacheWrite = Math.min(n(u.cacheWrite), input - cacheRead);
  const cacheWrite1h = Math.min(n(u.cacheWrite1h), cacheWrite);
  const uncached = Math.max(0, input - cacheRead - cacheWrite);
  const discount = typeof pricing.cachedInputDiscount === "number" ? pricing.cachedInputDiscount : 0.1;
  // Per-model absolute cache-read rate (USD/1M) wins over the fractional default.
  const readRate = typeof p.cacheReadInput === "number" && Number.isFinite(p.cacheReadInput) ? p.cacheReadInput : p.input * discount;
  const mult5m = multiplier(pricing, "5m", multiplier(pricing, "default", 1.25));
  const mult1h = multiplier(pricing, "1h", 2.0);
  const inputUsd =
    (uncached * p.input + cacheRead * readRate + ((cacheWrite - cacheWrite1h) * mult5m + cacheWrite1h * mult1h) * p.input) /
    1_000_000;
  const outputUsd = n(u.output) * (p.output / 1_000_000);
  return inputUsd + outputUsd;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Fold the buckets that fall inside `days` into one summary. */
export function summarizeDaily(
  daily: Record<string, Partial<DailyBucket>> | undefined | null,
  days: string[],
  pricing: Pricing
): AgentWindowSummary {
  const byModel: Record<string, DailyModelUsage> = {};
  const evalScores: Record<string, { sum: number; count: number }> = {};
  let sessions = 0;
  let calls = 0;
  const inWindow = new Set(days);

  for (const [day, bucket] of Object.entries(daily || {})) {
    if (!inWindow.has(day) || !bucket) continue;
    sessions += n(bucket.sessions);
    calls += n(bucket.calls);
    for (const [model, u] of Object.entries(bucket.byModel || {})) {
      const m = (byModel[model] ||= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd: 0, calls: 0 });
      m.input += n(u.input);
      m.output += n(u.output);
      m.cacheRead += n(u.cacheRead);
      m.cacheWrite += n(u.cacheWrite);
      m.cacheWrite1h += n(u.cacheWrite1h);
      m.costUsd += n(u.costUsd);
      m.calls += n(u.calls);
    }
    for (const [evaluator, s] of Object.entries(bucket.evalScores || {})) {
      const cur = (evalScores[evaluator] ||= { sum: 0, count: 0 });
      cur.sum += n(s?.sum);
      cur.count += n(s?.count);
    }
  }

  const models: ModelWindowUsage[] = Object.entries(byModel)
    .map(([model, u]) => ({
      model,
      input: Math.round(u.input),
      output: Math.round(u.output),
      cacheRead: Math.round(u.cacheRead),
      cacheWrite: Math.round(u.cacheWrite),
      calls: u.calls,
      cost: round2(modelCost(model, u, pricing)),
    }))
    .sort((a, b) => b.cost - a.cost);

  const tokensIn = models.reduce((s, m) => s + m.input, 0);
  const tokensOut = models.reduce((s, m) => s + m.output, 0);
  const cacheRead = models.reduce((s, m) => s + m.cacheRead, 0);
  const cacheWrite = models.reduce((s, m) => s + m.cacheWrite, 0);
  const cost = round2(Object.entries(byModel).reduce((s, [model, u]) => s + modelCost(model, u, pricing), 0));

  return {
    sessions,
    tokensIn,
    tokensOut,
    cacheRead,
    cacheWrite,
    calls,
    cost,
    costPerSession: sessions > 0 ? round2(cost / sessions) : 0,
    models,
    evalScores,
  };
}
