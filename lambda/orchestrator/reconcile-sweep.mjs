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
 * Modes (RECONCILE_SWEEP_MODE): off (the default) = skip; shadow = full scan +
 * logs/metrics of what WOULD be re-driven, but ZERO writes; enforce = re-drive
 * for real. Fails SAFE: the value is trimmed + lowercased and anything that is
 * not exactly off|shadow|enforce is coerced to shadow with a loud warning.
 *
 * Testability: all effects (ddb, cascade, getChildTickets, clock) are injected
 * via `deps`, so the sweep runs against stubs with no AWS — same DI shape as the
 * detector and the cascade.
 */

import { newMetrics as newCascadeMetrics } from "./cascade.mjs";
// The ONE gate-label vocabulary (TEAM-4739 WP1) — W3 must recognise "the same
// gate, re-filed" exactly as the twins that refuse and stamp them do: the same kind
// AND the same binding (TEAM-4987), which is what gateRefileBindingMatches decides.
import { gateKindsOf, gateExecOf, gateHeadOf, gateRefileBindingMatches } from "./fix-contract.mjs";
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
    now = () => Date.now(),
    log = (msg) => console.log(`[orchestrator] ${msg}`),
    // TEAM-4739 W2/W3. Injected, not imported, for the same reason every other
    // effect here is: the sweep must run against stubs with no AWS. Both are
    // optional — an install that has not wired them keeps today's sweep exactly.
    appendNotification,   // (workflowId, id, notification, {maxCount}) → wrote?
    lastStreamedTextAt,   // (workflowId, agentId, ticketId) → ISO | "" (TICKET-scoped)
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
   * TEAM-4739 W2/W3 — the two watches. Purely OBSERVATIONAL: they page a human
   * and return, never re-drive anything, never `continue`, and never touch a
   * ticket. Their whole job is to make two silent stalls audible.
   *
   *   W2  a human gate open for hours with nobody looking at it. The cascade is
   *       working exactly as designed here — it is WAITING — so nothing else in
   *       the system will ever say anything, and a run can sit on an unanswered
   *       gate indefinitely.
   *   W3  a gate ticket that closed and was immediately re-filed with the same
   *       kind under the same epic: the loop-breaking signal. Something is
   *       closing gates that are not actually satisfied, and each cycle looks
   *       locally like progress.
   *
   * Both re-observe on every 5-minute sweep, hence appendEscalationOnce's ONE
   * open row per ticket with a bounded count rather than a notification storm.
   * Everything here fails toward SILENCE: its own try/catch, and a missing dep
   * or an unreadable liveness probe simply declines to page.
   */
  const WATCH = { gateMs: 4 * 60 * 60 * 1000, refileMs: 30 * 60 * 1000, maxCount: 6 };

  /** Ticket-SCOPED quiet time: how long since THIS ticket's agent last streamed
   *  text, falling back to the row's own clock. Deliberately not a workflow-wide
   *  activity read — 17 other personas being busy is exactly how a wedged agent
   *  looks alive. */
  async function quietMsOf(workflow, ticket, nowMs) {
    let at = "";
    if (lastStreamedTextAt) {
      try {
        at = (await lastStreamedTextAt(workflow.id, ticket.assignee, ticket.ticketId)) || "";
      } catch { /* unreadable → fall back to the row's clock */ }
    }
    const ms = Date.parse(at || ticket.updatedAt || ticket.createdAt || "");
    return Number.isFinite(ms) ? nowMs - ms : 0;
  }

  async function runWatches(workflow, sibling, siblings, nowMs, mode, m, sweepId) {
    const ticketId = sibling.ticketId;
    const page = async (id, kind, detail, metric) => {
      if (mode !== "enforce") {
        m[`would${metric}`]++;
        log(`reconcile.would_${kind} (shadow) — ${ticketId} ${detail} (sweep ${sweepId})`);
        return;
      }
      if (!appendNotification) return;
      const wrote = await appendNotification(workflow.id, id, {
        id, type: "manager_escalation", ticketId, watch: kind, message: detail,
        createdAt: new Date(nowMs).toISOString(),
      }, { maxCount: WATCH.maxCount });
      if (wrote) m[metric]++;
      log(`reconcile.${kind}${wrote ? "" : "_held"} — ${ticketId} ${detail} (sweep ${sweepId})`);
    };

    // W2 — a human gate nobody has answered. Scoped to human assignees: an
    // agent ticket open for 4h is the detector's business, not a page.
    if (String(sibling.assignee || "").startsWith("human:")
        && !TERMINAL_TICKET_STATUSES.has(sibling.status)) {
      const quiet = await quietMsOf(workflow, sibling, nowMs);
      // An open review_needed for this ticket in the last 4h already put a human
      // on it; a second, differently-typed page would just be noise.
      const recentReview = (workflow.humanNotifications || []).some((n) =>
        n?.ticketId === ticketId && n.type === "review_needed" && !n.acknowledged
        && nowMs - Date.parse(n.createdAt || "") < WATCH.gateMs);
      if (quiet >= WATCH.gateMs && !recentReview) {
        await page(`notif_watch_gate_${ticketId}`, "watch_gate",
          `human gate open ${Math.round(quiet / 60000)}m with no answer`, "watchGate");
      }
    }

    // W3 — a closed gate re-filed (created AT OR AFTER the close) as the same kind
    // AND against the same BINDING. Kind alone is not a re-file: four serial CD
    // follow-ups under one Bug parent each close a deploy gate and file the next one
    // minutes later, for four DIFFERENT pipeline executions, and paging a human
    // about that healthy run is TEAM-4987. gateRefileBindingMatches owns the whole
    // rule (`exec:` for a deploy gate, `head:`/blocked_by otherwise, deploy-approval
    // governing when a ticket carries both kinds) so this watch keeps no gate
    // vocabulary of its own.
    const kinds = gateKindsOf(sibling.labels);
    if (kinds.length && sibling.status === "done") {
      const closedMs = Date.parse(sibling.updatedAt || "");
      const refiled = siblings.some((s) => s && s.ticketId !== ticketId
        && !TERMINAL_TICKET_STATUSES.has(s.status)
        && gateRefileBindingMatches(sibling, s)
        && Date.parse(s.createdAt || "") >= closedMs && Date.parse(s.createdAt || "") <= closedMs + WATCH.refileMs);
      if (refiled) {
        // Name the binding in the page: "the deploy gate for exec X" is actionable,
        // "a deploy gate" makes the human re-derive which decision is looping.
        const exec = gateExecOf(sibling.labels);
        const head = gateHeadOf(sibling.labels);
        const bound = exec ? ` (exec:${exec})` : head ? ` (head:${head})` : "";
        await page(`notif_watch_refile_${ticketId}`, "watch_refile",
          `gate ${kinds.join(",")}${bound} closed then re-filed within 30m against the same binding`, "watchRefile");
      }
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
      watchGate: 0,
      watchRefile: 0,
      wouldwatchGate: 0,
      wouldwatchRefile: 0,
      watchErrors: 0,
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

          // TEAM-4739 W2/W3 FIRST, before every candidate filter below: W3 must
          // observe a `done` gate (CANDIDATE_STATUSES excludes it) and W2 a
          // long-parked human gate (parkedLongEnough may skip it), so a watch
          // placed after the filters would never run. Observational, never
          // `continue`s, and its own catch keeps a failed page from costing the
          // recovery below.
          try {
            await runWatches(workflow, sibling, siblings, startedAtMs, mode, m, sweepId);
          } catch (err) {
            m.watchErrors++;
            log(`reconcile.watch_error — ${sibling.ticketId} ${err?.message || err} (sweep ${sweepId})`);
          }

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
    log(`reconcile sweep done — mode=${mode} candidates=${m.candidates} skippedLiveLease=${m.skippedLiveLease} redispatched=${m.redispatched} escalated=${m.escalated || 0} escalationHeld=${m.escalationHeld || 0} reviewReawakened=${m.reviewReawakened} watchGate=${m.watchGate} watchRefile=${m.watchRefile} wouldWatchGate=${m.wouldwatchGate} wouldWatchRefile=${m.wouldwatchRefile} watchErrors=${m.watchErrors} wouldRedispatch=${m.wouldRedispatch} noop=${m.noop} candidateErrors=${m.candidateErrors} truncated=${m.truncated} durationMs=${m.durationMs} (sweep ${sweepId})`);
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
  }));
}
