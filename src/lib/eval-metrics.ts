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
 *
 * TEAM-4688: the window is no longer clamped to the daily-bucket TTL (the old
 * MAX_WINDOW_DAYS = 14 silently turned a 30- or 90-day request into 14 days).
 * `parseWindow` accepts exactly 7 | 30 | 90 | all, and `summarizeDaily` takes
 * "all"/null for `days` meaning "every day present in the data" — retention,
 * not a hardcoded ceiling, is what bounds an all-time fold.
 *
 * The same table also holds one row per agent PERSONA, keyed
 * `${agentId}#${persona}` / day with the same flat attributes. `splitDailyItems`
 * separates the two row families out of a single scan, so no caller needs a
 * second pass over the table.
 *
 * TEAM-4997: `Pricing` is now the GENERATED projection of the model registry
 * (`config/pricing.json`, see src/lib/models-registry.ts), so a rate can gain a
 * long-context tier (`rateFor`) and a missing rate is no longer invisible —
 * `summarizeDaily` reports `unpricedModels`, the ids that fell through to
 * `pricing.default` and are therefore costed by guess.
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

/**
 * The rates that apply above `thresholdInputTokens` prompt tokens. OpenAI's
 * long-context tier (TEAM-4997): the same model bills roughly 2x once a single
 * request's prompt crosses the threshold. Projected per model from the registry
 * catalog by `pricingProjection` (src/lib/models-registry.ts).
 */
export interface LongContextRates {
  thresholdInputTokens: number;
  input: number;
  output: number;
  cacheReadInput: number;
}

export interface PricingRates {
  input: number;
  output: number;
  cacheReadInput?: number;
}

export interface PricingEntry extends PricingRates {
  longContext?: LongContextRates;
}

export interface Pricing {
  models: Record<string, PricingEntry>;
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
  /**
   * Models in this window that have no row in `pricing.models` and were
   * therefore billed at `pricing.default` — i.e. a cost that is a guess rather
   * than a rate. Sorted, distinct. Empty is the healthy state: the registry
   * projection is supposed to cover every id a span can carry, so a non-empty
   * list is a catalog gap to close, not a number to quietly display.
   */
  unpricedModels: string[];
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
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Ascending list of UTC day keys: today and the (days - 1) days before it. */
export function windowDays(days: number, now: Date = new Date()): string[] {
  const n = Math.max(1, Math.floor(days) || DEFAULT_WINDOW_DAYS);
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

/** The only window lengths the API accepts, besides "all". */
export const ALLOWED_WINDOW_DAYS = [7, 30, 90] as const;

export interface WindowSpec {
  /** A fixed number of trailing UTC days, or "all" for every day on record. */
  days: number | "all";
  /** Human label for the UI — "last 30 days" / "all time". */
  label: string;
}

/**
 * Parse the `?days=` search param. Returns null for anything not in
 * {7, 30, 90, all} so the caller can answer 400 instead of silently serving a
 * different period than the one the operator asked for. A missing/empty param
 * is the default 7-day window, not an error.
 */
export function parseWindow(param: string | null | undefined): WindowSpec | null {
  const raw = (param ?? "").trim();
  if (!raw) return { days: DEFAULT_WINDOW_DAYS, label: `last ${DEFAULT_WINDOW_DAYS} days` };
  if (raw.toLowerCase() === "all") return { days: "all", label: "all time" };
  const num = Number(raw);
  if (!Number.isInteger(num)) return null;
  if (!(ALLOWED_WINDOW_DAYS as readonly number[]).includes(num)) return null;
  return { days: num, label: `last ${num} days` };
}

/** Resolve a WindowSpec to the day keys summarizeDaily folds over. */
export function windowDaysFor(spec: WindowSpec, now: Date = new Date()): string[] | "all" {
  return spec.days === "all" ? "all" : windowDays(spec.days, now);
}

export interface SplitDailyItems {
  /** Runtime-level rows (PK `agentId`): agentId → day → bucket. */
  byAgent: Record<string, Record<string, Partial<DailyBucket>>>;
  /** Persona rows (PK `${agentId}#${persona}`): agentId → persona → day → bucket. */
  byPersona: Record<string, Record<string, Record<string, Partial<DailyBucket>>>>;
}

/**
 * One scan, two row families. Persona rows carry `${agentId}#${persona}` in the
 * partition key, so they are told apart from runtime rows by the separator
 * alone — no extra query and no schema flag.
 */
export function splitDailyItems(items: Array<Record<string, unknown>>): SplitDailyItems {
  const out: SplitDailyItems = { byAgent: {}, byPersona: {} };
  for (const item of items) {
    const pk = typeof item.agentId === "string" ? item.agentId : null;
    const day = typeof item.day === "string" ? item.day : null;
    if (!pk || !day) continue;
    const sep = pk.indexOf("#");
    if (sep < 0) {
      (out.byAgent[pk] ||= {})[day] = bucketFromDailyItem(item);
      continue;
    }
    const agentId = pk.slice(0, sep);
    const persona = pk.slice(sep + 1);
    // A half-formed key belongs to neither family — dropping it beats charging
    // an empty agent (or every agent) with the row's sessions.
    if (!agentId || !persona) continue;
    ((out.byPersona[agentId] ||= {})[persona] ||= {})[day] = bucketFromDailyItem(item);
  }
  return out;
}

/** Map a raw CloudWatch Logs evaluator name to its UI display name. */
export function normalizeEvaluatorName(raw: string): string {
  if (raw.startsWith("Builtin.")) return raw.slice("Builtin.".length);
  if (raw.includes("dependency_chain_compliance")) return "DependencyChainCompliance";
  return raw;
}

function multiplier(pricing: Pricing, key: string, fallback: number): number {
  const v = pricing.cacheWriteMultiplier?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * The rates that apply to ONE request of `requestInputTokens` prompt tokens.
 *
 * The long-context tier is keyed on the size of a single request, so the
 * comparison is STRICTLY greater: a prompt of exactly `thresholdInputTokens`
 * bills at the standard rate and one token more bills at the long rate. Pure, so
 * a caller that does know a request's size (per-span cost, the cost-report
 * Lambda's read side) can price it correctly.
 */
export function rateFor(price: PricingEntry, requestInputTokens: number): PricingRates {
  const lc = price.longContext;
  if (!lc || !Number.isFinite(lc.thresholdInputTokens) || n(requestInputTokens) <= lc.thresholdInputTokens) {
    return price.cacheReadInput === undefined
      ? { input: price.input, output: price.output }
      : { input: price.input, output: price.output, cacheReadInput: price.cacheReadInput };
  }
  return { input: lc.input, output: lc.output, cacheReadInput: lc.cacheReadInput };
}

/**
 * USD for one model's window usage. Cache reads are discounted, cache writes
 * surcharged.
 *
 * Deliberately does NOT consult `rateFor`: a daily bucket is a SUM over a day's
 * requests and carries no per-request prompt size, so there is nothing to
 * compare against `thresholdInputTokens`. Dividing `input` by `calls` to guess
 * an average prompt would bill a day of small requests at the long-context rate
 * (or the reverse) with no way for the operator to tell. A day bucket therefore
 * always bills at the standard rate; long-context pricing belongs to the
 * per-request readers that know a request's real size.
 */
export function modelCost(model: string, u: Partial<DailyModelUsage>, pricing: Pricing): number {
  const p: PricingEntry = pricing.models[model] || pricing.default;
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

/**
 * Fold the buckets that fall inside `days` into one summary. `days` is the
 * explicit day-key list of a fixed window, or "all"/null meaning "every day
 * present in `daily`" (the all-time view).
 */
export function summarizeDaily(
  daily: Record<string, Partial<DailyBucket>> | undefined | null,
  days: string[] | "all" | null | undefined,
  pricing: Pricing
): AgentWindowSummary {
  const byModel: Record<string, DailyModelUsage> = {};
  const evalScores: Record<string, { sum: number; count: number }> = {};
  let sessions = 0;
  let calls = 0;
  const inWindow = Array.isArray(days) ? new Set(days) : null;

  for (const [day, bucket] of Object.entries(daily || {})) {
    if ((inWindow && !inWindow.has(day)) || !bucket) continue;
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
  // Exactly the ids modelCost fell through to `pricing.default` for.
  const unpricedModels = Object.keys(byModel)
    .filter((model) => !pricing.models[model])
    .sort();

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
    unpricedModels,
  };
}
