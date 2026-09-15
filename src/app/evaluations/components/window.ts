/**
 * The evaluations window (`?days=`) — one implementation shared by the overview
 * and the drilldown so both read the same URL and label it the same way.
 */

import type { EvalWindow } from "./types";

export const EVAL_WINDOWS: EvalWindow[] = ["7", "30", "90", "all"];
export const DEFAULT_EVAL_WINDOW: EvalWindow = "7";

/** Anything unrecognised (or absent) falls back to the default window. */
export function parseWindow(raw: string | null | undefined): EvalWindow {
  const value = (raw || "").trim().toLowerCase();
  return (EVAL_WINDOWS as string[]).includes(value) ? (value as EvalWindow) : DEFAULT_EVAL_WINDOW;
}

/** Fallback label; the server's `windowLabel` wins whenever it is present. */
export function windowLabel(w: EvalWindow): string {
  return w === "all" ? "all time" : `last ${w} days`;
}

export function windowButtonLabel(w: EvalWindow): string {
  return w === "all" ? "All" : `${w}d`;
}

/**
 * UTC day range for the routes that take `from`/`to` instead of `days`
 * (`/api/evaluations/results`). `all` sends neither bound.
 */
export function windowRange(w: EvalWindow): { from?: string; to?: string } {
  if (w === "all") return {};
  const days = Number(w);
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}
