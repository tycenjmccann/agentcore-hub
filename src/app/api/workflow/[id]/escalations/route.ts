/**
 * GET   /api/workflow/[id]/escalations → { escalations: [...] } (open first)
 * PATCH /api/workflow/[id]/escalations { notificationId } → acknowledge one
 *       manager escalation (or all open ones when notificationId is omitted).
 *
 * An open (unacknowledged) manager_escalation is a human gate: the Workflow
 * Manager watch scheduler skips the run while one exists. Resolving it here —
 * via the Telegram "Resolved" button or the UI — is what puts the run back
 * under watch. There is no other unmute path by design.
 *
 * TEAM-4099 F6: the PATCH used to read `humanNotifications`, mutate the array in
 * memory and write the whole list back, so any notification appended in that gap
 * (an orchestrator escalation, a review_needed) was silently deleted — an open
 * human gate that vanishes is a run nobody knows is stuck. The ack is now
 * per-index and conditional, in workflow-store.ackNotifications.
 */

import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ackNotifications } from "@/lib/workflow/workflow-store";

const REGION = process.env.AWS_REGION || "us-east-1";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export const dynamic = "force-dynamic";

type Notification = {
  id?: string;
  type?: string;
  acknowledged?: boolean;
  [key: string]: unknown;
};

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const wf = await ddb.send(new GetCommand({
    TableName: WORKFLOWS_TABLE,
    Key: { workflowId: params.id },
    ProjectionExpression: "humanNotifications",
  }));
  if (!wf.Item) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  const escalations = ((wf.Item.humanNotifications || []) as Notification[])
    .filter((n) => n?.type === "manager_escalation")
    .sort((a, b) => Number(Boolean(a.acknowledged)) - Number(Boolean(b.acknowledged)));
  return NextResponse.json({ escalations });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const workflowId = params.id;
  let notificationId: string | undefined;
  try {
    const body = await req.json();
    if (typeof body?.notificationId === "string") notificationId = body.notificationId;
  } catch {
    /* no body = resolve all open escalations */
  }

  try {
    const wf = await ddb.send(new GetCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
      ProjectionExpression: "humanNotifications",
    }));
    if (!wf.Item) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });

    // One scoped, conditional write per matching notification — the store
    // re-reads the list itself so the indices it writes are the ones it matched.
    const { acknowledged, skipped } = await ackNotifications(
      workflowId,
      (n) => n?.type === "manager_escalation" && (!notificationId || n.id === notificationId)
    );
    if (skipped.length) {
      console.warn(
        `[escalations] ${workflowId}: ${skipped.length} escalation(s) not acknowledged ` +
          `(no id, or the notification list moved): ${skipped.join(", ")}`
      );
    }
    return NextResponse.json({ workflowId, resolved: acknowledged });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[escalations] ${workflowId}:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
