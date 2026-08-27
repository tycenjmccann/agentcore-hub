// The two "the gate proved nothing" guards, which must land on FAIL rather than
// on a neutral/green verdict (B1 bootstrap baseline, B3 zero gating cases).
// Pure gate math plus one source assertion for the verdict→exit-code mapping.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateSuite } from "../lib/thresholds.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const THRESHOLDS = {
  overallDropMaxPoints: 5,
  floorRule: { floorDelta: 10, minAbsoluteFloor: 40 },
  maxRunUsd: 20.0,
};

const BOOTSTRAP_BASELINE = { schemaVersion: 1, scoringBackend: "local-judge", bootstrap: true, runs_per_case: 0, cases: {} };

const baselineWith = (means: Record<string, number>) => ({
  schemaVersion: 1,
  scoringBackend: "local-judge",
  bootstrap: false,
  cases: Object.fromEntries(
    Object.entries(means).map(([id, mean]) => [
      id,
      { evaluators: { "Builtin.Correctness": { mean, min: mean, max: mean, n: 3 } } },
    ])
  ),
});

const run = (overrides: any) =>
  evaluateSuite({
    thresholds: THRESHOLDS,
    baseline: BOOTSTRAP_BASELINE,
    caseResults: [],
    newCaseIds: [],
    costEstimateUsd: 0,
    scoringBackend: "local-judge",
    ...overrides,
  });

describe("B1: a bootstrap baseline can never produce a success verdict", () => {
  it("FAILs an all-zero-score run, naming the bootstrap reason", () => {
    const suite = run({
      caseResults: [
        { id: "case-a", status: "scored", scores: { "Builtin.Correctness": 0 } },
        { id: "case-b", status: "scored", scores: { "Builtin.Correctness": 0 } },
      ],
    });
    expect(suite.verdict).not.toBe("PASS");
    expect(suite.verdict).toBe("FAIL");
    expect(suite.bootstrapBaseline).toBe(true);
    expect(suite.failureReasons.join()).toContain(
      "baseline is bootstrap — gate cannot pass until a real baseline is published"
    );
    expect(suite.gatingCases).toEqual([]);
  });

  it("FAILs a PERFECT-score run too — the verdict does not depend on the scores", () => {
    const suite = run({
      caseResults: [{ id: "case-a", status: "scored", scores: { "Builtin.Correctness": 100 } }],
    });
    expect(suite.verdict).toBe("FAIL");
    expect(suite.failureReasons.join()).toContain("baseline is bootstrap");
  });

  it("still executes and reports the scores informationally (the baseline workflow consumes them)", () => {
    const suite = run({
      caseResults: [
        { id: "case-a", status: "scored", scores: { "Builtin.Correctness": 0 } },
        { id: "case-b", status: "scored", scores: { "Builtin.Correctness": 44.5 } },
      ],
    });
    expect(suite.deltaRows.map((r: any) => r.current)).toEqual([0, 44.5]);
    expect(suite.deltaRows.every((r: any) => r.verdict === "informational")).toBe(true);
    expect(suite.informationalCases.sort()).toEqual(["case-a", "case-b"]);
  });

  it("maps every non-PASS verdict onto a non-zero process exit code", () => {
    // The only exit path out of a gate run — asserted on the source because the
    // pipeline has no neutral conclusion to fall back on.
    const src = readFileSync(join(REPO_ROOT, "evals/battery/run-battery.mjs"), "utf8");
    expect(src).toContain('process.exit(results.verdict === "PASS" ? 0 : 1)');
  });
});

describe("B3: PASS requires ≥1 scored, baseline-compared, non-informational case", () => {
  it("FAILs when every case is new-in-PR, even with a real baseline and perfect scores", () => {
    const suite = run({
      baseline: baselineWith({ "case-old": 90 }),
      newCaseIds: ["fresh-1", "fresh-2"],
      caseResults: [
        { id: "fresh-1", status: "scored", scores: { "Builtin.Correctness": 100 } },
        { id: "fresh-2", status: "scored", scores: { "Builtin.Correctness": 100 } },
      ],
    });
    expect(suite.verdict).toBe("FAIL");
    expect(suite.failureReasons.join()).toContain("no baseline-compared gating cases — refusing to PASS");
    expect(suite.gatingCases).toEqual([]);
    expect(suite.informationalCases.sort()).toEqual(["fresh-1", "fresh-2"]);
  });

  it("FAILs an empty suite (nothing selected ran)", () => {
    const suite = run({ baseline: baselineWith({ "case-a": 90 }), caseResults: [] });
    expect(suite.verdict).toBe("FAIL");
    expect(suite.failureReasons.join()).toContain("refusing to PASS");
  });

  it("is independent of B1: a real baseline with only informational cases still FAILs, without the bootstrap reason", () => {
    const suite = run({
      baseline: baselineWith({ "case-old": 90 }),
      newCaseIds: ["fresh-1"],
      caseResults: [{ id: "fresh-1", status: "scored", scores: { "Builtin.Correctness": 100 } }],
    });
    expect(suite.bootstrapBaseline).toBe(false);
    expect(suite.failureReasons.join()).not.toContain("bootstrap");
    expect(suite.failureReasons.join()).toContain("refusing to PASS");
  });

  it("PASSes as soon as one case is compared against the baseline, alongside informational ones", () => {
    const suite = run({
      baseline: baselineWith({ "case-a": 90 }),
      newCaseIds: ["fresh-1"],
      caseResults: [
        { id: "case-a", status: "scored", scores: { "Builtin.Correctness": 90 } },
        { id: "fresh-1", status: "scored", scores: { "Builtin.Correctness": 3 } },
      ],
    });
    expect(suite.verdict).toBe("PASS");
    expect(suite.gatingCases).toEqual(["case-a"]);
  });
});
