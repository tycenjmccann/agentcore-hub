import { NextRequest, NextResponse } from "next/server";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { getWorkflowFromDynamo, getTicketsForWorkflowFromDynamo } from "@/lib/workflow/dynamo-read";
import { getTicketsForWorkflowFromJira } from "@/lib/workflow/jira-read";
import { withDefaultDecision } from "@/lib/workflow/gate-decision";
import { getIdentity } from "@/lib/auth/identity";

export const dynamic = "force-dynamic";

const TICKET_PROVIDER = process.env.TICKET_PROVIDER || "dynamodb";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" }),
  { marshallOptions: { removeUndefinedValues: true } }
);

/**
 * TEAM-3991 F6 — the gate DECISION ledger writer.
 *
 * `reviewGateHistory[gate].decisions` is the authoritative record of merge
 * authority: the gate-bypass detector (lambda/orchestrator/gate-bypass.mjs)
 * compares each merged PR's `mergedAt` against these rows, NOT against the gate
 * ticket's board status — a status can be flipped by an agent, a row cannot.
 *
 * SECURITY: rows are written ONLY from human-authenticated paths, which is this
 * route (and the Telegram bridge, which taps the very same endpoint — see the
 * `source` note below). The orchestrator's done handlers CONSUME the ledger and
 * must never append an APPROVE, or the detector would be approving on the
 * agent's behalf and could never fire.
 *
 * `decidedBy` comes from the middleware-verified identity header. NEVER from the
 * request body: a body-supplied actor is caller-controlled, and this row is the
 * evidence a human authorized the merge.
 *
 * Mirrors workflow-store.mjs appendGateDecision — seed the map, then list_append
 * (never a whole-array rewrite, so a console click and a Telegram reply landing
 * together are both recorded). Best-effort by construction: the human's
 * transition already succeeded, so a ledger failure is logged, never surfaced.
 */
async function recordGateDecision(
  workflowId: string,
  gateTicketId: string,
  targetStatus: string,
  decidedBy: string
): Promise<void> {
  const decision = targetStatus === "done" ? "APPROVE" : "REQUEST_CHANGES";
  const row = {
    decision,
    decidedAt: new Date().toISOString(),
    decidedBy,
    // The Telegram gate buttons (deploy/telegram-bug-intake handleGateCallback /
    // handleDecisionCallback, both merge-approval and escalation gates) POST to
    // THIS route, so their taps are recorded here too. We deliberately do not
    // read a `source` from the body — a spoofable provenance label on a security
    // record is worse than one honest value naming the endpoint that wrote it.
    source: "console",
  };
  await ddb.send(
    new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
      UpdateExpression: "SET reviewGateHistory = if_not_exists(reviewGateHistory, :emptyMap)",
      ExpressionAttributeValues: { ":emptyMap": {} },
    })
  );
  await ddb.send(
    new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
      UpdateExpression: "SET reviewGateHistory.#g = if_not_exists(reviewGateHistory.#g, :seed)",
      ExpressionAttributeNames: { "#g": gateTicketId },
      ExpressionAttributeValues: { ":seed": { rounds: [], authorizations: [], escalations: [] } },
    })
  );
  await ddb.send(
    new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
      UpdateExpression:
        "SET reviewGateHistory.#g.decisions = list_append(if_not_exists(reviewGateHistory.#g.decisions, :empty), :d)",
      ExpressionAttributeNames: { "#g": gateTicketId },
      ExpressionAttributeValues: { ":empty": [], ":d": [row] },
    })
  );
  console.log(`[transition] ${gateTicketId}: recorded ${decision} by ${decidedBy} in the gate ledger`);
}

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

  const { ticketId, targetStatus, comment } = body;

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

  // TEAM-3971: an approve (→ done) needs the gate's title, to recognise an
  // escalation gate. TEAM-3991 F6 needs the same row's assignee, to recognise a
  // human gate. Best-effort — a lookup failure must never block a human's
  // decision (withDefaultDecision no-ops for anything but done).
  let decisionDefaulted: string | null = null;
  let finalComment: string | undefined = comment;
  // TEAM-3991 F6: a decision on a HUMAN gate also earns a ledger row. Only the
  // two decision transitions qualify — done is an approve, blocked is a request
  // for changes; every other move (a re-open, a manual unstick) is not a verdict.
  let humanGate = false;
  if (targetStatus === "done" || targetStatus === "blocked") {
    try {
      if (TICKET_PROVIDER === "jira") {
        tickets = (await getTicketsForWorkflowFromJira(params.id)) as unknown as Record<string, unknown>[];
      }
      const gate = tickets.find((t) => t.ticketId === ticketId);
      humanGate = String(gate?.assignee || "").startsWith("human:");
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

  // Invoke the agentcore-hub-tickets Lambda
  const lambda = new LambdaClient({ region: process.env.AWS_REGION || "us-east-1" });

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

    // TEAM-3991 F6: the transition landed, so a human has now decided this gate
    // — record it. AFTER the Lambda, never before: a ledger row claiming an
    // approval the board never received is exactly the false authority the
    // bypass detector exists to catch.
    if (humanGate) {
      try {
        await recordGateDecision(params.id, ticketId, targetStatus, getIdentity(req).userId);
      } catch (err) {
        console.error(`[transition] ${ticketId}: gate ledger write failed (transition already applied): ${err instanceof Error ? err.message : err}`);
      }
    }

    return NextResponse.json({
      success: true, ticketId, newStatus: targetStatus,
      ...(decisionDefaulted ? { decisionDefaulted } : {}),
    });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Lambda invocation failed", details: errorMessage },
      { status: 500 }
    );
  }
}
