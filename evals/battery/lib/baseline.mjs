// Baseline-mode math (TEAM-3405): repeat quorum, per-case aggregation over
// scored runs, and whole-run deadline resolution. Pure and injectable so the
// rules run-battery.mjs enforces are unit-testable without a Bedrock run.

// Whole-run watchdog default; baseline mode's DEFAULT scales with --repeat
// (a repeat-3 baseline run is ~3× a gate run) while an explicit
// BATTERY_RUN_DEADLINE_SECONDS is honored verbatim in every mode.
export const DEFAULT_RUN_DEADLINE_SECONDS = 13 * 60;

/** Minimum scored runs out of N for a case to be baseline-eligible: ceil(2N/3). */
export function baselineQuorum(repeat) {
  return Math.ceil((2 * repeat) / 3);
}

/**
 * @param {{ baselineMode: boolean, repeat: number, explicitSeconds?: number|null, defaultSeconds?: number }} args
 * @returns {{ seconds: number, autoScaled: boolean }}
 */
export function resolveRunDeadline({
  baselineMode,
  repeat,
  explicitSeconds = null,
  defaultSeconds = DEFAULT_RUN_DEADLINE_SECONDS,
}) {
  if (explicitSeconds != null) return { seconds: explicitSeconds, autoScaled: false };
  return baselineMode
    ? { seconds: defaultSeconds * repeat, autoScaled: true }
    : { seconds: defaultSeconds, autoScaled: false };
}

/**
 * Aggregate one case's repeat runs into a candidate baseline entry.
 * Per-evaluator mean/min/max are computed over the SCORED runs only; a case
 * below quorum yields no entry (`belowQuorum: true`) and must fail the whole
 * baseline generation — soundness is preserved, never averaged around.
 *
 * @param {{ def: { id: string, evaluators: string[] }, results: Array<{ id: string, status: string, scores: Record<string, number> }>, quorum: number }} args
 * @returns {{ id: string, runsScored: number, runsAttempted: number, belowQuorum: boolean, entry?: any }}
 */
export function aggregateBaselineCase({ def, results, quorum }) {
  const attempted = results.filter((r) => r.id === def.id);
  const scored = attempted.filter((r) => r.status === "scored");
  const counts = { id: def.id, runsScored: scored.length, runsAttempted: attempted.length };
  if (scored.length < quorum) return { ...counts, belowQuorum: true };
  const evaluators = {};
  for (const evaluator of def.evaluators) {
    const xs = scored.map((r) => r.scores[evaluator]).filter((x) => typeof x === "number");
    evaluators[evaluator] = {
      mean: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100,
      min: Math.min(...xs),
      max: Math.max(...xs),
      n: xs.length,
    };
  }
  // runsScored/runsAttempted keep the artifact honest about its sample size;
  // consumers (thresholds.mjs, preflight) read only `evaluators`.
  return {
    ...counts,
    belowQuorum: false,
    entry: { evaluators, runsScored: scored.length, runsAttempted: attempted.length },
  };
}
