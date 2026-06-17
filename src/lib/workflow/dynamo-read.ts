/**
 * DynamoDB read helpers for the event-driven workflow.
 * Used by the list, state, and tickets API endpoints.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand, BatchGetCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-1";
const TICKETS_TABLE = process.env.TICKETS_TABLE || "agentcore-hub-tickets";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export async function listWorkflowsFromDynamo(options?: { includeArchived?: boolean }) {
  // Paginate to get all workflows (table is small, <200 items)
  let items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(new ScanCommand({
      TableName: WORKFLOWS_TABLE,
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  // Sort by startedAt descending
  items.sort((a, b) => new Date(b.startedAt as string).getTime() - new Date(a.startedAt as string).getTime());

  // Filter out archived workflows unless includeArchived is true
  if (!options?.includeArchived) {
    items = items.filter(item => item.archived !== true);
  }

  return items.slice(0, 50);
}

export async function getWorkflowFromDynamo(workflowId: string) {
  const result = await ddb.send(new GetCommand({
    TableName: WORKFLOWS_TABLE,
    Key: { workflowId },
  }));
  return result.Item || null;
}

export async function getTicketsForWorkflowFromDynamo(workflowId: string) {
  // Query tickets by workflowId using a scan with filter (no GSI yet)
  const result = await ddb.send(new ScanCommand({
    TableName: TICKETS_TABLE,
    FilterExpression: "workflowId = :wid",
    ExpressionAttributeValues: { ":wid": workflowId },
  }));
  return (result.Items || []).filter(t => t.ticketId !== "__COUNTER__");
}

export async function getTicketsByIds(ticketIds: string[]) {
  if (ticketIds.length === 0) return [];
  // BatchGet supports max 100 keys at a time
  const chunks = [];
  for (let i = 0; i < ticketIds.length; i += 100) {
    chunks.push(ticketIds.slice(i, i + 100));
  }
  const items: Record<string, unknown>[] = [];
  for (const chunk of chunks) {
    const result = await ddb.send(new BatchGetCommand({
      RequestItems: {
        [TICKETS_TABLE]: {
          Keys: chunk.map(id => ({ ticketId: id })),
        },
      },
    }));
    items.push(...(result.Responses?.[TICKETS_TABLE] || []));
  }
  return items.filter(t => t.ticketId !== "__COUNTER__");
}
