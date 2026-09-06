/**
 * ─── Blocker-edge writes for the DynamoDB tickets table (TEAM-4130 F1) ────────
 *
 * `addBlockers` in index.mjs used to do ONE conditional write per blocker that
 * appended the edge AND set `status = "blocked"` in the same UpdateExpression.
 * That is right for every caller that is about to park a ticket nobody is
 * running (dead-session escalation; sync-main's pre-flight, whose CI ticket is
 * `in_progress` at call time and RELIES on the flip). It is wrong for
 * live-reverify, which blocks the run's OPEN ship tickets: a release manager
 * that is mid-run (`in_progress`, or a human gate in `in_review`) gets its
 * status yanked to `blocked`, and from `blocked` the agent's own
 * report_completion can no longer reach Done through the real `done` transition
 * — the tickets Lambda's TRANSITIONS.blocked has no `done` row, so `to_status:
 * "done"` only resolves by falling through the `skip` row's `to` alias, which
 * records a SKIP where a completion belongs.
 *
 * So the status write is now opt-in-preservable: a caller passes the statuses
 * that must survive, and the decision is made INSIDE the conditional write (a
 * read-then-write would race the agent's own transition). Two attempts:
 *
 *   1. today's write (edge + `status = "blocked"`), additionally conditioned on
 *      the current status NOT being one of the preserved ones;
 *   2. on ConditionalCheckFailedException, an edge-ONLY write conditioned on the
 *      status BEING one of the preserved ones.
 *
 * Exactly one can succeed. If both fail the edge was already there (the first
 * clause of both conditions), which is the idempotent no-op case.
 *
 * Zero imports on purpose: the AWS command object is constructed by the caller
 * and handed in as `send`, so this module is unit-testable with a plain fake and
 * loads in isolation.
 */

/**
 * ─── The id of a ticket we just created, under EITHER provider (TEAM-4156 F1) ──
 *
 * It lives in this module because this module has zero imports, so all three
 * create_ticket producers (sync-main.mjs, live-reverify.mjs,
 * dead-session-escalation.mjs) can share it with no chance of an import cycle —
 * they have no other module in common. It is a ticket-shape reader rather than a
 * blocker-edge builder, but every one of its callers is about to hand the result
 * to `addBlockers`, which is what this module is for.
 *
 * The two ticket backends have ALWAYS answered create_ticket differently:
 *   DynamoDB (lambda/agentcore-hub-tickets) → `{ key, ticket: { key } }`
 *   Jira     (lambda/agentcore-hub-jira)    → `{ ticketId }` on a fresh create,
 *      and `{ ...mapIssue(dup), deduplicated: true }` — also `ticketId` — when it
 *      dedupes against an existing summary.
 * Every producer read `res?.key || res?.ticket?.key`, so under
 * TICKET_PROVIDER=jira (what `.env.example` and the Dockerfile ship) all three
 * read `null` and took their fail-open branch: the ticket really existed on the
 * board, but nothing blocked on it and nothing said why.
 *
 * Strings only. A provider answering `{ key: { value: "X" } }` or
 * `{ ticketId: 42 }` has given us something that is not a ticket id, and putting
 * it into a blocker edge or a `syncMain` record would corrupt the run — so a
 * non-string candidate is skipped rather than trusted, and an object with no
 * usable id at all reads null (which every caller already handles).
 */
export function createdTicketId(res) {
  for (const v of [res?.key, res?.ticketId, res?.ticket?.key, res?.ticket?.ticketId]) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Statuses, normalized the way the board stores them (lowercase, deduped). */
export function normalizePreserveStatuses(statuses) {
  if (!Array.isArray(statuses)) return [];
  const out = [];
  for (const s of statuses) {
    if (typeof s !== "string") continue;
    const norm = s.trim().toLowerCase();
    if (norm && !out.includes(norm)) out.push(norm);
  }
  return out;
}

/**
 * The one or two UpdateCommand inputs a single blocker edge needs. With an empty
 * `preserveStatusIf` this returns exactly ONE input, byte-for-byte the write
 * addBlockers has always issued.
 */
export function buildAddBlockerUpdates({ table, ticketId, blockerId, preserveStatusIf = [], now }) {
  const preserve = normalizePreserveStatuses(preserveStatusIf);
  const notLinked = "attribute_not_exists(blockedBy) OR NOT contains(blockedBy, :id)";
  const appendEdge = "SET blockedBy = list_append(if_not_exists(blockedBy, :empty), :one)";
  const base = { ":empty": [], ":one": [blockerId], ":id": blockerId, ":now": now };

  if (!preserve.length) {
    return [{
      TableName: table,
      Key: { ticketId },
      UpdateExpression: `${appendEdge}, #s = :blocked, #u = :now`,
      ConditionExpression: notLinked,
      ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
      ExpressionAttributeValues: { ...base, ":blocked": "blocked" },
    }];
  }

  // `#s IN (…)` over positional placeholders — same idiom as the gate-state
  // guard's refused-state list, so the caller's array is the only source.
  const psList = preserve.map((_, i) => `:ps${i}`).join(", ");
  const psValues = {};
  preserve.forEach((s, i) => { psValues[`:ps${i}`] = s; });

  return [
    {
      TableName: table,
      Key: { ticketId },
      UpdateExpression: `${appendEdge}, #s = :blocked, #u = :now`,
      ConditionExpression: `(${notLinked}) AND (attribute_not_exists(#s) OR NOT (#s IN (${psList})))`,
      ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
      ExpressionAttributeValues: { ...base, ...psValues, ":blocked": "blocked" },
    },
    {
      // No `:blocked` value here — DynamoDB rejects an unused
      // ExpressionAttributeValue, and this write deliberately leaves the
      // running agent's status exactly where it is.
      TableName: table,
      Key: { ticketId },
      UpdateExpression: `${appendEdge}, #u = :now`,
      ConditionExpression: `(${notLinked}) AND #s IN (${psList})`,
      ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
      ExpressionAttributeValues: { ...base, ...psValues },
    },
  ];
}

/**
 * Write ONE blocker edge. `send(input)` wraps the caller's DDB doc client (it is
 * what constructs the UpdateCommand). Returns the outcome so the caller can log
 * it and decide whether the blocker counts as added:
 *
 *   "blocked"   — edge added, status set to `blocked` (attempt 1)
 *   "preserved" — edge added, status left untouched (attempt 2)
 *   "present"   — the edge was already there; nothing written
 *   "error"     — a non-conditional failure; warned, nothing to assume
 *
 * Never throws: a blocker edge is advisory bookkeeping on the done cascade, and
 * every existing caller treats a failure as non-fatal.
 */
export async function applyBlockerEdge({ send, table, ticketId, blockerId, preserveStatusIf = [], now, warn }) {
  const [attempt1, attempt2] = buildAddBlockerUpdates({ table, ticketId, blockerId, preserveStatusIf, now });
  const isCcfe = (err) => err?.name === "ConditionalCheckFailedException";
  try {
    await send(attempt1);
    return "blocked";
  } catch (err) {
    if (!isCcfe(err)) {
      warn?.(`[orchestrator] addBlockers: ${ticketId} += ${blockerId} failed (non-fatal): ${err?.message || err}`);
      return "error";
    }
    if (!attempt2) return "present";
  }
  try {
    await send(attempt2);
    return "preserved";
  } catch (err) {
    if (isCcfe(err)) return "present";
    warn?.(`[orchestrator] addBlockers: ${ticketId} += ${blockerId} (status-preserving) failed (non-fatal): ${err?.message || err}`);
    return "error";
  }
}
