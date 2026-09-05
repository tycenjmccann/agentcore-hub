/**
 * Invocation leases (R3 of docs/race-condition-study.md).
 *
 * "Is the agent dead?" was guessed from silence in three places with three
 * thresholds — and retry/dispatch released the invocation claim with NO proof
 * the old session was dead. A live agent whose ticket got re-Readied means two
 * agents working the same ticket: duplicate PRs, duplicate commits.
 *
 * The lease contract, one knob (WORKFLOW_LEASE_TTL_MINUTES, default 30):
 *
 * - An agent is presumed ALIVE while its last observed activity (streaming
 *   text, tool traces, coding-turn poll heartbeats) is younger than the TTL.
 *   Runtimes stream events continuously, so a healthy long-running session
 *   keeps renewing its lease with no new write path.
 * - Stealing a running claim (retry / dispatch) is refused while the lease is
 *   live, unless the caller passes force=true after verifying death by other
 *   evidence (the WM's dossier check, a human reading the session).
 * - The steal itself is a CAS on the claim's startedAt generation — two
 *   concurrent stealers resolve to one winner, and a steal can never clobber
 *   a claim that was re-issued in between.
 * - The orchestrator's claim-stale escape hatch (crashed sessions blocking a
 *   board re-Ready) is 2× TTL on startedAt — same knob, documented multiple.
 */

import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import leaseConstants from "../../config/lease-constants.json";

// Single source of truth shared with the orchestrator Lambda (lambda/
// orchestrator/lease.mjs reads the SAME file). TEAM-3618: constants extraction
// only — the values are identical to the literals they replaced.
const { defaultTtlMinutes, stallSoftTimeoutMs, heartbeatEventTypes, liveClaimStatuses } = leaseConstants;
const [HEARTBEAT_TYPE_1, HEARTBEAT_TYPE_2] = heartbeatEventTypes;

// The absolute no-heartbeat soft-timeout (TEAM-3992 D4.3). A claim can sit
// inside its lease TTL yet emit no stream/tool heartbeat for a long time (a hung
// tool call, a wedged coding turn) — the lease TTL alone would protect it for up
// to 30 min. This is the tighter, activity-based window after which the sweep
// begins confirming death. Shared with the UI (src/lib/workflow/stale.ts caps
// the claude_code stale threshold at this same value) so board and detector agree.
export const STALL_SOFT_TIMEOUT_MS = stallSoftTimeoutMs;

/** A nonnumeric/zero/negative env value must not silently disable leases. */
function resolveTtlMs(): number {
  const minutes = Number(process.env.WORKFLOW_LEASE_TTL_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : defaultTtlMinutes) * 60_000;
}

export const LEASE_TTL_MS = resolveTtlMs();

export interface AgentTaskEntry {
  ticketId?: string;
  agentId?: string;
  status?: string;
  startedAt?: string;
}

/**
 * Pure liveness check. A claim is live when it is running AND the newer of
 * (claim start, last observed agent activity) is within the TTL.
 */
export function isLeaseLive(
  task: AgentTaskEntry | undefined,
  lastActivityIso: string | null,
  nowMs: number,
  ttlMs: number = LEASE_TTL_MS
): boolean {
  if (!task) return false;
  if (!task.status || !liveClaimStatuses.includes(task.status)) return false;
  const started = task.startedAt ? Date.parse(task.startedAt) : 0;
  const lastActivity = lastActivityIso ? Date.parse(lastActivityIso) : 0;
  const freshest = Math.max(started, lastActivity);
  if (!freshest) return false; // no start, no activity — nothing to protect
  return nowMs - freshest < ttlMs;
}

export type LeaseVerdict = "live" | "soft-stale" | "stale";

export interface LeaseVerdictOpts {
  ttlMs?: number;
  softTimeoutMs?: number;
  hardTimeoutMs?: number;
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
export function leaseVerdict(
  task: AgentTaskEntry | undefined,
  lastActivityIso: string | null,
  otelActivityIso: string | null | undefined,
  nowMs: number,
  opts: LeaseVerdictOpts = {}
): LeaseVerdict {
  const ttlMs = opts.ttlMs ?? LEASE_TTL_MS;
  const softTimeoutMs = opts.softTimeoutMs ?? STALL_SOFT_TIMEOUT_MS;
  const hardTimeoutMs = opts.hardTimeoutMs ?? 2 * softTimeoutMs;

  // TTL is the outer bound (R3): a claim past its lease TTL is unconditionally
  // stale, regardless of any soft-timeout refinement.
  if (!isLeaseLive(task, lastActivityIso, nowMs, ttlMs)) return "stale";

  // Heartbeat silence: now minus the newest of (claim start, stream/tool activity).
  const started = task!.startedAt ? Date.parse(task!.startedAt) : 0;
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
export async function lastAgentActivity(
  ddb: DynamoDBDocumentClient,
  eventsTable: string,
  workflowId: string,
  agentId: string,
  ticketId?: string,
  ttlMs: number = LEASE_TTL_MS
): Promise<string | null> {
  const windowStart = new Date(Date.now() - ttlMs).toISOString();
  let lastKey: Record<string, unknown> | undefined;
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
      const detail = (e.detail || {}) as Record<string, unknown>;
      if (ticketId && detail.ticketId && detail.ticketId !== ticketId) continue;
      if (typeof e.timestamp === "string") return e.timestamp;
    }
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
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
export async function stealClaim(
  ddb: DynamoDBDocumentClient,
  workflowsTable: string,
  workflowId: string,
  ticketId: string,
  expectedStartedAt: string | undefined
): Promise<boolean> {
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
    if ((err as Error).name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}
