"use client";

/**
 * Fleet performance card — cost / time / quality per run for a window, vs the
 * prior window, with anomaly bands against the trailing 28 days. Self-contained:
 * fetches GET /api/workflow/performance and re-polls every minute.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Gauge, Coins, Clock, CheckCircle2, RefreshCcw, Loader2, TrendingUp, TrendingDown, Minus, Server } from "lucide-react";
import { LineChart, Line, ResponsiveContainer, ReferenceLine, YAxis, Tooltip } from "recharts";
import { formatKpi, type FleetView, type FleetKpi, type BandStatus, type KpiGroup } from "@/lib/workflow/performance";

interface Props {
  onSelectRun?: (workflowId: string) => void;
  defaultDays?: 7 | 14 | 30;
}

const STATUS_STYLE: Record<BandStatus, string> = {
  ok: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  warn: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  alert: "bg-red-500/15 text-red-400 border-red-500/30",
  insufficient: "bg-slate-500/15 text-slate-400 border-slate-500/30",
  unknown: "bg-slate-500/15 text-slate-400 border-slate-500/30",
};
const STATUS_LABEL: Record<BandStatus, string> = {
  ok: "within bands", warn: "warn", alert: "alert", insufficient: "no baseline", unknown: "no data",
};

const GROUPS: { id: KpiGroup; title: string; icon: typeof Coins; primary: string; color: string }[] = [
  { id: "cost", title: "Cost", icon: Coins, primary: "cost.total", color: "#fbbf24" },
  { id: "time", title: "Time", icon: Clock, primary: "time.wall", color: "#60a5fa" },
  { id: "quality", title: "Quality", icon: CheckCircle2, primary: "quality.loops", color: "#34d399" },
];

function StatusChip({ status, small }: { status: BandStatus; small?: boolean }) {
  return (
    <span className={`inline-flex items-center rounded-full border font-medium ${small ? "px-1.5 py-0 text-[10px]" : "px-2 py-0.5 text-xs"} ${STATUS_STYLE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function Delta({ pct, direction = "upper" }: { pct: number | null; direction?: "upper" | "lower" }) {
  if (pct == null) return <span className="text-[10px] text-[var(--color-text-muted)]">no prior</span>;
  const up = pct > 0.02, down = pct < -0.02;
  const worse = direction === "lower" ? down : up;
  const better = direction === "lower" ? up : down;
  const Icon = worse ? TrendingUp : better ? TrendingDown : Minus;
  const cls = worse ? "text-red-400" : better ? "text-emerald-400" : "text-[var(--color-text-muted)]";
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-medium ${cls}`} title="vs prior window (median)">
      <Icon className="w-3 h-3" />{pct > 0 ? "+" : ""}{Math.round(pct * 100)}%
    </span>
  );
}

function KpiTile({ k }: { k: FleetKpi }) {
  return (
    <div className="rounded-lg bg-[var(--color-bg-tertiary)] px-3 py-2" title={k.help}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-[var(--color-text-muted)] truncate">{k.label}</span>
        <StatusChip status={k.status} small />
      </div>
      <div className="mt-0.5 flex items-baseline justify-between gap-2">
        <span className="text-lg font-semibold text-[var(--color-text-primary)] tabular-nums">{formatKpi(k.unit, k.current?.median)}</span>
        <Delta pct={k.deltaPct} direction={k.direction} />
      </div>
      <div className="text-[10px] text-[var(--color-text-muted)] tabular-nums">
        prior {formatKpi(k.unit, k.prior?.median)}
        {k.band ? ` · warn ${k.direction === "lower" ? "<" : ">"} ${formatKpi(k.unit, k.band.warnAbove, true)}` : ""}
      </div>
    </div>
  );
}

function Spark({ k, color }: { k: FleetKpi; color: string }) {
  if (k.series.length < 2) return null;
  const data = k.series.map((p, i) => ({ i, v: p.v, t: p.t, id: p.workflowId }));
  return (
    <div className="h-14">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
          <YAxis hide domain={["auto", "auto"]} />
          {k.band && <ReferenceLine y={k.band.median} stroke="#64748b" strokeDasharray="3 3" />}
          {k.band && <ReferenceLine y={k.band.warnAbove} stroke="#f59e0b" strokeDasharray="2 4" strokeOpacity={0.6} />}
          <Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} dot={{ r: 2 }} isAnimationActive={false} />
          <Tooltip
            cursor={false}
            contentStyle={{ background: "var(--color-bg-secondary)", border: "1px solid var(--color-border)", fontSize: 11, padding: "4px 8px" }}
            labelFormatter={() => ""}
            formatter={(v: number, _n, p) => [formatKpi(k.unit, v), new Date((p.payload as { t: string }).t).toLocaleDateString()]}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function Money({ v }: { v: number | null | undefined }) {
  return <span className="tabular-nums">{formatKpi("usd", v)}</span>;
}

export default function PerformanceCard({ onSelectRun, defaultDays = 7 }: Props) {
  const [days, setDays] = useState<number>(defaultDays);
  const [defId, setDefId] = useState<string>("all");
  const [view, setView] = useState<FleetView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/workflow/performance?days=${days}&defId=${encodeURIComponent(defId)}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setView(json as FleetView);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [days, defId]);

  useEffect(() => {
    setLoading(true);
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const kpisByGroup = useMemo(() => {
    const m: Record<KpiGroup, FleetKpi[]> = { cost: [], time: [], quality: [] };
    for (const k of view?.kpis || []) m[k.group].push(k);
    return m;
  }, [view]);

  // Where the money goes, per run: LLM (personas + CLIs) from the cards, infra
  // allocated from the trailing-30d Cost Explorer snapshot.
  const money = useMemo(() => {
    if (!view || !view.totals.runs) return null;
    const n = view.totals.runs;
    const persona = view.totals.persona / n;
    const coding = view.totals.coding / n;
    const runtime = view.infraPerRun?.runtime ?? 0;
    const other = Math.max(0, (view.infraPerRun?.core ?? 0) - runtime);
    const total = persona + coding + runtime + other;
    const seg = (label: string, v: number, color: string) => ({ label, v, pct: total ? v / total : 0, color });
    return {
      total,
      segments: [
        seg("Persona LLM", persona, "#fbbf24"),
        seg("Coding CLIs", coding, "#f472b6"),
        seg("AgentCore runtime + memory", runtime, "#60a5fa"),
        seg("Other infra (network, CW, ECS…)", other, "#94a3b8"),
      ],
    };
  }, [view]);

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <Gauge className="w-4 h-4 text-sky-400" />
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Performance Card</h2>
          {view && <StatusChip status={view.status} />}
        </div>
        {view && (
          <span className="text-xs text-[var(--color-text-muted)]">
            {view.totals.runs} run{view.totals.runs === 1 ? "" : "s"} · vs {view.priorRuns} prior · <Money v={view.totals.cost} /> total LLM
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div className="flex rounded-md overflow-hidden border border-[var(--color-border)] text-xs">
            {[7, 14, 30].map((d) => (
              <button key={d} onClick={() => setDays(d)}
                className={`px-2.5 py-1 ${days === d ? "bg-sky-600 text-white" : "bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"}`}>
                {d}d
              </button>
            ))}
          </div>
          <select value={defId} onChange={(e) => setDefId(e.target.value)} aria-label="Workflow definition"
            className="text-xs px-2 py-1 rounded-md bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-[var(--color-text-primary)]">
            <option value="all">All workflows</option>
            {(view?.defIds || []).map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <button onClick={() => { setLoading(true); load(); }} title="Refresh" className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCcw className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {error && <div className="px-4 py-3 text-xs text-red-400">{error}</div>}
      {!error && view && view.totals.runs === 0 && (
        <div className="px-4 py-6 text-center text-xs text-[var(--color-text-muted)]">
          No completed runs with cost data in the last {days} days{defId !== "all" ? ` for ${defId}` : ""}.
        </div>
      )}

      {view && view.totals.runs > 0 && (
        <div className="p-4 space-y-4">
          {/* Anomalies */}
          {view.anomalies.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {view.anomalies.map((a) => (
                <span key={a.kpi} className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${STATUS_STYLE[a.status]}`}>
                  {a.label} {a.z != null ? `z=${a.z.toFixed(1)}` : ""}
                </span>
              ))}
            </div>
          )}

          {/* Cost / Time / Quality */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {GROUPS.map((g) => {
              const primary = kpisByGroup[g.id].find((k) => k.key === g.primary);
              return (
                <div key={g.id} className="rounded-lg border border-[var(--color-border)] p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <g.icon className="w-4 h-4" style={{ color: g.color }} />
                    <span className="text-sm font-medium text-[var(--color-text-primary)]">{g.title}</span>
                    <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">median per run</span>
                  </div>
                  {primary && <Spark k={primary} color={g.color} />}
                  <div className="grid grid-cols-2 gap-2">
                    {kpisByGroup[g.id].map((k) => <KpiTile key={k.key} k={k} />)}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Where the money goes + runtime split */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {money && (
              <div className="rounded-lg border border-[var(--color-border)] p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-[var(--color-text-primary)]">Where a run&apos;s money goes</span>
                  <span className="text-xs text-[var(--color-text-muted)]">≈ <Money v={money.total} /> / run all-in</span>
                </div>
                <div className="mt-2 flex h-3 w-full overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]">
                  {money.segments.map((s) => (
                    <div key={s.label} style={{ width: `${s.pct * 100}%`, background: s.color }} title={`${s.label}: ${formatKpi("usd", s.v)}`} />
                  ))}
                </div>
                <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  {money.segments.map((s) => (
                    <li key={s.label} className="flex items-center gap-2 text-[var(--color-text-muted)]">
                      <span className="inline-block w-2 h-2 rounded-sm" style={{ background: s.color }} />
                      <span className="truncate">{s.label}</span>
                      <span className="ml-auto text-[var(--color-text-primary)] tabular-nums">{formatKpi("usd", s.v)} · {Math.round(s.pct * 100)}%</span>
                    </li>
                  ))}
                </ul>
                {!view.infraPerRun && (
                  <p className="mt-2 text-[10px] text-[var(--color-text-muted)]">Infra allocation appears once the Lambda has refreshed its Cost Explorer snapshot.</p>
                )}
              </div>
            )}
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="flex items-center gap-2">
                <Server className="w-4 h-4 text-sky-400" />
                <span className="text-sm font-medium text-[var(--color-text-primary)]">Infrastructure, trailing {view.infra?.windowDays ?? 30}d</span>
                {view.infra?.coreTotal != null && (
                  <span className="ml-auto text-xs text-[var(--color-text-muted)]">core <Money v={view.infra.coreTotal} /> · optional <Money v={view.infra.optionalTotal} /></span>
                )}
              </div>
              {view.infra?.buckets ? (
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  {Object.entries(view.infra.buckets)
                    .filter(([k, v]) => v > 0 && k !== "llm" && k !== "excluded")
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => (
                      <div key={k} className="flex justify-between text-[var(--color-text-muted)]">
                        <span>{BUCKET_LABEL[k] || k}</span><Money v={v} />
                      </div>
                    ))}
                </div>
              ) : (
                <p className="mt-2 text-xs text-[var(--color-text-muted)]">No infra snapshot yet.</p>
              )}
              {view.infra?.runtimes && Object.keys(view.infra.runtimes).length > 0 && (
                <div className="mt-3">
                  <div className="text-[11px] uppercase tracking-wide text-[var(--color-text-muted)]">AgentCore runtime by workload</div>
                  <div className="mt-1 space-y-0.5 text-xs">
                    {Object.entries(view.infra.runtimes).sort((a, b) => b[1].usd - a[1].usd).slice(0, 6).map(([name, r]) => (
                      <div key={name} className="flex justify-between text-[var(--color-text-muted)]">
                        <span className="truncate">{RUNTIME_LABEL(name)}</span>
                        <span className="tabular-nums text-[var(--color-text-primary)]"><Money v={r.usd} /> <span className="text-[var(--color-text-muted)]">· {Math.round(r.gbHours).toLocaleString()} GB·h</span></span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* By agent */}
          {view.agents.length > 0 && (
            <div className="rounded-lg border border-[var(--color-border)] overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-medium">Agent</th>
                    <th className="text-right px-3 py-1.5 font-medium">Cost</th>
                    <th className="text-right px-3 py-1.5 font-medium">Share</th>
                    <th className="text-right px-3 py-1.5 font-medium">Work</th>
                    <th className="text-right px-3 py-1.5 font-medium">Tasks</th>
                    <th className="text-right px-3 py-1.5 font-medium">Rework</th>
                    <th className="text-right px-3 py-1.5 font-medium">$ / task</th>
                  </tr>
                </thead>
                <tbody>
                  {view.agents.slice(0, 10).map((a) => (
                    <tr key={a.agentId} className="border-t border-[var(--color-border)] text-[var(--color-text-primary)]">
                      <td className="px-3 py-1.5 font-mono">{a.agentId.replace(/^agentcore_hub_/, "")}</td>
                      <td className="px-3 py-1.5 text-right"><Money v={a.usd} /></td>
                      <td className="px-3 py-1.5 text-right text-[var(--color-text-muted)] tabular-nums">{view.totals.cost ? Math.round((a.usd / view.totals.cost) * 100) : 0}%</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{formatKpi("ms", a.workMs, true)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{a.tasks}</td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${a.reworkRounds > a.tasks / 2 ? "text-amber-400" : ""}`}>{a.reworkRounds}</td>
                      <td className="px-3 py-1.5 text-right"><Money v={a.usdPerTask} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Runs */}
          <div className="rounded-lg border border-[var(--color-border)] overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">
                <tr>
                  <th className="text-left px-3 py-1.5 font-medium">Completed</th>
                  <th className="text-left px-3 py-1.5 font-medium">Run</th>
                  <th className="text-right px-3 py-1.5 font-medium">Cost</th>
                  <th className="text-right px-3 py-1.5 font-medium">E2E</th>
                  <th className="text-right px-3 py-1.5 font-medium">Active</th>
                  <th className="text-right px-3 py-1.5 font-medium">Work</th>
                  <th className="text-right px-3 py-1.5 font-medium">Tasks</th>
                  <th className="text-right px-3 py-1.5 font-medium">Loops</th>
                  <th className="text-right px-3 py-1.5 font-medium">Rework</th>
                  <th className="text-left px-3 py-1.5 font-medium">Bands</th>
                </tr>
              </thead>
              <tbody>
                {view.runs.slice(0, 25).map((r) => (
                  <tr key={r.workflowId}
                    onClick={onSelectRun ? () => onSelectRun(r.workflowId) : undefined}
                    className={`border-t border-[var(--color-border)] text-[var(--color-text-primary)] ${onSelectRun ? "cursor-pointer hover:bg-[var(--color-bg-tertiary)]" : ""}`}>
                    <td className="px-3 py-1.5 whitespace-nowrap text-[var(--color-text-muted)]">{new Date(r.completedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                    <td className="px-3 py-1.5 max-w-[280px]">
                      <div className="truncate" title={r.title || r.workflowId}>{r.title || r.workflowId}</div>
                      <div className="text-[10px] text-[var(--color-text-muted)]">{r.epicId || ""} · {r.workflowDefId}{r.outcome && r.outcome !== "complete" ? ` · ${r.outcome}` : ""}</div>
                    </td>
                    <td className="px-3 py-1.5 text-right"><Money v={r.cost.total} /></td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatKpi("ms", r.time.wall, true)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatKpi("ms", r.time.active, true)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatKpi("ms", r.time.agentWork, true)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{r.quality.tasks}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{r.quality.loops}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{r.quality.reworkRounds}</td>
                    <td className="px-3 py-1.5"><StatusChip status={r.status} small /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-[10px] text-[var(--color-text-muted)]">
            Medians per run over the window; delta vs the prior {days}d; bands = median ± 2σ/3σ (MAD) over the prior 28d of the same workflow.
            Prices are Bedrock list (src/config/pricing.json). Index updated {view.indexUpdatedAt ? new Date(view.indexUpdatedAt).toLocaleString() : "—"}.
          </p>
        </div>
      )}
    </section>
  );
}

const BUCKET_LABEL: Record<string, string> = {
  runtimeCompute: "AgentCore runtime compute",
  agentMemory: "AgentCore memory",
  network: "NAT / VPC / IPv4",
  storage: "EFS + S3",
  observability: "CloudWatch",
  platform: "ECS, Lambda, DDB, ECR, Secrets",
  evaluations: "Evaluations (optional)",
  ciFleet: "CodeBuild fleet (optional)",
  legacy: "App Runner (legacy)",
};

function RUNTIME_LABEL(name: string): string {
  return name.replace(/^harness_agentcore_hub_/, "harness: ").replace(/^agentcore_hub_/, "").replace(/_/g, " ");
}
