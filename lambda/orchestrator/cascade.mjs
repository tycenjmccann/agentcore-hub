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
 *
 * TEAM-3618 D3 commit 4b (behind CASCADE_EXTENDED_STATES, default OFF): when the
 * LAST blocker of an ALREADY-MOVING dependent resolves, cascadeUnblock also
 *   - in_progress: lease-guarded. LIVE lease → orchestrator.nudge only (context
 *     signal, ZERO steal/claim attempts). STALE lease → stealClaim CAS on the
 *     generation, and on a win re-dispatch through the normal claim CAS (the
 *     claim CAS is the final arbiter — a live claim always wins, AC-D3.3).
 *   - in_review: re-wake the parked/reopened human-review gate — emit
 *     review.reawakened and re-run the existing gate readiness path.
 * Off by default → these are no-ops and only the commit-4a union runs.
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
    // Extended-states (commit 4b) — all optional; guarded by extendedStates.
    extendedStates = false,
    lease,
    eventsTable,
    workflowsTable,
    redispatch,
    reawakenGate,
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
    const m = { nudged: 0, skippedLiveLease: 0, redispatched: 0, reviewReawakened: 0 };

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
        continue;
      }

      // Commit 4b (CASCADE_EXTENDED_STATES). The last blocker of an ALREADY-
      // MOVING dependent just resolved. Off by default → no-op (commit-4a only).
      if (!extendedStates) continue;
      if (sibling.status === "in_progress") {
        await handleInProgressDependent(sibling, ticketId, workflow, m);
      } else if (sibling.status === "in_review") {
        await handleInReviewDependent(sibling, ticketId, workflow, m);
      }
      // done / cancelled / any other terminal state → no-op.
    }

    log(`[orchestrator] ${ticketId} cascade — unblocked=[${unblocked.join(", ")}]` +
      (extendedStates ? ` nudged=${m.nudged} redispatched=${m.redispatched} reviewReawakened=${m.reviewReawakened}` : ""));

    // Journey log: one orchestrator.unblocked per Ready transition. The helper
    // OWNS this event so BOTH call sites emit an identical journal trail (the
    // stream twin previously omitted it entirely).
    for (const unblockedId of unblocked) {
      await publishEvent(unblockedId, "orchestrator.unblocked", {
        ticketId: unblockedId, unblockedBy: ticketId, workflowId: workflow?.id,
      });
    }

    if (m.nudged || m.skippedLiveLease || m.redispatched || m.reviewReawakened) {
      emitCascadeMetrics(m);
    }

    return unblocked;
  }

  /**
   * A dependent already in_progress whose last blocker just resolved. NEVER
   * steal a live lease and NEVER attempt a claim against one — a live agent is
   * doing the work; a re-dispatch would duplicate the session. The lease check
   * (R3, lease.mjs) is the sole authority for liveness.
   */
  async function handleInProgressDependent(sibling, unblockedBy, workflow, m) {
    const agentId = sibling.assignee;
    const task = workflow?.agentTasks?.[sibling.ticketId];
    const lastActivity = await lease.lastAgentActivity(
      ddb, eventsTable, workflow?.id, agentId, sibling.ticketId
    );
    if (lease.isLeaseLive(task, lastActivity, now())) {
      // LIVE lease — context signal ONLY. Zero steal, zero claim (AC-D3.3).
      await publishEvent(sibling.ticketId, "orchestrator.nudge", {
        agentId, unblockedBy, workflowId: workflow?.id,
      });
      m.nudged++;
      m.skippedLiveLease++;
      log(`[orchestrator] cascade nudge (live lease) — ${sibling.ticketId} agent=${agentId}`);
      return;
    }
    // STALE lease — steal the exact generation (CAS on startedAt), then
    // re-dispatch through the normal claim CAS. Both CAS steps are arbiters: a
    // fresh claim that raced in makes the steal OR the re-dispatch lose, and we
    // stop — a re-dispatch against a live lease is structurally refused.
    const stole = await lease.stealClaim(
      ddb, workflowsTable, workflow?.id, sibling.ticketId, task?.startedAt
    );
    if (!stole) {
      log(`[orchestrator] cascade steal lost — ${sibling.ticketId} (claim moved)`);
      return;
    }
    const dispatched = await redispatch(workflow, sibling);
    if (dispatched) {
      m.redispatched++;
      log(`[orchestrator] cascade re-dispatch — ${sibling.ticketId} agent=${agentId}`);
    } else {
      log(`[orchestrator] cascade re-dispatch refused — ${sibling.ticketId} (claim CAS lost)`);
    }
  }

  /**
   * A dependent parked in_review (a human-review gate) whose last blocker just
   * resolved — e.g. a reopened gate whose rework fix children have all closed.
   * Re-wake the gate: emit review.reawakened and re-run the EXISTING gate
   * readiness path (re-parks in_review idempotently + refreshes the reviewer
   * notification if none is open). No ticket-status write beyond what that gate
   * logic itself decides.
   */
  async function handleInReviewDependent(sibling, unblockedBy, workflow, m) {
    await publishEvent(sibling.ticketId, "review.reawakened", {
      gateTicketId: sibling.ticketId, unblockedBy, workflowId: workflow?.id,
    });
    if (reawakenGate) {
      await reawakenGate(sibling.ticketId, sibling.assignee, workflow);
    }
    m.reviewReawakened++;
    log(`[orchestrator] cascade review re-wake — ${sibling.ticketId}`);
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

/**
 * Emit the extended-state cascade actions as a single EMF record
 * (AgentCoreHub/Orchestrator namespace) — same emitter shape as the detector's
 * emitMetrics. Only called when at least one extended action fired, so the
 * commit-4a-only path stays silent.
 */
export function emitCascadeMetrics(m) {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: "AgentCoreHub/Orchestrator",
        Dimensions: [[]],
        Metrics: [
          { Name: "CascadeNudgeLiveLease", Unit: "Count" },
          { Name: "CascadeSkippedLiveLease", Unit: "Count" },
          { Name: "CascadeRedispatch", Unit: "Count" },
          { Name: "CascadeReviewReawaken", Unit: "Count" },
        ],
      }],
    },
    CascadeNudgeLiveLease: m.nudged,
    CascadeSkippedLiveLease: m.skippedLiveLease,
    CascadeRedispatch: m.redispatched,
    CascadeReviewReawaken: m.reviewReawakened,
  }));
}
