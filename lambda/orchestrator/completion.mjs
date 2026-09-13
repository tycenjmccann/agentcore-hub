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

/**
 * TEAM-4121 FR-8 — PARITY MIRROR of FIX_KINDS in lambda/orchestrator/fix-contract.mjs
 * (and its byte-identical copies in both ticket Lambdas), the kind union in
 * src/lib/workflow/types.ts, and the origin map in deploy/runtime-agent/main.py.
 * Kept as a literal Set because scripts/check-fix-kinds-parity.sh greps the
 * literal from each location — importing it would defeat the check (and this
 * module is loaded by callers that don't ship fix-contract.mjs in tests).
 * Add a kind in EVERY place listed above or CI fails.
 */
export const FIX_KINDS = new Set(["review_fix", "qa_fix", "codex_fix", "ship_fix", "ci_fix", "sync_fix"]);

/**
 * The subset that represents a HUMAN-authored rework round. ci_fix and sync_fix
 * are environmental (a red build, a branch out of sync) — they are real fix
 * tickets, so the open-fix completion gate must wait on them, but they must NOT
 * count toward the rework-loop cap's human escalation: a flaky pipeline would
 * otherwise escalate a run that nobody is looping on.
 * PARITY MIRROR of REWORK_FIX_KINDS in fix-contract.mjs.
 */
export const REWORK_FIX_KINDS = new Set(["review_fix", "qa_fix", "codex_fix", "ship_fix"]);

/**
 * TEAM-3747 D2 — lifecycle-integrity terminal outcomes ("no green close over
 * unshipped work"). PARITY MIRROR of src/lib/workflow/types.ts SHIP_BLOCKED_OUTCOMES
 * (this .mjs module cannot import the TS module). Also mirrored in
 * deploy/workflow-manager/toolkit/save_analysis.py RUN_OUTCOMES. Keep the three
 * lists in agreement — a value here must exist there and vice-versa.
 *   - "deploy-blocked" : a deploy/preflight was attempted and blocked.
 *   - "static-ci-only" : CI was green but nothing was merged/deployed.
 */
export const SHIP_BLOCKED_OUTCOMES = ["deploy-blocked", "static-ci-only"];

/**
 * TEAM-3755 F2 — the ONE list of phases a run can already be closed on. Every
 * terminal-claim CAS must refuse ALL of them, or a later write can overwrite an
 * earlier honest verdict.
 *
 * The bug this fixes: completeWorkflow's ConditionExpression excluded only
 * complete/cancelled/error, so a run already closed "deploy-blocked" or
 * "static-ci-only" (the TEAM-3747 D2 honest-close outcomes) still satisfied the
 * condition — a completion racing in behind the block silently overwrote the
 * blocked phase with "complete", destroying the FR-D2.2 evidence that nothing
 * shipped. claimTerminalOutcome already listed all five; the two writes had
 * drifted apart because each spelled the list out by hand.
 *
 * Derived from SHIP_BLOCKED_OUTCOMES so a sixth outcome cannot be added to one
 * write and forgotten in the other. PARITY MIRROR of the TERMINAL_PHASES in
 * src/lib/workflow/types.ts (same five values, same purpose).
 */
export const TERMINAL_WORKFLOW_PHASES = Object.freeze([
  "complete",
  "cancelled",
  "error",
  ...SHIP_BLOCKED_OUTCOMES,
]);

/**
 * Build the "not already terminal" half of a terminal-claim ConditionExpression
 * from TERMINAL_WORKFLOW_PHASES. Returns { condition, values } to splice into an
 * UpdateCommand; `nameRef` is how the caller refers to the phase attribute
 * ("phase" bare, or "#phase" when it is aliased).
 *
 * Placeholders are positional (:tp0…) so they can never collide with a caller's
 * own SET values, and every declared value IS referenced by the condition —
 * DynamoDB rejects an unused ExpressionAttributeValues entry.
 */
export function notTerminalPhaseGuard(nameRef = "phase") {
  const values = {};
  const condition = TERMINAL_WORKFLOW_PHASES.map((phase, i) => {
    const key = `:tp${i}`;
    values[key] = phase;
    return `${nameRef} <> ${key}`;
  }).join(" AND ");
  return { condition, values };
}

/**
 * TEAM-3755 F8 — the SCAN counterpart of notTerminalPhaseGuard: the
 * "still open" FilterExpression the background sweeps (reconcile-sweep.mjs, the
 * dead-session detector) use to skip finished runs, derived from the SAME
 * TERMINAL_WORKFLOW_PHASES list so a sweep can never re-drive work inside a run
 * that already closed deploy-blocked / static-ci-only.
 *
 * Deliberately the `NOT (#p IN (…))` form the sweeps already used, NOT the
 * guard's chain of `<>`: for an item with NO phase attribute the two differ —
 * `IN` evaluates false so `NOT (…)` KEEPS the row, whereas every `<>` would
 * evaluate false and DROP it. Rows in the workflows table that carry no phase
 * (e.g. the start-route dedup markers) must keep reading as non-terminal exactly
 * as before; this helper changes which phases are excluded, nothing else.
 */
export function notTerminalPhaseFilter(nameRef = "#p") {
  const values = {};
  const keys = TERMINAL_WORKFLOW_PHASES.map((phase, i) => {
    const key = `:tp${i}`;
    values[key] = phase;
    return key;
  });
  return { filter: `NOT (${nameRef} IN (${keys.join(", ")}))`, values };
}

/**
 * Agent phases whose done tickets owe a MERGE/DEPLOY verdict rather than mere
 * output (the ship / CD stage). A def opts in by listing "ship" in its
 * completionRequiresAgentPhases; runs with no ship phase are wholly unaffected.
 */
export const SHIP_PHASES = new Set(["ship"]);

/**
 * Is this child a HUMAN review gate rather than agent work? Assignee `human:<who>`
 * (the Jira/DDB mappers derive it from the `reviewer:<who>` label) or the
 * `human-review` marker label. Exported for the HTTP route's TS twin parity test.
 */
export function isHumanGateTicket(t) {
  if (typeof t?.assignee === "string" && t.assignee.startsWith("human:")) return true;
  return Array.isArray(t?.labels) && t.labels.some((l) => String(l).trim().toLowerCase() === "human-review");
}

// ─── TEAM-4122 FR-7: advisory tickets ────────────────────────────────────────

const isDone = (t) => t.status === "done";
const isOpen = (t) => t.status !== "done" && t.status !== "cancelled";
const isHuman = (a) => typeof a === "string" && a.startsWith("human:");

/**
 * TEAM-4131 F2 — the ticket shapes that can NEVER be advisory, whatever their
 * labels say.
 *
 * `advisory` means "backlog this run does not wait on", so under enforce the
 * label removes a child from every gate below. On a FIX ticket that is a bypass
 * of the exact gate the fix exists to hold: `labels: ["advisory"]` on a real
 * qa_fix let the run finalize with the fix open. The label reaches a ticket
 * through create_ticket's user-supplied `labels`, which any persona (or a
 * prompt-injected one) can set, and main.py exposes `labels` to all of them.
 *
 * fix-contract.mjs now refuses to STORE the word on these shapes, which is the
 * write-side half. This is the read-side half, and it is the one that must hold:
 * it covers tickets stored before that guard existed, a hand-edited board, and
 * any future writer that forgets to pass the ticket shape to sanitizeUserLabels.
 * A human gate is included for the same reason — being waited on is its entire
 * function.
 */
export function advisoryNeverApplies(t) {
  if (t?.spawnedBy && FIX_KINDS.has(t.spawnedBy.kind)) return true;
  return isHuman(t?.assignee);
}

/**
 * Is this ticket ADVISORY — filed as backlog that the run does not wait on? The
 * marker is the literal label `advisory` (case- and whitespace-insensitive, but
 * an EXACT word: "advisory-ish" is not advisory), written by the requirements
 * analyst / release manager through create_ticket's `labels` param. Anything
 * that is not an array of labels is simply not advisory.
 *
 * A fix ticket or a human gate is never advisory no matter what it is labelled
 * (advisoryNeverApplies, TEAM-4131 F2).
 */
export function isAdvisoryTicket(t) {
  if (!Array.isArray(t?.labels)) return false;
  if (!t.labels.some((l) => String(l).trim().toLowerCase() === "advisory")) return false;
  return !advisoryNeverApplies(t);
}

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

/**
 * TEAM-3747 D2 — ship/CD merge-verdict for ONE harvested agentTasks entry.
 *
 * For a ship-phase ticket, "done + non-empty output" is NOT proof the work
 * shipped — only a merge commit / deploy verdict is. This is the crucial
 * difference from a mere output/artifact evidence check.
 * Classifies the entry into one of:
 *   "shipped"          → carries a positive merge/deploy signal: a non-empty
 *                        `mergeCommit`, or an EXPLICIT outcome==="shipped".
 *
 *                        TEAM-3755 F1 (P0): `commitSha` is deliberately NOT a
 *                        merge signal. harvestCompletionEvidence stores every
 *                        agent's record.commit_sha — that is the HEAD of the
 *                        (still unmerged) feature branch, present on literally
 *                        every dev/ship completion record. Accepting it made
 *                        shipVerdictOf return "shipped" for unmerged work, so
 *                        the D2 gate passed and the run closed "complete" over
 *                        an unshipped branch — the exact 29g73c failure this
 *                        gate exists to stop (FR-D2.2 / AC-D2.4). Only a merge
 *                        commit (or the release manager's explicit verdict)
 *                        proves the work landed.
 *   <a SHIP_BLOCKED_OUTCOMES value> → the agent recorded an EXPLICIT terminal
 *                        block ("deploy-blocked" / "static-ci-only").
 *   null               → neither: a phantom green close (CI may be green, but
 *                        nothing merged/deployed and no block was declared).
 *
 * Reads only harvested fields (see harvestCompletionEvidence in index.mjs), so it
 * is pure + testable with plain data. Legacy entries (no outcome/mergeCommit)
 * classify as null — the caller decides how to treat a missing verdict.
 */
export function shipVerdictOf(entry) {
  if (!entry || typeof entry !== "object") return null;
  const outcome = typeof entry.outcome === "string" ? entry.outcome.trim().toLowerCase() : "";
  if (SHIP_BLOCKED_OUTCOMES.includes(outcome)) return outcome;
  // A merge commit is the ONLY harvested field that proves the work landed.
  // commitSha is NOT consulted (see the F1 note above) — it is the unmerged
  // branch HEAD and is present on every completion record.
  const merged = typeof entry.mergeCommit === "string" && entry.mergeCommit.trim().length > 0;
  if (merged || outcome === "shipped") return "shipped";
  return null;
}

/**
 * TEAM-3747 D2 — decide the ship/CD verdict for a whole run. Given the epic's
 * children, the harvested agentTasks, and the def's ship phases, returns:
 *   {
 *     required:    boolean — the run actually has a ship phase to verify.
 *     shipped:     boolean — every done ship AGENT ticket carries a positive
 *                            merge/deploy verdict (true also when required=false).
 *     outcome:     when NOT shipped, the HONEST terminal phase to close on —
 *                  "deploy-blocked" if any ship ticket recorded an explicit
 *                  block, else "static-ci-only" (green but nothing merged).
 *     blockReason: first recorded block reason (null if none).
 *     offenders:   [{ ticketId, phase, verdict }] — ship tickets missing a verdict.
 *   }
 *
 * Only tightens when it can prove a phantom: with no done ship agent ticket to
 * inspect it returns
 * shipped=true (it cannot prove a phantom). Human review-gate tickets in a ship
 * phase owe no merge verdict — only agent tickets are inspected. A ticket's phase
 * is its explicit `phase` stamp when present, else the assignee's roster phase.
 */
export function evaluateShipVerdict(children, agentTasks, shipPhases, opts = {}) {
  const phases = shipPhases instanceof Set ? shipPhases : new Set(shipPhases || []);
  const inert = { required: false, shipped: true, outcome: null, blockReason: null, offenders: [] };
  if (!Array.isArray(children) || phases.size === 0) return inert;

  const getAgentPhase = opts.getAgentPhase || (() => undefined);
  const phaseOf = (t) =>
    typeof t.phase === "string" && t.phase ? t.phase : getAgentPhase(t.assignee);
  const tasks = agentTasks && typeof agentTasks === "object" ? agentTasks : {};
  const byTicketId = new Map();
  for (const entry of Object.values(tasks)) {
    if (entry && typeof entry.ticketId === "string") byTicketId.set(entry.ticketId, entry);
  }

  const shipTickets = children.filter(
    (t) =>
      t.type !== "epic" &&
      String(t.status || "").toLowerCase() === "done" &&
      !isHuman(t.assignee) &&
      phases.has(phaseOf(t))
  );
  // Cannot prove a phantom with nothing to inspect — stay green (isWorkflowComplete
  // already requires a done agent ticket per required phase, so this is defensive).
  if (shipTickets.length === 0) return { ...inert, required: true };

  let blocked = null;
  let blockReason = null;
  const offenders = [];
  for (const t of shipTickets) {
    const ticketId = String(t.ticketId || "");
    const entry = tasks[ticketId] || byTicketId.get(ticketId);
    const verdict = shipVerdictOf(entry);
    if (verdict === "shipped") continue;
    offenders.push({ ticketId, phase: phaseOf(t), verdict: verdict || "none" });
    // deploy-blocked outranks static-ci-only (an attempted+blocked deploy is the
    // more specific, more urgent verdict).
    if (verdict === "deploy-blocked") {
      blocked = "deploy-blocked";
      if (!blockReason && entry && typeof entry.blockReason === "string") {
        blockReason = entry.blockReason;
      }
    } else if (!blocked) {
      blocked = "static-ci-only";
    }
  }

  if (offenders.length === 0) {
    return { required: true, shipped: true, outcome: null, blockReason: null, offenders: [] };
  }
  return { required: true, shipped: false, outcome: blocked || "static-ci-only", blockReason, offenders };
}
