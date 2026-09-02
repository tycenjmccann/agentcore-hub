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

import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { newMetrics as newCascadeMetrics } from "./cascade.mjs";
// The ONE terminal-phase list (TEAM-3755 F2/F8). completion.mjs is pure — no AWS
// clients, no store import — so importing it here cannot cycle.
import { notTerminalPhaseFilter } from "./completion.mjs";

const SWEEP_CAP = 50;                 // workflows inspected per sweep (most recent first)
const WORKFLOW_SCAN_PAGES = 20;       // bound the workflows scan
// TEAM-3764 F5 — when more than SWEEP_CAP workflows are open, the capped window
// ROTATES across sweeps instead of always re-inspecting the newest 50 (which
// starved older parked workflows forever). The rotation index is derived from
// the injected clock in quanta of this size — stateless (a cold start computes
// the same window a warm one would; zero writes, so shadow mode stays
// write-free) and deterministic for tests. The quantum sits above the sweep
// schedule (rate(5 minutes), mirroring the dead-session rule), so the index
// advances by at most 1 between sweeps and every chunk of ceil(N/SWEEP_CAP) is
// inspected within ceil(N/SWEEP_CAP) quanta.
export const SWEEP_ROTATION_QUANTUM_MS = 10 * 60 * 1000;
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
    now = () => Date.now(),
    log = (msg) => console.log(`[orchestrator] ${msg}`),
  } = deps;

  const minParkedMs = Number.isFinite(leaseTtlMs) && leaseTtlMs > 0
    ? leaseTtlMs
    : DEFAULT_MIN_PARKED_MS;

  /**
   * Scan workflows in a non-terminal phase, newest first, capped at SWEEP_CAP.
   * Returns { workflows, matched, rotation, pages } so the caller can flag
   * truncation. Identical shape/bounds to
   * dead-session-detector.scanNonTerminalWorkflows, except that an over-cap
   * result rotates which SWEEP_CAP-sized chunk is returned (TEAM-3764 F5) so
   * every open workflow is eventually inspected.
   *
   * TEAM-3755 F8: the filter is DERIVED from the shared TERMINAL_WORKFLOW_PHASES
   * list (completion.mjs) rather than spelled out here. It previously named only
   * complete/cancelled/error, so a run already closed deploy-blocked /
   * static-ci-only (the TEAM-3747 D2 honest closes) still scanned as "open" —
   * and in enforce mode the sweep could steal a lease and RE-DISPATCH a parked
   * candidate inside a terminally-blocked run, resurrecting work after the
   * verdict. Deriving it means a sixth terminal phase can never be added to the
   * completion gate and forgotten here.
   */
  async function scanNonTerminalWorkflows() {
    const matched = [];
    let lastKey;
    const openOnly = notTerminalPhaseFilter("#p");
    for (let page = 0; page < WORKFLOW_SCAN_PAGES; page++) {
      const res = await ddb.send(new ScanCommand({
        TableName: workflowsTable,
        FilterExpression: openOnly.filter,
        ExpressionAttributeNames: { "#p": "phase" },
        ExpressionAttributeValues: { ...openOnly.values },
        ExclusiveStartKey: lastKey,
      }));
      for (const w of res.Items || []) matched.push(w);
      lastKey = res.LastEvaluatedKey;
      if (!lastKey) break;
    }
    const recency = (w) => String(w.updatedAt || w.completedAt || w.startedAt || "");
    matched.sort((a, b) => recency(b).localeCompare(recency(a)));
    // TEAM-3764 F5 — rotate the capped window: chunk k of the recency-sorted
    // list this quantum, chunk k+1 the next, wrapping. Under the cap this is
    // exactly the old slice(0, SWEEP_CAP).
    const pages = Math.max(1, Math.ceil(matched.length / SWEEP_CAP));
    const rotation = pages === 1 ? 0 : Math.floor(now() / SWEEP_ROTATION_QUANTUM_MS) % pages;
    const start = rotation * SWEEP_CAP;
    return {
      workflows: matched.slice(start, start + SWEEP_CAP),
      matched: matched.length,
      rotation,
      pages,
    };
  }

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

  /** Parked long enough to be a stall, not an in-flight cascade. */
  function parkedLongEnough(ticket, nowMs) {
    const updated = ticket.updatedAt ? Date.parse(ticket.updatedAt) : NaN;
    if (!Number.isFinite(updated)) return true; // no timestamp → it's been around
    return nowMs - updated >= minParkedMs;
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
          if (!sibling || sibling.type === "epic") continue;
          if (!sibling.assignee) continue;
          if (!CANDIDATE_STATUSES.has(sibling.status)) continue;
          if (!allBlockersResolved(sibling, siblings)) continue;
          if (!parkedLongEnough(sibling, startedAtMs)) continue;

          m.candidates++;

          if (mode === "shadow") {
            // Observe only — run the same routing to learn the outcome shape,
            // but reconcileDependent honors shadow mode and performs no writes.
            const outcome = await cascade.reconcileDependent(sibling, "reconcile-sweep", workflow, newCascadeMetrics(), "shadow");
            tally(m, outcome);
            log(`reconcile.would_recover (shadow) — ${sibling.ticketId} status=${sibling.status} → ${outcome} (sweep ${sweepId})`);
            continue;
          }

          // enforce — re-drive through the ONE implementation of the invariant.
          const outcome = await cascade.reconcileDependent(sibling, "reconcile-sweep", workflow, newCascadeMetrics(), "enforce");
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
    log(`reconcile sweep done — mode=${mode} candidates=${m.candidates} skippedLiveLease=${m.skippedLiveLease} redispatched=${m.redispatched} reviewReawakened=${m.reviewReawakened} wouldRedispatch=${m.wouldRedispatch} noop=${m.noop} candidateErrors=${m.candidateErrors} truncated=${m.truncated} durationMs=${m.durationMs} (sweep ${sweepId})`);
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
      m.skippedLiveLease++;
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
          { Name: "ReconcileReviewReawaken", Unit: "Count" },
          { Name: "ReconcileWouldRedispatch", Unit: "Count" },
          { Name: "ReconcileNoop", Unit: "Count" },
          { Name: "ReconcileCandidateErrors", Unit: "Count" },
          { Name: "ReconcileSweepTruncated", Unit: "Count" },
        ],
      }],
    },
    ReconcileMode: m.mode,
    ReconcileSweepDurationMs: m.durationMs || 0,
    ReconcileSweepCandidates: m.candidates,
    ReconcileSkippedLiveLease: m.skippedLiveLease,
    ReconcileRedispatch: m.redispatched,
    ReconcileReviewReawaken: m.reviewReawakened,
    ReconcileWouldRedispatch: m.wouldRedispatch,
    ReconcileNoop: m.noop,
    ReconcileCandidateErrors: m.candidateErrors || 0,
    ReconcileSweepTruncated: m.truncated ? 1 : 0,
  }));
}
