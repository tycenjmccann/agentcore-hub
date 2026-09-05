/**
 * PATCH /api/workflow/[id]/archive
 *
 * Archives a workflow by setting archived=true on the DynamoDB row.
 * Idempotent: archiving an already-archived workflow returns 200.
 */

import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { setArchived } from "@/lib/workflow/workflow-store";

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

    // 2. Refuse to archive a still-running workflow — archiving hides it while
    //    its agents keep working. Only terminal states may be archived.
    const phase = wfResult.Item.phase as string | undefined;
    const TERMINAL = ["complete", "error", "cancelled"];
    const alreadyArchived = wfResult.Item.archived === true;
    if (phase && !TERMINAL.includes(phase) && !alreadyArchived) {
      return NextResponse.json(
        { error: `Cannot archive a running workflow (phase: ${phase}). Cancel it first.` },
        { status: 409 }
      );
    }

    // 3. Set archived = true, archivedAt = ISO timestamp (idempotent)
    const archivedAt = new Date().toISOString();
    await setArchived(workflowId, archivedAt);

    return NextResponse.json({ status: "archived", archivedAt }, { status: 200 });
  } catch (err) {
    console.error("[archive] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
