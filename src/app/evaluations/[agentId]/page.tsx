"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ExternalLink, Loader2, RefreshCw, X } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import agentsConfig from "@/config/agents.json";
import ScoreChip, { formatScore } from "../components/ScoreChip";
import TrendChart from "../components/TrendChart";
import WindowSelector from "../components/WindowSelector";
import { parseWindow, windowLabel, windowRange } from "../components/window";
import {
  normalizeEvaluator,
  toEvaluatorSeries,
  type EvalWindow,
  type EvaluatorSeries,
  type ResultsResponse,
  type SessionDetail,
  type SessionRow,
} from "../components/types";

/**
 * Per-agent evaluation drilldown: score over time per evaluator, the scored
 * sessions behind those averages, and one session's full judge output.
 *
 * Coexists with the static /evaluations/config route — Next resolves a static
 * segment before this dynamic one, so `config` never lands here.
 */

const ROSTER = (agentsConfig as unknown as { agents: { agentId: string; displayName: string }[] }).agents;

const ALL_PERSONAS = "__all__";

function displayNameFor(agentId: string): string {
  return ROSTER.find((a) => a.agentId === agentId)?.displayName || agentId;
}

function formatWhen(iso?: string): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Later pages may repeat a session whose rows straddled the boundary. */
function mergeSessions(prev: SessionRow[], next: SessionRow[]): SessionRow[] {
  const byId = new Map<string, SessionRow>();
  for (const row of [...prev, ...next]) {
    if (!row?.sessionId) continue;
    const existing = byId.get(row.sessionId);
    byId.set(
      row.sessionId,
      existing
        ? { ...existing, ...row, evaluators: { ...(existing.evaluators || {}), ...(row.evaluators || {}) } }
        : row
    );
  }
  return [...byId.values()];
}

export default function EvaluationDrilldownPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-5 h-5 animate-spin text-brand-400" />
        </div>
      }
    >
      <Drilldown />
    </Suspense>
  );
}

function Drilldown() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const routeParams = useParams<{ agentId: string }>();
  const agentId = decodeURIComponent(String(routeParams?.agentId ?? ""));

  const win = parseWindow(searchParams.get("days"));
  const persona = searchParams.get("persona") || "";
  const workflowId = searchParams.get("workflowId") || "";

  const [series, setSeries] = useState<EvaluatorSeries>({});
  const [seriesLoading, setSeriesLoading] = useState(true);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  const pushParams = useCallback(
    (patch: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value) params.set(key, value);
        else params.delete(key);
      }
      router.replace(`/evaluations/${agentId}?${params.toString()}`);
    },
    [agentId, router, searchParams]
  );

  const resultsUrl = useCallback(
    (nextCursor?: string | null) => {
      const params = new URLSearchParams({ agentId });
      if (persona) params.set("persona", persona);
      if (workflowId) params.set("workflowId", workflowId);
      const { from, to } = windowRange(win);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (nextCursor) params.set("cursor", nextCursor);
      return `/api/evaluations/results?${params.toString()}`;
    },
    [agentId, persona, win, workflowId]
  );

  // Score over time
  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    setSeriesLoading(true);
    const params = new URLSearchParams({ agentId, days: win });
    if (persona) params.set("persona", persona);
    fetch(`/api/evaluations/timeseries?${params.toString()}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (cancelled) return;
        setSeries(toEvaluatorSeries(json?.series));
      })
      .catch(() => {
        if (!cancelled) setSeries({});
      })
      .finally(() => {
        if (!cancelled) setSeriesLoading(false);
      });
    return () => { cancelled = true; };
  }, [agentId, persona, win]);

  // First page of sessions
  const loadSessions = useCallback(async () => {
    if (!agentId) return;
    setSessionsLoading(true);
    try {
      const res = await fetch(resultsUrl(), { cache: "no-store" });
      const json: ResultsResponse & { error?: string } = await res.json();
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      setSessions(mergeSessions([], json.sessions || []));
      setCursor(json.cursor ?? null);
      setError("");
    } catch (err: unknown) {
      setSessions([]);
      setCursor(null);
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    } finally {
      setSessionsLoading(false);
    }
  }, [agentId, resultsUrl]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const res = await fetch(resultsUrl(cursor), { cache: "no-store" });
      const json: ResultsResponse & { error?: string } = await res.json();
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      setSessions((prev) => mergeSessions(prev, json.sessions || []));
      setCursor(json.cursor ?? null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load more sessions");
    } finally {
      setLoadingMore(false);
    }
  };

  // Session detail (authoritative per session — a row may have straddled a page)
  useEffect(() => {
    if (!openSessionId) { setDetail(null); setDetailError(""); return; }
    let cancelled = false;
    setDetailLoading(true);
    setDetail(null);
    setDetailError("");
    fetch(`/api/evaluations/sessions/${encodeURIComponent(openSessionId)}`, { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
        return json as SessionDetail;
      })
      .then((json) => { if (!cancelled) setDetail(json); })
      .catch((err: unknown) => {
        if (!cancelled) setDetailError(err instanceof Error ? err.message : "Failed to load session");
      })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [openSessionId]);

  // Evaluator columns: every evaluator any loaded session was scored on.
  const evaluatorColumns = useMemo(() => {
    const seen: string[] = [];
    for (const row of sessions) {
      for (const raw of Object.keys(row.evaluators || {})) {
        const name = normalizeEvaluator(raw);
        if (!seen.includes(name)) seen.push(name);
      }
    }
    for (const name of Object.keys(series)) if (!seen.includes(name)) seen.push(name);
    return seen;
  }, [sessions, series]);

  const personaOptions = useMemo(() => {
    const found = new Set<string>();
    if (persona) found.add(persona);
    for (const row of sessions) if (row.persona) found.add(row.persona);
    return [...found].sort();
  }, [persona, sessions]);

  const scoreFor = (row: SessionRow, evaluator: string) =>
    row.evaluators?.[evaluator] ?? row.evaluators?.[`Builtin.${evaluator}`];

  return (
    <div className="space-y-4" data-testid="eval-drilldown">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href={`/evaluations?days=${win}`}
            data-testid="eval-drilldown-back"
            className="inline-flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-brand-400 transition-colors"
          >
            <ArrowLeft className="w-3 h-3" /> All evaluations
          </Link>
          <h1 data-testid="eval-drilldown-title" className="text-xl font-bold text-[var(--color-text-primary)] mt-1">
            {displayNameFor(agentId)}
            {persona && <span className="text-[var(--color-text-muted)] font-normal"> · {persona}</span>}
          </h1>
          <p className="text-[11px] font-semibold text-info-fg uppercase tracking-[0.15em] mt-1">
            <span data-testid="eval-window-label">{windowLabel(win)}</span> &nbsp;·&nbsp; {sessions.length} scored session{sessions.length === 1 ? "" : "s"} loaded
            {workflowId && <> &nbsp;·&nbsp; run {workflowId}</>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <WindowSelector value={win} onChange={(next: EvalWindow) => pushParams({ days: next })} />
          <select
            data-testid="eval-persona-filter"
            aria-label="Persona"
            value={persona || ALL_PERSONAS}
            onChange={(e) => pushParams({ persona: e.target.value === ALL_PERSONAS ? null : e.target.value })}
            className="text-xs px-2 py-1.5 rounded-lg bg-surface-2 border border-surface-4 text-[var(--color-text-primary)]"
          >
            <option value={ALL_PERSONAS}>All personas</option>
            {personaOptions.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <button
            onClick={loadSessions}
            data-testid="eval-drilldown-refresh"
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-brand-600/20 border border-brand-600/30 text-brand-400 text-xs hover:bg-brand-600/30 transition-colors"
          >
            <RefreshCw className={`w-3 h-3 ${sessionsLoading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {workflowId && (
        <button
          type="button"
          data-testid="eval-clear-workflow-filter"
          onClick={() => pushParams({ workflowId: null })}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-surface-2 border border-surface-4 text-[11px] text-[var(--color-text-secondary)] hover:border-brand-500/50"
        >
          <X className="w-3 h-3" /> Clear run filter
        </button>
      )}

      {error && (
        <div data-testid="eval-drilldown-error" className="bg-danger-subtle border border-danger-fg/30 rounded-lg px-3 py-2 text-danger-fg text-xs">
          {error}
        </div>
      )}

      {/* Score over time */}
      <TrendChart series={series} evaluatorOrder={evaluatorColumns} loading={seriesLoading} />

      {/* Sessions */}
      <div className="bg-surface-2 border border-surface-4 rounded-xl overflow-hidden">
        <div className="px-3 py-2 border-b border-white/[0.06] text-sm font-bold text-success-fg uppercase tracking-wider">
          Scored sessions
        </div>
        {sessionsLoading && !sessions.length ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 animate-spin text-brand-400" />
          </div>
        ) : !sessions.length ? (
          <div data-testid="eval-sessions-empty" className="px-3 py-8 text-center text-xs text-[var(--color-text-muted)]">
            No scored sessions in this window.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table data-testid="eval-sessions-table" className="w-full text-xs">
              <thead className="bg-white/[0.03] text-[var(--color-text-muted)]">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Evaluated</th>
                  <th className="text-left px-3 py-2 font-medium">Session</th>
                  <th className="text-left px-3 py-2 font-medium">Persona</th>
                  <th className="text-left px-3 py-2 font-medium">Run / ticket</th>
                  {evaluatorColumns.map((ev) => (
                    <th key={ev} className="text-center px-2 py-2 font-medium whitespace-nowrap" title={ev}>
                      {ev}
                    </th>
                  ))}
                  <th className="text-left px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((row) => {
                  const statuses = Object.values(row.evaluators || {})
                    .map((c) => c?.status)
                    .filter((s): s is string => !!s);
                  const status = statuses.find((s) => s.toLowerCase() !== "completed" && s.toLowerCase() !== "success") || statuses[0];
                  return (
                    <tr
                      key={row.sessionId}
                      data-testid={`eval-session-row-${row.sessionId}`}
                      onClick={() => setOpenSessionId(row.sessionId)}
                      className={`border-t border-white/[0.04] cursor-pointer hover:bg-white/[0.03] ${
                        openSessionId === row.sessionId ? "bg-white/[0.05]" : ""
                      }`}
                    >
                      <td className="px-3 py-2 whitespace-nowrap text-[var(--color-text-muted)]">{formatWhen(row.evaluatedAt)}</td>
                      <td className="px-3 py-2 font-mono text-[var(--color-text-secondary)] max-w-[200px] truncate" title={row.sessionId}>
                        {row.sessionId}
                      </td>
                      <td className="px-3 py-2 text-[var(--color-text-secondary)]">{row.persona || "—"}</td>
                      <td className="px-3 py-2 text-[var(--color-text-secondary)]">
                        {row.workflowId || row.ticketId ? (
                          <span className="whitespace-nowrap">
                            {row.workflowId || "—"}
                            {row.ticketId && <span className="text-[var(--color-text-muted)]"> · {row.ticketId}</span>}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      {evaluatorColumns.map((ev) => {
                        const cell = scoreFor(row, ev);
                        return (
                          <td key={ev} className="px-2 py-2 text-center">
                            <ScoreChip
                              score={cell?.score ?? null}
                              label={cell && cell.score == null ? cell.scoreLabel ?? null : null}
                              testId={`eval-session-score-${row.sessionId}-${ev}`}
                            />
                          </td>
                        );
                      })}
                      <td className="px-3 py-2 text-[var(--color-text-muted)]">{status || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {cursor && (
          <div className="px-3 py-2 border-t border-white/[0.06] text-center">
            <button
              type="button"
              data-testid="eval-sessions-load-more"
              onClick={loadMore}
              disabled={loadingMore}
              className="px-3 py-1.5 rounded-lg bg-brand-600/20 border border-brand-600/30 text-brand-400 text-xs hover:bg-brand-600/30 transition-colors"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>

      {/* Session panel */}
      {openSessionId && (
        <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-label="Session evaluation">
          <button
            type="button"
            aria-label="Close session panel"
            onClick={() => setOpenSessionId(null)}
            className="flex-1 bg-black/40"
          />
          <aside
            data-testid="eval-session-panel"
            className="w-full max-w-[520px] h-full overflow-y-auto bg-[var(--color-bg-secondary)] border-l border-surface-4 p-4 space-y-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">Session</div>
                <div data-testid="eval-session-panel-id" className="font-mono text-sm text-[var(--color-text-primary)] break-all">
                  {openSessionId}
                </div>
                <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                  {(detail?.persona || persona) && <>{detail?.persona || persona} · </>}
                  {displayNameFor(detail?.agentId || agentId)}
                  {detail?.ticketId && <> · {detail.ticketId}</>}
                </div>
              </div>
              <button
                type="button"
                data-testid="eval-session-panel-close"
                onClick={() => setOpenSessionId(null)}
                className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex flex-wrap gap-2">
              {detail?.tracesHref && (
                <a
                  href={detail.tracesHref}
                  data-testid="eval-session-trace-link"
                  target={detail.tracesHref.startsWith("http") ? "_blank" : undefined}
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-surface-2 border border-surface-4 text-[11px] text-[var(--color-text-secondary)] hover:border-brand-500/50"
                >
                  <ExternalLink className="w-3 h-3" /> Traces
                </a>
              )}
              {detail?.workflowHref && (
                <a
                  href={detail.workflowHref}
                  data-testid="eval-session-workflow-link"
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-surface-2 border border-surface-4 text-[11px] text-[var(--color-text-secondary)] hover:border-brand-500/50"
                >
                  <ExternalLink className="w-3 h-3" /> Workflow run{detail.workflowId ? ` ${detail.workflowId}` : ""}
                </a>
              )}
            </div>

            {detailLoading && (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="w-5 h-5 animate-spin text-brand-400" />
              </div>
            )}
            {detailError && (
              <div data-testid="eval-session-panel-error" className="bg-danger-subtle border border-danger-fg/30 rounded-lg px-3 py-2 text-danger-fg text-xs">
                {detailError}
              </div>
            )}

            {(detail?.results || []).map((result) => {
              const evaluator = normalizeEvaluator(result.evaluator);
              return (
                <div
                  key={`${result.evaluator}-${result.evaluatedAt ?? ""}`}
                  data-testid={`eval-session-result-${evaluator}`}
                  className="bg-surface-2 border border-surface-4 rounded-lg p-3 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-[var(--color-text-secondary)]">{evaluator}</span>
                    <ScoreChip
                      score={result.score ?? null}
                      label={result.score == null ? result.scoreLabel ?? null : null}
                      title={result.scoreLabel || undefined}
                    />
                  </div>
                  <div className="text-[10px] text-[var(--color-text-muted)]">
                    {formatWhen(result.evaluatedAt)}
                    {result.status && <> · {result.status}</>}
                    {result.statusReason && <> · {result.statusReason}</>}
                    {typeof result.score === "number" && <> · {formatScore(result.score)}</>}
                  </div>
                  {result.explanation && (
                    <p
                      data-testid={`eval-session-explanation-${evaluator}`}
                      className="text-[11px] leading-relaxed text-[var(--color-text-secondary)] whitespace-pre-wrap"
                    >
                      {result.explanation}
                      {result.explanationTruncated && <span className="text-[var(--color-text-muted)]"> …(truncated)</span>}
                    </p>
                  )}
                  {(result.errorType || result.errorMessage) && (
                    <p data-testid={`eval-session-error-${evaluator}`} className="text-[11px] text-danger-fg">
                      {result.errorType}
                      {result.errorType && result.errorMessage ? ": " : ""}
                      {result.errorMessage}
                    </p>
                  )}
                  {result.traceId && (
                    <div className="text-[10px] font-mono text-[var(--color-text-muted)] break-all">
                      trace {result.traceId}
                      {result.spanId && <> · span {result.spanId}</>}
                    </div>
                  )}
                </div>
              );
            })}

            {!detailLoading && !detailError && !(detail?.results || []).length && (
              <div className="text-xs text-[var(--color-text-muted)]">No evaluator results on this session.</div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
