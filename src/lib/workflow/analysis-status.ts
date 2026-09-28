/**
 * What the Workflow Manager panel should show while a Run Analysis it started is
 * in flight (TEAM-5226). Pure, so the decision is unit-testable: before this the
 * panel only ever stopped on a NEW analysis, and a failed ANALYZE (the harness
 * dying on MaxTokensReachedException) read as "Analyzing…" for 10 minutes and
 * then silently reset to the old state. TEAM-5240: a failure only ends the poll
 * when it is THIS attempt's (a concurrent auto run can fail meanwhile), and the
 * cutoff outlasts the analyzer Lambda's 15-minute maximum.
 */
import type { AnalysisFailure, WorkflowAnalysis } from "./analysis-types";

/** Longer than the analyzer Lambda's 900s timeout + the auto-trigger delay. */
export const ANALYSIS_POLL_TIMEOUT_MS = 20 * 60_000;

export type AnalysisPollState = "pending" | "done" | "failed" | "timeout";

export interface AnalysisPollInput {
  /** analysisId of the latest analysis when Run Analysis was clicked. */
  baselineId: string | null;
  latest: WorkflowAnalysis | null | undefined;
  /** The attemptId POST /analyze returned; null until it has answered. */
  attemptId: string | null;
  /** From GET /analysis?attempt=<id>; ignored unless it names that attempt. */
  latestFailure: AnalysisFailure | null | undefined;
  now: number;
  pollUntil: number;
}

/** The one-line error the panel shows for a failed ANALYZE. */
export function analysisFailureMessage(f: AnalysisFailure): string {
  const d = f.detail || ({} as AnalysisFailure["detail"]);
  const attempts = d.attempts ? ` after ${d.attempts} attempt${d.attempts === 1 ? "" : "s"}` : "";
  const why = d.message ? ` — ${d.message}` : "";
  return `Analysis failed: ${d.errorClass || "Error"}${attempts}${why}`;
}

export function analysisPollOutcome(i: AnalysisPollInput): { state: AnalysisPollState; message?: string } {
  // A new analysis wins: a failed attempt followed by a successful manual
  // re-run (or a slow first attempt) must not show an error over a good result.
  if (i.latest && i.latest.analysisId !== i.baselineId) return { state: "done" };
  if (i.latestFailure && i.attemptId && i.latestFailure.detail?.attemptId === i.attemptId) {
    return { state: "failed", message: analysisFailureMessage(i.latestFailure) };
  }
  if (i.now > i.pollUntil) {
    return {
      state: "timeout",
      message: `No analysis after ${ANALYSIS_POLL_TIMEOUT_MS / 60_000} minutes — check the Workflow Manager logs, then Re-run.`,
    };
  }
  return { state: "pending" };
}
