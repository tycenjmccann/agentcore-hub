/**
 * liveGate — a human gate as the active ticket twin reports it NOW (TEAM-5367,
 * DL-036): its current decision cycle (`gateCycle`) and scope line, read through
 * Tickets___get_issue. A gate-decision record stands only against this
 * (gateDecisionStands). Never throws: an unreadable or refused read is null, which
 * gateDecisionStands treats as cycle_unknown, i.e. the record does not stand.
 */

import { liveGateOf, type LiveGate } from "./gate-decision-record";
import { invokeTicketTool } from "./ticket-tools";

export type LiveGateReader = (ticketId: string) => Promise<LiveGate | null>;

export const liveGate: LiveGateReader = async (ticketId) => {
  const res = await invokeTicketTool("Tickets___get_issue", { ticket_id: ticketId });
  return res.ok ? liveGateOf(res.result) : null;
};
