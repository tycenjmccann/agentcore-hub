// Live spend ceiling (B5): maxRunUsd is enforced BETWEEN turns and BETWEEN
// cases, not reported after the fact. Fake transports throughout — no AWS.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSpendLedger, SpendCeilingExceededError } from "../lib/spend.mjs";
import { runCase, isRetryableTransportError } from "../lib/agent-runner.mjs";
import { evaluateSuite } from "../lib/thresholds.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const QA_CASE = JSON.parse(
  readFileSync(join(REPO_ROOT, "evals/battery/cases/qa-verifier-regression-001.json"), "utf8")
);

// runCase requires the runner's end-to-end deadline signal; this test's
// ceiling breach comes from the ledger, so the signal never aborts.
const signal = new AbortController().signal;

const THRESHOLDS = { overallDropMaxPoints: 5, floorRule: { floorDelta: 10, minAbsoluteFloor: 40 }, maxRunUsd: 20 };
const BASELINE = {
  schemaVersion: 1,
  scoringBackend: "local-judge",
  bootstrap: false,
  cases: {
    "case-a": { evaluators: { "Builtin.Correctness": { mean: 90, min: 90, max: 90, n: 3 } } },
    [QA_CASE.id]: { evaluators: { "Builtin.Correctness": { mean: 90, min: 90, max: 90, n: 3 } } },
    "case-c": { evaluators: { "Builtin.Correctness": { mean: 90, min: 90, max: 90, n: 3 } } },
  },
};

const usage = { inputTokens: 100, outputTokens: 10 };
const endTurn = (text = "Done.") => ({ stopReason: "end_turn", usage, output: { message: { role: "assistant", content: [{ text }] } } });
const toolUse = (name: string, input: any, id = "t1") => ({
  stopReason: "tool_use",
  usage,
  output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: id, name, input } }] } },
});

describe("ledger accounting", () => {
  it("meters each response by tier and treats exactly maxUsd as within the ceiling", () => {
    const ledger = createSpendLedger({ maxUsd: 6 });
    ledger.add("haiku", { inputTokens: 1_000_000, outputTokens: 1_000_000 }); // $1 + $5
    expect(ledger.spentUsd).toBe(6);
    expect(ledger.exceeded).toBe(false);
    expect(ledger.failureReasons()).toEqual([]);
    ledger.add("judge", { inputTokens: 200_000, outputTokens: 0 }); // +$1
    expect(ledger.exceeded).toBe(true);
    expect(ledger.failureReasons()[0]).toContain("run spend ceiling exceeded");
    expect(ledger.failureReasons()[0]).toContain("maxRunUsd $6.00");
  });

  it("refuses the next Converse call once the ceiling is up instead of spending more", async () => {
    const ledger = createSpendLedger({ maxUsd: 1, cost: () => 0.6 });
    let calls = 0;
    const transport = async () => {
      calls++;
      return endTurn();
    };
    const metered = ledger.meter(transport, "haiku", "case-a");
    await metered({}, {});
    await metered({}, {});
    await expect(metered({}, {})).rejects.toThrow(SpendCeilingExceededError);
    expect(calls).toBe(2); // the third call never reached the transport
    expect(ledger.abortedCaseIds).toEqual(["case-a"]);
    // A ceiling breach must never look like a retryable transport blip.
    expect(isRetryableTransportError(new SpendCeilingExceededError("x"))).toBe(false);
  });
});

describe("mid-run ceiling inside a case", () => {
  it("aborts the in-flight case (errored, no retry) and leaves the ledger over the ceiling", async () => {
    const ledger = createSpendLedger({ maxUsd: 20, cost: () => 15 });
    const script = [
      toolUse("load_blueprint", { blueprint_name: "qa-verifier" }),
      toolUse("WorkflowOutput___report_completion", { ticket_id: "BATT-110", summary: "PASS" }, "t2"),
      endTurn(),
    ];
    let i = 0;
    const run = await runCase({
      caseDef: QA_CASE,
      repoRoot: REPO_ROOT,
      runId: "spend1",
      converse: ledger.meter(async () => script[i++], QA_CASE.modelTier, QA_CASE.id),
      signal,
    });
    expect(run.status).toBe("errored");
    expect(run.attempt).toBe(1); // typed-transport retries only — a ceiling breach is not one
    if (!("error" in run)) throw new Error(`expected an errored run with an error, got '${run.status}'`);
    expect(run.error).toContain("run spend ceiling reached");
    expect(run.error).toContain(`aborting case '${QA_CASE.id}'`);
    expect(i).toBe(2); // third turn never dispatched
    expect(ledger.exceeded).toBe(true);

    // The runner then skips whatever had not started, and the suite must fail
    // — as ERRORED (TEAM-3295): the aborted run is an infra outcome, not a
    // score verdict. Still red, still exit 1.
    ledger.noteAborted("case-c");
    const suite = evaluateSuite({
      thresholds: THRESHOLDS,
      baseline: BASELINE,
      caseResults: [
        { id: "case-a", status: "scored", scores: { "Builtin.Correctness": 90 } },
        { id: QA_CASE.id, status: "errored", error: run.error },
        { id: "case-c", status: "skipped", error: ledger.message("case 'case-c' was not started") },
      ],
      newCaseIds: [],
      costEstimateUsd: ledger.spentUsd,
      scoringBackend: "local-judge",
      costCeilingReasons: ledger.failureReasons(),
    });
    expect(suite.verdict).toBe("ERRORED");
    expect(suite.verdict).not.toBe("PASS");
    const reasons = suite.failureReasons.join("\n");
    expect(reasons).toContain("run spend ceiling exceeded");
    expect(reasons).toContain("Aborted/unrun case(s):");
    expect(reasons).toContain("case-c");
    expect(reasons).toContain("case case-c: status 'skipped'");
  });
});

describe("suite-level bound", () => {
  // Mirrors runPool() in run-battery.mjs.
  async function runPool<T, R>(items: T[], size: number, worker: (item: T) => Promise<R>) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(size, items.length) }, async () => {
        while (next < items.length) {
          const i = next++;
          results[i] = await worker(items[i]);
        }
      })
    );
    return results as R[];
  }

  it("bounds total spend to ~maxRunUsd plus the turns in flight, and skips the rest", async () => {
    const POOL = 4;
    const CEILING = 20;
    const ledger = createSpendLedger({ maxUsd: CEILING, cost: () => 1 }); // $1 per turn
    const ids = Array.from({ length: 40 }, (_, n) => `case-${n}`);

    const results = await runPool(ids, POOL, async (id) => {
      // Same guard the runner applies before starting a case.
      if (ledger.exceeded) {
        ledger.noteAborted(id);
        return { id, status: "skipped" };
      }
      const metered = ledger.meter(async () => endTurn(), "haiku", id);
      try {
        for (let turn = 0; turn < 5; turn++) await metered({}, {});
        return { id, status: "scored" };
      } catch (err: any) {
        expect(err.spendCeiling).toBe(true);
        return { id, status: "errored" };
      }
    });

    const counts = results.reduce((acc: any, r: any) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
    expect(counts.skipped).toBeGreaterThan(0); // work was abandoned, not silently completed
    expect(ledger.spentUsd).toBeGreaterThan(CEILING); // the ceiling was actually reached
    // Overshoot is bounded by the turns already dispatched across the pool, not
    // by "whatever the remaining 40 cases would have cost" ($200).
    expect(ledger.spentUsd).toBeLessThanOrEqual(CEILING + POOL);
    expect(ledger.abortedCaseIds.length).toBeGreaterThan(0);
    expect(ledger.failureReasons()).toHaveLength(1);
  });
});
