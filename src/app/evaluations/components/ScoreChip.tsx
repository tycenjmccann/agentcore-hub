"use client";

/**
 * The one score swatch used by the overview table, the trend facets and the
 * session views. Status colors (good / warn / bad) at the long-standing
 * thresholds — 90% and 75% — and nothing else carries them.
 */

export function scoreColor(score: number): string {
  if (score >= 0.9) return "#22c55e";
  if (score >= 0.75) return "#f59e0b";
  return "#ef4444";
}

export function scoreBg(score: number): string {
  if (score >= 0.9) return "rgba(34,197,94,0.12)";
  if (score >= 0.75) return "rgba(245,158,11,0.12)";
  return "rgba(239,68,68,0.12)";
}

export function formatScore(score: number | null | undefined): string {
  return typeof score === "number" && Number.isFinite(score) ? `${Math.round(score * 100)}%` : "—";
}

export default function ScoreChip({
  score,
  label,
  title,
  bold,
  testId,
}: {
  score: number | null | undefined;
  /** Overrides the rendered text (e.g. the API's `scoreLabel`). */
  label?: string | null;
  title?: string;
  bold?: boolean;
  testId?: string;
}) {
  const known = typeof score === "number" && Number.isFinite(score);
  if (!known && !label) {
    return (
      <span data-testid={testId} className="text-[var(--color-text-muted)]" title={title}>
        —
      </span>
    );
  }
  return (
    <span
      data-testid={testId}
      title={title}
      className={`inline-block px-2 py-0.5 rounded tabular-nums ${bold ? "font-bold" : "font-medium"}`}
      style={
        known
          ? { color: scoreColor(score as number), backgroundColor: scoreBg(score as number) }
          : { color: "var(--color-text-secondary)", backgroundColor: "rgba(148,163,184,0.12)" }
      }
    >
      {label ?? formatScore(score)}
    </span>
  );
}
