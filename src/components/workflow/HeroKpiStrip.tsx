"use client";

/**
 * Hero KPI strip (TEAM-4482) — a terminal run's headline cost / time / quality
 * above the fold, before the pipeline. The full Performance Card still renders
 * further down the board; every tile scrolls to it (or, for the agent-authored
 * Workflow Manager score, to that panel) so the strip is a summary, not a
 * second source of truth.
 *
 * Rules this file exists to keep:
 *  - never show a fabricated number. A missing value is an em dash, never 0,
 *    never grade F. The single hand-written numeric literal in here is the
 *    cost-missing "$0" (see COST_MISSING_VALUE) — everything else goes through
 *    formatKpi from @/lib/workflow/performance.
 *  - a v4 card (no `kpi` block) must render without throwing, and must say so
 *    rather than implying a score of zero.
 *  - colour never carries status on its own: every band chip spells its word.
 */

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ClipboardCheck, Clock, Coins, type LucideIcon } from "lucide-react";
import {
  BASELINE_DAYS,
  BASELINE_MIN,
  formatKpi,
  type BandStatus,
  type KpiUnit,
} from "@/lib/workflow/performance";
import { BAND_TEXT, GRADE_STYLE, STATUS_STYLE, type Grade } from "./band-style";
import { usePerformanceCard, type CardState, type RunCard, type RunCardKpi } from "./use-performance-card";

/**
 * The one permitted literal. formatKpi("usd", 0) is "$0.00" — a precise, real
 * looking bill — and formatKpi("usd", null) is "—", which loses the fact that
 * we know spend was not measured. The tile has to read "$0 · no usage data".
 */
const COST_MISSING_VALUE = "$0";

const POLL_MS = 3000;
/** 30 polls x 3s = 90s per window; two windows maximum, then we stop. */
const MAX_POLLS = 30;

const COST_PATH = "cost.totalUsd";
const TIME_PATH = "time.wallMs";
const QUALITY_PATH = "quality.score";

interface TileModel {
  testId: string;
  label: string;
  icon: LucideIcon;
  iconClass: string;
  value: string;
  muted: boolean;
  sub: string | null;
  /** Render `value · sub` on one baseline row instead of two lines. */
  inlineSub: boolean;
  /** null → no chip at all (e.g. cost was never measured). */
  band: BandStatus | null;
  grade: Grade | null;
  gradeDim: boolean;
  hover: string;
  ariaLabel: string;
  disabled: boolean;
  skeleton: boolean;
}

const SHELLS = {
  cost: { testId: "hero-kpi-cost", label: "Cost", icon: Coins, iconClass: "text-amber-400" },
  time: { testId: "hero-kpi-time", label: "Time", icon: Clock, iconClass: "text-sky-400" },
  quality: { testId: "hero-kpi-quality", label: "Quality", icon: CheckCircle2, iconClass: "text-emerald-400" },
} as const;

function bandHover(card: RunCard | null, path: string, unit: KpiUnit): string {
  const bands = card?.bands;
  const k = bands?.kpis?.[path];
  if (k && k.median != null && k.z != null) {
    return `${formatKpi(unit, k.value)} vs median ${formatKpi(unit, k.median)} (z=${k.z})`;
  }
  const min = bands?.baseline?.minSamples ?? BASELINE_MIN;
  const days = bands?.baseline?.windowDays ?? BASELINE_DAYS;
  return `No baseline yet — needs ${min} runs in the last ${days} days`;
}

/** Human-readable list of the score components that could not be measured. */
function excludedLabels(q: RunCardKpi["quality"]): string {
  const fromComponents = (q.components ?? [])
    .filter((c) => !c.included)
    .map((c) => (c.note ? `${c.label} (${c.note})` : c.label));
  const labels = fromComponents.length ? fromComponents : (q.excluded ?? []);
  return labels.length ? labels.join(", ") : "none";
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Every rendering decision for the three tiles, in one pure function so the
 * state table is readable end to end (and unit-testable without a DOM).
 */
export function deriveTiles(state: CardState, card: RunCard | null): TileModel[] {
  // 1-3: nothing to show — loading, never computed, or the read failed.
  if (state !== "ready" || !card) {
    const skeleton = state === "loading";
    const sub = state === "missing" ? "not computed yet" : null;
    const hover =
      state === "missing" ? "This run has no performance card yet."
      : state === "error" ? "Could not load the performance card."
      : "Loading the performance card…";
    const tail =
      state === "missing" ? "not computed yet"
      : state === "error" ? "could not load"
      : "loading";
    return Object.values(SHELLS).map((shell) => ({
      ...shell,
      value: "—",
      muted: true,
      sub,
      inlineSub: false,
      band: null,
      grade: null,
      gradeDim: false,
      hover,
      ariaLabel: `${shell.label} — ${tail}`,
      disabled: true,
      skeleton,
    }));
  }

  const kpi = card.kpi;
  const bandOf = (path: string) => card.bands?.kpis?.[path]?.status ?? null;

  // 5: cost was not measured. A v5 card says so with `kpi.cost.usd === null`; a
  // v4 card only via dataQuality. Either way it is not a $0.00 bill.
  const costMissing = card.dataQuality?.costMissing === true || (!!kpi && kpi.cost.usd === null);
  const cost: TileModel = {
    ...SHELLS.cost,
    value: costMissing ? COST_MISSING_VALUE : formatKpi("usd", kpi ? kpi.cost.usd : card.cost.totalUsd),
    muted: costMissing,
    sub: costMissing
      ? "no usage data"
      : `${formatKpi("usd", card.cost.personaUsd)} personas · ${formatKpi("usd", card.cost.codingUsd)} coding`,
    inlineSub: costMissing,
    band: costMissing ? null : (kpi ? kpi.cost.band : bandOf(COST_PATH)),
    grade: null,
    gradeDim: false,
    hover: costMissing
      ? "No token/usage data was captured for this run, so cost cannot be computed."
      : bandHover(card, COST_PATH, "usd"),
    ariaLabel: "",
    disabled: false,
    skeleton: false,
  };

  const time: TileModel = {
    ...SHELLS.time,
    value: formatKpi("ms", kpi ? kpi.time.wallMs : card.time.wallMs),
    muted: (kpi ? kpi.time.wallMs : card.time.wallMs) == null,
    sub: `${formatKpi("ms", kpi ? kpi.time.activeMs : card.time.activeMs)} active · ${formatKpi("ms", kpi ? kpi.time.humanWaitMs : card.time.humanWaitMs)} human wait`,
    inlineSub: false,
    band: kpi ? kpi.time.band : bandOf(TIME_PATH),
    grade: null,
    gradeDim: false,
    hover: bandHover(card, TIME_PATH, "ms"),
    ariaLabel: "",
    disabled: false,
    skeleton: false,
  };

  // 4: a v4 card predates the deterministic score. Say that — do not imply 0.
  const quality: TileModel = !kpi
    ? {
        ...SHELLS.quality,
        value: "—",
        muted: true,
        sub: "no deterministic score",
        inlineSub: false,
        band: null,
        grade: null,
        gradeDim: false,
        hover: "no deterministic score — card predates v5; recompute to get one",
        ariaLabel: "",
        disabled: false,
        skeleton: false,
      }
    : qualityTile(card, kpi);

  return [cost, time, quality].map((t) => ({
    ...t,
    ariaLabel: `${t.label} ${t.value}, ${t.band ? BAND_TEXT[t.band] : "no baseline"} — jump to performance card`,
  }));
}

/** States 6-9 for the quality tile: outcome caps, partial + insufficient evidence. */
function qualityTile(card: RunCard, kpi: RunCardKpi): TileModel {
  const q = kpi.quality;
  // 8: too little evidence to stand behind a number — mute it, and never fall
  // back to 0/100 or an F that the evidence does not support.
  const insufficient = q.confidence === "insufficient" || q.evidenceWeight < 50;
  const cap = q.capsApplied?.[0];

  const parts: string[] = [];
  // 6: the cap and the outcome that caused it, both read from the payload.
  if (cap) parts.push(`capped at ${cap.cap} — outcome ${cap.outcome}`);
  else if (q.outcome && q.outcome !== "complete") parts.push(q.outcome);
  if (insufficient) parts.push("insufficient evidence");
  else if (q.confidence === "partial") parts.push("partial evidence"); // 7
  if (!parts.length) parts.push(plural(card.quality.loops, "loop")); // 9

  const hover = insufficient
    ? `Only ${q.evidenceWeight} of 100 points of evidence were available. Excluded: ${excludedLabels(q)}`
    : cap
      ? `Score capped because the run did not deliver: ${cap.outcome}.`
      : q.confidence === "partial"
        ? `Excluded: ${excludedLabels(q)}`
        : bandHover(card, QUALITY_PATH, "count");

  return {
    ...SHELLS.quality,
    value: q.score == null ? "—" : `${q.score}/100`,
    muted: q.score == null || insufficient,
    sub: parts.join(" · "),
    inlineSub: false,
    band: q.band ?? null,
    // No score means no grade — an "F" here would be a verdict we cannot back.
    grade: q.score == null ? null : (q.grade ?? null),
    gradeDim: insufficient,
    hover,
    ariaLabel: "",
    disabled: false,
    skeleton: false,
  };
}

// ─── Compute now ─────────────────────────────────────────────────────────────

type Compute =
  | { kind: "idle" }
  | { kind: "posting" }
  | { kind: "polling"; attempts: number; window: 1 | 2; note?: "already" }
  | { kind: "done" }
  | { kind: "timeout"; canRetry: boolean }
  | { kind: "error"; tone: "red" | "amber"; message: string };

const START_ERROR = "Could not start the KPI computation.";
const READ_ERROR = "Could not load the performance card.";

/**
 * POST the compute request, then wait for the card by polling — bounded, so a
 * backend that never writes one cannot leave the tab polling forever.
 */
function useComputeNow(workflowId: string, setCard: (card: RunCard) => void) {
  const [compute, setCompute] = useState<Compute>({ kind: "idle" });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [workflowId]);

  const schedule = (fn: () => void, ms: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (alive.current) fn();
    }, ms);
  };

  const poll = async (attempts: number, window: 1 | 2, note?: "already") => {
    try {
      const r = await fetch(`/api/workflow/performance?workflowId=${encodeURIComponent(workflowId)}`, { cache: "no-store" });
      if (!alive.current) return;
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (!alive.current) return;
        if (j?.card) {
          setCard(j.card as RunCard);
          setCompute({ kind: "done" });
          return;
        }
      } else if (r.status !== 404) {
        setCompute({ kind: "error", tone: "red", message: READ_ERROR });
        return;
      }
    } catch {
      if (alive.current) setCompute({ kind: "error", tone: "red", message: READ_ERROR });
      return;
    }
    const next = attempts + 1;
    if (next >= MAX_POLLS) {
      setCompute({ kind: "timeout", canRetry: window === 1 });
      return;
    }
    setCompute({ kind: "polling", attempts: next, window, note });
    schedule(() => poll(next, window, note), POLL_MS);
  };

  const beginPolling = (delay: number, note?: "already") => {
    setCompute({ kind: "polling", attempts: 0, window: 1, note });
    schedule(() => poll(0, 1, note), delay);
  };

  const start = async () => {
    setCompute({ kind: "posting" });
    try {
      const r = await fetch("/api/workflow/performance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflowId }),
      });
      const j = await r.json().catch(() => null);
      if (!alive.current) return;
      if (r.status === 200 && j?.card) {
        setCard(j.card as RunCard);
        setCompute({ kind: "done" });
        return;
      }
      if (r.status === 200 || r.status === 202) {
        beginPolling(typeof j?.pollAfterMs === "number" ? j.pollAfterMs : POLL_MS);
        return;
      }
      // Already running for this run — wait for the other computation to land
      // rather than starting (or reporting) a second one.
      if (r.status === 429) {
        beginPolling(typeof j?.retryAfterMs === "number" ? j.retryAfterMs : POLL_MS, "already");
        return;
      }
      if (r.status === 409) {
        setCompute({ kind: "error", tone: "amber", message: "run is not terminal" });
        return;
      }
      setCompute({ kind: "error", tone: "red", message: START_ERROR });
    } catch {
      if (alive.current) setCompute({ kind: "error", tone: "red", message: START_ERROR });
    }
  };

  const checkAgain = () => {
    setCompute({ kind: "polling", attempts: 0, window: 2 });
    schedule(() => poll(0, 2), POLL_MS);
  };

  return { compute, start, checkAgain };
}

// ─── Workflow Manager assessment ─────────────────────────────────────────────

interface WmAssessment {
  overall: number;
  verdict: string;
}

/**
 * The agent-authored score, read separately from the deterministic card. Fetched
 * here rather than inside the tile so the grid knows whether it has a 4th column.
 */
function useWmAssessment(workflowId: string): WmAssessment | null {
  const [wm, setWm] = useState<WmAssessment | null>(null);
  useEffect(() => {
    let alive = true;
    setWm(null);
    fetch(`/api/workflow/${workflowId}/analysis`)
      .then(async (r) => {
        if (!alive || !r.ok) return;
        const j = await r.json();
        if (!alive) return;
        const overall = j?.latest?.scores?.overall;
        if (typeof overall !== "number") return;
        setWm({ overall, verdict: typeof j.latest.verdict === "string" ? j.latest.verdict : "" });
      })
      .catch(() => { /* the panel below reports analysis failures */ });
    return () => { alive = false; };
  }, [workflowId]);
  return wm;
}

// ─── Presentation ────────────────────────────────────────────────────────────

const TILE_CLASS =
  "group relative flex flex-col items-start gap-1 text-left min-h-[104px] rounded-lg border border-[var(--color-border)] p-3 transition-colors hover:border-[var(--color-border-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-hover)] disabled:cursor-default";
const LABEL_CLASS = "text-xs uppercase tracking-wider text-[var(--color-text-muted)] flex items-center gap-1.5";
const SUB_CLASS = "text-[11px] text-[var(--color-text-muted)] tabular-nums";
const CHIP_CLASS = "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium";
const SKELETON_CLASS = "animate-pulse rounded bg-[var(--color-bg-tertiary)]";

function scrollToAnchor(id: string) {
  const el = typeof document === "undefined" ? null : document.getElementById(id);
  if (!el) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}

function KpiTile({ model, onActivate }: { model: TileModel; onActivate: () => void }) {
  const Icon = model.icon;
  const hintId = `${model.testId}-hint`;
  return (
    <button
      type="button"
      data-testid={model.testId}
      aria-label={model.ariaLabel}
      aria-describedby={hintId}
      title={model.hover}
      disabled={model.disabled}
      onClick={onActivate}
      className={`${TILE_CLASS} bg-[var(--color-bg-secondary)]`}
    >
      <span className={LABEL_CLASS}>
        <Icon className={`w-3.5 h-3.5 ${model.iconClass}`} aria-hidden />
        {model.label}
      </span>
      {model.skeleton ? (
        <>
          <span className={`${SKELETON_CLASS} h-7 w-20`} />
          <span className={`${SKELETON_CLASS} h-3 w-32`} />
          <span className={`${SKELETON_CLASS} h-4 w-24 rounded-full`} />
        </>
      ) : (
        <>
          <span className="flex flex-wrap items-baseline gap-1.5">
            <span
              className={`text-2xl font-semibold tabular-nums leading-none ${
                model.muted ? "text-[var(--color-text-muted)]" : "text-[var(--color-text-primary)]"
              }`}
            >
              {model.value}
            </span>
            {model.grade && (
              <span
                aria-label={`grade ${model.grade}`}
                className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${GRADE_STYLE[model.grade]} ${
                  model.gradeDim ? "opacity-60 border-dashed" : ""
                }`}
              >
                {model.grade}
              </span>
            )}
            {model.inlineSub && model.sub && <span className={SUB_CLASS}>· {model.sub}</span>}
          </span>
          {!model.inlineSub && model.sub && <span className={SUB_CLASS}>{model.sub}</span>}
          {/* mt-auto: the chips line up along the bottom of the row even when one
              tile's sub-line wraps to two lines and another's does not. */}
          {model.band && <span className={`${CHIP_CLASS} mt-auto ${STATUS_STYLE[model.band]}`}>{BAND_TEXT[model.band]}</span>}
        </>
      )}
      <span id={hintId} className="sr-only">{model.hover}</span>
    </button>
  );
}

function WmAssessmentTile({ assessment }: { assessment: WmAssessment }) {
  return (
    <button
      type="button"
      data-testid="hero-kpi-wm"
      aria-label={`Workflow Manager assessment ${assessment.overall} out of 100, agent-authored${
        assessment.verdict ? `: ${assessment.verdict}` : ""
      } — jump to the Workflow Manager panel`}
      title={
        assessment.verdict ||
        "The Workflow Manager agent's own judgement of this run — not the deterministic score"
      }
      onClick={() => scrollToAnchor("workflow-manager-panel")}
      className={`${TILE_CLASS} border-dashed bg-transparent opacity-90 col-span-2 md:col-span-1`}
    >
      <span className={LABEL_CLASS}>
        <ClipboardCheck className="w-3.5 h-3.5 text-slate-400" aria-hidden />
        Workflow Manager · agent-authored
      </span>
      <span className="text-xl font-semibold tabular-nums leading-none text-[var(--color-text-primary)]">
        {assessment.overall}/100
      </span>
      {/*
        The verdict itself lives in the panel below (and in this tile's title +
        aria-label). Repeating the sentence here would duplicate it in the DOM,
        which is both visual noise and ambiguous for anything selecting by text.
      */}
      {assessment.verdict && <span className={SUB_CLASS}>read the full assessment</span>}
      <span className={`${CHIP_CLASS} mt-auto ${STATUS_STYLE.insufficient}`}>agent judgement</span>
    </button>
  );
}

// ─── Strip ───────────────────────────────────────────────────────────────────

export default function HeroKpiStrip({ workflowId }: { workflowId: string }) {
  const { card, state, setCard, refetch } = usePerformanceCard(workflowId);
  const { compute, start, checkAgain } = useComputeNow(workflowId, setCard);
  const wm = useWmAssessment(workflowId);

  const tiles = deriveTiles(state, card);
  const busy = compute.kind === "posting" || compute.kind === "polling";
  // A terminal run always offers a way forward: compute the card it lacks, or
  // recompute a pre-v5 card that has no deterministic score.
  const computeLabel = state === "missing" ? "Compute now" : state === "ready" && !card?.kpi ? "Recompute" : null;

  const baseline = card?.bands?.baseline;
  const liveMessage =
    compute.kind === "posting" ? "Computing the performance card…"
    : compute.kind === "polling" ? (compute.note === "already" ? "Already computing the performance card…" : "Computing the performance card…")
    : compute.kind === "done" ? "Performance card ready"
    : compute.kind === "timeout" ? "Still computing the performance card"
    : compute.kind === "error" ? compute.message
    : "";

  return (
    <section
      aria-label="Run KPIs"
      data-testid="hero-kpi-strip"
      className="px-5 pt-3 mb-4 w-full"
      aria-busy={state === "loading"}
    >
      <h2 className="sr-only">Run KPIs</h2>

      <div className={`grid gap-3 grid-cols-1 min-[400px]:grid-cols-2 ${wm ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
        {tiles.map((t) => (
          <KpiTile key={t.testId} model={t} onActivate={() => scrollToAnchor("run-performance-card")} />
        ))}
        {wm && <WmAssessmentTile assessment={wm} />}
      </div>

      {card && (
        <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">
          {card.workflowDefId}
          {baseline?.n ? ` · baseline ${baseline.n} runs / ${baseline.windowDays}d` : ""}
        </p>
      )}

      {(computeLabel || busy || state === "error" || compute.kind === "timeout" || compute.kind === "error") && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          {computeLabel && (
            <button
              type="button"
              data-testid="hero-kpi-compute-now"
              onClick={start}
              disabled={busy}
              className="inline-flex items-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-1 font-medium text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-border-hover)] disabled:opacity-60"
            >
              {computeLabel}
            </button>
          )}
          {compute.kind === "posting" && <span className="text-[var(--color-text-muted)]">computing…</span>}
          {compute.kind === "polling" && (
            <span className="text-[var(--color-text-muted)]">
              {compute.note === "already" ? "already computing" : "computing…"}
            </span>
          )}
          {compute.kind === "timeout" && (
            <>
              <span className="text-amber-400">still computing — the card usually appears within a minute</span>
              {compute.canRetry && (
                <button
                  type="button"
                  data-testid="hero-kpi-check-again"
                  onClick={checkAgain}
                  className="inline-flex items-center rounded-md border border-[var(--color-border)] px-2 py-1 font-medium text-[var(--color-text-primary)] hover:border-[var(--color-border-hover)]"
                >
                  Check again
                </button>
              )}
            </>
          )}
          {compute.kind === "error" && (
            <span className={compute.tone === "red" ? "text-red-400" : "text-amber-400"}>{compute.message}</span>
          )}
          {state === "error" && (
            <>
              <span className="text-red-400">{READ_ERROR}</span>
              <button
                type="button"
                data-testid="hero-kpi-retry"
                onClick={refetch}
                className="inline-flex items-center rounded-md border border-[var(--color-border)] px-2 py-1 font-medium text-[var(--color-text-primary)] hover:border-[var(--color-border-hover)]"
              >
                Retry
              </button>
            </>
          )}
        </div>
      )}

      <div aria-live="polite" className="sr-only">{liveMessage}</div>
    </section>
  );
}
