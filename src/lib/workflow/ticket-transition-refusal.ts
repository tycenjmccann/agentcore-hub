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
