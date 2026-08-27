// Pure gate math (FR-3): normalization, floor derivation, delta table, suite
// verdict. Fail-closed by construction — a partial or unscored run is NEVER a
// pass. Numbers per evals/battery/thresholds.json.

export const SCALE = "0-100";

// Evaluator native scores are 0.0–1.0 (see deploy/evaluations/
// dependency_chain_evaluator.json ratingScale); ×100 at ingestion.
export function normalizeScore(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return Math.round(n * 100 * 100) / 100;
}

// floor = baseline mean − floorDelta, clamped up to minAbsoluteFloor;
// a case file's evaluator_floors entry overrides the derivation entirely.
/** @param {{ baselineMean: number, thresholds: any, override?: number|null }} args */
export function deriveFloor({ baselineMean, thresholds, override }) {
  if (override !== undefined && override !== null) return override;
  return Math.max(baselineMean - thresholds.floorRule.floorDelta, thresholds.floorRule.minAbsoluteFloor);
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round2 = (x) => Math.round(x * 100) / 100;

/**
 * caseResults: [{ id, status, scores: {evaluator: 0-100}, evaluator_floors?, error? }]
 *   status ∈ scored | errored | timed_out | skipped | unscored | failed_forbidden_tool
 * newCaseIds: ids added in this PR (or ALL active ids when baseline.bootstrap)
 *   — these run informational: scores reported, no delta verdict; but a
 *   non-scored new case still fails the gate.
 *
 * @param {{ thresholds: any, baseline: any, caseResults: any[], newCaseIds?: string[], costEstimateUsd?: number, scoringBackend?: string }} args
 */
export function evaluateSuite({ thresholds, baseline, caseResults, newCaseIds, costEstimateUsd, scoringBackend }) {
  const failureReasons = [];
  const deltaRows = [];
  const newIds = new Set(baseline?.bootstrap === true ? caseResults.map((c) => c.id) : newCaseIds || []);

  if (scoringBackend && baseline?.scoringBackend && baseline.scoringBackend !== scoringBackend) {
    failureReasons.push(
      `scoring backend mismatch: baseline '${baseline.scoringBackend}' vs current '${scoringBackend}' — fail closed`
    );
  }

  const baselinePairs = [];
  const currentPairs = [];

  for (const result of caseResults) {
    const isNew = newIds.has(result.id);

    if (result.status !== "scored") {
      // (c) errored/timed_out/skipped/unscored/forbidden — partial run is never a pass.
      failureReasons.push(
        `case ${result.id}: status '${result.status}'${result.error ? ` (${result.error})` : ""} — non-scored case fails the gate`
      );
      continue;
    }

    const baselineCase = baseline?.cases?.[result.id];
    if (!isNew && !baselineCase) {
      // (e) pre-existing case missing from baseline ⇒ fail closed.
      failureReasons.push(
        `case ${result.id}: pre-existing case missing from baseline.json — fail closed (baseline is regenerated only by the merge-to-main workflow)`
      );
      continue;
    }

    for (const [evaluator, current] of Object.entries(result.scores || {})) {
      if (isNew) {
        deltaRows.push({ case: result.id, evaluator, baseline: null, current, delta: null, floor: null, verdict: "informational" });
        continue;
      }
      const stats = baselineCase.evaluators?.[evaluator];
      if (!stats || typeof stats.mean !== "number") {
        failureReasons.push(`case ${result.id}: evaluator '${evaluator}' has no baseline stats — fail closed`);
        continue;
      }
      const floor = deriveFloor({
        baselineMean: stats.mean,
        thresholds,
        override: result.evaluator_floors?.[evaluator],
      });
      const delta = round2(current - stats.mean);
      const breached = current < floor;
      deltaRows.push({
        case: result.id,
        evaluator,
        baseline: round2(stats.mean),
        current: round2(current),
        delta,
        floor: round2(floor),
        verdict: breached ? "floor_breach" : "pass",
      });
      if (breached) {
        // (b) any floor breach fails the suite.
        failureReasons.push(
          `case ${result.id}, evaluator ${evaluator}: current ${round2(current)} < floor ${round2(floor)} (baseline mean ${round2(stats.mean)})`
        );
      }
      baselinePairs.push(stats.mean);
      currentPairs.push(current);
    }
  }

  // (a) overall drop, strictly greater than the allowance (exactly 5.00 passes).
  let overallBaseline = null;
  let overallCurrent = null;
  let overallDelta = null;
  if (baselinePairs.length > 0) {
    overallBaseline = round2(mean(baselinePairs));
    overallCurrent = round2(mean(currentPairs));
    overallDelta = round2(overallCurrent - overallBaseline);
    const drop = overallBaseline - overallCurrent;
    if (drop > thresholds.overallDropMaxPoints) {
      failureReasons.push(
        `overall mean dropped ${round2(drop)} points (baseline ${overallBaseline} → current ${overallCurrent}); allowed drop is ${thresholds.overallDropMaxPoints} (strict)`
      );
    }
  }

  // (d) budget.
  if (typeof costEstimateUsd === "number" && costEstimateUsd > thresholds.maxRunUsd) {
    failureReasons.push(
      `FAIL: budget exceeded — estimated $${costEstimateUsd.toFixed(2)} > maxRunUsd $${thresholds.maxRunUsd.toFixed(2)}`
    );
  }

  return {
    verdict: failureReasons.length === 0 ? "PASS" : "FAIL",
    failureReasons,
    deltaRows,
    informationalCases: [...newIds].filter((id) => caseResults.some((c) => c.id === id)),
    summary: { overallBaseline, overallCurrent, overallDelta, scale: SCALE },
  };
}
