// Gate math (design §5.2 matrix). Pure — no fs, no AWS.
import { describe, it, expect } from "vitest";
import { evaluateSuite, deriveFloor, normalizeScore } from "../lib/thresholds.mjs";

const THRESHOLDS = {
  overallDropMaxPoints: 5,
  floorRule: { floorDelta: 10, minAbsoluteFloor: 40 },
  maxRunUsd: 20.0,
};

const baselineWith = (cases: Record<string, Record<string, number>>) => ({
  scoringBackend: "local-judge",
  bootstrap: false,
  cases: Object.fromEntries(
    Object.entries(cases).map(([id, evs]) => [
      id,
      { evaluators: Object.fromEntries(Object.entries(evs).map(([e, mean]) => [e, { mean, min: mean, max: mean, n: 3 }])) },
    ])
  ),
});

const run = (overrides: Partial<Parameters<typeof evaluateSuite>[0]>) =>
  evaluateSuite({
    thresholds: THRESHOLDS,
    baseline: baselineWith({}),
    caseResults: [],
    newCaseIds: [],
    costEstimateUsd: 0,
    scoringBackend: "local-judge",
    ...overrides,
  });

describe("overall drop rule (strict > 5.00)", () => {
  it("PASSes on a drop of exactly 5.00 with floors held", () => {
    const suite = run({
      baseline: baselineWith({ a: { "Builtin.Correctness": 90 } }),
      caseResults: [{ id: "a", status: "scored", scores: { "Builtin.Correctness": 85 } }],
    });
    expect(suite.verdict).toBe("PASS");
    expect(suite.summary.overallDelta).toBe(-5);
  });

  it("FAILs on a drop of 5.01", () => {
    const suite = run({
      baseline: baselineWith({ a: { "Builtin.Correctness": 90 } }),
      caseResults: [{ id: "a", status: "scored", scores: { "Builtin.Correctness": 84.99 } }],
    });
    expect(suite.verdict).toBe("FAIL");
    expect(suite.failureReasons.join()).toMatch(/overall mean dropped/);
  });

  it("PASSes when all within floors and drop ≤ 5", () => {
    const suite = run({
      baseline: baselineWith({ a: { "Builtin.Correctness": 90, "Builtin.Helpfulness": 80 } }),
      caseResults: [
        { id: "a", status: "scored", scores: { "Builtin.Correctness": 88, "Builtin.Helpfulness": 81 } },
      ],
    });
    expect(suite.verdict).toBe("PASS");
    expect(suite.failureReasons).toEqual([]);
  });
});

describe("floor rule", () => {
  it("FAILs on a single floor breach even when every other cell improved, naming case+evaluator+numbers", () => {
    const suite = run({
      baseline: baselineWith({
        a: { "Builtin.Correctness": 80 },
        b: { "Builtin.Correctness": 80, "Builtin.Helpfulness": 80 },
      }),
      caseResults: [
        { id: "a", status: "scored", scores: { "Builtin.Correctness": 60 } }, // floor 70 → breach
        { id: "b", status: "scored", scores: { "Builtin.Correctness": 95, "Builtin.Helpfulness": 95 } },
      ],
    });
    expect(suite.verdict).toBe("FAIL");
    const reason = suite.failureReasons.find((r: string) => r.includes("floor"));
    expect(reason).toContain("case a");
    expect(reason).toContain("Builtin.Correctness");
    expect(reason).toContain("60");
    expect(reason).toContain("70");
  });

  it("clamps the derived floor to minAbsoluteFloor when baseline mean is 45", () => {
    expect(deriveFloor({ baselineMean: 45, thresholds: THRESHOLDS })).toBe(40);
    const suite = run({
      baseline: baselineWith({ a: { "Builtin.Correctness": 45 } }),
      caseResults: [{ id: "a", status: "scored", scores: { "Builtin.Correctness": 41 } }],
    });
    expect(suite.deltaRows[0].floor).toBe(40);
    expect(suite.deltaRows[0].verdict).toBe("pass");
  });

  it("case-file evaluator_floors overrides the derived floor", () => {
    // Derived floor would be 85 (mean 95 − 10); override 80 lets 82 pass.
    const suite = run({
      baseline: baselineWith({ a: { "Builtin.Correctness": 95 } }),
      caseResults: [
        {
          id: "a",
          status: "scored",
          scores: { "Builtin.Correctness": 82 },
          evaluator_floors: { "Builtin.Correctness": 80 },
        },
      ],
    });
    expect(suite.deltaRows[0].floor).toBe(80);
    expect(suite.deltaRows[0].verdict).toBe("pass");
    // Drop of 13 still trips the overall rule — the override only moves the floor.
    expect(suite.failureReasons.join()).toMatch(/overall mean dropped/);
  });
});

describe("partial runs never pass", () => {
  for (const status of ["errored", "timed_out", "skipped", "unscored", "failed_forbidden_tool"]) {
    it(`FAILs when a case is ${status}`, () => {
      const suite = run({
        baseline: baselineWith({ a: { "Builtin.Correctness": 90 }, bad: { "Builtin.Correctness": 90 } }),
        caseResults: [
          { id: "a", status: "scored", scores: { "Builtin.Correctness": 90 } },
          { id: "bad", status, error: "boom" },
        ],
      });
      expect(suite.verdict).toBe("FAIL");
      expect(suite.failureReasons.join()).toContain(`case bad: status '${status}'`);
    });
  }
});

describe("baseline coverage (fail closed)", () => {
  it("FAILs when a pre-existing case is absent from the baseline", () => {
    const suite = run({
      baseline: baselineWith({ a: { "Builtin.Correctness": 90 } }),
      caseResults: [
        { id: "a", status: "scored", scores: { "Builtin.Correctness": 90 } },
        { id: "orphan", status: "scored", scores: { "Builtin.Correctness": 99 } },
      ],
    });
    expect(suite.verdict).toBe("FAIL");
    expect(suite.failureReasons.join()).toContain("orphan");
    expect(suite.failureReasons.join()).toContain("missing from baseline");
  });

  it("FAILs on scoring backend mismatch", () => {
    const suite = run({
      baseline: { ...baselineWith({}), scoringBackend: "agentcore-ondemand" },
      caseResults: [],
    });
    expect(suite.verdict).toBe("FAIL");
    expect(suite.failureReasons.join()).toContain("backend mismatch");
  });
});

describe("new-case semantics", () => {
  it("treats a PR-added case as informational (no delta verdict)", () => {
    const suite = run({
      baseline: baselineWith({ a: { "Builtin.Correctness": 90 } }),
      newCaseIds: ["fresh"],
      caseResults: [
        { id: "a", status: "scored", scores: { "Builtin.Correctness": 90 } },
        { id: "fresh", status: "scored", scores: { "Builtin.Correctness": 10 } }, // terrible score, still no verdict
      ],
    });
    expect(suite.verdict).toBe("PASS");
    const row = suite.deltaRows.find((r: any) => r.case === "fresh");
    expect(row?.verdict).toBe("informational");
    expect(row?.baseline).toBeNull();
    expect(suite.informationalCases).toContain("fresh");
  });

  it("still FAILs when a new case errored", () => {
    const suite = run({
      baseline: baselineWith({}),
      newCaseIds: ["fresh"],
      caseResults: [{ id: "fresh", status: "errored", error: "boom" }],
    });
    expect(suite.verdict).toBe("FAIL");
    expect(suite.failureReasons.join()).toContain("case fresh");
  });

  it("treats ALL cases as informational under a bootstrap baseline, but NEVER passes (B1/B3)", () => {
    const suite = run({
      baseline: { scoringBackend: "local-judge", bootstrap: true, cases: {} },
      caseResults: [
        { id: "a", status: "scored", scores: { "Builtin.Correctness": 10 } },
        { id: "b", status: "scored", scores: { "Builtin.Correctness": 20 } },
      ],
    });
    expect(suite.verdict).toBe("FAIL");
    expect(suite.bootstrapBaseline).toBe(true);
    expect(suite.failureReasons.join()).toContain("baseline is bootstrap");
    expect(suite.failureReasons.join()).toContain("no baseline-compared gating cases");
    // Scores are still reported informationally — the baseline workflow needs them.
    expect(suite.deltaRows.every((r: any) => r.verdict === "informational")).toBe(true);
    expect(suite.informationalCases.sort()).toEqual(["a", "b"]);
    expect(suite.gatingCases).toEqual([]);
  });
});

describe("budget", () => {
  // A gating case is required for any PASS (B3), so the budget cases carry a
  // real baseline instead of the bootstrap placeholder.
  const gated = {
    baseline: baselineWith({ a: { "Builtin.Correctness": 90 } }),
    caseResults: [{ id: "a", status: "scored", scores: { "Builtin.Correctness": 90 } }],
  };

  it("FAILs with 'budget exceeded' when cost > maxRunUsd", () => {
    const suite = run({ ...gated, costEstimateUsd: 20.01 });
    expect(suite.verdict).toBe("FAIL");
    expect(suite.failureReasons.join()).toContain("budget exceeded");
  });

  it("PASSes at exactly maxRunUsd", () => {
    const suite = run({ ...gated, costEstimateUsd: 20.0 });
    expect(suite.verdict).toBe("PASS");
  });
});

describe("normalization", () => {
  it("maps native 0..1 to 0-100 and rejects out-of-range", () => {
    expect(normalizeScore(1.0)).toBe(100);
    expect(normalizeScore(0.5)).toBe(50);
    expect(normalizeScore(0)).toBe(0);
    expect(normalizeScore(0.87)).toBe(87);
    expect(normalizeScore(1.2)).toBeNull();
    expect(normalizeScore(-0.1)).toBeNull();
    expect(normalizeScore("nope")).toBeNull();
    expect(normalizeScore(NaN)).toBeNull();
  });
});
