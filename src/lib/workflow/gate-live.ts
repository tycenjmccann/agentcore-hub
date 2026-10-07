/**
 * liveGate — a human gate as the active ticket twin reports it NOW (TEAM-5367,
 * DL-036): its current decision cycle (`gateCycle`), scope line and status, read
 * through Tickets___get_issue. A gate-decision record stands only against this
 * (gateDecisionStands); it is COMMITTED, not just a pending claim, only when its
 * status also matches the live status (gateDecisionCommitted, TEAM-5397 F4). Never
 * throws: an unreadable or refused read is null, which gateDecisionStands treats
 * as cycle_unknown (does not stand) and gateDecisionCommitted treats as not
 * committed.
 */

import { liveGateOf, liveStatusOf, type LiveGate } from "./gate-decision-record";
import { invokeTicketTool } from "./ticket-tools";

export type LiveGateReader = (ticketId: string) => Promise<LiveGate | null>;

export const liveGate: LiveGateReader = async (ticketId) => {
  const res = await invokeTicketTool("Tickets___get_issue", { ticket_id: ticketId });
  if (!res.ok) return null;
  const live = liveGateOf(res.result);
  return live && { ...live, status: liveStatusOf(res.result) };
};
