/**
 * Cloud Code — DynamoDB session store.
 *
 * One row per coding conversation, keyed by sessionId (== runtimeSessionId).
 * Single-user for now: every row carries userId "default"; swap for the Cognito
 * `sub` when app-wide SSO lands (no migration — just start writing the real id
 * and filter by it).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  CloudCodeSession,
  CloudCodeSessionSummary,
  SessionWarmth,
} from "./types";

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE = process.env.CLOUD_CODE_TABLE || "agentcore-hub-cloud-code-sessions";

export const DEFAULT_USER_ID = "default";

// Warmth thresholds (ms since last activity). The coding runtime idles a session
// out at 1800s; mark idle well before that and cold past it.
const WARM_MS = 5 * 60_000;
const IDLE_MS = 30 * 60_000;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

function warmthOf(updatedAt: string): SessionWarmth {
  const age = Date.now() - new Date(updatedAt).getTime();
  if (age <= WARM_MS) return "warm";
  if (age <= IDLE_MS) return "idle";
  return "cold";
}

export async function getSession(sessionId: string): Promise<CloudCodeSession | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { sessionId }, ConsistentRead: true })
  );
  return (res.Item as CloudCodeSession) || null;
}

export async function putSession(session: CloudCodeSession): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: session }));
}

export async function deleteSession(sessionId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { sessionId } }));
}

export async function listSessions(
  userId: string = DEFAULT_USER_ID
): Promise<CloudCodeSessionSummary[]> {
  const items: CloudCodeSession[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({ TableName: TABLE, ExclusiveStartKey: lastKey })
    );
    items.push(...((res.Items as CloudCodeSession[]) || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  return items
    // Exclude non-session rows that share this table (e.g. config:{userId}
    // metadata written by the config-bundle store) — they have no turns/cli.
    .filter((s) => !String(s.sessionId).startsWith("config:") && s.cli)
    .filter((s) => (s.userId || DEFAULT_USER_ID) === userId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map((s) => ({
      sessionId: s.sessionId,
      title: s.title,
      cli: s.cli,
      repo: s.repo,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      warmth: warmthOf(s.updatedAt),
    }));
}
