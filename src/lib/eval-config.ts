import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE = process.env.EVAL_CONFIG_TABLE || "agentcore-hub-eval-config";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export async function getAllEvalConfigs() {
  let items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(new ScanCommand({
      TableName: TABLE,
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

export async function getEvalConfig(agentId: string) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { agentId },
  }));
  return result.Item || null;
}

export async function updateEvalConfig(agentId: string, updates: Record<string, unknown>) {
  const keys = Object.keys(updates);
  if (keys.length === 0) return;

  const expressionParts: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  for (const key of keys) {
    const safeKey = `#${key}`;
    const safeVal = `:${key}`;
    expressionParts.push(`${safeKey} = ${safeVal}`);
    names[safeKey] = key;
    values[safeVal] = updates[key];
  }

  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { agentId },
    UpdateExpression: `SET ${expressionParts.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

export async function clearSessionBuffer(agentId: string, lastFlushedAt: string) {
  // bufferSessions (the distinct-run set the packager flushes on) must reset
  // with the buffer. Leaving it behind keeps the run count >= batchSize, so
  // the very next log delivery re-triggers an auto-flush with a near-empty
  // buffer — flushes every few minutes instead of every batchSize runs.
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { agentId },
    UpdateExpression: "SET #buf = :empty, #lf = :lf REMOVE bufferSessions",
    ExpressionAttributeNames: {
      "#buf": "sessionBuffer",
      "#lf": "lastFlushedAt",
    },
    ExpressionAttributeValues: {
      ":empty": [],
      ":lf": lastFlushedAt,
    },
  }));
}

/**
 * Distinct runs currently buffered — the count the packager compares to
 * batchSize. sessionBuffer.length counts log DELIVERIES, not runs, and one
 * delivery can carry many runs (or one run many deliveries).
 */
export function bufferRunCount(item: Record<string, unknown>): number {
  const runs = item.bufferSessions;
  if (runs instanceof Set) return runs.size;
  if (Array.isArray(runs)) return runs.length;
  return 0;
}
