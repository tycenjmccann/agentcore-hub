/**
 * DL-035 park clears from the hub (TEAM-5323).
 *
 * The orchestrator parks a ticket it has given up on (redispatch cap, agent
 * BLOCKED) and its claim CAS then refuses every dispatch while
 * `parkedTickets[ticketId]` exists. Only a human decision clears that: the
 * retry route and a TARGETED nudge (`dispatch` / `unstick --ticket`). An
 * untargeted nudge never does — a scan that un-parked everything would undo the
 * cap-3 loop protection on every click.
 *
 * `unparkTicket` is a mirror of lambda/orchestrator/workflow-store.mjs
 * unparkTicket (separate deployables, so it is copied); park-parity.test.ts pins
 * the update expression and condition to the store's text.
 */

import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

/**
 * Clear a park AND the ticket's redispatch budget (a human decided, so the next
 * silence is a new episode). Returns false when the row has neither map.
 */
export async function unparkTicket(
  ddb: DynamoDBDocumentClient,
  workflowsTable: string,
  workflowId: string,
  ticketId: string
): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: workflowsTable,
        Key: { workflowId },
        UpdateExpression: "REMOVE parkedTickets.#t, redispatchCounts.#t",
        ConditionExpression: "attribute_exists(parkedTickets) OR attribute_exists(redispatchCounts)",
        ExpressionAttributeNames: { "#t": ticketId },
      })
    );
    return true;
  } catch (err) {
    if ((err as { name?: string })?.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/** Is `ticketId` parked on this workflow row? Pure. */
export function isParked(row: { parkedTickets?: Record<string, unknown> } | null | undefined, ticketId: string): boolean {
  return Boolean(row?.parkedTickets && Object.prototype.hasOwnProperty.call(row.parkedTickets, ticketId));
}
