/**
 * POST /api/workflow/[id]/stop — "Stop the run" (TEAM-5358 FR-8).
 *
 * Body: { reason: string (required, ≤1000) }
 *
 * A cancel that also closes every open human gate with a signed `stopped`
 * decision, so the run ends with a recorded decision on each gate instead of
 * gates left open (humanGatesLeftOpen). Human-only: the hub mints the stop
 * tokens with the gate-decision key, which it does only for a provably human
 * caller (requireHumanIdentity, as tickets/transition does). The Workflow
 * Manager and agents use /cancel.
 *
 *   1. read the run and list its tickets (loadRunForCancel — the cancel's own read)
 *   2. per open human:* gate: mint a `stopped` token bound to the gate's
 *      description (scope hash `s`) and ask the ticket Lambda for
 *      Tickets___transition_ticket → cancelled. The twin verifies the token and
 *      writes the v3 gate decision record (status cancelled) before the ticket moves.
 *   3. cancelRun({ decision: "stopped" }) — the cancel sweep, row write and event.
 *
 *   200 { status:"cancelled", gatesStopped, gatesNotStopped:[{ticketId, error}], ...cancel body }
 *   400 reason_required | reason_too_long {max}
 *   403 human_identity_required (no ticket is touched)
 *   404 / 409 as /cancel
 *
 * TEAM-5373: a repeat /stop on a run whose cancel committed but whose close-out
 * failed part-way (cancelCloseoutPending) is not 409: loadRunForCancel lets it
 * through, the gates still open are stopped, and cancelRun resumes the sweep and
 * follow-up moves under the original cancel (body carries resumed:true).
 *   502 ticket_list_failed (nothing written: a stop that cannot see its gates would not stop them)
 *   503 decision_channel_unavailable (gate-decision key unreadable; nothing written)
 *
 * A gate the twin refuses lands in gatesNotStopped and the cancel still runs;
 * the cancel then reports it in humanGatesLeftOpen.
 */

import { NextRequest, NextResponse } from "next/server";
import { claimedCallerOf, humanIdentityRequiredBody, requireHumanIdentity } from "@/lib/auth/human";
import {
  CANCEL_DECISION,
  CANCEL_REASON_MAX,
  cancelRun,
  loadRunForCancel,
  openHumanGates,
  sanitizeCancelReason,
} from "@/lib/workflow/cancel-run";
import { mintDecisionToken } from "@/lib/workflow/decision-contract";
import { loadDecisionKeys } from "@/lib/workflow/decision-keys";
import { invokeTicketTool } from "@/lib/workflow/ticket-tools";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const workflowId = params.id;
  if (!workflowId || typeof workflowId !== "string") {
    return NextResponse.json({ error: "Invalid workflow ID" }, { status: 400 });
  }

  const human = requireHumanIdentity(request);
  if (!human.ok) return NextResponse.json(humanIdentityRequiredBody(human.reason), { status: 403 });

  let body: { reason?: unknown } | null = null;
  try {
    body = await request.json();
  } catch {
    /* empty or non-JSON body: reason_required below */
  }
  const reason = sanitizeCancelReason(body?.reason);
  if (!reason.ok) {
    return NextResponse.json(
      reason.error === "reason_too_long" ? { error: reason.error, max: CANCEL_REASON_MAX } : { error: reason.error },
      { status: 400 }
    );
  }

  try {
    const run = await loadRunForCancel(workflowId);
    if (!run.ok) return NextResponse.json(run.body, { status: run.status });
    if (run.listError) return NextResponse.json({ error: "ticket_list_failed", detail: run.listError }, { status: 502 });

    const gates = openHumanGates(run.tickets);
    const gatesStopped: string[] = [];
    const gatesNotStopped: Array<{ ticketId: string; error: string }> = [];
    if (gates.length > 0) {
      const keys = await loadDecisionKeys();
      if (!keys.ok) return NextResponse.json({ error: "decision_channel_unavailable", detail: keys.detail }, { status: 503 });
      for (const gate of gates) {
        const decision_token = mintDecisionToken(
          { ticketId: gate.ticketId, option: CANCEL_DECISION, channel: "hub", by: human.by, workflowId, description: gate.description || "" },
          keys.keys[0]
        );
        const res = await invokeTicketTool("Tickets___transition_ticket", {
          ticket_id: gate.ticketId,
          transition_id: "cancelled",
          reason: `${reason.reason}\nDECISION: override:${CANCEL_DECISION}`,
          decision: CANCEL_DECISION,
          decision_token,
          note: reason.reason,
        });
        if (res.ok) gatesStopped.push(gate.ticketId);
        else gatesNotStopped.push({ ticketId: gate.ticketId, error: res.error });
      }
    }

    const result = await cancelRun({
      workflowId,
      reason: reason.reason,
      decision: CANCEL_DECISION,
      cancelledBy: human.by,
      humanIdentity: true,
      claimedCaller: claimedCallerOf(request),
    });
    if (!result.ok) return NextResponse.json({ ...result.body, gatesStopped, gatesNotStopped }, { status: result.status });
    return NextResponse.json({ ...result.body, gatesStopped, gatesNotStopped }, { status: 200 });
  } catch (error) {
    console.error("[stop] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
