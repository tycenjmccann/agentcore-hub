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
 *   TEAM-6165 — the jira twin's already-Done acknowledgement (a literal `done` on an issue
 *   Jira already reads Done, after the Done guard admitted it): { ticketId, status: "done",
 *   requested: "done", alreadyDone: true, noop: true, message }. It is proof by the plain
 *   `landed === target` rule below — no rule here is loosened for it. TEAM-6206: the Done
 *   it reports is a status RE-READ taken after the guard's awaits, right before the ack.
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
 *   - TEAM-6141: an absent/empty landed status is never proof, and the pair is proof only
 *     when it ACCOUNTS for the move the way the Lambda made it: the matched transition is
 *     NAMED for the target (the Lambda's own match rule — a destination match would have
 *     landed on the target) and the landed status is the Lambda's own mapping of the
 *     destination it echoed (jiraStatusToInternal, a mirror of its mapStatusToInternal).
 *     `{requested:"done", matchedTransition:{name:"Start Review", to:"Waiting for review"}}`
 *     with `status:"waiting_for_review"` is a move the Lambda never makes for a done.
 * `to`/`status`/`requested` are compared against targetStatus trimmed + lowercased,
 * the same normalization the route applies before it ever reaches the Lambda.
 */
/** The hub's own columns. A Jira move that lands in one of these is proof only when it IS the target. */
export const HUB_STATUSES = ["todo", "ready", "in_progress", "in_review", "blocked", "done", "cancelled"];

/**
 * TEAM-6141 — mirror of the jira Lambda's status map (INTERNAL_TO_JIRA / JIRA_TO_INTERNAL /
 * mapStatusToInternal in lambda/agentcore-hub-jira/index.mjs). The Lambda ships as a
 * self-contained zip, so the two copies cannot share a file; parity is pinned against the
 * REAL Lambda module by ticket-transition-refusal.jira-e2e.test.ts. Edit the Lambda first.
 */
const INTERNAL_TO_JIRA: Record<string, string> = {
  todo: "To Do",
  ready: "Ready",
  in_progress: "In Progress",
  in_review: "In Review",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Won't Do",
};
const JIRA_TO_INTERNAL: Record<string, string> = {
  ...Object.fromEntries(Object.entries(INTERNAL_TO_JIRA).map(([k, v]) => [v.toLowerCase(), k])),
  "wont do": "cancelled",
  cancelled: "cancelled",
  canceled: "cancelled",
};

/** What the Lambda reports as `status` for a Jira status name (its mapStatusToInternal). */
export function jiraStatusToInternal(name: unknown): string {
  const n = normalizeStatus(name);
  return JIRA_TO_INTERNAL[n] || n.replace(/\s+/g, "_");
}

/**
 * The Jira display name the Lambda matches a requested internal status against — its
 * `effectiveStatus` (`INTERNAL_TO_JIRA[target] || target`), lowercased as it compares it.
 */
export function jiraDisplayNameOf(target: string): string {
  return normalizeStatus(INTERNAL_TO_JIRA[target] ?? target);
}

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
  if (!landed) return false; // TEAM-6141: no landed status — nothing to account for, whatever the metadata says
  if (landed === target) return true;
  if (HUB_STATUSES.includes(landed)) return false; // landed in one of OUR other columns: not the move asked for
  if (normalizeStatus(p.requested) !== target) return false;
  const mt = p.matchedTransition;
  if (!mt || typeof mt !== "object" || Array.isArray(mt)) return false;
  const m = mt as Record<string, unknown>;
  if (!nonEmptyString(m.id) || !nonEmptyString(m.name) || !nonEmptyString(m.to)) return false;
  // TEAM-6141: the pair is proof only when it accounts for the move the way the Lambda
  // made it. transitionTicket matches a transition whose NAME or DESTINATION equals the
  // target's Jira display name; `landed !== target` here, so a destination match is
  // impossible (it would have landed ON the target) — only a transition NAMED for the
  // target can have landed somewhere else…
  if (normalizeStatus(m.name) !== jiraDisplayNameOf(target)) return false;
  // …and where it landed must be the Lambda's own mapping of the destination it echoed.
  return jiraStatusToInternal(m.to) === landed;
}
