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
import { parseGitHubUrl } from "./repo-check.mjs";

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

// ─── TEAM-3985 / TEAM-5184: the ONE manager_escalation a stranded run gets ─────
// Why a run whose tickets all look Done still is not complete, in the words the
// human reads. Keyed by the `workflow.completion_blocked` reason; `slug` keeps the
// TEAM-3985 notification id stable (`notif_completion_evidence_<wf>`) and gives
// every reason its own id, so one open escalation never masks another reason.
export function completionBlockedNotice(reason, detail, { featureBranch } = {}) {
  if (reason === "incomplete_roster") {
    return {
      slug: "roster",
      title: "Run cannot complete: child ticket roster could not be read in full",
      details: `Every ticket looks Done but the completion gate could not read the epic's full child list (${detail}), so it deferred instead of completing on a partial roster. Jira paging usually recovers on its own: re-Done any ticket to re-check. If it keeps failing, the epic has more children than the pager can list or Jira is degraded.`,
    };
  }
  if (reason === "unmerged_branch") {
    return {
      slug: "unmerged",
      title: "Run cannot complete: feature branch has work not on the default branch",
      details: `Every ticket is Done but the ship merge-verify gate refused to close the run: ${detail}. Land it: open a PR from ${featureBranch ? `feature branch ${featureBranch}` : "the feature branch"} to the default branch (or have the release manager open a fresh unified PR through Merge Approval), then re-Done any ticket to re-check.`,
    };
  }
  if (reason === "open_follow_up_pr") {
    // TEAM-6062: one notice per distinct open-PR set — a later, different set must surface.
    return {
      slug: `followup_pr_${shortHash(String(detail).split(", ").sort().join(","))}`,
      title: "Run cannot complete: a follow-up PR to the default branch or a stated base is still open",
      details: `Every ticket is Done but this run's unified PR already merged and follow-up PR(s) to the default branch or a stated base are still open: ${detail}. Nothing merges them on its own: file its CI → Ship → Merge Approval → CD chain (release-manager blueprint, "Post-merge follow-up PR"), or close the PR as superseded, then re-Done any ticket to re-check.`,
    };
  }
  return {
    slug: "evidence",
    title: "Run cannot complete: missing completion evidence",
    details: `Every ticket is Done but the completion evidence gate refused to close the run — no output/artifact recorded for ${detail}. The agent probably moved its ticket to Done before report_completion wrote completions/<ticket>.json. If the record exists now, re-Done any ticket to re-check; otherwise add the evidence (or set COMPLETION_EVIDENCE_REQUIRED=off) and re-check.`,
  };
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

// TEAM-5996: mirror of gate-contract.mjs isIntentOnlyReservation (zip-local; gate-contract-parity.test.ts pins it) - a twin's Done-intent reservation is no record.
export const isIntentOnlyReservation = (r) => !!r && typeof r === "object" && !Array.isArray(r) && r.reservation === "done-intent" && Object.keys(r).every((k) => ["reservation", "ticketId", "doneIntent"].includes(k));
/** Does a completions/{ticketId}.json record (lambda/workflow-output reportCompletion) prove a
 *  deliverable? A blank/empty record is NOT evidence (TEAM-3690 / AC-D4.1). */
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

// COPY of the ticket twins' export (lambda/agentcore-hub-{tickets,jira}) — three
// zips, no shared module; src/lib/workflow/follow-ups-parity.test.ts pins `.source`.
export const BASE_BRANCH_LINE_RE = /^base_branch:\s*(\S+)\s*$/m;

/**
 * TEAM-5828 / TEAM-5853 — the PR base a dev-phase ticket is told to target. Once
 * this run's unified PR has merged (a SHIP-phase task carries a mergeCommit, whatever
 * its outcome — a deploy block after the merge still merged) the integration branch
 * is dead and the base is the default branch, overriding even a ticket's stale
 * `base_branch:` naming that dead branch. Else the ticket's own line wins; else the
 * integration branch as before. A dev task's mergeCommit (its sub-PR into the
 * integration branch) is not the unified merge — hence the ship-phase scope.
 */
export function resolvePrBase({ workflow, ticketDescription, defaultBranch, getAgentPhase = () => undefined }) {
  const fb = workflow?.featureBranch || "";
  const merged = fb && Object.values(workflow?.agentTasks || {}).find(
    (e) => nonEmptyString(e?.mergeCommit) && SHIP_PHASES.has(getAgentPhase(e.agentId))
  );
  const stated = BASE_BRANCH_LINE_RE.exec(String(ticketDescription || ""))?.[1];
  if (stated && !(merged && stated === fb)) return { baseBranch: stated, isShared: Boolean(fb) && stated === fb, reason: "ticket" };
  if (merged) return { baseBranch: defaultBranch, isShared: false, reason: "unified_pr_merged", mergeCommit: merged.mergeCommit.trim() };
  return { baseBranch: fb || defaultBranch, isShared: Boolean(fb), reason: "default" };
}

/**
 * TEAM-5913 — every distinct branch head this run recorded (harvested `commitSha`,
 * TEAM-3755 F1). Deliberately unordered: completedAt is not ancestry (a replay or a
 * late first completion reorders it), so the 404 proof must account for ALL of them.
 */
export function recordedHeads(agentTasks) {
  return [...new Set(Object.values(agentTasks || {}).map((e) => e?.commitSha).filter(nonEmptyString).map((s) => s.trim()))];
}

/**
 * TEAM-3986 / TEAM-5828 / TEAM-5853 / TEAM-5868 — did the feature branch land on `base`?
 * `api` is the orchestrator's githubApi (path → json, throws with err.status; the caller
 * fails open). Only PRs INTO `base` count, read across pages (newest first, ≤10 pages;
 * a FULL tenth page means the history was truncated, and truncation turns every
 * "provably not merged" below into "unknown" — N4). `recordedHeads` is recordedHeads().
 *   { merged: true,  mergeCommit, prUrl } the latest merged PR's head IS the branch
 *                                         head (squash-safe); or the branch is gone
 *                                         (404) and EVERY recorded head is, or is an
 *                                         ancestor of, that PR's head (TEAM-5913); or
 *                                         compare says base
 *                                         contains the branch; or the branch's tree
 *                                         equals what merged (merged-head..head diff
 *                                         empty, P2); or it equals a base state that
 *                                         already contains the merge commit (P3).
 *                                         GitHub compare is THREE-dot (merge-base..head),
 *                                         so an empty base...head diff alone proves
 *                                         only tree(head) == tree(merge-base) — and the
 *                                         merge-base may predate the squash (N1). Or
 *                                         base's tip tree IS the head's tree (TEAM-5913).
 *                                         Or every file the branch changed AFTER its
 *                                         merged PR has the identical tree entry (mode +
 *                                         blob sha, TEAM-5943) on base's tip (per-file
 *                                         proof, TEAM-5935; list complete).
 *   { merged: false, reason }             provably not on base and nothing open to
 *                                         carry it — incl. commits pushed AFTER the
 *                                         unified PR merged (the TEAM-5828 strand):
 *                                         at least one such file whose tree entry on base's
 *                                         tip EQUALS its pre-merge entry and differs
 *                                         from the branch tip, i.e. base demonstrably
 *                                         never took the change. Trees that merely differ
 *                                         prove nothing — an unrelated commit on base
 *                                         differs them (TEAM-5935) — so that is null.
 *   { merged: null,  reason? }            unknown, or an open PR still carries it.
 * Only `merged === false` refuses completion (TEAM-3721 fail-open).
 */
// TEAM-5935 — per-file landing proof. GitHub compare lists at most 300 files.
const COMPARE_FILES_MAX = 300, FILE_PROBE_CAP = 50;
const ABSENT = Symbol("absent"), UNKNOWN = Symbol("unknown");

// Tree-entry identity "<mode> <sha>" per path from ONE recursive tree read (the only API
// that exposes mode — Contents never does, so blob sha alone can call a 100644→100755 or
// file→symlink change "landed", TEAM-5943). Non-blob entries (tree/commit) are UNKNOWN;
// a path missing from a complete index is ABSENT, from a truncated one UNKNOWN; a failed
// or malformed read makes the whole ref UNKNOWN. UNKNOWN can never become a `false`.
async function treeIndex({ owner, repo, api }, treeSha) {
  try {
    const t = await api(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`);
    if (!Array.isArray(t?.tree)) return null;
    const entries = new Map();
    for (const e of t.tree) if (nonEmptyString(e?.path)) entries.set(e.path, e.type === "blob" && nonEmptyString(e.mode) && nonEmptyString(e.sha) ? `${e.mode} ${e.sha}` : UNKNOWN);
    return { entries, truncated: t.truncated === true };
  } catch { return null; }
}
const entryAt = (idx, path) => (!idx ? UNKNOWN : idx.entries.has(path) ? idx.entries.get(path) : idx.truncated ? UNKNOWN : ABSENT);

// Classify each post-merge feature change (`files` = mergedHead...tip compare files) by
// tree-entry identity in the three indexes (`base` = base tip, `before` = merged head, `tip`):
//   LANDED  base == tip (mode AND sha; both ABSENT counts)
//   ABSENT  base == before && before != tip  (base holds exactly the pre-change entry)
//   UNKNOWN anything else (base moved the file to a third state, or a lookup was unresolvable)
// Renamed: LANDED only if new path base == tip AND previous path ABSENT on base; else UNKNOWN.
// Beyond FILE_PROBE_CAP only an ABSENT found within the cap may be returned; `landed` also
// needs the list untruncated (< COMPARE_FILES_MAX).
function perFileLanding(files, { base, before, tip }) {
  const absent = [], unknown = [];
  for (const f of files.slice(0, FILE_PROBE_CAP)) {
    const path = f?.filename;
    if (!nonEmptyString(path)) { unknown.push("(unnamed)"); continue; }
    const [m, b, t] = [base, before, tip].map((i) => entryAt(i, path));
    if (f.status === "renamed") {
      const prev = nonEmptyString(f.previous_filename) ? entryAt(base, f.previous_filename) : UNKNOWN;
      if (m !== UNKNOWN && t !== UNKNOWN && m === t && prev === ABSENT) continue;
      unknown.push(path); continue;
    }
    if (m === UNKNOWN || t === UNKNOWN) { unknown.push(path); continue; }
    if (m === t) continue;
    if (b !== UNKNOWN && m === b && b !== t) { absent.push(path); continue; }
    unknown.push(path);
  }
  const truncated = files.length >= COMPARE_FILES_MAX, capped = files.length > FILE_PROBE_CAP;
  const landed = absent.length === 0 && unknown.length === 0 && !truncated && !capped;
  const why = truncated ? `post-merge diff lists ${files.length} files (truncated)`
    : capped ? `${files.length} post-merge files exceed the ${FILE_PROBE_CAP}-file probe cap`
    : `unresolvable on base: ${unknown.join(", ")}`;
  return { absent, landed, why };
}

export async function featureBranchLanding({ owner, repo, base, head, api, recordedHeads = [] }) {
  const enc = encodeURIComponent;
  const list = [];
  let lastBatch = 0;
  for (let page = 1; page <= 10; page++) {
    const prs = await api(`/repos/${owner}/${repo}/pulls?head=${owner}:${enc(head)}&base=${enc(base)}&state=all&sort=updated&direction=desc&per_page=100&page=${page}`);
    const batch = Array.isArray(prs) ? prs : [];
    list.push(...batch.filter((p) => p?.base?.ref === base));
    lastBatch = batch.length;
    if (batch.length < 100) break;
  }
  const truncated = lastBatch === 100;
  const unmerged = (reason) =>
    truncated ? { merged: null, reason: `PR history for ${head} into ${base} truncated at 10 pages; ${reason}` } : { merged: false, reason };
  const mergedPr = list.filter((p) => p.merged_at).sort((a, b) => String(b.merged_at).localeCompare(String(a.merged_at)))[0];
  const proof = () => ({ merged: true, mergeCommit: mergedPr.merge_commit_sha || "", prUrl: mergedPr.html_url || "" });
  const mergedHead = mergedPr?.head?.sha || "";
  let headSha = null;
  if (mergedPr) {
    try { headSha = (await api(`/repos/${owner}/${repo}/branches/${enc(head)}`))?.commit?.sha || null; }
    catch (err) {
      if (err?.status !== 404) throw err;
      // Auto-deleted after merge — proof ONLY if the PR's head contains EVERY head this
      // run recorded (TEAM-5913: order-free, so no replay or late completion can steer it).
      const heads = recordedHeads.filter(nonEmptyString).map((s) => s.trim());
      const why = (h) => ({ merged: null, reason: `branch ${head} is gone and recorded head ${h} is not contained in merged PR #${mergedPr.number} head ${mergedHead.slice(0, 12)}` });
      if (!mergedHead || heads.length === 0) return why("(none)");
      for (const h of heads) {
        if (h.length < 7) return why(h);
        if (mergedHead.startsWith(h)) continue;
        const c = await api(`/repos/${owner}/${repo}/compare/${enc(h)}...${enc(mergedHead)}`);
        if (!(c?.behind_by === 0 && (c.status === "identical" || c.status === "ahead"))) return why(h);
      }
      return proof();
    }
  }
  if (mergedPr && headSha && mergedHead === headSha) return proof();
  const cmp = await api(`/repos/${owner}/${repo}/compare/${enc(base)}...${enc(head)}`);
  if (cmp?.status === "identical" || cmp?.status === "behind") {
    return { merged: true, mergeCommit: cmp?.base_commit?.sha || "", prUrl: "" };
  }
  if (!mergedPr) {
    if (cmp?.status === "ahead" || cmp?.status === "diverged") {
      return unmerged(`branch ${cmp.ahead_by} commit(s) ahead of ${base} (status=${cmp.status})`);
    }
    return { merged: null };
  }
  // P2: head descends from the merged head (behind_by 0 ⇒ merge-base IS the merged
  // head, so this three-dot diff is a true two-dot one) and adds nothing to it.
  const after = mergedHead && headSha ? await api(`/repos/${owner}/${repo}/compare/${enc(mergedHead)}...${enc(headSha)}`) : null;
  if (after && after.behind_by === 0 && Array.isArray(after.files) && after.files.length === 0) return proof();
  // P3: tree(head) == tree(merge-base) AND that merge-base already contains the merge
  // commit — base's tip does by construction; an older merge-base must be shown to.
  if (Array.isArray(cmp?.files) && cmp.files.length === 0) {
    if (cmp.behind_by === 0) return proof();
    const mb = cmp.merge_base_commit?.sha, mc = mergedPr.merge_commit_sha;
    if (mb && mc && (await api(`/repos/${owner}/${repo}/compare/${enc(mc)}...${enc(mb)}`))?.behind_by === 0) return proof();
  }
  const open = list.find((p) => p.state === "open");
  if (open) return { merged: null, reason: `open PR #${open.number} to ${base}` };
  if (!after) return { merged: null };
  // TEAM-5913: P2/P3 are sufficient, not exhaustive — refuse only on positive evidence.
  const tipSha = cmp?.base_commit?.sha || null;
  const treeOf = async (sha) => (sha ? (await api(`/repos/${owner}/${repo}/git/commits/${enc(sha)}`).catch(() => null))?.tree?.sha || null : null);
  const tipTree = await treeOf(tipSha), headTree = await treeOf(headSha);
  if (tipTree && tipTree === headTree) return { merged: true, mergeCommit: tipSha, prUrl: "" };
  // TEAM-5935: trees that DIFFER prove nothing (an unrelated commit on base differs them).
  // Prove per file over the post-merge feature changes instead.
  const files = Array.isArray(after.files) ? after.files : [];
  const inconclusive = (why) => ({ merged: null, reason: `no landing proof for ${head} on ${base}, but no proof of unlanded content either (${why})` });
  if (files.length === 0 || !tipSha || !headSha) return inconclusive("post-merge file list or tip unavailable");
  // TEAM-5943: one recursive tree per ref, read sequentially (bounded peak memory); a null
  // index makes every path UNKNOWN at that ref — LANDED never needed `before`, ABSENT does.
  const idx = async (t) => (t ? treeIndex({ owner, repo, api }, t) : null);
  const v = perFileLanding(files, { base: await idx(tipTree), before: await idx(await treeOf(mergedHead)), tip: await idx(headTree) });
  if (v.absent.length > 0) {
    return unmerged(
      `feature branch ${head} has ${after.ahead_by ?? "?"} commit(s) after its merged PR #${mergedPr.number} not contained in ${base} and no open PR to ${base}` +
      `; ${base} still holds the pre-merge content of: ${v.absent.join(", ")}`
    );
  }
  if (v.landed) return { merged: true, mergeCommit: tipSha, prUrl: "" };
  return inconclusive(v.why);
}

/** TEAM-6062 — 8-hex FNV-1a; pure, no node:crypto (src/ imports this module). */
function shortHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** TEAM-6062 — every configured GitHub repo with its own default branch (TEAM-6075: one parser, shared with parseRepoUrl). */
export function repoTargets(repoConfig) {
  return (repoConfig?.repos || []).flatMap((r) => {
    const m = parseGitHubUrl(r?.url);
    return m ? [{ ...m, defaultBranch: r.defaultBranch || "main" }] : [];
  });
}

/**
 * TEAM-6133 — the ONE PR-url parser: the first http(s) URL token in `text` whose host is
 * exactly github.com (any case; `new URL` lowercases it) and whose path is /<owner>/<repo>/pull/<n>, <n> a WHOLE
 * positive integer (TEAM-6148: `1not-a-pr`, `1%2Fx`, `0` are null; prose punctuation is stripped off the token first). A look-alike host (notgithub.com, example.org/github.com/…) is null.
 */
export function githubPrRef(text) {
  for (const tok of String(text ?? "").match(/https?:\/\/\S+/gi) || []) {
    let u; try { u = new URL(tok.replace(/[.,;:!?)\]}>'"]+$/, "")); } catch { continue; } // TEAM-6148: prose punctuation off the token
    const p = u.pathname.split("/"), n = /^[1-9]\d*$/.exec(p[4] || "");
    if (u.hostname === "github.com" && p[1] && p[2] && p[3] === "pull" && n) return { owner: p[1], repo: p[2], number: Number(n[0]) };
  }
  return null;
}

/**
 * TEAM-6032 (DL-038) — the run's PRs in its configured repos, one per repo+number.
 * TEAM-6062: `prUrl` is fill-once, so a re-dispatched ticket's completion record
 * (`records[ticketId].pr_url`) is read too. Pure; foreign repos and non-PR urls are dropped.
 */
export function followUpPrRefs(agentTasks, repos, records = {}) {
  const refs = new Map();
  for (const [tid, e] of Object.entries(agentTasks || {})) {
    for (const url of [records?.[tid]?.pr_url, e?.prUrl]) {
      if (typeof url !== "string") continue; // TEAM-6075: a non-string record pr_url must not disable the gate
      const m = githubPrRef(url);
      const r = m && [].concat(repos).find((x) => m.owner.toLowerCase() === String(x?.owner).toLowerCase() && m.repo.toLowerCase() === String(x?.repo).toLowerCase());
      const key = r && `${r.owner}/${r.repo}#${m.number}`.toLowerCase();
      if (r && !refs.has(key)) refs.set(key, { owner: r.owner, repo: r.repo, defaultBranch: r.defaultBranch, number: m.number, url: url.trim() });
    }
  }
  return [...refs.values()];
}

/**
 * TEAM-6032 — one PR after the unified merge: "skip" the unified PR itself and any PR
 * into neither the default branch nor a `statedBases` entry (TEAM-6108; a pre-merge fix
 * into the integration branch, or an arbitrary base); "open" is an orphan nothing will
 * merge; "closed" (merged, or closed as superseded) is fine.
 */
export function classifyFollowUpPr(pr, { featureBranch, defaultBranch, statedBases = [] }) {
  if (!pr || typeof pr.state !== "string" || !nonEmptyString(pr.base?.ref)) return "unknown";
  if (pr.head?.ref === featureBranch || (pr.base.ref !== defaultBranch && !statedBases.includes(pr.base.ref))) return "skip";
  return pr.state === "open" ? "open" : "closed";
}

/**
 * TEAM-6032 — which of `refs` are still OPEN into the default branch or a stated base. `api` as
 * in featureBranchLanding; a failed read is `unknown`, never `open` (fail-open, TEAM-3721).
 */
export async function openFollowUpPrs({ owner, repo, refs, featureBranch, defaultBranch, statedBases = [], api }) {
  const open = [], unknown = [];
  for (const ref of refs) {
    const pr = await api(`/repos/${ref.owner || owner}/${ref.repo || repo}/pulls/${ref.number}`).catch(() => null);
    const c = classifyFollowUpPr(pr, { featureBranch, defaultBranch: ref.defaultBranch || defaultBranch, statedBases });
    if (c === "open") open.push(ref.url);
    else if (c === "unknown") unknown.push(ref.url);
  }
  return { open, unknown };
}

/**
 * TEAM-6032 (DL-038) — the completion backstop: once the unified PR merged
 * (`mergeProof` from GitHub, or a ship-phase mergeCommit per resolvePrBase), the
 * open follow-up PRs into the default branch, or (TEAM-6108) into a `base_branch:` a
 * roster ticket's description states that is not the integration branch, whenever the
 * PR was opened. Fail-open: an unreadable PR or a thrown probe never refuses. `repoRef()` returns `[{ owner, repo, defaultBranch }]`
 * (may throw); `readCompletionRecord(ticketId)` is read only past the merge check
 * and a null/failed read falls back to the cached `prUrl` (TEAM-6062): one record
 * read per ticket per completion attempt, memoized per invocation by the caller.
 */
export async function followUpPrGate({ workflow, agentTasks, tickets = [], mergeProof, repoRef = () => repoTargets(workflow.repoConfig), readCompletionRecord = async () => null, getAgentPhase, api, warn = console.warn }) {
  try {
    const repos = [].concat(repoRef());
    const defaultBranch = workflow.repoConfig?.repos?.[0]?.defaultBranch || "main";
    if (!mergeProof && resolvePrBase({ workflow: { ...workflow, agentTasks }, defaultBranch, getAgentPhase }).reason !== "unified_pr_merged") return [];
    const ids = Object.keys(agentTasks || {});
    const recs = await Promise.all(ids.map((tid) => Promise.resolve().then(() => readCompletionRecord(tid)).catch(() => null)));
    const records = Object.fromEntries(ids.map((tid, i) => [tid, recs[i]]));
    const statedBases = [...new Set([].concat(tickets || []).map((t) => BASE_BRANCH_LINE_RE.exec(String(t?.description || ""))?.[1]).filter((b) => b && b !== workflow.featureBranch))];
    const r = await openFollowUpPrs({ refs: followUpPrRefs(agentTasks, repos, records), featureBranch: workflow.featureBranch, defaultBranch, statedBases, api });
    if (r.unknown.length > 0) warn(`[orchestrator] follow-up PR state unknown for ${workflow.id}: ${r.unknown.join(", ")}`);
    return [...r.open].sort();
  } catch (err) {
    warn(`[orchestrator] follow-up PR check skipped for ${workflow.id}: ${err.message}`);
    return [];
  }
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
