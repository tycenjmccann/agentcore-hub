import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// The writer: the orchestrator's roll-up decides delivery.outcome at completion.
import { deliveryRollUp } from "../../../lambda/orchestrator/completion.mjs";
// The reader: the performance card re-derives it for rows that predate the roll-up.
import { deliveryOutcomeOf } from "../../../lambda/cost-report/index.mjs";

/**
 * TEAM-5337 — one empty_sweep rule (DL-035), three twins. The orchestrator
 * writes it; cost-report and the WM toolkit (compute_metrics.delivery_outcome,
 * test_metrics.py EmptySweep) read it back. All three run the SAME cases file,
 * so a reader that drifts from the writer fails here, not on a card that calls
 * an empty sweep a delivered run with a CI pass.
 */

const REPO = join(__dirname, "../../..");
const readJson = (rel: string) => JSON.parse(readFileSync(join(REPO, rel), "utf8"));
type Case = { name: string; fixture?: string; workflow?: Record<string, unknown>; persisted?: boolean; expected: string | null };
const { cases } = readJson("lambda/cost-report/fixtures/empty-sweep-cases.json") as { cases: Case[] };
const workflowOf = (c: Case) => (c.fixture ? readJson(c.fixture) : c.workflow) as { agentTasks?: Record<string, unknown> };

describe("empty_sweep parity: deliveryRollUp (writer) ⇔ deliveryOutcomeOf (card reader)", () => {
  it("covers both real empty-sweep rows", () => {
    expect(cases.filter((c) => c.fixture).map((c) => c.fixture)).toEqual([
      "lambda/orchestrator/fixtures/workflow-33rea7.json",
      "lambda/orchestrator/fixtures/workflow-f7jj7j.json",
    ]);
  });

  for (const c of cases) {
    it(c.name, () => {
      const wf = workflowOf(c);
      expect(deliveryOutcomeOf(wf)).toBe(c.expected);
      if (c.persisted) return;
      const written = deliveryRollUp([], wf.agentTasks ?? {}).outcome === "empty_sweep" ? "empty_sweep" : null;
      expect(written).toBe(c.expected);
    });
  }
});
