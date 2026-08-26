"use client";

import { useState, useEffect } from "react";
import { ArrowRight } from "lucide-react";
import Link from "next/link";

// ─── Types (mirror /api/jira/metrics) ────────────────────────────────────────

type Timeframe = "day" | "week" | "month" | "year";

interface FlowBucket {
  label: string;
  created: number;
  resolved: number;
  byType: Record<string, number>;
}

interface ThroughputRow {
  type: string;
  count: number;
  e2eMin: number;
  aiMin: number;
  humanMin: number;
}

interface ActivityItem {
  key: string;
  summary: string;
  action: "resolved" | "started" | "in_review" | "queued";
  at: string;
}

interface FlowMetrics {
  ticketsResolved: number;
  ticketsCreated: number;
  ticketsInProgress: number;
  inFlightWorkflows: number;
  avgResolutionTime: number;
  automationRate: number | null;
  throughput: number;
  timeframe: Timeframe;
  buckets: FlowBucket[];
  throughputByType: ThroughputRow[];
  activity: ActivityItem[];
}

// ─── Type → color mapping ────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  SDLC: "#60a5fa",
  "Bug-Fix": "#f87171",
  Marketing: "#f472b6",
  "Dead-Code": "#22d3ee",
  Sales: "#fb923c",
  Legal: "#a78bfa",
  Other: "#64748b",
};
const FALLBACK_COLORS = ["#34d399", "#fbbf24", "#818cf8", "#2dd4bf", "#e879f9"];

function colorForType(type: string, index: number): string {
  return TYPE_COLORS[type] || FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

function formatMinutes(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function relativeTime(iso: string): string {
  const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 60) return "now";
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

const ACTION_STYLES: Record<ActivityItem["action"], { label: string; cls: string }> = {
  resolved: { label: "RESOLVED", cls: "text-success-fg bg-success-subtle border-success-fg/25" },
  started: { label: "STARTED", cls: "text-info-fg bg-info-subtle border-info-fg/25" },
  in_review: { label: "IN REVIEW", cls: "text-warning-fg bg-warning-subtle border-warning-fg/25" },
  queued: { label: "QUEUED", cls: "text-violet-fg bg-violet-subtle border-violet-fg/25" },
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function TicketsFlowPanel() {
  const [timeframe, setTimeframe] = useState<Timeframe>("week");
  const [data, setData] = useState<FlowMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/jira/metrics?timeframe=${timeframe}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d.error) setData(d);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [timeframe]);

  const backlogGap = data ? data.ticketsCreated - data.ticketsResolved : 0;
  const typeOrder = orderedTypes(data);
  const ticketsByType: Record<string, number> = {};
  for (const b of data?.buckets ?? []) {
    for (const [t, n] of Object.entries(b.byType)) ticketsByType[t] = (ticketsByType[t] || 0) + n;
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide">
          Tickets · {process.env.NEXT_PUBLIC_TICKET_PROVIDER === "jira" ? "Jira" : "DynamoDB"}
        </h3>
        <select
          value={timeframe}
          onChange={(e) => setTimeframe(e.target.value as Timeframe)}
          className="text-xs bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-md px-2 py-1 text-[var(--color-text-secondary)] focus:outline-none focus:border-blue-500"
        >
          <option value="day">Today</option>
          <option value="week">This Week</option>
          <option value="month">This Month</option>
          <option value="year">This Year</option>
        </select>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-5">
        <Kpi label="Tickets Resolved"
          value={loading ? "—" : formatCount(data?.ticketsResolved ?? 0)}
          sub={`${formatCount(data?.ticketsInProgress ?? 0)} in progress`} />
        <Kpi label="Throughput"
          value={loading ? "—" : `${formatCount(Math.round(data?.throughput ?? 0))}/day`}
          sub={`avg this ${timeframe}`} />
        <Kpi label="Avg Resolution"
          value={loading ? "—" : formatMinutes(data?.avgResolutionTime ?? 0)}
          sub="per ticket" />
        <Kpi label="Backlog Gap"
          value={loading ? "—" : `${backlogGap > 0 ? "+" : ""}${formatCount(backlogGap)}`}
          sub="created − resolved" />
        <Kpi label="In Flight"
          value={loading ? "—" : formatCount(data?.inFlightWorkflows ?? 0)}
          sub="active workflows" />
        <Kpi label="Automation Rate"
          value={loading ? "—" : data?.automationRate == null ? "n/a" : `${data.automationRate}%`}
          sub="no human touch" />
      </div>

      <div className="border-t border-surface-4 pt-5 grid grid-cols-1 lg:grid-cols-2 gap-x-9 gap-y-7">
        <ResolvedStack buckets={data?.buckets ?? []} types={typeOrder} loading={loading} />
        <CreatedVsResolved buckets={data?.buckets ?? []} loading={loading} />
        <ThroughputLanes rows={data?.throughputByType ?? []} tickets={ticketsByType} loading={loading} />
        <ActivityFeed items={data?.activity ?? []} loading={loading} />
      </div>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-[10px] text-[var(--color-text-muted)] uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold text-[var(--color-text-primary)] mt-0.5">{value}</p>
      {sub && <p className="text-[11px] text-[var(--color-text-secondary)] mt-0.5">{sub}</p>}
    </div>
  );
}

/** Types sorted by total resolved volume so stack order and legend are stable. */
function orderedTypes(data: FlowMetrics | null): string[] {
  if (!data) return [];
  const totals = new Map<string, number>();
  for (const b of data.buckets) {
    for (const [t, n] of Object.entries(b.byType)) totals.set(t, (totals.get(t) || 0) + n);
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between mb-1">
      <p className="text-[11px] text-[var(--color-text-muted)] uppercase tracking-wider">{children}</p>
      {hint && <span className="text-[10.5px] text-[var(--color-text-muted)]">{hint}</span>}
    </div>
  );
}

function EmptyViz({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center h-36 text-[12px] text-[var(--color-text-muted)]">
      {label}
    </div>
  );
}

// ─── ① Resolved per bucket, stacked by workflow type ────────────────────────

function ResolvedStack({ buckets, types, loading }: { buckets: FlowBucket[]; types: string[]; loading: boolean }) {
  const max = Math.max(1, ...buckets.map((b) => b.resolved));
  const peak = buckets.reduce((best, b) => (b.resolved > best.resolved ? b : best), { label: "", resolved: 0 } as FlowBucket);
  // month = 30 slim bars; hide per-bar counts there
  const dense = buckets.length > 14;

  return (
    <div>
      <SectionTitle hint={peak.resolved > 0 ? `peak ${peak.resolved} · ${peak.label}` : undefined}>
        Resolved per {buckets.length === 12 && buckets[0]?.label.includes(":") ? "2h" : buckets.length === 12 ? "month" : "day"}
      </SectionTitle>
      <div className="flex flex-wrap gap-x-3 gap-y-1 mb-3">
        {types.map((t, i) => (
          <span key={t} className="text-[10px] text-[var(--color-text-muted)] flex items-center gap-1.5">
            <i className="inline-block w-2 h-2 rounded-[3px]" style={{ background: colorForType(t, i) }} />
            {t}
          </span>
        ))}
      </div>
      {loading ? <EmptyViz label="Loading…" /> : buckets.every((b) => b.resolved === 0) ? (
        <EmptyViz label="Nothing resolved in this window" />
      ) : (
        <>
          <div className="flex items-end h-32" style={{ gap: dense ? 2 : 8 }}>
            {buckets.map((b) => (
              <div key={b.label} className="flex-1 relative flex flex-col-reverse rounded-t overflow-hidden"
                style={{ height: `${(b.resolved / max) * 100}%`, minHeight: b.resolved > 0 ? 3 : 0 }}
                title={`${b.label}: ${b.resolved} resolved`}>
                {!dense && b.resolved > 0 && (
                  <span className="absolute -top-4 w-full text-center text-[9px] text-[var(--color-text-muted)]">{b.resolved}</span>
                )}
                {types.map((t, i) =>
                  b.byType[t] ? (
                    <div key={t} style={{ height: `${(b.byType[t] / b.resolved) * 100}%`, background: colorForType(t, i), opacity: 0.85 }} />
                  ) : null
                )}
              </div>
            ))}
          </div>
          <div className="flex mt-1.5" style={{ gap: dense ? 2 : 8 }}>
            {buckets.map((b, i) => (
              <span key={b.label} className={`flex-1 text-center text-[9px] ${b.label === "Today" ? "text-[var(--color-text-secondary)] font-semibold" : "text-[var(--color-text-muted)]"}`}>
                {dense ? (i % 5 === 0 ? b.label : "") : b.label}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── ② Created vs resolved (cumulative) ──────────────────────────────────────

function CreatedVsResolved({ buckets, loading }: { buckets: FlowBucket[]; loading: boolean }) {
  const W = 560, H = 150, PAD_L = 34, PAD_R = 40, PAD_T = 12, PAD_B = 22;

  let cumC = 0, cumR = 0;
  const pts = buckets.map((b) => {
    cumC += b.created;
    cumR += b.resolved;
    return { label: b.label, created: cumC, resolved: cumR };
  });
  const maxY = Math.max(1, cumC, cumR);
  const x = (i: number) => PAD_L + (i / Math.max(1, pts.length - 1)) * (W - PAD_L - PAD_R);
  const y = (v: number) => PAD_T + (1 - v / maxY) * (H - PAD_T - PAD_B);
  const path = (get: (p: { created: number; resolved: number }) => number) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(get(p)).toFixed(1)}`).join(" ");
  const gap = cumC - cumR;

  return (
    <div>
      <SectionTitle hint={pts.length > 0 ? `backlog ${gap > 0 ? "+" : ""}${gap}` : undefined}>
        Created vs resolved
      </SectionTitle>
      <div className="flex gap-4 mb-2">
        <span className="text-[10px] text-[var(--color-text-muted)] flex items-center gap-1.5">
          <i className="inline-block w-3.5 h-[3px] rounded bg-success-fg" /> resolved (cumulative)
        </span>
        <span className="text-[10px] text-[var(--color-text-muted)] flex items-center gap-1.5">
          <i className="inline-block w-3.5 border-t-2 border-dashed border-violet-fg" /> created
        </span>
      </div>
      {loading ? <EmptyViz label="Loading…" /> : cumC === 0 && cumR === 0 ? (
        <EmptyViz label="No ticket flow in this window" />
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
          <defs>
            <linearGradient id="tf-green" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#34d399" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#34d399" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={PAD_L} x2={W - PAD_R} y1={y(maxY * f)} y2={y(maxY * f)} stroke="var(--color-border)" strokeWidth="1" />
              <text x={PAD_L - 5} y={y(maxY * f) + 3} fill="var(--color-text-muted)" fontSize="9" textAnchor="end">
                {Math.round(maxY * f)}
              </text>
            </g>
          ))}
          <path d={`${path((p) => p.resolved)} L${x(pts.length - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill="url(#tf-green)" />
          <path d={path((p) => p.resolved)} fill="none" stroke="#34d399" strokeWidth="2.5" />
          <path d={path((p) => p.created)} fill="none" stroke="#a78bfa" strokeWidth="2" strokeDasharray="5 4" opacity="0.85" />
          <circle cx={x(pts.length - 1)} cy={y(cumR)} r="3.5" fill="#34d399" />
          <text x={x(pts.length - 1) + 7} y={y(cumR) + 3} fill="#34d399" fontSize="10" fontWeight="600">{cumR}</text>
          <text x={x(pts.length - 1) + 7} y={y(cumC) + 3} fill="#a78bfa" fontSize="10">{cumC}</text>
          {pts.map((p, i) =>
            (pts.length <= 14 || i % 5 === 0) ? (
              <text key={i} x={x(i)} y={H - 6} fill="var(--color-text-muted)" fontSize="9" textAnchor="middle">{p.label}</text>
            ) : null
          )}
        </svg>
      )}
    </div>
  );
}

// ─── ③ Workflow throughput: e2e per workflow, AI vs human split ──────────────

const HUMAN_COLOR = "#f59e0b";

function ThroughputLanes({ rows, tickets, loading }: {
  rows: ThroughputRow[];
  /** tickets resolved per type in the window (summed from the flow buckets) */
  tickets: Record<string, number>;
  loading: boolean;
}) {
  const shown = rows.slice(0, 5);
  return (
    <div>
      <SectionTitle hint="median e2e, completed workflows">Where the time goes · AI vs human</SectionTitle>
      <div className="flex gap-4 mb-2">
        <span className="text-[10px] text-[var(--color-text-muted)]">bar = 100% of workflow time · type color = AI working</span>
        <span className="text-[10px] text-[var(--color-text-muted)] flex items-center gap-1.5">
          <i className="inline-block w-2.5 h-2.5 rounded-[3px]" style={{ background: HUMAN_COLOR }} /> waiting on human
        </span>
      </div>
      {loading ? <EmptyViz label="Loading…" /> : shown.length === 0 ? (
        <EmptyViz label="No workflows completed in this window" />
      ) : (
        <div>
          {shown.map((r, i) => {
            const aiPct = r.e2eMin > 0 ? Math.round((r.aiMin / r.e2eMin) * 100) : 100;
            const typeColor = colorForType(r.type, i);
            const nTickets = tickets[r.type] || 0;
            const minPerTicket = nTickets > 0 ? Math.round((r.e2eMin * r.count) / nTickets) : 0;
            return (
              <div key={r.type} className={`py-2.5 ${i > 0 ? "border-t border-surface-4/60" : ""}`}>
                <div className="flex items-baseline justify-between mb-1.5">
                  <span className="text-[11.5px] text-[var(--color-text-secondary)] flex items-center gap-2">
                    <i className="inline-block w-2 h-2 rounded-[3px] flex-shrink-0" style={{ background: typeColor }} />
                    {r.type}
                    <span className="text-[10px] text-[var(--color-text-muted)]">
                      {r.count} wf · {formatCount(nTickets)} tickets{minPerTicket > 0 ? ` · ~${formatMinutes(minPerTicket)}/ticket` : ""}
                    </span>
                  </span>
                  <span className="text-[15px] font-bold" style={{ color: aiPct >= 90 ? "var(--color-text-primary)" : HUMAN_COLOR }}>
                    {aiPct}%<span className="text-[10px] font-medium text-[var(--color-text-muted)] ml-1">AI</span>
                  </span>
                </div>
                <div className="h-[20px] rounded-md flex overflow-hidden bg-surface-3"
                  title={`AI ${formatMinutes(r.aiMin)} · human ${formatMinutes(r.humanMin)} · ${formatMinutes(r.e2eMin)} e2e`}>
                  <div className="h-full flex items-center px-2 min-w-0" style={{ width: `${aiPct}%`, background: typeColor, opacity: 0.85 }}>
                    <span className="text-[9.5px] font-semibold text-black/70 whitespace-nowrap overflow-hidden">
                      AI · {formatMinutes(r.aiMin)}
                    </span>
                  </div>
                  {r.humanMin > 0 && (
                    <div className="h-full flex items-center justify-end px-2 min-w-0" style={{ width: `${100 - aiPct}%`, background: HUMAN_COLOR }}>
                      <span className="text-[9.5px] font-semibold text-black/70 whitespace-nowrap overflow-hidden">
                        {formatMinutes(r.humanMin)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── ④ Live activity feed ────────────────────────────────────────────────────

function ActivityFeed({ items, loading }: { items: ActivityItem[]; loading: boolean }) {
  return (
    <div>
      <SectionTitle>Live activity</SectionTitle>
      {loading ? <EmptyViz label="Loading…" /> : items.length === 0 ? (
        <EmptyViz label="No recent ticket activity" />
      ) : (
        <div className="mt-2">
          {items.slice(0, 7).map((it) => {
            const style = ACTION_STYLES[it.action];
            return (
              <div key={`${it.key}-${it.at}`} className="grid grid-cols-[38px_84px_90px_1fr] gap-2.5 items-center px-2 py-[7px] rounded-lg hover:bg-surface-3/40 text-[12px]">
                <span className="text-[10.5px] text-[var(--color-text-muted)] tabular-nums">{relativeTime(it.at)}</span>
                <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full border text-center ${style.cls}`}>{style.label}</span>
                <span className="text-[10.5px] font-mono text-[var(--color-text-muted)] truncate">{it.key}</span>
                <span className="text-[var(--color-text-secondary)] truncate" title={it.summary}>{it.summary}</span>
              </div>
            );
          })}
          <Link href="/workflow" className="inline-flex items-center gap-1 text-[11px] text-brand-400 hover:text-brand-300 mt-2 px-2">
            View board <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      )}
    </div>
  );
}
