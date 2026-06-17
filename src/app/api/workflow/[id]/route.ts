/**
 * DELETE /api/workflow/[id]
 *
 * Permanently deletes a workflow and all its events from DynamoDB.
 * Only workflows in terminal states (complete, error, cancelled) can be deleted.
 * Does NOT delete underlying Jira epic/tickets — only hub records.
 */

import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  DeleteCommand,
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
    return NextResponse.json(
      { error: "Invalid workflow ID" },
      { status: 400 }
    );
  }

  try {
    // 1. Fetch workflow and return 404 if missing
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

    // 2. Return 409 if workflow is NOT in a terminal phase
    if (!TERMINAL_PHASES.includes(workflow.phase as typeof TERMINAL_PHASES[number])) {
      return NextResponse.json(
        {
          error: "Cannot delete a workflow that is still running",
          phase: workflow.phase,
        },
        { status: 409 }
      );
    }

    // 3. Query all events for this workflow, paginating with LastEvaluatedKey
    const allEvents: Array<{ workflowId: string; eventId: string }> = [];
    let lastKey: Record<string, unknown> | undefined;

    do {
      const queryResult = await ddb.send(
        new QueryCommand({
          TableName: EVENTS_TABLE,
          KeyConditionExpression: "workflowId = :wid",
          ExpressionAttributeValues: { ":wid": workflowId },
          ProjectionExpression: "workflowId, eventId",
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        })
      );

      if (queryResult.Items) {
        allEvents.push(
          ...queryResult.Items.map((item) => ({
            workflowId: item.workflowId as string,
            eventId: item.eventId as string,
          }))
        );
      }

      lastKey = queryResult.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);

    // 4. Batch-delete all events in chunks of 25 (DynamoDB limit)
    for (let i = 0; i < allEvents.length; i += 25) {
      const batch = allEvents.slice(i, i + 25);
      await ddb.send(
        new BatchWriteCommand({
          RequestItems: {
            [EVENTS_TABLE]: batch.map((event) => ({
              DeleteRequest: {
                Key: {
                  workflowId: event.workflowId,
                  eventId: event.eventId,
                },
              },
            })),
          },
        })
      );
    }

    // 5. Delete the workflow row
    await ddb.send(
      new DeleteCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
      })
    );

    // 6. Return 200 with { deleted: true }
    return NextResponse.json({ deleted: true }, { status: 200 });
  } catch (err) {
    console.error("[delete-workflow] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
