"use client";

/**
 * "SI impact" — did the self-improvement loop actually improve anything?
 *
 * The Self-Improvement Loop rows in the table above answer "is the loop
 * running": eval scores, packager invocations, PRDs written. They cannot answer
 * "did the fixes work", because nothing used to connect a recommendation to the
 * PR that addressed it or to the metric afterwards. This panel reads the SI
 * ledger, where each row is one defect class with its sightings, its fix
 * attempts and an ARITHMETIC verdict over the before/after window.
 *
 * Read-only, and deliberately so — see the route's header comment. Nothing here
 * posts; the numbers are computed by the loop's own writers and this panel only
 * renders them.
 *
 * Two rendering rules worth keeping:
 *  - A metric that could not be read is `—` with a reason on hover, never `0`.
 *    Six of the ten verdict metrics need a REPORT_VERSION 6 card, so
 *    `insufficient` is a normal state, not a bug, and must not look like "zero
 *    regressions".
 *  - A row can be counted by both the "open" and the "fix did nothing" tile. A
 *    no-effect verdict returns the row to `open` with the attempt kept, because
 *    the ask is still outstanding — that is the honest double count.
 */

import { Fragment, useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, RefreshCw, Repeat, Target } from "lucide-react";
import type { SiCoverageDay, SiLedgerRow, SiStatus, SiSummary, SiPatternSummary } from "./types";

const REPO_URL = "https://github.com/tycenjmccann/agentcore-hub";

/** Status → swatch. `no-effect`/`regressed` are verdicts, but a row can hold them mid-flight. */
const STATUS_STYLE: Record<string, { fg: string; bg: string }> = {
  open: { fg: "#f59e0b", bg: "rgba(245,158,11,0.12)" },
  batched: { fg: "#a78bfa", bg: "rgba(167,139,250,0.12)" },
  "in-run": { fg: "#3b82f6", bg: "rgba(59,130,246,0.12)" },
  landed: { fg: "#38bdf8", bg: "rgba(56,189,248,0.12)" },
  deployed: { fg: "#22d3ee", bg: "rgba(34,211,238,0.12)" },
  verified: { fg: "#22c55e", bg: "rgba(34,197,94,0.12)" },
  "no-effect": { fg: "#ef4444", bg: "rgba(239,68,68,0.12)" },
  regressed: { fg: "#ef4444", bg: "rgba(239,68,68,0.18)" },
  "wont-fix": { fg: "#94a3b8", bg: "rgba(148,163,184,0.12)" },
};

const VERDICT_STYLE: Record<string, string> = {
  verified: "#22c55e",
  "no-effect": "#ef4444",
  regressed: "#ef4444",
  insufficient: "var(--color-text-muted)",
};

function StatusBadge({ status }: { status: SiStatus | null }) {
  if (!status) return <span className="text-[var(--color-text-muted)]">—</span>;
  const s = STATUS_STYLE[status] ?? { fg: "var(--color-text-secondary)", bg: "rgba(148,163,184,0.12)" };
  return (
    <span className="inline-block px-2 py-0.5 rounded text-[11px] font-medium" style={{ color: s.fg, backgroundColor: s.bg }}>
      {status}
    </span>
  );
}

function day(iso: string | null | undefined): string {
  return iso ? String(iso).slice(0, 10) : "—";
}

function pct(ratio: number | null | undefined): string {
  return typeof ratio === "number" && Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : "—";
}

function num(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "—";
}

/** `before → after` for the metrics the latest verdict actually measured. */
function BeforeAfter({ verdict }: { verdict: SiPatternSummary["latestVerdict"] }) {
  if (!verdict) return <span className="text-[var(--color-text-muted)]">not measured yet</span>;
  const metrics = Object.keys({ ...(verdict.before || {}), ...(verdict.after || {}) });
  const color = VERDICT_STYLE[verdict.verdict || ""] ?? "var(--color-text-secondary)";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-medium" style={{ color }} title={verdict.note || undefined}>
        {verdict.verdict || "—"}
      </span>
      {metrics.length === 0 ? (
        // An `insufficient` verdict has no numbers by definition: the metric
        // could not be read (usually a pre-#635 card). Say that, do not show 0.
        <span className="text-[10px] text-[var(--color-text-muted)]">no readable metric</span>
      ) : (
        metrics.slice(0, 3).map((m) => (
          <span key={m} className="text-[10px] tabular-nums text-[var(--color-text-secondary)]">
            {m}: {num(verdict.before?.[m])} → {num(verdict.after?.[m])}
          </span>
        ))
      )}
    </div>
  );
}

/** The fix attempts, each linking its PRs. */
function Attempts({ pattern }: { pattern: SiPatternSummary }) {
  if (!pattern.attempts) return <span className="text-[var(--color-text-muted)]">—</span>;
  const latest = pattern.latestAttempt;
  const prs = latest?.prNumbers || [];
  return (
    <div className="flex flex-col gap-0.5">
      <span className="tabular-nums text-[var(--color-text-primary)]">{pattern.attempts}</span>
      {prs.length > 0 && (
        <span className="flex flex-wrap gap-1">
          {prs.map((pr) => (
            <a
              key={pr}
              href={`${REPO_URL}/pull/${pr}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-brand-400 hover:underline"
            >
              #{pr}
            </a>
          ))}
        </span>
      )}
      {latest?.outcome && <span className="text-[10px] text-[var(--color-text-muted)]">{latest.outcome}</span>}
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  color,
  icon,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  color?: string;
  icon: React.ReactNode;
  testId: string;
}) {
  return (
    <div data-testid={testId} className="bg-surface-2 border border-surface-4 rounded-xl px-3 py-2.5 flex-1 min-w-[140px]" title={hint}>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
        {icon}
        {label}
      </div>
      <div className="text-lg font-bold tabular-nums mt-1" style={{ color: color ?? "var(--color-text-primary)" }}>
        {value}
      </div>
      {hint && <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5 leading-tight">{hint}</div>}
    </div>
  );
}

/** The `?patternKey=` drill-down: the full sighting history the table collapses. */
function Drilldown({ patternKey, onClose }: { patternKey: string; onClose: () => void }) {
  const [row, setRow] = useState<SiLedgerRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRow(null);
    setError(null);
    fetch(`/api/evaluations/si-ledger?patternKey=${encodeURIComponent(patternKey)}`)
      .then(async (res) => {
        const json = await res.json();
        if (!live) return;
        if (!res.ok) setError(json.error || `HTTP ${res.status}`);
        else setRow(json.row);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : "Failed to load"));
    return () => {
      live = false;
    };
  }, [patternKey]);

  return (
    <tr data-testid="si-drilldown" className="border-b border-white/[0.06] bg-surface-1/40">
      <td colSpan={7} className="px-3 py-3">
        {error && <div className="text-danger-fg text-xs">{error}</div>}
        {!row && !error && <Loader2 className="w-4 h-4 animate-spin text-brand-400" />}
        {row && (
          <div className="space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] text-[var(--color-text-secondary)]">{row.patternKey}</span>
              <button onClick={onClose} className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
                close
              </button>
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
                Sightings ({(row.occurrences || []).length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(row.occurrences || []).map((o, i) => (
                  <a
                    key={`${o.workflowId}-${i}`}
                    href={`/workflow?id=${o.workflowId}`}
                    className="px-1.5 py-0.5 rounded bg-surface-3 text-[10px] text-brand-400 hover:underline"
                    title={`${o.workflowDefId || "run"} · ${o.severity || "severity unknown"} · ${day(o.at)}`}
                  >
                    {o.workflowId}
                  </a>
                ))}
                {(row.occurrences || []).length === 0 && <span className="text-[var(--color-text-muted)]">none recorded</span>}
              </div>
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
                Attempts ({(row.attempts || []).length})
              </div>
              <div className="flex flex-col gap-1">
                {(row.attempts || []).map((a, i) => (
                  <div key={`${a.prdKey}-${i}`} className="flex flex-wrap items-center gap-2 text-[11px]">
                    <StatusBadge status={(a.outcome as SiStatus) ?? null} />
                    {a.workflowId && (
                      <a href={`/workflow?id=${a.workflowId}`} className="text-brand-400 hover:underline">
                        {a.workflowId}
                      </a>
                    )}
                    {(a.prNumbers || []).map((pr) => (
                      <a key={pr} href={`${REPO_URL}/pull/${pr}`} target="_blank" rel="noopener noreferrer" className="text-brand-400 hover:underline">
                        #{pr}
                      </a>
                    ))}
                    <span className="text-[var(--color-text-muted)]">
                      merged {day(a.mergedAt)} · deployed {day(a.deployedAt)}
                    </span>
                    {a.note && <span className="text-[var(--color-text-muted)]">{a.note}</span>}
                  </div>
                ))}
                {(row.attempts || []).length === 0 && <span className="text-[var(--color-text-muted)]">no fix attempted yet</span>}
              </div>
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] mb-1">Expected vs measured</div>
              <div className="flex flex-col gap-1">
                {(row.expected || []).map((e, i) => (
                  <div key={`${e.metric}-${i}`} className="text-[11px] tabular-nums text-[var(--color-text-secondary)]">
                    <span className="text-[var(--color-text-primary)]">{e.metric}</span>: baseline {num(e.baseline?.value)}{" "}
                    {e.baseline?.runs ? `over ${e.baseline.runs} runs` : ""} → target {String(e.target ?? "—")}
                    {e.observeRuns ? ` (observe ${e.observeRuns} runs)` : ""}
                  </div>
                ))}
                {(row.expected || []).length === 0 && (
                  <span className="text-[var(--color-text-muted)]">no expected block — this key predates the ledger</span>
                )}
              </div>
              <div className="flex flex-col gap-1 mt-1.5">
                {(row.verdicts || []).map((v, i) => (
                  <div key={`${v.at}-${i}`} className="text-[11px]">
                    <span style={{ color: VERDICT_STYLE[v.verdict || ""] ?? "var(--color-text-secondary)" }}>{v.verdict}</span>
                    <span className="text-[var(--color-text-muted)]"> · {day(v.at)}</span>
                    {Object.keys({ ...(v.before || {}), ...(v.after || {}) }).map((m) => (
                      <span key={m} className="text-[var(--color-text-secondary)] tabular-nums ml-2">
                        {m}: {num(v.before?.[m])} → {num(v.after?.[m])}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </td>
    </tr>
  );
}

export default function SiImpactPanel() {
  const [summary, setSummary] = useState<SiSummary | null>(null);
  const [patterns, setPatterns] = useState<SiPatternSummary[]>([]);
  const [coverage, setCoverage] = useState<SiCoverageDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const fetchLedger = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/evaluations/si-ledger");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setSummary(json.summary ?? null);
      setPatterns(json.patterns ?? []);
      setCoverage(json.coverage ?? []);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load the SI ledger");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLedger();
  }, [fetchLedger]);

  return (
    <div data-testid="si-impact-panel" className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-sm font-bold text-success-fg uppercase tracking-wider">SI impact</span>
          <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
            One row per tracked defect class — sightings, fix attempts, and an arithmetic before/after verdict. Read-only.
          </p>
        </div>
        <button
          onClick={fetchLedger}
          disabled={loading}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-brand-600/20 border border-brand-600/30 text-brand-400 text-xs hover:bg-brand-600/30 transition-colors"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {error && (
        <div data-testid="si-impact-error" className="bg-danger-subtle border border-danger-fg/30 rounded-lg px-3 py-2 text-danger-fg text-xs">
          {error}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Tile
          testId="si-tile-open"
          label="Open patterns"
          value={summary ? String(summary.openPatterns) : "—"}
          hint={`${summary?.occurrences ?? 0} sightings across ${summary?.patterns ?? 0} tracked patterns`}
          color="#f59e0b"
          icon={<Target className="w-3 h-3" />}
        />
        <Tile
          testId="si-tile-verified"
          label="Verified fixes"
          value={summary ? String(summary.verifiedFixes) : "—"}
          hint="Measured better on the metric the PRD promised"
          color="#22c55e"
          icon={<CheckCircle2 className="w-3 h-3" />}
        />
        <Tile
          testId="si-tile-no-effect"
          label="Fixes with no effect"
          value={summary ? String(summary.noEffectFixes) : "—"}
          hint="Shipped, measured, and the metric did not move — the ask is open again"
          color="#ef4444"
          icon={<AlertTriangle className="w-3 h-3" />}
        />
        <Tile
          testId="si-tile-coverage"
          label="Analysis coverage"
          value={pct(summary?.analysisCoverage)}
          hint={
            summary?.analysisCoverageDay
              ? `Terminal runs that got an analysis on ${summary.analysisCoverageDay}${coverage.length > 1 ? ` (${coverage.length} days recorded)` : ""}`
              : "Not measured yet — the daily verify has not run"
          }
          color="#3b82f6"
          icon={<Repeat className="w-3 h-3" />}
        />
      </div>

      <div className="bg-surface-2 border border-surface-4 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs" data-testid="si-impact-table">
            <thead>
              <tr className="border-b border-white/[0.06]">
                {["Pattern", "Status", "Seen", "First", "Last", "Attempts", "Latest verdict"].map((h) => (
                  <th key={h} className="text-left px-3 py-2 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {patterns.map((p) => (
                <Fragment key={p.patternKey}>
                  <tr
                    data-testid="si-pattern-row"
                    onClick={() => setOpenKey(openKey === p.patternKey ? null : p.patternKey)}
                    className="border-b border-white/[0.06] hover:bg-surface-3/40 cursor-pointer"
                  >
                    <td className="px-3 py-2 max-w-[320px]">
                      <div className="text-[var(--color-text-primary)] truncate" title={p.title || p.patternKey}>
                        {p.title || p.patternKey}
                      </div>
                      <div className="font-mono text-[10px] text-[var(--color-text-muted)] truncate">{p.patternKey}</div>
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={p.status} />
                      {p.source === "backfill" && (
                        <div className="text-[9px] text-[var(--color-text-muted)] mt-0.5" title="Seeded from history that predates the ledger">
                          backfilled
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-[var(--color-text-primary)]">{p.occurrences}</td>
                    <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">{day(p.firstSeen)}</td>
                    <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">{day(p.lastSeen)}</td>
                    <td className="px-3 py-2">
                      <Attempts pattern={p} />
                    </td>
                    <td className="px-3 py-2">
                      <BeforeAfter verdict={p.latestVerdict} />
                    </td>
                  </tr>
                  {openKey === p.patternKey && <Drilldown patternKey={p.patternKey} onClose={() => setOpenKey(null)} />}
                </Fragment>
              ))}
              {!loading && patterns.length === 0 && !error && (
                <tr>
                  <td colSpan={7} data-testid="si-impact-empty" className="px-3 py-6 text-center text-[var(--color-text-muted)]">
                    No patterns tracked yet. The ledger fills as runs are analysed — run{" "}
                    <code className="font-mono text-[10px]">scripts/si-ledger-backfill.mjs</code> to seed it from history.
                  </td>
                </tr>
              )}
              {loading && patterns.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center">
                    <Loader2 className="w-4 h-4 animate-spin text-brand-400 inline" />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[10px] text-[var(--color-text-muted)]">
        Verdicts are arithmetic over performance cards, events and the ledger — no model judgement.{" "}
        <a href={`${REPO_URL}/blob/main/docs/MODULES.md`} target="_blank" rel="noopener noreferrer" className="text-brand-400 hover:underline">
          How this is computed <ExternalLink className="w-2.5 h-2.5 inline" />
        </a>
      </p>
    </div>
  );
}
