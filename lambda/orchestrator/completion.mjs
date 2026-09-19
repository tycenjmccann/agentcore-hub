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
 * TEAM-4763 P1-A — the ship outcomes the orchestrator's evidence harvest may
 * carry onto an agentTasks entry, decided HERE beside shipVerdictOf because
 * admitting a value and knowing what it means are one decision. They had drifted
 * apart: `handoff` was writable by report_completion (workflow-output
 * SHIP_OUTCOMES) and admitted by nothing, so the harvest dropped it, shipVerdictOf
 * saw no outcome at all, and a run that honestly handed its PR to another team
 * closed on the static-ci-only terminal phase.
 */
export const HARVESTED_SHIP_OUTCOMES = Object.freeze([
  ...SHIP_BLOCKED_OUTCOMES,
  "shipped",
  "empty_sweep",
  "handoff",
]);

/**
 * Normalize a completion record's raw `outcome` for the harvest: the trimmed,
 * lowercased value when this reader can classify it, else null. A garbage or
 * future-schema outcome is DROPPED rather than stored, so the ship gate can never
 * trust a verdict nobody defined — a closed set, on purpose.
 */
export function harvestableShipOutcome(value) {
  if (typeof value !== "string") return null;
  const outcome = value.trim().toLowerCase();
  return HARVESTED_SHIP_OUTCOMES.includes(outcome) ? outcome : null;
}

/**
 * TEAM-4763 P1-A — the verdicts that SATISFY the D2 ship gate. "shipped" proves
 * the work landed; "handoff" proves it was delivered to another team to land,
 * which DL-030 already makes the agent prove with a PR URL (report_completion
 * refuses outcome:"handoff" without one). Both are positive, agent-declared
 * evidence in the DL-028 sense — this gate exists to catch SILENCE, not an honest
 * handoff — so neither closes the run on a blocked terminal phase.
 */
export const SHIP_SATISFIED_VERDICTS = Object.freeze(["shipped", "handoff"]);

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
/**
 * Is this child a HUMAN review gate rather than agent work? Assignee `human:<who>`
 * (the Jira/DDB mappers derive it from the `reviewer:<who>` label) or the
 * `human-review` marker label. Exported for the HTTP route's TS twin parity test.
 */
export function isHumanGateTicket(t) {
  if (typeof t?.assignee === "string" && t.assignee.startsWith("human:")) return true;
  return Array.isArray(t?.labels) && t.labels.some((l) => String(l).trim().toLowerCase() === "human-review");
}

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
    // A human review gate owes no deliverable: approving it IS its work, and no
    // agent ever writes completions/<gate>.json for it. Hub-materialized gates
    // (intake-materialize.ts) carry `phase:<afterPhase>`, so without this skip a
    // done Merge Approval in a required phase strands every run as
    // CompletionRejectedMissingEvidence (wf cnyl86/TEAM-4538). Mirrors the
    // human exclusion isWorkflowComplete and the HTTP complete route already apply.
    if (isHumanGateTicket(t)) continue;
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
 *   "handoff"          → TEAM-4763 P1-A: the work was delivered to another team to
 *                        land, so the PR is OPEN, not merged. Satisfies the gate
 *                        (SHIP_SATISFIED_VERDICTS) without ever being a merge.
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
  // TEAM-4763 P1-A: a handoff is its OWN verdict, deliberately NOT an alias for
  // "shipped" — the work is delivered but nothing merged, and mapping it to
  // "shipped" would make deliveryRollUp derive prState "merged" for a PR that is
  // still open (workflow-output's derivePrState calls the same PR "open").
  if (outcome === "handoff") return "handoff";
  // A merge commit is the ONLY harvested field that proves the work landed.
  // commitSha is NOT consulted (see the F1 note above) — it is the unmerged
  // branch HEAD and is present on every completion record.
  const merged = typeof entry.mergeCommit === "string" && entry.mergeCommit.trim().length > 0;
  // TEAM-4739 / TEAM-4740 FR-10: `empty_sweep` is "there was nothing to merge",
  // and that is a SHIPPED run, not a blocked one. A sweep that found nothing to
  // remove has provably nothing to merge, so "shipped" is the HONEST verdict for
  // it, not a missing one. It is deliberately NOT in SHIP_BLOCKED_OUTCOMES: an
  // honest empty sweep has nothing left to do, so closing it "static-ci-only"
  // would file it under unfinished work forever and page a human about a run
  // that succeeded. The alternative the sweeper used before this existed was
  // worse - close dishonestly, or wedge.
  if (merged || outcome === "shipped" || outcome === "empty_sweep") return "shipped";
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
 *     handoff:     TEAM-4768 — the run is shipped PURELY by handoff: every inspected
 *                  ship ticket said "handoff" and none said "shipped", so nothing
 *                  here ever claimed a merge. The merge-verify probe reads this to
 *                  know it has no claim to cross-check (a handoff's PR is open by
 *                  definition, which the probe would otherwise call "provably
 *                  unmerged" and refuse the run over). `shipped` alone cannot answer
 *                  that question — it is true for a merge and a handoff alike.
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
  const inert = { required: false, shipped: true, handoff: false, outcome: null, blockReason: null, offenders: [] };
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
  let handoffs = 0;
  const offenders = [];
  for (const t of shipTickets) {
    const ticketId = String(t.ticketId || "");
    const entry = tasks[ticketId] || byTicketId.get(ticketId);
    const verdict = shipVerdictOf(entry);
    // TEAM-4763 P1-A: "handoff" satisfies the gate alongside "shipped" — see
    // SHIP_SATISFIED_VERDICTS. Anything else (including null) is an offender.
    if (SHIP_SATISFIED_VERDICTS.includes(verdict)) { if (verdict === "handoff") handoffs++; continue; }
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
    // TEAM-4768: PURE handoff only. A run with one handoff beside one "shipped" DID
    // claim a merge, so it is not exempt from the merge probe — every inspected
    // ticket has to have handed off for there to be no claim to cross-check.
    return { required: true, shipped: true, handoff: handoffs === shipTickets.length, outcome: null, blockReason: null, offenders: [] };
  }
  return { required: true, shipped: false, handoff: false, outcome: blocked || "static-ci-only", blockReason, offenders };
}

/**
 * TEAM-4740 FR-13 — the markers the follow-up materializer mints. The label
 * filters; the title suffix is the only one a re-entrant scan can read back
 * (list_tickets returns `summary`, not `labels`). Both exported so workflow-output
 * and the parity test share these source strings.
 */
export const FOLLOWUP_LABEL_RE = /^followup-[0-9a-f]{8}$/;
export const FOLLOWUP_TITLE_RE = /\[fu:([0-9a-f]{8})\]\s*$/;

/**
 * TEAM-4740 FR-13/FR-14 — pure roll-up for the orchestrator's ONE setDelivery
 * write. Returns `{}` (never undefined) so it is spread-safe, and adds no key it
 * cannot derive. `prState` is DERIVED, never polled: a merge commit or an explicit
 * "shipped" proves the work landed, a pr url alone proves only that a PR exists,
 * and a handoff is deliberately NOT a merge (its PR is open, by definition).
 *
 * TEAM-4763 P1-A — `outcome` is one of the two values types.ts allows for
 * `delivery.outcome`, and this is the reading of FR-14 that decides between them
 * (recorded here so the next reader does not re-derive it):
 *   - "complete:handoff:static-only" — a HANDOFF-MODE run (the repo is absent from
 *     the CD registry, so cd-registry.mjs stripped the ship phase) that nothing
 *     proves merged: the hub opened a PR and static CI is the only verification it
 *     ever had. The mode is the caller's to know, which is why it is passed in; it
 *     is the more specific statement about such a run, so it outranks the plain
 *     handoff label below (only one key is legal).
 *   - "complete-with-handoff" — otherwise handed off: a ship record that declared
 *     outcome:"handoff" (shipVerdictOf → "handoff"), or FR-13's rule that every
 *     STILL-OPEN follow-up is human-owned. An open AGENT follow-up is a fix ticket,
 *     so isWorkflowComplete rule (iii) is holding the run open and there is nothing
 *     to describe yet — hence "every".
 * A handed-off run therefore never records a bare `complete` with no qualifier.
 */
export function deliveryRollUp(tickets, agentTasks, opts = {}) {
  const isFollowUp = (t) =>
    (Array.isArray(t?.labels) && t.labels.some((l) => FOLLOWUP_LABEL_RE.test(String(l)))) ||
    FOLLOWUP_TITLE_RE.test(String(t?.title || ""));
  const open = (Array.isArray(tickets) ? tickets : []).filter((t) => isFollowUp(t) && isOpen(t));
  const tasks = Object.values(agentTasks && typeof agentTasks === "object" ? agentTasks : {});
  const verdicts = tasks.map((e) => shipVerdictOf(e));
  // Only "shipped" is a merge — "handoff" is excluded on purpose (see above).
  const merged = verdicts.includes("shipped");
  const prState = merged ? "merged"
    : tasks.some((e) => typeof e?.prUrl === "string" && e.prUrl.trim().length > 0) ? "open" : null;
  const handoff =
    verdicts.includes("handoff") || (open.length > 0 && open.every((t) => isHuman(t.assignee)));
  const mode = typeof opts?.mode === "string" ? opts.mode : "";
  const outcome = mode === "handoff" && !merged ? "complete:handoff:static-only"
    : handoff ? "complete-with-handoff" : null;
  return { ...(outcome ? { outcome } : {}), ...(prState ? { prState } : {}) };
}
