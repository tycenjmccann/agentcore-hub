import { describe, it, expect } from "vitest";

// The writer of a ship outcome and the reader of it ship as two separate Lambda
// zips, so they cannot share a module — the vocabulary is duplicated instead.
import { SHIP_OUTCOMES } from "../../../lambda/workflow-output/index.mjs";
import {
  SHIP_BLOCKED_OUTCOMES,
  TERMINAL_WORKFLOW_PHASES,
  shipVerdictOf,
} from "../../../lambda/orchestrator/completion.mjs";
import { TERMINAL_PHASES } from "./types";

/**
 * TEAM-4740 FR-10 parity contract — same shape as fix-contract-parity.test.ts.
 *
 * `report_completion` (workflow-output) decides which ship outcomes may be
 * WRITTEN; `shipVerdictOf` (orchestrator completion) decides what each one MEANS
 * for closing the run. A value accepted by the writer that the reader cannot
 * classify is the exact failure this ticket exists to remove: the run either
 * closes green on a ship that never happened, or wedges open forever because its
 * terminal outcome reads as unknown. So every member of SHIP_OUTCOMES must have a
 * decided verdict here, and the test must fail on a value added to one side only.
 */
describe("ship outcome vocabulary — writer/reader parity (TEAM-4740 FR-10)", () => {
  /**
   * The FULL map, spelled out by hand on purpose: a blanket "is not undefined"
   * assertion would pass for a new outcome that silently fell into the wrong
   * bucket.
   *
   * TEAM-4763 P1-A — `handoff` maps to ITSELF, not to `null`. The old `null` here
   * recorded the defect as a contract: evaluateShipVerdict reads a null verdict as
   * SILENCE, not as "no verdict claimed", so a run that honestly handed its PR to
   * another team was closed on the static-ci-only terminal phase. It is also not an
   * alias for "shipped" — nothing merged, so deliveryRollUp must not derive
   * prState "merged" for a PR that workflow-output's derivePrState calls "open".
   */
  const VERDICTS: Record<string, string | null> = {
    shipped: "shipped",
    "deploy-blocked": "deploy-blocked",
    "static-ci-only": "static-ci-only",
    handoff: "handoff",
    empty_sweep: "shipped",
  };

  it("every writable ship outcome has a DECIDED verdict on the reader side", () => {
    expect(SHIP_OUTCOMES.length).toBeGreaterThan(0);
    for (const outcome of SHIP_OUTCOMES) {
      // Decided, i.e. present in the table above — never `undefined`, which is
      // what an outcome the reader has never heard of looks like.
      expect(VERDICTS, `SHIP_OUTCOMES has "${outcome}" with no verdict`).toHaveProperty(outcome);
      expect(shipVerdictOf({ outcome })).toBe(VERDICTS[outcome]);
    }
  });

  it("has no verdict for an outcome the writer would refuse", () => {
    // The other direction: the table is not allowed to grow a value the writer
    // cannot produce, or the reader is carrying dead vocabulary.
    for (const outcome of Object.keys(VERDICTS)) {
      expect(SHIP_OUTCOMES, `verdict for "${outcome}" that no writer can emit`).toContain(outcome);
    }
    expect(shipVerdictOf({ outcome: "totally-made-up" })).toBeNull();
  });

  it("accepts empty_sweep as writable and reads it as shipped", () => {
    expect(SHIP_OUTCOMES).toContain("empty_sweep");
    expect(shipVerdictOf({ outcome: "empty_sweep" })).toBe("shipped");
  });

  it("keeps empty_sweep out of the BLOCKED set and every terminal-phase mirror", () => {
    // A sweep with nothing to remove was not blocked — nothing was attempted and
    // refused — so it must not join the honest-close outcomes.
    expect(SHIP_BLOCKED_OUTCOMES).not.toContain("empty_sweep");
    // And it is an OUTCOME, not a PHASE: a run still closes on `complete`. Landing
    // it in either terminal-phase list would change what the reconcile sweep, the
    // dead-session detector and resolveDedup all consider a closed run.
    expect(TERMINAL_WORKFLOW_PHASES).not.toContain("empty_sweep");
    expect(TERMINAL_PHASES as readonly string[]).not.toContain("empty_sweep");
  });

  it("keeps the two terminal-phase lists in agreement", () => {
    // Pre-existing invariant, re-asserted because this ticket touches the list
    // they are both derived from.
    expect([...TERMINAL_WORKFLOW_PHASES].sort()).toEqual([...TERMINAL_PHASES].sort());
  });
});
