/**
 * POST /api/workflow/[id]/tickets/comment
 *
 * Add a comment to a ticket, routed through the configured ticket provider
 * (same pattern as retry/nudge). With TICKET_PROVIDER=jira the comment is
 * posted to Jira — the canonical store — instead of an unused DynamoDB shadow
 * row; otherwise it appends to the ticket's comments list in DynamoDB.
 *
 * This is the write path the Workflow Manager's watch-mode `comment`
 * intervention calls, so a comment reaches the same place a human's would.
 *
 * Body: { ticketId: string, author?: string, content: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { JiraClient } from "@/lib/workflow/jira-client";

const REGION = process.env.AWS_REGION || "us-east-1";
const TICKETS_TABLE = process.env.TICKETS_TABLE || "agentcore-hub-tickets";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const workflowId = params.id;
  const { ticketId, author, content } = await req.json().catch(() => ({}));

  if (!ticketId || typeof ticketId !== "string") {
    return NextResponse.json({ error: "ticketId is required" }, { status: 400 });
  }
  if (!content || typeof content !== "string" || !content.trim()) {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }

  const commentAuthor = typeof author === "string" && author.trim() ? author.trim() : "workflow-manager";
  const ticketProvider = process.env.TICKET_PROVIDER || "dynamodb";

  try {
    if (ticketProvider === "jira") {
      await JiraClient.fromEnv().addComment(ticketId, commentAuthor, content);
    } else {
      const comment = {
        id: `cmt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        author: commentAuthor,
        content,
        timestamp: new Date().toISOString(),
      };
      await ddb.send(new UpdateCommand({
        TableName: TICKETS_TABLE,
        Key: { ticketId },
        UpdateExpression:
          "SET comments = list_append(if_not_exists(comments, :empty), :c), updatedAt = :u",
        // The ticket must already exist — never create a shadow row.
        ConditionExpression: "attribute_exists(ticketId)",
        ExpressionAttributeValues: { ":c": [comment], ":empty": [], ":u": comment.timestamp },
      }));
    }

    return NextResponse.json({ success: true, workflowId, ticketId, provider: ticketProvider });
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      return NextResponse.json({ error: `Ticket ${ticketId} not found` }, { status: 404 });
    }
    console.error(`[comment] Error on ${workflowId}/${ticketId}:`, err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
