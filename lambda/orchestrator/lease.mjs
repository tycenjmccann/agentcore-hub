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

const { defaultTtlMinutes, staleClaimMultiplier, stallSoftTimeoutMs, heartbeatEventTypes, liveClaimStatuses } = loadLeaseConstants();
const [HEARTBEAT_TYPE_1, HEARTBEAT_TYPE_2] = heartbeatEventTypes;

// The absolute no-heartbeat soft-timeout (TEAM-3992 D4.3). A claim can sit
// inside its lease TTL yet emit no stream/tool heartbeat for a long time (a hung
// tool call, a wedged coding turn) — the lease TTL alone would protect it for up
// to 30 min. This is the tighter, activity-based window after which the sweep
// begins confirming death. Shared with the UI (src/lib/workflow/stale.ts caps
// the claude_code stale threshold at this same value) so board and detector agree.
export const STALL_SOFT_TIMEOUT_MS = stallSoftTimeoutMs;

// Re-exported for the orchestrator's claim-stale escape hatch
// (index.mjs claimTicketInvocation), so it reads the same knob + multiple as
// the lease-aware endpoints instead of re-hardcoding them.
export const DEFAULT_TTL_MINUTES = defaultTtlMinutes;
export const STALE_CLAIM_MULTIPLIER = staleClaimMultiplier;

// The claim statuses that hold a lease, straight from lease-constants.json
// (TEAM-3991 D2.2). Exported so a caller that needs to know "is this task's claim
// still live enough to be worth parking?" reads the same list isLeaseLive does,
// instead of re-hardcoding ["running","in_progress"]. NOT a liveness check — the
// authoritative CAS still lives in workflow-store.parkClaim / lease.stealClaim.
export const LIVE_CLAIM_STATUSES = Object.freeze([...liveClaimStatuses]);

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
 * Absolute stall verdict (TEAM-3992 D4.3) — a pure REFINEMENT of isLeaseLive that
 * adds the activity-based soft-timeout on top of the TTL. isLeaseLive is left
 * byte-identical (R3): this composes it, never re-derives it.
 *
 *   "live"       — the lease is live per TTL AND the newest of (stream/tool
 *                  activity, OTEL span activity) is within softTimeoutMs.
 *   "soft-stale" — the lease is live per TTL but there has been NO stream/tool
 *                  heartbeat for >= softTimeoutMs, and OTEL is UNKNOWN (not yet
 *                  queried). This is the "needs confirmation" state: the caller
 *                  runs an OTEL span query and re-verdicts with the result.
 *   "stale"      — the lease is not live per TTL, OR silence >= softTimeoutMs and
 *                  death is confirmed: OTEL was queried and found no (recent)
 *                  span, OR the absolute hard ceiling (hardTimeoutMs, default
 *                  2× soft) has passed even without OTEL confirmation.
 *
 * `otelActivityIso` sentinel — the caller MUST distinguish these three:
 *   undefined = OTEL not queried / unknown (OTEL_ACTIVITY_CONFIRM off, over
 *               budget, query error/timeout) → yields soft-stale (below the hard
 *               ceiling) so the conservative default never steals on silence
 *               alone.
 *   null      = OTEL queried successfully, found NO span → confirmed dead.
 *   string    = the newest span's ISO timestamp → renews liveness if recent.
 */
export function leaseVerdict(task, lastActivityIso, otelActivityIso, nowMs, opts = {}) {
  const ttlMs = opts.ttlMs ?? LEASE_TTL_MS;
  const softTimeoutMs = opts.softTimeoutMs ?? STALL_SOFT_TIMEOUT_MS;
  const hardTimeoutMs = opts.hardTimeoutMs ?? 2 * softTimeoutMs;

  // TTL is the outer bound (R3): a claim past its lease TTL is unconditionally
  // stale, regardless of any soft-timeout refinement.
  if (!isLeaseLive(task, lastActivityIso, nowMs, ttlMs)) return "stale";

  // Heartbeat silence: now minus the newest of (claim start, stream/tool activity).
  const started = task.startedAt ? Date.parse(task.startedAt) : 0;
  const lastActivity = lastActivityIso ? Date.parse(lastActivityIso) : 0;
  const silence = nowMs - Math.max(started, lastActivity);

  // A fresh stream/tool heartbeat inside the soft window keeps it live.
  if (silence < softTimeoutMs) return "live";

  // No heartbeat for >= soft. Consult the OTEL span signal.
  if (typeof otelActivityIso === "string") {
    const otelMs = Date.parse(otelActivityIso);
    if (Number.isFinite(otelMs) && nowMs - otelMs < softTimeoutMs) return "live";
    return "stale"; // a span exists but is itself older than the soft window
  }
  if (otelActivityIso === null) return "stale"; // queried, confirmed no span

  // OTEL unknown (undefined): soft-stale (needs confirmation) UNLESS the
  // absolute hard ceiling has passed, at which point silence alone is enough to
  // declare death (catches an outage where OTEL confirm is off / over budget —
  // the 4v1ykk TEAM-2609 incident: >2× soft of pure silence, never confirmed).
  if (silence >= hardTimeoutMs) return "stale";
  return "soft-stale";
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
