// Local-judge scoring adapter (security review CRED-5, design §2.4). v1 scores
// via direct Bedrock Converse calls to the same judge model the online configs
// use — NOT via any guessed agentcore CLI subcommand (the only demonstrated
// commands in this repo are `agentcore eval evaluator list` / `eval online
// create` / `eval online list`, none of which score a local session). The
// transport is injectable so a future agentcore on-demand backend can slot in
// behind the same scoreCase() signature and so tests can mock the boundary.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeScore } from "./thresholds.mjs";
import { isRetryableTransportError } from "./agent-runner.mjs";
import { backoffDelayMs, sleep } from "./retry.mjs";

export const SCORING_BACKEND = "local-judge";
// Same judge the online eval configs use (deploy/evaluations/
// dependency_chain_evaluator.json modelConfig / setup-evaluations.sh).
export const JUDGE_MODEL_ID = "us.anthropic.claude-opus-4-7";
export const JUDGE_MAX_TOKENS = 1000; // mirrors dependency_chain_evaluator.json inferenceConfig

export const CUSTOM_EVALUATOR_ID = "dependency_chain_compliance-VyBv7H2bCi";

// Rating-scale semantics reused from deploy/evaluations/
// dependency_chain_evaluator.json: native 0.0 / 0.5 / 1.0 (Failed / Partial /
// Correct); intermediate 0..1 values allowed; ×100 at ingestion.
const RATING_SCALE_TEXT =
  "Score on this scale: 1.0 = fully correct/compliant, 0.5 = partially correct " +
  "(some expectations met, others missed), 0.0 = failed. Intermediate values in " +
  "[0,1] are allowed when the evidence genuinely sits between anchors.";

// Faithful instruction texts for the Builtin.* evaluators, by name and level
// (TOOL_CALL / TRACE / SESSION per deploy/evaluations/eval-config-ids.json).
const BUILTIN_INSTRUCTIONS = {
  "Builtin.ToolSelectionAccuracy": {
    level: "TOOL_CALL",
    text: "Evaluate whether each tool the agent chose was the appropriate one for what it was trying to accomplish at that step, given the tools available. Wrong tool for the job, ignoring a required tool (e.g. skipping load_blueprint when instructed to load it first), or calling tools with no purpose lowers the score.",
  },
  "Builtin.ToolParameterAccuracy": {
    level: "TOOL_CALL",
    text: "Evaluate whether the parameters passed to each tool call were correct and complete: right ticket ids, correct assignees, correct blocked_by chains, content that matches what the task required. Fabricated or missing parameters lower the score.",
  },
  "Builtin.InstructionFollowing": {
    level: "TRACE",
    text: "Evaluate how well the agent followed the explicit instructions in its task: required steps done in the required order, prohibited actions avoided, output delivered through the required channel (e.g. WorkflowOutput___report_completion rather than plain text).",
  },
  "Builtin.GoalSuccessRate": {
    level: "SESSION",
    text: "Evaluate whether the session achieved the user's end goal, as defined by the expected outcomes provided. Partial goal completion scores 0.5; achieving the stated outcomes scores 1.0.",
  },
  "Builtin.Correctness": {
    level: "TRACE",
    text: "Evaluate the factual and technical correctness of the agent's statements and work products against the provided inputs: root causes identified correctly, findings that match the actual defect, no invented facts.",
  },
  "Builtin.Coherence": {
    level: "TRACE",
    text: "Evaluate the logical coherence of the agent's reasoning and actions: steps follow from evidence, no contradictions between what it observed and what it concluded or did.",
  },
  "Builtin.Faithfulness": {
    level: "TRACE",
    text: "Evaluate whether the agent's claims are grounded in the provided context and tool results — no hallucinated file contents, ticket states, or test results that its tools never returned.",
  },
  "Builtin.Helpfulness": {
    level: "TRACE",
    text: "Evaluate how useful the agent's work product is to the downstream consumer (orchestrator, reviewer, or human): actionable, complete for its purpose, and appropriately scoped.",
  },
  "Builtin.ResponseRelevance": {
    level: "TRACE",
    text: "Evaluate whether the agent's responses stay on the assigned task and respond to what was actually asked, without drifting into unrequested work.",
  },
  "Builtin.Conciseness": {
    level: "TRACE",
    text: "Evaluate whether the agent communicates without unnecessary verbosity or repetition while still covering what the task requires.",
  },
};

export function builtinInstruction(name) {
  return BUILTIN_INSTRUCTIONS[name] || null;
}

// ─── Transport ───────────────────────────────────────────────────────────────

// HTTP backstop (TEAM-3352): with the SDK defaults (requestTimeout 0 = never)
// a single stalled connection parks a pool slot forever, invisibly. These caps
// guarantee every Converse call settles even if an abort signal is lost.
export const HTTP_CONNECTION_TIMEOUT_MS = 5_000;
export const HTTP_REQUEST_TIMEOUT_MS = 120_000;
export const SDK_MAX_ATTEMPTS = 3; // explicit, so quota changes can't widen it silently

// Real Bedrock transport, created lazily so --dry-run never constructs a
// client. Shared by agent-runner (case model) and the judge.
export async function createConverseTransport() {
  const { BedrockRuntimeClient, ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
  const client = new BedrockRuntimeClient({
    maxAttempts: SDK_MAX_ATTEMPTS,
    requestHandler: {
      connectionTimeout: HTTP_CONNECTION_TIMEOUT_MS,
      requestTimeout: HTTP_REQUEST_TIMEOUT_MS,
    },
  });
  return async (params, { signal } = {}) => client.send(new ConverseCommand(params), { abortSignal: signal });
}

// ─── Judge prompt construction ───────────────────────────────────────────────

function renderConversation(messages) {
  const lines = [];
  for (const m of messages || []) {
    for (const block of m.content || []) {
      if (block.text) lines.push(`${m.role.toUpperCase()}: ${block.text}`);
      if (block.toolUse) lines.push(`ASSISTANT tool_use ${block.toolUse.name}(${JSON.stringify(block.toolUse.input)})`);
      if (block.toolResult) {
        const text = (block.toolResult.content || []).map((c) => c.text).join("");
        lines.push(`TOOL_RESULT: ${text.slice(0, 1500)}`);
      }
    }
  }
  return lines.join("\n");
}

function renderContext(caseDef, runResult) {
  const trajectory = runResult.trajectory.map((t) => ({ tool: t.tool, args: t.args }));
  const parts = [
    `## Task given to the agent\n${caseDef.taskPrompt}`,
    `## Session conversation\n${renderConversation(runResult.messages)}`,
    `## Actual tool trajectory (ordered)\n${JSON.stringify(trajectory, null, 2)}`,
    `## Reference: expected outcomes\n${caseDef.referenceInputs.expectedOutcomes.map((o) => `- ${o}`).join("\n")}`,
  ];
  if (caseDef.referenceInputs.expectedToolTrajectory) {
    parts.push(
      `## Reference: expected tool trajectory\n${JSON.stringify(caseDef.referenceInputs.expectedToolTrajectory, null, 2)}`
    );
  }
  if (caseDef.referenceInputs.forbiddenTools?.length) {
    parts.push(`## Reference: forbidden tools\n${caseDef.referenceInputs.forbiddenTools.join(", ")}`);
  }
  return parts.join("\n\n");
}

export function buildJudgeRequest({ evaluator, caseDef, runResult, repoRoot }) {
  const context = renderContext(caseDef, runResult);
  let instructions;
  if (evaluator === CUSTOM_EVALUATOR_ID) {
    // Reuse the checked-in evaluator's actual instruction text; fill its
    // placeholders ({context}, and {actual_tool_trajectory} in the on-demand
    // variant) with this session's data.
    const evaluatorDef = JSON.parse(
      readFileSync(join(repoRoot, "deploy", "evaluations", "dependency_chain_evaluator.json"), "utf8")
    );
    const trajectoryJson = JSON.stringify(
      runResult.trajectory.map((t) => ({ tool: t.tool, args: t.args })),
      null,
      2
    );
    instructions = evaluatorDef.llmAsAJudge.instructions
      .replaceAll("{actual_tool_trajectory}", trajectoryJson)
      .replaceAll("{context}", context);
  } else {
    const builtin = BUILTIN_INSTRUCTIONS[evaluator];
    instructions =
      `You are evaluating an AI agent session (${builtin.level}-level evaluation: ${evaluator}).\n\n` +
      `${builtin.text}\n\n${RATING_SCALE_TEXT}\n\nContext:\n${context}`;
  }
  return {
    modelId: JUDGE_MODEL_ID,
    system: [
      {
        text:
          "You are a strict evaluation judge. Respond with ONLY a JSON object " +
          '{"score": <number 0..1>, "label": "<short label>", "explanation": "<1-3 sentences citing evidence>"} — no prose, no code fences.',
      },
    ],
    messages: [{ role: "user", content: [{ text: instructions }] }],
    inferenceConfig: { maxTokens: JUDGE_MAX_TOKENS },
  };
}

export function parseJudgeResponse(response) {
  const text = (response.output?.message?.content || [])
    .filter((b) => b.text)
    .map((b) => b.text)
    .join("\n");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`judge returned no JSON: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(match[0]);
  const normalized = normalizeScore(parsed.score);
  if (normalized === null) throw new Error(`judge score out of range: ${parsed.score}`);
  return { rawScore: parsed.score, score: normalized, label: parsed.label || "", explanation: parsed.explanation || "" };
}

// ─── Scoring one case ────────────────────────────────────────────────────────

/**
 * Score a completed case run with every evaluator it declares.
 * Any evaluator failing after its single transport retry ⇒ the whole case is
 * `unscored` ⇒ gate FAIL (a partial score set is never a silent pass).
 *
 * `signal` (optional) is the case's end-to-end deadline: it aborts in-flight
 * judge calls and backoff sleeps, and once fired the remaining evaluators are
 * never attempted — the case reports `unscored` with the deadline as reason.
 */
export async function scoreCase({ caseDef, runResult, transport, repoRoot, signal }) {
  /** @type {Record<string, number>} */
  const scores = {};
  /** @type {Record<string, any>} */
  const details = {};
  const usage = { inputTokens: 0, outputTokens: 0 };
  const deadlineError = () =>
    new Error(signal?.reason?.message || "case deadline exceeded during judge scoring");
  for (const evaluator of caseDef.evaluators) {
    const request = buildJudgeRequest({ evaluator, caseDef, runResult, repoRoot });
    let lastError = null;
    let verdict = null;
    let attemptUsed = 0;
    for (let attempt = 1; attempt <= 2 && !verdict; attempt++) {
      if (signal?.aborted) {
        lastError = deadlineError();
        break;
      }
      attemptUsed = attempt;
      try {
        const response = await transport(request, { signal });
        usage.inputTokens += response.usage?.inputTokens || 0;
        usage.outputTokens += response.usage?.outputTokens || 0;
        verdict = parseJudgeResponse(response);
      } catch (err) {
        lastError = signal?.aborted ? deadlineError() : err;
        if (signal?.aborted || !(attempt < 2 && isRetryableTransportError(err))) break;
        await sleep(backoffDelayMs(attempt), signal);
      }
    }
    if (!verdict) {
      return {
        status: "unscored",
        scores,
        details,
        usage,
        error: `evaluator '${evaluator}' failed to score: ${lastError?.message}`,
      };
    }
    scores[evaluator] = verdict.score;
    details[evaluator] = { ...verdict, attempt: attemptUsed };
  }
  return { status: "scored", scores, details, usage };
}
