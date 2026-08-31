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
  try {
    await _ddb.send(new UpdateCommand({
      TableName: _table,
      Key: { workflowId },
      UpdateExpression: "SET agentTasks.#tid = :task",
      ConditionExpression:
        "attribute_not_exists(agentTasks.#tid) OR agentTasks.#tid.#st <> :running OR agentTasks.#tid.startedAt < :staleBefore",
      ExpressionAttributeNames: { "#tid": ticketId, "#st": "status" },
      ExpressionAttributeValues: {
        ":task": entry,
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
 */
export async function completeWorkflow(workflowId, completedAt) {
  try {
    await _ddb.send(new UpdateCommand({
      TableName: _table,
      Key: { workflowId },
      UpdateExpression: "SET phase = :complete, completedAt = :ts",
      ConditionExpression: "phase <> :complete AND phase <> :cancelled AND phase <> :error",
      ExpressionAttributeValues: {
        ":complete": "complete",
        ":ts": completedAt,
        ":cancelled": "cancelled",
        ":error": "error",
      },
    }));
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
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
        "phase = :complete AND attribute_not_exists(finalizedAt) AND completedAt < :staleBefore",
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
