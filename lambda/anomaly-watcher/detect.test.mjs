/**
 * Unit tests for the anomaly-watcher detection core (§3.6 of the design).
 *   node --test    (from lambda/anomaly-watcher/)
 *
 * detect.mjs is PURE, so every case here is a plain in/out assertion — no AWS
 * mocks, no clock control, no js-yaml (metric configs are hand-built in the
 * shape bands-schema.mjs normalizes to, so this file needs no npm install).
 *
 * The baseline fixture is chosen so the statistics are EXACT, not approximate:
 * 50×90 + 50×110 + 1×100 → n=101, mean exactly 100, sample stddev exactly 10.
 * That makes the inclusive tier edges (exactly 1.0σ / 2.0σ / 3.0σ) meaningful —
 * an alternating 90/110 baseline gives σ≈10.0504 and `mean + σ` lands a ulp
 * below the edge, which would fail as if `>=` were broken.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MAX_CONTRIBUTORS,
  MAX_RECENT_POINTS,
  aggregate,
  canonicalWindowStart,
  detect,
  hourBucket,
} from "./detect.mjs";

// ─── fixtures ──────────────────────────────────────────────────────────────────

const WINDOWS = Object.freeze({
  baselineStart: "2026-08-20T14:00:00Z",
  baselineEnd: "2026-08-27T13:00:00Z",
  evalStart: "2026-08-27T13:00:00Z",
  evalEnd: "2026-08-27T14:00:00Z",
});

/** One validated bands.yaml duration metric; floors inert unless overridden. */
function durationMetric(overrides = {}) {
  return {
    id: "agent_task_duration_ms",
    enabled: true,
    direction: "upper",
    aggregation: "duration_ms",
    source: {
      kind: "events",
      startTypes: ["agent.invoked"],
      endTypes: ["agent.complete", "workflow.report_completion"],
      groupBy: "fleet",
    },
    baselineWindow: "7d",
    evaluationWindow: "1h",
    sigmaThresholds: { tier1: 1, tier2: 2, tier3: 3 },
    minSamples: { baselineBuckets: 24, evalSamples: 1 },
    stddevFloor: { epsilon: 0, relFloor: 0 },
    westernElectric: { rules: [1, 2, 3] },
    suppression: { tier3Ttl: "6h", tier2Ttl: "2h" },
    diagnosis: { maxTargets: 2 },
    ...overrides,
  };
}

function rateMetric(overrides = {}) {
  return {
    id: "agent_error_retry_rate",
    enabled: true,
    direction: "upper",
    aggregation: "rate",
    source: {
      kind: "events",
      numeratorTypes: ["agent.error", "agent.retry"],
      denominatorTypes: ["agent.invoked"],
      groupBy: "fleet",
    },
    baselineWindow: "7d",
    evaluationWindow: "1h",
    sigmaThresholds: { tier1: 1, tier2: 2, tier3: 3 },
    minSamples: { baselineBuckets: 24, evalSamples: 5, bucketDenominator: 10 },
    stddevFloor: { epsilon: 0.05, relFloor: 0.25 },
    westernElectric: { rules: [1, 2, 3] },
    suppression: { tier3Ttl: "6h", tier2Ttl: "2h" },
    diagnosis: { maxTargets: 2 },
    ...overrides,
  };
}

/** n=101, mean exactly 100, sample stddev exactly 10. */
function exactBaseline() {
  return [
    ...Array.from({ length: 50 }, () => ({ value: 90 })),
    ...Array.from({ length: 50 }, () => ({ value: 110 })),
    { value: 100 },
  ];
}

/** Flat baseline of `n` identical values — raw stddev exactly 0. */
function flatBaseline(value, n) {
  return Array.from({ length: n }, () => ({ value }));
}

/**
 * detect() with the exact baseline and sane defaults. Eval values are given as
 * integers (110 = 1.0σ, 120 = 2.0σ, …) so the sigma division is exact.
 */
function classify(evalValue, opts = {}) {
  const {
    metric = durationMetric(),
    baselinePoints = exactBaseline(),
    evalSampleCount = 20,
    recentPoints = [],
    contributors = [],
    groupKey = "fleet",
  } = opts;
  return detect(
    { baselinePoints, evalValue, evalSampleCount, recentPoints, contributors },
    { metric, windows: WINDOWS, groupKey }
  );
}

const sigmas = (...values) => values.map((sigma) => ({ evalEnd: WINDOWS.evalEnd, sigma }));

// ─── §3.6 cases 1–7: tier resolution, inclusive edges ──────────────────────────

test("§3.6 case 1: exactly 1.0σ is tier1 (thresholds are INCLUSIVE)", () => {
  const v = classify(110);
  assert.equal(v.sigma, 1);
  assert.equal(v.tier, 1);
  assert.equal(v.status, "anomaly");
  assert.deepEqual(v.rulesTriggered, []);
});

test("§3.6 case 2: exactly 2.0σ is tier2 — full verdict shape (§3.1)", () => {
  const v = classify(120);
  assert.deepEqual(v, {
    metricId: "agent_task_duration_ms",
    groupKey: "fleet",
    status: "anomaly",
    tier: 2,
    observed: 120,
    baselineMean: 100,
    baselineStddev: 10,
    effectiveStddev: 10,
    sigma: 2,
    direction: "upper",
    rulesTriggered: [],
    sampleCount: { baselineBuckets: 101, evalSamples: 20 },
    windows: { ...WINDOWS },
    contributors: [],
    insufficientReason: null,
  });
});

test("§3.6 case 3: exactly 3.0σ is tier3 via rule 1", () => {
  const v = classify(130);
  assert.equal(v.sigma, 3);
  assert.equal(v.tier, 3);
  assert.deepEqual(v.rulesTriggered, ["we1"]);
});

test("§3.6 case 4: 0.9σ is ok / tier0", () => {
  const v = classify(109);
  assert.equal(v.sigma, 0.9);
  assert.equal(v.tier, 0);
  assert.equal(v.status, "ok");
  assert.equal(v.insufficientReason, null);
});

test("§3.6 case 5: 1.5σ is tier1", () => {
  const v = classify(115);
  assert.equal(v.sigma, 1.5);
  assert.equal(v.tier, 1);
});

test("§3.6 case 6: 2.5σ is tier2", () => {
  const v = classify(125);
  assert.equal(v.sigma, 2.5);
  assert.equal(v.tier, 2);
  assert.deepEqual(v.rulesTriggered, []);
});

test("§3.6 case 7: 3.5σ is tier3", () => {
  const v = classify(135);
  assert.equal(v.sigma, 3.5);
  assert.equal(v.tier, 3);
  assert.deepEqual(v.rulesTriggered, ["we1"]);
});

// ─── §3.6 cases 8–12: the insufficient-sample guards ───────────────────────────

test("§3.6 case 8: empty baseline is insufficient_sample / below_min_baseline_buckets", () => {
  const v = classify(130, { baselinePoints: [] });
  assert.equal(v.status, "insufficient_sample");
  assert.equal(v.tier, 0);
  assert.equal(v.insufficientReason, "below_min_baseline_buckets");
  assert.equal(v.sampleCount.baselineBuckets, 0);
  assert.equal(v.baselineMean, null);
  assert.equal(v.baselineStddev, null);
  assert.equal(v.sigma, null);
});

test("§3.6 case 9: a single baseline bucket stops before the n−1 stddev", () => {
  // Even with baselineBuckets configured at the schema floor of 2, n=1 must not
  // reach `variance / (n - 1)` — that is a divide by zero.
  const v = classify(130, {
    baselinePoints: [{ value: 100 }],
    metric: durationMetric({ minSamples: { baselineBuckets: 2, evalSamples: 1 } }),
  });
  assert.equal(v.status, "insufficient_sample");
  assert.equal(v.insufficientReason, "below_min_baseline_buckets");
  assert.equal(v.sampleCount.baselineBuckets, 1);
  assert.equal(v.sigma, null);
});

test("§3.6 case 10: min−1 buckets with a 50σ outlier still refuses to classify", () => {
  const v = classify(600, {
    baselinePoints: flatBaseline(100, 23), // minSamples.baselineBuckets is 24
  });
  assert.equal(v.status, "insufficient_sample");
  assert.equal(v.tier, 0);
  assert.equal(v.insufficientReason, "below_min_baseline_buckets");
  assert.equal(v.sampleCount.baselineBuckets, 23);
  assert.equal(v.sigma, null);
  assert.deepEqual(v.rulesTriggered, []);
});

test("§3.6 case 11: a null evalValue is no_source_events_in_window, never a zero anomaly", () => {
  const v = classify(null);
  assert.equal(v.status, "insufficient_sample");
  assert.equal(v.tier, 0);
  assert.equal(v.insufficientReason, "no_source_events_in_window");
  // The absent-source rule (§2.2): missing data must not become an observed 0.
  assert.equal(v.observed, null);
  assert.notEqual(v.observed, 0);
  // The baseline was still counted, so the evidence can say how much history exists.
  assert.equal(v.sampleCount.baselineBuckets, 101);
});

test("§3.6 case 11b: undefined and NaN evalValues take the same guard", () => {
  for (const evalValue of [undefined, NaN, "130"]) {
    const v = classify(evalValue);
    assert.equal(v.insufficientReason, "no_source_events_in_window", `for ${String(evalValue)}`);
    assert.equal(v.observed, null);
  }
});

test("§3.6 case 12: evalSampleCount one below the minimum is below_min_eval_samples", () => {
  const metric = durationMetric({ minSamples: { baselineBuckets: 24, evalSamples: 10 } });
  const v = classify(130, { metric, evalSampleCount: 9 });
  assert.equal(v.status, "insufficient_sample");
  assert.equal(v.tier, 0);
  assert.equal(v.insufficientReason, "below_min_eval_samples");
  assert.equal(v.sampleCount.evalSamples, 9);
  // The value is still reported — it just cannot be trusted to classify.
  assert.equal(v.observed, 130);
  assert.equal(v.sigma, null);

  // Exactly at the minimum it classifies.
  const at = classify(130, { metric, evalSampleCount: 10 });
  assert.equal(at.status, "anomaly");
  assert.equal(at.tier, 3);
});

// ─── §3.6 case 13: the stddev floor ────────────────────────────────────────────

test("§3.6 case 13: epsilon floor turns a zero-variance baseline into 0.8σ / ok", () => {
  const v = classify(104, {
    baselinePoints: flatBaseline(100, 24),
    metric: durationMetric({ stddevFloor: { epsilon: 5, relFloor: 0 } }),
  });
  assert.equal(v.baselineMean, 100);
  assert.equal(v.baselineStddev, 0);
  assert.equal(v.effectiveStddev, 5);
  assert.equal(v.sigma, 0.8);
  assert.equal(v.tier, 0);
  assert.equal(v.status, "ok");
});

test("§3.6 case 13b: the floor suppresses a 15σ artifact from a near-flat baseline", () => {
  // 12×100 + 12×100.5 → mean 100.25, raw σ = sqrt(1.5/23) ≈ 0.2554.
  const baselinePoints = [...flatBaseline(100, 12), ...flatBaseline(100.5, 12)];
  const metric = durationMetric({ stddevFloor: { epsilon: 5, relFloor: 0 } });
  const v = classify(104.25, { baselinePoints, metric });
  assert.equal(v.baselineMean, 100.25);
  assert.equal(v.baselineStddev, Math.sqrt(1.5 / 23));
  // Unfloored this is a ~15σ "anomaly" out of half a millisecond of jitter.
  assert.ok(4 / v.baselineStddev > 3, "raw sigma should have exceeded tier3");
  assert.equal(v.effectiveStddev, 5);
  assert.equal(v.sigma, 0.8);
  assert.equal(v.tier, 0);
});

test("§3.6 case 13c: relFloor floors relative to |mean| and wins when it is largest", () => {
  const metric = rateMetric({ stddevFloor: { epsilon: 0.05, relFloor: 0.25 } });
  const v = classify(0.5, {
    metric,
    baselinePoints: Array.from({ length: 24 }, () => ({ value: 0.25, denominator: 20 })),
    evalSampleCount: 20,
  });
  assert.equal(v.baselineMean, 0.25);
  assert.equal(v.baselineStddev, 0);
  assert.equal(v.effectiveStddev, 0.0625); // max(0, 0.05, 0.25 × 0.25)
  assert.equal(v.sigma, 4);
  assert.equal(v.tier, 3);
});

test("effectiveStddev 0 (no variance, no floors) reports 0σ rather than ±Infinity", () => {
  const v = classify(130, { baselinePoints: flatBaseline(100, 24) });
  assert.equal(v.effectiveStddev, 0);
  assert.equal(v.sigma, 0);
  assert.equal(v.tier, 0);
  assert.equal(v.status, "ok");
});

// ─── §3.6 case 14: direction ───────────────────────────────────────────────────

test("§3.6 case 14: direction lower ignores an upward spike and fires on a drop", () => {
  const metric = durationMetric({ direction: "lower" });
  const up = classify(130, { metric });
  assert.equal(up.sigma, 3);
  assert.equal(up.tier, 0);
  assert.equal(up.status, "ok");
  assert.deepEqual(up.rulesTriggered, []);

  const down = classify(70, { metric });
  assert.equal(down.sigma, -3);
  assert.equal(down.tier, 3);
  assert.equal(down.status, "anomaly");
  assert.deepEqual(down.rulesTriggered, ["we1"]);
  assert.equal(down.direction, "lower");
});

test("direction both fires on either side", () => {
  const metric = durationMetric({ direction: "both" });
  assert.equal(classify(130, { metric }).tier, 3);
  assert.equal(classify(70, { metric }).tier, 3);
  assert.equal(classify(109, { metric }).tier, 0);
  assert.equal(classify(91, { metric }).tier, 0);
});

// ─── §3.6 cases 15–18: Western Electric rules 2–3 ──────────────────────────────

test("§3.6 case 15: rule 2 — 2 of the last 3 beyond tier2", () => {
  const v = classify(122, { recentPoints: sigmas(2.4, 0.5) });
  assert.equal(v.sigma, 2.2);
  assert.equal(v.tier, 2);
  assert.deepEqual(v.rulesTriggered, ["we2"]);
});

test("§3.6 case 15b: rule 2 alone promotes a tier1 reading to tier2", () => {
  // 1.5σ is only tier1 on its own; two of the last three beyond 2σ escalate it.
  const v = classify(115, { recentPoints: sigmas(2.4, 2.3) });
  assert.equal(v.sigma, 1.5);
  assert.equal(v.tier, 2);
  assert.deepEqual(v.rulesTriggered, ["we2"]);
});

test("§3.6 case 15c: rule 2 does NOT trigger on the wrong side (direction upper)", () => {
  const v = classify(78, { recentPoints: sigmas(-2.4, -2.5) });
  assert.equal(v.sigma, -2.2);
  assert.equal(v.tier, 0);
  assert.equal(v.status, "ok");
  assert.deepEqual(v.rulesTriggered, []);
});

test("§3.6 case 15d: direction both requires the run to be on ONE side", () => {
  const metric = durationMetric({ direction: "both" });

  // Mixed signs: only the current point is on the current side → 1 hit < 2.
  const mixed = classify(78, { metric, recentPoints: sigmas(2.4, 2.5) });
  assert.equal(mixed.sigma, -2.2);
  assert.deepEqual(mixed.rulesTriggered, []);
  assert.equal(mixed.tier, 2, "still tier2 via the plain band, not via we2");

  // Consistently negative: |σ| beyond the threshold on the same side → rule 2.
  const consistent = classify(78, { metric, recentPoints: sigmas(-2.4, -2.5) });
  assert.deepEqual(consistent.rulesTriggered, ["we2"]);
});

test("§3.6 case 16: rule 3 — 4 of the last 5 beyond tier1", () => {
  const v = classify(113, { recentPoints: sigmas(1.2, 1.4, 0.2, 1.1) });
  assert.equal(v.sigma, 1.3);
  assert.equal(v.tier, 2, "rule 3 promotes what would be a tier1 reading");
  assert.deepEqual(v.rulesTriggered, ["we3"]);
});

test("§3.6 case 16b: rule 3 does NOT trigger on the wrong side", () => {
  const v = classify(87, { recentPoints: sigmas(-1.2, -1.4, -0.2, -1.1) });
  assert.equal(v.sigma, -1.3);
  assert.equal(v.tier, 0);
  assert.deepEqual(v.rulesTriggered, []);
});

test("§3.6 case 16c: rule 3 needs 4 hits, not 3", () => {
  // Two of the last five are inside the band → 3 hits, no promotion.
  const v = classify(113, { recentPoints: sigmas(1.2, 0.4, 0.2, 1.1) });
  assert.equal(v.tier, 1);
  assert.deepEqual(v.rulesTriggered, []);
});

test("§3.6 case 17: rule 1 and rule 2 together — tier3, both listed", () => {
  const v = classify(135, { recentPoints: sigmas(2.5, 2.5) });
  assert.equal(v.sigma, 3.5);
  assert.equal(v.tier, 3);
  assert.deepEqual(v.rulesTriggered, ["we1", "we2"]);
});

test("§3.6 case 17b: all three rules can be listed at once, tier stays 3", () => {
  const v = classify(135, { recentPoints: sigmas(2.5, 2.5, 2.5, 2.5) });
  assert.equal(v.tier, 3);
  assert.deepEqual(v.rulesTriggered, ["we1", "we2", "we3"]);
});

test("§3.6 case 18: too few recentPoints — tier2 via the plain band, no rules", () => {
  const v = classify(125, { recentPoints: sigmas(2.4) });
  assert.equal(v.sigma, 2.5);
  assert.equal(v.tier, 2);
  assert.deepEqual(v.rulesTriggered, [], "a 2-point series cannot satisfy rule 2 or 3");
});

test("§3.6 case 18b: an empty recentPoints history never blocks rule 1", () => {
  const v = classify(130, { recentPoints: [] });
  assert.equal(v.tier, 3);
  assert.deepEqual(v.rulesTriggered, ["we1"]);
});

test("only the last MAX_RECENT_POINTS prior points are considered", () => {
  // Nine priors, but rule 3 looks at a 5-wide window over the last 5 priors + now.
  const stale = sigmas(1.9, 1.9, 1.9, 1.9, 0.2, 0.2, 0.2, 0.2);
  const v = classify(113, { recentPoints: stale });
  assert.equal(MAX_RECENT_POINTS, 5);
  assert.deepEqual(v.rulesTriggered, [], "stale points beyond the window must not count");
  assert.equal(v.tier, 1);
});

test("recentPoints entries without a finite sigma are ignored, not treated as 0", () => {
  const v = classify(122, {
    recentPoints: [
      { evalEnd: WINDOWS.evalEnd, sigma: 2.4 },
      { evalEnd: WINDOWS.evalEnd },
      { evalEnd: WINDOWS.evalEnd, sigma: null },
      { evalEnd: WINDOWS.evalEnd, sigma: 0.5 },
    ],
  });
  assert.deepEqual(v.rulesTriggered, ["we2"]);
});

test("westernElectric.rules gates each rule independently", () => {
  const onlyRule1 = durationMetric({ westernElectric: { rules: [1] } });
  const v = classify(122, { metric: onlyRule1, recentPoints: sigmas(2.4, 0.5) });
  assert.deepEqual(v.rulesTriggered, [], "rule 2 is disabled for this metric");
  assert.equal(v.tier, 2, "the plain 2σ band still applies");

  const noRule1 = durationMetric({ westernElectric: { rules: [2, 3] } });
  const w = classify(135, { metric: noRule1 });
  assert.deepEqual(w.rulesTriggered, []);
  assert.equal(w.tier, 2, "without rule 1 nothing can reach tier3");
});

// ─── §3.6 case 19: determinism + input immutability ────────────────────────────

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

test("§3.6 case 19: same input ⇒ same output, three times, inputs unmutated", () => {
  const samples = {
    baselinePoints: exactBaseline(),
    evalValue: 122,
    evalSampleCount: 20,
    recentPoints: sigmas(2.4, 0.5),
    contributors: [
      { workflowId: "wf_b", value: 100 },
      { workflowId: "wf_a", value: 300 },
    ],
  };
  const config = { metric: durationMetric(), windows: { ...WINDOWS }, groupKey: "fleet" };
  const samplesSnapshot = structuredClone(samples);
  const configSnapshot = structuredClone(config);

  // Frozen inputs: any write attempt throws in ESM strict mode.
  deepFreeze(samples);
  deepFreeze(config);

  const a = detect(samples, config);
  const b = detect(samples, config);
  const c = detect(samples, config);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(b, c);

  assert.deepStrictEqual(samples, samplesSnapshot, "samples must not be mutated");
  assert.deepStrictEqual(config, configSnapshot, "config must not be mutated");

  // The returned verdict is fresh state, not a view onto the inputs.
  assert.notEqual(a.contributors, samples.contributors);
  assert.notEqual(a.windows, config.windows);
});

// ─── §3.6 case 20: contributors ────────────────────────────────────────────────

test("§3.6 case 20: contributors are ranked desc with their share of the total", () => {
  const v = classify(130, {
    contributors: [
      { workflowId: "wf_b", value: 100 },
      { workflowId: "wf_a", value: 300 },
    ],
  });
  assert.deepEqual(v.contributors, [
    { workflowId: "wf_a", value: 300, share: 0.75 },
    { workflowId: "wf_b", value: 100, share: 0.25 },
  ]);
});

test("§3.6 case 20b: contributors are capped at MAX_CONTRIBUTORS, shares stay over the full total", () => {
  const v = classify(130, {
    contributors: [
      { workflowId: "wf_c", value: 200 },
      { workflowId: "wf_a", value: 400 },
      { workflowId: "wf_d", value: 100 },
      { workflowId: "wf_b", value: 300 },
    ],
  });
  assert.equal(MAX_CONTRIBUTORS, 3);
  assert.equal(v.contributors.length, 3);
  assert.deepEqual(v.contributors, [
    { workflowId: "wf_a", value: 400, share: 0.4 },
    { workflowId: "wf_b", value: 300, share: 0.3 },
    { workflowId: "wf_c", value: 200, share: 0.2 },
  ]);
  // Shares are of the observed total (1000), so the kept three sum to < 1 —
  // the dropped tail is visible as the missing 10%.
  const kept = v.contributors.reduce((acc, c) => acc + c.share, 0);
  assert.ok(Math.abs(kept - 0.9) < 1e-12, `kept shares summed to ${kept}`);
});

test("contributor ties break by workflowId ascending so diagnosis targets are stable", () => {
  const v = classify(130, {
    contributors: [
      { workflowId: "wf_z", value: 100 },
      { workflowId: "wf_a", value: 100 },
      { workflowId: "wf_m", value: 100 },
    ],
  });
  assert.deepEqual(v.contributors.map((c) => c.workflowId), ["wf_a", "wf_m", "wf_z"]);
});

test("non-numeric contributors are dropped and a zero total yields 0 shares", () => {
  const v = classify(130, {
    contributors: [
      { workflowId: "wf_a", value: "300" },
      { workflowId: "wf_b" },
      null,
      { workflowId: "wf_c", value: 0 },
    ],
  });
  assert.deepEqual(v.contributors, [{ workflowId: "wf_c", value: 0, share: 0 }]);
});

test("contributors survive the insufficient-sample guards (evidence still names them)", () => {
  const v = classify(null, { contributors: [{ workflowId: "wf_a", value: 5 }] });
  assert.equal(v.status, "insufficient_sample");
  assert.deepEqual(v.contributors, [{ workflowId: "wf_a", value: 5, share: 1 }]);
});

// ─── disabled metrics (§3.5) ───────────────────────────────────────────────────

test("a disabled metric is never evaluated", () => {
  const v = classify(600, { metric: durationMetric({ enabled: false }) });
  assert.equal(v.status, "disabled");
  assert.equal(v.tier, 0);
  assert.equal(v.sigma, null);
  assert.equal(v.observed, null);
  assert.equal(v.insufficientReason, null);
});

// ─── hand-computed statistics ──────────────────────────────────────────────────

test("mean and sample stddev match a hand-computed fixture (n−1 denominator)", () => {
  // [2,4,4,4,5,5,7,9] → mean 5, Σ(x−mean)² = 32, sample variance 32/7.
  const values = [2, 4, 4, 4, 5, 5, 7, 9];
  const v = classify(5, {
    baselinePoints: values.map((value) => ({ value })),
    metric: durationMetric({
      minSamples: { baselineBuckets: 2, evalSamples: 1 },
      stddevFloor: { epsilon: 0, relFloor: 0 },
    }),
  });
  assert.equal(v.sampleCount.baselineBuckets, 8);
  assert.equal(v.baselineMean, 5);
  assert.equal(v.baselineStddev, Math.sqrt(32 / 7));
  // Population stddev would be sqrt(32/8) = 2 — the n−1 form is deliberately larger.
  assert.notEqual(v.baselineStddev, 2);
  assert.ok(v.baselineStddev > 2);
  assert.equal(v.sigma, 0);
});

test("baseline points with an unusable value are dropped from the statistics", () => {
  const v = classify(130, {
    baselinePoints: [
      ...flatBaseline(100, 24),
      { value: null },
      { value: "100" },
      {},
      null,
      { value: NaN },
    ],
  });
  assert.equal(v.sampleCount.baselineBuckets, 24);
  assert.equal(v.baselineMean, 100);
});

// ─── bucketDenominator filtering (§3.2) ────────────────────────────────────────

test("rate baselines drop buckets below minSamples.bucketDenominator", () => {
  const baselinePoints = [
    ...Array.from({ length: 20 }, () => ({ value: 0.25, denominator: 20 })),
    // Two 1-invocation hours at a 100% error rate: real data, useless as a baseline.
    { value: 1, denominator: 1 },
    { value: 1, denominator: 2 },
  ];
  const metric = rateMetric({
    minSamples: { baselineBuckets: 10, evalSamples: 5, bucketDenominator: 10 },
    stddevFloor: { epsilon: 0, relFloor: 0 },
  });
  const v = classify(0.25, { metric, baselinePoints, evalSampleCount: 20 });
  assert.equal(v.sampleCount.baselineBuckets, 20, "the two thin buckets are excluded");
  assert.equal(v.baselineMean, 0.25);
  assert.equal(v.baselineStddev, 0);

  // Same data with the filter turned off: the thin buckets drag the mean up and
  // inflate the stddev, which is exactly what would mask a real anomaly.
  const unfiltered = classify(0.25, {
    metric: rateMetric({
      minSamples: { baselineBuckets: 10, evalSamples: 5, bucketDenominator: 0 },
      stddevFloor: { epsilon: 0, relFloor: 0 },
    }),
    baselinePoints,
    evalSampleCount: 20,
  });
  assert.equal(unfiltered.sampleCount.baselineBuckets, 22);
  assert.equal(unfiltered.baselineMean, 7 / 22); // (20 × 0.25 + 1 + 1) / 22
  assert.ok(unfiltered.baselineMean > 0.31, `mean was ${unfiltered.baselineMean}`);
  assert.ok(
    unfiltered.baselineStddev > 0.2 && unfiltered.baselineStddev > v.baselineStddev,
    `stddev was ${unfiltered.baselineStddev}`
  );
});

test("a rate bucket exactly at bucketDenominator qualifies (inclusive)", () => {
  const metric = rateMetric({
    minSamples: { baselineBuckets: 2, evalSamples: 1, bucketDenominator: 10 },
  });
  const v = classify(0.25, {
    metric,
    baselinePoints: [
      { value: 0.25, denominator: 10 },
      { value: 0.25, denominator: 10 },
      { value: 0.25, denominator: 9 },
    ],
    evalSampleCount: 10,
  });
  assert.equal(v.sampleCount.baselineBuckets, 2);
});

test("duration metrics ignore denominators entirely", () => {
  // bucketDenominator is not even valid config for duration_ms, so a missing
  // denominator must never disqualify a bucket.
  const v = classify(130, { baselinePoints: exactBaseline() });
  assert.equal(v.sampleCount.baselineBuckets, 101);
  assert.equal(v.baselineMean, 100);
});

// ─── window helpers ────────────────────────────────────────────────────────────

test("canonicalWindowStart floors to the window, UTC, second precision", () => {
  assert.equal(canonicalWindowStart("2026-08-27T14:27:31Z", 600_000), "2026-08-27T14:20:00Z");
  assert.equal(canonicalWindowStart("2026-08-27T14:20:00Z", 600_000), "2026-08-27T14:20:00Z");
  assert.equal(canonicalWindowStart("2026-08-27T14:29:59.999Z", 600_000), "2026-08-27T14:20:00Z");
  assert.equal(canonicalWindowStart("2026-08-27T14:30:00Z", 600_000), "2026-08-27T14:30:00Z");
  assert.equal(canonicalWindowStart(Date.parse("2026-08-27T14:27:31Z"), 3_600_000), "2026-08-27T14:00:00Z");
  assert.throws(() => canonicalWindowStart("2026-08-27T14:27:31Z", 0), TypeError);
  assert.throws(() => canonicalWindowStart("not a time", 600_000), TypeError);
});

test("hourBucket keys by the event's own ISO timestamp", () => {
  assert.equal(hourBucket("2026-08-27T13:59:59Z"), "2026-08-27T13");
  assert.equal(hourBucket("2026-08-27T14:00:00Z"), "2026-08-27T14");
});

// ─── aggregate() (§4.1–§4.2) ───────────────────────────────────────────────────

const evt = (eventId, type, timestamp, detail = {}, workflowId = "wf_1") => ({
  workflowId, eventId, type, timestamp, detail,
});

const bandsWith = (...metrics) => ({ version: 1, metrics });

test("aggregate dedupes a double-written event (same tuple, different eventId)", () => {
  const detail = { ticketId: "T-1", agentId: "agentcore_hub_backend_dev" };
  const events = [
    // The same logical error, written once by the EventBridge path and once directly.
    evt("1756300000000-a", "agent.error", "2026-08-27T13:40:00Z", detail),
    evt("1756300000001-b", "agent.error", "2026-08-27T13:40:00Z", detail),
    evt("1756299000000-c", "agent.invoked", "2026-08-27T13:05:00Z", detail),
  ];
  const r = aggregate(events, bandsWith(rateMetric()));
  assert.equal(r.stats.eventsRead, 3);
  assert.equal(r.stats.eventsDeduped, 1);
  assert.deepEqual(r.bucketDeltas, [
    { metricId: "agent_error_retry_rate", groupKey: "fleet", bucket: "2026-08-27T13", num: 1, den: 1 },
  ]);
});

test("aggregate keeps events that differ in any tuple field", () => {
  const events = [
    evt("1", "agent.error", "2026-08-27T13:40:00Z", { ticketId: "T-1", agentId: "a1" }),
    evt("2", "agent.error", "2026-08-27T13:40:00Z", { ticketId: "T-2", agentId: "a1" }),
    evt("3", "agent.error", "2026-08-27T13:40:00Z", { ticketId: "T-1", agentId: "a2" }),
    evt("4", "agent.error", "2026-08-27T13:41:00Z", { ticketId: "T-1", agentId: "a1" }),
  ];
  const r = aggregate(events, bandsWith(rateMetric()));
  assert.equal(r.stats.eventsDeduped, 0);
  assert.equal(r.bucketDeltas[0].num, 4);
});

test("aggregate drops agent.streaming but still advances the cursor past it", () => {
  const events = [
    evt("1756299000000-a", "agent.invoked", "2026-08-27T13:05:00Z", { ticketId: "T-1" }),
    evt("1756300000000-z", "agent.streaming", "2026-08-27T13:36:00Z", { ticketId: "T-1" }),
  ];
  const r = aggregate(events, bandsWith(rateMetric()));
  assert.equal(r.stats.streamingDropped, 1);
  assert.equal(r.bucketDeltas.length, 1);
  assert.equal(r.bucketDeltas[0].den, 1);
  assert.equal(r.bucketDeltas[0].num, 0, "streaming is never a numerator");
  // Dropped noise must not be re-read next cycle.
  assert.deepEqual(r.newCursor, {
    wf_1: { lastEventId: "1756300000000-z", lastTimestamp: "2026-08-27T13:36:00Z", count: 2 },
  });
});

test("aggregate skips items with no usable timestamp instead of throwing", () => {
  const events = [
    evt("1", "agent.invoked", "2026-08-27T13:05:00Z", { ticketId: "T-1" }),
    evt("2", "agent.error", "not-a-timestamp", { ticketId: "T-1" }),
    { workflowId: "wf_1", eventId: "3", type: "agent.error", detail: { ticketId: "T-1" } },
  ];
  const r = aggregate(events, bandsWith(rateMetric()));
  assert.equal(r.stats.unbucketable, 2);
  assert.equal(r.bucketDeltas[0].num, 0);
  assert.equal(r.bucketDeltas[0].den, 1);
});

test("aggregate buckets by the event timestamp, not the eventId prefix", () => {
  // A late-arriving event: its eventId was minted now, but it happened yesterday.
  const events = [
    evt("1756400000000-late", "agent.error", "2026-08-26T09:15:00Z", { ticketId: "T-9" }),
  ];
  const r = aggregate(events, bandsWith(rateMetric()));
  assert.equal(r.bucketDeltas[0].bucket, "2026-08-26T09");
});

test("aggregate pairs a duration across two cycles via openPairs", () => {
  const bands = bandsWith(durationMetric());
  const first = aggregate(
    [evt("1", "agent.invoked", "2026-08-27T13:05:00Z", { ticketId: "T-1", agentId: "a1" })],
    bands
  );
  assert.deepEqual(first.bucketDeltas, [], "an unfinished task contributes no sample");
  assert.equal(first.openPairs.length, 1);
  assert.equal(first.openPairs[0].ticketId, "T-1");
  assert.equal(first.openPairs[0].metricId, "agent_task_duration_ms");
  assert.equal(first.stats.openPairs, 1);

  const second = aggregate(
    [evt("2", "agent.complete", "2026-08-27T13:35:00Z", { ticketId: "T-1", agentId: "a1" })],
    bands,
    { openPairs: first.openPairs }
  );
  const thirtyMin = 30 * 60 * 1000;
  assert.deepEqual(second.bucketDeltas, [
    {
      metricId: "agent_task_duration_ms",
      groupKey: "fleet",
      // Bucketed by the TERMINAL event — that is when the sample became observable.
      bucket: "2026-08-27T13",
      n: 1,
      sum: thirtyMin,
      sumSq: thirtyMin * thirtyMin,
    },
  ]);
  assert.deepEqual(second.openPairs, [], "the pair is closed and no longer carried");
});

test("aggregate pairs within one batch and accepts workflow.report_completion as terminal", () => {
  const r = aggregate(
    [
      evt("1", "agent.invoked", "2026-08-27T13:00:00Z", { ticketId: "T-1", agentId: "a1" }),
      evt("2", "agent.complete", "2026-08-27T13:10:00Z", { ticketId: "T-1", agentId: "a1" }),
      evt("3", "agent.invoked", "2026-08-27T13:00:00Z", { ticketId: "T-2", agentId: "a1" }),
      evt("4", "workflow.report_completion", "2026-08-27T13:20:00Z", { ticketId: "T-2", agentId: "a1" }),
    ],
    bandsWith(durationMetric())
  );
  assert.equal(r.bucketDeltas.length, 1);
  assert.equal(r.bucketDeltas[0].n, 2);
  assert.equal(r.bucketDeltas[0].sum, 10 * 60 * 1000 + 20 * 60 * 1000);
  assert.deepEqual(r.openPairs, []);
});

test("aggregate carries a start whose only terminal event predates it", () => {
  // A stale completion from a previous attempt must not become a negative sample.
  const r = aggregate(
    [
      evt("1", "agent.complete", "2026-08-27T12:00:00Z", { ticketId: "T-1", agentId: "a1" }),
      evt("2", "agent.invoked", "2026-08-27T13:00:00Z", { ticketId: "T-1", agentId: "a1" }),
    ],
    bandsWith(durationMetric())
  );
  assert.deepEqual(r.bucketDeltas, []);
  assert.equal(r.openPairs.length, 1);
});

test("aggregate ignores carried openPairs with an unparseable timestamp", () => {
  const r = aggregate(
    [evt("2", "agent.complete", "2026-08-27T13:35:00Z", { ticketId: "T-1" })],
    bandsWith(durationMetric()),
    { openPairs: [{ metricId: "agent_task_duration_ms", ticketId: "T-1", timestamp: "garbage" }, null] }
  );
  assert.deepEqual(r.bucketDeltas, [], "a corrupt cursor row must not fail the fold");
});

test("aggregate groups by a detail path and skips unattributable events", () => {
  const metric = rateMetric({
    source: { ...rateMetric().source, groupBy: "detail.agentId" },
  });
  const r = aggregate(
    [
      evt("1", "agent.invoked", "2026-08-27T13:00:00Z", { ticketId: "T-1", agentId: "a1" }),
      evt("2", "agent.error", "2026-08-27T13:10:00Z", { ticketId: "T-1", agentId: "a1" }),
      evt("3", "agent.invoked", "2026-08-27T13:00:00Z", { ticketId: "T-2", agentId: "a2" }),
      // No agentId → cannot be attributed to a band anyone can act on.
      evt("4", "agent.error", "2026-08-27T13:20:00Z", { ticketId: "T-3" }),
    ],
    bandsWith(metric)
  );
  assert.deepEqual(r.bucketDeltas.map((d) => [d.groupKey, d.num, d.den]), [
    ["a1", 1, 1],
    ["a2", 0, 1],
  ]);
});

test("aggregate applies a flat where matcher with equals", () => {
  const metric = rateMetric({
    source: { ...rateMetric().source, where: { "detail.agentId": { equals: "a1" } } },
  });
  const r = aggregate(
    [
      evt("1", "agent.invoked", "2026-08-27T13:00:00Z", { ticketId: "T-1", agentId: "a1" }),
      evt("2", "agent.error", "2026-08-27T13:10:00Z", { ticketId: "T-1", agentId: "a1" }),
      evt("3", "agent.invoked", "2026-08-27T13:00:00Z", { ticketId: "T-2", agentId: "a2" }),
      evt("4", "agent.error", "2026-08-27T13:20:00Z", { ticketId: "T-2", agentId: "a2" }),
    ],
    bandsWith(metric)
  );
  assert.deepEqual(r.bucketDeltas, [
    { metricId: "agent_error_retry_rate", groupKey: "fleet", bucket: "2026-08-27T13", num: 1, den: 1 },
  ]);
});

test("aggregate applies where matchers with in and startsWith", () => {
  const events = [
    evt("1", "agent.invoked", "2026-08-27T13:00:00Z", { ticketId: "T-1", agentId: "agentcore_hub_backend_dev" }),
    evt("2", "agent.invoked", "2026-08-27T13:00:00Z", { ticketId: "T-2", agentId: "agentcore_hub_qa" }),
    evt("3", "agent.invoked", "2026-08-27T13:00:00Z", { ticketId: "T-3", agentId: "external_tool" }),
  ];
  const src = rateMetric().source;

  const inMatcher = aggregate(
    events,
    bandsWith(rateMetric({ source: { ...src, where: { "detail.agentId": { in: ["agentcore_hub_qa", "external_tool"] } } } }))
  );
  assert.equal(inMatcher.bucketDeltas[0].den, 2);

  const prefix = aggregate(
    events,
    bandsWith(rateMetric({ source: { ...src, where: { "detail.agentId": { startsWith: "agentcore_hub_" } } } }))
  );
  assert.equal(prefix.bucketDeltas[0].den, 2);

  // startsWith against a non-string value simply does not match.
  const nonString = aggregate(
    [evt("4", "agent.invoked", "2026-08-27T13:00:00Z", { ticketId: "T-4", agentId: 7 })],
    bandsWith(rateMetric({ source: { ...src, where: { "detail.agentId": { startsWith: "7" } } } }))
  );
  assert.deepEqual(nonString.bucketDeltas, []);
});

test("aggregate applies a roled where to the numerator only", () => {
  const metric = rateMetric({
    source: {
      ...rateMetric().source,
      where: { numerator: { "agent.error": { "detail.agentId": { equals: "a1" } } } },
    },
  });
  const r = aggregate(
    [
      evt("1", "agent.invoked", "2026-08-27T13:00:00Z", { ticketId: "T-1", agentId: "a1" }),
      evt("2", "agent.error", "2026-08-27T13:10:00Z", { ticketId: "T-1", agentId: "a1" }),
      evt("3", "agent.invoked", "2026-08-27T13:00:00Z", { ticketId: "T-2", agentId: "a2" }),
      // Excluded from the numerator by the roled matcher…
      evt("4", "agent.error", "2026-08-27T13:20:00Z", { ticketId: "T-2", agentId: "a2" }),
      // …while agent.retry is unconstrained (the role names only agent.error).
      evt("5", "agent.retry", "2026-08-27T13:30:00Z", { ticketId: "T-2", agentId: "a2" }),
    ],
    bandsWith(metric)
  );
  assert.deepEqual(r.bucketDeltas, [
    { metricId: "agent_error_retry_rate", groupKey: "fleet", bucket: "2026-08-27T13", num: 2, den: 2 },
  ]);
});

test("aggregate ignores snapshot metrics and unknown aggregations", () => {
  const snapshot = {
    id: "eval_score_avg",
    enabled: true,
    direction: "lower",
    aggregation: "snapshot_delta_avg",
    source: { kind: "eval-config-snapshot", groupBy: "agentId" },
  };
  const r = aggregate(
    [evt("1", "agent.invoked", "2026-08-27T13:00:00Z", { ticketId: "T-1", agentId: "a1" })],
    bandsWith(snapshot, { id: "", enabled: true })
  );
  assert.deepEqual(r.bucketDeltas, [], "eval scores are not event-sourced");
});

test("aggregate output ordering is deterministic and independent of read order", () => {
  const events = [
    evt("3", "agent.error", "2026-08-27T14:10:00Z", { ticketId: "T-2", agentId: "a2" }),
    evt("1", "agent.invoked", "2026-08-27T13:00:00Z", { ticketId: "T-1", agentId: "a1" }),
    evt("2", "agent.error", "2026-08-27T13:10:00Z", { ticketId: "T-1", agentId: "a1" }),
  ];
  const bands = bandsWith(rateMetric({ source: { ...rateMetric().source, groupBy: "detail.agentId" } }));
  const forward = aggregate(events, bands);
  const reversed = aggregate(events.slice().reverse(), bands);
  assert.deepEqual(forward.bucketDeltas, reversed.bucketDeltas);
  assert.deepEqual(
    forward.bucketDeltas.map((d) => `${d.groupKey}/${d.bucket}`),
    ["a1/2026-08-27T13", "a2/2026-08-27T14"]
  );
});

test("aggregate tolerates junk input without throwing", () => {
  for (const events of [null, undefined, "nope", [null, 3, "x"]]) {
    const r = aggregate(events, bandsWith(rateMetric()));
    assert.deepEqual(r.bucketDeltas, []);
  }
  const noMetrics = aggregate([evt("1", "agent.error", "2026-08-27T13:00:00Z", { ticketId: "T" })], null);
  assert.deepEqual(noMetrics.bucketDeltas, []);
  assert.equal(noMetrics.stats.eventsRead, 1);
});

test("aggregate does not mutate its inputs", () => {
  const events = [
    evt("1", "agent.invoked", "2026-08-27T13:00:00Z", { ticketId: "T-1", agentId: "a1" }),
    evt("2", "agent.complete", "2026-08-27T13:30:00Z", { ticketId: "T-1", agentId: "a1" }),
  ];
  const bands = bandsWith(durationMetric(), rateMetric());
  const prior = { openPairs: [] };
  const snapshot = structuredClone({ events, bands, prior });
  aggregate(deepFreeze(events), deepFreeze(bands), deepFreeze(prior));
  assert.deepStrictEqual({ events, bands, prior }, snapshot);
});

// ─── purity (§3, enforced as a test on the source text) ────────────────────────

const PURE_MODULES = ["./detect.mjs", "./bands-schema.mjs"];

/** Every static/dynamic import specifier in an ES module's source. */
function importsOf(source) {
  const specs = [];
  const re = /(?:^|\n)\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/g;
  let match;
  while ((match = re.exec(source)) !== null) specs.push(match[1]);
  return specs;
}

test("the pure modules contain no I/O, clock, randomness, or model-client tokens", () => {
  // §3: detect.mjs must be a function of its arguments alone. A text scan is
  // crude but it is the check that survives refactors — an added `Date.now()`
  // fails here long before it corrupts a fixture.
  const banned = [
    { token: "@aws-sdk", ci: false },
    { token: "fetch(", ci: false },
    { token: "Date.now", ci: false },
    { token: "Math.random", ci: false },
    { token: "process.env", ci: false },
    { token: "bedrock", ci: true },
    { token: "anthropic", ci: true },
  ];

  for (const specifier of PURE_MODULES) {
    const source = readFileSync(new URL(specifier, import.meta.url), "utf8");
    for (const { token, ci } of banned) {
      const haystack = ci ? source.toLowerCase() : source;
      const needle = ci ? token.toLowerCase() : token;
      assert.equal(
        haystack.includes(needle),
        false,
        `${specifier} must not contain "${token}"`
      );
    }
    assert.equal(/\bimport\s*\(/.test(source), false, `${specifier} must not import dynamically`);
    assert.equal(/\brequire\s*\(/.test(source), false, `${specifier} must not use require()`);
  }
});

test("detect.mjs imports only ./bands-schema.mjs, which imports nothing", () => {
  const detectSource = readFileSync(new URL("./detect.mjs", import.meta.url), "utf8");
  assert.deepEqual(importsOf(detectSource), ["./bands-schema.mjs"]);

  const schemaSource = readFileSync(new URL("./bands-schema.mjs", import.meta.url), "utf8");
  assert.deepEqual(importsOf(schemaSource), []);
});
