// Baseline-mode math (TEAM-3405): repeat quorum, aggregation over scored runs
// only, and whole-run deadline resolution — plus the max-turns truncation
// annotation on failed_required_tool errors. Fake transports throughout — no AWS.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  baselineQuorum,
  aggregateBaselineCase,
  topUpCase,
  MAX_TOPUP_RUNS,
  resolveRunDeadline,
  DEFAULT_RUN_DEADLINE_SECONDS,
} from "../lib/baseline.mjs";
import { runCase, requiredToolFailureError, MAX_OUTPUT_TOKENS } from "../lib/agent-runner.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const QA_CASE = JSON.parse(
  readFileSync(join(REPO_ROOT, "evals/battery/cases/qa-verifier-regression-001.json"), "utf8")
);

const DEF = { id: "case-a", evaluators: ["Builtin.Correctness", "Builtin.Helpfulness"] };
const scored = (scores: Record<string, number>, id = "case-a") => ({ id, status: "scored", scores });
const failed = (status = "failed_forbidden_tool", id = "case-a") => ({ id, status, scores: {} });

describe("baselineQuorum: ceil(2N/3)", () => {
  it("repeat 3 → quorum 2 (the QA finding's headline case)", () => {
    expect(baselineQuorum(3)).toBe(2);
  });
  it("repeat 1 → quorum 1 (a single run must still score)", () => {
    expect(baselineQuorum(1)).toBe(1);
  });
  it("repeat 2 → 2, repeat 5 → 4, repeat 6 → 4", () => {
    expect(baselineQuorum(2)).toBe(2);
    expect(baselineQuorum(5)).toBe(4);
    expect(baselineQuorum(6)).toBe(4);
  });
});

describe("aggregateBaselineCase", () => {
  it("computes per-evaluator means over the SCORED runs only", () => {
    const results = [
      scored({ "Builtin.Correctness": 80, "Builtin.Helpfulness": 90 }),
      scored({ "Builtin.Correctness": 90, "Builtin.Helpfulness": 70 }),
      failed(), // a failed run must not drag the mean toward zero
    ];
    const agg = aggregateBaselineCase({ def: DEF, results, quorum: 2 });
    expect(agg.belowQuorum).toBe(false);
    expect(agg.entry.evaluators["Builtin.Correctness"]).toEqual({ mean: 85, min: 80, max: 90, n: 2 });
    expect(agg.entry.evaluators["Builtin.Helpfulness"]).toEqual({ mean: 80, min: 70, max: 90, n: 2 });
  });

  it("records runsScored/runsAttempted so the artifact is honest about its sample size", () => {
    const results = [scored({ "Builtin.Correctness": 80, "Builtin.Helpfulness": 90 }), scored({ "Builtin.Correctness": 90, "Builtin.Helpfulness": 70 }), failed()];
    const agg = aggregateBaselineCase({ def: DEF, results, quorum: 2 });
    expect(agg.entry.runsScored).toBe(2);
    expect(agg.entry.runsAttempted).toBe(3);
  });

  it("a case below quorum yields belowQuorum (fails the whole baseline) and no entry", () => {
    const results = [scored({ "Builtin.Correctness": 95, "Builtin.Helpfulness": 95 }), failed(), failed("timed_out")];
    const agg = aggregateBaselineCase({ def: DEF, results, quorum: 2 });
    expect(agg.belowQuorum).toBe(true);
    expect(agg.entry).toBeUndefined();
    expect(agg.runsScored).toBe(1);
    expect(agg.runsAttempted).toBe(3);
  });

  it("only counts runs belonging to the case (mixed-batch results)", () => {
    const results = [
      scored({ "Builtin.Correctness": 80, "Builtin.Helpfulness": 80 }),
      scored({ "Builtin.Correctness": 90, "Builtin.Helpfulness": 90 }),
      scored({ "Builtin.Correctness": 10, "Builtin.Helpfulness": 10 }, "case-other"),
    ];
    const agg = aggregateBaselineCase({ def: DEF, results, quorum: 2 });
    expect(agg.runsAttempted).toBe(2);
    expect(agg.entry.evaluators["Builtin.Correctness"].mean).toBe(85);
  });
});

describe("topUpCase: per-case top-up runs (baseline mode only)", () => {
  const topUpDef = { id: "case-a", evaluators: ["Builtin.Correctness"] };

  it("stops as soon as quorum is reached mid-top-up", async () => {
    const results: any[] = [scored({ "Builtin.Correctness": 90 }), failed(), failed()];
    let calls = 0;
    const used = await topUpCase({
      def: topUpDef,
      results,
      quorum: 2,
      repeat: 3,
      runOnce: async () => (calls++, scored({ "Builtin.Correctness": 80 })),
    });
    expect(used).toBe(1);
    expect(calls).toBe(1);
    expect(results).toHaveLength(4);
  });

  it("exhausted top-ups still leave the case below quorum (whole baseline fails)", async () => {
    const results: any[] = [scored({ "Builtin.Correctness": 90 }), failed(), failed()];
    const used = await topUpCase({
      def: topUpDef,
      results,
      quorum: 2,
      repeat: 3,
      runOnce: async () => failed("failed_forbidden_tool"),
    });
    expect(used).toBe(MAX_TOPUP_RUNS);
    const agg = aggregateBaselineCase({ def: topUpDef, results, quorum: 2, topUpRuns: used });
    expect(agg.belowQuorum).toBe(true);
    expect(agg.runsAttempted).toBe(5);
    expect(agg.topUpRuns).toBe(2);
  });

  it("a case already at quorum uses zero top-ups", async () => {
    const results: any[] = [scored({ "Builtin.Correctness": 90 }), scored({ "Builtin.Correctness": 80 }), failed()];
    let calls = 0;
    const used = await topUpCase({
      def: topUpDef,
      results,
      quorum: 2,
      repeat: 3,
      runOnce: async () => (calls++, failed()),
    });
    expect(used).toBe(0);
    expect(calls).toBe(0);
  });

  it("records runsAttempted (incl. top-ups) and topUpRuns in the baseline entry, means over scored runs only", async () => {
    const results: any[] = [scored({ "Builtin.Correctness": 90 }), failed(), failed()];
    const used = await topUpCase({
      def: topUpDef,
      results,
      quorum: 2,
      repeat: 3,
      runOnce: async () => scored({ "Builtin.Correctness": 70 }),
    });
    const agg = aggregateBaselineCase({ def: topUpDef, results, quorum: 2, topUpRuns: used });
    expect(agg.belowQuorum).toBe(false);
    expect(agg.entry.runsAttempted).toBe(4);
    expect(agg.entry.runsScored).toBe(2);
    expect(agg.entry.topUpRuns).toBe(1);
    expect(agg.entry.evaluators["Builtin.Correctness"]).toEqual({ mean: 80, min: 70, max: 90, n: 2 });
  });
});

describe("resolveRunDeadline", () => {
  it("baseline mode default = 780 × repeat (2340s for repeat 3), flagged auto-scaled", () => {
    expect(resolveRunDeadline({ baselineMode: true, repeat: 3 })).toEqual({
      seconds: DEFAULT_RUN_DEADLINE_SECONDS * 3,
      autoScaled: true,
    });
    expect(DEFAULT_RUN_DEADLINE_SECONDS * 3).toBe(2340);
  });
  it("gate mode default = 780 regardless of repeat", () => {
    expect(resolveRunDeadline({ baselineMode: false, repeat: 3 })).toEqual({
      seconds: DEFAULT_RUN_DEADLINE_SECONDS,
      autoScaled: false,
    });
  });
  it("explicit env value wins verbatim in BOTH modes — never scaled", () => {
    expect(resolveRunDeadline({ baselineMode: true, repeat: 3, explicitSeconds: 3600 })).toEqual({
      seconds: 3600,
      autoScaled: false,
    });
    expect(resolveRunDeadline({ baselineMode: false, repeat: 3, explicitSeconds: 3600 })).toEqual({
      seconds: 3600,
      autoScaled: false,
    });
  });
});

describe("requiredToolFailureError: max-turns truncation annotation", () => {
  it("names the missing tools without the annotation on a deliberate prose finish", () => {
    expect(
      requiredToolFailureError({ missingRequiredTools: ["Tickets___create_ticket"], maxTurnsExceeded: undefined, turns: 4 })
    ).toBe("required tool(s) never called: Tickets___create_ticket");
  });

  it("appends the turn-cap annotation when the agent loop was truncated", () => {
    expect(
      requiredToolFailureError({
        missingRequiredTools: ["Tickets___create_ticket", "WorkflowOutput___report_completion"],
        maxTurnsExceeded: true,
        turns: 24,
      })
    ).toBe(
      "required tool(s) never called: Tickets___create_ticket, WorkflowOutput___report_completion (agent loop truncated at the 24-turn cap)"
    );
  });

  it("annotates a final reply cut off at the output-token cap (max_tokens stop)", () => {
    expect(
      requiredToolFailureError({
        missingRequiredTools: ["WorkflowOutput___report_completion"],
        maxTokensTruncated: true,
        turns: 5,
      })
    ).toBe(
      "required tool(s) never called: WorkflowOutput___report_completion (final reply truncated at the output-token cap)"
    );
  });

  it("passes the production-parity output-token cap to the transport, and a max_tokens stop that misses required tools carries the annotation", async () => {
    // Mirrors MAX_OUTPUT_TOKENS in deploy/runtime-agent/main.py — the old
    // 4096 cap cut long sonnet reviews before their required tool calls.
    expect(MAX_OUTPUT_TOKENS).toBe(32000);
    let seenMaxTokens = 0;
    const converse = async (params: any) => {
      seenMaxTokens = params.inferenceConfig?.maxTokens;
      return {
        stopReason: "max_tokens",
        usage: { inputTokens: 10, outputTokens: 5 },
        output: { message: { role: "assistant", content: [{ text: "very long review, cut off mid-" }] } },
      };
    };
    const result = (await runCase({
      caseDef: QA_CASE,
      repoRoot: REPO_ROOT,
      runId: "test",
      converse,
      signal: new AbortController().signal,
    })) as any;
    expect(seenMaxTokens).toBe(MAX_OUTPUT_TOKENS);
    expect(result.status).toBe("failed_required_tool");
    expect(result.maxTokensTruncated).toBe(true);
    expect(requiredToolFailureError(result)).toContain("(final reply truncated at the output-token cap)");
  });

  it("a runCase truncated at the turn cap reports failed_required_tool with the annotation", async () => {
    // Transport always asks for a harmless tool, so the loop can only end by
    // hitting maxTurns — required load_blueprint/report_completion never run.
    let n = 0;
    const converse = async () => ({
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5 },
      output: {
        message: { role: "assistant", content: [{ toolUse: { toolUseId: `t${++n}`, name: "current_time", input: {} } }] },
      },
    });
    // runCase's inferred return is a union across its error branches; the
    // truncation fields only exist on the success shape.
    const result = (await runCase({
      caseDef: QA_CASE,
      repoRoot: REPO_ROOT,
      runId: "test",
      converse,
      maxTurns: 2,
      signal: new AbortController().signal,
    })) as any;
    expect(result.status).toBe("failed_required_tool");
    expect(result.maxTurnsExceeded).toBe(true);
    expect(requiredToolFailureError(result)).toContain("(agent loop truncated at the 2-turn cap)");
  });
});
