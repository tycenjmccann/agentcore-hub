/**
 * Performance card — fleet-level aggregation over the per-run cards the
 * cost-report Lambda writes (performance/index.json in the artifact bucket).
 *
 * PURE: no AWS calls, no clock reads (callers pass `now`). The band arithmetic
 * (median + MAD, warn at 2σ, alert at 3σ, sigma floored at max(floor, 10% of
 * |median|)) deliberately mirrors lambda/cost-report/index.mjs so a run's card
 * and the fleet view never disagree about what "anomalous" means.
 */

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
  };
  agents: Record<string, { usd: number; workMs: number; tasks: number; reworkRounds: number }>;
  status: BandStatus;
  anomalies: { kpi: string; status: BandStatus; z: number | null }[];
  gaps: number;
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
  totals: { runs: number; cost: number; persona: number; coding: number; tokens: number; agentWorkMs: number; wallMs: number; loops: number; reworkRounds: number };
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

/** Cards with cost data — a $0 card means the spans didn't match, not a free run. */
export function isValidCard(c: CardSummary): boolean {
  return (c.cost?.total ?? 0) > 0 && !!c.completedAt;
}

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

  const kpis: FleetKpi[] = FLEET_KPIS.map((k) => {
    const cur = runs.map((c) => getPath(c, k.key)).filter((v): v is number => v != null);
    const pri = prior.map((c) => getPath(c, k.key)).filter((v): v is number => v != null);
    const current = stat(cur), priorStat = stat(pri);
    const band = bandFor(baseline.map((c) => getPath(c, k.key)), current?.median ?? null, k.floor, k.direction || "upper");
    const deltaPct = current && priorStat && priorStat.median !== 0
      ? (current.median - priorStat.median) / Math.abs(priorStat.median)
      : null;
    const series = [...runs].reverse()
      .map((c) => ({ t: c.completedAt, v: getPath(c, k.key), workflowId: c.workflowId }))
      .filter((p): p is { t: string; v: number; workflowId: string } => p.v != null);
    return { ...k, current, prior: priorStat, deltaPct, band, status: band?.status ?? (current ? "insufficient" : "unknown"), series };
  });

  const agentMap = new Map<string, AgentAgg>();
  const engines: Record<string, number> = {};
  const totals = { runs: runs.length, cost: 0, persona: 0, coding: 0, tokens: 0, agentWorkMs: 0, wallMs: 0, loops: 0, reworkRounds: 0 };
  for (const c of runs) {
    totals.cost += c.cost.total; totals.persona += c.cost.persona; totals.coding += c.cost.coding;
    totals.tokens += c.cost.tokens; totals.agentWorkMs += c.time.agentWork; totals.wallMs += c.time.wall ?? 0;
    totals.loops += c.quality.loops; totals.reworkRounds += c.quality.reworkRounds;
    for (const [e, usd] of Object.entries(c.cost.byEngine || {})) engines[e] = (engines[e] || 0) + usd;
    for (const [agentId, a] of Object.entries(c.agents || {})) {
      const agg = agentMap.get(agentId) || { agentId, usd: 0, workMs: 0, tasks: 0, reworkRounds: 0, runs: 0, usdPerTask: null };
      agg.usd += a.usd; agg.workMs += a.workMs; agg.tasks += a.tasks; agg.reworkRounds += a.reworkRounds; agg.runs++;
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
