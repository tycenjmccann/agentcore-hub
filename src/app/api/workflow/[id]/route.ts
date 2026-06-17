/**
 * DELETE /api/workflow/[id]
 *
 * Permanently deletes a workflow and all its events.
 * Only allowed for workflows in terminal states (complete, error, cancelled).
 * Does NOT make any Jira API calls.
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
    // 1. Read current workflow
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

    // 2. Terminal state guard — only allow deleting terminal workflows
    if (!TERMINAL_PHASES.includes(workflow.phase as typeof TERMINAL_PHASES[number])) {
      return NextResponse.json(
        {
          error: "Workflow must be in a terminal state to delete",
          phase: workflow.phase,
        },
        { status: 409 }
      );
    }

    // 3. Delete the workflow row
    await ddb.send(
      new DeleteCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
      })
    );

    // 4. Query all events for this workflow (paginate)
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    const allEventKeys: Array<{ workflowId: string; eventId: string }> = [];

    do {
      const queryResult = await ddb.send(
        new QueryCommand({
          TableName: EVENTS_TABLE,
          KeyConditionExpression: "workflowId = :wfId",
          ExpressionAttributeValues: { ":wfId": workflowId },
          ProjectionExpression: "workflowId, eventId",
          ExclusiveStartKey: lastEvaluatedKey,
        })
      );

      if (queryResult.Items) {
        for (const item of queryResult.Items) {
          allEventKeys.push({
            workflowId: item.workflowId as string,
            eventId: item.eventId as string,
          });
        }
      }

      lastEvaluatedKey = queryResult.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastEvaluatedKey);

    // 5. Batch-delete all events (DynamoDB 25-item batch limit)
    const BATCH_SIZE = 25;
    for (let i = 0; i < allEventKeys.length; i += BATCH_SIZE) {
      const batch = allEventKeys.slice(i, i + BATCH_SIZE);
      await ddb.send(
        new BatchWriteCommand({
          RequestItems: {
            [EVENTS_TABLE]: batch.map((key) => ({
              DeleteRequest: { Key: key },
            })),
          },
        })
      );
    }

    console.log(
      `[delete] Workflow ${workflowId} deleted. Removed ${allEventKeys.length} events.`
    );

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err) {
    console.error("[delete] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
