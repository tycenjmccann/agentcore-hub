"use client";

/**
 * Workflow Manager analysis panel — shown on terminal (complete/cancelled/error)
 * runs. Self-contained: fetches GET /api/workflow/[id]/analysis, renders the
 * latest analysis (verdict, scores, metric cards, findings, recommendations,
 * def-level trend), and can trigger POST /api/workflow/[id]/analyze.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ClipboardCheck,
  ChevronDown,
  ChevronRight,
  Clock,
  UserCheck,
  RefreshCcw,
  Wrench,
  Coins,
  Loader2,
  MessageSquare,
} from "lucide-react";
import {
  LineChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  YAxis,
} from "recharts";
import { MarkdownRenderer } from "./MarkdownRenderer";
import type {
  AnalysisResponse,
  WorkflowAnalysis,
  AnalysisFinding,
  AnalysisRecommendation,
} from "@/lib/workflow/analysis-types";

interface Props {
  workflowId: string;
  /** Called when the user clicks "Ask about this run" — opens the chat drawer. */
  onAskAboutRun?: (workflowId: string) => void;
}

const POLL_MS = 10_000;
const POLL_TIMEOUT_MS = 10 * 60_000;

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function scoreColor(score: number | null | undefined): string {
  if (score == null) return "#71717a";
  if (score >= 80) return "#22c55e";
  if (score >= 60) return "#eab308";
  return "#ef4444";
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#3b82f6",
};

const KIND_BADGE: Record<string, { label: string; color: string }> = {
  bottleneck: { label: "Bottleneck", color: "#f97316" },
  failure: { label: "Failure", color: "#ef4444" },
  success: { label: "What worked", color: "#22c55e" },
  risk: { label: "Risk", color: "#eab308" },
};

const PRIORITY_COLOR: Record<string, string> = { P0: "#ef4444", P1: "#f97316", P2: "#3b82f6" };

export default function WorkflowManagerPanel({ workflowId, onAskAboutRun }: Props) {
  const [data, setData] = useState<AnalysisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [showReport, setShowReport] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const pollUntilRef = useRef(0);
  const baselineIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/workflow/${workflowId}/analysis`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: AnalysisResponse = await res.json();
      setData(json);
      setError(null);
      // Stop polling once a new analysis appears.
      if (analyzing && json.latest && json.latest.analysisId !== baselineIdRef.current) {
        setAnalyzing(false);
      }
      return json;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load analysis");
      return null;
    } finally {
      setLoading(false);
    }
  }, [workflowId, analyzing]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [workflowId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll while an analysis is running.
  useEffect(() => {
    if (!analyzing) return;
    const t = setInterval(() => {
      if (Date.now() > pollUntilRef.current) {
        setAnalyzing(false);
        return;
      }
      load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [analyzing, load]);

  const runAnalysis = useCallback(async () => {
    baselineIdRef.current = data?.latest?.analysisId ?? null;
    pollUntilRef.current = Date.now() + POLL_TIMEOUT_MS;
    setAnalyzing(true);
    setError(null);
    try {
      const res = await fetch(`/api/workflow/${workflowId}/analyze`, { method: "POST" });
      if (!res.ok && res.status !== 202) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      setAnalyzing(false);
      setError(err instanceof Error ? err.message : "Failed to start analysis");
    }
  }, [workflowId, data]);

  const selected: WorkflowAnalysis | null =
    (selectedId && data?.history.find((h) => h.analysisId === selectedId)) ||
    data?.latest ||
    null;

  return (
    <div className="wm-panel">
      <style>{PANEL_STYLES}</style>

      <button className="wm-header" onClick={() => setExpanded((e) => !e)}>
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <ClipboardCheck size={16} className="wm-header-icon" />
        <span className="wm-title">Workflow Manager</span>
        {selected && (
          <span className="wm-score-chip" style={{ color: scoreColor(selected.scores?.overall) }}>
            {selected.scores?.overall ?? "—"}
          </span>
        )}
        <span className="wm-header-spacer" />
        {onAskAboutRun && (
          <span
            className="wm-ask-btn"
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onAskAboutRun(workflowId); }}
          >
            <MessageSquare size={13} /> Ask about this run
          </span>
        )}
      </button>

      {expanded && (
        <div className="wm-body">
          {loading ? (
            <div className="wm-empty"><Loader2 size={16} className="wm-spin" /> Loading analysis…</div>
          ) : !selected ? (
            <div className="wm-empty-state">
              <p>No analysis yet for this run.</p>
              <button className="wm-run-btn" onClick={runAnalysis} disabled={analyzing}>
                {analyzing ? <><Loader2 size={14} className="wm-spin" /> Analyzing…</> : "Run Analysis"}
              </button>
              {error && <p className="wm-error">{error}</p>}
            </div>
          ) : (
            <>
              <div className="wm-verdict-row">
                <div
                  className="wm-overall"
                  style={{ borderColor: scoreColor(selected.scores?.overall), color: scoreColor(selected.scores?.overall) }}
                >
                  {selected.scores?.overall ?? "—"}
                </div>
                <div className="wm-verdict">
                  <p className="wm-verdict-text">{selected.verdict}</p>
                  <p className="wm-verdict-meta">
                    {selected.runOutcome} · {selected.trigger} ·{" "}
                    {new Date(selected.analyzedAt).toLocaleString()}
                  </p>
                </div>
                <div className="wm-actions">
                  <button className="wm-icon-btn" onClick={runAnalysis} disabled={analyzing} title="Re-run analysis">
                    {analyzing ? <Loader2 size={14} className="wm-spin" /> : <RefreshCcw size={14} />}
                  </button>
                </div>
              </div>

              <MetricCards analysis={selected} />
              <SubScores scores={selected.scores} />
              <Findings findings={selected.findings} />
              <Recommendations recommendations={selected.recommendations} />
              <Trend data={data} analysis={selected} />

              {selected.summaryMarkdown && (
                <div className="wm-report">
                  <button className="wm-report-toggle" onClick={() => setShowReport((s) => !s)}>
                    {showReport ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Full report
                  </button>
                  {showReport && (
                    <div className="wm-report-body">
                      <MarkdownRenderer content={selected.summaryMarkdown} />
                    </div>
                  )}
                </div>
              )}

              {data && data.history.length > 1 && (
                <div className="wm-history">
                  <label>Prior analyses of this run:</label>
                  <select
                    value={selected.analysisId}
                    onChange={(e) => setSelectedId(e.target.value)}
                  >
                    {data.history.map((h) => (
                      <option key={h.analysisId} value={h.analysisId}>
                        {new Date(h.analyzedAt).toLocaleString()} · {h.trigger} · score {h.scores?.overall ?? "—"}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MetricCards({ analysis }: { analysis: WorkflowAnalysis }) {
  const m = analysis.metrics;
  const cards = [
    { icon: Clock, label: "Duration", value: fmtDuration(m?.totalDurationMs) },
    { icon: UserCheck, label: "Human wait", value: fmtDuration(m?.humanWaitTotalMs) },
    { icon: RefreshCcw, label: "Change requests", value: fmtNumber(m?.changeRequests?.count) },
    { icon: Wrench, label: "Fix cycles", value: fmtNumber(m?.fixTickets?.count) },
    {
      icon: Coins,
      label: "Tokens",
      value: m?.tokens ? fmtNumber(m.tokens.totalInput + m.tokens.totalOutput) : "—",
    },
  ];
  return (
    <div className="wm-cards">
      {cards.map((c) => (
        <div key={c.label} className="wm-card">
          <c.icon size={14} className="wm-card-icon" />
          <div className="wm-card-value">{c.value}</div>
          <div className="wm-card-label">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

function SubScores({ scores }: { scores: WorkflowAnalysis["scores"] }) {
  if (!scores) return null;
  const rows: Array<[string, number]> = [
    ["Planning", scores.planning],
    ["Execution", scores.execution],
    ["Review efficiency", scores.reviewEfficiency],
    ["Rework discipline", scores.reworkDiscipline],
  ];
  return (
    <div className="wm-subscores">
      {rows.map(([label, val]) => (
        <div key={label} className="wm-subscore">
          <span className="wm-subscore-label">{label}</span>
          <div className="wm-bar">
            <div className="wm-bar-fill" style={{ width: `${val}%`, background: scoreColor(val) }} />
          </div>
          <span className="wm-subscore-val">{val}</span>
        </div>
      ))}
    </div>
  );
}

function Findings({ findings }: { findings: AnalysisFinding[] }) {
  if (!findings?.length) return null;
  return (
    <div className="wm-section">
      <h4>Findings</h4>
      {findings.map((f, i) => {
        const badge = KIND_BADGE[f.kind] || { label: f.kind, color: "#71717a" };
        return (
          <div key={i} className="wm-finding" style={{ borderLeftColor: SEVERITY_COLOR[f.severity] || "#71717a" }}>
            <div className="wm-finding-head">
              <span className="wm-kind" style={{ background: `${badge.color}22`, color: badge.color }}>{badge.label}</span>
              <span className="wm-finding-title">{f.title}</span>
              {f.phase && <span className="wm-tag">{f.phase}</span>}
            </div>
            <p className="wm-finding-evidence">{f.evidence}</p>
          </div>
        );
      })}
    </div>
  );
}

function Recommendations({ recommendations }: { recommendations: AnalysisRecommendation[] }) {
  if (!recommendations?.length) return null;
  return (
    <div className="wm-section">
      <h4>Recommendations</h4>
      {recommendations.map((r, i) => (
        <div key={i} className="wm-rec">
          <div className="wm-rec-head">
            <span className="wm-priority" style={{ background: `${PRIORITY_COLOR[r.priority]}22`, color: PRIORITY_COLOR[r.priority] }}>
              {r.priority}
            </span>
            <span className="wm-rec-title">{r.title}</span>
            <span className="wm-tag">{r.type}</span>
          </div>
          <p className="wm-rec-desc">{r.description}</p>
          <p className="wm-rec-impact"><strong>Impact:</strong> {r.expectedImpact}</p>
        </div>
      ))}
    </div>
  );
}

function Trend({ data, analysis }: { data: AnalysisResponse | null; analysis: WorkflowAnalysis }) {
  const points = (data?.trend || [])
    .filter((p) => p.overallScore != null)
    .slice()
    .reverse()
    .map((p) => ({ score: p.overallScore, ts: p.analyzedAt }));
  const t = analysis.trend;
  return (
    <div className="wm-section">
      <h4>Trend</h4>
      {points.length > 1 && (
        <div className="wm-sparkline">
          <ResponsiveContainer width="100%" height={60}>
            <LineChart data={points} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
              <YAxis domain={[0, 100]} hide />
              <Tooltip
                contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 6, fontSize: 11 }}
                labelFormatter={() => ""}
                formatter={(v: number) => [`${v}`, "overall"]}
              />
              <Line type="monotone" dataKey="score" stroke="#0ea5e9" strokeWidth={2} dot={{ r: 2 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      {t && (
        <p className="wm-trend-notes">
          {t.priorRunsCompared > 0
            ? `Compared against ${t.priorRunsCompared} prior run(s). `
            : "First analyzed run for this workflow definition. "}
          {t.notes}
        </p>
      )}
    </div>
  );
}

const PANEL_STYLES = `
.wm-panel{margin:16px 0;border:1px solid var(--pipeline-border,#27272a);border-radius:12px;
  background:var(--pipeline-card,#18181b);overflow:hidden;font-size:13px;color:var(--pipeline-text,#e4e4e7)}
.wm-header{display:flex;align-items:center;gap:8px;width:100%;padding:12px 14px;background:none;border:none;
  cursor:pointer;color:inherit;text-align:left;font-size:13px}
.wm-header:hover{background:rgba(255,255,255,0.02)}
.wm-header-icon{color:#0ea5e9}
.wm-title{font-weight:600}
.wm-score-chip{font-weight:700;font-size:14px;padding:1px 8px;border-radius:6px;background:rgba(255,255,255,0.05)}
.wm-header-spacer{flex:1}
.wm-ask-btn{display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:4px 9px;border-radius:8px;
  border:1px solid rgba(14,165,233,0.4);color:#38bdf8;cursor:pointer}
.wm-ask-btn:hover{background:rgba(14,165,233,0.1)}
.wm-body{padding:0 14px 16px}
.wm-empty,.wm-empty-state{padding:20px;text-align:center;color:var(--pipeline-text-3,#a1a1aa);display:flex;
  flex-direction:column;align-items:center;gap:10px;justify-content:center}
.wm-run-btn{padding:8px 18px;border-radius:8px;border:1px solid rgba(14,165,233,0.5);background:rgba(14,165,233,0.1);
  color:#38bdf8;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
.wm-run-btn:hover:not(:disabled){background:rgba(14,165,233,0.2)}
.wm-run-btn:disabled{opacity:0.6;cursor:default}
.wm-error{color:#f87171;font-size:12px}
.wm-spin{animation:wmspin 1s linear infinite}
@keyframes wmspin{to{transform:rotate(360deg)}}
.wm-verdict-row{display:flex;align-items:center;gap:14px;padding:8px 0 14px}
.wm-overall{flex-shrink:0;width:52px;height:52px;border:2px solid;border-radius:50%;display:flex;
  align-items:center;justify-content:center;font-size:20px;font-weight:800}
.wm-verdict{flex:1}
.wm-verdict-text{margin:0;font-weight:500;line-height:1.4}
.wm-verdict-meta{margin:3px 0 0;font-size:11px;color:var(--pipeline-text-3,#a1a1aa);text-transform:capitalize}
.wm-actions{display:flex;gap:6px}
.wm-icon-btn{width:32px;height:32px;border-radius:8px;border:1px solid var(--pipeline-border,#3f3f46);
  background:none;color:var(--pipeline-text-2,#d4d4d8);cursor:pointer;display:flex;align-items:center;justify-content:center}
.wm-icon-btn:hover:not(:disabled){background:rgba(255,255,255,0.05)}
.wm-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px;margin-bottom:14px}
.wm-card{padding:10px;border:1px solid var(--pipeline-border,#27272a);border-radius:8px;text-align:center;
  background:rgba(255,255,255,0.02)}
.wm-card-icon{color:#0ea5e9;margin-bottom:4px}
.wm-card-value{font-size:16px;font-weight:700}
.wm-card-label{font-size:10px;color:var(--pipeline-text-3,#a1a1aa);margin-top:2px}
.wm-subscores{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
.wm-subscore{display:flex;align-items:center;gap:10px}
.wm-subscore-label{width:120px;font-size:12px;color:var(--pipeline-text-2,#d4d4d8)}
.wm-bar{flex:1;height:6px;border-radius:3px;background:rgba(255,255,255,0.06);overflow:hidden}
.wm-bar-fill{height:100%;border-radius:3px}
.wm-subscore-val{width:28px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums}
.wm-section{margin-bottom:14px}
.wm-section h4{margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.5px;
  color:var(--pipeline-text-3,#a1a1aa)}
.wm-finding{padding:8px 10px;margin-bottom:6px;border-left:3px solid;border-radius:0 6px 6px 0;
  background:rgba(255,255,255,0.02)}
.wm-finding-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wm-kind{font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;text-transform:uppercase}
.wm-finding-title{font-weight:600}
.wm-finding-evidence{margin:5px 0 0;font-size:12px;color:var(--pipeline-text-2,#c4c4c8);line-height:1.4}
.wm-tag{font-size:10px;padding:1px 6px;border-radius:4px;background:rgba(255,255,255,0.06);
  color:var(--pipeline-text-3,#a1a1aa)}
.wm-rec{padding:8px 10px;margin-bottom:6px;border:1px solid var(--pipeline-border,#27272a);border-radius:6px}
.wm-rec-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wm-priority{font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px}
.wm-rec-title{font-weight:600}
.wm-rec-desc{margin:5px 0 0;font-size:12px;color:var(--pipeline-text-2,#c4c4c8);line-height:1.4}
.wm-rec-impact{margin:4px 0 0;font-size:11px;color:var(--pipeline-text-3,#a1a1aa)}
.wm-sparkline{margin-bottom:8px}
.wm-trend-notes{margin:0;font-size:12px;color:var(--pipeline-text-2,#c4c4c8);line-height:1.4}
.wm-report{border-top:1px solid var(--pipeline-border,#27272a);padding-top:10px}
.wm-report-toggle{display:flex;align-items:center;gap:6px;background:none;border:none;color:var(--pipeline-text-2,#d4d4d8);
  cursor:pointer;font-size:12px;font-weight:600;padding:0}
.wm-report-body{margin-top:10px;font-size:13px}
.wm-history{margin-top:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wm-history label{font-size:11px;color:var(--pipeline-text-3,#a1a1aa)}
.wm-history select{background:var(--pipeline-card,#18181b);border:1px solid var(--pipeline-border,#3f3f46);
  border-radius:6px;color:inherit;padding:4px 8px;font-size:12px}
`;
