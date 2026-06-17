import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, DeleteCommand, QueryCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";

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
    return NextResponse.json(
      { error: "Invalid workflow ID" },
      { status: 400 }
    );
  }

  try {
    // 1. Read current workflow with ConsistentRead
    const wfResult = await ddb.send(
      new GetCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
        ConsistentRead: true,
      })
    );

    if (!wfResult.Item) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const workflow = wfResult.Item;

    // 2. Guard: only allow deletion for terminal phases
    if (!TERMINAL_PHASES.includes(workflow.phase as typeof TERMINAL_PHASES[number])) {
      return NextResponse.json(
        {
          error: "Workflow must be in terminal state to delete",
          phase: workflow.phase,
        },
        { status: 409 }
      );
    }

    // 3. Delete the workflow item
    await ddb.send(
      new DeleteCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
      })
    );

    // 4. Delete associated events
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    do {
      const eventsResult = await ddb.send(
        new QueryCommand({
          TableName: EVENTS_TABLE,
          KeyConditionExpression: "workflowId = :wid",
          ExpressionAttributeValues: { ":wid": workflowId },
          ProjectionExpression: "workflowId, eventId",
          ExclusiveStartKey: lastEvaluatedKey,
        })
      );

      const items = eventsResult.Items || [];
      lastEvaluatedKey = eventsResult.LastEvaluatedKey as Record<string, unknown> | undefined;

      // Batch delete in groups of 25
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        await ddb.send(
          new BatchWriteCommand({
            RequestItems: {
              [EVENTS_TABLE]: batch.map((item) => ({
                DeleteRequest: {
                  Key: { workflowId: item.workflowId, eventId: item.eventId },
                },
              })),
            },
          })
        );
      }
    } while (lastEvaluatedKey);

    return NextResponse.json({ status: "deleted" }, { status: 200 });
  } catch (err) {
    console.error("[delete] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
