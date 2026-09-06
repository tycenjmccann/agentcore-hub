/**
 * Human review-gate state machine (TEAM-4120 FR-1).
 *
 * The reject path is currently driven by ONE signal: a gate ticket's transition
 * to `blocked`. That signal is ambiguous, and every ambiguity has already fired
 * in production:
 *   - a gate's CREATION-time dependency block (`todo → blocked`, or an INSERT
 *     straight into blocked) read as "Request changes" — TEAM-4044, which fixed
 *     that one case by pinning the PREVIOUS status;
 *   - a gate blocked again after an earlier rejection (a webhook redelivery, or
 *     the DDB-stream twin firing for the same change) re-opening the same
 *     upstream work a second time;
 *   - a gate blocked that was never PRESENTED to a human at all (no review was
 *     requested, so nobody could have requested changes).
 *
 * The fix is to stop inferring the human's intent from a status edge and read it
 * off recorded state instead: the orchestrator writes `requested` when it parks
 * a gate for a human, and a `→ blocked` is admitted as a rejection only when the
 * gate is actually sitting in `requested`.
 *
 * This module is the pure half — the truth table plus the flag normalizer. ZERO
 * imports, no I/O, so it can be reasoned about (and tested) without an AWS
 * client anywhere near it. The store writes live in workflow-store.mjs (the only
 * module allowed to write the workflows table) and the wiring in index.mjs.
 *
 * Rollout: GATE_STATE_GUARD = off (default) | shadow | enforce.
 *   off     — byte-identical to pre-4120: the guard returns "admitted" before
 *             reading anything, so ZERO extra DynamoDB I/O.
 *   shadow  — classify + RECORD state + publish gate.reject_ignored
 *             {wouldDrop:true}, but never drop: every rejection still runs.
 *             Deliberately NOT byte-identical (it writes gateStates, so the
 *             ledger is populated before an operator flips enforce) — same
 *             posture as REWORK_LOOP_CAP's shadow.
 *   enforce — an unrequested/duplicate rejection is dropped.
 */

/** The states a gate can be recorded in. A seed ("none") or anything else is
 * "no usable state" — see classifyRejection. */
export const GATE_STATES = ["requested", "rejected", "approved"];

/**
 * STRICT allow-list: exactly off | shadow | enforce (trimmed, lowercased);
 * anything else — unset, "", legacy "on"/"true"/"1", a typo — is off.
 *
 * Fail-safe DIRECTION matters here and it is the opposite of REWORK_LOOP_CAP's.
 * The dangerous failure for this guard is DROPPING a human's Request-changes: a
 * reviewer clicks the one button they have and the run silently ignores it. So
 * an unrecognized value must never grant enforce, and never even shadow (which
 * writes). Only an operator who typed a mode exactly gets one.
 */
export function normalizeGateGuardMode(v) {
  const m = String(v ?? "").trim().toLowerCase();
  return m === "shadow" || m === "enforce" || m === "off" ? m : "off";
}

/**
 * Classify a gate's `→ blocked` transition.
 *
 *   creation_block — the gate was never presented because it had just been
 *                    created (prev status "", "new", "todo"). DEFENSIVE ONLY:
 *                    both call sites already break on isCreationTimeBlock
 *                    before reaching the classifier (index.mjs), so this is the
 *                    belt to that suspenders — a future caller that forgets the
 *                    check still cannot read a creation block as a rejection.
 *   presented      — the gate is sitting in `requested`: a human was actually
 *                    asked, so this is their answer. ADMIT.
 *   duplicate      — the gate is already `rejected`: this is the same rejection
 *                    arriving twice (webhook redelivery, or the DDB-stream twin
 *                    firing for the change the Jira webhook already handled).
 *   unrequested    — nothing was pending: the gate is `approved` (its review
 *                    already concluded) or has no recorded state and no
 *                    review_needed notification ever existed for it.
 *
 * `gateState` absent (or carrying the "none" seed / an unknown state) means
 * this run predates the ledger — it may have been parked for a human long
 * before the guard was deployed. Falling back to the notification is the
 * fail-OPEN direction: if a review_needed for this gate exists at all, a human
 * WAS asked, so their rejection is honored.
 *
 * Callers pass the whole `{ gateTicket, oldStatus, gateState, hasReviewNeeded }`
 * bag; `gateTicket` is for the caller's own logging and is deliberately NOT
 * destructured here. Nothing on the ticket may influence the verdict — by the
 * time this runs its status is already `blocked`, so it carries no information
 * about whether a human was ever asked.
 */
export function classifyRejection({ oldStatus, gateState, hasReviewNeeded } = {}) {
  const prev = String(oldStatus ?? "").trim().toLowerCase();
  if (prev === "" || prev === "new" || prev === "todo") return "creation_block";

  const st = gateState?.state;
  if (st === "requested") return "presented";
  if (st === "rejected") return "duplicate";
  if (st === "approved") return "unrequested";

  // No usable recorded state (absent row, or the "none" seed): legacy fail-open.
  return hasReviewNeeded ? "presented" : "unrequested";
}
