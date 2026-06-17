import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  DeleteCommand,
  QueryCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-1";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";

const TERMINAL_PHASES = ["complete", "error", "cancelled"] as const;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export const dynamic = "force-dynamic";

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const workflowId = params.id;

  if (!workflowId || typeof workflowId !== "string") {
    return NextResponse.json({ error: "Invalid workflow ID" }, { status: 400 });
  }

  try {
    const wfResult = await ddb.send(
      new GetCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
        ConsistentRead: true,
      })
    );

    if (!wfResult.Item) {
      return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    }

    const workflow = wfResult.Item;

    if (!TERMINAL_PHASES.includes(workflow.phase as typeof TERMINAL_PHASES[number])) {
      return NextResponse.json(
        { error: "Cannot delete a running workflow" },
        { status: 409 }
      );
    }

    try {
      const eventsResult = await ddb.send(
        new QueryCommand({
          TableName: EVENTS_TABLE,
          KeyConditionExpression: "workflowId = :wid",
          ExpressionAttributeValues: { ":wid": workflowId },
        })
      );
      const events = eventsResult.Items || [];
      for (let i = 0; i < events.length; i += 25) {
        const batch = events.slice(i, i + 25);
        await ddb.send(
          new BatchWriteCommand({
            RequestItems: {
              [EVENTS_TABLE]: batch.map((e) => ({
                DeleteRequest: {
                  Key: { workflowId: e.workflowId, eventId: e.eventId },
                },
              })),
            },
          })
        );
      }
    } catch (err) {
      console.warn("[delete] Failed to delete events:", err);
    }

    await ddb.send(
      new DeleteCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
      })
    );

    console.log(`[delete] Workflow ${workflowId} deleted (was: ${workflow.phase})`);

    return NextResponse.json({ status: "deleted" }, { status: 200 });
  } catch (err) {
    console.error("[delete] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
