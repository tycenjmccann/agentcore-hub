/**
 * publish-event — one workflow event to EventBridge and the events table
 * (TEAM-5399, F3 of the #807 ship review).
 *
 * PutEvents can answer 200 and still drop the entry (FailedEntryCount > 0, the
 * entry's ErrorCode set), so a caller that only awaits send() reads a lost
 * event as delivered. putBusEvent folds a throw, a failed count and an entry
 * error into one result the caller has to act on; it never throws. The events
 * table row stays best-effort (the board's poll copy), but its failure is
 * logged, not swallowed.
 */

import type { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { PutEventsCommand, type PutEventsRequestEntry } from "@aws-sdk/client-eventbridge";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";

export type BusResult = { ok: true } | { ok: false; error: string };

/** One entry to EventBridge. ok only when nothing threw, FailedEntryCount is 0 and the entry has no ErrorCode. */
export async function putBusEvent(client: EventBridgeClient, entry: PutEventsRequestEntry): Promise<BusResult> {
  let res: { FailedEntryCount?: number; Entries?: Array<{ ErrorCode?: string; ErrorMessage?: string }> } | undefined;
  try {
    res = await client.send(new PutEventsCommand({ Entries: [entry] }));
  } catch (err) {
    return failed(entry, (err as Error)?.message || String(err));
  }
  const bad = res?.Entries?.find((e) => e?.ErrorCode);
  if (bad) return failed(entry, `${bad.ErrorCode}: ${bad.ErrorMessage || "no message"}`);
  if ((res?.FailedEntryCount ?? 0) > 0) return failed(entry, `FailedEntryCount ${res?.FailedEntryCount}`);
  return { ok: true };
}

function failed(entry: PutEventsRequestEntry, error: string): BusResult {
  console.error(`[publish-event] EventBridge ${entry.DetailType} not delivered: ${error}`);
  return { ok: false, error };
}

export type WorkflowEvent = {
  eventBridge: EventBridgeClient;
  ddb: DynamoDBDocumentClient;
  eventsTable: string;
  eventBus: string;
  workflowId: string;
  detailType: string;
  detail: Record<string, unknown>;
  timestamp: string;
  /** Events-table sort key; generated when absent. */
  eventId?: string;
  /** With an eventId: the row is written once (a re-send finds it there and counts that as written). */
  idempotent?: boolean;
};

/**
 * The detail (+ timestamp) to EventBridge and the same detail to the events
 * table. Returns the bus result: that is the delivery contract.
 */
export async function publishWorkflowEvent(o: WorkflowEvent): Promise<BusResult> {
  const bus = await putBusEvent(o.eventBridge, {
    Source: "agentcore-hub.orchestrator",
    DetailType: o.detailType,
    Detail: JSON.stringify({ ...o.detail, timestamp: o.timestamp }),
    EventBusName: o.eventBus,
  });
  const once = Boolean(o.eventId && o.idempotent);
  try {
    await o.ddb.send(
      new PutCommand({
        TableName: o.eventsTable,
        Item: {
          workflowId: o.workflowId,
          eventId: o.eventId || `${Date.now()}-${o.detailType}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: o.timestamp,
          type: o.detailType,
          detail: o.detail,
        },
        ...(once ? { ConditionExpression: "attribute_not_exists(eventId)" } : {}),
      })
    );
  } catch (err) {
    const ccf = (err as { name?: string })?.name === "ConditionalCheckFailedException";
    if (!(once && ccf)) console.warn(`[publish-event] events table ${o.detailType} not written: ${(err as Error)?.message || err}`);
  }
  return bus;
}
