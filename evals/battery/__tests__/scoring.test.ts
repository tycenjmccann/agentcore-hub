// Local-judge adapter with a fully mocked transport. ZERO AWS: the real
// Bedrock client in scoring.mjs is created lazily inside
// createConverseTransport(), which these tests never call.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import {
  scoreCase,
  buildJudgeRequest,
  parseJudgeResponse,
  JUDGE_MODEL_ID,
  PERSONA_EVALUATOR_ID,
} from "../lib/scoring.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const CASE_DEF = {
  id: "score-test-case",
  taskPrompt: "Verify the thing and report via WorkflowOutput___report_completion.",
  evaluators: ["Builtin.Correctness", "Builtin.GoalSuccessRate"],
  referenceInputs: {
    expectedOutcomes: ["reports a verdict with evidence"],
    expectedToolTrajectory: [{ tool: "load_blueprint" }, { tool: "WorkflowOutput___report_completion" }],
    forbiddenTools: ["Tickets___transition_ticket"],
  },
};

const RUN_RESULT = {
  trajectory: [
    { tool: "load_blueprint", args: { blueprint_name: "qa-verifier" }, argsDigest: "abc" },
    { tool: "WorkflowOutput___report_completion", args: { ticket_id: "BATT-110", summary: "PASS" }, argsDigest: "def" },
  ],
  messages: [
    { role: "user", content: [{ text: "do the task" }] },
    { role: "assistant", content: [{ text: "done" }] },
  ],
};

const judgeReply = (score: number, label = "Correct", explanation = "cited evidence") => ({
  usage: { inputTokens: 100, outputTokens: 20 },
  output: { message: { content: [{ text: JSON.stringify({ score, label, explanation }) }] } },
});

describe("judge response parsing + normalization", () => {
  it("parses strict JSON and normalizes ×100 with label/explanation captured", async () => {
    const calls: any[] = [];
    const transport = async (req: any) => {
      calls.push(req);
      return judgeReply(calls.length === 1 ? 1.0 : 0.5, "Partial", "half done");
    };
    const scored = await scoreCase({ caseDef: CASE_DEF, runResult: RUN_RESULT, transport, repoRoot: REPO_ROOT });
    expect(scored.status).toBe("scored");
    expect(scored.scores).toEqual({ "Builtin.Correctness": 100, "Builtin.GoalSuccessRate": 50 });
    expect(scored.details["Builtin.GoalSuccessRate"].label).toBe("Partial");
    expect(scored.details["Builtin.GoalSuccessRate"].explanation).toBe("half done");
    expect(calls).toHaveLength(2);
    expect(calls[0].modelId).toBe(JUDGE_MODEL_ID);
  });

  it("tolerates prose-wrapped JSON but rejects out-of-range scores", () => {
    const wrapped = {
      output: { message: { content: [{ text: 'Here you go: {"score": 0.5, "label": "P", "explanation": "e"}' }] } },
    };
    expect(parseJudgeResponse(wrapped).score).toBe(50);
    const outOfRange = { output: { message: { content: [{ text: '{"score": 7}' }] } } };
    expect(() => parseJudgeResponse(outOfRange)).toThrow(/out of range/);
  });
});

describe("transport retry policy (single retry, transport errors only)", () => {
  it("retries exactly once on throttling then succeeds, recording the attempt", async () => {
    let calls = 0;
    const transport = async () => {
      calls++;
      if (calls === 1) {
        const err: any = new Error("rate exceeded");
        err.name = "ThrottlingException";
        throw err;
      }
      return judgeReply(1.0);
    };
    const oneEvaluator = { ...CASE_DEF, evaluators: ["Builtin.Correctness"] };
    const scored = await scoreCase({ caseDef: oneEvaluator, runResult: RUN_RESULT, transport, repoRoot: REPO_ROOT });
    expect(scored.status).toBe("scored");
    expect(scored.details["Builtin.Correctness"].attempt).toBe(2);
    expect(calls).toBe(2);
  });

  it("marks the case unscored after persistent transport failure (never a silent partial pass)", async () => {
    let calls = 0;
    const transport = async () => {
      calls++;
      const err: any = new Error("service unavailable");
      err.$metadata = { httpStatusCode: 503 };
      throw err;
    };
    const scored = await scoreCase({ caseDef: CASE_DEF, runResult: RUN_RESULT, transport, repoRoot: REPO_ROOT });
    expect(scored.status).toBe("unscored");
    expect(scored.error).toContain("Builtin.Correctness");
    expect(calls).toBe(2); // 1 attempt + 1 retry for the first evaluator, then stop — no spend on the rest
  });

  it("does NOT retry on malformed judge output — unscored immediately", async () => {
    let calls = 0;
    const transport = async () => {
      calls++;
      return { output: { message: { content: [{ text: "I think it went well overall!" }] } } };
    };
    const oneEvaluator = { ...CASE_DEF, evaluators: ["Builtin.Correctness"] };
    const scored = await scoreCase({ caseDef: oneEvaluator, runResult: RUN_RESULT, transport, repoRoot: REPO_ROOT });
    expect(scored.status).toBe("unscored");
    expect(calls).toBe(1); // parse failure is not a transport error — no retry
  });

  it("does NOT retry when the judge returns JSON missing a valid score", async () => {
    let calls = 0;
    const transport = async () => {
      calls++;
      return { output: { message: { content: [{ text: '{"label": "Correct"}' }] } } };
    };
    const oneEvaluator = { ...CASE_DEF, evaluators: ["Builtin.Correctness"] };
    const scored = await scoreCase({ caseDef: oneEvaluator, runResult: RUN_RESULT, transport, repoRoot: REPO_ROOT });
    expect(scored.status).toBe("unscored");
    expect(calls).toBe(1);
  });
});

describe("judge prompt construction", () => {
  it("builds builtin prompts with the evaluator level and the references", () => {
    const req = buildJudgeRequest({
      evaluator: "Builtin.GoalSuccessRate",
      caseDef: CASE_DEF,
      runResult: RUN_RESULT,
      repoRoot: REPO_ROOT,
    });
    const text = req.messages[0].content[0].text;
    expect(text).toContain("SESSION-level evaluation");
    expect(text).toContain("expected outcomes");
    expect(text).toContain("reports a verdict with evidence");
    expect(text).toContain("load_blueprint");
    expect(req.system[0].text).toContain('"score"');
  });

  it("tells the judge to treat harness stub results as the agent's ground-truth observations", () => {
    const req = buildJudgeRequest({
      evaluator: "Builtin.Correctness",
      caseDef: CASE_DEF,
      runResult: RUN_RESULT,
      repoRoot: REPO_ROOT,
    });
    const text = req.messages[0].content[0].text;
    expect(text).toContain("## Harness note (hermetic battery)");
    expect(text).toContain("[battery-stub]");
    expect(text).toContain("citing them as evidence is correct");
  });

  it("renders the pinned persona contract as a reference section for every evaluator", () => {
    const caseDef = {
      ...CASE_DEF,
      referenceInputs: {
        ...CASE_DEF.referenceInputs,
        personaContract: ["Never transitions tickets itself.", "A dev claim of green tests is never evidence."],
      },
    };
    const req = buildJudgeRequest({ evaluator: "Builtin.Correctness", caseDef, runResult: RUN_RESULT, repoRoot: REPO_ROOT });
    const text = req.messages[0].content[0].text;
    expect(text).toContain("## Reference: persona contract");
    expect(text).toContain("Never transitions tickets itself.");
    expect(text).toContain("regardless of what its own system prompt said");
  });

  it("omits the persona-contract section when the case pins none", () => {
    const req = buildJudgeRequest({ evaluator: "Builtin.Correctness", caseDef: CASE_DEF, runResult: RUN_RESULT, repoRoot: REPO_ROOT });
    expect(req.messages[0].content[0].text).not.toContain("Reference: persona contract");
  });

  it("persona_contract_compliance judges against the REFERENCE contract, not the agent's apparent instructions", async () => {
    const caseDef = {
      ...CASE_DEF,
      evaluators: [PERSONA_EVALUATOR_ID],
      referenceInputs: { ...CASE_DEF.referenceInputs, personaContract: ["Files a fix ticket per finding."] },
    };
    const req = buildJudgeRequest({ evaluator: PERSONA_EVALUATOR_ID, caseDef, runResult: RUN_RESULT, repoRoot: REPO_ROOT });
    const text = req.messages[0].content[0].text;
    expect(text).toContain("REFERENCE persona contract");
    expect(text).toContain("NOT against whatever");
    expect(text).toContain("task success is NOT contract compliance");
    expect(text).toContain("Files a fix ticket per finding.");
    // Scores through the normal pipeline like any evaluator.
    const scored = await scoreCase({ caseDef, runResult: RUN_RESULT, transport: async () => judgeReply(0.5), repoRoot: REPO_ROOT });
    expect(scored.status).toBe("scored");
    expect(scored.scores[PERSONA_EVALUATOR_ID]).toBe(50);
  });

  it("fills the checked-in dependency-chain instruction text with the actual trajectory", () => {
    const req = buildJudgeRequest({
      evaluator: "dependency_chain_compliance-VyBv7H2bCi",
      caseDef: CASE_DEF,
      runResult: RUN_RESULT,
      repoRoot: REPO_ROOT,
    });
    const text = req.messages[0].content[0].text;
    // Real instruction text from deploy/evaluations/dependency_chain_evaluator.json…
    expect(text).toContain("blocking/dependency relationships");
    // …with placeholders filled (no {context}/{actual_tool_trajectory} left) and our data inlined.
    expect(text).not.toContain("{context}");
    expect(text).not.toContain("{actual_tool_trajectory}");
    expect(text).toContain("WorkflowOutput___report_completion");
  });
});
