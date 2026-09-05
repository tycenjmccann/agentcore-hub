/**
 * TEAM-4112 — ship-dispatch prerequisite gate.
 *
 * The release_manager (ship phase) is dispatched the instant its Ship ticket
 * reaches Ready. In the happy path the ship ticket is blockedBy its dev/QA/CI
 * siblings, so Ready only arrives once they are done — but that guard fails
 * whenever the blockedBy graph is incomplete: the requirements agent forgot a
 * dependency edge, a reconcile/nudge re-drove the ticket to Ready early, or a
 * fix ticket re-opened a prerequisite AFTER the ship ticket already went Ready.
 * The RM then acts on a half-built PR — reviewing incomplete work or merging
 * ahead of QA — and the run either loops or ships unverified code.
 *
 * This is the deterministic backstop: at ship-ticket dispatch time, decide
 * whether the ship phase is actually eligible yet. It is GATED iff a NON-epic
 * prerequisite sibling — a ticket in one of the def's completion-required
 * phases that comes BEFORE ship, and that actually exists in this run — is not
 * terminal (done|cancelled). The caller (enforce) writes a blockedBy edge from
 * the ship ticket to that incomplete prerequisite so the EXISTING unblock
 * cascade re-wakes ship when the prerequisite completes — no bespoke sweep
 * needed, unlike the ship-head gate.
 *
 * Fail-safe direction matches the ship-head gate (a DISPATCH-BLOCKING gate: the
 * dangerous failure is wedging ship). So:
 *   - `shouldGateShipDispatch` gates ONLY on prerequisites whose phase is
 *     unambiguously classifiable AND present in this run — a ticket with an
 *     unresolvable phase (e.g. a human-review gate, whose assignee has no agent
 *     phase) is deliberately NOT counted here; those are handled by the
 *     blockedBy cascade + the human-review-gate path, and counting them would
 *     risk wedging ship on an unclassifiable ticket.
 *   - `normalizeShipDispatchMode` is a strict allow-list: anything not exactly
 *     off|shadow|enforce (including legacy "on"/"true"/"1") fails SAFE to off.
 *
 * off is byte-identical to today (the caller returns dispatch without computing
 * anything); shadow measures the would-gate rate with zero writes.
 */

const MODES = new Set(["off", "shadow", "enforce"]);
const TERMINAL = new Set(["done", "cancelled"]);
// When several prerequisites are incomplete, prefer to block ship on the one
// closest to ship in the pipeline — a stuck verification/CI ticket is the most
// actionable re-entry point — else fall back to the most recently touched.
const REPAIR_PHASE_PREFERENCE = ["verification", "ci", "review"];

/** Strict allow-list. Unknown (incl. legacy truthy "on"/"true"/"1") → off. */
export function normalizeShipDispatchMode(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return MODES.has(v) ? v : "off";
}

const idOf = (t) => t?.ticketId || t?.id || t?.key || null;

/**
 * Pure prerequisite verdict.
 *
 * @param {object}   p
 * @param {object}   p.agentDef      roster def of the ticket being dispatched
 * @param {object}   p.wfDef         workflow def (reads completionRequiresAgentPhases)
 * @param {object[]} p.siblings      all child tickets of the epic (incl. self + epic)
 * @param {function} p.getAgentPhase (assignee) => phase | undefined
 * @param {Set}      [p.shipPhases]  phases treated as "ship" (default {"ship"})
 * @returns {{gated:boolean, reason:string, repairBlocker:string|null, blockers:string[], prereqPhases:string[]}}
 */
export function shouldGateShipDispatch({ agentDef, wfDef, siblings, getAgentPhase, shipPhases }) {
  const ship = shipPhases instanceof Set ? shipPhases : new Set(["ship"]);
  const base = { gated: false, repairBlocker: null, blockers: [], prereqPhases: [] };

  if (!ship.has(agentDef?.phase)) return { ...base, reason: "not-ship-phase" };

  const required = Array.isArray(wfDef?.completionRequiresAgentPhases)
    ? wfDef.completionRequiresAgentPhases
    : [];
  // Only gate ship when the def's completion contract actually requires ship
  // (i.e. the run is not "complete" until ship is done). If ship isn't a
  // completion-required phase, holding it on prerequisites would risk wedging a
  // run that can legitimately finish without a ship ticket.
  if (!required.some((p) => ship.has(p))) return { ...base, reason: "ship-not-in-completion-contract" };

  const phaseOf = (t) => t?.phase || getAgentPhase?.(t?.assignee);
  const kids = (Array.isArray(siblings) ? siblings : []).filter((t) => t && t.type !== "epic");

  // Intersect the required-prereq phases with the phases ACTUALLY present in this
  // run's tickets — never gate on a phase that spawned no work (that ticket will
  // never complete, so the gate would never release).
  const present = new Set(kids.map(phaseOf).filter(Boolean));
  const prereqPhaseSet = new Set(
    required.filter((p) => !ship.has(p)).filter((p) => present.has(p))
  );
  if (prereqPhaseSet.size === 0) return { ...base, reason: "no-prereq-phases-present" };

  const prereqTickets = kids.filter((t) => prereqPhaseSet.has(phaseOf(t)));
  const blockers = prereqTickets.filter((t) => !TERMINAL.has(String(t.status).toLowerCase()));
  const prereqPhases = [...prereqPhaseSet];

  if (blockers.length === 0) {
    return { ...base, reason: "prereqs-complete", prereqPhases };
  }

  const repair = pickRepairBlocker(blockers, phaseOf);
  return {
    gated: true,
    reason: "prereqs-incomplete",
    repairBlocker: idOf(repair),
    blockers: blockers.map(idOf).filter(Boolean),
    prereqPhases,
  };
}

/** Prefer a verification/CI/review prerequisite; else the most recently touched. */
function pickRepairBlocker(blockers, phaseOf) {
  const rank = (t) => {
    const i = REPAIR_PHASE_PREFERENCE.indexOf(phaseOf(t));
    return i === -1 ? REPAIR_PHASE_PREFERENCE.length : i;
  };
  const ts = (t) => Date.parse(t?.updatedAt || t?.createdAt || 0) || 0;
  return [...blockers].sort((a, b) => rank(a) - rank(b) || ts(b) - ts(a))[0];
}

/**
 * EMF metric emitter (same namespace/shape as ship-head-stability + merge-on-green).
 * `counter` is one of the metric keys, or null to emit an all-zero heartbeat.
 */
export function emitShipDispatchMetrics(counter, now = Date.now) {
  const m = { wouldGate: 0, gated: 0, clear: 0 };
  if (counter && counter in m) m[counter] = 1;
  console.log(JSON.stringify({
    _aws: {
      Timestamp: typeof now === "function" ? now() : now,
      CloudWatchMetrics: [{
        Namespace: "AgentCoreHub/Orchestrator",
        Dimensions: [[]],
        Metrics: [
          { Name: "ShipDispatchWouldGate", Unit: "Count" },
          { Name: "ShipDispatchGated", Unit: "Count" },
          { Name: "ShipDispatchClear", Unit: "Count" },
        ],
      }],
    },
    ShipDispatchWouldGate: m.wouldGate,
    ShipDispatchGated: m.gated,
    ShipDispatchClear: m.clear,
  }));
}
