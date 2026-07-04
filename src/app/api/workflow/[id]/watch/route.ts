/**
 * GET  /api/workflow/[id]/watch  → { watch: boolean }
 * PATCH /api/workflow/[id]/watch  { watch: boolean } → toggle Workflow Manager
 *        watchdog for this run.
 *
 * managerWatch defaults to on (undefined === watched). Setting false opts a run
 * out of the 5-minute stale-run scan.
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

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const wf = await ddb.send(new GetCommand({
    TableName: WORKFLOWS_TABLE,
    Key: { workflowId: params.id },
    ProjectionExpression: "managerWatch",
  }));
  if (!wf.Item) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  return NextResponse.json({ watch: wf.Item.managerWatch !== false });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const workflowId = params.id;
  try {
    const { watch } = await req.json();
    if (typeof watch !== "boolean") {
      return NextResponse.json({ error: "watch (boolean) is required" }, { status: 400 });
    }
    await ddb.send(new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
      UpdateExpression: "SET managerWatch = :w",
      ConditionExpression: "attribute_exists(workflowId)",
      ExpressionAttributeValues: { ":w": watch },
    }));
    return NextResponse.json({ workflowId, watch });
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[watch] ${workflowId}:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
