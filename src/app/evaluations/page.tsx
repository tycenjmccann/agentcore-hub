"use client";

import { useState, useEffect, useCallback } from "react";
import { BarChart3, Loader2, RefreshCw, ExternalLink, Settings } from "lucide-react";
import Link from "next/link";
import agentsConfig from "@/config/agents.json";

// Map agent display names → agent IDs for API calls
const AGENT_ID_MAP = new Map<string, string>(
  agentsConfig.agents.map((a) => [a.displayName, a.agentId])
);

interface ScorecardEntry {
  avg: number;
  count: number;
  passing: number;
}

interface ModelCost {
  model: string;
  input: number;
  output: number;
  cost: number;
}

interface AgentMetrics {
  sessions: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  costPerSession: number;
  models?: ModelCost[];
}

interface EvalData {
  agents: string[];
  scorecard: Record<string, Record<string, ScorecardEntry>>;
  metrics: Record<string, AgentMetrics>;
  evaluators: string[];
  lastUpdated: string;
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

function scoreColor(score: number): string {
  if (score >= 0.9) return "#22c55e";
  if (score >= 0.75) return "#f59e0b";
  return "#ef4444";
}

function scoreBg(score: number): string {
  if (score >= 0.9) return "rgba(34,197,94,0.12)";
  if (score >= 0.75) return "rgba(245,158,11,0.12)";
  return "rgba(239,68,68,0.12)";
}

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
  if (modelId.includes("opus-4-6") || modelId.includes("opus-4-7")) return "Opus";
  if (modelId.includes("sonnet-4-6") || modelId.includes("sonnet-4-5")) return "Sonnet";
  if (modelId.includes("haiku")) return "Haiku";
  return modelId.split(".").pop()?.split("-")[0] || modelId;
}

// Client-side cache key for sessionStorage
const EVAL_CACHE_KEY = "agentcore-hub-eval-cache";
const EVAL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedData(): EvalData | null {
  try {
    const raw = sessionStorage.getItem(EVAL_CACHE_KEY);
    if (!raw) return null;
    const { data, timestamp } = JSON.parse(raw);
    if (Date.now() - timestamp > EVAL_CACHE_TTL) return null;
    return data;
  } catch { return null; }
}

function setCachedData(data: EvalData) {
  try {
    sessionStorage.setItem(EVAL_CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
  } catch {}
}

export default function EvaluationsPage() {
  const [data, setData] = useState<EvalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [agentEnabled, setAgentEnabled] = useState<Record<string, boolean>>({});
  const [agentToggling, setAgentToggling] = useState<Record<string, boolean>>({});

  const fetchData = useCallback(async () => {
    setLoading((prev) => prev); // keep current loading state
    try {
      const res = await fetch("/api/evaluations");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const newData = await res.json();
      setData(newData);
      setCachedData(newData);
      setError("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);


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

  const toggleAgent = async (agentName: string) => {
    const agentId = AGENT_ID_MAP.get(agentName);
    if (!agentId) return;
    const current = agentEnabled[agentId];
    if (current === undefined) return;
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
    const cached = getCachedData();
    if (cached) { setData(cached); setLoading(false); }
    fetchData();
    fetchAgentConfigs();
  }, [fetchData, fetchAgentConfigs]);

  // One column per REAL deployed runtime, not per persona. Personas sharing a
  // runtimeArn collapse to a single column labeled by the "anchor" persona —
  // the one whose agentId is embedded in the ARN (that's the runtime's actual
  // name and where token-aggregator/eval-packager attribute data). So 1-runtime
  // mode shows 1 column, 4-runtime shows 4, 14-runtime shows 14.
  //
  // The checked-in agents.json ships runtimeArn: null by contract — those values
  // are only populated post-deploy (in the S3 copy the Lambdas read, or in a
  // bundle rebuilt after deploy-topology). When no runtimeArn is present we fall
  // back to the API's agent list, which is already real: /api/evaluations only
  // returns personas that have a DynamoDB eval-config row, so this is NOT the old
  // "14 fictional personas" fallback.
  const runtimeCols = (() => {
    const seen = new Set<string>();
    const cols: string[] = [];
    for (const a of agentsConfig.agents) {
      const arn = a.runtimeArn as string | null;
      if (!a.evaluationsEnabled || !arn || seen.has(arn)) continue;
      seen.add(arn);
      const anchor = agentsConfig.agents.find((p) => arn.includes(p.agentId)) ?? a;
      cols.push(anchor.displayName);
    }
    return cols;
  })();
  const agents = runtimeCols.length ? runtimeCols : (data?.agents ?? []);
  const hasScores = !!(data?.scorecard && Object.keys(data.scorecard).length > 0);

  // Compute totals for operational metrics
  const totals = {
    sessions: agents.reduce((s, a) => s + (data?.metrics[a]?.sessions || 0), 0),
    tokensIn: agents.reduce((s, a) => s + (data?.metrics[a]?.tokensIn || 0), 0),
    tokensOut: agents.reduce((s, a) => s + (data?.metrics[a]?.tokensOut || 0), 0),
    cost: agents.reduce((s, a) => s + (data?.metrics[a]?.cost || 0), 0),
    costPerSession: 0,
  };
  totals.costPerSession = totals.sessions > 0 ? totals.cost / totals.sessions : 0;

  // Compute per-model totals across all agents
  const modelTotals: Record<string, number> = {};
  if (data) {
    for (const agent of agents) {
      for (const m of data.metrics[agent]?.models || []) {
        modelTotals[m.model] = (modelTotals[m.model] || 0) + m.cost;
      }
    }
  }
  const usedModels = Object.keys(modelTotals).sort();

  // Compute overall average per evaluator (across all agents that have scores)
  function evalTotal(ev: string): number | null {
    if (!data) return null;
    let sum = 0;
    let count = 0;
    for (const agent of agents) {
      const entry = data.scorecard[agent]?.[`Builtin.${ev}`] || data.scorecard[agent]?.[ev];
      if (entry) { sum += entry.avg; count++; }
    }
    return count > 0 ? sum / count : null;
  }

  function overallTotal(): number | null {
    if (!data) return null;
    let sum = 0;
    let count = 0;
    for (const agent of agents) {
      const agentScores = data.scorecard[agent];
      if (!agentScores || Object.keys(agentScores).length === 0) continue;
      const entries = Object.values(agentScores);
      const overall = entries.reduce((s, e) => s + e.avg, 0) / entries.length;
      sum += overall;
      count++;
    }
    return count > 0 ? sum / count : null;
  }

  // Shared column header for both tables
  const columnHeaders = (
    <tr className="border-b border-white/[0.06]">
      <th className="text-left px-3 py-3 text-xs text-[var(--color-text-muted)] font-medium sticky left-0 bg-surface-2 z-10 w-[160px] min-w-[160px]">
        Metric
      </th>
      <th className="text-center px-2 py-3 text-xs font-bold text-[var(--color-text-primary)] w-[65px] min-w-[65px]">
        Total
      </th>
      {agents.map((agent) => (
        <th
          key={agent}
          className="text-center px-2 py-3 font-bold w-[140px]"
          style={{ color: AGENT_COLORS[agent] || "#94a3b8" }}
        >
          <span className="block text-[11px] leading-snug">
            {agent}
          </span>
        </th>
      ))}
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
          <p className="text-[11px] font-semibold text-blue-400 uppercase tracking-[0.15em] mt-1.5">
            {agents.length} {agents.length === 1 ? "agent" : "agents"} &nbsp;·&nbsp; {(data?.evaluators?.length ?? 0)} evaluators &nbsp;·&nbsp; Opus 4.7 judge &nbsp;·&nbsp; 100% sampling &nbsp;·&nbsp; last 7 days
          </p>
        </div>
        <div className="flex items-center gap-2">
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
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-400 text-xs">
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-5 h-5 animate-spin text-brand-400" />
        </div>
      )}

      {agents.length > 0 && (
        <div className="bg-surface-2 border border-surface-4 rounded-xl overflow-hidden w-fit max-w-full">
          <div className="overflow-x-auto">
            <table style={{ tableLayout: "fixed", width: "max-content" }}>
              <colgroup>
                <col style={{ width: "160px", minWidth: "160px" }} />
                <col style={{ width: "65px", minWidth: "65px" }} />
              </colgroup>

              {/* ─── Self-Improvement Loop ─── */}
              <thead>
                <tr>
                  <td colSpan={agents.length + 2} className="px-3 pt-4 pb-2">
                    <span className="text-sm font-bold text-emerald-400 uppercase tracking-wider">Self-Improvement Loop</span>
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
                  {agents.map((agent) => {
                    const agentId = AGENT_ID_MAP.get(agent) || "";
                    const enabled = agentEnabled[agentId];
                    const toggling = agentToggling[agentId];
                    return (
                      <td key={agent} className="text-center py-3">
                        <button
                          onClick={() => toggleAgent(agent)}
                          disabled={toggling || enabled === undefined}
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
                  <td colSpan={agents.length + 2} className="px-3 pt-6 pb-2">
                    <span className="text-sm font-bold text-blue-400 uppercase tracking-wider">Operational Metrics</span>
                  </td>
                </tr>
                {columnHeaders}
              </thead>
              <tbody className="text-sm">
                <OpsRow
                  label="Sessions"
                  total={String(totals.sessions || "—")}
                  agents={agents}
                  renderCell={(agent) => {
                    const v = data.metrics[agent]?.sessions;
                    return v ? String(v) : "—";
                  }}
                />
                <OpsRow
                  label="Cost / Session"
                  total={formatCost(totals.costPerSession)}
                  totalColor="#3b82f6"
                  agents={agents}
                  renderCell={(agent) => formatCost(data.metrics[agent]?.costPerSession)}
                  cellColor={(agent) => {
                    const v = data.metrics[agent]?.costPerSession;
                    if (!v) return undefined;
                    return "#3b82f6";
                  }}
                />
                <OpsRow
                  label="Tokens In"
                  total={formatTokens(totals.tokensIn)}
                  agents={agents}
                  renderCell={(agent) => formatTokens(data.metrics[agent]?.tokensIn)}
                />
                <OpsRow
                  label="Tokens Out"
                  total={formatTokens(totals.tokensOut)}
                  agents={agents}
                  renderCell={(agent) => formatTokens(data.metrics[agent]?.tokensOut)}
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
                    {agents.map((agent) => {
                      const modelEntry = data.metrics[agent]?.models?.find((m) => m.model === model);
                      return (
                        <td key={agent} className="text-center py-2 text-[var(--color-text-secondary)]">
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
                  {agents.map((agent) => {
                    const v = data.metrics[agent]?.cost;
                    return (
                      <td key={agent} className="text-center py-2.5 font-bold text-[var(--color-text-primary)]">
                        {formatCost(v) || "—"}
                      </td>
                    );
                  })}
                </tr>
              </tbody>
              </>
              )}

              {/* ─── Evaluator Scores ─── */}
              {hasScores && (
                <>
                  <thead>
                    <tr>
                      <td colSpan={agents.length + 2} className="px-3 pt-6 pb-2">
                        <span className="text-sm font-bold text-emerald-400 uppercase tracking-wider">Evaluator Scores</span>
                      </td>
                    </tr>
                    <tr className="border-b border-white/[0.06]">
                      <th className="text-left px-3 py-3 text-xs text-[var(--color-text-muted)] font-medium sticky left-0 bg-surface-2 z-10 w-[160px] min-w-[160px]">
                        Evaluator
                      </th>
                      <th className="text-center px-2 py-3 text-xs font-bold text-[var(--color-text-primary)] w-[65px] min-w-[65px]">
                        Avg
                      </th>
                      {agents.map((agent) => (
                        <th
                          key={agent}
                          className="text-center px-2 py-3 font-bold w-[140px]"
                          style={{ color: AGENT_COLORS[agent] || "#94a3b8" }}
                        >
                          <span className="block text-[11px] leading-snug">
                            {agent}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="text-sm">
                    {/* Overall Average row */}
                    <tr className="bg-white/[0.03]">
                      <td className="px-3 py-2.5 font-bold text-[var(--color-text-primary)] sticky left-0 bg-white/[0.03] z-10">
                        Overall Avg
                      </td>
                      <td className="text-center py-2.5">
                        {(() => {
                          const avg = overallTotal();
                          if (avg === null) return <span className="text-[var(--color-text-muted)]">—</span>;
                          const pct = Math.round(avg * 100);
                          return (
                            <span className="inline-block px-2 py-0.5 rounded font-bold" style={{ color: scoreColor(avg), backgroundColor: scoreBg(avg) }}>
                              {pct}%
                            </span>
                          );
                        })()}
                      </td>
                      {agents.map((agent) => {
                        const agentScores = data.scorecard[agent];
                        if (!agentScores || Object.keys(agentScores).length === 0) {
                          return <td key={agent} className="text-center text-[var(--color-text-muted)]">—</td>;
                        }
                        const entries = Object.values(agentScores);
                        const overall = entries.reduce((s, e) => s + e.avg, 0) / entries.length;
                        const pct = Math.round(overall * 100);
                        return (
                          <td key={agent} className="text-center py-2.5">
                            <span
                              className="inline-block px-2 py-0.5 rounded font-bold"
                              style={{ color: scoreColor(overall), backgroundColor: scoreBg(overall) }}
                            >
                              {pct}%
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                    {/* Individual evaluator rows */}
                    {data.evaluators.map((ev) => {
                      const avg = evalTotal(ev);
                      return (
                        <tr key={ev} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                          <td className="px-3 py-2 text-[var(--color-text-secondary)] sticky left-0 bg-surface-2 z-10">
                            {ev}
                          </td>
                          <td className="text-center py-2">
                            {avg !== null ? (
                              <span
                                className="inline-block px-2 py-0.5 rounded font-medium"
                                style={{ color: scoreColor(avg), backgroundColor: scoreBg(avg) }}
                              >
                                {Math.round(avg * 100)}%
                              </span>
                            ) : (
                              <span className="text-[var(--color-text-muted)]">—</span>
                            )}
                          </td>
                          {agents.map((agent) => {
                            const entry = data.scorecard[agent]?.[`Builtin.${ev}`] || data.scorecard[agent]?.[ev];
                            if (!entry) return <td key={agent} className="text-center text-[var(--color-text-muted)]">—</td>;
                            const pct = Math.round(entry.avg * 100);
                            return (
                              <td key={agent} className="text-center py-2">
                                <span
                                  className="inline-block px-2 py-0.5 rounded font-medium"
                                  style={{ color: scoreColor(entry.avg), backgroundColor: scoreBg(entry.avg) }}
                                >
                                  {pct}%
                                </span>
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
            <span>Scores: <span className="text-emerald-400">≥90%</span> · <span className="text-amber-400">≥75%</span> · <span className="text-red-400">&lt;75%</span></span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Ops Metric Row ──────────────────────────────────────────────────────────

function OpsRow({
  label,
  total,
  totalColor,
  agents,
  renderCell,
  cellColor,
}: {
  label: string;
  total: string;
  totalColor?: string;
  agents: string[];
  renderCell: (agent: string) => string;
  cellColor?: (agent: string) => string | undefined;
}) {
  return (
    <tr className="border-b border-white/[0.04] hover:bg-white/[0.02]">
      <td className="px-3 py-2 text-[var(--color-text-secondary)] sticky left-0 bg-surface-2 z-10">
        {label}
      </td>
      <td className="text-center py-2 font-semibold" style={{ color: totalColor || "var(--color-text-primary)" }}>
        {total}
      </td>
      {agents.map((agent) => {
        const value = renderCell(agent);
        const color = cellColor?.(agent);
        return (
          <td key={agent} className="text-center py-2">
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
