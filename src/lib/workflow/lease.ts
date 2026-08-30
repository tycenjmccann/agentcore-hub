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
 * - An agent is presumed ALIVE while its last observed activity (any event it
 *   published: streaming text, tool traces, coding-turn poll heartbeats) is
 *   younger than the TTL. Runtimes stream events continuously, so a healthy
 *   long-running session keeps renewing its lease with no new write path.
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

export const LEASE_TTL_MS =
  Number(process.env.WORKFLOW_LEASE_TTL_MINUTES || 30) * 60_000;

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
  if (task.status !== "running" && task.status !== "in_progress") return false;
  const started = task.startedAt ? Date.parse(task.startedAt) : 0;
  const lastActivity = lastActivityIso ? Date.parse(lastActivityIso) : 0;
  const freshest = Math.max(started, lastActivity);
  if (!freshest) return false; // no start, no activity — nothing to protect
  return nowMs - freshest < ttlMs;
}

/**
 * Newest event this agent published for this workflow (its heartbeat).
 * Scans recent events newest-first; bounded page — an agent silent for longer
 * than one page of workflow events is silent, period.
 */
export async function lastAgentActivity(
  ddb: DynamoDBDocumentClient,
  eventsTable: string,
  workflowId: string,
  agentId: string
): Promise<string | null> {
  const page = await ddb.send(
    new QueryCommand({
      TableName: eventsTable,
      KeyConditionExpression: "workflowId = :w",
      ExpressionAttributeValues: { ":w": workflowId },
      ScanIndexForward: false,
      Limit: 100,
    })
  );
  for (const e of page.Items || []) {
    const detail = (e.detail || {}) as Record<string, unknown>;
    if (detail.agentId === agentId && typeof e.timestamp === "string") {
      return e.timestamp;
    }
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
          ":running": "running",
          ":inprog": "in_progress",
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
