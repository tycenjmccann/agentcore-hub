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

import { DynamoDBClient, ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
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

// Sentinel embedded in the agent turn the /stop route persists. The streaming
// /message writer checks for it on a re-read so a late stream-completion Put
// can't clobber a turn that /stop already recorded (the two writers race when a
// turn is interrupted). Keep in sync with STOP_NOTE in the stop route.
export const STOP_MARKER = "⏹ Stopped.";

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
  // A tombstoned row is deleted as far as every route is concerned — without
  // this, a bookmarked/already-open client could keep messaging or opening a
  // terminal on a session the user deleted, until the TTL actually expires.
  if (s.deletedAt) return null;
  return s;
}

export async function putSession(session: CloudCodeSession): Promise<void> {
  // Always stamp a tenant so tenant-scoped reads find the row. New rows get their
  // real tenant from the route; this backstops any path that builds a session
  // without one (and re-stamps legacy rows on rewrite).
  if (!session.tenantId) session.tenantId = DEFAULT_TENANT_ID;
  await ddb.send(new PutCommand({ TableName: TABLE, Item: session }));
}

/**
 * Optimistic-concurrency read-modify-write. Reads the row, hands it to `mutate`
 * (which edits in place and returns the row, or null to abort the write), then
 * conditionally Puts it only if the stored `rev` still matches what we read —
 * retrying the whole cycle on a version conflict. This SERIALIZES concurrent
 * writers deterministically (unlike a plain re-read, which two callers can both
 * pass before either writes). Used where the /message stream completing races
 * the /stop persist for the same interrupted turn.
 *
 * `mutate` returning null (no change needed) skips the write and returns the row.
 * Returns the row as persisted, or null if it no longer exists.
 */
export async function mutateSession(
  sessionId: string,
  mutate: (s: CloudCodeSession) => CloudCodeSession | null,
  attempts = 5
): Promise<CloudCodeSession | null> {
  for (let i = 0; i < attempts; i++) {
    const current = await getSession(sessionId);
    if (!current) return null;
    const prevRev = current.rev ?? 0;
    const next = mutate(current);
    if (!next) return current; // mutate opted out — nothing to write
    if (!next.tenantId) next.tenantId = DEFAULT_TENANT_ID;
    next.rev = prevRev + 1;
    try {
      await ddb.send(
        new PutCommand({
          TableName: TABLE,
          Item: next,
          // Land only if nobody else bumped rev since our read. attribute_not_exists
          // covers legacy rows written before rev existed (treated as rev 0).
          ConditionExpression: "attribute_not_exists(#rev) OR #rev = :prev",
          ExpressionAttributeNames: { "#rev": "rev" },
          ExpressionAttributeValues: { ":prev": prevRev },
        })
      );
      return next;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) continue; // lost the race — retry
      throw err;
    }
  }
  throw new Error(`mutateSession: exhausted ${attempts} attempts on ${sessionId} (write contention)`);
}

export async function deleteSession(sessionId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { sessionId } }));
}

// Grace before DynamoDB TTL expires a tombstoned row (and thereby triggers the
// reaper via the table stream). The row is hidden from the user the instant
// deletedAt is set; this only governs how soon the backend cleanup fires. Short
// so reclamation is prompt, but non-zero to absorb clock skew. (Actual TTL delete
// latency is best-effort — usually minutes — which is fine for storage cleanup.)
const REAP_GRACE_S = 60;

/**
 * Soft-delete: stamp the row as deleted and give it a TTL, then return. The row
 * vanishes from the user's list immediately (listSessions filters deletedAt), but
 * survives as the retry handle for backend cleanup. When DynamoDB expires it, the
 * table stream fires the reaper Lambda once — which stops the microVM + purges
 * EFS/S3. No multi-step cleanup runs in the request path, so there's no race to
 * lose: a failed cleanup just re-arms the TTL and fires again. Goes through
 * mutateSession so a concurrent turn-persist can't resurrect the row.
 */
export async function softDeleteSession(
  sessionId: string,
  tenantId: string
): Promise<boolean> {
  const owned = await getOwnedSession(sessionId, tenantId);
  if (!owned) return false; // missing or not this tenant's → no-op
  const updated = await mutateSession(sessionId, (s) => {
    s.deletedAt = new Date().toISOString();
    s.ttl = Math.floor(Date.now() / 1000) + REAP_GRACE_S;
    return s;
  });
  return Boolean(updated);
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
    // Hide soft-deleted rows: the user's delete already happened; the tombstone
    // lingers only until the reaper finishes backend cleanup.
    .filter((s) => !s.deletedAt)
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
