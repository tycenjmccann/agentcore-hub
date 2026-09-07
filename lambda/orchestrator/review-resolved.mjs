/**
 * review.resolved — the ONE canonical lifecycle event every human-review gate
 * emits when it reaches a terminal state, whichever way it resolved
 * (TEAM-4167 D3 FR-3.2).
 *
 * Before this, a consumer had to piece a gate's outcome together from a scatter
 * of shape-specific events (review.approved_with_advisory, review.rejected,
 * a gate-skip that emitted nothing). review.resolved is the single, uniform
 * signal: one event per gate completion carrying the outcome, when it resolved,
 * and who resolved it.
 *
 * `outcome` vocabulary:
 *   "approved"                — a human approved the gate.
 *   "approved_with_advisory"  — approved with advisory findings recorded.
 *   "rejected"                — a human requested changes / the gate was held.
 *   "skipped"                 — the gate never engaged (e.g. a ship gate on a
 *                               handoff run) and was resolved without a human.
 *
 * Pure — builds the detail object only; index.mjs owns publishEvent. Emitted
 * ONLY for human gates (assignee startsWith "human:"), exactly once per gate
 * completion.
 */

/** The canonical review.resolved detail. `now` is a single ISO stamp reused for
 *  both resolvedAt and timestamp so the two never disagree. */
export function buildReviewResolved({ workflowId, ticketId, assignee, outcome, now }) {
  return {
    workflowId,
    ticketId,
    outcome,
    resolvedAt: now,
    reviewer: assignee || null,
    timestamp: now,
  };
}
