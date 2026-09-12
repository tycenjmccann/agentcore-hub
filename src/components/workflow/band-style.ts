/**
 * Band + grade chip styling shared by the hero KPI strip and the per-run
 * performance card (TEAM-4482).
 *
 * Leaf module: types only from @/lib/workflow/performance, no React, no fetch.
 * STATUS_STYLE moved here verbatim from RunPerformanceCard so both surfaces
 * colour a band the same way and the palette lives in exactly one place.
 */

import type { BandStatus } from "@/lib/workflow/performance";

export const STATUS_STYLE: Record<BandStatus, string> = {
  ok: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  warn: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  alert: "bg-red-500/15 text-red-400 border-red-500/30",
  insufficient: "bg-slate-500/15 text-slate-400 border-slate-500/30",
  unknown: "bg-slate-500/15 text-slate-400 border-slate-500/30",
};

/**
 * The word each band shows. Colour alone never carries the status — a chip
 * always spells it out, for colour-blind users and for screen readers.
 */
export const BAND_TEXT: Record<BandStatus, string> = {
  ok: "within bands",
  warn: "warn",
  alert: "alert",
  insufficient: "no baseline",
  unknown: "no baseline",
};

export type Grade = "A" | "B" | "C" | "D" | "F";

/** Reuses STATUS_STYLE's class strings — no new palette entries. */
export const GRADE_STYLE: Record<Grade | "none", string> = {
  A: STATUS_STYLE.ok,
  B: STATUS_STYLE.ok,
  C: STATUS_STYLE.warn,
  D: STATUS_STYLE.alert,
  F: STATUS_STYLE.alert,
  none: STATUS_STYLE.insufficient,
};
