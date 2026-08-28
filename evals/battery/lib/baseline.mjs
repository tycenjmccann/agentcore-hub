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

// Per-case top-up budget: a below-quorum case after the main N-run pass gets
// up to this many extra runs (stopping at quorum). With per-run failure rate
// p = 0.3 and repeat 3, P(below quorum) drops from ~22% to ~3%.
export const MAX_TOPUP_RUNS = 2;

/**
 * Top-up one below-quorum case: run extra attempts (via `runOnce`, results
 * pushed into `results`) until quorum is reached or the top-up budget is
 * spent. Returns the number of top-up runs used. Baseline mode only — the
 * caller never invokes this in gate mode.
 *
 * @param {{ def: any, results: any[], quorum: number, repeat: number, runOnce: (def: any) => Promise<any>, maxTopUps?: number, log?: (msg: string) => void }} args
 */
export async function topUpCase({ def, results, quorum, repeat, runOnce, maxTopUps = MAX_TOPUP_RUNS, log = () => {} }) {
  const scoredCount = () => results.filter((r) => r.id === def.id && r.status === "scored").length;
  let used = 0;
  while (scoredCount() < quorum && used < maxTopUps) {
    used++;
    log(`↻ top-up run for ${def.id} (scored ${scoredCount()}/${repeat + used - 1}, need ${quorum})`);
    results.push(await runOnce(def));
  }
  return used;
}

/**
 * Aggregate one case's repeat runs into a candidate baseline entry.
 * Per-evaluator mean/min/max are computed over the SCORED runs only; a case
 * below quorum yields no entry (`belowQuorum: true`) and must fail the whole
 * baseline generation — soundness is preserved, never averaged around.
 *
 * @param {{ def: { id: string, evaluators: string[] }, results: Array<{ id: string, status: string, scores: Record<string, number> }>, quorum: number, topUpRuns?: number }} args
 * @returns {{ id: string, runsScored: number, runsAttempted: number, topUpRuns: number, belowQuorum: boolean, entry?: any }}
 */
export function aggregateBaselineCase({ def, results, quorum, topUpRuns = 0 }) {
  const attempted = results.filter((r) => r.id === def.id);
  const scored = attempted.filter((r) => r.status === "scored");
  const counts = { id: def.id, runsScored: scored.length, runsAttempted: attempted.length, topUpRuns };
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
  // runsScored/runsAttempted/topUpRuns keep the artifact honest about its
  // sample size; consumers (thresholds.mjs, preflight) read only `evaluators`.
  return {
    ...counts,
    belowQuorum: false,
    entry: { evaluators, runsScored: scored.length, runsAttempted: attempted.length, topUpRuns },
  };
}
