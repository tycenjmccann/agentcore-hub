// Report rendering + the OTEL attribute contract (lambda/eval-packager/index.mjs).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OTEL_EVAL_ATTRS } from "../lib/otel.mjs";
import { buildResults, renderCheckSummary } from "../lib/report.mjs";
import { evaluateSuite } from "../lib/thresholds.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

describe("otel eval-attribute contract", () => {
  it("constants exactly match schema/otel-eval-attributes.json", () => {
    const fixture = JSON.parse(
      readFileSync(join(REPO_ROOT, "evals/battery/schema/otel-eval-attributes.json"), "utf8")
    );
    expect({ ...OTEL_EVAL_ATTRS }).toEqual(fixture.attributes);
  });

  it("matches the exact attrs[...] reads in the eval-packager Lambda", () => {
    const lambda = readFileSync(join(REPO_ROOT, "lambda/eval-packager/index.mjs"), "utf8");
    for (const key of Object.values(OTEL_EVAL_ATTRS)) {
      expect(lambda).toContain(`attrs['${key}']`);
    }
  });
});

describe("renderCheckSummary", () => {
  function makeResults() {
    const thresholds = { overallDropMaxPoints: 5, floorRule: { floorDelta: 10, minAbsoluteFloor: 40 }, maxRunUsd: 20 };
    const baseline = {
      scoringBackend: "local-judge",
      bootstrap: false,
      source_commit: "baselinesha123",
      cases: {
        "case-a": { evaluators: { "Builtin.Correctness": { mean: 90, min: 88, max: 92, n: 3 } } },
        "case-b": { evaluators: { "Builtin.Helpfulness": { mean: 80, min: 78, max: 82, n: 3 } } },
      },
    };
    const caseResults = [
      {
        id: "case-a",
        status: "scored",
        scores: { "Builtin.Correctness": 88 },
        details: { "Builtin.Correctness": { score: 88, label: "correct", explanation: "PASSING-CELL-EXPLANATION must stay out of the summary" } },
        trajectory: [],
        modelTier: "haiku",
        attempt: 1,
      },
      {
        id: "case-b",
        status: "scored",
        scores: { "Builtin.Helpfulness": 55 },
        details: { "Builtin.Helpfulness": { score: 55, label: "partial", explanation: "BREACH-EXPLANATION: the agent skipped evidence gathering entirely" } },
        trajectory: [],
        modelTier: "haiku",
        attempt: 1,
      },
      { id: "case-new", status: "scored", scores: { "Builtin.Correctness": 91 }, trajectory: [], modelTier: "sonnet", attempt: 1 },
      {
        id: "case-dead",
        status: "timed_out",
        error: "timed out after 180s",
        details: { "Builtin.Coherence": { score: 100, label: "coherent", explanation: `DEAD-CASE-EXPLANATION ${"x".repeat(500)}` } },
        trajectory: [],
        modelTier: "haiku",
        attempt: 1,
      },
    ];
    const suite = evaluateSuite({
      thresholds, baseline, caseResults, newCaseIds: ["case-new"], costEstimateUsd: 2.5, scoringBackend: "local-judge",
    });
    return buildResults({
      runId: "run-42",
      configSha: "configsha456",
      baselineSha: baseline.source_commit,
      scoringBackend: "local-judge",
      suite,
      caseResults,
      retiredCases: [{ id: "old-flake-001", retirement_reason: "flaked three times; retired pending rework" }],
      costEstimateUsd: 2.5,
      runtimeSeconds: 61.234,
    });
  }

  it("includes verdict, baseline SHA, responsible evaluators, delta table, retired + informational sections", () => {
    const results = makeResults();
    // The fixture's timed_out case makes the suite ERRORED (infra), which
    // outranks the coexisting floor breach — still a failing, red verdict.
    expect(results.verdict).toBe("ERRORED");
    expect(results.infraCases).toEqual(["case-dead"]);
    const md = renderCheckSummary(results);

    expect(md).toContain("❌ ERRORED"); // verdict
    expect(md).toContain("infra/timeout corrupted 1 case(s)"); // ERRORED marker line
    expect(md).toContain("baselinesha123"); // baseline SHA
    expect(md).toContain("configsha456");
    // floor violation names the responsible evaluator
    expect(md).toMatch(/Floor violations[\s\S]*case-b[\s\S]*Builtin\.Helpfulness/);
    // delta table with both gated rows
    expect(md).toContain("| Case | Evaluator | Baseline | Current | Δ | Floor | Verdict |");
    expect(md).toMatch(/\| case-a \| Builtin\.Correctness \| 90 \| 88 \| -2 \| 80 \| ✅ pass \|/);
    // informational new case, listed separately with scores
    expect(md).toMatch(/Informational[\s\S]*case-new.*Builtin\.Correctness=91/);
    // non-scored case surfaced
    expect(md).toMatch(/Non-scored cases[\s\S]*case-dead.*timed_out/);
    // retired cases visible with reasons — never silent
    expect(md).toMatch(/Retired cases[\s\S]*old-flake-001.*flaked three times/);
    // cost + runtime
    expect(md).toContain("$2.5");
    expect(md).toContain("61.23s");
  });

  it("marks informational cases and keeps their rows out of the gated delta table", () => {
    const results = makeResults();
    const newCase = results.cases.find((c: any) => c.id === "case-new");
    expect(newCase.informational).toBe(true);
    expect(newCase.deltas[0].verdict).toBe("informational");
    const md = renderCheckSummary(results);
    const tableSection = md.split("## Per-evaluator deltas")[1].split("##")[0];
    expect(tableSection).not.toContain("case-new");
  });

  it("carries per-case plumbing: attempt, trajectory digests, session id, failure reasons with numbers", () => {
    const results = makeResults();
    expect(results.cases[0].attempt).toBe(1);
    expect(results.failureReasons.join()).toMatch(/case-b.*Builtin\.Helpfulness.*55.*70/);
    expect(results.scoringBackend).toBe("local-judge");
  });

  // TEAM-3090: judge explanations for failing cells, in the check text itself.
  it("surfaces the judge explanation for a floor-breaching evaluator and keeps passing-cell explanations out", () => {
    const md = renderCheckSummary(makeResults());
    expect(md).toMatch(/Floor violations[\s\S]*case-b[\s\S]*Judge: BREACH-EXPLANATION/);
    expect(md).not.toContain("PASSING-CELL-EXPLANATION");
  });

  it("surfaces collected explanations for non-scored cases, truncated to the cap", () => {
    const md = renderCheckSummary(makeResults());
    const section = md.split("## Non-scored cases")[1];
    expect(section).toContain("DEAD-CASE-EXPLANATION");
    expect(section).toContain("Builtin.Coherence");
    expect(section).toContain("…"); // 500-char explanation is truncated
    expect(section).not.toContain("x".repeat(450));
  });

  // TEAM-3090: flaky candidates are rendered, and only when present.
  it("renders flaky candidates as informational and omits the section when none are flagged", () => {
    const noFlags = renderCheckSummary(makeResults());
    expect(noFlags).not.toContain("Flaky candidates");

    const results = makeResults();
    results.flakyFlags = [
      {
        caseId: "case-a",
        flips: 2,
        fingerprint: "fp-1",
        window: [
          { runId: "r1", ts: "t1", verdict: "pass" },
          { runId: "r2", ts: "t2", verdict: "fail" },
          { runId: "r3", ts: "t3", verdict: "pass" },
        ],
      },
    ];
    const md = renderCheckSummary(results);
    expect(md).toMatch(/Flaky candidates \(informational — never changes the gate verdict\)/);
    expect(md).toContain("status:retired PR");
    expect(md).toMatch(/case-a.*2 flip\(s\).*\[pass → fail → pass\]/);
    // flags never touch the verdict fields (the shared fixture's timed_out
    // case makes the verdict ERRORED per TEAM-3295 — still unaffected by flags)
    expect(results.verdict).toBe("ERRORED");
    expect(results.failureReasons.join()).not.toContain("flaky");
  });

  // TEAM-3090 item 4: tenant plumbing is carried per case.
  it("carries the per-case tenant field (null when the runner did not set one)", () => {
    const results = makeResults();
    expect(results.cases.every((c: any) => "tenant" in c)).toBe(true);
  });
});
