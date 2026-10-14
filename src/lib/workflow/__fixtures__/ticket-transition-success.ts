/**
 * TEAM-6131 — the ONLY success shapes the two ticket Lambdas return from
 * Tickets___transition_ticket, as test fixtures shared by every reader of
 * provesTransitioned (the helper test, the webhook route test and the console
 * transition route test), so the fixtures cannot drift apart from each other.
 *
 * They are pinned against the Lambdas themselves:
 *   - the jira shapes are asserted with toEqual against the REAL handler's return in
 *     src/lib/workflow/ticket-transition-refusal.jira-e2e.test.ts;
 *   - the tickets shape is the return at lambda/agentcore-hub-tickets/index.mjs:2461
 *     (`key` is the caller's ticket_id verbatim, `to` the internal destination).
 */

/** lambda/agentcore-hub-tickets/index.mjs:2461 — key + status:"transitioned" + from/to/transition. */
export function ticketsSuccess(ticketId: string, to: string, from = "in_progress") {
  return { key: ticketId, status: "transitioned", from, to, transition: to };
}

/** lambda/agentcore-hub-jira/index.mjs:2495 — the ordinary Jira Done: the matched transition's destination IS Done. */
export const JIRA_DONE_SUCCESS = {
  ticketId: "TEAM-7",
  status: "done",
  message: "Transitioned to done",
  requested: "done",
  matchedTransition: { id: "31", name: "Done", to: "Done" },
};

/**
 * TEAM-6131 Finding 4 — a Jira workflow whose transition NAMED "Done" lands in a status
 * the hub does not model ("Closed"). The Lambda matched by name, POSTed it, and reports
 * the destination it actually landed in (`status: "closed"`) alongside what was asked for.
 */
export const JIRA_NAME_MATCH_CLOSED = {
  ticketId: "TEAM-7",
  status: "closed",
  message: "Transitioned to closed",
  requested: "done",
  matchedTransition: { id: "31", name: "Done", to: "Closed" },
};
