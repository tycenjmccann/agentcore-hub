"use client";

/**
 * Workflow Manager analysis panel — shown on every terminal run EXCEPT a
 * "complete" one that still has open fix-it tickets. The board owns that rule
 * (showWorkflowManager in WorkflowBoard.tsx) and only offers the hero KPI strip's
 * agent-authored tile, whose click scrolls here, when it mounts this panel.
 *
 * Self-contained: fetches GET /api/workflow/[id]/analysis, renders the latest
 * analysis (verdict, scores, metric cards, findings, recommendations, def-level
 * trend), and can trigger POST /api/workflow/[id]/analyze.
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
import { usePerformanceCard } from "./use-performance-card";
import type {
  AnalysisResponse,
  WorkflowAnalysis,
  AnalysisFinding,
  AnalysisRecommendation,
} from "@/lib/workflow/analysis-types";
import {
  ANALYSIS_POLL_TIMEOUT_MS,
  analysisFailureMessage,
  analysisPollOutcome,
} from "@/lib/workflow/analysis-status";

interface Props {
  workflowId: string;
  /** Called when the user clicks "Ask about this run" — opens the chat drawer. */
  onAskAboutRun?: (workflowId: string) => void;
  /** Bumped by the board on a live workflow.analysis_failed event — reload. */
  failureSignal?: number;
}

const POLL_MS = 10_000;

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

// Theme-aware (globals.css semantic tokens) — light shades are dark enough for
// #fff, dark shades are light enough for --pipeline-card-bg's #1a2332, both
// >= 4.5:1 (TEAM-5246: the flat hex values below were tuned for the dark panel
// background only, e.g. #f87171 on #fff was 2.77:1).
const TONE = {
  danger: "var(--danger-fg,#f87171)",
  warning: "var(--warning-fg,#fbbf24)",
  success: "var(--success-fg,#4ade80)",
  orange: "var(--orange-fg,#fb923c)",
  info: "var(--info-fg,#7dd3fc)",
  neutral: "var(--pipeline-text-secondary,#94a3b8)",
};

/** Badge text colours — panel-scoped (PANEL_STYLES). Dark reuses TONE's tokens;
 * light uses one shade darker than TONE, because the light TONE shades
 * (amber/green/orange ~5.0:1 on #fff) can't sit on any visible tint of their
 * own hue and still clear 4.5:1 (TEAM-5251). */
const BADGE = {
  danger: "var(--wm-badge-danger)",
  warning: "var(--wm-badge-warning)",
  success: "var(--wm-badge-success)",
  orange: "var(--wm-badge-orange)",
  info: "var(--wm-badge-info)",
  neutral: "var(--wm-badge-neutral)",
};

/** Badge/chip tint: 10% of the badge's own colour (the --*-subtle alpha) keeps
 * every BADGE colour >= 4.5:1 on it, layered on `.wm-finding`'s surface, in
 * both themes — worst case dark danger 4.70:1 (TEAM-5251; 5% was barely
 * visible in light, 12% leaves dark danger at 4.56:1). */
const tint = (color: string) => `color-mix(in srgb, ${color} 10%, transparent)`;

function scoreColor(score: number | null | undefined): string {
  if (score == null) return TONE.neutral;
  if (score >= 80) return TONE.success;
  if (score >= 60) return TONE.warning;
  return TONE.danger;
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: TONE.danger,
  high: TONE.orange,
  medium: TONE.warning,
  low: TONE.info,
};

const KIND_BADGE: Record<string, { label: string; color: string }> = {
  bottleneck: { label: "Bottleneck", color: BADGE.orange },
  failure: { label: "Failure", color: BADGE.danger },
  success: { label: "What worked", color: BADGE.success },
  risk: { label: "Risk", color: BADGE.warning },
};

const PRIORITY_COLOR: Record<string, string> = { P0: BADGE.danger, P1: BADGE.orange, P2: BADGE.info };

export default function WorkflowManagerPanel({ workflowId, onAskAboutRun, failureSignal }: Props) {
  const [data, setData] = useState<AnalysisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [showReport, setShowReport] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const pollUntilRef = useRef(0);
  const baselineIdRef = useRef<string | null>(null);
  /** POST /analyze's attemptId; `?attempt=` scopes failures to it (TEAM-5240). */
  const attemptIdRef = useRef<string | null>(null);
  const { card } = usePerformanceCard(workflowId);

  const load = useCallback(async () => {
    try {
      const qs = analyzing && attemptIdRef.current ? `?attempt=${encodeURIComponent(attemptIdRef.current)}` : "";
      const res = await fetch(`/api/workflow/${workflowId}/analysis${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: AnalysisResponse = await res.json();
      setData(json);
      // Stop polling once a new analysis appears — or the analyzer recorded a
      // failure for THIS attempt, or we gave up waiting. Only the last two carry
      // a message; another attempt's failure is not shown while polling.
      if (analyzing) {
        const outcome = analysisPollOutcome({
          baselineId: baselineIdRef.current,
          attemptId: attemptIdRef.current,
          latest: json.latest,
          latestFailure: json.latestFailure,
          now: Date.now(),
          pollUntil: pollUntilRef.current,
        });
        if (outcome.state !== "pending") setAnalyzing(false);
        setError(outcome.message ?? null);
      } else {
        // No poll running: a failure newer than the latest analysis (auto run,
        // or a panel reopened after a failure) is shown as it stands (TEAM-5240).
        setError(json.latestFailure ? analysisFailureMessage(json.latestFailure) : null);
      }
      return json;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load analysis");
      // A GET that keeps failing must not poll forever.
      if (analyzing && Date.now() > pollUntilRef.current) setAnalyzing(false);
      return null;
    } finally {
      setLoading(false);
    }
  }, [workflowId, analyzing]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [workflowId]); // eslint-disable-line react-hooks/exhaustive-deps

  // A live workflow.analysis_failed from the board's event stream.
  useEffect(() => {
    if (failureSignal) load();
  }, [failureSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll while an analysis is running.
  useEffect(() => {
    if (!analyzing) return;
    // load() decides when to stop (analysisPollOutcome), including the timeout,
    // so the timeout gets a message instead of a silent reset.
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [analyzing, load]);

  const runAnalysis = useCallback(async () => {
    baselineIdRef.current = data?.latest?.analysisId ?? null;
    attemptIdRef.current = null;
    pollUntilRef.current = Date.now() + ANALYSIS_POLL_TIMEOUT_MS;
    setAnalyzing(true);
    setError(null);
    try {
      const res = await fetch(`/api/workflow/${workflowId}/analyze`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 202) {
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      attemptIdRef.current = typeof body.attemptId === "string" ? body.attemptId : null;
    } catch (err) {
      setAnalyzing(false);
      setError(err instanceof Error ? err.message : "Failed to start analysis");
    }
  }, [workflowId, data]);

  const selected: WorkflowAnalysis | null =
    (selectedId && data?.history.find((h) => h.analysisId === selectedId)) ||
    data?.latest ||
    null;

  // The deterministic score, next to the agent-authored one. Shares the hero
  // strip's cached card, so this costs no extra request.
  //
  // TEAM-4521 F2 — provenance: `selected` may be an OLDER analysis picked from the
  // history <select> and scored under an older kpi.json rubric, while `card.kpi` is
  // always the CURRENT card. card.kpi.version IS kpi.json's kpiVersion
  // (performance.ts: `version: config.kpiVersion`), so the two are directly
  // comparable — print the number only when they match, and say why not when they
  // don't rather than attributing today's score to an older rubric.
  const kpiVersion = selected?.kpiVersion;
  const cardKpiVersion = card?.kpi?.version;
  const detQuality = card?.kpi?.quality;
  const versionsDiffer =
    typeof kpiVersion === "number" && typeof cardKpiVersion === "number" && cardKpiVersion !== kpiVersion;
  const detChip = versionsDiffer ? (
    <span className="wm-det-chip" data-testid="wm-det-chip" data-kpi-match="false">
      Deterministic score not comparable — card is kpi v{cardKpiVersion}, analysis scored under kpi v{kpiVersion}
    </span>
  ) : typeof kpiVersion === "number" && cardKpiVersion === kpiVersion && detQuality?.score != null ? (
    <span className="wm-det-chip" data-testid="wm-det-chip" data-kpi-match="true">
      Deterministic: {detQuality.score}/100 {detQuality.grade}
    </span>
  ) : null;

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
                  {/* This score is the agent's own judgement. Name it, so it is never
                      read as the deterministic KPI score shown alongside it. */}
                  <p className="wm-verdict-kind">Workflow Manager assessment (agent-authored)</p>
                  <p className="wm-verdict-text">{selected.verdict}</p>
                  <p className="wm-verdict-meta">
                    {selected.runOutcome} · {selected.trigger} ·{" "}
                    {new Date(selected.analyzedAt).toLocaleString()}
                    {detChip}
                  </p>
                </div>
                <div className="wm-actions">
                  <button className="wm-icon-btn" onClick={runAnalysis} disabled={analyzing} title="Re-run analysis">
                    {analyzing ? <Loader2 size={14} className="wm-spin" /> : <RefreshCcw size={14} />}
                  </button>
                </div>
              </div>
              {error && <p className="wm-error">{error}</p>}

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
        const badge = KIND_BADGE[f.kind] || { label: f.kind, color: BADGE.neutral };
        return (
          <div key={i} className="wm-finding" style={{ borderLeftColor: SEVERITY_COLOR[f.severity] || TONE.neutral }}>
            <div className="wm-finding-head">
              <span className="wm-kind" style={{ background: tint(badge.color), color: badge.color }}>{badge.label}</span>
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
            <span
              className="wm-priority"
              style={{ background: tint(PRIORITY_COLOR[r.priority] || BADGE.neutral), color: PRIORITY_COLOR[r.priority] || BADGE.neutral }}
            >
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
/* Panel-scoped theme tokens (TEAM-5251), overridden for light like WorkflowBoard's
   --pl-* vars. --pipeline-text-muted (#64748b) is 3.32:1 on the dark panel, and
   rgba(255,255,255,...) tints vanish on the light one. Every value clears 4.5:1
   (text) / 3:1 (icons, bar fill vs track) on the surface it sits on. */
.wm-panel{--wm-text-muted:#94a3b8;--wm-accent:var(--accent-fg,#38bdf8);
  --wm-surface:rgba(255,255,255,0.02);--wm-hover:rgba(255,255,255,0.05);
  --wm-chip-bg:rgba(255,255,255,0.05);--wm-tag-bg:rgba(255,255,255,0.06);--wm-track:rgba(255,255,255,0.12);
  --wm-badge-danger:var(--danger-fg,#f87171);--wm-badge-warning:var(--warning-fg,#fbbf24);
  --wm-badge-success:var(--success-fg,#4ade80);--wm-badge-orange:var(--orange-fg,#fb923c);
  --wm-badge-info:var(--info-fg,#7dd3fc);--wm-badge-neutral:var(--pipeline-text-secondary,#94a3b8)}
[data-theme="light"] .wm-panel{--wm-text-muted:#586579;
  --wm-surface:rgba(15,23,42,0.03);--wm-hover:rgba(15,23,42,0.05);
  --wm-chip-bg:rgba(15,23,42,0.03);--wm-tag-bg:rgba(15,23,42,0.06);--wm-track:rgba(15,23,42,0.12);
  --wm-badge-danger:#991b1b;--wm-badge-warning:#92400e;--wm-badge-success:#166534;
  --wm-badge-orange:#9a3412;--wm-badge-info:#075985;--wm-badge-neutral:#334155}
.wm-panel{margin:16px 0;border:1px solid var(--pipeline-border,#27272a);border-radius:12px;
  background:var(--pipeline-card-bg,#1a2332);overflow:hidden;font-size:13px;color:var(--pipeline-text,#e4e4e7)}
.wm-header{display:flex;align-items:center;gap:8px;width:100%;padding:12px 14px;background:none;border:none;
  cursor:pointer;color:inherit;text-align:left;font-size:13px}
.wm-header:hover{background:var(--wm-hover)}
.wm-header-icon{color:var(--wm-accent)}
.wm-title{font-weight:600}
.wm-score-chip{font-weight:700;font-size:14px;padding:1px 8px;border-radius:6px;background:var(--wm-chip-bg)}
.wm-header-spacer{flex:1}
.wm-ask-btn{display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:4px 9px;border-radius:8px;
  border:1px solid rgba(14,165,233,0.4);color:var(--info-fg,#38bdf8);cursor:pointer}
.wm-ask-btn:hover{background:rgba(14,165,233,0.1)}
.wm-body{padding:0 14px 16px}
.wm-empty,.wm-empty-state{padding:20px;text-align:center;color:var(--wm-text-muted);display:flex;
  flex-direction:column;align-items:center;gap:10px;justify-content:center}
.wm-run-btn{padding:8px 18px;border-radius:8px;border:1px solid rgba(14,165,233,0.5);background:rgba(14,165,233,0.1);
  color:var(--info-fg,#38bdf8);font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
.wm-run-btn:hover:not(:disabled){background:rgba(14,165,233,0.2)}
/* Muted tokens, not opacity: opacity 0.6 put "Analyzing…" at 2.57:1 light / 3.97:1 dark (TEAM-5254). */
.wm-run-btn:disabled{color:var(--wm-text-muted);border-color:var(--pipeline-border,#27272a);background:var(--wm-surface);cursor:default}
.wm-error{color:var(--danger-fg,#f87171);font-size:12px}
.wm-spin{animation:wmspin 1s linear infinite}
@keyframes wmspin{to{transform:rotate(360deg)}}
.wm-verdict-row{display:flex;align-items:center;gap:14px;padding:8px 0 14px}
.wm-overall{flex-shrink:0;width:52px;height:52px;border:2px solid;border-radius:50%;display:flex;
  align-items:center;justify-content:center;font-size:20px;font-weight:800}
.wm-verdict{flex:1}
.wm-verdict-text{margin:0;font-weight:500;line-height:1.4}
.wm-verdict-meta{margin:3px 0 0;font-size:11px;color:var(--wm-text-muted);text-transform:capitalize}
.wm-verdict-kind{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--wm-text-muted);margin:0 0 3px}
/* text-transform:none — .wm-verdict-meta capitalizes, which would mangle "100 C" */
.wm-det-chip{margin-left:8px;padding:1px 6px;border-radius:5px;border:1px solid var(--pipeline-border,#3f3f46);
  font-variant-numeric:tabular-nums;text-transform:none}
.wm-actions{display:flex;gap:6px}
.wm-icon-btn{width:32px;height:32px;border-radius:8px;border:1px solid var(--pipeline-border,#3f3f46);
  background:none;color:var(--pipeline-text-secondary,#d4d4d8);cursor:pointer;display:flex;align-items:center;justify-content:center}
.wm-icon-btn:hover:not(:disabled){background:var(--wm-hover)}
.wm-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px;margin-bottom:14px}
.wm-card{padding:10px;border:1px solid var(--pipeline-border,#27272a);border-radius:8px;text-align:center;
  background:var(--wm-surface)}
.wm-card-icon{color:var(--wm-accent);margin-bottom:4px}
.wm-card-value{font-size:16px;font-weight:700}
.wm-card-label{font-size:10px;color:var(--wm-text-muted);margin-top:2px}
.wm-subscores{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
.wm-subscore{display:flex;align-items:center;gap:10px}
.wm-subscore-label{width:120px;font-size:12px;color:var(--pipeline-text-secondary,#d4d4d8)}
.wm-bar{flex:1;height:6px;border-radius:3px;background:var(--wm-track);overflow:hidden}
.wm-bar-fill{height:100%;border-radius:3px}
.wm-subscore-val{width:28px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums}
.wm-section{margin-bottom:14px}
.wm-section h4{margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.5px;
  color:var(--wm-text-muted)}
.wm-finding{padding:8px 10px;margin-bottom:6px;border-left:3px solid;border-radius:0 6px 6px 0;
  background:var(--wm-surface)}
.wm-finding-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wm-kind{font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;text-transform:uppercase}
.wm-finding-title{font-weight:600}
.wm-finding-evidence{margin:5px 0 0;font-size:12px;color:var(--pipeline-text-secondary,#c4c4c8);line-height:1.4}
.wm-tag{font-size:10px;padding:1px 6px;border-radius:4px;background:var(--wm-tag-bg);
  color:var(--pipeline-text-secondary,#94a3b8)}
.wm-rec{padding:8px 10px;margin-bottom:6px;border:1px solid var(--pipeline-border,#27272a);border-radius:6px}
.wm-rec-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wm-priority{font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px}
.wm-rec-title{font-weight:600}
.wm-rec-desc{margin:5px 0 0;font-size:12px;color:var(--pipeline-text-secondary,#c4c4c8);line-height:1.4}
.wm-rec-impact{margin:4px 0 0;font-size:11px;color:var(--wm-text-muted)}
.wm-sparkline{margin-bottom:8px}
/* recharts sets stroke as an SVG attribute, which can't take var() — CSS wins over it */
.wm-sparkline .recharts-line-curve,.wm-sparkline .recharts-dot{stroke:var(--wm-accent)}
.wm-trend-notes{margin:0;font-size:12px;color:var(--pipeline-text-secondary,#c4c4c8);line-height:1.4}
.wm-report{border-top:1px solid var(--pipeline-border,#27272a);padding-top:10px}
.wm-report-toggle{display:flex;align-items:center;gap:6px;background:none;border:none;color:var(--pipeline-text-secondary,#d4d4d8);
  cursor:pointer;font-size:12px;font-weight:600;padding:0}
.wm-report-body{margin-top:10px;font-size:13px}
.wm-history{margin-top:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wm-history label{font-size:11px;color:var(--wm-text-muted)}
.wm-history select{background:var(--pipeline-card-bg,#1a2332);border:1px solid var(--pipeline-border,#3f3f46);
  border-radius:6px;color:inherit;padding:4px 8px;font-size:12px}
`;
