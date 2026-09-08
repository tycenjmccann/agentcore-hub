import { NextRequest, NextResponse } from "next/server";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getWorkflowFromDynamo, getTicketsForWorkflowFromDynamo } from "@/lib/workflow/dynamo-read";
import { getTicketsForWorkflowFromJira } from "@/lib/workflow/jira-read";
import { withDefaultDecision } from "@/lib/workflow/gate-decision";

export const dynamic = "force-dynamic";

const TICKET_PROVIDER = process.env.TICKET_PROVIDER || "dynamodb";
const REGION = process.env.AWS_REGION || "us-east-1";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";

// TEAM-4266: cap the operator's evidence string at the same length
// evidenceBackfillFields (lambda/orchestrator/completion.mjs) slices a record's
// summary to, so the record can never be larger than what the gate will read.
const EVIDENCE_MAX_LEN = 10000;

const VALID_STATUSES = ["todo", "ready", "in_progress", "in_review", "done", "blocked"];

// Simplified flow: todo → ready → in_progress → done  (+blocked as escape hatch).
// in_review is the human-review gate state: approve (→done) or request changes (→blocked).
const VALID_TRANSITIONS: Record<string, string[]> = {
  todo: ["ready", "blocked"],
  ready: ["in_progress", "in_review", "blocked"],
  in_progress: ["done", "in_review", "blocked"],
  in_review: ["done", "blocked"],
  blocked: ["todo", "ready", "in_progress", "in_review", "done"],
  done: ["todo"],
};

/**
 * TEAM-4266 — persist an out-of-band approve's evidence as the SAME completion
 * record the agent's own report_completion would have written
 * (completions/{ticketId}.json, lambda/workflow-output/index.mjs reportCompletion).
 *
 * The bug this closes: when an agent ships its deliverable and then dies before
 * calling report_completion, the Workflow Manager closes the ticket with
 * `intervene.py mark-done --evidence "..."`. That recorded the proof as prose only
 * (a ticket comment + a manager.intervention event), so nothing ever wrote the
 * record BOTH completion evidence gates require — harvestCompletionEvidence /
 * missingEvidenceTickets in lambda/orchestrator, and the twin in
 * POST /api/workflow/[id]/complete. The run then emitted
 * workflow.completion_blocked reason=missing_evidence forever and /complete 409'd.
 * Writing the record here makes mark-done a first-class evidence producer with no
 * change to either gate: a non-empty `summary` is all completionRecordHasEvidence
 * needs, and evidenceBackfillFields maps it onto agentTasks[ticketId].output.
 *
 * FILL-ONLY-IF-MISSING, atomically: IfNoneMatch "*" makes the PUT fail with 412
 * PreconditionFailed when a record already exists, so an agent's authoritative
 * record (which carries pr_url / commit_sha / merge signals this one cannot) is
 * never clobbered by an operator's prose. A late-landing agent record is already
 * handled by the gates' own completions-record fallback (TEAM-3976).
 *
 * Best-effort by design: any other S3 failure is logged and swallowed. The
 * TRANSITION is the primary action — refusing it because a side-effect write
 * failed would strand the run harder than the bug being fixed here. Returns
 * whether the record was written so the caller (intervene.py) can report it.
 */
async function writeCompletionRecord(ticketId: string, evidence: string): Promise<boolean> {
  if (!ARTIFACT_BUCKET) {
    console.warn(`[transition] ${ticketId}: ARTIFACT_BUCKET unset — completion evidence record not written`);
    return false;
  }
  const key = `completions/${ticketId}.json`;
  // Byte-compatible superset of reportCompletion's record: the same key set, plus
  // `source` (audit: this came from an operator, not the agent) and the already-
  // valid evidence_kind "static". Every reader ignores unknown keys.
  const record = {
    ticket_id: ticketId,
    summary: evidence.slice(0, EVIDENCE_MAX_LEN),
    artifacts: "",
    branch: null,
    commit_sha: null,
    pr_url: null,
    completed_at: new Date().toISOString(),
    source: "workflow-manager",
    evidence_kind: "static",
  };
  try {
    const s3 = new S3Client({ region: REGION });
    await s3.send(
      new PutObjectCommand({
        Bucket: ARTIFACT_BUCKET,
        Key: key,
        Body: JSON.stringify(record, null, 2),
        ContentType: "application/json",
        IfNoneMatch: "*",
      })
    );
    console.log(`[transition] ${ticketId}: wrote completion evidence record s3://${ARTIFACT_BUCKET}/${key}`);
    return true;
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === "PreconditionFailed" || e?.$metadata?.httpStatusCode === 412) {
      console.log(`[transition] ${ticketId}: ${key} already exists — keeping the existing record`);
      return false;
    }
    console.warn(
      `[transition] ${ticketId}: completion evidence record write failed (non-fatal): ${err instanceof Error ? err.message : err}`
    );
    return false;
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  // Parse request body
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // TEAM-4266: `evidence` is STRICTLY optional — the console UI never sends it, and
  // a blank/non-string value is ignored rather than rejected, so every existing
  // caller behaves exactly as before.
  const { ticketId, targetStatus, comment, evidence } = body;
  const trimmedEvidence = typeof evidence === "string" ? evidence.trim() : "";

  // Validate ticketId
  if (!ticketId || typeof ticketId !== "string") {
    return NextResponse.json(
      { error: "ticketId is required and must be a non-empty string" },
      { status: 400 }
    );
  }

  // Validate targetStatus
  if (!targetStatus || !VALID_STATUSES.includes(targetStatus)) {
    return NextResponse.json(
      { error: `targetStatus must be one of: ${VALID_STATUSES.join(", ")}` },
      { status: 400 }
    );
  }

  // Verify workflow exists
  const workflow = await getWorkflowFromDynamo(params.id);
  if (!workflow) {
    return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  }

  // In jira mode tickets live in Jira (no DynamoDB tickets table). The ticket
  // Lambda validates transition legality against Jira's live transitions, so we
  // skip the DDB pre-check here. In dynamodb mode we still validate locally.
  let tickets: Record<string, unknown>[] = [];
  if (TICKET_PROVIDER !== "jira") {
    tickets = (await getTicketsForWorkflowFromDynamo(params.id)) as Record<string, unknown>[];
    const ticket = tickets.find((t) => (t as Record<string, unknown>).ticketId === ticketId);
    if (!ticket) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }
    const currentStatus = ticket.status as string;
    const allowedTransitions = VALID_TRANSITIONS[currentStatus] || [];
    if (!allowedTransitions.includes(targetStatus)) {
      return NextResponse.json(
        { error: `Invalid transition from ${currentStatus} to ${targetStatus}` },
        { status: 400 }
      );
    }
    // in_review is reserved for human-review-gate tickets (assignee "human:*").
    const assignee = String((ticket as Record<string, unknown>).assignee || "");
    if (targetStatus === "in_review" && !assignee.startsWith("human:")) {
      return NextResponse.json(
        { error: "Only human-review tickets can be sent to in_review" },
        { status: 400 }
      );
    }
  }

  // TEAM-3971: only an approve (→ done) needs the gate's title, and only to
  // recognise an escalation gate. Best-effort — a lookup failure must never
  // block a human's approval.
  let decisionDefaulted: string | null = null;
  let finalComment: string | undefined = comment;
  if (targetStatus === "done") {
    try {
      if (TICKET_PROVIDER === "jira") {
        tickets = (await getTicketsForWorkflowFromJira(params.id)) as unknown as Record<string, unknown>[];
      }
      const gate = tickets.find((t) => t.ticketId === ticketId);
      ({ comment: finalComment, decisionDefaulted } = withDefaultDecision(
        comment, targetStatus, gate ? String(gate.title || "") : undefined
      ));
      if (decisionDefaulted) {
        console.log(`[transition] ${ticketId}: escalation gate approved without a DECISION line — recorded as DECISION: ${decisionDefaulted}`);
      }
    } catch (err) {
      console.warn(`[transition] ${ticketId}: escalation-gate lookup failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  // TEAM-4266: write the completion evidence record BEFORE the transition. The
  // orchestrator's done cascade (markTaskComplete → harvestCompletionEvidence) runs
  // off the DDB stream / Jira webhook this transition fires, so writing first means
  // the evidence is harvested in the SAME orchestrator pass instead of waiting for
  // the completion-time re-harvest. Sits on the shared path, so it behaves
  // identically in both jira and dynamodb ticket-provider modes.
  const wantsEvidenceRecord = targetStatus === "done" && trimmedEvidence.length > 0;
  const completionRecordWritten = wantsEvidenceRecord
    ? await writeCompletionRecord(ticketId, trimmedEvidence)
    : false;

  // Invoke the agentcore-hub-tickets Lambda
  const lambda = new LambdaClient({ region: REGION });

  const payload = {
    tool_name: "Tickets___transition_ticket",
    parameters: {
      ticket_id: ticketId,
      transition_id: targetStatus,
      reason: finalComment || "Manual override from console",
    },
  };

  try {
    const command = new InvokeCommand({
      FunctionName: process.env.TICKET_TOOLS_LAMBDA || "agentcore-hub-tickets",
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify(payload)),
    });

    const response = await lambda.send(command);

    if (response.FunctionError) {
      const errorMessage = response.Payload
        ? Buffer.from(response.Payload).toString()
        : "Unknown error";
      return NextResponse.json(
        { error: "Lambda invocation failed", details: errorMessage },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true, ticketId, newStatus: targetStatus,
      ...(decisionDefaulted ? { decisionDefaulted } : {}),
      // Only when evidence was supplied, so the console UI's response shape is
      // byte-identical to before (same idiom as decisionDefaulted above).
      ...(wantsEvidenceRecord ? { completionRecordWritten } : {}),
    });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Lambda invocation failed", details: errorMessage },
      { status: 500 }
    );
  }
}
