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

import { newMetrics as newCascadeMetrics } from "./cascade.mjs";
// The ONE open-workflow scan, shared with dead-session-detector.mjs
// (TEAM-3839). Carries the TEAM-3764 F5 rotating window and the TEAM-3755
// F8-derived terminal-phase filter. SWEEP_ROTATION_QUANTUM_MS is re-exported
// unchanged for existing importers.
import { SWEEP_CAP, SWEEP_ROTATION_QUANTUM_MS, createOpenWorkflowScan, createPendingRollupScan } from "./sweep-scan.mjs";
export { SWEEP_ROTATION_QUANTUM_MS };

const KNOWN_MODES = ["off", "shadow", "enforce"];

// A dependent is a candidate only once it has been parked longer than this —
// so the sweep never races a normal in-flight cascade (which fires within
// seconds of a blocker closing). Floored at the lease TTL: the same window the
// dead-session detector treats as "long enough to be suspicious".
const DEFAULT_MIN_PARKED_MS = 30 * 60 * 1000; // 30m fallback if no lease TTL given

/**
 * TEAM-3991 D2.3 — the floor is SPLIT, because one number was doing two
 * unrelated jobs.
 *
 * The lease-TTL floor above exists to protect a possibly-live agent: stealing an
 * in_progress claim needs proof the session is dead, and "no activity for a lease
 * TTL" is that proof. Nothing about a `ready`/`todo`/`blocked-but-satisfied`
 * ticket needs that proof — there is NO claim to steal. It was simply never
 * dispatched, and the only risk of dispatching it is racing a normal cascade,
 * which fires within seconds. Making those wait 30 minutes cost prod runs half an
 * hour of dead air each (sffzti TEAM-3970 sat Ready and un-dispatched from 20:56
 * until the 21:26 sweep). Two minutes is comfortably past any in-flight cascade
 * and 15× tighter.
 */
const DEFAULT_READY_SLA_MS = 2 * 60 * 1000;

// Statuses a reconcile candidate can be parked in. done/cancelled are terminal;
// pending is pre-dispatch bookkeeping, not a stalled dependent.
const CANDIDATE_STATUSES = new Set(["blocked", "todo", "ready", "in_progress", "in_review"]);
const TERMINAL_TICKET_STATUSES = new Set(["done", "cancelled"]);
// Statuses whose recovery is a STEAL (a claim exists) — the only ones held to the
// lease-TTL floor. Everything else in CANDIDATE_STATUSES is a missed dispatch and
// takes the ready SLA. in_review is a gate re-wake, not a steal.
const STEAL_STATUSES = new Set(["in_progress"]);

/**
 * TEAM-3991 D2.3 — every reason a scanned ticket can go un-acted-on. A sweep that
 * reports "0 recoveries" is indistinguishable from a sweep that is silently
 * dropping every candidate on the floor unless it can also say WHY for each one
 * (prod: three separate sweeps over sffzti reported nothing and nobody could tell
 * whether the run was healthy or the sweep was broken). So the reason set is
 * closed, pre-seeded to 0, and the loop is structured so exactly one of these is
 * counted for every ticket it does not act on.
 *
 * `runtime_outage` is RESERVED: the sweep does not yet detect an AgentCore control
 * plane outage, but the dashboards and the invariant check below are built to
 * carry it, so adding the detector later is a one-line change and not a metric
 * migration.
 */
export const SKIP_REASONS = Object.freeze([
  "epic",
  "no_assignee",
  "terminal",
  "human_assigned",
  "in_review",
  "blockers_pending",
  "parked_too_recently",
  "lease_live",
  "escalation_held",
  "runtime_outage",
]);

/** A fresh all-zero skip tally, so EMF always carries every reason. */
export function newSkipTally() {
  return SKIP_REASONS.reduce((acc, r) => ((acc[r] = 0), acc), {});
}

/**
 * Whether a reconcileDependent verdict means "nothing was done".
 *
 * Deliberately keyed off the cascade's OWN `reason` vocabulary
 * (cascade.reconcileReason) rather than a second copy of the outcome→reason map
 * here: the cascade already names `lease_live`, `escalation_held`, `in_review` and
 * `blockers_pending`, which is exactly the non-action half of SKIP_REASONS. A new
 * cascade outcome therefore lands in the tally automatically, and the two lists
 * cannot drift.
 */
const skipReasonOf = (reason) => (SKIP_REASONS.includes(reason) ? reason : null);

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
    readySlaMs,       // D2.3 — the (much tighter) floor for missed DISPATCHES
    gateBypassRecheck, // (workflow, ticketId) → re-run the deferred bypass check
    retryEpicRollup,   // (workflow) → discharge an outstanding epic roll-up
    now = () => Date.now(),
    // Structured records (the skip reasons) are passed as OBJECTS; the default
    // logger JSON-encodes them so CW Logs Insights can filter on `reason`
    // directly instead of regexing a prose line.
    log = (msg) => console.log(typeof msg === "string" ? `[orchestrator] ${msg}` : JSON.stringify(msg)),
  } = deps;

  const minParkedMs = Number.isFinite(leaseTtlMs) && leaseTtlMs > 0
    ? leaseTtlMs
    : DEFAULT_MIN_PARKED_MS;

  // Factory opt wins over the env var, which wins over the 2-minute default.
  const readySla = Number.isFinite(readySlaMs) && readySlaMs > 0
    ? readySlaMs
    : Number(process.env.RECONCILE_READY_SLA_MS) || DEFAULT_READY_SLA_MS;

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

  /** D2.3 — the complete-but-unfinalized rollup-debt list (sweep-scan.mjs). */
  const scanPendingRollups = createPendingRollupScan({ ddb, workflowsTable });

  /**
   * Every blockedBy entry of `ticket` reads done/cancelled in `snapshot`. Same
   * predicate the cascade uses (evaluated against a supplied snapshot, not a
   * fresh per-blocker read). A ticket with no blockers is vacuously satisfied —
   * a stalled no-blocker todo/ready is a missed DISPATCH, still worth reconciling.
   */
  function allBlockersResolved(ticket, snapshot) {
    return (ticket.blockedBy || []).every((bid) => {
      const blocker = snapshot.find((s) => s.ticketId === bid);
      return blocker && TERMINAL_TICKET_STATUSES.has(blocker.status);
    });
  }

  /**
   * Parked long enough to be a stall, not an in-flight cascade. `floorMs` is now
   * EXPLICIT (D2.3): the caller picks the lease-TTL floor for a steal candidate or
   * the ready SLA for a missed dispatch. Defaults to the steal floor so any
   * existing caller keeps its old, more conservative behaviour.
   */
  function parkedLongEnough(ticket, nowMs, floorMs = minParkedMs) {
    const updated = ticket.updatedAt ? Date.parse(ticket.updatedAt) : NaN;
    if (!Number.isFinite(updated)) return true; // no timestamp → it's been around
    return nowMs - updated >= floorMs;
  }

  /** Which floor a candidate is held to — see STEAL_STATUSES. */
  const floorFor = (ticket) => (STEAL_STATUSES.has(ticket.status) ? minParkedMs : readySla);

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
      scanned: 0,        // every ticket the sweep LOOKED at (D2.3)
      acted: 0,          // every ticket it did something about
      skipped: newSkipTally(),
      bypassRechecked: 0,
      rollupsRetried: 0,
      rollupsRecovered: 0,
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
          if (!sibling) continue;
          m.scanned++;
          // D2.3 — every ticket that gets past `scanned++` leaves via exactly one
          // of: a skip reason, `m.acted++`, or the catch below. `skip()` returns
          // true so each guard reads as one line.
          const skip = (reason) => {
            m.skipped[reason] = (m.skipped[reason] || 0) + 1;
            log({ type: "reconcile.skip", sweepId, workflowId: workflow.id, ticketId: sibling.ticketId, reason, status: sibling.status });
            return true;
          };

          if (sibling.type === "epic") { skip("epic"); continue; }
          // Terminal BEFORE no_assignee: a done/cancelled ticket is finished
          // whether or not it still carries an assignee, and calling that
          // "no_assignee" would misreport a healthy closed ticket as a data defect.
          if (TERMINAL_TICKET_STATUSES.has(sibling.status)) { skip("terminal"); continue; }
          if (!CANDIDATE_STATUSES.has(sibling.status)) { skip("terminal"); continue; }
          if (!sibling.assignee) { skip("no_assignee"); continue; }
          // A human's ticket is never re-driven by a sweep — it is waiting on a
          // person, and dispatching it would hand their work to an agent. Counted
          // separately from `in_review` so the dashboards can tell "waiting on a
          // named human" from "waiting at a review gate".
          //
          // in_review is the ONE exception: a review gate is human-assigned by
          // construction, and re-waking a gate whose notification was lost is
          // exactly what this sweep is for. The cascade owns that decision
          // (review-reawakened vs review-noop), so gates go through to it and get
          // their reason from there.
          if (sibling.status !== "in_review" && String(sibling.assignee).startsWith("human:")) {
            skip("human_assigned"); continue;
          }
          if (!allBlockersResolved(sibling, siblings)) { skip("blockers_pending"); continue; }
          if (!parkedLongEnough(sibling, startedAtMs, floorFor(sibling))) { skip("parked_too_recently"); continue; }

          m.candidates++;

          // Route through the ONE implementation of the R3 invariant, in the
          // sweep's mode (shadow observes, enforce writes).
          const { outcome, reason } = await cascade.reconcileDependent(
            sibling, "reconcile-sweep", workflow, newCascadeMetrics(), mode === "shadow" ? "shadow" : "enforce"
          );
          tally(m, outcome);
          // The cascade's own verdict can also be a non-action (a live lease, an
          // escalation held for a human) — fold those into the SAME reason tally,
          // so `scanned = acted + sum(skipped)` holds end to end.
          const skipReason = skipReasonOf(reason);
          if (skipReason) skip(skipReason);
          else m.acted++;
          log(
            mode === "shadow"
              ? `reconcile.would_recover (shadow) — ${sibling.ticketId} status=${sibling.status} → ${outcome} (${reason}) (sweep ${sweepId})`
              : `reconcile.recover — ${sibling.ticketId} status=${sibling.status} → ${outcome} (${reason}) (sweep ${sweepId})`
          );
        } catch (err) {
          m.candidateErrors++;
          log(`reconcile.candidate_error — ${sibling?.ticketId} ${err?.name || "Error"}: ${err?.message || err} (sweep ${sweepId})`);
        }
      }

      // D2.3 extra step (a) — re-evaluate DEFERRED gate-bypass checks. The
      // detector defers a merge it saw before the approval window closed
      // (gateBypassCheckAt); completion re-evaluates them synchronously (F10), but
      // a run that never reaches completion would sit on an un-re-checked merge
      // forever. Re-check here once the grace has elapsed. Budgeted + isolated:
      // this is observability, never a reason for the sweep to die.
      if (mode === "enforce" && gateBypassRecheck) {
        for (const [ticketId, entry] of Object.entries(workflow.agentTasks || {})) {
          const dueAt = entry?.gateBypassCheckAt ? Date.parse(entry.gateBypassCheckAt) : NaN;
          if (!Number.isFinite(dueAt) || dueAt > startedAtMs) continue;
          try {
            await gateBypassRecheck(workflow, ticketId);
            m.bypassRechecked++;
            log(`reconcile.bypass_recheck — ${workflow.id}/${ticketId} grace elapsed (due ${entry.gateBypassCheckAt}) (sweep ${sweepId})`);
          } catch (err) {
            m.candidateErrors++;
            log(`reconcile.bypass_recheck_error — ${workflow.id}/${ticketId}: ${err?.message || err} (sweep ${sweepId})`);
          }
        }
      }
    }

    // D2.3 extra step (b) — discharge outstanding epic roll-ups. These runs are in
    // phase `complete`, so the scan above cannot see them (by design); the debt
    // list is its own narrow scan. The dep takes over through the same
    // claimFinalization CAS the completion path uses, so a sweep and a live
    // completer can never both roll the epic.
    if (mode === "enforce" && retryEpicRollup) {
      try {
        const pending = await scanPendingRollups();
        for (const wf of pending.workflows) {
          try {
            const res = await retryEpicRollup(wf);
            m.rollupsRetried++;
            if (res?.ok) m.rollupsRecovered++;
            log(`reconcile.rollup_retry — ${wf.id} claimed=${res?.claimed} ok=${res?.ok} ${res?.reason ? `reason=${res.reason}` : `attempts=${res?.attempts}`} (sweep ${sweepId})`);
          } catch (err) {
            m.candidateErrors++;
            log(`reconcile.rollup_retry_error — ${wf?.id}: ${err?.message || err} (sweep ${sweepId})`);
          }
        }
      } catch (err) {
        m.candidateErrors++;
        log(`reconcile.rollup_scan_error — ${err?.message || err} (sweep ${sweepId})`);
      }
    }

    // D2.3 invariant — a sweep that looked at tickets, acted on none, and cannot
    // name a reason for a single one is BROKEN (a filter silently swallowing
    // everything). Loud, but never fatal: a wrong count must not stop recovery.
    const skippedSum = Object.values(m.skipped).reduce((a, b) => a + b, 0);
    if (m.scanned > 0 && m.acted === 0 && skippedSum === 0) {
      console.warn(`[orchestrator] reconcile.unexplained — sweep ${sweepId} scanned ${m.scanned} ticket(s), acted on none, and recorded ZERO skip reasons. Every scanned ticket must yield an action or a reason; this is a sweep bug, not a healthy run.`);
    }

    m.durationMs = now() - startedAtMs;
    emitReconcileMetrics(m);
    log(`reconcile sweep done — mode=${mode} scanned=${m.scanned} candidates=${m.candidates} acted=${m.acted} skipped=${JSON.stringify(nonZero(m.skipped))} skippedLiveLease=${m.skippedLiveLease} redispatched=${m.redispatched} escalated=${m.escalated || 0} escalationHeld=${m.escalationHeld || 0} reviewReawakened=${m.reviewReawakened} wouldRedispatch=${m.wouldRedispatch} noop=${m.noop} bypassRechecked=${m.bypassRechecked} rollupsRetried=${m.rollupsRetried} rollupsRecovered=${m.rollupsRecovered} candidateErrors=${m.candidateErrors} truncated=${m.truncated} durationMs=${m.durationMs} (sweep ${sweepId})`);
    return m;
  }

  return { runSweep, scanNonTerminalWorkflows, scanPendingRollups, allBlockersResolved, parkedLongEnough, readySlaMs: readySla, minParkedMs };
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
/** Only the reasons that actually fired — keeps the human log line readable. */
function nonZero(tally) {
  return Object.fromEntries(Object.entries(tally || {}).filter(([, v]) => v > 0));
}

export function emitReconcileMetrics(m) {
  const skipped = { ...newSkipTally(), ...(m.skipped || {}) };
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
          { Name: "ReconcileSweepScanned", Unit: "Count" },
          { Name: "ReconcileActed", Unit: "Count" },
          { Name: "ReconcileBypassRechecked", Unit: "Count" },
          { Name: "ReconcileRollupsRetried", Unit: "Count" },
          { Name: "ReconcileRollupsRecovered", Unit: "Count" },
          // One metric per skip reason (D2.3) — a dashboard can then show WHY a
          // sweep is quiet, not just that it is.
          ...SKIP_REASONS.map((r) => ({ Name: `ReconcileSkipped_${r}`, Unit: "Count" })),
        ],
      }],
    },
    ReconcileMode: m.mode,
    ReconcileSweepDurationMs: m.durationMs || 0,
    ReconcileSweepCandidates: m.candidates,
    ReconcileSweepScanned: m.scanned || 0,
    ReconcileActed: m.acted || 0,
    ReconcileBypassRechecked: m.bypassRechecked || 0,
    ReconcileRollupsRetried: m.rollupsRetried || 0,
    ReconcileRollupsRecovered: m.rollupsRecovered || 0,
    ...Object.fromEntries(SKIP_REASONS.map((r) => [`ReconcileSkipped_${r}`, skipped[r] || 0])),
    ReconcileSkippedLiveLease: m.skippedLiveLease,
    ReconcileRedispatch: m.redispatched,
    ReconcileEscalations: m.escalated || 0,
    ReconcileEscalationHeld: m.escalationHeld || 0,
    ReconcileReviewReawaken: m.reviewReawakened,
    ReconcileWouldRedispatch: m.wouldRedispatch,
    ReconcileNoop: m.noop,
    ReconcileCandidateErrors: m.candidateErrors || 0,
    ReconcileSweepTruncated: m.truncated ? 1 : 0,
  }));
}
