/**
 * Workflow store — the ONLY module allowed to write the workflows table
 * (R2 of docs/race-condition-study.md; enforced by scripts/check-workflow-writes.sh).
 *
 * Every op is a SCOPED conditional write. There is deliberately no "save the
 * whole workflow" function: full-row puts resurrect stale snapshots over
 * concurrent scoped writes (invocation claims, resume contexts, notification
 * appends) — the read-modify-write clobber class from the study.
 *
 * The one op that must read-modify-write (acking notifications inside a list)
 * runs under an optimistic version CAS with retry.
 */

import {
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
// TEAM-3755 F2: both terminal-claim CASes below derive their "not already
// terminal" guard from the ONE list in completion.mjs. completion.mjs is pure
// (no store import), so this cannot cycle.
import { notTerminalPhaseGuard } from "./completion.mjs";

let _ddb = null;
let _table = null;

/** Wire the shared DocumentClient + table name once at module init. */
export function initWorkflowStore(ddb, tableName) {
  _ddb = ddb;
  _table = tableName;
}

export async function getWorkflow(workflowId) {
  if (!workflowId || typeof workflowId !== "string") return null;
  const result = await _ddb.send(new GetCommand({
    TableName: _table,
    Key: { workflowId },
    ConsistentRead: true,
  }));
  return result.Item || null;
}

/**
 * Create a workflow row exactly once. A concurrent duplicate create (webhook
 * redelivery racing the epicId-index idempotency scan) loses the condition
 * and returns false instead of silently overwriting the winner.
 */
export async function createWorkflow(workflow) {
  try {
    await _ddb.send(new PutCommand({
      TableName: _table,
      Item: { ...workflow, workflowId: workflow.id },
      ConditionExpression: "attribute_not_exists(workflowId)",
    }));
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/** Ensure the agentTasks map exists without disturbing concurrent claims. */
async function ensureAgentTasksMap(workflowId) {
  await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression: "SET agentTasks = if_not_exists(agentTasks, :empty)",
    ExpressionAttributeValues: { ":empty": {} },
  }));
}

/**
 * Atomically claim a ticket for invocation. The ONE invocation lock that works
 * in both ticket providers — Jira transitions are not atomic and concurrent
 * webhook deliveries race straight through them (the PR #84 root cause).
 * Returns true when this caller won the claim.
 *
 * `staleBefore`: a claim whose startedAt is older is a crashed session — a
 * human re-Readying the ticket must be able to re-dispatch past it.
 *
 * TEAM-3991 SECURITY F8: a ticket flagged for merge-gate bypass
 * (`gateBypassFlaggedAt`) can NEVER be re-claimed. A fresh claim replaces the
 * whole entry, so re-dispatching a flagged ticket would erase the flag AND the
 * evidence (branch/commit/prUrl/output) a human needs to judge the bypass. The
 * flag is cleared only from a human-authenticated path.
 */
export async function claimInvocation(workflowId, ticketId, entry, staleBefore) {
  await ensureAgentTasksMap(workflowId);
  // TEAM-3698: a FRESH claim generation must never inherit the previous
  // generation's deadSessionDetectedAt stamp. Callers build the entry by
  // spreading the prior task (index.mjs claimTicketInvocation), so the stamp
  // would ride along onto a new startedAt — and the dead-session detector skips
  // any live task that is already stamped, permanently suppressing recovery for
  // that new generation. This write replaces the whole entry, so dropping the
  // key here IS the REMOVE (DynamoDB rejects a SET and a REMOVE on overlapping
  // document paths in one expression). Enforced here, in the sole writer (R2),
  // so no caller can reintroduce the inheritance.
  const { deadSessionDetectedAt: _staleStamp, ...task } = entry || {};
  try {
    await _ddb.send(new UpdateCommand({
      TableName: _table,
      Key: { workflowId },
      UpdateExpression: "SET agentTasks.#tid = :task",
      // The parentheses matter: the three stale/free alternatives are ORed, and
      // the bypass flag vetoes ALL of them.
      ConditionExpression:
        "(attribute_not_exists(agentTasks.#tid) OR agentTasks.#tid.#st <> :running OR agentTasks.#tid.startedAt < :staleBefore)" +
        " AND attribute_not_exists(agentTasks.#tid.gateBypassFlaggedAt)",
      ExpressionAttributeNames: { "#tid": ticketId, "#st": "status" },
      ExpressionAttributeValues: {
        ":task": task,
        ":running": "running",
        ":staleBefore": staleBefore,
      },
    }));
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/**
 * Track a ticket in agentTasks at creation time — first writer wins, a
 * concurrent tracker (stream + webhook double delivery) keeps the existing
 * entry. Returns true when this call created the entry.
 */
export async function trackTicket(workflowId, ticketId, entry) {
  await ensureAgentTasksMap(workflowId);
  try {
    await _ddb.send(new UpdateCommand({
      TableName: _table,
      Key: { workflowId },
      UpdateExpression: "SET agentTasks.#tid = :task",
      ConditionExpression: "attribute_not_exists(agentTasks.#tid)",
      ExpressionAttributeNames: { "#tid": ticketId },
      ExpressionAttributeValues: { ":task": entry },
    }));
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/** Replace one task entry (completion cascade). Scoped to its map key. */
export async function putTaskEntry(workflowId, ticketId, entry) {
  await ensureAgentTasksMap(workflowId);
  await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression: "SET agentTasks.#tid = :task",
    ExpressionAttributeNames: { "#tid": ticketId },
    ExpressionAttributeValues: { ":task": entry },
  }));
}

/**
 * Mark a task complete touching ONLY completion-owned fields. Replacing the
 * entry from a read snapshot races the webhook's concurrent metadata merge
 * (branch/commitSha/prUrl/output) — whichever write lands last would erase the
 * other's fields. When the entry was never tracked, seed it whole instead.
 */
export async function completeTaskEntry(workflowId, ticketId, seedEntry) {
  try {
    await _ddb.send(new UpdateCommand({
      TableName: _table,
      Key: { workflowId },
      UpdateExpression: "SET agentTasks.#tid.#st = :s, agentTasks.#tid.completedAt = :ts",
      ConditionExpression: "attribute_exists(agentTasks.#tid)",
      ExpressionAttributeNames: { "#tid": ticketId, "#st": "status" },
      ExpressionAttributeValues: { ":s": "complete", ":ts": seedEntry.completedAt },
    }));
  } catch (err) {
    if (err.name !== "ConditionalCheckFailedException") throw err;
    await putTaskEntry(workflowId, ticketId, seedEntry);
  }
}

/**
 * Per-field SET paths for one task entry — never a whole-entry replacement, so
 * a metadata merge can't erase a concurrent claim/complete write. Returns null
 * when there is nothing settable (every value undefined/null).
 */
function taskMetadataUpdate(ticketId, fields) {
  const names = { "#tid": ticketId };
  const values = {};
  const sets = [];
  let i = 0;
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined || v === null) continue;
    i++;
    names[`#f${i}`] = k;
    values[`:v${i}`] = v;
    sets.push(`agentTasks.#tid.#f${i} = :v${i}`);
  }
  if (!sets.length) return null;
  return {
    UpdateExpression: `SET ${sets.join(", ")}`,
    ConditionExpression: "attribute_exists(agentTasks.#tid)",
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

/**
 * Merge metadata fields (branch/commit/prUrl/output) into one task entry.
 * Returns true when the merge landed, false when there was no tracked entry to
 * merge into (or nothing to set) — see mergeTaskMetadataOrTrack for the callers
 * that must not lose the metadata.
 */
export async function mergeTaskMetadata(workflowId, ticketId, fields) {
  const update = taskMetadataUpdate(ticketId, fields);
  if (!update) return false;
  try {
    await _ddb.send(new UpdateCommand({ TableName: _table, Key: { workflowId }, ...update }));
    return true;
  } catch (err) {
    if (err.name !== "ConditionalCheckFailedException") throw err;
    // No tracked entry to merge into — drop the metadata rather than
    // materializing a partial entry the claim/complete paths don't own.
    return false;
  }
}

/**
 * TEAM-3991 D1.2 — merge metadata into a task entry, CREATING the entry first
 * when it was never tracked.
 *
 * mergeTaskMetadata deliberately drops on a missing entry, which is right for
 * the harvest paths (they only decorate work the orchestrator already owns) but
 * wrong for synthesized/manager evidence: a ticket whose agent died before any
 * claim landed has no agentTasks entry at all, and dropping the evidence there
 * is exactly the stranded-run bug. Seed via trackTicket (first-writer-wins, so
 * a concurrent tracker is harmless) and re-merge. Returns true when the fields
 * landed.
 */
export async function mergeTaskMetadataOrTrack(workflowId, ticketId, fields, seed = {}) {
  if (!taskMetadataUpdate(ticketId, fields)) return false;
  if (await mergeTaskMetadata(workflowId, ticketId, fields)) return true;
  await trackTicket(workflowId, ticketId, {
    ticketId,
    status: "pending",
    createdAt: new Date().toISOString(),
    ...seed,
  });
  return await mergeTaskMetadata(workflowId, ticketId, fields);
}

/** Set one task's status (claim release on failed invoke, re-dispatch, …). */
export async function setTaskStatus(workflowId, ticketId, status) {
  await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression: "SET agentTasks.#tid.#st = :s",
    ConditionExpression: "attribute_exists(agentTasks.#tid)",
    ExpressionAttributeNames: { "#tid": ticketId, "#st": "status" },
    ExpressionAttributeValues: { ":s": status },
  }));
}

/**
 * TEAM-4099 F2 — claim the right to flag ONE ticket for gate bypass.
 *
 * The detector used to publish `workflow.gate_bypass`, flip the task to
 * `in_review` and escalate BEFORE any conditional write, so two concurrent
 * cascades (the original done racing a re-Done, or the reconcile sweep racing a
 * live cascade) each published the event and each re-flipped the task. This is
 * now the FIRST write on the flag path: stamp `gateBypassFlaggedAt` ONLY IF the
 * entry exists and is not already stamped. Losing the CAS means another actor
 * already owns the flag, so the caller returns without side effects.
 *
 * `shadow: true` stamps observation-only fields instead
 * (`gateBypassShadowAt`/`gateBypassShadowCommit`): shadow mode must NEVER write
 * `gateBypassFlaggedAt`, because claimInvocation's veto (F8) makes a stamped
 * ticket permanently un-claimable — that is enforcement, not measurement.
 *
 * A ticket whose agent died before any claim landed has no agentTasks entry at
 * all, and DynamoDB cannot distinguish "no entry" from "already stamped". So,
 * mirroring mergeTaskMetadataOrTrack: on a lost CAS seed the entry via
 * trackTicket (first-writer-wins) and retry ONLY when this call created it —
 * otherwise the entry existed, which means the stamp was already there.
 * Returns { won } — true when THIS caller owns the flag.
 */
export async function claimGateBypassFlag(workflowId, ticketId, { mergeCommit = "", flaggedAt, shadow = false } = {}) {
  const stampedAt = shadow ? "gateBypassShadowAt" : "gateBypassFlaggedAt";
  const commitField = shadow ? "gateBypassShadowCommit" : "gateBypassMergeCommit";
  const ts = flaggedAt || new Date().toISOString();
  const stamp = async () => {
    try {
      await _ddb.send(new UpdateCommand({
        TableName: _table,
        Key: { workflowId },
        UpdateExpression: "SET agentTasks.#tid.#at = :ts, agentTasks.#tid.#sha = :sha",
        ConditionExpression: "attribute_exists(agentTasks.#tid) AND attribute_not_exists(agentTasks.#tid.#at)",
        ExpressionAttributeNames: { "#tid": ticketId, "#at": stampedAt, "#sha": commitField },
        ExpressionAttributeValues: { ":ts": ts, ":sha": mergeCommit },
      }));
      return true;
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") return false;
      throw err;
    }
  };

  if (await stamp()) return { won: true };
  const created = await trackTicket(workflowId, ticketId, {
    ticketId,
    status: "pending",
    createdAt: new Date().toISOString(),
  });
  if (!created) return { won: false };
  return { won: await stamp() };
}

/**
 * TEAM-4099 F4 — claim the right to SYNTHESIZE completion evidence for ONE ticket.
 *
 * Four independent paths call synthesizeCompletion (dead-session detector's stall
 * and dead-session branches, the invoke-failure catch, and the prGuard's
 * merged-PR salvage). Each used to read "no evidence yet" and then write
 * unconditionally, so two triggers could both synthesize (two done-cascades) and
 * either could land AFTER the agent's real report_completion and overwrite real
 * evidence with `evidenceSource: "synthesized"`. D1.2 says never fabricate
 * evidence; clobbering real evidence is worse.
 *
 * This is the FIRST write on the synthesis path: stamp `synthesisClaimedAt` ONLY
 * IF the entry exists, carries no `output` yet (a real report_completion having
 * landed is disqualifying), and is not already claimed. Losing the CAS means
 * another actor owns the synthesis — or real output arrived — so the caller
 * returns with zero writes.
 *
 * A ticket whose agent died before any claim landed has no agentTasks entry at
 * all, and DynamoDB cannot distinguish "no entry" from "already claimed". So,
 * mirroring claimGateBypassFlag / mergeTaskMetadataOrTrack: on a lost CAS seed
 * the entry via trackTicket (first-writer-wins) and retry ONLY when this call
 * created it. Returns { won, claimedAt } — `claimedAt` is the claim GENERATION,
 * passed back to setSynthesizedEvidence / releaseCompletionSynthesisClaim so
 * those writes can prove they own the claim they are acting on.
 */
export async function claimCompletionSynthesis(workflowId, ticketId, { now: claimedAt, seed = {} } = {}) {
  const ts = claimedAt || new Date().toISOString();
  const stamp = async () => {
    try {
      await _ddb.send(new UpdateCommand({
        TableName: _table,
        Key: { workflowId },
        UpdateExpression: "SET agentTasks.#tid.#sc = :ts",
        ConditionExpression:
          "attribute_exists(agentTasks.#tid) AND attribute_not_exists(agentTasks.#tid.#out) " +
          "AND attribute_not_exists(agentTasks.#tid.#sc)",
        ExpressionAttributeNames: { "#tid": ticketId, "#sc": "synthesisClaimedAt", "#out": "output" },
        ExpressionAttributeValues: { ":ts": ts },
      }));
      return true;
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") return false;
      throw err;
    }
  };

  if (await stamp()) return { won: true, claimedAt: ts };
  const created = await trackTicket(workflowId, ticketId, {
    ticketId,
    status: "pending",
    createdAt: new Date().toISOString(),
    ...seed,
  });
  if (!created) return { won: false };
  return (await stamp()) ? { won: true, claimedAt: ts } : { won: false };
}

/**
 * TEAM-4099 F4 — write synthesized evidence onto a task row, but ONLY while it
 * is still evidence-free.
 *
 * The synthesizer's GitHub probe takes seconds; the agent's real
 * report_completion can land in that window (the S3 record write is conditional
 * for the same reason). `attribute_not_exists(output)` makes the row write lose
 * that race by design — real evidence is never overwritten by synthesized. When
 * a claim generation is supplied, the write also proves ownership of the claim
 * it was authorized by, so a released-and-reclaimed synthesis can't be finished
 * by the stale loser. Deliberately does NOT trackTicket on a missing entry: the
 * claim already established the entry, and resurrecting a vanished row here
 * would recreate the unconditional write this replaces. Returns { applied }.
 */
export async function setSynthesizedEvidence(workflowId, ticketId, fields, { claimedAt } = {}) {
  const update = taskMetadataUpdate(ticketId, fields);
  if (!update) return { applied: false, reason: "nothing_to_set" };
  const names = { ...update.ExpressionAttributeNames, "#out": "output" };
  const values = { ...update.ExpressionAttributeValues };
  let condition = `${update.ConditionExpression} AND attribute_not_exists(agentTasks.#tid.#out)`;
  if (claimedAt) {
    names["#sc"] = "synthesisClaimedAt";
    values[":claimed"] = claimedAt;
    condition += " AND agentTasks.#tid.#sc = :claimed";
  }
  try {
    await _ddb.send(new UpdateCommand({
      TableName: _table,
      Key: { workflowId },
      UpdateExpression: update.UpdateExpression,
      ConditionExpression: condition,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
    return { applied: true };
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return { applied: false, reason: "condition_failed" };
    throw err;
  }
}

/**
 * TEAM-4099 F4 — drop OUR synthesis claim after an abort that left no durable
 * evidence behind (no repo, no branch/PR yet, or a thrown probe).
 *
 * A sticky claim is not harmless: claimCompletionSynthesis refuses an already
 * claimed ticket forever, so a run whose branch appears minutes after the first
 * failed probe could never be salvaged — exactly the stranded-run bug D1.2
 * exists to fix. Generation-scoped (`synthesisClaimedAt = :claimed`) so we only
 * ever release the claim we took, and refused once real `output` exists (the
 * claim has become a permanent "synthesis is settled" marker at that point).
 * Returns true when the claim was released.
 */
export async function releaseCompletionSynthesisClaim(workflowId, ticketId, claimedAt) {
  if (!claimedAt) return false;
  try {
    await _ddb.send(new UpdateCommand({
      TableName: _table,
      Key: { workflowId },
      UpdateExpression: "REMOVE agentTasks.#tid.#sc",
      ConditionExpression:
        "attribute_exists(agentTasks.#tid) AND agentTasks.#tid.#sc = :claimed " +
        "AND attribute_not_exists(agentTasks.#tid.#out)",
      ExpressionAttributeNames: { "#tid": ticketId, "#sc": "synthesisClaimedAt", "#out": "output" },
      ExpressionAttributeValues: { ":claimed": claimedAt },
    }));
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/**
 * TEAM-3991 D2.2 — park an agent's live claim because its ticket was blocked
 * (a fix ticket was filed against it, or a reviewer requested changes). "parked"
 * is deliberately NOT in lease-constants `liveClaimStatuses`, so a parked claim
 * stops holding the lease and the reconcile sweep can re-drive the ticket once
 * its blockers clear — without the dead-session detector having to declare the
 * session dead first.
 *
 * Generation-scoped: only the exact claim generation the caller observed is
 * parked (same startedAt — or, mirroring markDeadSessionDetected/stealClaim,
 * still no startedAt at all for a legacy task). Losing the CAS means the claim
 * already moved on (re-claimed, completed, stolen) and is not ours to park.
 * Returns true when this caller parked the claim.
 */
export async function parkClaim(workflowId, ticketId, expectedStartedAt) {
  try {
    await _ddb.send(new UpdateCommand({
      TableName: _table,
      Key: { workflowId },
      UpdateExpression: "SET agentTasks.#tid.#st = :parked",
      ConditionExpression:
        "(agentTasks.#tid.#st = :running OR agentTasks.#tid.#st = :inprog) AND " +
        (expectedStartedAt
          ? "agentTasks.#tid.startedAt = :expected"
          : "attribute_not_exists(agentTasks.#tid.startedAt)"),
      ExpressionAttributeNames: { "#tid": ticketId, "#st": "status" },
      ExpressionAttributeValues: {
        ":parked": "parked",
        ":running": "running",
        ":inprog": "in_progress",
        ...(expectedStartedAt ? { ":expected": expectedStartedAt } : {}),
      },
    }));
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/**
 * Sweep idempotency for the dead-session detector (TEAM-3618 D1.2). Stamp
 * deadSessionDetectedAt on the task ONLY IF the entry still holds the exact
 * claim generation the sweep inspected (same startedAt — or, mirroring
 * stealClaim, still no startedAt at all for a legacy task that never recorded
 * one) and has not already been stamped. This is the FIRST write on the
 * trigger path — losing the CAS
 * (the claim moved, or a concurrent sweep already stamped it) means another
 * actor owns this generation, so the caller stops. Scoped to the task's own
 * map keys; never a full-map replacement (R2). Returns true when this caller
 * won the stamp.
 */
export async function markDeadSessionDetected(workflowId, ticketId, expectedStartedAt) {
  try {
    await _ddb.send(new UpdateCommand({
      TableName: _table,
      Key: { workflowId },
      UpdateExpression: "SET agentTasks.#tid.deadSessionDetectedAt = :now",
      ConditionExpression: expectedStartedAt
        ? "agentTasks.#tid.startedAt = :expected AND attribute_not_exists(agentTasks.#tid.deadSessionDetectedAt)"
        : "attribute_not_exists(agentTasks.#tid.startedAt) AND attribute_not_exists(agentTasks.#tid.deadSessionDetectedAt)",
      ExpressionAttributeNames: { "#tid": ticketId },
      ExpressionAttributeValues: {
        ":now": new Date().toISOString(),
        ...(expectedStartedAt ? { ":expected": expectedStartedAt } : {}),
      },
    }));
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/**
 * Un-stamp a dead-session detection (TEAM-3698). The detector stamps BEFORE its
 * TOCTOU lease re-check; when that re-check finds the agent resurrected
 * (heartbeated after the stamp), the stamp comes back off so the generation
 * stays cheaply detectable. A clear that fails or loses its CAS is not fatal:
 * the detector re-evaluates stamped live-status tasks on every sweep
 * (TEAM-3702) — retrying this clear while the lease is live, re-driving
 * recovery on the held stamp once it is dead.
 *
 * REMOVEs deadSessionDetectedAt ONLY IF the entry still holds the exact claim
 * generation the sweep inspected (same startedAt — or, mirroring
 * markDeadSessionDetected/stealClaim, still no startedAt at all) and is in fact
 * stamped. Losing the CAS means the generation moved on (re-claimed, completed,
 * escalated) and the stamp is no longer ours to clear — the caller just logs.
 * Scoped to the task's own map keys; never a full-map replacement (R2). Returns
 * true when this caller cleared the stamp.
 */
export async function clearDeadSessionDetected(workflowId, ticketId, expectedStartedAt) {
  try {
    await _ddb.send(new UpdateCommand({
      TableName: _table,
      Key: { workflowId },
      UpdateExpression: "REMOVE agentTasks.#tid.deadSessionDetectedAt",
      ConditionExpression: expectedStartedAt
        ? "agentTasks.#tid.startedAt = :expected AND attribute_exists(agentTasks.#tid.deadSessionDetectedAt)"
        : "attribute_not_exists(agentTasks.#tid.startedAt) AND attribute_exists(agentTasks.#tid.deadSessionDetectedAt)",
      ExpressionAttributeNames: { "#tid": ticketId },
      // A REMOVE with no placeholder needs NO values map at all — an empty
      // ExpressionAttributeValues is a validation error, so omit the key.
      ...(expectedStartedAt ? { ExpressionAttributeValues: { ":expected": expectedStartedAt } } : {}),
    }));
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/**
 * Increment the per-ticket dead-session retry counter (TEAM-3618 D1.2), scoped
 * to deadSessionRetries[ticketId] so it never touches qaRetryCount or sibling
 * tickets. The map is seeded first (if_not_exists on the map is illegal inside
 * the same SET that indexes into it), then the leaf is bumped with
 * if_not_exists so the first detection reads 0 → 1. Returns the new count.
 */
/**
 * TEAM-3971 — clear one ticket's dead-session retry budget. A human just made
 * the decision the agent was parked on, so its next silence is a NEW episode
 * and deserves the one automatic re-dispatch again. Scoped REMOVE of the leaf
 * only; a missing map (never retried) is a no-op, not an error.
 */
export async function resetDeadSessionRetry(workflowId, ticketId) {
  try {
    await _ddb.send(new UpdateCommand({
      TableName: _table,
      Key: { workflowId },
      UpdateExpression: "REMOVE deadSessionRetries.#tid",
      ConditionExpression: "attribute_exists(deadSessionRetries)",
      ExpressionAttributeNames: { "#tid": ticketId },
    }));
    return true;
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

export async function incrementDeadSessionRetry(workflowId, ticketId) {
  await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression: "SET deadSessionRetries = if_not_exists(deadSessionRetries, :empty)",
    ExpressionAttributeValues: { ":empty": {} },
  }));
  const res = await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression: "SET deadSessionRetries.#tid = if_not_exists(deadSessionRetries.#tid, :zero) + :one",
    ExpressionAttributeNames: { "#tid": ticketId },
    ExpressionAttributeValues: { ":zero": 0, ":one": 1 },
    ReturnValues: "UPDATED_NEW",
  }));
  return res.Attributes?.deadSessionRetries?.[ticketId];
}

/**
 * Advance the workflow phase, optionally pinning the shared feature branch.
 * if_not_exists on the branch keeps the first winner under concurrent
 * same-phase claims; the monotonic phase check happened caller-side against a
 * consistent read serialized by the command queue (R1).
 */
export async function advancePhase(workflowId, phase, featureBranch) {
  await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression: featureBranch
      ? "SET phase = :p, featureBranch = if_not_exists(featureBranch, :fb)"
      : "SET phase = :p",
    ExpressionAttributeValues: {
      ":p": phase,
      ...(featureBranch ? { ":fb": featureBranch } : {}),
    },
  }));
}

/** Pin the shared feature branch (first writer wins). */
export async function adoptFeatureBranch(workflowId, branch) {
  await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression: "SET featureBranch = if_not_exists(featureBranch, :fb)",
    ExpressionAttributeValues: { ":fb": branch },
  }));
}

/** Atomically set resumeContexts[ticketId] without touching sibling keys. */
export async function setResumeContext(workflowId, ticketId, note) {
  await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression: "SET resumeContexts = if_not_exists(resumeContexts, :empty)",
    ExpressionAttributeValues: { ":empty": {} },
  }));
  await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression: "SET resumeContexts.#k = :note",
    ExpressionAttributeNames: { "#k": ticketId },
    ExpressionAttributeValues: { ":note": note },
  }));
}

/**
 * Persist the repo URL pre-flight result (see repo-check.mjs). Scoped SET of
 * one attribute — never touches the rest of the row.
 */
export async function setRepoCheck(workflowId, repoCheck) {
  await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression: "SET repoCheck = :rc",
    ExpressionAttributeValues: { ":rc": repoCheck },
  }));
}

/**
 * TEAM-3991 D1.1 — persist the branch-protection pre-flight result (see
 * repo-check.mjs checkBranchProtection). Advisory data for humans and for the
 * gate-bypass escalation text; scoped SET of one attribute.
 */
export async function setProtectionCheck(workflowId, protectionCheck) {
  await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression: "SET branchProtectionCheck = :pc",
    ExpressionAttributeValues: { ":pc": protectionCheck },
  }));
}

/**
 * TEAM-3992 D3.4 — record the one-shot realized-graph audit result. The
 * orchestrator validates the run's realized child graph against the def's
 * ticketDag once, at the first development-phase dispatch; this stamps the
 * outcome. The `attribute_not_exists(dagAudit)` condition makes the write itself
 * the idempotency guard — the first caller wins and records, every later caller
 * loses the CAS and gets false, so the audit (and its event) fires exactly once
 * per run. Scoped SET of one top-level attribute; never a full-map replacement
 * (R2). Returns true when this caller recorded the audit.
 */
export async function setDagAudit(workflowId, { at, violationCount, violations }) {
  try {
    await _ddb.send(new UpdateCommand({
      TableName: _table,
      Key: { workflowId },
      UpdateExpression: "SET dagAudit = :a",
      ConditionExpression: "attribute_not_exists(dagAudit)",
      ExpressionAttributeValues: {
        ":a": {
          at,
          violationCount,
          violations: (violations || []).slice(0, 20),
        },
      },
    }));
    return true;
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/** Remove one resume context (one-time use). No-op if absent. */
export async function removeResumeContext(workflowId, ticketId) {
  try {
    await _ddb.send(new UpdateCommand({
      TableName: _table,
      Key: { workflowId },
      UpdateExpression: "REMOVE resumeContexts.#k",
      ExpressionAttributeNames: { "#k": ticketId },
    }));
  } catch (err) {
    // Map attribute absent — nothing to remove.
    console.warn(`[workflow-store] removeResumeContext(${ticketId}): ${err.message}`);
  }
}

/**
 * Ensure reviewGateHistory[gateTicketId] exists as an empty ledger.
 *
 * Two writes, not one: a single expression cannot both create the
 * reviewGateHistory map and index into it (same constraint setResumeContext
 * works around). Both are if_not_exists, so concurrent rejection cycles for the
 * same gate seed idempotently instead of clobbering each other's rounds.
 */
async function ensureReviewGateLedger(workflowId, gateTicketId) {
  await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression: "SET reviewGateHistory = if_not_exists(reviewGateHistory, :empty)",
    ExpressionAttributeValues: { ":empty": {} },
  }));
  await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression: "SET reviewGateHistory.#g = if_not_exists(reviewGateHistory.#g, :seed)",
    ExpressionAttributeNames: { "#g": gateTicketId },
    ExpressionAttributeValues: { ":seed": { rounds: [], authorizations: [], escalations: [] } },
  }));
}

/**
 * Append one review round to a gate's convergence ledger (TEAM-3619 D2c) and
 * return the gate's post-write ledger `{ rounds, authorizations, escalations }`.
 *
 * list_append, never a whole-array rewrite: two rejection cycles landing at
 * once must both be counted, because a lost round is a cap that trips late —
 * i.e. the runaway loop this ledger exists to stop.
 *
 * Callers MUST use the returned ledger (not their pre-write workflow snapshot)
 * to compute the effective round count, so a concurrent cycle's round is
 * included. Duplicate round numbers are fine: effectiveRoundCount dedupes by
 * round number, last entry winning, which is how a re-run of the same head SHA
 * replaces its earlier verdict.
 *
 * ALL_NEW rather than UPDATED_NEW because the caller needs `authorizations`
 * (human "continue" decisions reset the count) and `escalations` (an already-
 * open escalation makes this a no-op) from the SAME post-write snapshot;
 * UPDATED_NEW returns only the rounds path.
 */
export async function appendReviewRound(workflowId, gateTicketId, round) {
  await ensureReviewGateLedger(workflowId, gateTicketId);
  const res = await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression:
      "SET reviewGateHistory.#g.rounds = list_append(if_not_exists(reviewGateHistory.#g.rounds, :empty), :r)",
    ExpressionAttributeNames: { "#g": gateTicketId },
    ExpressionAttributeValues: { ":empty": [], ":r": [round] },
    ReturnValues: "ALL_NEW",
  }));
  return res.Attributes?.reviewGateHistory?.[gateTicketId] || null;
}

/**
 * Record that a gate hit its round cap and was handed to a human. Audit trail
 * plus the idempotency key for the escalation: an entry with `decision: null`
 * means the escalation is still open, so a subsequent rejection cycle re-parks
 * the gate without re-publishing review.cap_reached.
 */
export async function appendReviewCapEscalation(workflowId, gateTicketId, escalation) {
  await ensureReviewGateLedger(workflowId, gateTicketId);
  await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression:
      "SET reviewGateHistory.#g.escalations = list_append(if_not_exists(reviewGateHistory.#g.escalations, :empty), :e)",
    ExpressionAttributeNames: { "#g": gateTicketId },
    ExpressionAttributeValues: { ":empty": [], ":e": [escalation] },
  }));
}

/**
 * Append a human authorization to a gate's ledger — the escalation's exit.
 * A `continue` decision carries `resetAtRound`, which is what makes the cap
 * count start over from that round (see effectiveRoundCount).
 */
export async function appendReviewAuthorization(workflowId, gateTicketId, authorization) {
  await ensureReviewGateLedger(workflowId, gateTicketId);
  await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression:
      "SET reviewGateHistory.#g.authorizations = list_append(if_not_exists(reviewGateHistory.#g.authorizations, :empty), :a)",
    ExpressionAttributeNames: { "#g": gateTicketId },
    ExpressionAttributeValues: { ":empty": [], ":a": [authorization] },
  }));
}

/**
 * TEAM-3991 D1.1 — append one human gate DECISION to a gate's ledger. This is
 * the AUTHORITATIVE record of merge authority: gate-bypass detection compares
 * `mergedAt` against these rows, not against the ticket's board status.
 *
 * SECURITY F6: only human-authenticated paths may call this — the console
 * transition route (actor from the middleware identity, never from the request
 * body) and the Telegram gate-decision path. The orchestrator's done handlers
 * CONSUME this ledger and must never append an APPROVE row, or the bypass check
 * would approve on the agent's behalf and detect nothing.
 *
 * list_append, never a whole-array rewrite: two decisions landing at once (a
 * console click and a Telegram reply) must both be recorded. Returns the gate's
 * post-write decisions array so the caller can act on the merged view.
 */
export async function appendGateDecision(workflowId, gateTicketId, decision) {
  await ensureReviewGateLedger(workflowId, gateTicketId);
  const res = await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression:
      "SET reviewGateHistory.#g.decisions = list_append(if_not_exists(reviewGateHistory.#g.decisions, :empty), :d)",
    ExpressionAttributeNames: { "#g": gateTicketId },
    ExpressionAttributeValues: { ":empty": [], ":d": [decision] },
    ReturnValues: "ALL_NEW",
  }));
  return res.Attributes?.reviewGateHistory?.[gateTicketId]?.decisions || null;
}

/**
 * Append a human notification atomically (no full-array rewrite). Bumps
 * notifVersion in the same write so a concurrent ackNotifications CAS that
 * read the pre-append list fails and re-reads instead of overwriting the
 * fresh notification with its stale copy.
 */
export async function appendNotification(workflowId, notification) {
  await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression:
      "SET humanNotifications = list_append(if_not_exists(humanNotifications, :empty), :n), notifVersion = if_not_exists(notifVersion, :zero) + :one",
    ExpressionAttributeValues: { ":empty": [], ":n": [notification], ":zero": 0, ":one": 1 },
  }));
}

/**
 * Append a review_needed notification for `ticketId` at most once WHILE ONE IS
 * STILL OPEN (TEAM-3684 Finding 2). Concurrent last-blocker completions each
 * re-wake the same review gate carrying a stale in-memory snapshot, so a plain
 * appendNotification would create duplicate reviewer notifications (and let the
 * caller re-emit review.reawakened twice). DynamoDB can't scan a list inside a
 * ConditionExpression, so the idempotency check rides the same optimistic
 * notifVersion CAS used by ackNotifications: read fresh → if an unacknowledged
 * review_needed for this ticket already exists, do nothing → else append under
 * `notifVersion = :cur`. A concurrent append/ack bumps the version, our CAS
 * fails, we re-read and now observe the open notification and stand down.
 *
 * Reuses the existing acknowledged-based open/closed lifecycle, so a gate that
 * was reviewed (notification acked) and later reopened re-notifies correctly.
 * Returns true only when THIS caller appended the notification.
 */
export async function appendReviewNotificationOnce(workflowId, ticketId, notification, maxAttempts = 3) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const wf = await getWorkflow(workflowId);
    if (!wf) return false;
    const list = Array.isArray(wf.humanNotifications) ? wf.humanNotifications : [];
    const alreadyOpen = list.some(
      (n) => n.ticketId === ticketId && n.type === "review_needed" && !n.acknowledged
    );
    if (alreadyOpen) return false;
    try {
      await _ddb.send(new UpdateCommand({
        TableName: _table,
        Key: { workflowId },
        UpdateExpression: "SET humanNotifications = :n, notifVersion = :next",
        ConditionExpression: "attribute_not_exists(notifVersion) OR notifVersion = :cur",
        ExpressionAttributeValues: {
          ":n": [...list, notification],
          ":next": (wf.notifVersion || 0) + 1,
          ":cur": wf.notifVersion || 0,
        },
      }));
      return true;
    } catch (err) {
      if (err.name !== "ConditionalCheckFailedException") throw err;
      // Concurrent append/ack — re-read, re-check the open-notification guard.
    }
  }
  console.warn(`[workflow-store] appendReviewNotificationOnce(${workflowId}, ${ticketId}): CAS retries exhausted`);
  return false;
}

/**
 * TEAM-3991 — append ANY notification at most once while one is still open,
 * keyed on the notification's own `id` (the generalization of
 * appendReviewNotificationOnce, which is keyed on ticketId + "review_needed").
 *
 * Callers mint a deterministic id per offending fact so a re-delivered stream
 * record / a second cascade / a sweep re-check can't multiply escalations:
 *   - gate bypass:  notif_gate_bypass_<workflowId>_<mergeCommit>   (SECURITY F9)
 *   - epic roll-up: notif_epic_rollup_<workflowId>
 * The in-memory `humanNotifications.some(...)` pre-check callers used before is
 * NOT enough — two concurrent invocations both hold pre-append snapshots. Same
 * optimistic notifVersion CAS as ackNotifications: read fresh → if an
 * unacknowledged notification with this id already exists, stand down → else
 * append under `notifVersion = :cur`.
 *
 * Once a human acknowledges it, a later recurrence notifies again (the same
 * acknowledged-based open/closed lifecycle as the review notification).
 * `opts.isDuplicate(n)` overrides the id predicate. Returns true ONLY when THIS
 * caller appended.
 */
export async function appendNotificationOnce(workflowId, notification, opts = {}) {
  const maxAttempts = opts.maxAttempts || 3;
  const isDuplicate =
    opts.isDuplicate || ((n) => n.id === notification.id && !n.acknowledged);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const wf = await getWorkflow(workflowId);
    if (!wf) return false;
    const list = Array.isArray(wf.humanNotifications) ? wf.humanNotifications : [];
    if (list.some(isDuplicate)) return false;
    try {
      await _ddb.send(new UpdateCommand({
        TableName: _table,
        Key: { workflowId },
        UpdateExpression: "SET humanNotifications = :n, notifVersion = :next",
        ConditionExpression: "attribute_not_exists(notifVersion) OR notifVersion = :cur",
        ExpressionAttributeValues: {
          ":n": [...list, notification],
          ":next": (wf.notifVersion || 0) + 1,
          ":cur": wf.notifVersion || 0,
        },
      }));
      return true;
    } catch (err) {
      if (err.name !== "ConditionalCheckFailedException") throw err;
      // Concurrent append/ack — re-read, re-check the duplicate guard.
    }
  }
  console.warn(`[workflow-store] appendNotificationOnce(${workflowId}, ${notification?.id}): CAS retries exhausted`);
  return false;
}

/**
 * Acknowledge matching notifications. DynamoDB can't update list items by
 * predicate, so this is the one unavoidable read-modify-write — guarded by an
 * optimistic version CAS with bounded retry.
 */
export async function ackNotifications(workflowId, predicate, maxAttempts = 3) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const wf = await getWorkflow(workflowId);
    if (!wf || !Array.isArray(wf.humanNotifications)) return;
    let changed = false;
    const next = wf.humanNotifications.map((n) => {
      if (!n.acknowledged && predicate(n)) {
        changed = true;
        return { ...n, acknowledged: true };
      }
      return n;
    });
    if (!changed) return;
    try {
      await _ddb.send(new UpdateCommand({
        TableName: _table,
        Key: { workflowId },
        UpdateExpression: "SET humanNotifications = :n, notifVersion = :next",
        ConditionExpression: "attribute_not_exists(notifVersion) OR notifVersion = :cur",
        ExpressionAttributeValues: {
          ":n": next,
          ":next": (wf.notifVersion || 0) + 1,
          ":cur": wf.notifVersion || 0,
        },
      }));
      return;
    } catch (err) {
      if (err.name !== "ConditionalCheckFailedException") throw err;
      // Concurrent append/ack — re-read and retry.
    }
  }
  console.warn(`[workflow-store] ackNotifications(${workflowId}): CAS retries exhausted`);
}

/**
 * Complete the workflow exactly once. Scoped conditional write mirroring the
 * /api/workflow/[id]/complete route — the orchestrator path previously used a
 * full-row put guarded only by a stale in-memory phase check (study P1).
 * Returns true when this caller performed the completion.
 *
 * TEAM-3619 D4a: the CAS also refuses when `cancelledAt` is stamped, so a
 * cancellation that landed after this caller's phase read (the phase attribute
 * itself may lag behind the cancelledAt stamp) can never be overwritten by a
 * completion. A lost CAS is a graceful no-op (returns false, never throws) —
 * some other actor already reached a terminal decision for this run.
 *
 * TEAM-3755 F2: the guard now refuses ALL FIVE terminal phases (shared list in
 * completion.mjs), not just complete/cancelled/error. It previously omitted
 * "deploy-blocked" / "static-ci-only", so a completion racing in behind an
 * honest blocked close overwrote it with "complete".
 *
 * TEAM-3991 D1.4: the SAME write stamps `epicRollupPending`, so the roll-up
 * obligation is created ATOMICALLY with the terminal claim and belongs to
 * exactly one invocation — the CAS winner. A winner that dies before rolling
 * the root epic leaves the flag set, and the reconcile sweep retries it; there
 * is no window in which the run is "complete" with nobody owning the roll-up.
 * The winner clears it with clearEpicRollupPending.
 */
export async function completeWorkflow(workflowId, completedAt) {
  const guard = notTerminalPhaseGuard("phase");
  try {
    await _ddb.send(new UpdateCommand({
      TableName: _table,
      Key: { workflowId },
      UpdateExpression: "SET phase = :complete, completedAt = :ts, epicRollupPending = :pending",
      ConditionExpression: `${guard.condition} AND attribute_not_exists(cancelledAt)`,
      ExpressionAttributeValues: {
        ":complete": "complete",
        ":ts": completedAt,
        ":pending": true,
        ...guard.values,
      },
    }));
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      console.log(`[workflow-store] completeWorkflow(${workflowId}): CAS lost — already terminal or cancelled, no-op.`);
      return false;
    }
    throw err;
  }
}

/**
 * TEAM-3747 D2 — atomically close a run on an HONEST NON-"complete" terminal
 * outcome ("deploy-blocked" / "static-ci-only"). Same CAS shape + idempotency as
 * completeWorkflow: only the first caller wins, and a run that is already terminal
 * (complete/error/cancelled or an already-recorded block outcome) is a harmless
 * no-op. Records the block reason when supplied. Cancellation still precedes
 * everything (attribute_not_exists(cancelledAt)).
 *
 * TEAM-3755 F2: this CAS already excluded all five phases by hand; it now derives
 * them from the SAME shared list as completeWorkflow so the two can never drift.
 */
export async function claimTerminalOutcome(workflowId, outcome, completedAt, reason) {
  const guard = notTerminalPhaseGuard("phase");
  try {
    await _ddb.send(new UpdateCommand({
      TableName: _table,
      Key: { workflowId },
      UpdateExpression:
        "SET phase = :outcome, completedAt = :ts" + (reason ? ", blockReason = :reason" : ""),
      ConditionExpression: `${guard.condition} AND attribute_not_exists(cancelledAt)`,
      ExpressionAttributeValues: {
        ":outcome": outcome,
        ":ts": completedAt,
        ...guard.values,
        ...(reason ? { ":reason": String(reason).slice(0, 500) } : {}),
      },
    }));
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      console.log(`[workflow-store] claimTerminalOutcome(${workflowId}, ${outcome}): CAS lost — already terminal, no-op.`);
      return false;
    }
    throw err;
  }
}

/**
 * TEAM-3991 D1.4 — the root epic was rolled up to done, so the obligation
 * stamped by the completeWorkflow CAS is discharged. Scoped REMOVE; a run whose
 * flag is already gone (a sweep retry that raced the winner) returns false
 * instead of throwing.
 *
 * TEAM-4099 F5: the retry lease goes with the debt — a discharged obligation has
 * nothing left to lease, and REMOVE of an absent attribute is a no-op, so the
 * completion-path winner (which never took a lease) is unaffected.
 */
export async function clearEpicRollupPending(workflowId) {
  try {
    await _ddb.send(new UpdateCommand({
      TableName: _table,
      Key: { workflowId },
      UpdateExpression: "REMOVE epicRollupPending, epicRollupClaimedAt",
      ConditionExpression: "attribute_exists(epicRollupPending)",
    }));
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/** How long one epic-roll-up retry owns the debt before another sweep may take it. */
export const EPIC_ROLLUP_RETRY_LEASE_MS = 10 * 60 * 1000;

/**
 * TEAM-4099 F5 — claim ONE attempt at an outstanding epic roll-up.
 *
 * The sweep used to take the debt via `claimFinalization`, which SETs
 * `finalizedAt`. That is fatal on failure: `finalizedAt` is exactly the attribute
 * the pending-roll-up scan excludes on (sweep-scan.mjs
 * `attribute_exists(epicRollupPending) AND attribute_not_exists(finalizedAt)`), so
 * one failed retry marked the run "every side effect ran" while `epicRollupPending`
 * was still true — and no future sweep could ever see it again. The epic stayed
 * open forever with nobody responsible, the precise failure mode D1.4's
 * obligation flag exists to prevent.
 *
 * So the retry takes a LEASE instead of a completion marker: `epicRollupClaimedAt`
 * is not read by any scan filter, so a failed attempt leaves the row still
 * matching the debt list. `finalizedAt` is written only by `markFinalized`, after
 * the roll-up actually lands.
 *
 * The lease doubles as back-pressure: it is deliberately NOT released on failure,
 * so a run whose epic write keeps being rejected is retried once per lease window
 * rather than once per sweep (rollUpEpic already burns 3 attempts with backoff
 * inside a single call). An owner that dies mid-attempt is covered by the same
 * expiry.
 *
 * Mutual exclusion is between RETRIES. A live completer mid-roll-up is not
 * excluded (there is no marker for its in-flight window) — that is intentional:
 * rollUpEpic is idempotent by construction (a Done epic transitioned to Done again
 * is a success), so a duplicate roll-up costs a duplicate event, whereas the old
 * exclusion cost a permanently stranded epic.
 */
export async function claimEpicRollupRetry(workflowId, { now = new Date().toISOString(), leaseMs = EPIC_ROLLUP_RETRY_LEASE_MS } = {}) {
  const nowMs = Date.parse(now);
  const staleBefore = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) - leaseMs).toISOString();
  try {
    await _ddb.send(new UpdateCommand({
      TableName: _table,
      Key: { workflowId },
      UpdateExpression: "SET epicRollupClaimedAt = :now",
      ConditionExpression:
        "attribute_exists(epicRollupPending) AND attribute_not_exists(finalizedAt) AND " +
        "(attribute_not_exists(epicRollupClaimedAt) OR epicRollupClaimedAt < :staleBefore)",
      ExpressionAttributeValues: { ":now": now, ":staleBefore": staleBefore },
    }));
    return { won: true };
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return { won: false };
    throw err;
  }
}

/** Record that completion side effects (PR, epic roll-up, event) finished. */
export async function markFinalized(workflowId) {
  await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression: "SET finalizedAt = :ts",
    ExpressionAttributeValues: { ":ts": new Date().toISOString() },
  }));
}

/**
 * Take over finalization of a workflow whose completing invocation died
 * between the completion claim and its side effects (phase=complete but no
 * finalizedAt after the stale window). Claim-first: the CAS on finalizedAt
 * means exactly one retry runs the takeover; the side effects themselves are
 * idempotent (duplicate PR create 422s and is caught, Done transition and the
 * completion event are harmless to repeat).
 */
export async function claimFinalization(workflowId, staleBefore) {
  try {
    await _ddb.send(new UpdateCommand({
      TableName: _table,
      Key: { workflowId },
      UpdateExpression: "SET finalizedAt = :ts",
      ConditionExpression:
        "phase = :complete AND attribute_not_exists(finalizedAt) AND attribute_not_exists(cancelledAt) AND completedAt < :staleBefore",
      ExpressionAttributeValues: {
        ":ts": new Date().toISOString(),
        ":complete": "complete",
        ":staleBefore": staleBefore,
      },
    }));
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}
