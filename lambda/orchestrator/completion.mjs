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
 * TEAM-4247 D2 — terminal outcomes for a run that had NOTHING TO DO. PARITY
 * MIRROR of src/lib/workflow/types.ts NO_OP_OUTCOMES (and of RUN_OUTCOMES in
 * save_analysis.py); run-outcome-parity.test.ts fails if they drift.
 *   - "nothing-to-remove" : a dead-code sweep verified its candidates and found
 *     none actually removable, so there is no branch, no PR, and nothing for a
 *     reviewer / QA verifier / CI agent / human merge gate to act on.
 *
 * Kept SEPARATE from SHIP_BLOCKED_OUTCOMES on purpose: nothing was blocked here,
 * and a no-op sweep must not trip the ship-verdict gates or the blocked-run
 * alerting. The only thing the two lists share is terminality, which is why the
 * merge happens in TERMINAL_WORKFLOW_PHASES below and nowhere else.
 *
 * NOTE for the D2 gates: neither isWorkflowComplete nor evaluateShipVerdict needs
 * a change for this outcome. A no-op sweep closes through
 * store.claimTerminalOutcome (like closeWorkflowBlocked) and therefore never
 * enters completeWorkflow, so those two functions are not on its path; and
 * evaluateShipVerdict only ever inspects done SHIP-phase children, which a sweep
 * that never reached a ship phase does not have.
 */
export const NO_OP_OUTCOMES = ["nothing-to-remove"];

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
 * Derived from SHIP_BLOCKED_OUTCOMES (and, since TEAM-4247 D2, NO_OP_OUTCOMES) so
 * a further outcome cannot be added to one write and forgotten in the other.
 * PARITY MIRROR of the TERMINAL_PHASES in src/lib/workflow/types.ts (same six
 * values, same purpose).
 */
export const TERMINAL_WORKFLOW_PHASES = Object.freeze([
  "complete",
  "cancelled",
  "error",
  ...SHIP_BLOCKED_OUTCOMES,
  ...NO_OP_OUTCOMES,
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

// ─── TEAM-3976: completions-record fallback for the evidence gate ────────────
// PARITY with src/lib/workflow/completion-evidence.ts (hand-ported TS twin used
// by the HTTP complete route). Keep the three functions below in agreement —
// src/lib/workflow/completion-evidence-parity.test.ts pins them.
//
// The gap these close: a ticket transitioned to done OUT-OF-BAND (Workflow
// Manager mark_done) before the agent's report_completion fired. The done
// cascade's one-shot harvest found no completions/{tid}.json and left the
// agentTasks entry evidence-less; the later report_completion wrote the record
// but its transition_ticket(done) was a no-op (done→done), so no second harvest
// ever ran. Both gates then refused forever on a ticket whose authoritative
// record proves the deliverable. These helpers let the gates consult that
// record for the would-be offenders ONLY (zero S3 reads on the happy path).

const nonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

/**
 * Does a completions/{ticketId}.json record (written by lambda/workflow-output
 * reportCompletion) prove the ticket produced a deliverable? A blank/empty
 * record is NOT evidence (TEAM-3690 / AC-D4.1).
 */
export function completionRecordHasEvidence(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (nonEmptyString(record.summary)) return true;
  if (nonEmptyString(record.pr_url)) return true;
  if (nonEmptyString(record.commit_sha)) return true;
  const artifacts = record.artifacts;
  if (nonEmptyString(artifacts)) return true;
  if (Array.isArray(artifacts) && artifacts.some((a) => nonEmptyString(a))) return true;
  return false;
}

/**
 * Fields to backfill onto an evidence-less agentTasks entry from a completions
 * record. FILL-ONLY-IF-MISSING: never emits a key the entry already has a
 * non-empty value for. Supplies output/branch/commitSha/prUrl ONLY — never
 * mergeCommit/outcome/blockReason (ship-verdict signals, TEAM-3747 D2 /
 * TEAM-3755 F1). commitSha is NOT a merge signal.
 */
export function evidenceBackfillFields(record, entry) {
  const fields = {};
  if (!record || typeof record !== "object") return fields;
  const e = entry && typeof entry === "object" ? entry : {};
  if (!nonEmptyString(e.output) && nonEmptyString(record.summary)) {
    fields.output = record.summary.trim().slice(0, 10000); // same cap as harvestCompletionEvidence
  }
  if (!nonEmptyString(e.branch) && nonEmptyString(record.branch)) fields.branch = record.branch;
  if (!nonEmptyString(e.commitSha) && nonEmptyString(record.commit_sha)) fields.commitSha = record.commit_sha;
  if (!nonEmptyString(e.prUrl) && nonEmptyString(record.pr_url)) fields.prUrl = record.pr_url;
  return fields;
}

/**
 * Second pass over missingEvidenceTickets() offenders: consult the authoritative
 * completions record for each would-be offender ONLY (zero S3 reads on the happy
 * path). Drops offenders whose record proves evidence and backfills their entry
 * so the run self-heals. Any read/backfill failure leaves the offender IN the
 * list (only tightens when it can prove — never a 500).
 *
 * @param missing     [{ ticketId, phase }] from missingEvidenceTickets
 * @param agentTasks  the same agentTasks map the gate evaluated
 * @param deps        { readCompletionRecord(ticketId) → Promise<object|null>,
 *                      backfill(ticketId, fields) → Promise<void>,
 *                      log?: (msg) => void }
 * @returns the remaining offenders (same shape)
 */
export async function resolveMissingEvidenceFromRecords(missing, agentTasks, deps = {}) {
  if (!Array.isArray(missing) || missing.length === 0) return missing;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const tasks = agentTasks && typeof agentTasks === "object" ? agentTasks : {};
  const byTicketId = new Map();
  for (const entry of Object.values(tasks)) {
    if (entry && typeof entry.ticketId === "string") byTicketId.set(entry.ticketId, entry);
  }
  const remaining = [];
  for (const offender of missing) {
    const ticketId = offender?.ticketId;
    let record = null;
    try {
      record = await deps.readCompletionRecord(ticketId);
    } catch (err) {
      log(`[completion] completions record read failed for ${ticketId}: ${err?.message || err}`);
      remaining.push(offender);
      continue;
    }
    if (!completionRecordHasEvidence(record)) {
      log(`[completion] completions record for ${ticketId} ${record ? "carries no evidence" : "not found"}`);
      remaining.push(offender);
      continue;
    }
    const entry = tasks[ticketId] || byTicketId.get(ticketId);
    const fields = evidenceBackfillFields(record, entry);
    if (Object.keys(fields).length > 0) {
      try {
        await deps.backfill(ticketId, fields);
      } catch (err) {
        // Evidence is proven by the record itself; a failed backfill only means
        // the next gate pass re-reads the record. Never re-block on it.
        log(`[completion] evidence backfill failed for ${ticketId}: ${err?.message || err}`);
      }
    }
  }
  return remaining;
}

// ─── TEAM-4122 FR-7: advisory tickets ────────────────────────────────────────

/**
 * ADVISORY_ROUTING mode — two values, no shadow:
 *   "off"     — an "advisory" label means nothing to the orchestrator (today).
 *   "enforce" — an advisory-labelled ticket is BACKLOG: invisible to every
 *               completion gate here, and (index.mjs) branched from / PR'd
 *               against the repo default branch instead of the run's shared
 *               integration branch.
 *
 * Garbage coalesces to "off", matching the discipline of every other flag that
 * changes what the run waits on (CI_CHECK_MODE, SYNC_MAIN_BEFORE_CI,
 * LIVE_REVERIFY): a typo must never silently start dropping tickets out of the
 * completion guard.
 */
export function normalizeAdvisoryRoutingMode(v) {
  return String(v || "").trim().toLowerCase() === "enforce" ? "enforce" : "off";
}

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

/** The children a completion gate may consider: everything that is not advisory. */
export function nonAdvisory(children) {
  return Array.isArray(children) ? children.filter((t) => !isAdvisoryTicket(t)) : children;
}

/**
 * @param children  the epic's child tickets
 * @param wfDef     resolved workflow def ({ completionRequiresAgentPhases, reviewGates })
 * @param opts
 *   getAgentPhase(assignee) → agent phase for a ticket's assignee (undefined for humans/unknowns)
 *   gatePhaseOf(ticket)     → the phase a human-assignee gate ticket guards (undefined if unknown)
 *   requestedGates          → workflow.input.reviewGates (activates "flagged" gates)
 *   advisoryRouting         → ADVISORY_ROUTING ("enforce" drops advisory-labelled
 *                             tickets out of every gate below; anything else, incl.
 *                             absent, leaves the decision byte-identical to pre-FR-7)
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

  // TEAM-4122 FR-7 — under enforce, advisory tickets are backlog and simply do
  // not exist for completion purposes. Filtering ONCE here covers every gate in
  // both branches below in one place: the legacy every-child-done heuristic, the
  // has-done-agent check, the open-agent integrity check, the open-fix (FIX_KINDS)
  // gate and gate-ticket matching. With the flag off (or absent) `children` is
  // untouched, so this function is byte-identical to its pre-FR-7 self.
  if (normalizeAdvisoryRoutingMode(opts.advisoryRouting) === "enforce") {
    children = nonAdvisory(children);
  }

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
 * difference from missingEvidenceTickets (which accepts any output/artifact).
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
 * Mirrors the "only tightens when it can prove" discipline of
 * missingEvidenceTickets: with no done ship agent ticket to inspect it returns
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

// ─── TEAM-4246 D1 — the verified-head completion gate ────────────────────────
//
// Run wf_1788731227559_dowtdh closed green over three different heads: QA
// verified 933ea6f, CI certified 12e9ac6 (QA's own evidence commit, not the code
// head), and the fix that finally landed did so at 001259d — five seconds before
// workflow.complete. Every gate above passed, because none of them compares one
// ticket's head against another's: the evidence gate wants any output, the ship
// verdict gate wants a merge commit, and neither asks "did anybody actually
// verify the code that is about to ship?".
//
// So this is the third gate, and it is the only one that reads across tickets.

/**
 * PARITY MIRROR of normalizeSha in lambda/orchestrator/verdict-contract.mjs.
 *
 * A local copy rather than an import for the same reason FIX_KINDS above is one:
 * this module is loaded by callers that ship neither sibling (the HTTP route's
 * parity test, the toolkit's offline replays), and it has no local imports of its
 * own to build a cycle out of. verified-head-completion.test.mjs asserts the two
 * agree over a table of inputs, so the copy cannot drift.
 *
 * 7-40 lowercase hex and nothing else — the whole point of D1's rule 2 is that a
 * head SHA is never inferred from prose, so anything that is not a git object
 * name is not a head.
 */
const HEAD_SHA_RE = /^[0-9a-f]{7,40}$/;
export function normalizeHeadSha(raw) {
  if (typeof raw !== "string") return null;
  const norm = raw.trim().toLowerCase();
  return HEAD_SHA_RE.test(norm) ? norm : null;
}

export const QA_VERIFIER_ID = "agentcore_hub_qa_verifier";
export const CI_AGENT_ID = "agentcore_hub_ci_agent";

/**
 * PARITY MIRROR of GATE_PERSONAS in verdict-contract.mjs (same zero-import
 * reason as normalizeHeadSha; the test pins set equality).
 *
 * It used to exclude a gate persona's ticket from the PR-head derivation (a gate
 * persona's `commitSha` is the head it INSPECTED, so counting it made the
 * comparison self-fulfilling). TEAM-4264 F3 deleted that derivation outright —
 * heads.pr is the caller's fact or nothing — so this set now has no reader in
 * this module and stays exported for the parity guard that pins it against
 * verdict-contract's GATE_PERSONAS. Keeping it is cheaper than re-deriving the
 * four ids the next time something here needs them.
 */
export const GATE_PERSONA_IDS = new Set([
  "agentcore_hub_code_reviewer",
  QA_VERIFIER_ID,
  CI_AGENT_ID,
  "agentcore_hub_release_manager",
]);

/** First readable head among `fields`, in order. Structured fields ONLY. */
function headFrom(entry, fields) {
  for (const field of fields) {
    const sha = normalizeHeadSha(entry?.[field]);
    if (sha) return sha;
  }
  return null;
}

/**
 * Two heads name the same commit. Prefix equality COUNTS: the same head reaches
 * this function as a 7-char short sha from one agent's prose-free field and as a
 * 40-char full sha from another's (dowtdh's CI wrote `12e9ac6ef50…` in full while
 * the reviewer's record carried `933ea6f`), and treating those as different heads
 * would report divergence on every run that mixes the two conventions.
 */
const sameHead = (a, b) => a === b || a.startsWith(b) || b.startsWith(a);

/**
 * TEAM-4246 D1 (FR-D1.9) — may this run close at the head it is about to ship?
 *
 * Two refusals, in this order, both returned as a `reason` the caller publishes
 * verbatim on `orchestrator.completion_blocked`:
 *
 *   "open-fix"        a fix ticket under the epic is still open. EPIC-WIDE on
 *                     purpose: isWorkflowComplete only waits on fixes routed
 *                     under a REQUIRED phase, so a fix stamped with a phase the
 *                     def does not require (or with none at all) is invisible to
 *                     it — and dowtdh's TEAM-4183 was exactly a fix nobody was
 *                     waiting on. The `!isAdvisoryTicket` clause is there for
 *                     shape-parity with every other gate in this module, but note
 *                     it can never fire on a fix ticket: advisoryNeverApplies
 *                     (TEAM-4131 F2) already refuses the `advisory` label on
 *                     FIX_KINDS precisely so a label cannot bypass the gate the
 *                     fix exists to hold.
 *   "head-divergence" the heads the gate personas certified and the head the run
 *                     is shipping are not the same commit.
 *
 * The three heads, from STRUCTURED FIELDS ONLY:
 *   heads.qa   the newest head the QA verifier declared (testedHead)
 *   heads.ci   the newest head the CI agent declared (testedHead, else the
 *              proven-build ci_head_sha it has recorded since TEAM-4122 FR-4)
 *   heads.pr   `opts.prHeadSha` — the real head of the branch the run is
 *              shipping, and NOTHING ELSE. Null when the caller could not
 *              resolve it, and null is UNKNOWN, never divergence.
 *
 * heads.pr used to fall back to the newest `commitSha` recorded by a done
 * NON-GATE ticket when the caller supplied nothing, and every caller supplied
 * nothing (TEAM-4264 F3). That proxy is a DEV COMMIT, which is the run's head
 * only until the branch moves: after any merge it is a PARENT of the real head,
 * so QA and CI heads that match the merge commit exactly read as divergent and
 * `enforce` files stale-head re-verifies in a loop. This branch's own history is
 * the proof — 5fa3728 has parents fcb47de + 6c63c70 and the dev persona reported
 * 6c63c70. Design §3.3 specified `pr: normalizeSha(opts.prHeadSha)`; a derived
 * head was never in the contract, and a fabricated head is worse than no head
 * for the same reason a fabricated verdict is (verdict-contract.mjs).
 *
 * What this does NOT weaken: two KNOWN heads that disagree are still divergence.
 * QA at one sha and CI at another is a real disagreement with or without a PR
 * head, and with no PR head to appeal to, BOTH are reported stale (neither has a
 * majority). Only the pr↔verifier comparison goes quiet when pr is unknown.
 *
 * "Newest" is by `completedAt`, and a done ticket that declared NO head is
 * skipped rather than treated as erasing the head an earlier round proved: the
 * question is "what is the newest head this persona certified", and a head-less
 * completion certifies nothing.
 *
 * FEWER THAN TWO KNOWN HEADS IS NOT DIVERGENCE. A run whose personas recorded no
 * head predates the field, or ran a def with no QA/CI phase at all, and refusing
 * to close it would wedge every such run for a fact nobody stated. Unknown is
 * unknown — the same discipline as missingEvidenceTickets' "only tightens when it
 * can prove".
 *
 * Never reads `delivery.mode`: the heads must agree whether the run merges itself
 * or hands the PR off, because the handoff PR is what the owning team reviews.
 *
 * @param children    the epic's child tickets (advisory ones included; filtered here)
 * @param agentTasks  the workflow's harvested agentTasks map
 * @param opts        { prHeadSha } — the real head of the shipping branch, or
 *                    nothing at all, in which case heads.pr stays unknown
 * @returns {{ ok: boolean, reason: null|"open-fix"|"head-divergence",
 *             heads: { qa: string|null, ci: string|null, pr: string|null },
 *             offenders: string[], stalePersonas: string[] }}
 *          `offenders` is the open-fix ticket list; divergence reports the
 *          personas whose head is stale in `stalePersonas` instead (the caller
 *          turns those into the re-verify tickets that remediate it).
 */
export function evaluateVerifiedHeads(children, agentTasks, opts = {}) {
  const heads = { qa: null, ci: null, pr: normalizeHeadSha(opts.prHeadSha) };
  // `inert` aliases `heads` on purpose: every pass/skip return still reports the
  // heads the scan below discovered, so the caller's event and log line say what
  // was compared even when nothing was wrong.
  const inert = { ok: true, reason: null, heads, offenders: [], stalePersonas: [] };
  if (!Array.isArray(children) || children.length === 0) return inert;

  const tasks = agentTasks && typeof agentTasks === "object" ? agentTasks : {};
  // agentTasks may be keyed by ticketId (orchestrator) or by task id with a
  // ticketId field — the same secondary index missingEvidenceTickets builds.
  const byTicketId = new Map();
  for (const entry of Object.values(tasks)) {
    if (entry && typeof entry.ticketId === "string") byTicketId.set(entry.ticketId, entry);
  }

  // Newest-wins by completedAt (ISO strings compare lexicographically); a tie or
  // a missing timestamp falls back to board order, so the scan is deterministic.
  // `pr` is not in here: it is the caller's fact, never scanned for.
  const at = { qa: "", ci: "" };
  const take = (slot, sha, when) => {
    if (!sha || when < at[slot]) return;
    heads[slot] = sha;
    at[slot] = when;
  };

  const openFixes = [];
  for (const t of children) {
    if (!t || t.type === "epic") continue;
    if (t.spawnedBy && FIX_KINDS.has(t.spawnedBy.kind) && isOpen(t) && !isAdvisoryTicket(t)) {
      const id = String(t.ticketId || "");
      if (id && !openFixes.includes(id)) openFixes.push(id);
    }
    if (String(t.status || "").toLowerCase() !== "done") continue;
    const ticketId = String(t.ticketId || "");
    const entry = tasks[ticketId] || byTicketId.get(ticketId);
    if (!entry) continue;
    const assignee = t.assignee || entry.agentId || "";
    const when = String(entry.completedAt || t.completedAt || "");
    if (assignee === QA_VERIFIER_ID) {
      take("qa", headFrom(entry, ["testedHead", "tested_head"]), when);
    } else if (assignee === CI_AGENT_ID) {
      take("ci", headFrom(entry, ["testedHead", "tested_head", "ci_head_sha", "ciHeadSha"]), when);
    }
    // NOTHING derives heads.pr (TEAM-4264 F3). A dev ticket's commitSha is the
    // head that ticket produced, not the head the run is shipping.
  }

  if (openFixes.length > 0) {
    return { ok: false, reason: "open-fix", heads, offenders: openFixes, stalePersonas: [] };
  }

  const known = Object.entries(heads).filter(([, sha]) => sha);
  if (known.length < 2) return inert;
  if (known.every(([, a]) => known.every(([, b]) => sameHead(a, b)))) return inert;

  const personaOf = { qa: QA_VERIFIER_ID, ci: CI_AGENT_ID };
  // Whose head is stale? Against the PR head when it is known — that is the head
  // the run is shipping, so anything that disagrees with it is what went
  // unverified. With no PR head, two disagreeing verifiers have no majority to
  // appeal to, so NEITHER can be called current and both are reported.
  const stalePersonas = ["qa", "ci"]
    .filter((slot) => heads[slot] && (!heads.pr || !sameHead(heads[slot], heads.pr)))
    .map((slot) => personaOf[slot]);
  return { ok: false, reason: "head-divergence", heads, offenders: [], stalePersonas };
}
