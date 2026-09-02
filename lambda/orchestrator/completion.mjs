/**
 * Workflow-completion re-verify (TEAM-3619 D4c).
 *
 * The pure decision behind the orchestrator's `isWorkflowComplete`, extracted so
 * it is unit-testable with plain data (no AWS, no ticket fetches) — same pattern
 * as ship-review.mjs / cascade.mjs. `index.mjs` fetches the epic's children and
 * the workflow def, then hands them here.
 *
 * Two branches:
 *   - Legacy (def declares no `completionRequiresAgentPhases`): the original
 *     suffix heuristic — at least one dev/QA/CI ticket done AND every child done.
 *     Unchanged, so unspecified/legacy runs behave exactly as before.
 *   - Config-driven: completion is decided PER REQUIRED PHASE. A run is done when,
 *     for every phase the def requires, (i) at least one agent ticket in that
 *     phase is done, (ii) every active BLOCKING review gate guarding that phase is
 *     approved (its gate ticket is done), (iii) no fix ticket routed under that
 *     phase is still open, and — preserving the original "the work is finished"
 *     guarantee — no agent ticket in that phase is still open. Advisory/backlog
 *     tickets outside the required phases no longer wedge a finished run open.
 *
 * A ticket's phase is its explicit `phase` stamp when present (D4c stamps spawned
 * fixes with their originating upstream phase, so a ship-review fix filed against
 * a dev still gates the SHIP phase), else the assignee's roster phase.
 */

const FIX_KINDS = new Set(["review_fix", "qa_fix", "codex_fix"]);

/**
 * TEAM-3686 Finding 3: deliverable-evidence check for the orchestrator's
 * completion path. Hand-port of the HTTP route's missingEvidenceTickets
 * (src/app/api/workflow/[id]/complete/route.ts) — same semantics: for every
 * DONE (not cancelled) child ticket whose phase is one the def requires for
 * completion, assert its agentTasks entry carries proof of work — a non-empty
 * string `output` OR an `artifactKey`. A "done" ticket with an empty task is a
 * phantom deliverable. Returns the offenders as [{ ticketId, phase }] (empty =
 * clean). Tickets whose phase can't be resolved, or whose phase isn't
 * required, are left alone — this only tightens, never invents work.
 *
 * A ticket's phase is its explicit `phase` stamp when present, else the
 * assignee's roster phase via opts.getAgentPhase — identical to phaseOf above.
 */
export function missingEvidenceTickets(children, agentTasks, requiredPhases, opts = {}) {
  if (!Array.isArray(children) || !Array.isArray(requiredPhases) || requiredPhases.length === 0) {
    return [];
  }
  const getAgentPhase = opts.getAgentPhase || (() => undefined);
  const phaseOf = (t) =>
    typeof t.phase === "string" && t.phase ? t.phase : getAgentPhase(t.assignee);
  const required = new Set(requiredPhases);
  const tasks = agentTasks && typeof agentTasks === "object" ? agentTasks : {};
  // agentTasks may be keyed by ticketId (orchestrator) or by task id with a
  // ticketId field (route tolerates both) — build the same secondary index.
  const byTicketId = new Map();
  for (const entry of Object.values(tasks)) {
    if (entry && typeof entry.ticketId === "string") byTicketId.set(entry.ticketId, entry);
  }
  const missing = [];
  for (const t of children) {
    if (t.type === "epic") continue;
    if (String(t.status || "").toLowerCase() !== "done") continue; // cancelled owes no evidence
    const phase = phaseOf(t);
    if (!phase || !required.has(phase)) continue;
    const ticketId = String(t.ticketId || "");
    const entry = tasks[ticketId] || byTicketId.get(ticketId);
    const hasOutput = typeof entry?.output === "string" && entry.output.trim().length > 0;
    const hasArtifact = typeof entry?.artifactKey === "string" && entry.artifactKey.length > 0;
    if (!hasOutput && !hasArtifact) missing.push({ ticketId, phase });
  }
  return missing;
}

const isDone = (t) => t.status === "done";
const isOpen = (t) => t.status !== "done" && t.status !== "cancelled";
const isHuman = (a) => typeof a === "string" && a.startsWith("human:");

/**
 * @param children  the epic's child tickets
 * @param wfDef     resolved workflow def ({ completionRequiresAgentPhases, reviewGates })
 * @param opts
 *   getAgentPhase(assignee) → agent phase for a ticket's assignee (undefined for humans/unknowns)
 *   gatePhaseOf(ticket)     → the phase a human-assignee gate ticket guards (undefined if unknown)
 *   requestedGates          → workflow.input.reviewGates (activates "flagged" gates)
 */
export function isWorkflowComplete(children, wfDef, opts = {}) {
  if (!Array.isArray(children) || children.length === 0) return false;

  const getAgentPhase = opts.getAgentPhase || (() => undefined);
  const gatePhaseOf =
    opts.gatePhaseOf || ((t) => (typeof t.phase === "string" ? t.phase : undefined));
  const requestedGates = Array.isArray(opts.requestedGates) ? opts.requestedGates : [];

  const phaseOf = (t) =>
    typeof t.phase === "string" && t.phase ? t.phase : getAgentPhase(t.assignee);

  const required = (wfDef && wfDef.completionRequiresAgentPhases) || [];

  // ── Legacy branch — preserved verbatim in spirit (suffix heuristic + all done).
  if (required.length === 0) {
    const hasTerminalDone = children.some((t) => {
      const a = t.assignee || "";
      const isDevOrQa = a.endsWith("_dev") || a.includes("_qa") || a.includes("_ci");
      return isDevOrQa && isDone(t);
    });
    return hasTerminalDone && children.every(isDone);
  }

  // ── Config-driven per-phase re-verify.
  const gates = (wfDef && wfDef.reviewGates) || [];
  const activeBlockingGatesFor = (p) =>
    gates.filter(
      (g) =>
        g.afterPhase === p &&
        g.blocking &&
        (g.condition === "always" || requestedGates.includes(g.afterPhase))
    );

  return required.every((p) => {
    const inPhase = children.filter((t) => phaseOf(t) === p);

    // (i) at least one agent ticket in the phase has finished.
    const hasDoneAgent = inPhase.some((t) => !isHuman(t.assignee) && isDone(t));
    if (!hasDoneAgent) return false;

    // Integrity: no agent ticket in the phase is still open (the original
    // guarantee that a phase's work is actually finished, scoped to this phase).
    const openAgent = inPhase.some((t) => !isHuman(t.assignee) && isOpen(t));
    if (openAgent) return false;

    // (iii) no spawned fix ticket routed under this phase is still open. Legacy
    //       tickets carry no `spawnedBy`, so they are simply not fix tickets.
    const openFix = children.some(
      (t) => t.spawnedBy && FIX_KINDS.has(t.spawnedBy.kind) && phaseOf(t) === p && isOpen(t)
    );
    if (openFix) return false;

    // (ii) every active blocking gate for the phase is approved. The gate ticket
    //      is a human-assignee child whose guarded phase is p; approval == done.
    //      If a required gate has no ticket yet, the gate hasn't been approved.
    const requiredGates = activeBlockingGatesFor(p);
    if (requiredGates.length > 0) {
      const gateTickets = children.filter((t) => isHuman(t.assignee) && gatePhaseOf(t) === p);
      if (gateTickets.length === 0) return false;
      if (!gateTickets.every(isDone)) return false;
    }

    return true;
  });
}
