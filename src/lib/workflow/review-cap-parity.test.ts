import { describe, it, expect } from "vitest";
import {
  resolveReviewGateCap as resolveTs,
  REVIEW_GATE_CAP_DEFAULTS as DEFAULTS_TS,
  REVIEW_GATE_MAX_ROUNDS_CEILING as CEILING_TS,
} from "./workflow-defs";
// The orchestrator (Lambda) port. Both copies MUST agree bit-for-bit — a drift
// means the web app's view of a gate's cap and the orchestrator's enforcement of
// it disagree about when the rework loop ends, which is the runaway-rework bug
// TEAM-3619 D2c closes and TEAM-3685 Finding 3 tightened.
import {
  resolveReviewGateCap as resolveMjs,
  REVIEW_GATE_CAP_DEFAULTS as DEFAULTS_MJS,
  REVIEW_GATE_MAX_ROUNDS_CEILING as CEILING_MJS,
} from "../../../lambda/orchestrator/review-cap.mjs";
import type { ReviewGate } from "./workflow-defs";

/**
 * TEAM-3685 parity contract: feed the SAME gate-config matrix through both
 * resolveReviewGateCap implementations and assert identical resolved caps. Same
 * role as lease-parity.test.ts (TEAM-3618) and ship-review-parity.test.ts
 * (TEAM-3619) — the guard that keeps a hand-port honest, here specifically over
 * the guard rails: the lower "finite and >= 1" fallback and the upper clamp at
 * REVIEW_GATE_MAX_ROUNDS_CEILING.
 *
 * The matrix is deliberately full of values a TypeScript signature forbids
 * ("3", null, {}): workflows.json is hand-editable, so at runtime the type is a
 * promise, not a fact, and BOTH twins have to mishandle those inputs the same
 * way.
 */

// Numbers around every boundary: the lower guard (0/1), the fractional floor,
// the ceiling (19/20/21), and the "looks configured but disables the cap" values.
const MAX_ROUNDS_CASES: unknown[] = [
  undefined,
  0,
  0.5,
  1,
  1.9,
  2,
  3,
  4.7,
  5,
  18,
  19,
  19.5,
  20,
  20.0001,
  20.9,
  21,
  22,
  100,
  1e6,
  1e9,
  1e9 + 0.5,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_VALUE,
  -0,
  -1,
  -20,
  -1e9,
  NaN,
  Infinity,
  -Infinity,
  Number.EPSILON,
  "3",
  "20",
  "1e9",
  "",
  null,
  true,
  false,
  {},
  [],
  [5],
];

const REGRESSION_CASES: unknown[] = [undefined, true, false, null, "false", 0];
const ON_CAP_CASES: unknown[] = [undefined, "escalate", "ignore", null, ""];

/** A gate carrying only the pre-existing required fields. */
const bareGate = (overrides: Record<string, unknown> = {}) =>
  ({
    afterPhase: "ship",
    name: "Merge Approval",
    blocking: true,
    condition: "always",
    onReject: "rework",
    ...overrides,
  }) as unknown as ReviewGate;

describe("resolveReviewGateCap parity: workflow-defs.ts ≡ review-cap.mjs", () => {
  it("agrees on every maxRounds × regressionCountsDouble × onCapReached combination", () => {
    let compared = 0;
    for (const maxRounds of MAX_ROUNDS_CASES) {
      for (const regressionCountsDouble of REGRESSION_CASES) {
        for (const onCapReached of ON_CAP_CASES) {
          const gate = bareGate({ maxRounds, regressionCountsDouble, onCapReached });
          const label =
            `maxRounds=${String(maxRounds)} regressionCountsDouble=${String(regressionCountsDouble)} ` +
            `onCapReached=${String(onCapReached)}`;
          expect(resolveMjs(gate), `mismatch for ${label}`).toEqual(resolveTs(gate));
          compared++;
        }
      }
    }
    expect(compared).toBe(
      MAX_ROUNDS_CASES.length * REGRESSION_CASES.length * ON_CAP_CASES.length
    );
  });

  it("agrees when the cap fields are absent entirely, and on the shared defaults", () => {
    expect(resolveMjs(bareGate())).toEqual(resolveTs(bareGate()));
    expect(resolveMjs(bareGate())).toEqual(DEFAULTS_TS);
    // The two default objects are the same values, not just the same shape —
    // they are duplicated across a Lambda/app boundary and must be kept in sync.
    expect(DEFAULTS_MJS).toEqual(DEFAULTS_TS);
    expect(CEILING_MJS).toBe(CEILING_TS);
    expect(CEILING_TS).toBe(20);
  });

  it("agrees on the clamp boundary specifically", () => {
    // The behaviour Finding 3 added: > ceiling clamps DOWN to the ceiling in both
    // twins, rather than one clamping and the other falling back to 3.
    for (const maxRounds of [19, 20, 21, 1e9]) {
      const gate = bareGate({ maxRounds });
      const ts = resolveTs(gate);
      expect(resolveMjs(gate)).toEqual(ts);
      expect(ts.maxRounds).toBe(Math.min(maxRounds, CEILING_TS));
    }
  });

  it("documents the ONE deliberate asymmetry: a missing gate object", () => {
    // The orchestrator can reach enforcement with gateCfg === null (a rejection
    // on a gate whose phase has no config), so the .mjs twin optional-chains and
    // resolves to the defaults — the safe direction, since an unconfigured gate
    // still gets a cap. The TS twin's signature requires a gate and it reads
    // `gate.maxRounds` directly, so it throws instead. This is asserted rather
    // than smoothed over: the two are NOT interchangeable on null, and a future
    // change that makes the TS side silently return defaults should have to come
    // through this test.
    for (const missing of [undefined, null]) {
      expect(resolveMjs(missing as unknown as ReviewGate)).toEqual(DEFAULTS_TS);
      expect(() => resolveTs(missing as unknown as ReviewGate)).toThrow(TypeError);
    }
  });

  it("neither implementation mutates the gate it was handed", () => {
    for (const maxRounds of [1e9, 21, 5, "3", undefined]) {
      const tsGate = bareGate({ maxRounds });
      const mjsGate = bareGate({ maxRounds });
      resolveTs(tsGate);
      resolveMjs(mjsGate);
      expect(tsGate).toEqual(bareGate({ maxRounds }));
      expect(mjsGate).toEqual(tsGate);
    }
  });
});
