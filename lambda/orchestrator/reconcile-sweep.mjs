/**
 * Missed-unblock reconciliation sweep — orchestrator (TEAM-3747 D1).
 *
 * A scheduled EventBridge rule invokes the orchestrator with the sentinel
 * { source: "orchestrator.sweep", action: "reconcile_sweep" }. This module owns
 * the sweep: scan non-terminal workflows for dependents that are PARKED
 * (in_progress / in_review) or READY/todo/blocked whose blockers are ALL
 * satisfied (done/cancelled) but which never received their unblock event, and
 * re-drive them idempotently.
 *
 * WHY it exists: the unblock cascade (cascade.mjs) fires only when a blocker
 * closes. If that cascade is missed — the orchestrator crashed between the
 * blocker's completion and the fan-out, an EventBridge/stream delivery was
 * dropped, or the eventually-consistent parentId-index re-fetch still hadn't
 * caught up on the one bounded retry — a dependent can stall FOREVER (no other
 * event will ever re-drive it). This periodic sweep is the safety net.
 *
 * Hard invariants (mirrors dead-session-detector.mjs / docs/race-condition-study):
 *   R2 — every workflows-table write goes through workflow-store.mjs (the
 *        recovery here routes through the cascade's redispatch/steal, which use
 *        the store).
 *   R3 — lease semantics are NEVER re-implemented here. Every candidate is gated
 *        on isLeaseLive FIRST via the cascade's reconcileDependent(): a live
 *        lease gets at most a nudge, ZERO steals. The sweep does not call
 *        lease.mjs directly — it routes candidates through the ONE
 *        implementation of the invariant that cascade.mjs exports, so the
 *        LIVE-nudge / STALE-steal logic is never duplicated.
 *   Idempotent — recovery goes through the claim CAS (redispatch) or the
 *        generation-CAS steal, so a second sweep over an already-recovered
 *        ticket loses that CAS harmlessly (a no-op).
 *
 * Modes (RECONCILE_SWEEP_MODE): off = skip; shadow (default) = full scan +
 * logs/metrics of what WOULD be re-driven, but ZERO writes; enforce = re-drive
 * for real. Fails SAFE: the value is trimmed + lowercased and anything that is
 * not exactly off|shadow|enforce is coerced to shadow with a loud warning.
 *
 * Testability: all effects (ddb, cascade, getChildTickets, clock) are injected
 * via `deps`, so the sweep runs against stubs with no AWS — same DI shape as the
 * detector and the cascade.
 */

import { newMetrics as newCascadeMetrics, blockerUnion } from "./cascade.mjs";
// The ONE open-workflow scan, shared with dead-session-detector.mjs
// (TEAM-3839). Carries the TEAM-3764 F5 rotating window and the TEAM-3755
// F8-derived terminal-phase filter. SWEEP_ROTATION_QUANTUM_MS is re-exported
// unchanged for existing importers.
import { SWEEP_CAP, SWEEP_ROTATION_QUANTUM_MS, createOpenWorkflowScan } from "./sweep-scan.mjs";
export { SWEEP_ROTATION_QUANTUM_MS };

const KNOWN_MODES = ["off", "shadow", "enforce"];

// A dependent is a candidate only once it has been parked longer than this —
// so the sweep never races a normal in-flight cascade (which fires within
// seconds of a blocker closing). Floored at the lease TTL: the same window the
// dead-session detector treats as "long enough to be suspicious".
const DEFAULT_MIN_PARKED_MS = 30 * 60 * 1000; // 30m fallback if no lease TTL given

// Statuses a reconcile candidate can be parked in. done/cancelled are terminal;
// pending is pre-dispatch bookkeeping, not a stalled dependent.
const CANDIDATE_STATUSES = new Set(["blocked", "todo", "ready", "in_progress", "in_review"]);
const TERMINAL_TICKET_STATUSES = new Set(["done", "cancelled"]);

/**
 * Build a sweep runner bound to its dependencies. Stateless across sweeps (no
 * cache to keep) — a cold start behaves identically to a warm one.
 */
export function createReconcileSweep(deps) {
  const {
    ddb,
    workflowsTable,
    cascade,          // createCascade(...) instance — exposes reconcileDependent
    getChildTickets,  // (parentId) → sibling ticket rows (same source as the cascade)
    leaseTtlMs,       // used to floor the min-parked window (R3 alignment)
    // TEAM-4166 D1/D2 — optional awaited-ids module. When absent the sweep behaves
    // exactly as pre-4166 (the backstop + wait-SLA blocks below are simply
    // skipped), so existing tests stay green.
    awaitedIds,
    now = () => Date.now(),
    log = (msg) => console.log(`[orchestrator] ${msg}`),
  } = deps;

  const minParkedMs = Number.isFinite(leaseTtlMs) && leaseTtlMs > 0
    ? leaseTtlMs
    : DEFAULT_MIN_PARKED_MS;

  /**
   * Scan workflows in a non-terminal phase, newest first, capped at SWEEP_CAP.
   * Shared implementation (sweep-scan.mjs, TEAM-3839) — identical semantics to
   * the local copy it replaces: an over-cap result rotates which
   * SWEEP_CAP-sized chunk is returned (TEAM-3764 F5) so every open workflow is
   * eventually inspected, and the phase filter is derived from the shared
   * TERMINAL_WORKFLOW_PHASES list (TEAM-3755 F8). Returns
   * { workflows, matched, rotation, pages } so the caller can flag truncation.
   */
  const scanNonTerminalWorkflows = createOpenWorkflowScan({ ddb, workflowsTable, now });

  /**
   * Every blockedBy entry of `ticket` reads done/cancelled in `snapshot`. Same
   * predicate the cascade uses (evaluated against a supplied snapshot, not a
   * fresh per-blocker read). A ticket with no blockers is vacuously satisfied —
   * a stalled no-blocker todo/ready is a missed DISPATCH, still worth reconciling.
   */
  function allBlockersResolved(ticket, snapshot) {
    // TEAM-4166 D1 — the UNION of blockedBy edges and preconditionUnmet.awaitingIds
    // (a tool-reported id that hasn't been edge-written yet still gates re-dispatch).
    return blockerUnion(ticket).every((bid) => {
      const blocker = snapshot.find((s) => s.ticketId === bid);
      return blocker && TERMINAL_TICKET_STATUSES.has(blocker.status);
    });
  }

  /** Parked long enough to be a stall, not an in-flight cascade. */
  function parkedLongEnough(ticket, nowMs) {
    const updated = ticket.updatedAt ? Date.parse(ticket.updatedAt) : NaN;
    if (!Number.isFinite(updated)) return true; // no timestamp → it's been around
    return nowMs - updated >= minParkedMs;
  }

  /**
   * TEAM-4166 D1/D2 — the awaited-ids backstop, run for every non-terminal child
   * carrying preconditionUnmet.awaitingIds, INDEPENDENT of the candidate gate
   * (a child still awaiting open fixes never passes allBlockersResolved, but its
   * edges still need backfilling and its wait still needs an SLA):
   *   1. Backfill: any awaited id that never became a blockedBy edge (the tool
   *      report landed but the level-triggered pickup was missed) is written now
   *      — idempotent via applyBlockerEdge "present".
   *   2. Wait-SLA: once the wait exceeds AWAITED_IDS_TIMEOUT_MINUTES, emit the
   *      once-only advisory orchestrator.await_timeout — an event, never a
   *      humanNotification (so it can't trip parkedOnHuman).
   * Both are writes, so they run only in an enforce sweep; shadow logs the intent.
   */
  async function handleAwaitedChild(sibling, siblings, workflow, m, mode, sweepId) {
    const awaitingIds = sibling.preconditionUnmet?.awaitingIds;
    if (!Array.isArray(awaitingIds) || !awaitingIds.length) return;

    const edges = new Set(sibling.blockedBy || []);
    const missingEdge = awaitingIds.some((id) => !edges.has(id));

    if (mode !== "enforce") {
      if (missingEdge) log(`reconcile.would_backfill_awaited (shadow) — ${sibling.ticketId} awaiting=[${awaitingIds.join(", ")}] (sweep ${sweepId})`);
      return;
    }

    if (missingEdge) {
      try {
        await awaitedIds.applyAwaitedEdges(sibling.ticketId, awaitingIds, "tool");
        log(`reconcile.awaited_backfill — ${sibling.ticketId} awaiting=[${awaitingIds.join(", ")}] (sweep ${sweepId})`);
      } catch (err) {
        log(`reconcile.awaited_backfill_error — ${sibling.ticketId}: ${err?.message || err} (sweep ${sweepId})`);
      }
    }

    const to = awaitedIds.checkAwaitTimeout?.(sibling, siblings, now());
    if (to?.timedOut) {
      const emitted = await awaitedIds.emitAwaitTimeoutOnce(
        workflow, sibling.ticketId, to.awaitingIds, to.waitedMs, "reconcile-sweep");
      if (emitted) m.awaitTimeouts++;
    }
  }

  /**
   * Run one sweep. `mode` is off | shadow | enforce (anything else is coerced to
   * shadow — fail safe). Returns a metrics summary (also emitted as an EMF
   * record) for observability + tests.
   */
  async function runSweep(mode = "shadow") {
    const startedAtMs = now();
    const sweepId = `reconcile_${startedAtMs}`;
    const rawMode = mode;
    mode = String(mode ?? "").trim().toLowerCase();
    if (!KNOWN_MODES.includes(mode)) {
      mode = "shadow";
      log(`reconcile.unknown_mode — RECONCILE_SWEEP_MODE=${JSON.stringify(rawMode)} is not off|shadow|enforce; coercing to SHADOW (observe-only, zero writes) (sweep ${sweepId})`);
    }

    const m = {
      sweepId,
      mode,
      candidates: 0,
      skippedLiveLease: 0,
      escalated: 0,
      escalationHeld: 0,
      redispatched: 0,
      reviewReawakened: 0,
      wouldRedispatch: 0,
      noop: 0,
      candidateErrors: 0,
      truncated: false,
      // TEAM-4166 D2 §2.3 — evidence-gated outcomes + the D1 wait-SLA timeout.
      exitedOk: 0,
      awaiting: 0,
      awaitTimeouts: 0,
    };

    if (mode === "off") {
      log(`reconcile sweep skipped (mode=off)`);
      return m;
    }

    const { workflows, matched, rotation, pages } = await scanNonTerminalWorkflows();
    if (matched > SWEEP_CAP) {
      m.truncated = true;
      log(`reconcile.sweep_truncated — ${matched} non-terminal workflows, capped at ${SWEEP_CAP}; inspecting rotating window ${rotation + 1}/${pages} (every window is reached within ${pages} rotation quanta) (sweep ${sweepId})`);
    }

    for (const workflow of workflows) {
      // Root ticket id whose children ARE the dependency graph (same lookup the
      // cascade uses). A workflow with no epicId can't be scanned — skip it.
      const parentId = workflow.epicId;
      if (!parentId) continue;

      let siblings;
      try {
        siblings = await getChildTickets(parentId);
      } catch (err) {
        m.candidateErrors++;
        log(`reconcile.children_error — workflow ${workflow.id} parent ${parentId}: ${err?.message || err} (sweep ${sweepId})`);
        continue;
      }

      for (const sibling of siblings) {
        // Per-candidate isolation: one failing candidate must not abort the rest
        // of the sweep. Everything downstream is CAS-guarded, so continuing is
        // safe — a candidate left mid-recovery is re-evaluated next sweep.
        try {
          if (!sibling || sibling.type === "epic") continue;
          if (!sibling.assignee) continue;
          if (!CANDIDATE_STATUSES.has(sibling.status)) continue;

          // TEAM-4166 D1/D2 — the awaited-ids backstop runs BEFORE the
          // candidate gate: a child still awaiting open fixes never passes
          // allBlockersResolved, but its edges still need backfilling and its
          // wait still needs an SLA. No-op when the awaited module is unwired.
          if (awaitedIds && !TERMINAL_TICKET_STATUSES.has(sibling.status)) {
            await handleAwaitedChild(sibling, siblings, workflow, m, mode, sweepId);
          }

          if (!allBlockersResolved(sibling, siblings)) continue;
          if (!parkedLongEnough(sibling, startedAtMs)) continue;

          m.candidates++;

          if (mode === "shadow") {
            // Observe only — run the same routing to learn the outcome shape,
            // but reconcileDependent honors shadow mode and performs no writes.
            const outcome = await cascade.reconcileDependent(sibling, "reconcile-sweep", workflow, newCascadeMetrics(), "shadow", siblings);
            tally(m, outcome);
            log(`reconcile.would_recover (shadow) — ${sibling.ticketId} status=${sibling.status} → ${outcome} (sweep ${sweepId})`);
            continue;
          }

          // enforce — re-drive through the ONE implementation of the invariant.
          const outcome = await cascade.reconcileDependent(sibling, "reconcile-sweep", workflow, newCascadeMetrics(), "enforce", siblings);
          tally(m, outcome);
          log(`reconcile.recover — ${sibling.ticketId} status=${sibling.status} → ${outcome} (sweep ${sweepId})`);
        } catch (err) {
          m.candidateErrors++;
          log(`reconcile.candidate_error — ${sibling?.ticketId} ${err?.name || "Error"}: ${err?.message || err} (sweep ${sweepId})`);
        }
      }
    }

    m.durationMs = now() - startedAtMs;
    emitReconcileMetrics(m);
    log(`reconcile sweep done — mode=${mode} candidates=${m.candidates} skippedLiveLease=${m.skippedLiveLease} redispatched=${m.redispatched} escalated=${m.escalated || 0} escalationHeld=${m.escalationHeld || 0} reviewReawakened=${m.reviewReawakened} wouldRedispatch=${m.wouldRedispatch} noop=${m.noop} candidateErrors=${m.candidateErrors} truncated=${m.truncated} durationMs=${m.durationMs} (sweep ${sweepId})`);
    return m;
  }

  return { runSweep, scanNonTerminalWorkflows, allBlockersResolved, parkedLongEnough };
}

/**
 * Fold one reconcileDependent() outcome string into the sweep's metrics. Real
 * recoveries (enforce) bump redispatched/reviewReawakened; shadow would-* bump
 * the would counters; live-lease encounters bump skippedLiveLease; a lost CAS or
 * an already-open gate is a no-op.
 */
function tally(m, outcome) {
  switch (outcome) {
    case "nudged":
    case "would-nudge":
    case "live":
      m.skippedLiveLease++;
      break;
    case "escalated":
      m.escalated++;
      break;
    case "escalation-held":
      m.escalationHeld++;
      break;
    case "redispatched":
      m.redispatched++;
      break;
    case "review-reawakened":
      m.reviewReawakened++;
      break;
    // TEAM-4166 D2 §2.3 — evidence-gated clean-exit re-wake vs. still-awaiting.
    case "exited-ok":
      m.exitedOk++;
      break;
    case "awaiting":
      m.awaiting++;
      break;
    case "would-redispatch":
    case "would-steal":
    case "would-review":
    case "would-escalate":
      m.wouldRedispatch++;
      break;
    // steal-lost / redispatch-refused / review-noop → already recovered or a
    // racing claim won; nothing changed.
    default:
      m.noop++;
  }
}

/**
 * Emit the sweep summary as a single EMF record (AgentCoreHub/Orchestrator
 * namespace) — same emitter shape as the dead-session detector's emitMetrics and
 * the cascade's emitCascadeMetrics. Healthy sweeps write explicit 0s so a silent
 * sweep is distinguishable from a healthy one.
 */
export function emitReconcileMetrics(m) {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: "AgentCoreHub/Orchestrator",
        Dimensions: [[]],
        Metrics: [
          { Name: "ReconcileSweepDurationMs", Unit: "Milliseconds" },
          { Name: "ReconcileSweepCandidates", Unit: "Count" },
          { Name: "ReconcileSkippedLiveLease", Unit: "Count" },
          { Name: "ReconcileRedispatch", Unit: "Count" },
          { Name: "ReconcileEscalations", Unit: "Count" },
          { Name: "ReconcileEscalationHeld", Unit: "Count" },
          { Name: "ReconcileReviewReawaken", Unit: "Count" },
          { Name: "ReconcileWouldRedispatch", Unit: "Count" },
          { Name: "ReconcileNoop", Unit: "Count" },
          { Name: "ReconcileCandidateErrors", Unit: "Count" },
          { Name: "ReconcileSweepTruncated", Unit: "Count" },
          // TEAM-4166 D2 §2.3 — evidence-gated re-wake outcomes + D1 wait-SLA.
          { Name: "ReconcileExitedOk", Unit: "Count" },
          { Name: "ReconcileAwaiting", Unit: "Count" },
          { Name: "ReconcileAwaitTimeouts", Unit: "Count" },
        ],
      }],
    },
    ReconcileMode: m.mode,
    ReconcileSweepDurationMs: m.durationMs || 0,
    ReconcileSweepCandidates: m.candidates,
    ReconcileSkippedLiveLease: m.skippedLiveLease,
    ReconcileRedispatch: m.redispatched,
    ReconcileEscalations: m.escalated || 0,
    ReconcileEscalationHeld: m.escalationHeld || 0,
    ReconcileReviewReawaken: m.reviewReawakened,
    ReconcileWouldRedispatch: m.wouldRedispatch,
    ReconcileNoop: m.noop,
    ReconcileCandidateErrors: m.candidateErrors || 0,
    ReconcileSweepTruncated: m.truncated ? 1 : 0,
    ReconcileExitedOk: m.exitedOk || 0,
    ReconcileAwaiting: m.awaiting || 0,
    ReconcileAwaitTimeouts: m.awaitTimeouts || 0,
  }));
}
