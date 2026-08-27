/**
 * Events Writer Lambda — Writes EventBridge events to DynamoDB for dashboard polling.
 * Triggered by EventBridge rule matching agentcore-hub.orchestrator and agentcore-hub.agent-invoker events.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-1";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

// ─── Monotonic Event ID Generator ────────────────────────────────────────────
// Produces IDs that sort lexicographically in creation order, even within the
// same millisecond. Format: <timestamp-ms-base36>-<counter-base36-padded>
// e.g. "lq7k2x00-0001"  (timestamp part is always 8+ chars, counter is 4 chars)
//
// Within a single Lambda invocation (warm container), the counter increments
// monotonically. Across cold starts the timestamp advances, resetting the counter.
let lastTs = 0;
let counter = 0;

function nextEventId() {
  const now = Date.now();
  if (now === lastTs) {
    counter++;
  } else {
    lastTs = now;
    counter = 0;
  }
  const tsPart = now.toString(36).padStart(9, "0");
  const seqPart = counter.toString(36).padStart(4, "0");
  return `${tsPart}-${seqPart}`;
}

export const handler = async (event) => {
  const detail = event.detail || {};
  const workflowId = detail.workflowId || detail.ticketId || "unknown";

  await ddb.send(new PutCommand({
    TableName: EVENTS_TABLE,
    Item: {
      workflowId,
      eventId: nextEventId(),
      type: event["detail-type"] || "unknown",
      source: event.source,
      detail,
      // Prefer the publisher's own timestamp (publishEvent stamps it into
      // detail and uses the SAME value on its direct DDB write): the
      // anomaly-watcher dedupes the two copies by timestamp, and EventBridge's
      // event.time is a different, second-granularity value.
      timestamp: detail.timestamp || event.time || new Date().toISOString(),
    },
  }));
};
