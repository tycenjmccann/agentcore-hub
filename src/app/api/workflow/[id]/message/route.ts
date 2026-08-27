/**
 * POST /api/workflow/[id]/message — queue an operator message for a running agent.
 *
 * Claude Code-style mid-flow messaging: the message is written to a mailbox
 * item in the events table and the persona runtime picks it up at its next
 * tool-call boundary (AfterToolCall hook), injecting it into the agent's
 * conversation. The runtime publishes an agent.streaming ack when consumed,
 * so delivery is visible in the agent's output stream.
 *
 * Mailbox items use the eventId prefix "0#mailbox#" — "0" sorts before every
 * timestamp-based eventId, so the live stream's cursor (eventId > :cursor)
 * never re-reads them, and transformEvent hides them from replay.
 */

import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

export const dynamic = "force-dynamic";

const REGION = process.env.AWS_REGION || "us-east-1";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";

const MAX_MESSAGE_CHARS = 4000;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const workflowId = params.id;

  let body: { agentId?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const agentId = (body.agentId || "").trim();
  const message = (body.message || "").trim();
  if (!agentId || !message) {
    return NextResponse.json(
      { error: "agentId and message are required" },
      { status: 400 }
    );
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return NextResponse.json(
      { error: `Message too long (max ${MAX_MESSAGE_CHARS} chars)` },
      { status: 400 }
    );
  }

  // One item per message: consumption is an atomic DeleteItem on the runtime
  // side, so concurrent sends never clobber each other.
  const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await ddb.send(
    new PutCommand({
      TableName: EVENTS_TABLE,
      Item: {
        workflowId,
        eventId: `0#mailbox#${agentId}#${messageId}`,
        type: "operator.message",
        detail: {
          agentId,
          message,
          queuedAt: new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
      },
    })
  );

  return NextResponse.json({
    queued: true,
    messageId,
    note: "Delivered to the agent at its next tool-call boundary.",
  });
}
