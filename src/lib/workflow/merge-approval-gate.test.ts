import { describe, it, expect } from "vitest";
import workflowsJson from "../../config/workflows.json";
import {
  applyFramework,
  getWorkflowDef,
  isGateActive as isGateActiveTs,
  activeGates as activeGatesTs,
  SHIP_PHASES,
  type ReviewGate,
  type WorkflowDef,
} from "./workflow-defs";
import { intentGateFor } from "./intent";
// The orchestrator (Lambda) port of the resolver, plus the two consumers that
// must agree with it: the completion guard's blocking-gate set and the handoff
// strip. Imported from the .mjs directly — same pattern as
// workflow-def-validate-parity.test.ts — so a drift between the app and the
// orchestrator fails here instead of in production.
import {
  isGateActive as isGateActiveMjs,
  activeGates as activeGatesMjs,
  effectiveWorkflowDef,
} from "../../../lambda/orchestrator/cd-registry.mjs";
import { activeBlockingGatesFor, isWorkflowComplete } from "../../../lambda/orchestrator/completion.mjs";

/**
 * TEAM-4288 r3-F1 — the human Merge Approval gate must stay ACTIVE on every
 * CD-registered run.
 *
 * The four ship gates in src/config/workflows.json are condition:"cdRegistered"
 * (the honest declaration — D3a). Every activation predicate used to test only
 * `condition === "always" || requestedGates.includes(afterPhase)`, which is
 * false for a "cdRegistered" gate — so on a registered repo the intake agent was
 * never told to create the gate ticket and the completion guard never waited for
 * one: the human production gate silently disappeared. These tests load the REAL
 * config and pin the gate ACTIVE when registered / ABSENT when not.
 */

/** A registry containing `repo`, in the shape cd-registry.mjs parses. */
const registryWith = (repo: string) => ({ version: 1, repos: [{ repo }] });
const repoConfig = { repos: [{ url: "https://github.com/acme/widget" }] };
const REGISTERED = registryWith("acme/widget");
const UNREGISTERED = { version: 1, repos: [] };

/** Every (def, framework) pair in the real config that ships a ship-phase gate. */
const SHIP_GATE_DEFS: { label: string; def: WorkflowDef }[] = [
  { label: "software-delivery", def: getWorkflowDef("software-delivery") },
  {
    label: "software-delivery + playbook",
    def: applyFramework(getWorkflowDef("software-delivery"), "playbook"),
  },
  { label: "bug-fix", def: getWorkflowDef("bug-fix") },
  { label: "dead-code-sweep", def: getWorkflowDef("dead-code-sweep") },
];

const shipGateOf = (def: WorkflowDef) =>
  (def.reviewGates || []).find((g) => SHIP_PHASES.includes(g.afterPhase)) || null;

describe("real workflows.json — the four Merge Approval gates", () => {
  it("declares a cdRegistered ship gate in all four places (the source of truth this fix depends on)", () => {
    const found = SHIP_GATE_DEFS.map(({ label, def }) => {
      const gate = shipGateOf(def);
      return `${label}: ${gate?.name}/${gate?.condition}/${gate?.blocking}`;
    });
    expect(found).toEqual([
      "software-delivery: Merge Approval/cdRegistered/true",
      "software-delivery + playbook: Merge Approval/cdRegistered/true",
      "bug-fix: Merge Approval/cdRegistered/true",
      "dead-code-sweep: Merge Approval/cdRegistered/true",
    ]);
    // Guard the count too: a fifth def gaining a ship gate must be added above.
    const jsonShipGates = JSON.stringify(workflowsJson).match(/"Merge Approval"/g) || [];
    expect(jsonShipGates).toHaveLength(4);
  });

  for (const { label, def } of SHIP_GATE_DEFS) {
    describe(label, () => {
      const gate = shipGateOf(def) as ReviewGate;

      it("is ACTIVE for the intake agent on a CD-registered repo", () => {
        expect(isGateActiveTs(gate, { requestedGates: [], cdRegistered: true })).toBe(true);
        expect(activeGatesTs(def.reviewGates, { requestedGates: [], cdRegistered: true })).toContain(gate);
      });

      it("BLOCKS completion on a CD-registered repo until its gate ticket is done", () => {
        const effective = effectiveWorkflowDef(def, REGISTERED, repoConfig, SHIP_PHASES);
        expect(
          activeBlockingGatesFor(effective.reviewGates, "ship", { requestedGates: [], cdRegistered: true })
        ).toHaveLength(1);
      });

      it("is ABSENT on a handoff (unregistered) run — stripped, and inactive even if read raw", () => {
        const effective = effectiveWorkflowDef(def, UNREGISTERED, repoConfig, SHIP_PHASES);
        expect(shipGateOf(effective)).toBeNull();
        expect(isGateActiveTs(gate, { requestedGates: [], cdRegistered: false })).toBe(false);
        expect(
          activeBlockingGatesFor(def.reviewGates, "ship", { requestedGates: [], cdRegistered: false })
        ).toHaveLength(0);
      });
    });
  }
});

describe("completion guard honors the cdRegistered ship gate", () => {
  const DEF = {
    completionRequiresAgentPhases: ["development", "ship"],
    reviewGates: [{ afterPhase: "ship", name: "Merge Approval", blocking: true, condition: "cdRegistered", onReject: "rework" }],
  };
  const getAgentPhase = (a: string) => ({ dev: "development", rm: "ship" })[a];
  const shipWorkDone = [
    { ticketId: "T-1", assignee: "dev", status: "done" },
    { ticketId: "T-2", assignee: "rm", status: "done" },
  ];

  it("is NOT complete on a registered repo when no Merge Approval ticket exists", () => {
    expect(isWorkflowComplete(shipWorkDone, DEF, { getAgentPhase, cdRegistered: true })).toBe(false);
  });

  it("is NOT complete on a registered repo while the Merge Approval ticket is open", () => {
    const children = [...shipWorkDone, { ticketId: "G-1", assignee: "human:engineer", phase: "ship", status: "in_review" }];
    expect(isWorkflowComplete(children, DEF, { getAgentPhase, cdRegistered: true })).toBe(false);
  });

  it("completes on a registered repo once the Merge Approval ticket is done", () => {
    const children = [...shipWorkDone, { ticketId: "G-1", assignee: "human:engineer", phase: "ship", status: "done" }];
    expect(isWorkflowComplete(children, DEF, { getAgentPhase, cdRegistered: true })).toBe(true);
  });

  it("completes without a gate ticket when the repo is NOT registered (gate auto-absent)", () => {
    expect(isWorkflowComplete(shipWorkDone, DEF, { getAgentPhase, cdRegistered: false })).toBe(true);
  });
});

describe("resolver parity — app (TS) vs orchestrator (.mjs)", () => {
  const CONDITIONS = ["always", "cdRegistered", "flagged", undefined, "bogus"];
  const REQUESTED = [[], ["ship"], ["design"]];

  it("agrees on every condition x cdRegistered x requestedGates combination", () => {
    for (const condition of CONDITIONS) {
      for (const cdRegistered of [true, false]) {
        for (const requestedGates of REQUESTED) {
          const gate = { afterPhase: "ship", blocking: true, condition } as unknown as ReviewGate;
          const ctx = { requestedGates, cdRegistered };
          expect(
            [String(condition), cdRegistered, requestedGates.join(","), isGateActiveTs(gate, ctx)]
          ).toEqual(
            [String(condition), cdRegistered, requestedGates.join(","), isGateActiveMjs(gate, ctx)]
          );
        }
      }
    }
  });

  it("resolves the three declared condition values as documented", () => {
    const g = (condition: string) => ({ afterPhase: "ship", condition }) as unknown as ReviewGate;
    // always → active regardless of delivery mode or request.
    expect(isGateActiveTs(g("always"), { cdRegistered: false })).toBe(true);
    // cdRegistered → active iff the repo is CD-registered.
    expect(isGateActiveTs(g("cdRegistered"), { cdRegistered: true })).toBe(true);
    expect(isGateActiveTs(g("cdRegistered"), { cdRegistered: false })).toBe(false);
    // flagged (and anything else, incl. absent) → active iff requested by afterPhase.
    expect(isGateActiveTs(g("flagged"), { requestedGates: ["ship"] })).toBe(true);
    expect(isGateActiveTs(g("flagged"), { requestedGates: [] })).toBe(false);
    // Defaults are the fail-safe direction: no context → only "always" is active.
    expect(isGateActiveTs(g("cdRegistered"))).toBe(false);
    expect(isGateActiveMjs(g("cdRegistered"))).toBe(false);
    expect(isGateActiveTs(null as unknown as ReviewGate)).toBe(false);
    expect(isGateActiveMjs(null)).toBe(false);
  });

  it("gives the intake predicate and the completion predicate the SAME verdict for a ship gate", () => {
    for (const { def } of SHIP_GATE_DEFS) {
      for (const cdRegistered of [true, false]) {
        const ctx = { requestedGates: [], cdRegistered };
        // index.mjs's intake context: activeGates over the def's gates.
        const intakeActive = activeGatesMjs(def.reviewGates, ctx).filter(
          (g: ReviewGate) => g.afterPhase === "ship" && g.blocking
        );
        // completion.mjs's guard: the blocking gates it will wait for.
        const blocking = activeBlockingGatesFor(def.reviewGates, "ship", ctx);
        expect(intakeActive.map((g: ReviewGate) => g.name)).toEqual(
          blocking.map((g: ReviewGate) => g.name)
        );
      }
    }
  });
});

describe("intentGateFor honors cdRegistered", () => {
  const defWith = (condition: string) =>
    ({
      reviewGates: [{ afterPhase: "intake", name: "Intent Acceptance", blocking: true, condition }],
    }) as unknown as WorkflowDef;

  it("activates a cdRegistered intake gate only when the repo is registered", () => {
    expect(intentGateFor(defWith("cdRegistered"), [], { cdRegistered: true })?.name).toBe("Intent Acceptance");
    expect(intentGateFor(defWith("cdRegistered"), [], { cdRegistered: false })).toBeNull();
  });

  it("keeps the existing always / flagged behavior (2-arg callers unchanged)", () => {
    expect(intentGateFor(defWith("always"))?.name).toBe("Intent Acceptance");
    expect(intentGateFor(defWith("flagged"))).toBeNull();
    expect(intentGateFor(defWith("flagged"), ["intake"])?.name).toBe("Intent Acceptance");
  });

  it("activates the real playbook Intent Acceptance gate", () => {
    const def = applyFramework(getWorkflowDef("software-delivery"), "playbook");
    expect(intentGateFor(def, [])?.name).toBe("Intent Acceptance");
  });
});
