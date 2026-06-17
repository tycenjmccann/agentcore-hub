/**
 * DELETE /api/workflow/[id]
 *
 * Deletes a workflow record and all its associated events from DynamoDB.
 * Only workflows in terminal states (complete, error, cancelled) can be deleted.
 */

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

const TERMINAL_PHASES = ["complete", "error", "cancelled"];

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export const dynamic = "force-dynamic";

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const id = params.id;

  try {
    // 1. Get workflow record
    const wfResult = await ddb.send(
      new GetCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId: id },
      })
    );

    if (!wfResult.Item) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    // 2. Check workflow is in terminal state
    if (!TERMINAL_PHASES.includes(wfResult.Item.phase)) {
      return NextResponse.json(
        { error: "Cannot delete a running workflow" },
        { status: 409 }
      );
    }

    // 3. Query all events for this workflow (paginate)
    const eventKeys: Array<{ workflowId: string; eventId: string }> = [];
    let exclusiveStartKey: Record<string, unknown> | undefined = undefined;

    do {
      const queryResult = await ddb.send(
        new QueryCommand({
          TableName: EVENTS_TABLE,
          KeyConditionExpression: "workflowId = :wid",
          ExpressionAttributeValues: { ":wid": id },
          ExclusiveStartKey: exclusiveStartKey,
          ProjectionExpression: "workflowId, eventId",
        })
      );

      if (queryResult.Items) {
        for (const item of queryResult.Items) {
          eventKeys.push({
            workflowId: item.workflowId,
            eventId: item.eventId,
          });
        }
      }

      exclusiveStartKey = queryResult.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);

    // 4. Batch delete events (25-item DynamoDB batch limit)
    const BATCH_SIZE = 25;
    for (let i = 0; i < eventKeys.length; i += BATCH_SIZE) {
      const chunk = eventKeys.slice(i, i + BATCH_SIZE);
      await ddb.send(
        new BatchWriteCommand({
          RequestItems: {
            [EVENTS_TABLE]: chunk.map((key) => ({
              DeleteRequest: {
                Key: key,
              },
            })),
          },
        })
      );
    }

    // 5. Delete the workflow record
    await ddb.send(
      new DeleteCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId: id },
      })
    );

    return NextResponse.json(
      { deleted: true, workflowId: id },
      { status: 200 }
    );
  } catch (err) {
    console.error("[delete] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
