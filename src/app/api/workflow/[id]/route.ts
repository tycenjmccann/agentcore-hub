/**
 * DELETE /api/workflow/[id]
 *
 * "Deletes" a terminal-state workflow: its events are removed, but the workflow
 * row itself is TOMBSTONED (deleted=true, heavy fields stripped) rather than
 * removed. Jira tickets keep `wf:<id>` labels forever; hard-deleting the row
 * broke ticket→workflow-type resolution and dashboard tickets showed as "Other".
 * Only workflows in 'complete', 'error', or 'cancelled' phase can be deleted.
 */

import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
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
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const workflowId = params.id;

  if (!workflowId || typeof workflowId !== "string") {
    return NextResponse.json({ error: "Invalid workflow ID" }, { status: 400 });
  }

  try {
    // 1. Fetch workflow with ConsistentRead
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

    // 2. Check phase — must be terminal
    if (!TERMINAL_PHASES.includes(workflow.phase as typeof TERMINAL_PHASES[number])) {
      return NextResponse.json(
        { error: "Cannot delete a running workflow", phase: workflow.phase },
        { status: 409 }
      );
    }

    // 3. Query ALL events for this workflow (paginate with LastEvaluatedKey)
    const allEventKeys: Array<{ workflowId: string; eventId: string }> = [];
    let lastKey: Record<string, unknown> | undefined;

    do {
      const result = await ddb.send(
        new QueryCommand({
          TableName: EVENTS_TABLE,
          KeyConditionExpression: "workflowId = :wid",
          ExpressionAttributeValues: { ":wid": workflowId },
          ProjectionExpression: "workflowId, eventId",
          ExclusiveStartKey: lastKey,
        })
      );

      for (const item of result.Items || []) {
        allEventKeys.push({ workflowId: item.workflowId, eventId: item.eventId });
      }
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    // 4. Batch-delete events (max 25 per BatchWriteCommand)
    let eventsDeleted = 0;
    for (let i = 0; i < allEventKeys.length; i += 25) {
      const batch = allEventKeys.slice(i, i + 25);
      await ddb.send(
        new BatchWriteCommand({
          RequestItems: {
            [EVENTS_TABLE]: batch.map((key) => ({
              DeleteRequest: { Key: key },
            })),
          },
        })
      );
      eventsDeleted += batch.length;
    }

    // 5. Tombstone the workflow row — keep just what metrics/type-resolution
    //    need; drop messages, agentTasks, and other heavy state. epicId is
    //    deliberately dropped: the epicId-index GSI is sparse, so omitting it
    //    keeps tombstones out of epic→workflow lookups (bug re-filing
    //    idempotency, orchestrator findWorkflowByEpic).
    await ddb.send(
      new PutCommand({
        TableName: WORKFLOWS_TABLE,
        Item: {
          workflowId,
          id: workflowId,
          deleted: true,
          deletedAt: new Date().toISOString(),
          phase: workflow.phase,
          workflowDefId: workflow.workflowDefId,
          startedAt: workflow.startedAt,
          completedAt: workflow.completedAt,
          ...(workflow.humanReviewMs !== undefined ? { humanReviewMs: workflow.humanReviewMs } : {}),
        },
      })
    );

    return NextResponse.json(
      { deleted: true, workflowId, eventsDeleted },
      { status: 200 }
    );
  } catch (err) {
    console.error("[delete] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
