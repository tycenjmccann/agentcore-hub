/**
 * TEAM-5347 F6 — the ONE ordering for a human-driven claim release (retry, targeted
 * nudge): human gate → lease gate → un-park → steal / reset. Both routes used to
 * carry their own copy, and the nudge's cleared the park BEFORE its lease check, so
 * a 409 LEASE_LIVE came back with the DL-035 park and redispatch budget already
 * gone — the reaper could then redispatch a ticket a human never released.
 *
 *   1. assertMayUnpark — clearing a park is a human decision (TEAM-5338 F1);
 *   2. the lease gate — a RUNNING claim whose agent has been heard from inside the
 *      TTL is refused (LeaseLiveError → 409) unless `force`; nothing is written;
 *   3. un-park — only now, when the release is going through;
 *   4. a live claim is stolen under the lease CAS (one winner, never clobbers a
 *      re-issued claim); a non-running one (error, parked) has no lease and is reset
 *      to ready under a CAS on the status that was read. Either CAS losing is
 *      ClaimMovedError: the claim completed or was re-issued meanwhile.
 */

import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { isLeaseLive, lastAgentActivity, stealClaim, LEASE_TTL_MS } from "./lease";
import { unparkTicket } from "./park";
import { assertMayUnpark, type HumanIdentityResult } from "@/lib/auth/human";

export const LIVE_CLAIM_STATUSES = new Set(["running", "in_progress"]);

/** Thrown when the target's lease is live — the routes surface it as HTTP 409 LEASE_LIVE. */
export class LeaseLiveError extends Error {
  constructor(ticketId: string, agentId: string, lastActivity: string | null) {
    super(
      `Ticket ${ticketId} is held by ${agentId || "its agent"} with a LIVE lease (last activity ${lastActivity || "at claim"}, ` +
        `TTL ${Math.round(LEASE_TTL_MS / 60000)}m). It is likely still working — releasing it now would spawn a second ` +
        `agent on the same ticket (duplicate PRs). Pass force=true only with evidence the session is dead (dossier, session logs).`
    );
    this.name = "LeaseLiveError";
  }
}

/** Thrown when the claim moved between the read and the CAS (completed or re-issued). */
export class ClaimMovedError extends Error {
  constructor(ticketId: string, verb: string) {
    super(`Claim on ${ticketId} moved while ${verb} (completed or re-claimed) — nothing to ${verb === "retrying" ? "retry" : "dispatch"}.`);
    this.name = "ClaimMovedError";
  }
}

export interface ReleaseClaimInput {
  ddb: DynamoDBDocumentClient;
  workflowsTable: string;
  eventsTable: string;
  workflowId: string;
  ticketId: string;
  /** The agentTasks entry as read; undefined when the ticket has no claim at all. */
  task: Record<string, unknown> | undefined;
  /** The agent whose lease is checked; defaults to the task's agentId / assignee. */
  agentId?: string;
  parked: boolean;
  force: boolean;
  human: HumanIdentityResult;
  /** "retrying" | "dispatching" — only for the ClaimMovedError message. */
  verb?: string;
}

export async function releaseClaimGated(input: ReleaseClaimInput): Promise<{ unparked: boolean }> {
  const { ddb, workflowsTable, eventsTable, workflowId, ticketId, task, parked, force, human } = input;
  const verb = input.verb ?? "dispatching";
  // 1. a park is cleared by a human, or not at all — before anything is read or written.
  assertMayUnpark(parked, ticketId, human);

  const live = Boolean(task && LIVE_CLAIM_STATUSES.has(String(task.status)));
  const agentId = input.agentId ?? String(task?.agentId || task?.assignee || "");
  // 2. the lease gate, BEFORE the park is touched.
  if (live && !force) {
    const lastActivity = agentId ? await lastAgentActivity(ddb, eventsTable, workflowId, agentId, ticketId) : null;
    if (isLeaseLive(task as Record<string, unknown>, lastActivity, Date.now())) {
      throw new LeaseLiveError(ticketId, agentId, lastActivity);
    }
  }
  // 3. un-park, now that the release is going through.
  const unparked = parked ? await unparkTicket(ddb, workflowsTable, workflowId, ticketId) : false;
  if (!task) return { unparked };
  // 4. release the claim under a CAS.
  if (live) {
    const stolen = await stealClaim(ddb, workflowsTable, workflowId, ticketId, task.startedAt as string | undefined);
    if (!stolen) throw new ClaimMovedError(ticketId, verb);
    return { unparked };
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: workflowsTable,
        Key: { workflowId },
        UpdateExpression: "SET #at.#tid.#s = :ready",
        ConditionExpression: "attribute_exists(#at.#tid) AND #at.#tid.#s = :prev",
        ExpressionAttributeNames: { "#at": "agentTasks", "#tid": ticketId, "#s": "status" },
        ExpressionAttributeValues: { ":ready": "ready", ":prev": task.status },
      })
    );
  } catch (err) {
    if ((err as Error).name !== "ConditionalCheckFailedException") throw err;
    throw new ClaimMovedError(ticketId, verb);
  }
  return { unparked };
}
