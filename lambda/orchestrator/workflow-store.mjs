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
      ConditionExpression:
        "attribute_not_exists(agentTasks.#tid) OR agentTasks.#tid.#st <> :running OR agentTasks.#tid.startedAt < :staleBefore",
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

/** Merge metadata fields (branch/commit/prUrl/output) into one task entry. */
export async function mergeTaskMetadata(workflowId, ticketId, fields) {
  const names = { "#tid": ticketId };
  const values = {};
  const sets = [];
  let i = 0;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    i++;
    names[`#f${i}`] = k;
    values[`:v${i}`] = v;
    sets.push(`agentTasks.#tid.#f${i} = :v${i}`);
  }
  if (!sets.length) return;
  try {
    await _ddb.send(new UpdateCommand({
      TableName: _table,
      Key: { workflowId },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ConditionExpression: "attribute_exists(agentTasks.#tid)",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
  } catch (err) {
    if (err.name !== "ConditionalCheckFailedException") throw err;
    // No tracked entry to merge into — drop the metadata rather than
    // materializing a partial entry the claim/complete paths don't own.
  }
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
 * Ship-head stability deferral bookkeeping (TEAM-4111). Scoped SET of two
 * attributes the gate + its reconcile-tick re-drive read: the consecutive
 * deferral count (bounds the deadlock fail-open) and the deferred ship
 * ticket id (so the re-drive knows which ticket to re-evaluate). count <= 0
 * REMOVEs both — a dispatched run carries no ship-head state. Never a full-row
 * put; never touches a sibling key.
 */
export async function setShipHeadDeferrals(workflowId, count, ticketId) {
  if (!count || count <= 0) {
    await _ddb.send(new UpdateCommand({
      TableName: _table,
      Key: { workflowId },
      UpdateExpression: "REMOVE shipHeadDeferrals, shipHeadTicketId",
    }));
    return;
  }
  await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression: "SET shipHeadDeferrals = :n, shipHeadTicketId = :t",
    ExpressionAttributeValues: { ":n": count, ":t": ticketId },
  }));
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
 * Rework-loop lineage ledger (TEAM-4113). Same two-write if_not_exists seed as
 * ensureReviewGateLedger, but keyed by a `${workflowId}:${phase}` LINEAGE key
 * (which spans distinct fix-ticket ids) instead of a single gate ticket id, so
 * the per-phase rework count survives the loop hopping ticket ids — the exact
 * blind spot the per-gate review-cap has. Concurrent fix-dones for the same
 * lineage seed idempotently rather than clobbering each other's rounds.
 */
async function ensureReworkLineageLedger(workflowId, lineageKey) {
  await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression: "SET reworkLineage = if_not_exists(reworkLineage, :empty)",
    ExpressionAttributeValues: { ":empty": {} },
  }));
  await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression: "SET reworkLineage.#k = if_not_exists(reworkLineage.#k, :seed)",
    ExpressionAttributeNames: { "#k": lineageKey },
    ExpressionAttributeValues: { ":seed": { rounds: [], authorizations: [], escalations: [] } },
  }));
}

/**
 * Append one rework round to a lineage ledger and return the POST-write ledger
 * `{ rounds, authorizations, escalations }` so the caller counts a concurrent
 * cycle's round too (list_append, never a whole-array rewrite — a lost round is
 * a cap that trips late). Returns null when the row is gone (a caller must not
 * read that as "zero rounds" and silently reset the cap).
 */
export async function appendReworkRound(workflowId, lineageKey, round) {
  await ensureReworkLineageLedger(workflowId, lineageKey);
  const res = await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression:
      "SET reworkLineage.#k.rounds = list_append(if_not_exists(reworkLineage.#k.rounds, :empty), :r)",
    ExpressionAttributeNames: { "#k": lineageKey },
    ExpressionAttributeValues: { ":empty": [], ":r": [round] },
    ReturnValues: "ALL_NEW",
  }));
  return res.Attributes?.reworkLineage?.[lineageKey] || null;
}

/** Record that a lineage hit its rework cap and was escalated. `decision:null`
 * means the escalation is still open — the idempotency key that stops a
 * subsequent fix-done from re-publishing rework.cap_reached. */
export async function appendReworkEscalation(workflowId, lineageKey, escalation) {
  await ensureReworkLineageLedger(workflowId, lineageKey);
  await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression:
      "SET reworkLineage.#k.escalations = list_append(if_not_exists(reworkLineage.#k.escalations, :empty), :e)",
    ExpressionAttributeNames: { "#k": lineageKey },
    ExpressionAttributeValues: { ":empty": [], ":e": [escalation] },
  }));
}

/** Append a human `DECISION: continue` authorization — resets the lineage
 * count from `resetAtRound` (same contract as appendReviewAuthorization). */
export async function appendReworkAuthorization(workflowId, lineageKey, authorization) {
  await ensureReworkLineageLedger(workflowId, lineageKey);
  await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression:
      "SET reworkLineage.#k.authorizations = list_append(if_not_exists(reworkLineage.#k.authorizations, :empty), :a)",
    ExpressionAttributeNames: { "#k": lineageKey },
    ExpressionAttributeValues: { ":empty": [], ":a": [authorization] },
  }));
}

/**
 * Human review-gate state machine (TEAM-4120 FR-1).
 *
 * Row shape: `gateStates[gateTicketId] = { state, requestedAt, resolvedAt?,
 * cycles: [{ requestedAt, resolvedAt, outcome }] }` where `cycles` holds only
 * CLOSED cycles — the OPEN one is the top-level `requestedAt` plus
 * `state: "requested"`, so "is a review pending right now" is one attribute
 * read, not a list scan.
 *
 * Same two-write if_not_exists seed as ensureReviewGateLedger (DynamoDB rejects
 * `SET a.b.c` when `a.b` is missing) with a `state: "none"` seed. "none" is
 * deliberately NOT one of the real GATE_STATES: a seeded-but-never-requested
 * gate must classify as "no usable state", not as a pending review.
 */
async function ensureGateState(workflowId, gateTicketId) {
  await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression: "SET gateStates = if_not_exists(gateStates, :empty)",
    ExpressionAttributeValues: { ":empty": {} },
  }));
  await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression: "SET gateStates.#g = if_not_exists(gateStates.#g, :seed)",
    ExpressionAttributeNames: { "#g": gateTicketId },
    ExpressionAttributeValues: { ":seed": { state: "none", cycles: [] } },
  }));
}

/**
 * Record that a gate has been PRESENTED to a human (parked for review).
 *
 * Returns false when the gate is ALREADY `requested` — the CAS
 * (`state <> "requested"`) makes the re-park idempotent, so a cascade re-wake or
 * a webhook redelivery cannot overwrite the original requestedAt and restart the
 * human's clock. Returns true when this call opened the cycle. Any error other
 * than the lost condition is rethrown: a caller must not read a failed write as
 * "already requested".
 */
export async function markGateRequested(workflowId, gateTicketId, at) {
  await ensureGateState(workflowId, gateTicketId);
  try {
    await _ddb.send(new UpdateCommand({
      TableName: _table,
      Key: { workflowId },
      UpdateExpression: "SET gateStates.#g.#st = :req, gateStates.#g.requestedAt = :at",
      ConditionExpression: "gateStates.#g.#st <> :req",
      ExpressionAttributeNames: { "#g": gateTicketId, "#st": "state" },
      ExpressionAttributeValues: { ":req": "requested", ":at": at },
    }));
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/**
 * Close a gate's open cycle as REJECTED ("Request changes") and return the gate's
 * post-write state row, or null when the CAS was lost.
 *
 * The condition is `state = "requested"`: exactly one caller can convert a
 * pending review into a rejection, which is what makes the guard idempotent
 * across the Jira-webhook and DDB-stream twins firing for the SAME transition
 * (both see `in_review → blocked`; the loser gets null and stands down).
 *
 * A null return therefore means "somebody else already recorded this" OR "there
 * was no pending review" — the caller distinguishes those by what it read before
 * the write, and must never treat null as a reason to drop a rejection on a run
 * that has no ledger yet (a pre-guard run seeds "none" and always loses).
 */
export async function markGateRejected(workflowId, gateTicketId, at, { requestedAt } = {}) {
  await ensureGateState(workflowId, gateTicketId);
  try {
    const res = await _ddb.send(new UpdateCommand({
      TableName: _table,
      Key: { workflowId },
      UpdateExpression:
        "SET gateStates.#g.#st = :rej, gateStates.#g.resolvedAt = :at, " +
        "gateStates.#g.cycles = list_append(if_not_exists(gateStates.#g.cycles, :empty), :cycle)",
      ConditionExpression: "gateStates.#g.#st = :req",
      ExpressionAttributeNames: { "#g": gateTicketId, "#st": "state" },
      ExpressionAttributeValues: {
        ":rej": "rejected",
        ":req": "requested",
        ":at": at,
        ":empty": [],
        // `?? null`, never undefined: the DocumentClient strips undefined values,
        // which would drop the key and lose the cycle's duration.
        ":cycle": [{ requestedAt: requestedAt ?? null, resolvedAt: at, outcome: "rejected" }],
      },
      ReturnValues: "ALL_NEW",
    }));
    return res.Attributes?.gateStates?.[gateTicketId] || null;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return null;
    throw err;
  }
}

/**
 * Close a gate's cycle as APPROVED (the human Done'd it) and return the
 * post-write state row, or null when the CAS was lost.
 *
 * Accepts `requested` OR `rejected` as the prior state: TEAM-3974 pins that a
 * human RE-deciding a gate is legitimate (Done after a Request-changes, a second
 * approval), so an approval must be able to close a cycle the reject path
 * already closed. `approved → approved` loses the CAS and is a no-op, which is
 * what keeps the done-cascade's repeated acks from appending endless cycles.
 */
export async function markGateApproved(workflowId, gateTicketId, at, { requestedAt } = {}) {
  await ensureGateState(workflowId, gateTicketId);
  try {
    const res = await _ddb.send(new UpdateCommand({
      TableName: _table,
      Key: { workflowId },
      UpdateExpression:
        "SET gateStates.#g.#st = :app, gateStates.#g.resolvedAt = :at, " +
        "gateStates.#g.cycles = list_append(if_not_exists(gateStates.#g.cycles, :empty), :cycle)",
      ConditionExpression: "gateStates.#g.#st IN (:req, :rej)",
      ExpressionAttributeNames: { "#g": gateTicketId, "#st": "state" },
      ExpressionAttributeValues: {
        ":app": "approved",
        ":req": "requested",
        ":rej": "rejected",
        ":at": at,
        ":empty": [],
        ":cycle": [{ requestedAt: requestedAt ?? null, resolvedAt: at, outcome: "approved" }],
      },
      ReturnValues: "ALL_NEW",
    }));
    return res.Attributes?.gateStates?.[gateTicketId] || null;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return null;
    throw err;
  }
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
 */
export async function completeWorkflow(workflowId, completedAt) {
  const guard = notTerminalPhaseGuard("phase");
  try {
    await _ddb.send(new UpdateCommand({
      TableName: _table,
      Key: { workflowId },
      UpdateExpression: "SET phase = :complete, completedAt = :ts",
      ConditionExpression: `${guard.condition} AND attribute_not_exists(cancelledAt)`,
      ExpressionAttributeValues: {
        ":complete": "complete",
        ":ts": completedAt,
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

/**
 * Record how a run was delivered at completion: { mode: "cd" | "handoff",
 * pipeline?, prUrl?, at }. "handoff" = the repo is outside the CD registry, so
 * the hub opened the PR and left it for the owning team; "cd" = the ship phase
 * merged + deployed. Plain overwrite — written once by the completer.
 */
export async function setDelivery(workflowId, delivery) {
  await _ddb.send(new UpdateCommand({
    TableName: _table,
    Key: { workflowId },
    UpdateExpression: "SET delivery = :d",
    ExpressionAttributeValues: { ":d": delivery },
  }));
}
