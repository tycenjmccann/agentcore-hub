import { NextRequest, NextResponse } from "next/server";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { getWorkflowFromDynamo, getTicketsForWorkflowFromDynamo } from "@/lib/workflow/dynamo-read";

export const dynamic = "force-dynamic";

const TICKET_PROVIDER = process.env.TICKET_PROVIDER || "dynamodb";

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
  if (TICKET_PROVIDER !== "jira") {
    const tickets = await getTicketsForWorkflowFromDynamo(params.id);
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

  // Invoke the agentcore-hub-tickets Lambda
  const lambda = new LambdaClient({ region: process.env.AWS_REGION || "us-east-1" });

  const payload = {
    tool_name: "Tickets___transition_ticket",
    parameters: {
      ticket_id: ticketId,
      transition_id: targetStatus,
      reason: comment || "Manual override from console",
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

    return NextResponse.json({ success: true, ticketId, newStatus: targetStatus });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Lambda invocation failed", details: errorMessage },
      { status: 500 }
    );
  }
}
