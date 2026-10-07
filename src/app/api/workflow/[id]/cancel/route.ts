/**
 * POST /api/workflow/[id]/cancel
 *
 * Body: { reason: string (required, ≤1000), decision?: "stopped" }
 *
 * Parses, identifies the caller, and hands off to cancelRun()
 * (src/lib/workflow/cancel-run.ts), which sets the phase, sweeps the tickets
 * and publishes workflow.cancelled. The orchestrator's cancel guard prevents
 * any new agent invocations after the phase is set. In-flight agents are NOT
 * interrupted (their tickets are reported in ticketsLeftRunning).
 *
 *   200 { status:"cancelled", cancelledAt, cancelledBy, reason, decision?, decisionDropped?,
 *         tickets, humanGatesLeftOpen, ticketsLeftRunning, cancelStatusMissing?,
 *         ticketsIncomplete?, error?, followUpsMoved }
 *   400 reason_required | reason_too_long {max} | decision_invalid
 *   404 Workflow not found
 *   409 Workflow already in terminal state
 *
 * cancelledBy is the verified identity (TEAM-5358 F8), else unauthenticated:cancel;
 * the x-hub-caller header is kept as claimedCaller. decision "stopped" is
 * persisted only per F9 (see cancel-run.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { claimedCallerOf, requireHumanIdentity, verifiedActor } from "@/lib/auth/human";
import { CANCEL_DECISION, CANCEL_REASON_MAX, cancelRun, sanitizeCancelReason } from "@/lib/workflow/cancel-run";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const workflowId = params.id;

  // Input validation
  if (!workflowId || typeof workflowId !== "string") {
    return NextResponse.json(
      { error: "Invalid workflow ID" },
      { status: 400 }
    );
  }

  let body: { reason?: unknown; decision?: unknown } | null = null;
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
  if (body?.decision !== undefined && body.decision !== CANCEL_DECISION) {
    return NextResponse.json({ error: "decision_invalid", allowed: [CANCEL_DECISION] }, { status: 400 });
  }

  try {
    const result = await cancelRun({
      workflowId,
      reason: reason.reason,
      decision: body?.decision === CANCEL_DECISION ? CANCEL_DECISION : undefined,
      cancelledBy: verifiedActor(request, "cancel"),
      humanIdentity: requireHumanIdentity(request).ok,
      claimedCaller: claimedCallerOf(request),
    });
    return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
  } catch (error) {
    console.error("[cancel] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
