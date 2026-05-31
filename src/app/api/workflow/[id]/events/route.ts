/**
 * GET /api/workflow/[id]/events — Fetch ALL events for a workflow (for replay)
 *
 * Returns events as a JSON array, ordered by eventId (timestamp-based).
 * Used by the frontend to replay completed workflows with a scrubber.
 */

import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { transformEvent } from "@/lib/workflow/transform-event";

export const dynamic = "force-dynamic";

const REGION = process.env.AWS_REGION || "us-east-1";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const workflowId = params.id;
  const allEvents: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;

  // Paginate through all events
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: EVENTS_TABLE,
      KeyConditionExpression: "workflowId = :wid",
      ExpressionAttributeValues: { ":wid": workflowId },
      ScanIndexForward: true,
      ExclusiveStartKey: lastKey,
    }));

    for (const item of result.Items || []) {
      const transformed = transformEvent(item, { includeEventId: true });
      if (transformed) {
        allEvents.push(transformed);
      }
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return NextResponse.json({ events: allEvents, count: allEvents.length }, {
    headers: { "Cache-Control": "no-store" },
  });
}
