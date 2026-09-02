/**
 * Invocation leases — orchestrator (Lambda) port of src/lib/workflow/lease.ts.
 *
 * TEAM-3618: hand-port of isLeaseLive / lastAgentActivity / stealClaim with
 * IDENTICAL semantics to the app-side module (R3 of docs/race-condition-study.md
 * — never re-implement lease semantics). The parity contract test
 * (src/lib/workflow/lease-parity.test.ts) feeds identical fixtures through both
 * copies of isLeaseLive and asserts identical booleans.
 *
 * Both copies read the SAME constants file (src/config/lease-constants.json) —
 * one source of truth, no forked values. In the repo it lives two directories
 * up; the orchestrator deploy zip (deploy.sh) copies it in beside this module,
 * so the deployed copy is preferred and the repo path is the fallback.
 */

import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

function loadLeaseConstants() {
  const candidates = ["./lease-constants.json", "../../src/config/lease-constants.json"];
  let lastErr;
  for (const rel of candidates) {
    try {
      return JSON.parse(readFileSync(join(HERE, rel), "utf8"));
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`lease-constants.json not found (tried ${candidates.join(", ")}): ${lastErr?.message}`);
}

const { defaultTtlMinutes, staleClaimMultiplier, heartbeatEventTypes, liveClaimStatuses } = loadLeaseConstants();
const [HEARTBEAT_TYPE_1, HEARTBEAT_TYPE_2] = heartbeatEventTypes;

// Re-exported for the orchestrator's claim-stale escape hatch
// (index.mjs claimTicketInvocation), so it reads the same knob + multiple as
// the lease-aware endpoints instead of re-hardcoding them.
export const DEFAULT_TTL_MINUTES = defaultTtlMinutes;
export const STALE_CLAIM_MULTIPLIER = staleClaimMultiplier;

/** A nonnumeric/zero/negative env value must not silently disable leases. */
function resolveTtlMs() {
  const minutes = Number(process.env.WORKFLOW_LEASE_TTL_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : defaultTtlMinutes) * 60_000;
}

export const LEASE_TTL_MS = resolveTtlMs();

/**
 * Pure liveness check. A claim is live when it is running AND the newer of
 * (claim start, last observed agent activity) is within the TTL.
 */
export function isLeaseLive(task, lastActivityIso, nowMs, ttlMs = LEASE_TTL_MS) {
  if (!task) return false;
  if (!task.status || !liveClaimStatuses.includes(task.status)) return false;
  const started = task.startedAt ? Date.parse(task.startedAt) : 0;
  const lastActivity = lastActivityIso ? Date.parse(lastActivityIso) : 0;
  const freshest = Math.max(started, lastActivity);
  if (!freshest) return false; // no start, no activity — nothing to protect
  return nowMs - freshest < ttlMs;
}

/**
 * A recent work event this agent published for this workflow (its heartbeat).
 * Only agent.streaming/agent.started prove ongoing work — terminal events
 * (agent.error, agent.retry, workflow.*) must not renew a lease, or a crash
 * report would block recovery for a full TTL.
 * Paginates the partition with a server-side filter (heartbeat type + agentId
 * + inside the lease window) — a busy sibling agent flooding the event stream
 * can no longer push a live heartbeat past a fixed page size. The sort key is
 * eventId whose format differs per writer, so the window bound lives in the
 * filter, not the key condition; any in-window heartbeat proves liveness, so
 * the first match suffices.
 *
 * `ticketId`: when given, events stamped with a DIFFERENT ticketId are
 * ignored; unstamped events still count (older runtimes don't stamp — err on
 * protecting a possibly-live agent).
 */
export async function lastAgentActivity(ddb, eventsTable, workflowId, agentId, ticketId, ttlMs = LEASE_TTL_MS) {
  const windowStart = new Date(Date.now() - ttlMs).toISOString();
  let lastKey;
  // 20 pages × 500 scanned items bounds the read on pathological partitions
  // while covering hours of the busiest observed event volume.
  for (let page = 0; page < 20; page++) {
    const res = await ddb.send(
      new QueryCommand({
        TableName: eventsTable,
        KeyConditionExpression: "workflowId = :w",
        FilterExpression: "#t IN (:hb1, :hb2) AND detail.agentId = :aid AND #ts >= :cutoff",
        ExpressionAttributeNames: { "#t": "type", "#ts": "timestamp" },
        ExpressionAttributeValues: {
          ":w": workflowId,
          ":hb1": HEARTBEAT_TYPE_1,
          ":hb2": HEARTBEAT_TYPE_2,
          ":aid": agentId,
          ":cutoff": windowStart,
        },
        ScanIndexForward: false,
        Limit: 500,
        ExclusiveStartKey: lastKey,
      })
    );
    for (const e of res.Items || []) {
      const detail = e.detail || {};
      if (ticketId && detail.ticketId && detail.ticketId !== ticketId) continue;
      if (typeof e.timestamp === "string") return e.timestamp;
    }
    lastKey = res.LastEvaluatedKey;
    if (!lastKey) break;
  }
  return null;
}

/**
 * Atomically steal a running claim: flip status→ready ONLY IF the entry still
 * holds the generation we inspected (same startedAt, still running). One
 * winner under concurrent stealers; never clobbers a re-issued claim.
 * Returns false when the claim moved (completed, re-claimed, already stolen).
 */
export async function stealClaim(ddb, workflowsTable, workflowId, ticketId, expectedStartedAt) {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: workflowsTable,
        Key: { workflowId },
        UpdateExpression: "SET agentTasks.#tid.#st = :ready",
        ConditionExpression: expectedStartedAt
          ? "agentTasks.#tid.#st IN (:running, :inprog) AND agentTasks.#tid.startedAt = :exp"
          : "agentTasks.#tid.#st IN (:running, :inprog) AND attribute_not_exists(agentTasks.#tid.startedAt)",
        ExpressionAttributeNames: { "#tid": ticketId, "#st": "status" },
        ExpressionAttributeValues: {
          ":ready": "ready",
          ":running": liveClaimStatuses[0],
          ":inprog": liveClaimStatuses[1],
          ...(expectedStartedAt ? { ":exp": expectedStartedAt } : {}),
        },
      })
    );
    return true;
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}
