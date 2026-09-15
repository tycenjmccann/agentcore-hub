/**
 * Chart parameters for every evaluations visual, in one place so the sparklines
 * and the trend facets read as a single system.
 *
 * Score-over-time is always a SINGLE series per plot (small multiples, one facet
 * per evaluator) — with up to 11 evaluators a shared plot would need more
 * categorical hues than any palette can keep colorblind-safe, and faceting keeps
 * every mark on the one validated accent. Identity comes from the facet title,
 * so no plot needs a legend. `SERIES` is categorical slot 1 (blue), validated
 * against both the dark (#1a1a25) and light (#f1f3f5) console surfaces:
 * lightness band, chroma floor and >= 3:1 contrast all pass.
 * Status hues (>= 90% / >= 75%) appear only as the two band annotations, never as
 * a series color.
 */

export const SERIES = "#3987e5";
/** Hairline, solid, one step off either surface — recessive on both themes. */
export const GRID = "rgba(148,163,184,0.20)";
export const AXIS_TEXT = "rgba(148,163,184,0.85)";
export const GOOD_BAND = "#22c55e";
export const WARN_BAND = "#f59e0b";

export const TOOLTIP_STYLE = {
  background: "var(--color-bg-secondary)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  fontSize: 11,
  padding: "4px 8px",
} as const;

/** `2026-09-14` → `Sep 14` (axis ticks and tooltips stay short). */
export function shortDay(day: string): string {
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return day;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}
