/**
 * PATCH /api/workflow/[id]/archive
 *
 * Archives a workflow by setting archived=true on the DynamoDB row.
 * Idempotent: archiving an already-archived workflow returns 200.
 */

import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-1";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const workflowId = params.id;

  if (!workflowId || typeof workflowId !== "string") {
    return NextResponse.json({ error: "Invalid workflow ID" }, { status: 400 });
  }

  try {
    // 1. Confirm workflow exists with ConsistentRead
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

    // 2. Set archived = true, archivedAt = ISO timestamp (idempotent)
    const archivedAt = new Date().toISOString();
    await ddb.send(
      new UpdateCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
        UpdateExpression: "SET archived = :true, archivedAt = :ts",
        ExpressionAttributeValues: {
          ":true": true,
          ":ts": archivedAt,
        },
      })
    );

    return NextResponse.json({ status: "archived", archivedAt }, { status: 200 });
  } catch (err) {
    console.error("[archive] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
