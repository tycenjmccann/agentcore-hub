/**
 * Unblock cascade — the ONE shared helper behind both "ticket done" paths.
 *
 * TEAM-3618 D3. The orchestrator has two entry points that fan a completion out
 * to a ticket's dependents:
 *   - the Jira-webhook path  (index.mjs handleTicketDoneUnified)
 *   - the DDB-stream path    (index.mjs handleTicketDone)
 * These two copies had DIVERGED: the unified path re-Readied dependents whose
 * status was {blocked, todo}; the stream twin matched ONLY "blocked", and it
 * never emitted the orchestrator.unblocked journal events. A ticket unblocked
 * via the stream therefore silently stalled if it had been parked in "todo".
 *
 * cascadeUnblock() is the single source of truth for the cascade: it owns the
 * blocker-resolution predicate, the provider branching (Jira transition vs DDB
 * status write), and the orchestrator.unblocked journal events. Both call sites
 * now delegate to it, so they behave identically (commit 4a = the UNION of the
 * two prior behaviors: {blocked, todo} → Ready in BOTH paths).
 *
 * Every effect is injected (ddb / provider / event publisher / child lookup),
 * so the cascade is unit-testable with stubs and a fake clock — same DI shape
 * as dead-session-detector.mjs.
 */

import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

export function createCascade(deps) {
  const {
    ddb,
    ticketsTable,
    provider,
    jiraTransition,
    getChildTickets,
    publishEvent,
    now = () => Date.now(),
    log = () => {},
  } = deps;

  /**
   * Fan a just-closed ticket's completion out to its dependents.
   *
   * For every sibling that lists `ticketId` in blockedBy, once ALL of that
   * sibling's blockers are done/cancelled and the sibling is still waiting
   * ({blocked, todo}), transition it to Ready and record an
   * orchestrator.unblocked journal event. blockedBy is never mutated — it is a
   * permanent record of the dependency graph.
   *
   * Returns the array of dependent ticketIds transitioned to Ready. The caller
   * keeps ownership of its own agent.complete publish and completion check.
   */
  async function cascadeUnblock(ticketId, parentId, workflow) {
    const siblings = await getChildTickets(parentId);
    const unblocked = [];

    for (const sibling of siblings) {
      if (sibling.ticketId === ticketId) continue;
      const blockers = sibling.blockedBy || [];
      if (!blockers.includes(ticketId)) continue;

      // Blocker-resolution predicate — UNCHANGED from both original copies:
      // every blockedBy entry is done/cancelled (this one just closed). Uses the
      // siblings snapshot, not a fresh per-blocker lookup (matches prior code).
      const allResolved = blockers.every((bid) => {
        if (bid === ticketId) return true; // this one is done
        const blocker = siblings.find((s) => s.ticketId === bid);
        return blocker && (blocker.status === "done" || blocker.status === "cancelled");
      });
      if (!allResolved) continue;

      // Commit 4a (union). The stream twin previously matched only "blocked";
      // Readying a parked "todo" dependent here is the divergence fix.
      if (sibling.status === "blocked" || sibling.status === "todo") {
        await transitionToReady(sibling);
        unblocked.push(sibling.ticketId);
      }
      // Any other status (in_progress / in_review / terminal) is untouched in
      // commit 4a — extended-state handling arrives behind a flag in 4b.
    }

    log(`[orchestrator] ${ticketId} cascade — unblocked=[${unblocked.join(", ")}]`);

    // Journey log: one orchestrator.unblocked per Ready transition. The helper
    // OWNS this event so BOTH call sites emit an identical journal trail (the
    // stream twin previously omitted it entirely).
    for (const unblockedId of unblocked) {
      await publishEvent(unblockedId, "orchestrator.unblocked", {
        ticketId: unblockedId, unblockedBy: ticketId, workflowId: workflow?.id,
      });
    }

    return unblocked;
  }

  /**
   * Provider branching — EXACTLY as the original copies. Jira hops the ticket to
   * "Ready"; the DDB board sets "todo" (a no-blocker todo is invocable there).
   */
  async function transitionToReady(sibling) {
    if (provider === "jira") {
      await jiraTransition(sibling.ticketId, "Ready");
    } else {
      await ddb.send(new UpdateCommand({
        TableName: ticketsTable,
        Key: { ticketId: sibling.ticketId },
        UpdateExpression: "SET #s = :s, #u = :u",
        ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
        ExpressionAttributeValues: { ":s": "todo", ":u": new Date(now()).toISOString() },
      }));
    }
  }

  return { cascadeUnblock };
}
