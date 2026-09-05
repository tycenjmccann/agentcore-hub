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
 * TEAM-3991 D1.4 — the outcomes that PROVE the work landed, and the only ones a
 * harvest may accept alongside SHIP_BLOCKED_OUTCOMES.
 *
 * `deployed` joins `shipped` because the CD agent's own evidence file says
 * "DEPLOY SUCCEEDED", not "shipped": wf sffzti merged 4 PRs and deployed, then
 * closed `static-ci-only` because no harvested field ever spelled the word
 * `shipped`. Both mean the same thing to the ship gate; they differ only in what
 * the terminal event REPORTS, so a deployed run is not filed as CI-only.
 *
 * PARITY MIRROR: src/lib/workflow/types.ts / the complete route's twin.
 */
export const SHIP_PROVEN_OUTCOMES = ["shipped", "deployed"];

/** Every outcome value a completion record may legitimately carry. */
export const ACCEPTED_SHIP_OUTCOMES = Object.freeze([
  ...SHIP_PROVEN_OUTCOMES,
  ...SHIP_BLOCKED_OUTCOMES,
]);

/** Human-gate statuses that mean "a person still owes this run a decision". */
const OPEN_GATE_STATUSES = new Set(["in_review", "todo", "blocked"]);
const ESCALATION_TITLE = /^Escalation #\d+/i;

/**
 * TEAM-3991 D1.4 — the human gate still standing between this run and a green
 * close, or null.
 *
 * wf 1pl3h1 is the failure: PR #274 was never merged, the preflight came back
 * BLOCKED, and TEAM-3757 ("Escalation #1 …") sat `in_review` waiting for a
 * person — yet the run closed `complete`. A run whose merge authority is still
 * unexercised has not finished, and saying so must NAME the gate, because
 * "blocked" without a ticket id is what sent humans hunting through the board.
 *
 * Human-assigned (`human:*`) children only: an agent ticket in `todo` is ordinary
 * unstarted work, not withheld authority. `blocked` counts — a rejected gate is
 * emphatically not an approval. Deterministic by ticketId so two callers looking
 * at the same board name the same gate.
 */
export function openGateOf(children) {
  if (!Array.isArray(children)) return null;
  const open = children
    .filter(
      (t) =>
        t &&
        t.type !== "epic" &&
        isHuman(t.assignee) &&
        OPEN_GATE_STATUSES.has(String(t.status || "").toLowerCase())
    )
    .sort((a, b) => String(a.ticketId || "").localeCompare(String(b.ticketId || "")));
  if (open.length === 0) return null;
  const gate = open[0];
  const title = String(gate.title || "");
  return {
    ticketId: String(gate.ticketId || ""),
    title,
    status: String(gate.status || "").toLowerCase(),
    kind: ESCALATION_TITLE.test(title) ? "escalation" : "merge_gate",
  };
}

/**
 * TEAM-3991 D1.4 — read the CD agent's deploy evidence file (S3
 * `workflows/<wf>/shared/cd-evidence/deploy-*.md`) for a ship verdict.
 *
 * The release manager writes this markdown whether or not it remembers to stamp
 * an `outcome` on its completion record — and in wf sffzti and wf 1pl3h1 it wrote
 * the file and stamped nothing, so the run's own account of itself was the only
 * honest evidence available and nobody read it. Only the FIRST matching line is
 * consulted: the heading is the verdict, and a later "blocked" mention inside the
 * body (a resolved preflight note, a quoted log) must not overturn it.
 *
 * Returns `{ outcome, blockReason? }` or null — never throws, never guesses.
 */
export function parseCdEvidence(markdown) {
  const text = typeof markdown === "string" ? markdown : "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/DEPLOY SUCCEEDED/i.test(line)) return { outcome: "deployed" };
    if (/(DEPLOY|PREFLIGHT) BLOCKED/i.test(line)) {
      return { outcome: "deploy-blocked", blockReason: line.replace(/^#+\s*/, "").trim() };
    }
  }
  return null;
}

/**
 * TEAM-3991 D1.4 — prefix a block reason with the gate that owes the decision.
 * `awaiting escalation TEAM-3757: <reason>` reads as an action for a human, where
 * a bare "preflight blocked" reads as a dead end.
 */
export function blockReasonWithGate(reason, openGate) {
  const base = typeof reason === "string" && reason.trim() ? reason.trim() : "";
  if (!openGate?.ticketId) return base || null;
  const head = `awaiting ${openGate.kind} ${openGate.ticketId}`;
  return base ? `${head}: ${base}` : head;
}

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
  // TEAM-3991 D1.4: "deployed" is proof of exactly the same strength as "shipped"
  // — it is the word the CD agent's own evidence uses. Both collapse to "shipped"
  // here so evaluateShipVerdict's ladder is unchanged; which of the two a run
  // actually achieved is reported by the terminal event, not by this classifier.
  if (merged || SHIP_PROVEN_OUTCOMES.includes(outcome)) return "shipped";
  return null;
}

/**
 * TEAM-3992 D3.2 — role name (as it appears in a def's ticketDag.fixRearm) → the
 * verification `kind` a verifier stamps on its report_completion record. review
 * and ci keep their names; the verification phase's re-verify is a `qa` record
 * (the QA verifier), so the role "verification" maps to kind "qa". PARITY MIRROR:
 * src/lib/workflow/completion-evidence.ts FIX_REARM_ROLE_TO_KIND.
 */
export const FIX_REARM_ROLE_TO_KIND = Object.freeze({
  review: "review",
  ci: "ci",
  verification: "qa",
});

/**
 * SHA-pinning tolerates abbreviation: a 7-char short sha matches its full 40-char
 * form (CI reports resolvedSourceVersion; a dev may report the short HEAD). Equal
 * after lower-casing, or — both ≥7 hex chars — one a prefix of the other. Empty
 * on either side never matches. PARITY MIRROR of the TS twin.
 */
function shaMatches(a, b) {
  const x = String(a || "").toLowerCase();
  const y = String(b || "").toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

/**
 * TEAM-3992 D3.2 — the SHA-pinned fix-verification gate. A fix ticket is only
 * honestly "done" once the roles its def re-arms (ticketDag.fixRearm[kind]) have
 * each re-verified the fix AT THE FIX'S FINAL SHA and passed. This is what stops
 * the TEAM-2811 / sffzti class of false-green: a reviewer approves fix commit Y,
 * the dev pushes Z to answer a later finding, and the run closes on the stale
 * approval — the review of record was never against the code that shipped.
 *
 * For every DONE fix ticket (`spawnedBy.kind ∈ FIX_KINDS`, and NOT itself a
 * re-arm ticket — a re-arm carries `spawnedBy.rearmOf` and is the verifier, not a
 * fix to be re-verified) whose kind re-arms at least one role:
 *   - no final SHA harvested onto its agentTasks entry (`commitSha`) → the fix
 *     never reported where it landed; reported as missingKinds ["commitSha"].
 *   - else, for each role in fixRearm[kind] (mapped to a verification kind), there
 *     must be SOME agentTasks entry carrying `verification` with
 *     targetTicketId === <fix>, headSha matching the fix's commitSha, and
 *     verdict "pass". A missing/failing/stale-SHA verification lists that kind.
 *
 * Returns [{ ticketId, commitSha, missingKinds[] }] — empty when every fix is
 * fully re-verified. A def with no `fixRearm` (non-code defs, or a def that opts
 * out) makes this inert: it returns []. Pure — plain data in, plain data out.
 *
 * @param children   epic child tickets (status + spawnedBy)
 * @param agentTasks harvested per-ticket metadata (commitSha + verification)
 * @param fixRearm   the def's ticketDag.fixRearm map (kind → role[])
 * @param opts       reserved (parity with the evidence/ship gates' signature)
 */
export function fixVerificationGaps(children, agentTasks, fixRearm, opts = {}) {
  void opts;
  if (!Array.isArray(children) || !fixRearm || typeof fixRearm !== "object") return [];
  const tasks = agentTasks && typeof agentTasks === "object" ? agentTasks : {};

  // Index every harvested verification record by the fix ticket it targets.
  const verifsByTarget = new Map();
  const byTicketId = new Map();
  for (const entry of Object.values(tasks)) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.ticketId === "string") byTicketId.set(entry.ticketId, entry);
    const v = entry.verification;
    if (!v || typeof v !== "object") continue;
    const target = typeof v.targetTicketId === "string" ? v.targetTicketId : "";
    if (!target) continue;
    if (!verifsByTarget.has(target)) verifsByTarget.set(target, []);
    verifsByTarget.get(target).push(v);
  }

  const gaps = [];
  for (const t of children) {
    if (!t || t.type === "epic") continue;
    if (String(t.status || "").toLowerCase() !== "done") continue;
    const sb = t.spawnedBy;
    if (!sb || !FIX_KINDS.has(sb.kind)) continue;
    if (sb.rearmOf) continue; // a re-arm ticket is a verifier, not a fix
    const roles = Array.isArray(fixRearm[sb.kind]) ? fixRearm[sb.kind] : [];
    if (roles.length === 0) continue; // this kind re-arms nothing
    const ticketId = String(t.ticketId || "");
    const entry = tasks[ticketId] || byTicketId.get(ticketId);
    const commitSha =
      typeof entry?.commitSha === "string" && entry.commitSha.trim() ? entry.commitSha.trim() : "";
    if (!commitSha) {
      gaps.push({ ticketId, commitSha: null, missingKinds: ["commitSha"] });
      continue;
    }
    const records = verifsByTarget.get(ticketId) || [];
    const missingKinds = [];
    for (const role of roles) {
      const kind = FIX_REARM_ROLE_TO_KIND[role] || role;
      const passed = records.some(
        (v) =>
          shaMatches(v.headSha, commitSha) &&
          v.kind === kind &&
          String(v.verdict || "").toLowerCase() === "pass"
      );
      if (!passed && !missingKinds.includes(kind)) missingKinds.push(kind);
    }
    if (missingKinds.length > 0) gaps.push({ ticketId, commitSha, missingKinds });
  }
  return gaps;
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
