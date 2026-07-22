/**
 * Cloud Code — DynamoDB session store.
 *
 * One row per coding conversation, keyed by sessionId (== runtimeSessionId). Each
 * row carries the owning tenantId (company) + userId (SSO subject). In no-auth
 * deploys (AUTH_MODE=none) both are "default".
 *
 * Reads are scoped by tenant: listSessions filters a Scan by tenantId, and
 * request handlers must use getOwnedSession (point read + tenant check) so a
 * probe cannot touch another tenant's session. A Scan→Query re-key (PK=TENANT#…)
 * is a later infra step; filtering here first makes the access surface
 * tenant-safe before the key change lands. sessionIds are unguessable UUIDs, but
 * the tenant check is the actual boundary — not the id space.
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
import { DEFAULT_USER_ID, DEFAULT_TENANT_ID } from "@/lib/auth/identity";

export { DEFAULT_USER_ID, DEFAULT_TENANT_ID } from "@/lib/auth/identity";

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE = process.env.CLOUD_CODE_TABLE || "agentcore-hub-cloud-code-sessions";

/** Tenant a row belongs to, tolerating legacy rows written before tenantId. */
function tenantOf(s: CloudCodeSession): string {
  return s.tenantId || DEFAULT_TENANT_ID;
}

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

/**
 * Raw point read by id. Does NOT enforce ownership — request handlers MUST use
 * getOwnedSession instead. Reserved for internal/system paths that re-key by the
 * same id they were handed (e.g. a read-modify-write on a row already owned).
 */
export async function getSession(sessionId: string): Promise<CloudCodeSession | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { sessionId }, ConsistentRead: true })
  );
  return (res.Item as CloudCodeSession) || null;
}

/**
 * Tenant-checked point read for request handlers. Returns null when the row is
 * missing OR belongs to another tenant — callers map both to 404 so a probe
 * cannot distinguish "exists elsewhere" from "doesn't exist".
 */
export async function getOwnedSession(
  sessionId: string,
  tenantId: string
): Promise<CloudCodeSession | null> {
  const s = await getSession(sessionId);
  if (!s) return null;
  if (tenantOf(s) !== tenantId) return null;
  return s;
}

export async function putSession(session: CloudCodeSession): Promise<void> {
  // Always stamp a tenant so tenant-scoped reads find the row. New rows get their
  // real tenant from the route; this backstops any path that builds a session
  // without one (and re-stamps legacy rows on rewrite).
  if (!session.tenantId) session.tenantId = DEFAULT_TENANT_ID;
  await ddb.send(new PutCommand({ TableName: TABLE, Item: session }));
}

export async function deleteSession(sessionId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { sessionId } }));
}

/**
 * List a tenant's sessions for the sidebar. Scoped by tenantId (the company),
 * NOT userId — colleagues in the same tenant share a workspace by design; the
 * cross-tenant boundary is the security one.
 */
export async function listSessions(
  tenantId: string = DEFAULT_TENANT_ID
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
    .filter((s) => tenantOf(s) === tenantId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map((s) => ({
      sessionId: s.sessionId,
      tenantId: tenantOf(s),
      title: s.title,
      cli: s.cli,
      repo: s.repo,
      defaultView: s.defaultView,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      warmth: warmthOf(s.updatedAt),
    }));
}
