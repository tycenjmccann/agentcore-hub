// Mock scoring backend (TEAM-3295 Gap 2): a deterministic, ZERO-AWS Converse
// transport injected behind the exact seam the real Bedrock transport uses
// (run-battery.mjs → runCase/scoreCase). Everything else — case loading,
// registry stubs, mechanical forbidden/required-tool checks, gate math,
// report/check-summary generation, exit codes — runs the REAL code path, so a
// --mock run demonstrates the true gate behavior end to end.
//
// Sensitivity reuses the TEAM-3352 mechanism: qa-* cases pin a base-ref
// persona contract in referenceInputs.personaContract, and the mock judge
// scores the contract-sensitive evaluators against the WORKING-TREE prompt of
// the case's target agent. A prompt that still carries its contract clauses
// scores healthy; one with the clauses stripped scores degraded — below the
// mock baseline's floor, so the gate goes RED naming the evaluator. This file
// must never import any AWS SDK (asserted by unit test).

import { readFileSync } from "node:fs";
import { systemPromptPath } from "./agent-runner.mjs";
import { PERSONA_EVALUATOR_ID } from "./scoring.mjs";

export const MOCK_SCORING_BACKEND = "mock";

// Raw (0..1) judge scores; ×100 at ingestion like every judge score.
export const MOCK_HEALTHY_SENSITIVE = 0.9; // contract clauses present in the prompt
export const MOCK_DEGRADED_SENSITIVE = 0.2; // contract clauses stripped → floor breach
export const MOCK_DEFAULT = 0.85; // evaluators/cases with no contract sensitivity

// Evaluators the mock keys to the working-tree prompt (the rest are flat).
export const SENSITIVE_EVALUATORS = Object.freeze([
  PERSONA_EVALUATOR_ID,
  "Builtin.InstructionFollowing",
]);

// Calibrated against deploy/runtime-agent/prompts/agentcore_hub_qa_verifier.txt
// and the four qa-* persona contracts: intact prompt ⇒ coverage 0.71–0.86,
// prompt with FIRST STEP + CRITICAL RULES stripped ⇒ 0.29–0.43. The 0.55
// boundary leaves a comfortable margin on both sides; whitespace/comment
// edits cannot move token containment at all.
export const CONTRACT_COVERAGE_THRESHOLD = 0.55;
const CLAUSE_PRESENT_THRESHOLD = 0.5;

// Generic glue words that appear in any prompt — they carry no contract
// signal and would inflate coverage of a stripped prompt.
const STOPWORDS = new Set([
  "that", "with", "this", "the", "and", "for", "are", "its", "was", "were",
  "never", "always", "every", "any", "when", "what", "own", "via", "per",
  "not", "does", "doing", "done", "only", "must", "them", "then", "than",
  "itself", "into", "before", "after", "over", "under", "each", "which",
  "means", "state", "stating", "work", "opens", "name", "names",
]);

const clauseTokens = (clause) =>
  (clause.toLowerCase().match(/[a-z][a-z_'\-]{3,}/g) || []).filter((w) => !STOPWORDS.has(w));

/**
 * Fraction of contract clauses still "present" in the prompt: a clause counts
 * as present when ≥50% of its distinctive tokens appear anywhere in the
 * prompt (substring, case-insensitive). Deterministic and whitespace-blind.
 */
export function contractCoverage(promptText, clauses) {
  if (!clauses?.length) return 1;
  const hay = String(promptText || "").toLowerCase();
  let present = 0;
  for (const clause of clauses) {
    const tokens = clauseTokens(clause);
    if (tokens.length === 0) {
      present += 1;
      continue;
    }
    const found = tokens.filter((t) => hay.includes(t)).length;
    if (found / tokens.length >= CLAUSE_PRESENT_THRESHOLD) present += 1;
  }
  return present / clauses.length;
}

/** Raw (0..1) mock judge score for one evaluator of one case. */
export function mockScore({ evaluator, caseDef, promptText }) {
  const clauses = caseDef?.referenceInputs?.personaContract;
  if (!SENSITIVE_EVALUATORS.includes(evaluator) || !clauses?.length) {
    return { raw: MOCK_DEFAULT, coverage: null };
  }
  const coverage = contractCoverage(promptText, clauses);
  return {
    raw: coverage >= CONTRACT_COVERAGE_THRESHOLD ? MOCK_HEALTHY_SENSITIVE : MOCK_DEGRADED_SENSITIVE,
    coverage,
  };
}

/**
 * Synthetic in-memory baseline for mock runs: per-case per-evaluator means at
 * the mock's HEALTHY values, so an intact working tree reproduces the
 * baseline exactly (PASS) and a degraded prompt breaches the derived floors
 * (FAIL). Real runs never see this — the strict B1 bootstrap guard on the
 * committed baseline.json is untouched.
 */
export function buildMockBaseline({ cases }) {
  const out = {};
  for (const def of cases) {
    const evaluators = {};
    const sensitiveCase = Boolean(def.referenceInputs?.personaContract?.length);
    for (const evaluator of def.evaluators) {
      const raw =
        sensitiveCase && SENSITIVE_EVALUATORS.includes(evaluator) ? MOCK_HEALTHY_SENSITIVE : MOCK_DEFAULT;
      evaluators[evaluator] = { mean: raw * 100, min: raw * 100, max: raw * 100, n: 1 };
    }
    out[def.id] = { evaluators };
  }
  return {
    schemaVersion: 1,
    source_commit: "mock-synthetic-baseline",
    baseline_run_id: "mock",
    runs_per_case: 1,
    scoringBackend: MOCK_SCORING_BACKEND,
    scale: "0-100",
    bootstrap: false,
    cases: out,
  };
}

// Plausible default args per stub tool so the scripted trajectory reads like
// a real session; a case's argsSubset (when present) overrides field-by-field.
function defaultArgs(tool, caseDef) {
  switch (tool) {
    case "load_blueprint": {
      const pinned = caseDef.input?.blueprints?.[0];
      const name = pinned ? pinned.replace(/^.*\//, "").replace(/\.md$/, "") : "unknown";
      return { blueprint_name: name };
    }
    case "Tickets___create_ticket":
      return { title: `[mock] finding from ${caseDef.id}`, description: "[mock] deterministic fix ticket" };
    case "WorkflowOutput___report_completion":
      return { ticket_id: "BATT-000", summary: `[mock] ${caseDef.id} verdict delivered with evidence` };
    case "WorkflowOutput___submit_ticket_plan":
      return { workflow_id: `wf_mock_${caseDef.id}`, epic_id: "BATT-100", tickets: "[]" };
    default:
      return {};
  }
}

const textBlocks = (params) => {
  const texts = [];
  for (const s of params.system || []) if (s.text) texts.push(s.text);
  for (const m of params.messages || []) for (const b of m.content || []) if (b.text) texts.push(b.text);
  return texts;
};

const isJudgeRequest = (params) =>
  Boolean(params.system?.[0]?.text?.startsWith("You are a strict evaluation judge"));

// scoring.mjs embeds "…-level evaluation: <evaluator>)" in every judge
// request it builds itself; the checked-in dependency_chain instruction text
// doesn't carry that marker, so unmatched requests score as non-sensitive.
const detectEvaluator = (text) => text.match(/evaluation: ([A-Za-z][\w.\-]*)\)/)?.[1] || null;

/**
 * Deterministic Converse-shaped transport. `cases` are the case defs in play
 * (requests are matched to a case by its verbatim taskPrompt); `promptFor`
 * (test seam) overrides how the target agent's prompt text is obtained —
 * default reads the WORKING TREE, which is what makes the mock sensitive to
 * the PR's prompt changes.
 */
export function createMockTransport({ repoRoot, cases, promptFor }) {
  const readPrompt =
    promptFor || ((targetAgentId) => readFileSync(systemPromptPath(repoRoot, targetAgentId), "utf8"));

  return async (params) => {
    const texts = textBlocks(params);
    const caseDef = cases.find((c) => texts.some((t) => t.includes(c.taskPrompt)));
    if (!caseDef) throw new Error("mock transport: request matched no known case taskPrompt");

    if (isJudgeRequest(params)) {
      const evaluator = detectEvaluator(texts.join("\n"));
      const { raw, coverage } = mockScore({
        evaluator,
        caseDef,
        promptText: readPrompt(caseDef.targetAgentId),
      });
      const verdict = {
        score: raw,
        label: coverage === null ? "mock-flat" : raw >= 0.5 ? "contract-intact" : "contract-degraded",
        explanation:
          coverage === null
            ? `mock judge: flat score for ${evaluator || "unidentified evaluator"} (not contract-sensitive)`
            : `mock judge: working-tree prompt for ${caseDef.targetAgentId} covers ` +
              `${Math.round(coverage * 100)}% of the reference persona contract ` +
              `(threshold ${Math.round(CONTRACT_COVERAGE_THRESHOLD * 100)}%)`,
      };
      return {
        stopReason: "end_turn",
        output: { message: { role: "assistant", content: [{ text: JSON.stringify(verdict) }] } },
        usage: { inputTokens: 800, outputTokens: 60 },
      };
    }

    // Agent turn. The first mock turn calls every non-optional expected tool
    // (the mechanical required/forbidden checks then run for real); the next
    // ends the session. Detected via the mock's own toolUse marker, NOT by
    // counting assistant messages — case fixtures may seed the conversation
    // with assistant transcript turns.
    const alreadyCalledTools = (params.messages || []).some(
      (m) => m.role === "assistant" && (m.content || []).some((b) => b.toolUse?.toolUseId?.startsWith("mock-"))
    );
    const required = (caseDef.referenceInputs?.expectedToolTrajectory || []).filter((e) => e && e.optional !== true);
    if (!alreadyCalledTools && required.length > 0) {
      return {
        stopReason: "tool_use",
        output: {
          message: {
            role: "assistant",
            content: [
              { text: `[mock] ${caseDef.id}: executing the required steps.` },
              ...required.map((e, i) => ({
                toolUse: {
                  toolUseId: `mock-${caseDef.id}-${i}`,
                  name: e.tool,
                  input: { ...defaultArgs(e.tool, caseDef), ...(e.argsSubset || {}) },
                },
              })),
            ],
          },
        },
        usage: { inputTokens: 500, outputTokens: 120 },
      };
    }
    return {
      stopReason: "end_turn",
      output: {
        message: {
          role: "assistant",
          content: [{ text: `[mock] ${caseDef.id}: task completed; verdict and artifacts delivered per instructions.` }],
        },
      },
      usage: { inputTokens: 500, outputTokens: 80 },
    };
  };
}
