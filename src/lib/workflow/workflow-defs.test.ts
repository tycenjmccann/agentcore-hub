import { describe, it, expect } from "vitest";
import {
  REVIEW_GATE_CAP_DEFAULTS,
  REVIEW_GATE_MAX_ROUNDS_CEILING,
  resolveReviewGateCap,
  WORKFLOW_DEFS,
  getWorkflowDef,
} from "./workflow-defs";
import type { ReviewGate } from "./workflow-defs";

/** A gate with only the pre-existing required fields — no cap config at all. */
function bareGate(overrides: Partial<ReviewGate> = {}): ReviewGate {
  return {
    afterPhase: "ship",
    name: "Merge Approval",
    blocking: true,
    condition: "always",
    onReject: "rework",
    ...overrides,
  };
}

describe("resolveReviewGateCap — defaults", () => {
  it("a gate with no cap fields resolves to 3 / true / escalate", () => {
    expect(resolveReviewGateCap(bareGate())).toEqual({
      maxRounds: 3,
      regressionCountsDouble: true,
      onCapReached: "escalate",
    });
  });

  it("the exported defaults match what the resolver applies (single source of truth)", () => {
    expect(resolveReviewGateCap(bareGate())).toEqual(REVIEW_GATE_CAP_DEFAULTS);
  });

  it("regressionCountsDouble: false is honored, not swallowed by the default", () => {
    // `??` not `||` — the whole point of this case.
    expect(resolveReviewGateCap(bareGate({ regressionCountsDouble: false })).regressionCountsDouble)
      .toBe(false);
  });

  it("resolving does not mutate the gate", () => {
    const gate = bareGate();
    resolveReviewGateCap(gate);
    expect(gate.maxRounds).toBeUndefined();
    expect(gate.regressionCountsDouble).toBeUndefined();
    expect(gate.onCapReached).toBeUndefined();
  });
});

describe("resolveReviewGateCap — config override (AC-D2.2a)", () => {
  it("an explicit maxRounds overrides the default", () => {
    expect(resolveReviewGateCap(bareGate({ maxRounds: 5 })).maxRounds).toBe(5);
    expect(resolveReviewGateCap(bareGate({ maxRounds: 1 })).maxRounds).toBe(1);
  });

  it("all three fields override together", () => {
    expect(
      resolveReviewGateCap(
        bareGate({ maxRounds: 7, regressionCountsDouble: false, onCapReached: "escalate" })
      )
    ).toEqual({ maxRounds: 7, regressionCountsDouble: false, onCapReached: "escalate" });
  });

  it("out-of-range / non-numeric maxRounds falls back to the default instead of a cap that never or always fires", () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      expect(resolveReviewGateCap(bareGate({ maxRounds: bad })).maxRounds).toBe(3);
    }
    // hand-edited JSON can put anything here; TS type is a lie at runtime
    for (const bad of ["4", null, undefined, {}]) {
      expect(
        resolveReviewGateCap(bareGate({ maxRounds: bad as unknown as number })).maxRounds
      ).toBe(3);
    }
  });

  it("a fractional maxRounds floors to a whole round", () => {
    expect(resolveReviewGateCap(bareGate({ maxRounds: 4.7 })).maxRounds).toBe(4);
  });
});

describe("resolveReviewGateCap — upper clamp (TEAM-3685 Finding 3)", () => {
  it("clamps an over-ceiling maxRounds to the ceiling, NOT to the default", () => {
    // `maxRounds: 1e9` passed every earlier guard — a cap that never fires,
    // configured in a way that reads as intentional. Clamping down preserves the
    // "lots of rounds" intent while removing the unboundedness; falling back to 3
    // would silently contradict the config instead.
    expect(REVIEW_GATE_MAX_ROUNDS_CEILING).toBe(20);
    for (const huge of [21, 100, 1e9, Number.MAX_SAFE_INTEGER]) {
      expect(resolveReviewGateCap(bareGate({ maxRounds: huge })).maxRounds).toBe(
        REVIEW_GATE_MAX_ROUNDS_CEILING
      );
      expect(resolveReviewGateCap(bareGate({ maxRounds: huge })).maxRounds).not.toBe(
        REVIEW_GATE_CAP_DEFAULTS.maxRounds
      );
    }
    // A fractional over-ceiling value floors and clamps to the same place.
    expect(resolveReviewGateCap(bareGate({ maxRounds: 20.9 })).maxRounds).toBe(20);
    expect(resolveReviewGateCap(bareGate({ maxRounds: 1e9 + 0.5 })).maxRounds).toBe(20);
  });

  it("values at or under the ceiling are untouched", () => {
    for (const ok of [1, 2, 3, 5, 19, 20]) {
      expect(resolveReviewGateCap(bareGate({ maxRounds: ok })).maxRounds).toBe(ok);
    }
  });

  it("Infinity is not finite, so it takes the default rather than the ceiling", () => {
    // The lower guard runs first: Number.isFinite(Infinity) is false, so this is
    // a malformed value (default 3), not a huge-but-honest one (clamp to 20).
    expect(resolveReviewGateCap(bareGate({ maxRounds: Infinity })).maxRounds).toBe(
      REVIEW_GATE_CAP_DEFAULTS.maxRounds
    );
    expect(resolveReviewGateCap(bareGate({ maxRounds: Infinity })).maxRounds).not.toBe(
      REVIEW_GATE_MAX_ROUNDS_CEILING
    );
    expect(resolveReviewGateCap(bareGate({ maxRounds: -Infinity })).maxRounds).toBe(3);
  });

  it("the ceiling leaves the other two fields alone", () => {
    expect(
      resolveReviewGateCap(bareGate({ maxRounds: 1e9, regressionCountsDouble: false }))
    ).toEqual({ maxRounds: 20, regressionCountsDouble: false, onCapReached: "escalate" });
  });
});

describe("workflows.json ship-review gate config (D2c)", () => {
  const shipGates = WORKFLOW_DEFS.flatMap((w) =>
    (w.reviewGates || [])
      .filter((g) => g.afterPhase === "ship")
      .map((g) => ({ workflow: w.id, gate: g }))
  );

  it("every ship gate sets the cap config explicitly", () => {
    expect(shipGates.length).toBeGreaterThan(0);
    for (const { workflow, gate } of shipGates) {
      expect(gate.maxRounds, `${workflow} maxRounds`).toBe(3);
      expect(gate.regressionCountsDouble, `${workflow} regressionCountsDouble`).toBe(true);
      expect(gate.onCapReached, `${workflow} onCapReached`).toBe("escalate");
    }
  });

  it("the default workflow's ship gate resolves to the documented cap", () => {
    const gate = (getWorkflowDef().reviewGates || []).find((g) => g.afterPhase === "ship");
    expect(gate).toBeDefined();
    expect(resolveReviewGateCap(gate!)).toEqual({
      maxRounds: 3,
      regressionCountsDouble: true,
      onCapReached: "escalate",
    });
  });

  it("non-ship gates are left without cap config (the cap is a ship-review concern)", () => {
    const others = WORKFLOW_DEFS.flatMap((w) => (w.reviewGates || [])).filter(
      (g) => g.afterPhase !== "ship"
    );
    for (const g of others) {
      expect(g.maxRounds).toBeUndefined();
      expect(g.regressionCountsDouble).toBeUndefined();
      expect(g.onCapReached).toBeUndefined();
    }
    // ...and they still resolve to the safe defaults if a consumer asks.
    for (const g of others) {
      expect(resolveReviewGateCap(g)).toEqual(REVIEW_GATE_CAP_DEFAULTS);
    }
  });
});
