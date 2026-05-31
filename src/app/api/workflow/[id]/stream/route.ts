/**
 * GET /api/workflow/[id]/stream — EVENT-DRIVEN VERSION
 *
 * SSE endpoint that polls the agentcore-hub-events DynamoDB table for new events.
 * Events are written there by the EventBridge → events-writer Lambda.
 *
 * No in-process subscribers. The Next.js app is stateless.
 *
 * To switch to this version, rename this file to route.ts and delete the old one.
 */

import { NextRequest } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { transformEvent } from "@/lib/workflow/transform-event";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REGION = process.env.AWS_REGION || "us-east-1";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

// Event transformation is handled by the shared transformer in @/lib/workflow/transform-event.ts

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const workflowId = params.id;
  const encoder = new TextEncoder();
  // Allow client to specify a cursor to skip already-replayed events
  let lastEventId = req.nextUrl.searchParams.get("cursor") || "";
  let stopped = false;

  req.signal.addEventListener("abort", () => { stopped = true; });

  const stream = new ReadableStream({
    async start(controller) {
      // Send heartbeat
      controller.enqueue(encoder.encode(": heartbeat\n\n"));

      // Poll loop — check for new events every 1 second.
      // Emit a heartbeat comment every ~15s of idle time so App Runner doesn't
      // close the connection during long phase gaps (idle TCP gets killed).
      const poll = async () => {
        let tick = 0;
        while (!stopped) {
          try {
            const result = await ddb.send(new QueryCommand({
              TableName: EVENTS_TABLE,
              KeyConditionExpression: "workflowId = :wid" + (lastEventId ? " AND eventId > :eid" : ""),
              ExpressionAttributeValues: {
                ":wid": workflowId,
                ...(lastEventId ? { ":eid": lastEventId } : {}),
              },
              ScanIndexForward: true,
              Limit: 50,
            }));

            const items = result.Items || [];
            for (const item of items) {
              // Transform EventBridge event format → UI event format
              const uiEvent = transformEvent(item);
              if (uiEvent) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(uiEvent)}\n\n`));
              }
              lastEventId = item.eventId;
            }

            // Idle heartbeat every 15 ticks (~15s) keeps the connection alive
            // through App Runner's idle-connection killer.
            if (tick % 15 === 0) {
              controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
            }
            tick++;
          } catch (err) {
            // Log but don't crash — keep polling
            console.warn(`[stream] Poll error for ${workflowId}:`, (err as Error).message);
          }

          // Wait 1 second before next poll
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        controller.close();
      };

      poll().catch(() => controller.close());
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering (App Runner / nginx-style) so SSE chunks
      // reach the browser immediately instead of being held in the proxy buffer.
      "X-Accel-Buffering": "no",
      "Content-Encoding": "identity",
    },
  });
}
