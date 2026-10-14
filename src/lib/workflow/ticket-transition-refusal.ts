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
 *   lambda/agentcore-hub-tickets/index.mjs:2461  { key, status: "transitioned", to, … }
 *   lambda/agentcore-hub-jira/index.mjs:2495      { ticketId, status: <finalStatus>, message, … }
 * `to`/`status` are compared against targetStatus trimmed + lowercased, the
 * same normalization the route applies before it ever reaches the Lambda.
 */
export function provesTransitioned(payload: unknown, targetStatus: string): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  if (typeof p.error === "string" && p.error.trim()) return false;
  const target = normalizeStatus(targetStatus);
  if (p.status === "transitioned") {
    // tickets twin: `to` names the actual destination. The real return always
    // carries it; `to === undefined` is kept lenient only because existing
    // fixtures/tests use the bare `{status:"transitioned"}` shape.
    return p.to === undefined || normalizeStatus(p.to) === target;
  }
  return typeof p.ticketId === "string" && normalizeStatus(p.status) === target;
}
