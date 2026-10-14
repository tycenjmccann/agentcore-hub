/**
 * TEAM-4282 F1 — BOTH ticket Lambdas report a refused transition inside a 200
 * payload with no FunctionError, so `response.FunctionError` alone reported
 * success:true for tickets that never moved. Returns the refusal text, or null
 * when nothing proves a refusal.
 *
 * The two vocabularies, read off the Lambdas:
 *   lambda/agentcore-hub-tickets/index.mjs:805  success = { key, status: "transitioned", from, to, … }
 *                                        :748  refusal = textResult(...) = { content: [{ text }] }
 *   lambda/agentcore-hub-jira/index.mjs:722     success = { ticketId, status: <internal>, message }
 *                                      :1074    refusal = { error: err.message }
 * Note the jira success `status` is the internal status ("done"), NOT "transitioned",
 * and can differ from targetStatus when Jira matched by transition name — so this is
 * a DENY-list, not a success allow-list. It therefore fails OPEN on an unknown shape:
 * a false refusal would revert a record for a ticket that really did move, which is
 * strictly worse than the pre-existing false success.
 *
 * TEAM-6094: shared between the console's own transition route and the
 * workflow webhook route, so both callers of Tickets___transition_ticket read
 * the SAME deny-list rather than drifting apart.
 */
export function rejectedDetails(payload: unknown, targetStatus: string): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.error === "string" && p.error.trim()) return p.error.trim();
  if (Array.isArray(p.content) && p.status !== "transitioned" && p.status !== targetStatus) {
    const first = p.content[0] as { text?: unknown } | undefined;
    return typeof first?.text === "string" && first.text.trim()
      ? first.text.trim()
      : "transition refused by the tickets Lambda";
  }
  return null;
}

function normalizeStatus(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * TEAM-6123 — the success-side counterpart to rejectedDetails above.
 * rejectedDetails answers null for a payload it doesn't recognize as a
 * refusal (deliberately — see the fail-OPEN rationale above), and BOTH callers
 * treated that null as "the ticket moved": an unparseable payload, "", "null",
 * "{}", or an unrecognized object (e.g. `{ok:true,status:"blocked"}`) all read
 * as rejectedDetails()===null and were reported as a success.
 *
 * This is the SUCCESS allow-list that closes that gap — the opposite failure
 * mode from rejectedDetails' deny-list on purpose: a false positive here just
 * costs a 502 (leaves the record where it was, same as a FunctionError), never
 * reverts a ticket that really did move. Only the two real success shapes, read
 * verbatim off the Lambdas' own-and-only success returns, count as proof:
 *   lambda/agentcore-hub-tickets/index.mjs:2461  { key, status: "transitioned", from, to, … }
 *   lambda/agentcore-hub-jira/index.mjs:2495      { ticketId, status: <landed>, message,
 *                                                   requested, matchedTransition: {id,name,to}, … }
 *
 * TEAM-6131 — proof is about THE ticket and THE status the caller asked for:
 *   - the payload must name the requested ticket (`key` / `ticketId`; the tickets twin
 *     echoes the caller's ticket_id verbatim, so the compare is trim + case-insensitive
 *     only because the console route accepts mixed-case ids). A bare
 *     `{status:"transitioned"}` — a shape neither Lambda returns — is NOT proof.
 *   - the tickets twin's `to` must be the target (always an internal status).
 *   - the jira twin matches a requested transition by NAME or by destination and
 *     reports the destination's internal status, so a workflow whose transition named
 *     "Done" lands in e.g. "Closed" answers `status:"closed"` for a requested "done".
 *     That IS the move that was asked for: it is proof when the Lambda also says so —
 *     `requested` is the target and it echoes the `matchedTransition` it POSTed — and
 *     the landed status is NOT one of the hub's own other columns (HUB_STATUSES). A
 *     landed "in_progress"/"blocked"/… for a requested "done" is never proof, with or
 *     without those fields: the ticket is demonstrably somewhere else the hub models.
 * `to`/`status`/`requested` are compared against targetStatus trimmed + lowercased,
 * the same normalization the route applies before it ever reaches the Lambda.
 */
/** The hub's own columns. A Jira move that lands in one of these is proof only when it IS the target. */
const HUB_STATUSES = ["todo", "ready", "in_progress", "in_review", "blocked", "done", "cancelled"];

const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export function provesTransitioned(payload: unknown, targetStatus: string, ticketId: string): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  if (typeof p.error === "string" && p.error.trim()) return false;
  const target = normalizeStatus(targetStatus);
  const wanted = ticketId.trim().toUpperCase();
  const idMatches = (x: unknown) => nonEmptyString(x) && x.trim().toUpperCase() === wanted;
  if (p.status === "transitioned") {
    // tickets twin: `key` is the caller's ticket_id, `to` the actual internal destination.
    return idMatches(p.key) && normalizeStatus(p.to) === target;
  }
  // jira twin
  if (!idMatches(p.ticketId)) return false;
  const landed = normalizeStatus(p.status);
  if (landed === target) return true;
  if (HUB_STATUSES.includes(landed)) return false; // landed in one of OUR other columns: not the move asked for
  const mt = p.matchedTransition;
  if (!mt || typeof mt !== "object" || Array.isArray(mt)) return false;
  const m = mt as Record<string, unknown>;
  return normalizeStatus(p.requested) === target && nonEmptyString(m.id) && nonEmptyString(m.name) && nonEmptyString(m.to);
}
