/**
 * What the Workflow Manager panel should show while a Run Analysis it started is
 * in flight (TEAM-5226). Pure, so the decision is unit-testable: before this the
 * panel only ever stopped on a NEW analysis, and a failed ANALYZE (the harness
 * dying on MaxTokensReachedException) read as "Analyzing…" for 10 minutes and
 * then silently reset to the old state.
 */
import type { AnalysisFailure, WorkflowAnalysis } from "./analysis-types";

export type AnalysisPollState = "pending" | "done" | "failed" | "timeout";

export interface AnalysisPollInput {
  /** analysisId of the latest analysis when Run Analysis was clicked. */
  baselineId: string | null;
  latest: WorkflowAnalysis | null | undefined;
  /** From GET /analysis?since=<click ms>: only failures after the click. */
  latestFailure: AnalysisFailure | null | undefined;
  now: number;
  pollUntil: number;
}

export function analysisPollOutcome(i: AnalysisPollInput): { state: AnalysisPollState; message?: string } {
  // A new analysis wins: a failed attempt followed by a successful manual
  // re-run (or a slow first attempt) must not show an error over a good result.
  if (i.latest && i.latest.analysisId !== i.baselineId) return { state: "done" };
  if (i.latestFailure) {
    const d = i.latestFailure.detail || ({} as AnalysisFailure["detail"]);
    const attempts = d.attempts ? ` after ${d.attempts} attempt${d.attempts === 1 ? "" : "s"}` : "";
    const why = d.message ? ` — ${d.message}` : "";
    return { state: "failed", message: `Analysis failed: ${d.errorClass || "Error"}${attempts}${why}` };
  }
  if (i.now > i.pollUntil) {
    return {
      state: "timeout",
      message: "No analysis after 10 minutes — check the Workflow Manager logs, then Re-run.",
    };
  }
  return { state: "pending" };
}
