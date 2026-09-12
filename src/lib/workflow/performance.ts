/**
 * Performance card — fleet-level aggregation over the per-run cards the
 * cost-report Lambda writes (performance/index.json in the artifact bucket).
 *
 * PURE: no AWS calls, no clock reads (callers pass `now`). The band arithmetic
 * (median + MAD, warn at 2σ, alert at 3σ, sigma floored at max(floor, 10% of
 * |median|)) deliberately mirrors lambda/cost-report/index.mjs so a run's card
 * and the fleet view never disagree about what "anomalous" means.
 *
 * It also holds the TS mirror of the deterministic quality score (`computeKpi`,
 * bottom of the file) — same rubric file, same arithmetic as the Lambda.
 */

import kpiConfig from "@/config/kpi.json";

export type BandStatus = "ok" | "warn" | "alert" | "insufficient" | "unknown";
export type KpiUnit = "usd" | "ms" | "tokens" | "count" | "ratio";
export type KpiGroup = "cost" | "time" | "quality";

export interface CardSummary {
  workflowId: string;
  epicId: string | null;
  workflowDefId: string;
  title: string | null;
  outcome: string | null;
  startedAt: string | null;
  completedAt: string;
  prUrl: string | null;
  cost: {
    total: number; persona: number; coding: number;
    tokens: number; tokensIn: number; tokensOut: number; cached: number;
    cacheRead?: number; cacheWrite?: number; cacheHitRate?: number; personaCacheHitRate?: number;
    byEngine: Record<string, number>;
  };
  time: {
    wall: number | null; active: number | null; agentWork: number;
    humanWait: number; busy?: number | null; idle: number | null; utilization: number | null;
  };
  quality: {
    tasks: number; reworkRounds: number; changeRequests: number; fixTickets: number;
    loops: number; nudges: number; errors: number; gateRounds: number;
    firstPassYield: number | null; humanGates: number;
    /** Deterministic 0-100 quality score (report v5+). Absent on older summaries. */
    score?: number | null;
  };
  agents: Record<string, { usd: number; workMs: number; tasks: number; reworkRounds: number }>;
  status: BandStatus;
  anomalies: { kpi: string; status: BandStatus; z: number | null }[];
  gaps: number;
  /** Hero KPI headline (report v5+); `null`/absent means "not scored", never zero. */
  kpi?: {
    version: number;
    quality: { score: number | null; grade: string | null; confidence: string };
  } | null;
  /** True when the run's cost spans never matched — a $0 total is unknown, not free. */
  costMissing?: boolean;
}

export interface InfraSnapshot {
  updatedAt: string | null;
  region?: string;
  windowDays?: number;
  period?: { Start: string; End: string };
  buckets?: Record<string, number>;
  coreTotal?: number;
  optionalTotal?: number;
  llmBilledUsd?: number;
  runsInWindow?: number;
  perRunCoreUsd?: number | null;
  perRunRuntimeUsd?: number | null;
  agentcore?: Record<string, number>;
  runtimes?: Record<string, { gbHours: number; vcpuHours: number; usd: number }> | null;
  byService?: Record<string, { usd: number; bucket: string }>;
  error?: string;
}

export interface PerformanceIndex {
  version: number;
  updatedAt: string | null;
  cards: CardSummary[];
  infra: InfraSnapshot | null;
}

export interface KpiDef {
  key: string;
  label: string;
  unit: KpiUnit;
  group: KpiGroup;
  /** Minimum sigma so a flat baseline cannot flag every run. */
  floor: number;
  /** "upper" (default): higher is worse. "lower": lower is worse. */
  direction?: "upper" | "lower";
  /** Short explanation shown on hover. */
  help: string;
}

export const FLEET_KPIS: KpiDef[] = [
  { key: "cost.total", label: "Cost per run", unit: "usd", group: "cost", floor: 5, help: "Total LLM spend (personas + coding CLIs) at Bedrock list price" },
  { key: "cost.persona", label: "Persona LLM", unit: "usd", group: "cost", floor: 5, help: "Strands persona agents on the shared runtime" },
  { key: "cost.coding", label: "Coding CLIs", unit: "usd", group: "cost", floor: 2, help: "Claude Code / Codex / Kiro bolt-on engines" },
  { key: "cost.tokens", label: "Tokens per run", unit: "tokens", group: "cost", floor: 500_000, help: "Input + output + cached tokens" },
  { key: "time.wall", label: "End-to-end", unit: "ms", group: "time", floor: 900_000, help: "Wall-clock from start to terminal phase" },
  { key: "time.active", label: "Active", unit: "ms", group: "time", floor: 900_000, help: "Wall-clock minus time waiting on human gates" },
  { key: "time.agentWork", label: "Agent work", unit: "ms", group: "time", floor: 900_000, help: "Sum of agent task durations (agents actually working)" },
  { key: "time.humanWait", label: "Human wait", unit: "ms", group: "time", floor: 900_000, help: "Union of open review-gate intervals" },
  { key: "quality.tasks", label: "Agent tasks", unit: "count", group: "quality", floor: 1, help: "Tickets worked by agents (fewer = tighter pipeline)" },
  { key: "quality.reworkRounds", label: "Rework rounds", unit: "count", group: "quality", floor: 1, help: "Re-invocations of a ticket after its first run" },
  { key: "quality.loops", label: "Loops", unit: "count", group: "quality", floor: 1, help: "Change requests + fix tickets — times the pipeline went back" },
  { key: "quality.nudges", label: "Nudges", unit: "count", group: "quality", floor: 1, help: "Workflow Manager had to push a stalled run" },
  { key: "quality.errors", label: "Errors", unit: "count", group: "quality", floor: 1, help: "agent.error events" },
  { key: "quality.firstPassYield", label: "First-pass yield", unit: "ratio", group: "quality", floor: 0.1, direction: "lower", help: "Share of agent tasks that needed no rework (higher is better)" },
  { key: "cost.personaCacheHitRate", label: "Persona cache hit rate", unit: "ratio", group: "cost", floor: 0.1, direction: "lower", help: "Share of persona input tokens served from the Bedrock prompt cache (higher is better)" },
  // `floor: 5` is the BAND floor (mirrors the Lambda's BAND_KPIS row for this
  // path), not a kpi.json rubric value — the rubric never appears as a literal
  // anywhere in this file. See the R-3 note in the quality-score section below.
  { key: "quality.score", label: "Quality score", unit: "count", group: "quality", floor: 5, direction: "lower", help: "Deterministic 0-100 quality score (higher is better)" },
];

export const BASELINE_DAYS = 28;
export const BASELINE_MIN = 5;

// ─── Robust statistics ────────────────────────────────────────────────────────

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function quantile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}

export function mad(xs: number[]): number | null {
  const m = median(xs);
  if (m == null) return null;
  return median(xs.map((v) => Math.abs(v - m)));
}

export interface Band {
  n: number;
  median: number;
  p75: number;
  sigma: number;
  warnAbove: number;
  alertAbove: number;
  value: number | null;
  z: number | null;
  status: BandStatus;
  direction: "upper" | "lower";
}

export function bandFor(
  values: (number | null | undefined)[], current: number | null, floor: number, direction: "upper" | "lower" = "upper",
): Band | null {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (xs.length < BASELINE_MIN) return null;
  const med = median(xs) as number;
  const sigma = Math.max(1.4826 * (mad(xs) as number), 0.1 * Math.abs(med), floor);
  const sign = direction === "lower" ? -1 : 1;
  const z = current == null ? null : (sign * (current - med)) / sigma;
  const status: BandStatus = z == null ? "unknown" : z >= 3 ? "alert" : z >= 2 ? "warn" : "ok";
  return {
    n: xs.length, median: med, p75: quantile(xs, 0.75) as number, sigma,
    warnAbove: med + sign * 2 * sigma, alertAbove: med + sign * 3 * sigma, value: current, z, status, direction,
  };
}

export function getPath(obj: unknown, path: string): number | null {
  const v = path.split(".").reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ─── Fleet view ───────────────────────────────────────────────────────────────

export interface KpiStat { n: number; median: number; mean: number; p75: number; max: number; total: number }

export interface FleetKpi extends KpiDef {
  current: KpiStat | null;
  prior: KpiStat | null;
  /** (current median − prior median) / |prior median|. Read with `direction`: positive is worse for "upper" KPIs, better for "lower". */
  deltaPct: number | null;
  band: Band | null;
  status: BandStatus;
  /** Per-run values in the current window, oldest first (sparkline). */
  series: { t: string; v: number; workflowId: string }[];
}

export interface AgentAgg {
  agentId: string;
  usd: number;
  workMs: number;
  tasks: number;
  reworkRounds: number;
  runs: number;
  usdPerTask: number | null;
}

export interface FleetView {
  window: { days: number; start: string; end: string; priorStart: string; baselineStart: string };
  workflowDefId: string | "all";
  defIds: string[];
  runs: CardSummary[];
  priorRuns: number;
  kpis: FleetKpi[];
  agents: AgentAgg[];
  engines: Record<string, number>;
  totals: { runs: number; cost: number; persona: number; coding: number; tokens: number; cacheRead: number; cacheWrite: number; agentWorkMs: number; wallMs: number; loops: number; reworkRounds: number };
  infra: InfraSnapshot | null;
  /** Per-run infra allocation from the trailing-30d snapshot, if available. */
  infraPerRun: { core: number | null; runtime: number | null } | null;
  status: BandStatus;
  anomalies: { kpi: string; label: string; status: BandStatus; z: number | null }[];
  indexUpdatedAt: string | null;
}

function stat(xs: number[]): KpiStat | null {
  if (!xs.length) return null;
  return {
    n: xs.length,
    median: median(xs) as number,
    mean: xs.reduce((s, v) => s + v, 0) / xs.length,
    p75: quantile(xs, 0.75) as number,
    max: Math.max(...xs),
    total: xs.reduce((s, v) => s + v, 0),
  };
}

const ms = (d: number) => d * 86_400_000;

/**
 * Cards we can place on a timeline. A run is real as soon as it has a terminal
 * timestamp — cost is a SEPARATE axis (FR-4.2). Before TEAM-4483 a $0 card was
 * dropped here, which silently under-reported `totals.runs` and every time and
 * quality KPI for any run whose cost spans never matched.
 */
export function isValidCard(c: CardSummary): boolean {
  return !!c.completedAt;
}

/**
 * Cards we actually priced. A $0 total means the spans didn't match, not a free
 * run, so cost KPIs / cost totals must exclude these rather than average a zero
 * into the median.
 */
export const hasCostData = (c: CardSummary): boolean => (c.cost?.total ?? 0) > 0;

export function buildFleetView(
  index: PerformanceIndex,
  opts: { days: number; workflowDefId?: string; now?: Date },
): FleetView {
  const now = opts.now ?? new Date();
  const days = Math.max(1, Math.min(90, opts.days || 7));
  const defId = opts.workflowDefId && opts.workflowDefId !== "all" ? opts.workflowDefId : "all";
  const end = now.getTime();
  const start = end - ms(days);
  const priorStart = start - ms(days);
  const baselineStart = start - ms(BASELINE_DAYS);

  const all = (index.cards || []).filter(isValidCard);
  const defIds = [...new Set(all.map((c) => c.workflowDefId))].sort();
  const scoped = defId === "all" ? all : all.filter((c) => c.workflowDefId === defId);
  const at = (c: CardSummary) => Date.parse(c.completedAt);
  const runs = scoped.filter((c) => at(c) >= start && at(c) < end).sort((a, b) => at(b) - at(a));
  const prior = scoped.filter((c) => at(c) >= priorStart && at(c) < start);
  const baseline = scoped.filter((c) => at(c) >= baselineStart && at(c) < start);

  // FR-4.2: cost KPIs and cost totals see only the runs we actually priced, so a
  // cost KPI's `n` is "runs with cost data" and an unpriced run can't drag the
  // median to zero. Everything else (time, quality, run counts) sees every run.
  const costRuns = runs.filter(hasCostData);
  const costPrior = prior.filter(hasCostData);
  const costBaseline = baseline.filter(hasCostData);

  const kpis: FleetKpi[] = FLEET_KPIS.map((k) => {
    const isCost = k.group === "cost";
    const curSrc = isCost ? costRuns : runs;
    const priSrc = isCost ? costPrior : prior;
    const baseSrc = isCost ? costBaseline : baseline;
    const cur = curSrc.map((c) => getPath(c, k.key)).filter((v): v is number => v != null);
    const pri = priSrc.map((c) => getPath(c, k.key)).filter((v): v is number => v != null);
    const current = stat(cur), priorStat = stat(pri);
    const band = bandFor(baseSrc.map((c) => getPath(c, k.key)), current?.median ?? null, k.floor, k.direction || "upper");
    const deltaPct = current && priorStat && priorStat.median !== 0
      ? (current.median - priorStat.median) / Math.abs(priorStat.median)
      : null;
    const series = [...curSrc].reverse()
      .map((c) => ({ t: c.completedAt, v: getPath(c, k.key), workflowId: c.workflowId }))
      .filter((p): p is { t: string; v: number; workflowId: string } => p.v != null);
    return { ...k, current, prior: priorStat, deltaPct, band, status: band?.status ?? (current ? "insufficient" : "unknown"), series };
  });

  const agentMap = new Map<string, AgentAgg>();
  const engines: Record<string, number> = {};
  const totals = { runs: runs.length, cost: 0, persona: 0, coding: 0, tokens: 0, cacheRead: 0, cacheWrite: 0, agentWorkMs: 0, wallMs: 0, loops: 0, reworkRounds: 0 };
  for (const c of runs) {
    const priced = hasCostData(c);
    // Money rollups from priced runs only; work/count rollups from every run.
    if (priced) {
      totals.cost += c.cost.total; totals.persona += c.cost.persona; totals.coding += c.cost.coding;
      totals.tokens += c.cost.tokens; totals.cacheRead += c.cost.cacheRead ?? 0; totals.cacheWrite += c.cost.cacheWrite ?? 0;
      for (const [e, usd] of Object.entries(c.cost.byEngine || {})) engines[e] = (engines[e] || 0) + usd;
    }
    totals.agentWorkMs += c.time.agentWork; totals.wallMs += c.time.wall ?? 0;
    totals.loops += c.quality.loops; totals.reworkRounds += c.quality.reworkRounds;
    for (const [agentId, a] of Object.entries(c.agents || {})) {
      const agg = agentMap.get(agentId) || { agentId, usd: 0, workMs: 0, tasks: 0, reworkRounds: 0, runs: 0, usdPerTask: null };
      if (priced) agg.usd += a.usd;
      agg.workMs += a.workMs; agg.tasks += a.tasks; agg.reworkRounds += a.reworkRounds; agg.runs++;
      agentMap.set(agentId, agg);
    }
  }
  const agents = [...agentMap.values()]
    .map((a) => ({ ...a, usdPerTask: a.tasks ? a.usd / a.tasks : null }))
    .sort((a, b) => b.usd - a.usd);

  const anomalies = kpis
    .filter((k) => k.status === "warn" || k.status === "alert")
    .map((k) => ({ kpi: k.key, label: k.label, status: k.status, z: k.band?.z ?? null }));
  const status: BandStatus = anomalies.some((a) => a.status === "alert") ? "alert"
    : anomalies.length ? "warn"
    : kpis.some((k) => k.status === "ok") ? "ok"
    : runs.length ? "insufficient" : "unknown";

  const infra = index.infra ?? null;
  const infraPerRun = infra && !infra.error
    ? { core: infra.perRunCoreUsd ?? null, runtime: infra.perRunRuntimeUsd ?? null }
    : null;

  return {
    window: {
      days, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
      priorStart: new Date(priorStart).toISOString(), baselineStart: new Date(baselineStart).toISOString(),
    },
    workflowDefId: defId,
    defIds,
    runs,
    priorRuns: prior.length,
    kpis,
    agents,
    engines,
    totals,
    infra,
    infraPerRun,
    status,
    anomalies,
    indexUpdatedAt: index.updatedAt ?? null,
  };
}

// ─── Formatting shared by the UI ──────────────────────────────────────────────

export function formatKpi(unit: KpiUnit, v: number | null | undefined, compact = false): string {
  if (v == null || !Number.isFinite(v)) return "—";
  switch (unit) {
    case "usd": return v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(v >= 10 ? 0 : 2)}`;
    case "ms": {
      const m = Math.round(v / 60000);
      if (m < 60) return `${m}m`;
      const h = Math.floor(m / 60);
      if (h < 48 || compact) return h < 10 ? `${h}h ${m % 60}m` : `${h}h`;
      return `${Math.floor(h / 24)}d ${h % 24}h`;
    }
    case "tokens": return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1000)}k`;
    case "ratio": return `${Math.round(v * 100)}%`;
    default: return Number.isInteger(v) ? String(v) : v.toFixed(1);
  }
}

// ─── Deterministic quality score (src/config/kpi.json) ────────────────────────
//
// `computeKpi` is the TS mirror of the cost-report Lambda's scorer. Both read the
// SAME rubric file and must produce byte-identical output for the same card —
// lambda/cost-report/fixtures/kpi-cases.json is the shared fixture that proves
// it (performance.test.ts runs every case through this copy).
//
// R-3: NOT ONE weight, tolerance, outcome cap, grade threshold or
// minEvidenceWeight may appear here as a numeric literal — every rubric value is
// read from `config`. The only numeric literals below are the clamp bounds (0, 1),
// the percentage base (100), round4's factor, and the +0.5 of the explicit
// round-half-up; all four are arithmetic, not policy. Changing the rubric means
// editing kpi.json, never this file.
//
// PURE: no AWS, no clock. `computedAt` is the card's own `generatedAt`, so
// recomputing a card twice yields the same bytes.

export type KpiComponentKind = "ratio" | "rate" | "count" | "sum" | "excess" | "verdict";
export type KpiConfidence = "full" | "partial" | "insufficient";

export interface KpiGradeDef { grade: string; min: number }

/**
 * One weighted line of the rubric. Which optional fields matter depends on
 * `kind`: `rate` uses source+per, `sum` uses sources, `excess` uses
 * source+baseline, `verdict` uses source+values+neutralOn, and every arithmetic
 * kind except `ratio` uses `tolerance` (the value at which the line scores 0).
 *
 * Not to be confused with `KpiDef` above — that's a fleet BAND definition
 * (median + MAD anomaly detection). This is a scoring component.
 */
export interface KpiComponentDef {
  key: string;
  label: string;
  weight: number;
  kind: KpiComponentKind;
  source?: string;
  sources?: string[];
  per?: string;
  baseline?: string;
  tolerance?: number;
  values?: Record<string, number>;
  neutralOn?: (string | null)[];
}

export interface KpiConfig {
  kpiVersion: number;
  /** Highest `min` first — the first entry a score reaches wins. */
  grades: KpiGradeDef[];
  /** Outcome → ceiling. A run that didn't ship can't grade above its cap. */
  outcomeCaps: Record<string, number>;
  quality: { minEvidenceWeight: number; components: KpiComponentDef[] };
}

export const KPI_CONFIG = kpiConfig as KpiConfig;

/** Card schema this build reads/writes. Bumped with any card shape change. */
export const CURRENT_REPORT_VERSION = 5;

export interface KpiComponent {
  key: string;
  label: string;
  weight: number;
  /** The measured input (a string for `verdict` kinds), or null when absent. */
  raw: number | string | null;
  /** UNCLAMPED, so an over-tolerance input is visibly negative. */
  normalized: number | null;
  /** round4(weight x clamp(normalized, 0, 1)), or null when excluded. */
  points: number | null;
  included: boolean;
  /** Why the component was excluded. Only set when `included` is false. */
  note?: string;
}

export interface KpiCap { kind: "outcome"; outcome: string; cap: number }

export interface Kpi {
  version: number;
  computedAt: string | null;
  cost: { usd: number | null; band: BandStatus; z: number | null };
  time: { wallMs: number | null; activeMs: number | null; humanWaitMs: number | null; band: BandStatus; z: number | null };
  quality: {
    score: number | null;
    grade: string | null;
    confidence: KpiConfidence;
    evidenceWeight: number;
    outcome: string;
    band: BandStatus;
    z: number | null;
    components: KpiComponent[];
    excluded: string[];
    capsApplied: KpiCap[];
  };
}

/**
 * The shape `computeKpi` reads. Deliberately all-optional with an index
 * signature: a report-v4 card, or a card with a data gap, must typecheck and
 * score without throwing.
 */
export interface PerformanceCardInput {
  reportVersion?: number;
  generatedAt?: string;
  run?: { outcome?: string | null;[k: string]: unknown } | null;
  cost?: { totalUsd?: number | null;[k: string]: unknown } | null;
  time?: { [k: string]: unknown } | null;
  quality?: { [k: string]: unknown } | null;
  dataQuality?: { costMissing?: boolean;[k: string]: unknown } | null;
  kpi?: unknown;
  [k: string]: unknown;
}

/** Byte-parity with the Lambda's round4 — 4 dp is the card's money/ratio precision. */
export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** The non-numeric sibling of `getPath` — walks a dotted path to any value. */
function getRaw(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}

const UNKNOWN_OUTCOME = "unknown";

interface Measured { raw: number | string | null; normalized: number | null; note?: string }

/** Per-kind measurement. `normalized === null` means "no evidence" → excluded. */
function measure(card: PerformanceCardInput, def: KpiComponentDef): Measured {
  const num = (path: string | undefined) => (path ? getPath(card, path) : null);
  const tolerance = def.tolerance;
  // A rubric line whose tolerance is missing is misconfigured, not zero-scoring:
  // excluding it keeps one bad edit from silently grading every run down.
  const needsTolerance = def.kind !== "ratio" && def.kind !== "verdict";
  if (needsTolerance && tolerance === undefined) {
    return { raw: null, normalized: null, note: `${def.key}: no tolerance in kpi.json` };
  }
  const decay = (raw: number) => 1 - raw / (tolerance as number);

  switch (def.kind) {
    case "ratio": {
      const raw = num(def.source);
      return raw === null ? { raw, normalized: null, note: `no ${def.source}` } : { raw, normalized: raw };
    }
    case "rate": {
      const per = num(def.per);
      if (!(per !== null && per > 0)) return { raw: null, normalized: null, note: `no ${def.per}` };
      const hits = num(def.source);
      if (hits === null) return { raw: null, normalized: null, note: `no ${def.source}` };
      const raw = hits / per;
      return { raw, normalized: decay(raw) };
    }
    case "count": {
      const raw = num(def.source);
      return raw === null ? { raw, normalized: null, note: `no ${def.source}` } : { raw, normalized: decay(raw) };
    }
    case "sum": {
      const sources = def.sources ?? [];
      const values = sources.map((s) => num(s));
      // Only a card missing EVERY source has no evidence; a missing sibling is 0.
      if (!values.some((v) => v !== null)) return { raw: null, normalized: null, note: `no ${sources.join(" / ") || def.key}` };
      const raw = values.reduce<number>((s, v) => s + (v ?? 0), 0);
      return { raw, normalized: decay(raw) };
    }
    case "excess": {
      const value = num(def.source), floor = num(def.baseline);
      if (value === null || floor === null) return { raw: null, normalized: null, note: `no ${def.source} or ${def.baseline}` };
      const raw = Math.max(0, value - floor);
      return { raw, normalized: decay(raw) };
    }
    case "verdict": {
      const found = getRaw(card, def.source ?? "");
      const raw = typeof found === "string" ? found : null;
      const values = def.values ?? {};
      const neutral = (def.neutralOn ?? []).some((n) => n === raw);
      if (neutral || raw === null || !Object.prototype.hasOwnProperty.call(values, raw)) {
        return { raw, normalized: null, note: `${def.source} is ${raw ?? "absent"}` };
      }
      return { raw, normalized: values[raw] };
    }
  }
}

/**
 * Score a performance card against the rubric. Deterministic and total: any card
 * shape scores or reports `insufficient`, and nothing here throws.
 */
export function computeKpi(card: PerformanceCardInput, config: KpiConfig = KPI_CONFIG): Kpi {
  const components: KpiComponent[] = [];
  const excluded: string[] = [];
  const capsApplied: KpiCap[] = [];
  let evidenceWeight = 0;
  // Σ of UNROUNDED points. The rounded per-component values are for display only
  // — summing those instead would drift the score by up to a point.
  let earned = 0;

  for (const def of config.quality.components) {
    const { raw, normalized, note } = measure(card, def);
    if (normalized === null || !Number.isFinite(normalized)) {
      excluded.push(def.key);
      components.push({ key: def.key, label: def.label, weight: def.weight, raw, normalized: null, points: null, included: false, note });
      continue;
    }
    const clamped = Math.min(1, Math.max(0, normalized));
    earned += def.weight * clamped;
    evidenceWeight += def.weight;
    components.push({ key: def.key, label: def.label, weight: def.weight, raw, normalized, points: round4(def.weight * clamped), included: true });
  }

  const outcome = typeof card.run?.outcome === "string" ? card.run.outcome : UNKNOWN_OUTCOME;
  let score: number | null = null;
  let grade: string | null = null;
  let confidence: KpiConfidence = "insufficient";

  if (evidenceWeight >= config.quality.minEvidenceWeight) {
    // Round HALF UP explicitly: Math.round is half-up only for positives, and the
    // Lambda twin must agree on the .5 case (see the round-half-up fixture).
    score = Math.floor((100 * earned) / evidenceWeight + 0.5);
    const cap = config.outcomeCaps[outcome];
    // Record the cap only when it actually lowered the score, so capsApplied
    // reads as "this is why the grade is what it is".
    if (cap !== undefined && score > cap) {
      capsApplied.push({ kind: "outcome", outcome, cap });
      score = cap;
    }
    confidence = evidenceWeight === 100 ? "full" : "partial";
    grade = config.grades.find((g) => (score as number) >= g.min)?.grade ?? null;
  }

  // A $0 total is unknown cost, never a free run — the hero strip must show "—".
  const costMissing = !!card.dataQuality?.costMissing || !((card.cost?.totalUsd ?? 0) > 0);

  return {
    version: config.kpiVersion,
    computedAt: card.generatedAt ?? null,
    cost: { usd: costMissing ? null : (card.cost?.totalUsd ?? null), band: "unknown", z: null },
    time: {
      wallMs: getPath(card, "time.wallMs"),
      activeMs: getPath(card, "time.activeMs"),
      humanWaitMs: getPath(card, "time.humanWaitMs"),
      band: "unknown",
      z: null,
    },
    quality: {
      score, grade, confidence, evidenceWeight, outcome,
      band: "unknown", z: null,
      components, excluded, capsApplied,
    },
  };
}

/**
 * Read a card's stored `kpi` block. Returns null for anything that isn't a
 * versioned KPI — a report-v4 card, a half-written card, a null. Never throws:
 * callers render every run in the same list.
 */
export function readKpi(card: PerformanceCardInput | null | undefined): Kpi | null {
  const stored = card?.kpi;
  if (!stored || typeof stored !== "object") return null;
  const version = (stored as { version?: unknown }).version;
  return typeof version === "number" && Number.isFinite(version) ? (stored as Kpi) : null;
}
