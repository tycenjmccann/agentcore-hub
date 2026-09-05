// Gate-mode config resolution (B2): in gate mode the rules the gate judges
// itself by come from the BASE REF, never from the PR checkout. `gitShow` is
// stubbed with an in-memory base tree — no git, no network, no fs.
import { describe, it, expect } from "vitest";
import { resolveGateConfig, CUSTOM_EVALUATOR_ID } from "../lib/cases.mjs";
import { evaluateSuite } from "../lib/thresholds.mjs";

const BASE_REF = "origin/main";
const P = (file: string) => `evals/battery/${file}`;

const BASE_THRESHOLDS = {
  schemaVersion: 1,
  overallDropMaxPoints: 5,
  floorRule: { floorDelta: 10, minAbsoluteFloor: 40 },
  maxRunUsd: 20,
};
// What a PR would edit if it could referee itself: more headroom on every knob.
const HEAD_THRESHOLDS = { ...BASE_THRESHOLDS, overallDropMaxPoints: 50, maxRunUsd: 500 };

const baselineWith = (means: Record<string, number>) => ({
  schemaVersion: 1,
  scoringBackend: "local-judge",
  bootstrap: false,
  source_commit: "deadbeef",
  cases: Object.fromEntries(
    Object.entries(means).map(([id, mean]) => [
      id,
      { evaluators: { "Builtin.Correctness": { mean, min: mean, max: mean, n: 3 } } },
    ])
  ),
});

const BASE_BASELINE = baselineWith({ "case-a": 82, "case-b": 82 });
const HEAD_BASELINE = baselineWith({ "case-a": 5, "case-b": 5 }); // hand-lowered means

const caseDef = (id: string, over: any = {}) => ({
  id,
  status: "active",
  evaluators: ["Builtin.Correctness"],
  referenceInputs: { expectedOutcomes: ["reports a verdict via report_completion"] },
  ...over,
});

/**
 * Resolve against an in-memory base tree. `base` maps repo-relative path →
 * object (or a raw string, to model a broken file at the base ref); anything
 * absent throws like `git show` does.
 */
function resolve({ base, head }: { base: Record<string, any>; head: any }) {
  const gitShow = (ref: string, relPath: string) => {
    expect(ref).toBe(BASE_REF);
    if (!(relPath in base)) throw new Error(`fatal: path '${relPath}' does not exist in '${ref}'\nnope`);
    const value = base[relPath];
    return typeof value === "string" ? value : JSON.stringify(value);
  };
  return resolveGateConfig({ repoRoot: "/nonexistent", baseRef: BASE_REF, head, gitShow });
}

/** Two cases active at base; the PR weakens every rule it can reach. */
function scenario(over: { base?: Record<string, any>; head?: any } = {}) {
  const base = {
    [P("thresholds.json")]: BASE_THRESHOLDS,
    [P("baseline.json")]: BASE_BASELINE,
    [P("manifest.json")]: { schemaVersion: 1, minActiveCases: 2, activeCases: ["case-a", "case-b"] },
    [P("cases/case-a.json")]: caseDef("case-a", { evaluator_floors: { "Builtin.Correctness": 85 } }),
    [P("cases/case-b.json")]: caseDef("case-b"),
    ...over.base,
  };
  const head = {
    thresholds: HEAD_THRESHOLDS,
    baseline: HEAD_BASELINE,
    manifest: { schemaVersion: 1, minActiveCases: 1, activeCases: ["case-a", "case-b"] },
    cases: [
      { file: P("cases/case-a.json"), def: caseDef("case-a") }, // floors dropped at HEAD
      { file: P("cases/case-b.json"), def: caseDef("case-b") },
    ],
    ...over.head,
  };
  return resolve({ base, head });
}

const errorText = (gate: any) => gate.errors.map((e: any) => `[${e.check}] ${e.file}: ${e.message}`).join("\n");

describe("thresholds / baseline / manifest come from the base ref", () => {
  it("ignores the PR's edited copies", () => {
    const gate = scenario();
    expect(errorText(gate)).toBe("");
    expect(gate.thresholds.overallDropMaxPoints).toBe(5);
    expect(gate.thresholds.maxRunUsd).toBe(20);
    expect(gate.baseline.cases["case-a"].evaluators["Builtin.Correctness"].mean).toBe(82);
    expect(gate.minActiveCases).toBe(2);
    expect(gate.baseActiveIds).toEqual(["case-a", "case-b"]);
    for (const file of ["thresholds.json", "baseline.json", "manifest.json"])
      expect(gate.sources[file]).toBe(`base-ref ${BASE_REF}`);
  });

  it("FAILs the suite under the base-ref rules where the PR's own rules would have passed", () => {
    const gate = scenario();
    const caseResults = [
      {
        id: "case-a",
        status: "scored",
        scores: { "Builtin.Correctness": 60 },
        evaluator_floors: gate.effectiveCaseDefs.get("case-a").evaluator_floors,
      },
      { id: "case-b", status: "scored", scores: { "Builtin.Correctness": 60 } },
    ];
    const refereed = evaluateSuite({
      thresholds: gate.thresholds,
      baseline: gate.baseline,
      caseResults,
      newCaseIds: [],
      costEstimateUsd: 0,
      scoringBackend: "local-judge",
    });
    expect(refereed.verdict).toBe("FAIL");
    expect(refereed.failureReasons.join()).toMatch(/overall mean dropped/);
    expect(refereed.failureReasons.join()).toContain("floor 85");

    // Same run, judged by the rules the PR shipped: green. That is the hole.
    const selfRefereed = evaluateSuite({
      thresholds: HEAD_THRESHOLDS,
      baseline: HEAD_BASELINE,
      caseResults: [
        { id: "case-a", status: "scored", scores: { "Builtin.Correctness": 60 } },
        { id: "case-b", status: "scored", scores: { "Builtin.Correctness": 60 } },
      ],
      newCaseIds: [],
      costEstimateUsd: 0,
      scoringBackend: "local-judge",
    });
    expect(selfRefereed.verdict).toBe("PASS");
  });

  it("enforces the base-ref minActiveCases, not the PR's lowered one", () => {
    const gate = scenario({
      base: { [P("manifest.json")]: { schemaVersion: 1, minActiveCases: 3, activeCases: ["case-a", "case-b"] } },
    });
    expect(gate.minActiveCases).toBe(3);
    expect(errorText(gate)).toContain("effective active case count 2 < minActiveCases 3 (base-ref value)");
  });
});

describe("case roster changes take effect only once they have landed", () => {
  it("keeps gating a base-active case that the PR retires, and does not report it as retired", () => {
    const retiredAtHead = caseDef("case-b", {
      status: "retired",
      retirement_reason: "flaked twice last week; retiring pending a fixture rework",
    });
    const gate = scenario({
      head: {
        thresholds: HEAD_THRESHOLDS,
        baseline: HEAD_BASELINE,
        manifest: { schemaVersion: 1, minActiveCases: 1, activeCases: ["case-a"] },
        cases: [
          { file: P("cases/case-a.json"), def: caseDef("case-a") },
          { file: P("cases/case-b.json"), def: retiredAtHead },
        ],
      },
    });
    expect(errorText(gate)).toBe("");
    expect(gate.resurrectedCases.map((c: any) => c.def.id)).toEqual(["case-b"]);
    expect(gate.warnings.join()).toContain("case 'case-b' is 'retired' at HEAD but active at origin/main — still gating this run");
    // …and it keeps the base-ref gating knobs while it does.
    expect(gate.effectiveCaseDefs.has("case-b")).toBe(true);
  });

  it("fails when the PR deletes a base-active case file", () => {
    const gate = scenario({
      head: {
        thresholds: HEAD_THRESHOLDS,
        baseline: HEAD_BASELINE,
        manifest: { schemaVersion: 1, minActiveCases: 1, activeCases: ["case-a"] },
        cases: [{ file: P("cases/case-a.json"), def: caseDef("case-a") }],
      },
    });
    const err = gate.errors.find((e: any) => e.file === "evals/battery/cases/case-b.json");
    expect(err?.message).toContain("active at origin/main but has no case file at HEAD");
    expect(err?.message).toContain("a PR cannot remove a gating case");
  });

  it("leaves cases the PR ADDS on their PR-head definitions", () => {
    const fresh = caseDef("case-c", { evaluator_floors: { "Builtin.Correctness": 1 } });
    const gate = scenario({
      head: {
        thresholds: HEAD_THRESHOLDS,
        baseline: HEAD_BASELINE,
        manifest: { schemaVersion: 1, minActiveCases: 1, activeCases: ["case-a", "case-b", "case-c"] },
        cases: [
          { file: P("cases/case-a.json"), def: caseDef("case-a") },
          { file: P("cases/case-b.json"), def: caseDef("case-b") },
          { file: P("cases/case-c.json"), def: fresh },
        ],
      },
    });
    expect(errorText(gate)).toBe("");
    expect(gate.effectiveCaseDefs.has("case-c")).toBe(false);
    expect(gate.caseSources["case-c"]).toBeUndefined();
  });
});

describe("gating knobs inside a base-active case file come from the base ref", () => {
  it("uses the base-ref evaluator_floors and evaluator list, not the PR's", () => {
    const gate = scenario({
      base: {
        [P("cases/case-a.json")]: caseDef("case-a", {
          taskPrompt: "the base-ref prompt",
          evaluators: ["Builtin.Correctness", "Builtin.Helpfulness"],
          evaluator_floors: { "Builtin.Correctness": 85 },
        }),
      },
      head: {
        thresholds: HEAD_THRESHOLDS,
        baseline: HEAD_BASELINE,
        manifest: { schemaVersion: 1, minActiveCases: 1, activeCases: ["case-a", "case-b"] },
        cases: [
          // PR lowers the floor to nothing AND drops the second evaluator.
          {
            file: P("cases/case-a.json"),
            def: caseDef("case-a", { taskPrompt: "the PR's prompt", evaluator_floors: { "Builtin.Correctness": 10 } }),
          },
          { file: P("cases/case-b.json"), def: caseDef("case-b") },
        ],
      },
    });
    const def = gate.effectiveCaseDefs.get("case-a");
    expect(def.evaluator_floors).toEqual({ "Builtin.Correctness": 85 });
    expect(def.evaluators).toEqual(["Builtin.Correctness", "Builtin.Helpfulness"]);
    expect(gate.caseSources["case-a"]).toContain(`base-ref ${BASE_REF}`);
    expect(gate.caseSources["case-a"]).toContain("evaluator_floors");
    expect(gate.warnings.join()).toContain("case 'case-a': evaluator_floors, evaluators differ at HEAD");
    // Content the PR is allowed to change stays on the PR-head value.
    expect(def.taskPrompt).toBe("the PR's prompt");

    // The floor the gate applies is the base one: 80 breaches 85, passes 10.
    const suite = evaluateSuite({
      thresholds: gate.thresholds,
      baseline: gate.baseline,
      caseResults: [
        { id: "case-a", status: "scored", scores: { "Builtin.Correctness": 80 }, evaluator_floors: def.evaluator_floors },
      ],
      newCaseIds: [],
      costEstimateUsd: 0,
      scoringBackend: "local-judge",
    });
    expect(suite.verdict).toBe("FAIL");
    expect(suite.failureReasons.join()).toContain("current 80 < floor 85");
  });

  it("drops floors the PR adds to a pre-existing case (tightening also waits for the merge)", () => {
    const gate = scenario({
      base: { [P("cases/case-b.json")]: caseDef("case-b") }, // no floors at base
      head: {
        thresholds: HEAD_THRESHOLDS,
        baseline: HEAD_BASELINE,
        manifest: { schemaVersion: 1, minActiveCases: 1, activeCases: ["case-a", "case-b"] },
        cases: [
          { file: P("cases/case-a.json"), def: caseDef("case-a") },
          { file: P("cases/case-b.json"), def: caseDef("case-b", { evaluator_floors: { "Builtin.Correctness": 99 } }) },
        ],
      },
    });
    expect("evaluator_floors" in gate.effectiveCaseDefs.get("case-b")).toBe(false);
  });

  it("unions forbiddenTools so a PR can add a prohibition but never drop one", () => {
    const gate = scenario({
      base: {
        [P("cases/case-b.json")]: caseDef("case-b", {
          referenceInputs: { expectedOutcomes: ["x"], forbiddenTools: ["Tickets___transition_ticket"] },
        }),
      },
      head: {
        thresholds: HEAD_THRESHOLDS,
        baseline: HEAD_BASELINE,
        manifest: { schemaVersion: 1, minActiveCases: 1, activeCases: ["case-a", "case-b"] },
        cases: [
          { file: P("cases/case-a.json"), def: caseDef("case-a") },
          {
            file: P("cases/case-b.json"),
            def: caseDef("case-b", { referenceInputs: { expectedOutcomes: ["x"], forbiddenTools: ["S3___delete_object"] } }),
          },
        ],
      },
    });
    expect(gate.effectiveCaseDefs.get("case-b").referenceInputs.forbiddenTools.sort()).toEqual([
      "S3___delete_object",
      "Tickets___transition_ticket",
    ]);
  });

  it("fails when the base-ref evaluator list needs a reference trajectory HEAD no longer has", () => {
    const gate = scenario({
      base: { [P("cases/case-b.json")]: caseDef("case-b", { evaluators: [CUSTOM_EVALUATOR_ID] }) },
    });
    expect(errorText(gate)).toContain(CUSTOM_EVALUATOR_ID);
    expect(errorText(gate)).toContain("no referenceInputs.expectedToolTrajectory for case 'case-b'");
  });
});

describe("base-ref reads that do not resolve", () => {
  it("falls back to the PR-head config file with a loud warning when it is absent at the base ref", () => {
    const base = {
      [P("thresholds.json")]: BASE_THRESHOLDS,
      [P("manifest.json")]: { schemaVersion: 1, minActiveCases: 1, activeCases: ["case-a"] },
      [P("cases/case-a.json")]: caseDef("case-a"),
    };
    const gate = resolve({
      base,
      head: {
        thresholds: HEAD_THRESHOLDS,
        baseline: HEAD_BASELINE,
        manifest: { schemaVersion: 1, minActiveCases: 1, activeCases: ["case-a"] },
        cases: [{ file: P("cases/case-a.json"), def: caseDef("case-a") }],
      },
    });
    expect(errorText(gate)).toBe("");
    expect(gate.sources["baseline.json"]).toBe("pr-head (absent at base ref)");
    expect(gate.warnings.join()).toContain("evals/battery/baseline.json is not readable at origin/main");
    expect(gate.warnings.join()).toContain("falling back to the PR-head copy");
    expect(gate.baseline).toBe(HEAD_BASELINE);
  });

  it("falls back to the PR-head gating knobs, loudly, when a base-active case file is absent at the base ref", () => {
    const gate = resolve({
      base: {
        [P("thresholds.json")]: BASE_THRESHOLDS,
        [P("baseline.json")]: BASE_BASELINE,
        [P("manifest.json")]: { schemaVersion: 1, minActiveCases: 1, activeCases: ["case-a", "case-b"] },
        [P("cases/case-a.json")]: caseDef("case-a"),
      },
      head: {
        thresholds: HEAD_THRESHOLDS,
        baseline: HEAD_BASELINE,
        manifest: { schemaVersion: 1, minActiveCases: 1, activeCases: ["case-a", "case-b"] },
        cases: [
          { file: P("cases/case-a.json"), def: caseDef("case-a") },
          { file: P("cases/case-b.json"), def: caseDef("case-b", { evaluator_floors: { "Builtin.Correctness": 1 } }) },
        ],
      },
    });
    expect(errorText(gate)).toBe("");
    expect(gate.caseSources["case-b"]).toBe("pr-head (absent at base ref)");
    expect(gate.warnings.join()).toContain("falling back to the PR-head gating knobs for case 'case-b'");
    expect(gate.effectiveCaseDefs.has("case-b")).toBe(false);
  });

  it("refuses to fall back when the base-ref copy is present but unparseable", () => {
    const gate = scenario({ base: { [P("thresholds.json")]: "{ not json" } });
    expect(gate.sources["thresholds.json"]).toBe("unreadable at base ref");
    expect(errorText(gate)).toContain("origin/main:evals/battery/thresholds.json");
    expect(errorText(gate)).toContain("JSON parse error");
  });

  it("errors when a base-active case file is unparseable at the base ref", () => {
    const gate = scenario({ base: { [P("cases/case-b.json")]: "{{{" } });
    expect(gate.caseSources["case-b"]).toBe("unreadable at base ref");
    expect(errorText(gate)).toContain("origin/main:evals/battery/cases/case-b.json");
    expect(errorText(gate)).toContain("JSON parse error");
  });
});
