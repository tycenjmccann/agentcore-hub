"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, ChevronDown, ChevronRight, Loader2, RefreshCw, ExternalLink, Settings } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import agentsConfig from "@/config/agents.json";
import ScoreChip from "./components/ScoreChip";
import SiImpactPanel from "./components/SiImpactPanel";
import Sparkline from "./components/Sparkline";
import WindowSelector from "./components/WindowSelector";
import { parseWindow, windowLabel as fallbackWindowLabel } from "./components/window";
import {
  normalizeEvaluator,
  personaMetrics,
  personaScores,
  toEvaluatorSeries,
  type AgentMetrics,
  type AgentMetricsWithPersonas,
  type EvalData,
  type EvalWindow,
  type EvaluatorSeries,
  type PersonaRow,
  type ScorecardEntry,
} from "./components/types";

/**
 * Evaluations overview. One column per agent that is wired for evaluations in
 * src/config/agents.json (`evalConfigName` + `evaluationsEnabled`), with the
 * shared-runtime agent expandable into the personas that actually have data.
 *
 * This replaced a `runtimeArn`-keyed collapse that could never fire — the
 * checked-in roster ships `runtimeArn: null` by contract, so the old rule always
 * fell through to the API's agent list.
 */

interface RawAgent {
  agentId: string;
  displayName: string;
  evaluationsEnabled?: boolean;
  evalConfigName?: string;
  /** Explicit override: the agentId whose runtime scores this persona. */
  evalHost?: string;
  personas?: (string | { persona?: string; name?: string })[];
}

const ROSTER = (agentsConfig as unknown as { agents: RawAgent[] }).agents;

const ROSTER_BY_ID = new Map(ROSTER.map((a) => [a.agentId, a]));

/**
 * Fallback column universe, used only until the API answers: every roster
 * agent that can hold evaluation data. The API's `columns` replaces it — the
 * server derives, from the LIVE roster's runtimeArns, which personas share a
 * host's runtime (and so are ↳ sub-columns, never a top-level column) and which
 * own theirs. The bundled roster ships null ARNs, so it cannot tell.
 */
const EVAL_AGENTS = ROSTER.filter((a) => !!a.evalConfigName && !!a.evaluationsEnabled && !a.evalHost);

function columnAgents(data: EvalData | null): RawAgent[] {
  if (!data?.columns?.length) return EVAL_AGENTS;
  // The API keys metrics/scorecard/personas by the LIVE roster's displayName, so
  // that name wins; the bundled entry only contributes colour and persona order.
  return data.columns.map((c) => ({
    ...(ROSTER_BY_ID.get(c.agentId) ?? {}),
    agentId: c.agentId,
    displayName: c.displayName,
    evaluationsEnabled: true,
  }));
}

/**
 * Persona names for ordering the expanded rows: the agent's own `personas` list
 * when it has one, else the API's persona → host map, else roster entries that
 * name this agent as `evalHost`.
 */
function configuredPersonas(agent: RawAgent, hosted: Record<string, string> | undefined): string[] {
  const declared = (agent.personas ?? [])
    .map((p) => (typeof p === "string" ? p : p.persona || p.name || ""))
    .filter(Boolean);
  if (declared.length) return declared;
  const fromApi = Object.entries(hosted ?? {})
    .filter(([, host]) => host === agent.agentId)
    .map(([persona]) => persona);
  if (fromApi.length) return fromApi;
  return ROSTER.filter((a) => a.evalHost === agent.agentId).map((a) => a.agentId);
}

const AGENT_COLORS: Record<string, string> = {
  "Requirements Analyst": "#8b5cf6",
  "Analytics Designer": "#06b6d4",
  "Android Designer": "#10b981",
  "Backend Designer": "#f59e0b",
  "Frontend Designer": "#ec4899",
  "iOS Designer": "#6366f1",
  "Legal & Compliance": "#64748b",
  "Localization": "#14b8a6",
  "API Developer": "#f97316",
  "Backend Developer": "#eab308",
  "Frontend Developer": "#a855f7",
  "QA Verifier": "#22c55e",
  "CI Agent": "#3b82f6",
  "Security Reviewer": "#ef4444",
};

function formatTokens(n?: number): string {
  if (!n) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function formatCost(v?: number): string {
  if (!v) return "—";
  if (v < 1) return `$${v.toFixed(2)}`;
  return `$${Math.round(v).toLocaleString()}`;
}

function shortModelName(modelId: string): string {
  if (modelId.includes("fable")) return "Fable";
  if (modelId.includes("opus")) return "Opus";
  if (modelId.includes("sonnet")) return "Sonnet";
  if (modelId.includes("haiku")) return "Haiku";
  return modelId.split(".").pop()?.split("-")[0] || modelId;
}

// Client-side cache, per window — a single shared key would let one window serve
// another window's numbers.
const EVAL_CACHE_PREFIX = "agentcore-hub-eval-cache";
const EVAL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function cacheKey(win: EvalWindow): string {
  return `${EVAL_CACHE_PREFIX}:${win}`;
}

function getCachedData(win: EvalWindow): EvalData | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(win));
    if (!raw) return null;
    const { data, timestamp } = JSON.parse(raw);
    if (Date.now() - timestamp > EVAL_CACHE_TTL) return null;
    return data;
  } catch { return null; }
}

function setCachedData(win: EvalWindow, data: EvalData) {
  try {
    sessionStorage.setItem(cacheKey(win), JSON.stringify({ data, timestamp: Date.now() }));
  } catch {}
}

/** One rendered column: an agent, or one persona of a shared-runtime agent. */
interface Col {
  key: string;
  /** Selector-safe id for per-cell test hooks. */
  slug: string;
  testId: string;
  agentId: string;
  persona?: string;
  label: string;
  color: string;
  href: string;
  metrics?: Partial<AgentMetrics>;
  scores?: Record<string, ScorecardEntry>;
  expandable?: boolean;
  expanded?: boolean;
}

export default function EvaluationsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-5 h-5 animate-spin text-brand-400" />
        </div>
      }
    >
      <EvaluationsOverview />
    </Suspense>
  );
}

function EvaluationsOverview() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const win = parseWindow(searchParams.get("days"));

  const [data, setData] = useState<EvalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [agentEnabled, setAgentEnabled] = useState<Record<string, boolean>>({});
  const [agentToggling, setAgentToggling] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [trends, setTrends] = useState<Record<string, EvaluatorSeries>>({});

  const setWindow = useCallback(
    (next: EvalWindow) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("days", next);
      router.replace(`/evaluations?${params.toString()}`);
    },
    [router, searchParams]
  );

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/evaluations?days=${win}`, { cache: "no-store" });
      const newData = await res.json();
      if (!res.ok) throw new Error(newData?.error || `HTTP ${res.status}`);
      setData(newData);
      setCachedData(win, newData);
      setError("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [win]);

  const fetchAgentConfigs = useCallback(async () => {
    try {
      const res = await fetch("/api/evaluations/agents");
      if (res.ok) {
        const { agents: configs } = await res.json();
        const map: Record<string, boolean> = {};
        for (const c of configs) {
          map[c.agentId] = c.enabled;
        }
        setAgentEnabled(map);
      }
    } catch {}
  }, []);

  const toggleAgent = async (agentId: string) => {
    const current = agentEnabled[agentId];
    if (!agentId || current === undefined) return;
    setAgentToggling((prev) => ({ ...prev, [agentId]: true }));
    try {
      const res = await fetch(`/api/evaluations/agents/${agentId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !current }),
      });
      if (res.ok) {
        setAgentEnabled((prev) => ({ ...prev, [agentId]: !current }));
      }
    } catch {} finally {
      setAgentToggling((prev) => ({ ...prev, [agentId]: false }));
    }
  };

  useEffect(() => {
    const cached = getCachedData(win);
    setData(cached);
    setLoading(!cached);
    setTrends({});
    fetchData();
  }, [win, fetchData]);

  useEffect(() => {
    fetchAgentConfigs();
  }, [fetchAgentConfigs]);

  // Persona rows for an agent: whatever the API reports (those are the personas
  // that actually have data), ordered by the roster's list when it has one.
  const personaRowsFor = useCallback(
    (agent: RawAgent): PersonaRow[] => {
      const fromTop = data?.personas?.[agent.displayName];
      const fromMetrics = (data?.metrics?.[agent.displayName] as AgentMetricsWithPersonas | undefined)?.personas;
      const rows = (fromTop ?? fromMetrics ?? []).filter((p) => !!p?.persona);
      const order = configuredPersonas(agent, data?.hosted);
      if (!order.length) return rows;
      return [...rows].sort((a, b) => {
        const ia = order.indexOf(a.persona);
        const ib = order.indexOf(b.persona);
        return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
      });
    },
    [data]
  );

  const { cols, agentCols } = useMemo(() => {
    const all: Col[] = [];
    const agentsOnly: Col[] = [];
    for (const agent of columnAgents(data)) {
      const personas = personaRowsFor(agent);
      const scores = data?.scorecard?.[agent.displayName];
      const col: Col = {
        key: agent.agentId,
        slug: agent.agentId,
        testId: `eval-col-${agent.agentId}`,
        agentId: agent.agentId,
        label: agent.displayName,
        color: AGENT_COLORS[agent.displayName] || "#94a3b8",
        href: `/evaluations/${agent.agentId}?days=${win}`,
        metrics: data?.metrics?.[agent.displayName],
        scores,
        expandable: personas.length > 0,
        expanded: !!expanded[agent.agentId],
      };
      all.push(col);
      agentsOnly.push(col);
      if (personas.length && expanded[agent.agentId]) {
        for (const row of personas) {
          all.push({
            key: `${agent.agentId}::${row.persona}`,
            slug: `${agent.agentId}-${row.persona}`,
            testId: `eval-persona-col-${row.persona}`,
            agentId: agent.agentId,
            persona: row.persona,
            label: row.persona,
            color: AGENT_COLORS[row.persona] || "#94a3b8",
            href: `/evaluations/${agent.agentId}?days=${win}&persona=${encodeURIComponent(row.persona)}`,
            metrics: personaMetrics(row),
            scores: personaScores(row),
          });
        }
      }
    }
    return { cols: all, agentCols: agentsOnly };
  }, [data, expanded, personaRowsFor, win]);

  // One timeseries request per agent column that has any score — never per
  // persona — and a failure just means no sparkline.
  useEffect(() => {
    const targets = agentCols.filter((c) => c.scores && Object.keys(c.scores).length > 0).map((c) => c.agentId);
    let cancelled = false;
    for (const agentId of targets) {
      if (trends[agentId]) continue;
      fetch(`/api/evaluations/timeseries?agentId=${encodeURIComponent(agentId)}&days=${win}`, { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => {
          if (cancelled || !json) return;
          setTrends((prev) => ({ ...prev, [agentId]: toEvaluatorSeries(json.series) }));
        })
        .catch(() => {});
    }
    return () => { cancelled = true; };
    // `trends` is intentionally read but not depended on: it only ever gains keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentCols, win]);

  const hasScores = !!(data?.scorecard && Object.keys(data.scorecard).length > 0);

  // Totals cover agent columns only — persona columns are a breakdown of one of
  // them, so folding them in would double-count.
  const totals = {
    sessions: agentCols.reduce((s, c) => s + (c.metrics?.sessions || 0), 0),
    tokensIn: agentCols.reduce((s, c) => s + (c.metrics?.tokensIn || 0), 0),
    tokensOut: agentCols.reduce((s, c) => s + (c.metrics?.tokensOut || 0), 0),
    cacheRead: agentCols.reduce((s, c) => s + (c.metrics?.cacheRead || 0), 0),
    cost: agentCols.reduce((s, c) => s + (c.metrics?.cost || 0), 0),
    costPerSession: 0,
  };
  totals.costPerSession = totals.sessions > 0 ? totals.cost / totals.sessions : 0;
  const cacheHitPct = (m?: { tokensIn?: number; cacheRead?: number }) =>
    m?.tokensIn && m.cacheRead ? Math.round((m.cacheRead / m.tokensIn) * 100) : 0;

  const label = data?.windowLabel || fallbackWindowLabel(win);

  // Per-model cost totals across agent columns
  const modelTotals: Record<string, number> = {};
  for (const col of agentCols) {
    for (const m of col.metrics?.models || []) {
      modelTotals[m.model] = (modelTotals[m.model] || 0) + m.cost;
    }
  }
  const usedModels = Object.keys(modelTotals).sort();

  const scoreOf = (col: Col, evaluator: string): ScorecardEntry | undefined =>
    col.scores?.[`Builtin.${evaluator}`] || col.scores?.[evaluator];

  /** Overall average per evaluator, across agent columns that have a score. */
  function evalTotal(evaluator: string): number | null {
    let sum = 0;
    let count = 0;
    for (const col of agentCols) {
      const entry = scoreOf(col, evaluator);
      if (entry) { sum += entry.avg; count++; }
    }
    return count > 0 ? sum / count : null;
  }

  function overallOf(col: Col): number | null {
    const entries = Object.values(col.scores || {});
    if (!entries.length) return null;
    return entries.reduce((s, e) => s + e.avg, 0) / entries.length;
  }

  function overallTotal(): number | null {
    let sum = 0;
    let count = 0;
    for (const col of agentCols) {
      const overall = overallOf(col);
      if (overall === null) continue;
      sum += overall;
      count++;
    }
    return count > 0 ? sum / count : null;
  }

  const columnHeader = (col: Col) => (
    <th
      key={col.key}
      data-testid={col.testId}
      className="text-center px-2 py-3 font-bold w-[140px] align-bottom"
      style={{ color: col.color }}
    >
      <span className="flex items-center justify-center gap-1">
        {col.expandable && (
          <button
            type="button"
            data-testid={`eval-expand-${col.agentId}`}
            aria-expanded={!!col.expanded}
            title={col.expanded ? "Collapse personas" : "Expand personas"}
            onClick={() => setExpanded((prev) => ({ ...prev, [col.agentId]: !prev[col.agentId] }))}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          >
            {col.expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </button>
        )}
        <Link
          href={col.href}
          className="block text-[11px] leading-snug hover:underline"
          title={col.persona ? `${col.persona} — open drilldown` : `${col.label} — open drilldown`}
        >
          {col.persona ? `↳ ${col.label}` : col.label}
        </Link>
      </span>
    </th>
  );

  const columnHeaders = (metricLabel: string, totalLabel: string) => (
    <tr className="border-b border-white/[0.06]">
      <th className="text-left px-3 py-3 text-xs text-[var(--color-text-muted)] font-medium sticky left-0 bg-surface-2 z-10 w-[160px] min-w-[160px]">
        {metricLabel}
      </th>
      <th className="text-center px-2 py-3 text-xs font-bold text-[var(--color-text-primary)] w-[65px] min-w-[65px]">
        {totalLabel}
      </th>
      {cols.map((col) => columnHeader(col))}
    </tr>
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[var(--color-text-primary)] flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-brand-400" />
            Evaluations
          </h1>
          <p className="text-[11px] font-semibold text-info-fg uppercase tracking-[0.15em] mt-1.5">
            {agentCols.length} {agentCols.length === 1 ? "agent" : "agents"} &nbsp;·&nbsp; {(data?.evaluators?.length ?? 0)} evaluators &nbsp;·&nbsp; Opus 4.7 judge &nbsp;·&nbsp; 100% sampling &nbsp;·&nbsp; <span data-testid="eval-window-label">{label}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <WindowSelector value={win} onChange={setWindow} />
          <a
            href="https://us-east-1.console.aws.amazon.com/bedrock-agentcore/home?region=us-east-1#/evaluations"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-surface-2 border border-surface-4 hover:border-brand-500/50 transition-colors text-xs text-[var(--color-text-secondary)]"
          >
            <ExternalLink className="w-3 h-3" /> Console
          </a>
          <button
            onClick={fetchData}
            disabled={loading}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-brand-600/20 border border-brand-600/30 text-brand-400 text-xs hover:bg-brand-600/30 transition-colors"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {error && (
        <div data-testid="eval-error" className="bg-danger-subtle border border-danger-fg/30 rounded-lg px-3 py-2 text-danger-fg text-xs">
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-5 h-5 animate-spin text-brand-400" />
        </div>
      )}

      {cols.length > 0 && (
        <div className="bg-surface-2 border border-surface-4 rounded-xl overflow-hidden w-fit max-w-full">
          <div className="overflow-x-auto">
            <table data-testid="eval-table" style={{ tableLayout: "fixed", width: "max-content" }}>
              <colgroup>
                <col style={{ width: "160px", minWidth: "160px" }} />
                <col style={{ width: "65px", minWidth: "65px" }} />
              </colgroup>

              {/* ─── Self-Improvement Loop ─── */}
              <thead>
                <tr>
                  <td colSpan={cols.length + 2} className="px-3 pt-4 pb-2">
                    <span className="text-sm font-bold text-success-fg uppercase tracking-wider">Self-Improvement Loop</span>
                  </td>
                </tr>
              </thead>
              <tbody className="text-sm">
                <tr className="border-b border-white/[0.06]">
                  <td className="px-3 py-3 text-[var(--color-text-secondary)] sticky left-0 bg-surface-2 z-10">
                    <Link
                      href="/evaluations/config"
                      className="text-[var(--color-text-secondary)] hover:text-brand-400 transition-colors"
                    >
                      All Settings
                    </Link>
                  </td>
                  <td className="text-center py-3">
                    <Link
                      href="/evaluations/config"
                      className="inline-flex items-center justify-center text-[var(--color-text-muted)] hover:text-brand-400 transition-colors"
                      title="Self-Improvement Settings"
                    >
                      <Settings className="w-[22px] h-[22px]" />
                    </Link>
                  </td>
                  {cols.map((col) => {
                    if (col.persona) {
                      return (
                        <td key={col.key} className="text-center py-3 text-[var(--color-text-muted)]">
                          —
                        </td>
                      );
                    }
                    const enabled = agentEnabled[col.agentId];
                    const toggling = agentToggling[col.agentId];
                    return (
                      <td key={col.key} className="text-center py-3">
                        <button
                          onClick={() => toggleAgent(col.agentId)}
                          disabled={toggling || enabled === undefined}
                          data-testid={`eval-toggle-${col.agentId}`}
                          className="group relative inline-block"
                          title={enabled ? "ON — click to disable" : "OFF — click to enable"}
                        >
                          <div className={`w-[38px] h-[19px] rounded-full transition-colors ${
                            enabled ? "bg-emerald-500" : "bg-surface-4"
                          } ${toggling ? "opacity-50" : "group-hover:opacity-80"}`}>
                            <div className={`absolute top-[3px] w-[13px] h-[13px] rounded-full bg-white transition-all ${
                              enabled ? "left-[21px]" : "left-[4px]"
                            }`} />
                          </div>
                        </button>
                      </td>
                    );
                  })}
                </tr>
              </tbody>

              {/* ─── Operational Metrics ─── */}
              {data && (
              <>
              <thead>
                <tr>
                  <td colSpan={cols.length + 2} className="px-3 pt-6 pb-2">
                    <span className="text-sm font-bold text-info-fg uppercase tracking-wider">Operational Metrics</span>
                  </td>
                </tr>
                {columnHeaders("Metric", "Total")}
              </thead>
              <tbody className="text-sm">
                <OpsRow
                  label="Sessions"
                  total={String(totals.sessions || "—")}
                  cols={cols}
                  renderCell={(col) => {
                    const v = col.metrics?.sessions;
                    return v ? String(v) : "—";
                  }}
                />
                <OpsRow
                  label="Cost / Session"
                  total={formatCost(totals.costPerSession)}
                  totalColor="#3b82f6"
                  cols={cols}
                  renderCell={(col) => formatCost(col.metrics?.costPerSession)}
                  cellColor={(col) => (col.metrics?.costPerSession ? "#3b82f6" : undefined)}
                />
                <OpsRow
                  label="Tokens In"
                  total={formatTokens(totals.tokensIn)}
                  cols={cols}
                  renderCell={(col) => formatTokens(col.metrics?.tokensIn)}
                />
                <OpsRow
                  label="Tokens Out"
                  total={formatTokens(totals.tokensOut)}
                  cols={cols}
                  renderCell={(col) => formatTokens(col.metrics?.tokensOut)}
                />
                <OpsRow
                  label="Cache Hit"
                  total={totals.cacheRead ? `${cacheHitPct(totals)}%` : "—"}
                  cols={cols}
                  renderCell={(col) => (col.metrics?.cacheRead ? `${cacheHitPct(col.metrics)}%` : "—")}
                />
                {/* Per-model cost sub-rows */}
                {usedModels.map((model) => (
                  <tr key={model} className="border-b border-white/[0.04]">
                    <td className="px-3 py-2 text-[var(--color-text-secondary)] sticky left-0 bg-surface-2 z-10 pl-6">
                      {shortModelName(model)}
                    </td>
                    <td className="text-center py-2 text-[var(--color-text-secondary)]">
                      {formatCost(modelTotals[model])}
                    </td>
                    {cols.map((col) => {
                      const modelEntry = col.metrics?.models?.find((m) => m.model === model);
                      return (
                        <td key={col.key} className="text-center py-2 text-[var(--color-text-secondary)]">
                          {formatCost(modelEntry?.cost)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {/* Total Cost row — bold */}
                <tr className="bg-white/[0.03]">
                  <td className="px-3 py-2.5 font-bold text-[var(--color-text-primary)] sticky left-0 bg-white/[0.03] z-10">
                    Total Cost
                  </td>
                  <td className="text-center py-2.5 font-bold text-lg text-[var(--color-text-primary)]">
                    {formatCost(totals.cost)}
                  </td>
                  {cols.map((col) => (
                    <td key={col.key} className="text-center py-2.5 font-bold text-[var(--color-text-primary)]">
                      {formatCost(col.metrics?.cost) || "—"}
                    </td>
                  ))}
                </tr>
              </tbody>
              </>
              )}

              {/* ─── Evaluator Scores ─── */}
              {hasScores && data && (
                <>
                  <thead>
                    <tr>
                      <td colSpan={cols.length + 2} className="px-3 pt-6 pb-2">
                        <span className="text-sm font-bold text-success-fg uppercase tracking-wider">Evaluator Scores</span>
                      </td>
                    </tr>
                    {columnHeaders("Evaluator", "Avg")}
                  </thead>
                  <tbody className="text-sm">
                    {/* Overall Average row */}
                    <tr className="bg-white/[0.03]">
                      <td className="px-3 py-2.5 font-bold text-[var(--color-text-primary)] sticky left-0 bg-white/[0.03] z-10">
                        Overall Avg
                      </td>
                      <td className="text-center py-2.5">
                        <ScoreChip score={overallTotal()} bold testId="eval-overall-total" />
                      </td>
                      {cols.map((col) => (
                        <td key={col.key} className="text-center py-2.5">
                          <ScoreChip score={overallOf(col)} bold testId={`eval-overall-${col.slug}`} />
                        </td>
                      ))}
                    </tr>
                    {/* Individual evaluator rows */}
                    {data.evaluators.map((ev) => {
                      const evaluator = normalizeEvaluator(ev);
                      const avg = evalTotal(evaluator);
                      return (
                        <tr key={ev} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                          <td className="px-3 py-2 text-[var(--color-text-secondary)] sticky left-0 bg-surface-2 z-10">
                            {evaluator}
                          </td>
                          <td className="text-center py-2">
                            <ScoreChip score={avg} />
                          </td>
                          {cols.map((col) => {
                            const entry = scoreOf(col, evaluator);
                            if (!entry) return <td key={col.key} className="text-center text-[var(--color-text-muted)]">—</td>;
                            const points = col.persona ? undefined : trends[col.agentId]?.[evaluator];
                            return (
                              <td key={col.key} className="text-center py-2">
                                <ScoreChip
                                  score={entry.avg}
                                  title={`${entry.count} scored`}
                                  testId={`eval-score-${col.slug}-${evaluator}`}
                                />
                                {points && points.length > 1 && (
                                  <Sparkline
                                    points={points}
                                    label={`${col.label} · ${evaluator}`}
                                    testId={`eval-sparkline-${col.agentId}-${evaluator}`}
                                  />
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </>
              )}
            </table>
          </div>
          {/* Footer */}
          <div className="px-3 py-2 border-t border-white/[0.06] flex items-center justify-between text-[11px] text-[var(--color-text-muted)]">
            <span>Updated: {data?.lastUpdated ? new Date(data.lastUpdated).toLocaleTimeString() : "—"}</span>
            <span>Scores: <span className="text-success-fg">≥90%</span> · <span className="text-warning-fg">≥75%</span> · <span className="text-danger-fg">&lt;75%</span></span>
          </div>
        </div>
      )}

      {/*
        The table above answers "is the loop running"; this answers "did the
        fixes work". Mounted OUTSIDE the `cols.length > 0` guard and loading its
        own data: the ledger is not per-agent and not windowed, so an empty
        evaluations roster must not hide it.
      */}
      <SiImpactPanel />
    </div>
  );
}

// ─── Ops Metric Row ──────────────────────────────────────────────────────────

function OpsRow({
  label,
  total,
  totalColor,
  cols,
  renderCell,
  cellColor,
}: {
  label: string;
  total: string;
  totalColor?: string;
  cols: Col[];
  renderCell: (col: Col) => string;
  cellColor?: (col: Col) => string | undefined;
}) {
  return (
    <tr className="border-b border-white/[0.04] hover:bg-white/[0.02]">
      <td className="px-3 py-2 text-[var(--color-text-secondary)] sticky left-0 bg-surface-2 z-10">
        {label}
      </td>
      <td className="text-center py-2 font-semibold" style={{ color: totalColor || "var(--color-text-primary)" }}>
        {total}
      </td>
      {cols.map((col) => {
        const value = renderCell(col);
        const color = cellColor?.(col);
        return (
          <td key={col.key} data-testid={`eval-cell-${col.slug}`} className="text-center py-2">
            <span
              style={color ? { color } : { color: value === "—" ? "var(--color-text-muted)" : "var(--color-text-secondary)" }}
            >
              {value}
            </span>
          </td>
        );
      })}
    </tr>
  );
}
