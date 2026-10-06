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
 * unparkTicket / PARK_CLEAR_WRITES (separate deployables, so it is copied);
 * park-parity.test.ts pins every update expression and condition to the store's text.
 */

import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

/**
 * The ONE human clear — a text-identical mirror of PARK_CLEAR_WRITES in
 * lambda/orchestrator/workflow-store.mjs (separate deployables), pinned by
 * park-parity.test.ts. Two scoped writes because a REMOVE through a missing map is
 * a DynamoDB ValidationException; the legacy deadSessionRetries leaf is cleared too
 * (TEAM-5345 F3), since the store reads max(redispatchCounts, deadSessionRetries).
 */
export const PARK_CLEAR_WRITES: ReadonlyArray<{ update: string; condition: string }> = [
  { update: "REMOVE deadSessionRetries.#t", condition: "attribute_exists(deadSessionRetries)" },
  { update: "REMOVE parkedTickets.#t, redispatchCounts.#t", condition: "attribute_exists(parkedTickets) OR attribute_exists(redispatchCounts)" },
];

/**
 * Clear a park AND the ticket's whole redispatch budget (a human decided, so the
 * next silence is a new episode). Returns false when no write landed.
 */
export async function unparkTicket(
  ddb: DynamoDBDocumentClient,
  workflowsTable: string,
  workflowId: string,
  ticketId: string
): Promise<boolean> {
  let cleared = false;
  for (const w of PARK_CLEAR_WRITES) {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: workflowsTable,
          Key: { workflowId },
          UpdateExpression: w.update,
          ConditionExpression: w.condition,
          ExpressionAttributeNames: { "#t": ticketId },
        })
      );
      cleared = true;
    } catch (err) {
      if ((err as { name?: string })?.name !== "ConditionalCheckFailedException") throw err;
    }
  }
  return cleared;
}

/** Is `ticketId` parked on this workflow row? Pure. */
export function isParked(row: { parkedTickets?: Record<string, unknown> } | null | undefined, ticketId: string): boolean {
  return Boolean(row?.parkedTickets && Object.prototype.hasOwnProperty.call(row.parkedTickets, ticketId));
}
