/**
 * Workflow-def validation — the orchestrator (.mjs) twin of the shape lint and
 * repo-aware validation in src/lib/workflow/workflow-defs.ts
 * (lintWorkflowDefShape / validateWorkflowDef).
 *
 * The orchestrator cannot import the TS source, so this mirrors it: SAME ship
 * set (["ship"]), SAME known-phase universe (phase order ∪ every phase's
 * extraAgentPhases), and — critically — BYTE-IDENTICAL error messages, so the
 * two implementations reach the same verdict on the same def. A parity test
 * (workflow-def-validate.parity.test.mjs) pins that equivalence.
 *
 * Why both a load-time lint (repo-agnostic) and a run-creation validate
 * (repo-aware): a ship gate with condition:"always" is a phantom human
 * expectation on any handoff run; the honest declarations are "cdRegistered"
 * (auto-absent on handoff) or "flagged" (opt-in). See docs/agents-own-cd.md.
 *
 * Pure — no I/O, no clock, no AWS — so index.mjs owns the S3 read and the
 * cdRegistered decision, and this file is unit-testable in isolation.
 */

/**
 * Ship-phase agent phases. Keep in sync with SHIP_PHASES in
 * src/lib/workflow/workflow-defs.ts and the ["ship"] passed to stripShipPhases
 * in cd-registry.mjs.
 */
export const SHIP_PHASES = ["ship"];

/**
 * The known-phase universe of a def: its phase ORDER plus every phase's
 * extraAgentPhases (display-only rollup phases such as software-delivery's
 * "ship"/"review" that fold onto the QA card). Mirrors the TS
 * `new Set([...getPhaseOrder(def), ...def.phases.flatMap(p => p.extraAgentPhases)])`.
 *
 * The orchestrator's mapped def already carries a deduped `phaseOrder`
 * (loadWorkflowDefs); when absent we derive it from `phases` the same way
 * getPhaseOrder does (intake + agentPhases, terminal "complete").
 */
function knownPhases(def) {
  const phases = Array.isArray(def?.phases) ? def.phases : [];
  let order;
  if (Array.isArray(def?.phaseOrder) && def.phaseOrder.length) {
    order = def.phaseOrder;
  } else {
    order = ["intake", ...phases.filter((p) => p.agentPhase !== "intake").map((p) => p.agentPhase).filter(Boolean)];
    const seen = new Set();
    order = order.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
    order.push("complete");
  }
  return new Set([...order, ...phases.flatMap((p) => p.extraAgentPhases || [])]);
}

/**
 * Repo-AGNOSTIC honesty lint for a def's SHAPE — twin of
 * workflow-defs.ts lintWorkflowDefShape. A ship-phase gate must never be
 * condition:"always". Validates the def's own reviewGates AND every framework
 * overlay's reviewGates. Throws on the first offender.
 */
export function lintWorkflowDefShape(def) {
  const check = (gates, where) => {
    for (const gate of gates || []) {
      if (SHIP_PHASES.includes(gate.afterPhase) && gate.condition === "always") {
        const label = gate.name ?? gate.afterPhase;
        throw new Error(
          `Workflow def "${def.id}"${where}: ship gate "${label}" has condition:"always"; ` +
            `ship gates must be condition:"cdRegistered" or "flagged".`
        );
      }
    }
  };
  check(def?.reviewGates, "");
  for (const [name, overlay] of Object.entries(def?.frameworks || {})) {
    check(overlay?.reviewGates, ` (framework "${name}")`);
  }
}

/**
 * Repo-AWARE validation of a resolved (framed) def against ONE run's delivery
 * mode — twin of workflow-defs.ts validateWorkflowDef.
 *
 * THROWS on: a reviewGate.afterPhase that is not a known phase of this def; a
 * ship-phase gate with condition:"always" on a repo that is NOT CD-registered.
 * RETURNS { warnings } (does not throw) when completion requires a ship phase
 * but no non-flagged ship gate survives on a CD-registered repo.
 */
export function validateEffectiveDef(def, { cdRegistered } = {}) {
  const warnings = [];
  const known = knownPhases(def);
  const gates = Array.isArray(def?.reviewGates) ? def.reviewGates : [];

  for (const gate of gates) {
    const label = gate.name ?? gate.afterPhase;
    if (!known.has(gate.afterPhase)) {
      throw new Error(
        `Workflow def "${def.id}" declares review gate "${label}" with afterPhase="${gate.afterPhase}", ` +
          `which is not a phase of this def (known phases: ${[...known].join(", ")}).`
      );
    }
    if (SHIP_PHASES.includes(gate.afterPhase) && gate.condition === "always" && !cdRegistered) {
      throw new Error(
        `Workflow def "${def.id}" declares review gate "${label}" (afterPhase="ship", condition="always") ` +
          `but the target repo is not CD-registered. A ship gate on a handoff run is unreachable — ` +
          `set condition:"cdRegistered" (auto-absent on handoff) or register the repo. See docs/agents-own-cd.md.`
      );
    }
  }

  const requiresShip = (def?.completionRequiresAgentPhases || []).some((p) => SHIP_PHASES.includes(p));
  if (requiresShip && cdRegistered) {
    const surviving = gates.some((g) => SHIP_PHASES.includes(g.afterPhase) && g.condition !== "flagged");
    if (!surviving) {
      warnings.push(
        `Workflow def "${def.id}" requires a ship phase for completion but declares no ship review gate ` +
          `on a CD-registered repo — completion will not wait on any human merge approval.`
      );
    }
  }

  return { warnings };
}

/**
 * Run-CREATION guard (TEAM-4167 D3 CALL 6 F2). Wraps validateEffectiveDef and
 * returns a VERDICT ({ ok, message }) instead of throwing, so the caller can
 * cleanly separate a genuinely misconfigured def (refuse the run, tell the
 * reporter) from an infra error in whatever loaded the def/registry — those
 * reads must stay OUTSIDE this call so a transient S3 blip propagates and is
 * retried, never laundered into a "your workflow is misconfigured" refusal.
 *
 * Pure: no I/O. `framed` is the already-framed def; `cdRegistered` is the
 * caller's resolved delivery mode. On the valid path returns { ok: true } and
 * drops the soft warnings (creation cares only about the hard reject — the
 * in-flight path is where warnings are surfaced).
 */
export function validateDefForCreation(framed, cdRegistered) {
  try {
    validateEffectiveDef(framed, { cdRegistered });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err?.message || String(err) };
  }
}
