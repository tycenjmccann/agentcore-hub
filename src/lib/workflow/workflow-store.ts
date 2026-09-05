/**
 * TEAM-4099 F6 — the app tier's workflows-table store. ONE owner for every
 * write the Next.js API routes make to the workflows table.
 *
 * WHY THIS EXISTS
 * The orchestrator has had a single-writer store (lambda/orchestrator/
 * workflow-store.mjs) since the race-condition study, enforced by
 * scripts/check-workflow-writes.sh. The console did not: ten route files each
 * hand-rolled their own UpdateCommands against the same item, re-deriving the
 * same scoped-conditional-write discipline by copy-paste — and the guard only
 * scanned `lambda/orchestrator/*.mjs`, so nothing caught a drift. Two of them
 * had already drifted: mark-done overwrote real evidence with the manager's
 * typed text (F6), and the escalations ack rewrote the whole
 * `humanNotifications` list, so a notification appended in the read→write gap
 * was silently dropped.
 *
 * THE RULES (R2), which this module is now the only place to satisfy:
 *   - Every write is SCOPED: field/map-key paths, never a whole-map or
 *     whole-list rewrite, so a concurrent writer touching a sibling key cannot
 *     be clobbered.
 *   - Every write is CONDITIONAL where a condition is meaningful, and a lost
 *     ConditionalCheckFailedException is a value (`false` / `{applied:false}`),
 *     never an exception the caller has to name.
 *   - Functions are named after their orchestrator twins wherever one exists
 *     (mergeTaskMetadata, setTaskStatus, appendGateDecision, completeWorkflow,
 *     claimTerminalOutcome, clearEpicRollupPending, ackNotifications,
 *     setResumeContext, trackTicket) so the two tiers can be diffed by eye.
 *
 * NOT HERE: writes to the tickets/events/analyses tables (a route may write
 * those directly — they are single-writer per item by construction), reads
 * (src/lib/workflow/dynamo-read.ts), and `stealClaim` in
 * src/lib/workflow/lease.ts, which stays with the liveness math it belongs to
 * (R3) exactly as lambda/orchestrator/lease.mjs does on the Lambda side. The
 * guard allowlists those two files and nothing else.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { SHIP_BLOCKED_OUTCOMES } from "./types";

const REGION = process.env.AWS_REGION || "us-east-1";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

type Fields = Record<string, unknown>;

const isConditionFailure = (err: unknown): boolean =>
  (err as { name?: string })?.name === "ConditionalCheckFailedException";

/** The table these writes target — exported so callers can log/assert on it. */
export const workflowsTable = WORKFLOWS_TABLE;

/**
 * TEAM-3755 F2 — the "not already terminal" half of a terminal-claim
 * ConditionExpression, built from ONE list so every terminal write (complete,
 * blocked-outcome, cancel) refuses the SAME five phases. It previously lived,
 * duplicated, in complete/route.ts and cancel/route.ts.
 *
 * Placeholders are positional (:tp0…) so they cannot collide with a write's own
 * values, and every declared value IS referenced — DynamoDB rejects unused ones.
 * PARITY with notTerminalPhaseGuard in lambda/orchestrator/completion.mjs.
 */
export const TERMINAL_PHASES = ["complete", "error", "cancelled", ...SHIP_BLOCKED_OUTCOMES] as const;

export function terminalPhaseGuard(): { condition: string; values: Record<string, string> } {
  const values: Record<string, string> = {};
  const condition = TERMINAL_PHASES.map((phase, i) => {
    const key = `:tp${i}`;
    values[key] = phase;
    return `#phase <> ${key}`;
  }).join(" AND ");
  return { condition, values };
}

// ─────────────────────────── task-entry writes ───────────────────────────

/**
 * Per-field SET paths for one task entry — never a whole-entry replacement, so
 * a metadata merge can't erase a concurrent claim/complete write. Returns null
 * when there is nothing settable. Hand-port of workflow-store.mjs
 * taskMetadataUpdate; `fill` swaps every SET for `if_not_exists(...)` (the
 * mark-done evidence path, which must never replace what is already there).
 */
function taskMetadataUpdate(
  ticketId: string,
  fields: Fields,
  opts: { fill?: boolean; dropEmptyStrings?: boolean; touchUpdatedAt?: boolean } = {}
): { UpdateExpression: string; ConditionExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues: Fields } | null {
  const names: Record<string, string> = { "#tid": ticketId };
  const values: Fields = {};
  const sets: string[] = [];
  if (opts.touchUpdatedAt) {
    names["#u"] = "updatedAt";
    values[":u"] = new Date().toISOString();
    sets.push("#u = :u");
  }
  let i = 0;
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined || v === null) continue;
    if (opts.dropEmptyStrings && v === "") continue;
    names[`#f${i}`] = k;
    values[`:v${i}`] = v;
    const path = `agentTasks.#tid.#f${i}`;
    sets.push(opts.fill ? `${path} = if_not_exists(${path}, :v${i})` : `${path} = :v${i}`);
    i++;
  }
  if (i === 0) return null;
  return {
    UpdateExpression: `SET ${sets.join(", ")}`,
    ConditionExpression: "attribute_exists(agentTasks.#tid)",
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

/** Seed the `agentTasks` map itself (a run created before the map existed). */
async function ensureAgentTasksMap(workflowId: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
      UpdateExpression: "SET agentTasks = if_not_exists(agentTasks, :emptyMap)",
      ExpressionAttributeValues: { ":emptyMap": {} },
    })
  );
}

/**
 * Track a ticket in agentTasks — first writer wins, so a concurrent tracker
 * keeps the existing entry. Returns true when THIS call created the entry, which
 * is what lets a lost CAS above be disambiguated ("no entry" vs "already
 * stamped" are the same ConditionalCheckFailedException). Twin: trackTicket.
 */
export async function trackTicket(workflowId: string, ticketId: string, entry: Fields): Promise<boolean> {
  await ensureAgentTasksMap(workflowId);
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
        UpdateExpression: "SET agentTasks.#tid = if_not_exists(agentTasks.#tid, :seed)",
        ConditionExpression: "attribute_not_exists(agentTasks.#tid)",
        ExpressionAttributeNames: { "#tid": ticketId },
        ExpressionAttributeValues: { ":seed": entry },
      })
    );
    return true;
  } catch (err) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

/**
 * Merge metadata fields into one task entry, dropping them when no entry exists
 * (rather than materializing a partial entry the claim/complete paths don't
 * own). Twin: mergeTaskMetadata. `touchUpdatedAt` also stamps the row's
 * `updatedAt` in the same write (the webhook completion path).
 */
export async function mergeTaskMetadata(
  workflowId: string,
  ticketId: string,
  fields: Fields,
  opts: { touchUpdatedAt?: boolean } = {}
): Promise<boolean> {
  const update = taskMetadataUpdate(ticketId, fields, opts);
  if (!update) return false;
  try {
    await ddb.send(new UpdateCommand({ TableName: WORKFLOWS_TABLE, Key: { workflowId }, ...update }));
    return true;
  } catch (err) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

/**
 * TEAM-4099 F6 — the manager mark-done evidence write: FILL-ONLY by default.
 *
 * The bug: this write was a plain scoped merge conditioned on nothing but
 * `attribute_exists(agentTasks.#tid)`, so a manager's `--evidence "looks done to
 * me"` REPLACED an agent's real `output` (and its branch/commitSha/prUrl) — the
 * console's own version of the clobber F4 fixed on the synthesis path. D1.3's
 * precedence (completions record → PR/branch probe → typed text) only chose what
 * the route would WRITE; it never protected what was already there.
 *
 * So, without `force`:
 *   - every field is `if_not_exists(agentTasks.#tid.<f>, :v)` — real branch/PR
 *     data harvested earlier is never replaced, only gaps are filled;
 *   - the condition adds `attribute_not_exists(agentTasks.#tid.output)`, so a
 *     row that already carries real evidence refuses the write outright and the
 *     caller reports EVIDENCE_EXISTS instead of silently winning.
 * `markedDoneBy` / `markedDoneAt` / `evidenceSource: "manager"` therefore land
 * ONLY when the write applies: the audit stamp cannot outlive its own evidence.
 *
 * With `force: true` (an explicit request-body flag — a human saying "yes, I
 * mean to replace it") the SETs are plain and the output condition is dropped.
 *
 * A lost CAS is ambiguous — no entry, or an entry with output. Disambiguated the
 * same way as claimGateBypassFlag/claimCompletionSynthesis: seed the entry via
 * trackTicket, which reports whether THIS call created it, and retry only then.
 * Not created ⇒ the entry existed ⇒ the refusal was the output condition.
 */
export async function markDoneEvidence(
  workflowId: string,
  ticketId: string,
  fields: Fields,
  opts: { force?: boolean; seed?: Fields } = {}
): Promise<{ applied: boolean; reason?: "evidence_exists" | "nothing_to_set" }> {
  const force = opts.force === true;
  const update = taskMetadataUpdate(ticketId, fields, { fill: !force, dropEmptyStrings: true });
  if (!update) return { applied: false, reason: "nothing_to_set" };
  const condition = force
    ? update.ConditionExpression
    : `${update.ConditionExpression} AND attribute_not_exists(agentTasks.#tid.#out)`;
  const names = force ? update.ExpressionAttributeNames : { ...update.ExpressionAttributeNames, "#out": "output" };

  const write = async (): Promise<boolean> => {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: WORKFLOWS_TABLE,
          Key: { workflowId },
          UpdateExpression: update.UpdateExpression,
          ConditionExpression: condition,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: update.ExpressionAttributeValues,
        })
      );
      return true;
    } catch (err) {
      if (isConditionFailure(err)) return false;
      throw err;
    }
  };

  if (await write()) return { applied: true };
  const created = await trackTicket(workflowId, ticketId, {
    ticketId,
    status: "pending",
    createdAt: new Date().toISOString(),
    ...(opts.seed || {}),
  });
  if (!created) return { applied: false, reason: "evidence_exists" };
  if (await write()) return { applied: true };
  // Someone reported real evidence into the entry we just seeded — they win.
  return { applied: false, reason: "evidence_exists" };
}

/** Set one task's status (claim release on a nudge/retry dispatch). Twin: setTaskStatus. */
export async function setTaskStatus(workflowId: string, ticketId: string, status: string): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
        UpdateExpression: "SET agentTasks.#tid.#st = :s",
        ConditionExpression: "attribute_exists(agentTasks.#tid)",
        ExpressionAttributeNames: { "#tid": ticketId, "#st": "status" },
        ExpressionAttributeValues: { ":s": status },
      })
    );
    return true;
  } catch (err) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

// ─────────────────────────── run-level writes ───────────────────────────

/**
 * TEAM-3703 D4b — claim the dedup marker for a (sourceTicket, defId) key.
 * First writer wins; the loser inspects the marker and coalesces. Returns true
 * when this caller owns the key.
 */
export async function claimDedupMarker(item: Fields): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: WORKFLOWS_TABLE,
        Item: item,
        ConditionExpression: "attribute_not_exists(workflowId)",
      })
    );
    return true;
  } catch (err) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

/**
 * Re-point an existing marker at a fresh run, guarded on the exact canonical id
 * the caller read (so a concurrent racer cannot double-claim). Returns false
 * when that guard lost — the caller re-reads and coalesces onto the winner.
 */
export async function repointDedupMarker(item: Fields, priorCanonical: string | undefined): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: WORKFLOWS_TABLE,
        Item: item,
        ConditionExpression: priorCanonical ? "canonicalWorkflowId = :old" : "attribute_not_exists(canonicalWorkflowId)",
        ...(priorCanonical ? { ExpressionAttributeValues: { ":old": priorCanonical } } : {}),
      })
    );
    return true;
  } catch (err) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

/** Read a workflow row (the marker re-read the fence needs). */
export async function getWorkflowRow(workflowId: string): Promise<Fields | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: WORKFLOWS_TABLE, Key: { workflowId }, ConsistentRead: true })
  );
  return (res.Item as Fields) || null;
}

/**
 * TEAM-3703 — write the canonical workflow row behind an atomic ownership FENCE.
 *
 * The marker is claimed BEFORE the epic + workflow row are created, and those
 * steps can take arbitrarily long, so by the time this caller writes its row the
 * marker may have been re-pointed at another racer (a legitimate recovery when
 * the first owner looked dead). A plain Put would land the loser's row anyway →
 * two live workflows for one key. For a dedup start the row is put inside a
 * transaction whose ConditionCheck requires the marker to still name US.
 *
 * Non-dedup starts (no marker) keep the plain unconditioned Put: the workflowId
 * is freshly minted per start, so there is nothing to collide with.
 *
 * Returns { won: true }, or { won: false, winner } when the fence was lost (no
 * row was written and the caller must coalesce). Throws on any other error,
 * including a cancelled transaction whose re-read still shows US as owner —
 * that is a transient conflict, not a loss.
 */
export async function putWorkflowRowFenced(
  item: Fields,
  markerId: string | undefined
): Promise<{ won: true } | { won: false; winner: string | undefined }> {
  const workflowId = item.workflowId as string;
  if (!markerId) {
    await ddb.send(new PutCommand({ TableName: WORKFLOWS_TABLE, Item: item }));
    return { won: true };
  }
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: WORKFLOWS_TABLE, Item: item } },
          {
            ConditionCheck: {
              TableName: WORKFLOWS_TABLE,
              Key: { workflowId: markerId },
              ConditionExpression: "canonicalWorkflowId = :me",
              ExpressionAttributeValues: { ":me": workflowId },
            },
          },
        ],
      })
    );
    return { won: true };
  } catch (err) {
    if ((err as { name?: string }).name !== "TransactionCanceledException") throw err;
    const marker = await getWorkflowRow(markerId);
    const winner = marker?.canonicalWorkflowId as string | undefined;
    if (winner === workflowId) throw err;
    return { won: false, winner };
  }
}

/**
 * TEAM-3686 — mark a just-created run terminal when intake-ticket creation
 * fails, so the dedup marker stops coalescing every future trigger onto a run
 * with zero tickets. Best-effort by construction: returns false (logged by the
 * caller) rather than masking the original failure.
 */
export async function markWorkflowStartError(workflowId: string, message: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
      UpdateExpression: "SET #phase = :error, erroredAt = :ts, startError = :msg",
      ExpressionAttributeNames: { "#phase": "phase" },
      ExpressionAttributeValues: { ":error": "error", ":ts": new Date().toISOString(), ":msg": message },
    })
  );
}

/**
 * Tombstone a terminal run: the row survives (Jira tickets keep `wf:<id>` labels
 * forever, so a hard delete broke ticket→workflow-type resolution) carrying only
 * what metrics/type resolution need. Unconditioned on purpose — the caller has
 * already proved the run is terminal, and the tombstone must land even if the
 * row changed underneath.
 */
export async function tombstoneWorkflow(item: Fields): Promise<void> {
  await ddb.send(new PutCommand({ TableName: WORKFLOWS_TABLE, Item: item }));
}

/** Archive / unarchive (idempotent — archiving an archived run is a 200). */
export async function setArchived(workflowId: string, archivedAt: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
      UpdateExpression: "SET archived = :true, archivedAt = :ts",
      ExpressionAttributeValues: { ":true": true, ":ts": archivedAt },
    })
  );
}

/** Toggle the Workflow Manager watchdog for one run. */
export async function setManagerWatch(workflowId: string, watch: boolean): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
        UpdateExpression: "SET managerWatch = :w",
        ConditionExpression: "attribute_exists(workflowId)",
        ExpressionAttributeValues: { ":w": watch },
      })
    );
    return true;
  } catch (err) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

/**
 * TEAM-3755 — claim the cancellation. Refuses all five terminal phases, so a
 * cancel arriving behind an honest deploy-blocked / static-ci-only close cannot
 * overwrite that verdict. Returns false when the CAS lost (already terminal).
 */
export async function claimCancellation(
  workflowId: string,
  { cancelledAt, previousPhase, reason }: { cancelledAt: string; previousPhase: unknown; reason?: string }
): Promise<boolean> {
  const guard = terminalPhaseGuard();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
        UpdateExpression:
          "SET #phase = :cancelled, cancelledAt = :ts, previousPhase = :prev" + (reason ? ", cancelReason = :reason" : ""),
        ConditionExpression: guard.condition,
        ExpressionAttributeNames: { "#phase": "phase" },
        ExpressionAttributeValues: {
          ":cancelled": "cancelled",
          ":ts": cancelledAt,
          ":prev": previousPhase,
          ...guard.values,
          ...(reason ? { ":reason": reason } : {}),
        },
      })
    );
    return true;
  } catch (err) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

/**
 * Complete the run exactly once. Twin: completeWorkflow.
 *
 * The CAS refuses all five terminal phases AND a stamped `cancelledAt` (a cancel
 * landing between the caller's pre-read and this write stamps cancelledAt before
 * phase flips, and must not be overwritten). `epicRollupPending` is stamped in
 * the SAME write, so the roll-up obligation belongs to exactly one caller — the
 * CAS winner — and a crash leaves a flag the reconcile sweep retries.
 *
 * `humanNotifications` is the ONE full-list write here, and deliberately: it
 * carries the COMPACTED list, shrinking an item bloated by thousands of no-op
 * escalations so this terminal write can land at all. It is safe because the run
 * is going terminal in the same write — nothing appends after it.
 */
export async function completeWorkflow(
  workflowId: string,
  {
    completedAt,
    previousPhase,
    notifications,
    epicRollupPending = false,
    completeReason,
  }: {
    completedAt: string;
    previousPhase: unknown;
    notifications: unknown[];
    epicRollupPending?: boolean;
    completeReason?: string;
  }
): Promise<boolean> {
  const guard = terminalPhaseGuard();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
        UpdateExpression:
          "SET #phase = :complete, completedAt = :ts, previousPhase = :prev, managerWatch = :false, " +
          (epicRollupPending ? "epicRollupPending = :pending, " : "") +
          "humanNotifications = :notifs" +
          (completeReason ? ", completeReason = :reason" : ""),
        ConditionExpression: `${guard.condition} AND attribute_not_exists(cancelledAt)`,
        ExpressionAttributeNames: { "#phase": "phase" },
        ExpressionAttributeValues: {
          ":complete": "complete",
          ":ts": completedAt,
          ":prev": previousPhase,
          ":false": false,
          ":notifs": notifications,
          ...(epicRollupPending ? { ":pending": true } : {}),
          ...guard.values,
          ...(completeReason ? { ":reason": completeReason } : {}),
        },
      })
    );
    return true;
  } catch (err) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

/**
 * TEAM-3747 D2 — close a run on an HONEST NON-"complete" terminal outcome
 * ("deploy-blocked" / "static-ci-only"). Same CAS shape and idempotency as
 * completeWorkflow. Twin: claimTerminalOutcome.
 */
export async function claimTerminalOutcome(
  workflowId: string,
  {
    outcome,
    completedAt,
    previousPhase,
    notifications,
    blockReason,
  }: {
    outcome: string;
    completedAt: string;
    previousPhase: unknown;
    notifications: unknown[];
    blockReason?: string | null;
  }
): Promise<boolean> {
  const guard = terminalPhaseGuard();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
        UpdateExpression:
          "SET #phase = :outcome, completedAt = :ts, previousPhase = :prev, managerWatch = :false, humanNotifications = :notifs" +
          (blockReason ? ", blockReason = :reason" : ""),
        ConditionExpression: `${guard.condition} AND attribute_not_exists(cancelledAt)`,
        ExpressionAttributeNames: { "#phase": "phase" },
        ExpressionAttributeValues: {
          ":outcome": outcome,
          ":ts": completedAt,
          ":prev": previousPhase,
          ":false": false,
          ":notifs": notifications,
          ...guard.values,
          ...(blockReason ? { ":reason": blockReason } : {}),
        },
      })
    );
    return true;
  } catch (err) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

/**
 * Discharge the epic roll-up obligation the terminal claim created. Conditional
 * on the flag still being there, so a concurrent sweep that already cleared it
 * is a no-op rather than a blind REMOVE. Twin: clearEpicRollupPending.
 */
export async function clearEpicRollupPending(workflowId: string): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
        UpdateExpression: "REMOVE epicRollupPending",
        ConditionExpression: "attribute_exists(epicRollupPending)",
      })
    );
    return true;
  } catch (err) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

/** Seed `reviewGateHistory` and the one gate's sub-map (idempotent). */
async function ensureReviewGateLedger(workflowId: string, gateTicketId: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
      UpdateExpression: "SET reviewGateHistory = if_not_exists(reviewGateHistory, :emptyMap)",
      ExpressionAttributeValues: { ":emptyMap": {} },
    })
  );
  await ddb.send(
    new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
      UpdateExpression: "SET reviewGateHistory.#g = if_not_exists(reviewGateHistory.#g, :seed)",
      ExpressionAttributeNames: { "#g": gateTicketId },
      ExpressionAttributeValues: { ":seed": { rounds: [], authorizations: [], escalations: [] } },
    })
  );
}

/**
 * TEAM-3991 F6 — append to the gate DECISION ledger, the authoritative record of
 * merge authority (the gate-bypass detector compares each merged PR's `mergedAt`
 * against these rows, not against the gate ticket's board status).
 *
 * SECURITY: only human-authenticated paths may call this. list_append, never a
 * whole-array rewrite, so a console click and a Telegram reply landing together
 * are both recorded. Twin: appendGateDecision.
 */
export async function appendGateDecision(workflowId: string, gateTicketId: string, decision: Fields): Promise<void> {
  await ensureReviewGateLedger(workflowId, gateTicketId);
  await ddb.send(
    new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
      UpdateExpression:
        "SET reviewGateHistory.#g.decisions = list_append(if_not_exists(reviewGateHistory.#g.decisions, :empty), :d)",
      ExpressionAttributeNames: { "#g": gateTicketId },
      ExpressionAttributeValues: { ":empty": [], ":d": [decision] },
    })
  );
}

/**
 * TEAM-4099 F6 — acknowledge notifications by INDEX, not by rewriting the list.
 *
 * The escalations route used to read `humanNotifications`, mutate the array in
 * memory and write `SET humanNotifications = :n`. Anything appended in that gap
 * — an escalation from the orchestrator's appendNotification, a review_needed —
 * was silently deleted, and an open human gate that vanishes is a run nobody
 * knows is stuck.
 *
 * DynamoDB cannot update list items by predicate, so the read is unavoidable;
 * what is avoidable is writing back the whole list. Instead each match becomes
 * its own scoped write on `humanNotifications[i]`, conditioned on that index
 * still holding the id we matched (`humanNotifications[i].id = :id`) so a list
 * that shifted underneath us refuses rather than acking the wrong row. The same
 * write bumps `notifVersion`, which is the version a concurrent
 * appendNotificationOnce / ackNotifications in the orchestrator CASes on — so
 * their read-modify-write re-reads instead of resurrecting our pre-ack copy.
 *
 * NOTE the deliberate divergence from the orchestrator twin (ackNotifications in
 * workflow-store.mjs), which is still a versioned full-list rewrite: it acks by
 * arbitrary predicate over notifications that may have no id at all. This path
 * always has ids (the console/Telegram hand one back), so it can be strictly
 * scoped. Rows with no id are skipped and reported, never blind-written.
 *
 * Returns the ids actually acknowledged.
 */
export async function ackNotifications(
  workflowId: string,
  predicate: (n: Fields) => boolean,
  acknowledgedAt: string = new Date().toISOString()
): Promise<{ acknowledged: string[]; skipped: string[] }> {
  const wf = await getWorkflowRow(workflowId);
  const list = Array.isArray(wf?.humanNotifications) ? (wf!.humanNotifications as Fields[]) : [];
  const acknowledged: string[] = [];
  const skipped: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (!n || n.acknowledged === true || !predicate(n)) continue;
    const id = typeof n.id === "string" ? n.id : "";
    if (!id) {
      // No id ⇒ no way to prove we are acking the row we read. Refuse rather
      // than write blind at an index that may have shifted.
      skipped.push(String(i));
      continue;
    }
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: WORKFLOWS_TABLE,
          Key: { workflowId },
          UpdateExpression:
            `SET humanNotifications[${i}].acknowledged = :true, humanNotifications[${i}].acknowledgedAt = :ts, ` +
            "notifVersion = if_not_exists(notifVersion, :zero) + :one",
          ConditionExpression: `humanNotifications[${i}].id = :id`,
          ExpressionAttributeValues: { ":true": true, ":ts": acknowledgedAt, ":id": id, ":zero": 0, ":one": 1 },
        })
      );
      acknowledged.push(id);
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
      // The list moved under us — that row is someone else's now.
      skipped.push(id);
    }
  }
  return { acknowledged, skipped };
}

/**
 * TEAM-3991 D1.5 — persist the resume context the orchestrator's
 * `consumeResumeContext` reads (`resumeContexts.<ticketId>`). Seed the map, then
 * a scoped SET of the one key — never a whole-map rewrite, so two concurrent
 * resumes cannot clobber each other. Twin: setResumeContext.
 */
export async function setResumeContext(workflowId: string, ticketId: string, note: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
      UpdateExpression: "SET resumeContexts = if_not_exists(resumeContexts, :empty)",
      ExpressionAttributeValues: { ":empty": {} },
    })
  );
  await ddb.send(
    new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
      UpdateExpression: "SET resumeContexts.#k = :note",
      ExpressionAttributeNames: { "#k": ticketId },
      ExpressionAttributeValues: { ":note": note },
    })
  );
}
