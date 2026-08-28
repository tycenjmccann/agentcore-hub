// Mock scoring backend (TEAM-3295 Gap 2): deterministic, zero-AWS, and
// sensitive to working-tree prompt degradation through the REAL pipeline —
// runCase → scoreCase → evaluateSuite, with only the transport mocked.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createMockTransport,
  buildMockBaseline,
  contractCoverage,
  mockScore,
  CONTRACT_COVERAGE_THRESHOLD,
  MOCK_SCORING_BACKEND,
  MOCK_HEALTHY_SENSITIVE,
  MOCK_DEGRADED_SENSITIVE,
} from "../lib/mock-transport.mjs";
import { runCase } from "../lib/agent-runner.mjs";
import { scoreCase, PERSONA_EVALUATOR_ID } from "../lib/scoring.mjs";
import { evaluateSuite } from "../lib/thresholds.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CANARY = JSON.parse(
  readFileSync(join(REPO_ROOT, "evals/battery/cases/qa-verifier-degradation-canary-004.json"), "utf8")
);
const CLAUSES = CANARY.referenceInputs.personaContract;
const INTACT_PROMPT = readFileSync(
  join(REPO_ROOT, "deploy/runtime-agent/prompts/agentcore_hub_qa_verifier.txt"),
  "utf8"
);
// The degradation the canary exists to catch: the load-bearing FIRST STEP and
// CRITICAL RULES sections stripped (an "always PASS, skip evidence" rewrite).
const DEGRADED_PROMPT = INTACT_PROMPT.replace(/## FIRST STEP[\s\S]*?(?=## WHAT YOU DO)/, "").replace(
  /## CRITICAL RULES[\s\S]*?(?=## TOOL STATUS REPORTING)/,
  ""
);

const THRESHOLDS = {
  overallDropMaxPoints: 5,
  floorRule: { floorDelta: 10, minAbsoluteFloor: 40 },
  maxRunUsd: 20.0,
};

async function runMockCanary(promptText: string) {
  const transport = createMockTransport({
    repoRoot: REPO_ROOT,
    cases: [CANARY],
    promptFor: () => promptText,
  });
  const run = await runCase({
    caseDef: CANARY,
    repoRoot: REPO_ROOT,
    runId: "mocktest",
    converse: transport,
    signal: undefined,
  });
  expect(run.status).toBe("completed"); // mechanical required/forbidden checks pass for real
  const scored = await scoreCase({
    caseDef: CANARY,
    runResult: run,
    transport,
    repoRoot: REPO_ROOT,
    signal: undefined,
  });
  expect(scored.status).toBe("scored");
  return scored;
}

function gate(scored: any) {
  return evaluateSuite({
    thresholds: THRESHOLDS,
    baseline: buildMockBaseline({ cases: [CANARY] }),
    caseResults: [{ id: CANARY.id, status: scored.status, scores: scored.scores }],
    newCaseIds: [],
    costEstimateUsd: 0,
    scoringBackend: MOCK_SCORING_BACKEND,
  });
}

describe("contract coverage heuristic", () => {
  it("scores the intact working-tree prompt above the threshold, the degraded one below", () => {
    expect(contractCoverage(INTACT_PROMPT, CLAUSES)).toBeGreaterThanOrEqual(CONTRACT_COVERAGE_THRESHOLD);
    expect(contractCoverage(DEGRADED_PROMPT, CLAUSES)).toBeLessThan(CONTRACT_COVERAGE_THRESHOLD);
  });

  it("is blind to whitespace/comment edits (innocuous change ⇒ identical coverage)", () => {
    const edited = INTACT_PROMPT + "\n\n# (formatting note: section order above is intentional)\n";
    expect(contractCoverage(edited, CLAUSES)).toBe(contractCoverage(INTACT_PROMPT, CLAUSES));
  });

  it("maps coverage onto the healthy/degraded mock scores for sensitive evaluators only", () => {
    expect(mockScore({ evaluator: PERSONA_EVALUATOR_ID, caseDef: CANARY, promptText: INTACT_PROMPT }).raw).toBe(
      MOCK_HEALTHY_SENSITIVE
    );
    expect(mockScore({ evaluator: PERSONA_EVALUATOR_ID, caseDef: CANARY, promptText: DEGRADED_PROMPT }).raw).toBe(
      MOCK_DEGRADED_SENSITIVE
    );
    // Non-sensitive evaluator: flat regardless of prompt state.
    const flat = mockScore({ evaluator: "Builtin.Correctness", caseDef: CANARY, promptText: DEGRADED_PROMPT });
    expect(flat.raw).toBe(mockScore({ evaluator: "Builtin.Correctness", caseDef: CANARY, promptText: INTACT_PROMPT }).raw);
  });
});

describe("mock transport determinism", () => {
  it("returns identical scores across repeated full runs", async () => {
    const a = await runMockCanary(INTACT_PROMPT);
    const b = await runMockCanary(INTACT_PROMPT);
    expect(a.scores).toEqual(b.scores);
    expect(Object.keys(a.scores).sort()).toEqual([...CANARY.evaluators].sort());
  });
});

describe("acceptance scenarios through the real gate path", () => {
  it("intact prompt ⇒ PASS (scores reproduce the synthetic baseline exactly)", async () => {
    const scored = await runMockCanary(INTACT_PROMPT);
    const suite = gate(scored);
    expect(suite.verdict).toBe("PASS");
    expect(suite.failureReasons).toEqual([]);
  });

  it("degraded qa-verifier prompt ⇒ FAIL naming the responsible evaluator and case", async () => {
    const scored = await runMockCanary(DEGRADED_PROMPT);
    const suite = gate(scored);
    expect(suite.verdict).toBe("FAIL");
    const reasons = suite.failureReasons.join("\n");
    expect(reasons).toContain(PERSONA_EVALUATOR_ID);
    expect(reasons).toContain("Builtin.InstructionFollowing");
    expect(reasons).toContain(CANARY.id);
    expect(reasons).toMatch(/current 20 < floor 80/);
  });
});

describe("zero AWS in mock mode", () => {
  it("mock-transport.mjs never references the AWS SDK", () => {
    const src = readFileSync(join(REPO_ROOT, "evals/battery/lib/mock-transport.mjs"), "utf8");
    expect(src).not.toContain("@aws-sdk");
  });

  it("run-battery.mjs only constructs the Bedrock transport on the non-mock branch", () => {
    const src = readFileSync(join(REPO_ROOT, "evals/battery/run-battery.mjs"), "utf8");
    // createConverseTransport (the battery's ONLY AWS SDK import, itself lazy)
    // must appear solely as the ternary alternative to the mock transport.
    expect(src).toMatch(/flags\.mock\s*\n?\s*\? createMockTransport\(\{ repoRoot: REPO_ROOT, cases: selected \}\)\s*\n?\s*: await createConverseTransport\(\)/);
    expect(src.match(/createConverseTransport\(\)/g)).toHaveLength(1);
  });
});
