/**
 * Routines — DynamoDB store.
 *
 * One row per routine, keyed by routineId, carrying the owning tenantId. Reads are
 * tenant-scoped exactly like the cloud-code session store (src/lib/cloud-code/
 * sessions.ts): listRoutines filters a Scan by tenantId, and request handlers use
 * getOwnedRoutine (point read + tenant check) so a probe cannot touch another
 * tenant's routine. sessionId-style unguessable ids are NOT the boundary — the
 * tenant check is.
 */

import { DynamoDBClient, ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Routine, RoutineSummary } from "./types";
import { DEFAULT_TENANT_ID } from "@/lib/auth/identity";

export { DEFAULT_USER_ID, DEFAULT_TENANT_ID } from "@/lib/auth/identity";

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE = process.env.ROUTINES_TABLE || "agentcore-hub-routines";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

function tenantOf(r: Routine): string {
  return r.tenantId || DEFAULT_TENANT_ID;
}

/** Raw point read by id. Does NOT enforce ownership — handlers use getOwnedRoutine. */
export async function getRoutine(routineId: string): Promise<Routine | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { routineId }, ConsistentRead: true })
  );
  return (res.Item as Routine) || null;
}

/**
 * Tenant-checked point read for request handlers. Returns null when the row is
 * missing OR belongs to another tenant — callers map both to 404 so a probe cannot
 * distinguish "exists elsewhere" from "doesn't exist".
 */
export async function getOwnedRoutine(
  routineId: string,
  tenantId: string
): Promise<Routine | null> {
  const r = await getRoutine(routineId);
  if (!r) return null;
  if (tenantOf(r) !== tenantId) return null;
  return r;
}

export async function putRoutine(routine: Routine): Promise<void> {
  if (!routine.tenantId) routine.tenantId = DEFAULT_TENANT_ID;
  await ddb.send(new PutCommand({ TableName: TABLE, Item: routine }));
}

/**
 * Optimistic-concurrency read-modify-write, mirroring mutateSession. `mutate`
 * edits the row in place and returns it (or null to abort the write); the Put
 * lands only if the stored `rev` still matches, retrying on conflict.
 */
export async function mutateRoutine(
  routineId: string,
  mutate: (r: Routine) => Routine | null,
  attempts = 5
): Promise<Routine | null> {
  for (let i = 0; i < attempts; i++) {
    const current = await getRoutine(routineId);
    if (!current) return null;
    const prevRev = current.rev ?? 0;
    const next = mutate(current);
    if (!next) return current;
    if (!next.tenantId) next.tenantId = DEFAULT_TENANT_ID;
    next.rev = prevRev + 1;
    try {
      await ddb.send(
        new PutCommand({
          TableName: TABLE,
          Item: next,
          ConditionExpression: "attribute_not_exists(#rev) OR #rev = :prev",
          ExpressionAttributeNames: { "#rev": "rev" },
          ExpressionAttributeValues: { ":prev": prevRev },
        })
      );
      return next;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) continue;
      throw err;
    }
  }
  throw new Error(`mutateRoutine: exhausted ${attempts} attempts on ${routineId} (write contention)`);
}

export async function deleteRoutine(routineId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { routineId } }));
}

/** List a tenant's routines, newest-updated first. Tenant-scoped (the security boundary). */
export async function listRoutines(
  tenantId: string = DEFAULT_TENANT_ID
): Promise<RoutineSummary[]> {
  const items: Routine[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({ TableName: TABLE, ExclusiveStartKey: lastKey })
    );
    items.push(...((res.Items as Routine[]) || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  return items
    .filter((r) => r.routineId && r.workflowDefId)
    .filter((r) => tenantOf(r) === tenantId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map((r) => ({
      routineId: r.routineId,
      tenantId: tenantOf(r),
      name: r.name,
      description: r.description,
      workflowDefId: r.workflowDefId,
      schedule: r.schedule,
      enabled: r.enabled,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      lastRun: r.lastRun,
    }));
}
