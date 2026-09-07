import { describe, it, expect } from "vitest";
import {
  WORKFLOW_DEFS,
  lintWorkflowDefShape as lintTs,
  validateWorkflowDef as validateTs,
} from "./workflow-defs";
// The orchestrator (Lambda) port. Both copies MUST reach the SAME verdict and
// the SAME message on the same def — a drift means the app's run-creation reject
// (validateWorkflowDef, HTTP 400) and the orchestrator's in-flight warn / bug
// bootstrap reject (validateEffectiveDef) disagree on whether a def is honest.
import {
  lintWorkflowDefShape as lintMjs,
  validateEffectiveDef as validateMjs,
  validateDefForCreation,
} from "../../../lambda/orchestrator/workflow-def-validate.mjs";

/**
 * TEAM-4167 D3 parity contract: the .mjs mirror of the honesty lint + repo-aware
 * validation must agree bit-for-bit with the TS source. Compare verdicts (throw
 * vs not) AND messages on: every bundled def (all honest → both lints pass), a
 * synthetic always-ship-gate def unregistered (both throw, naming the gate) and
 * the same def registered (both pass with the same warnings).
 */

/** Run a fn; return the thrown message, or null when it did not throw. */
function thrownMessage(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const alwaysShipGate = {
  afterPhase: "ship",
  name: "Merge Approval",
  blocking: true,
  condition: "always" as const,
  onReject: "hold" as const,
};

function alwaysShipDef() {
  return {
    id: "synthetic-always-ship",
    name: "Synthetic",
    description: "",
    icon: "x",
    intakeAgentId: "a",
    requiresRepo: true,
    featureBranchPhase: null,
    createsPullRequest: true,
    completionRequiresAgentPhases: ["ship"],
    reviewGates: [alwaysShipGate],
    phases: [
      { id: "dev", name: "Dev", type: "agent" as const, agentPhase: "development" },
      { id: "ship", name: "Ship", type: "agent" as const, agentPhase: "ship" },
    ],
  };
}

function unknownPhaseGateDef() {
  const def = alwaysShipDef();
  return {
    ...def,
    id: "synthetic-unknown-phase",
    reviewGates: [{ afterPhase: "nope", name: "Ghost", blocking: true, condition: "flagged" as const, onReject: "hold" as const }],
  };
}

describe("workflow-def-validate parity: workflow-defs.ts ≡ workflow-def-validate.mjs", () => {
  it("both lints PASS on every bundled def (all honest)", () => {
    for (const def of WORKFLOW_DEFS) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ts = thrownMessage(() => lintTs(def as any));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mjs = thrownMessage(() => lintMjs(def as any));
      expect(ts, `TS lint threw for bundled def ${def.id}`).toBeNull();
      expect(mjs, `MJS lint threw for bundled def ${def.id}`).toBeNull();
    }
    expect(WORKFLOW_DEFS.length).toBeGreaterThan(0);
  });

  it("an always ship gate on a NON-registered repo throws the same message in both", () => {
    const def = alwaysShipDef();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ts = thrownMessage(() => validateTs(def as any, { cdRegistered: false }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mjs = thrownMessage(() => validateMjs(def as any, { cdRegistered: false }));
    expect(ts).not.toBeNull();
    expect(ts).toBe(mjs);
    expect(ts).toContain("Merge Approval");
    expect(ts).toContain('condition="always"');
  });

  it("the SAME def on a REGISTERED repo passes in both (identical warnings)", () => {
    const def = alwaysShipDef();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ts = validateTs(def as any, { cdRegistered: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mjs = validateMjs(def as any, { cdRegistered: true });
    // A surviving (non-flagged) ship gate exists, so no "no human merge gate" warning.
    expect(ts.warnings).toEqual([]);
    expect(mjs.warnings).toEqual(ts.warnings);
  });

  it("a gate on an unknown phase throws the same message in both (registration-independent)", () => {
    for (const cdRegistered of [true, false]) {
      const def = unknownPhaseGateDef();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ts = thrownMessage(() => validateTs(def as any, { cdRegistered }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mjs = thrownMessage(() => validateMjs(def as any, { cdRegistered }));
      expect(ts).not.toBeNull();
      expect(ts).toBe(mjs);
      expect(ts).toContain('afterPhase="nope"');
    }
  });
});

/**
 * TEAM-4167 D3 CALL 6 F2: validateDefForCreation is the run-CREATION guard the
 * bug-bootstrap path uses — it turns validateEffectiveDef's throw into a verdict
 * so the caller can refuse a genuinely-misconfigured def (and comment on the bug)
 * while a transient loader error stays OUTSIDE this call and propagates. Pure,
 * so it is unit-testable directly here.
 */
describe("validateDefForCreation (run-creation verdict, never throws)", () => {
  it("returns { ok: true } (no message) on a valid def", () => {
    const verdict = validateDefForCreation(alwaysShipDef() as never, true);
    expect(verdict).toEqual({ ok: true });
  });

  it("returns { ok: false, message } — the SAME message validateEffectiveDef would throw — on an invalid def", () => {
    const def = alwaysShipDef();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const thrown = thrownMessage(() => validateMjs(def as any, { cdRegistered: false }));
    const verdict = validateDefForCreation(def as never, false);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toBe(thrown);
    expect(verdict.message).toContain("Merge Approval");
  });
});
