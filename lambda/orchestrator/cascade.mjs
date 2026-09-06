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
 * TEAM-3618 D3 commit 4b (behind CASCADE_EXTENDED_STATES): when the LAST blocker
 * of an ALREADY-MOVING dependent resolves, cascadeUnblock also
 *   - in_progress: lease-guarded. LIVE lease → orchestrator.nudge only (context
 *     signal, ZERO steal/claim attempts). STALE lease → stealClaim CAS on the
 *     generation, and on a win re-dispatch through the normal claim CAS (the
 *     claim CAS is the final arbiter — a live claim always wins, AC-D3.3).
 *   - in_review: re-wake the parked/reopened human-review gate — emit
 *     review.reawakened and re-run the existing gate readiness path.
 *
 * TEAM-3747 D1 — the extended-state path is now a tri-state safe rollout,
 * mirroring DEAD_SESSION_DETECTOR_MODE (off | shadow | enforce, default shadow):
 *   - off     → no-op; only the commit-4a union ({blocked, todo} → Ready) runs.
 *   - shadow  → evaluate the extended-state path and emit metrics/logs of what
 *               WOULD happen (would-nudge / would-steal / would-redispatch /
 *               would-reawaken), but perform ZERO writes.
 *   - enforce → the full commit-4b behavior above (nudge / steal + re-dispatch /
 *               re-wake) runs for real.
 * Backwards compatible: the legacy boolean `extendedStates` still maps true →
 * enforce and false/unset → off.
 *
 * The R3 invariant (LIVE → nudge only; STALE → steal-on-generation + re-dispatch
 * through the claim CAS) lives in ONE place — the shared emitNudge /
 * stealAndRedispatch helpers below — so the reconciliation sweep
 * (reconcile-sweep.mjs, TEAM-3747 D1) can reuse it via the exported
 * reconcileDependent() rather than re-implementing lease/steal semantics.
 *
 * TEAM-3755 — two guards on the enforce path, both documented at their call site:
 *   F7: a TOCTOU liveness RE-CHECK immediately before every stealClaim (the steal
 *       CAS keys on the claim generation, which an agent that heart-beats in the
 *       read→steal window still holds — so only a fresh read can refuse it).
 *   F9: a strongly-consistent per-blocker CONFIRM before the event path acts on
 *       an in_progress dependent (the sibling snapshot is an eventually-consistent
 *       GSI page; the sweep has a quiet period, the event path does not).
 */

import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

// Extended-state rollout modes (TEAM-3747 D1) — same vocabulary + fail-safe
// default (shadow) as DEAD_SESSION_DETECTOR_MODE.
const KNOWN_EXTENDED_MODES = ["off", "shadow", "enforce"];

// The only ticket statuses that resolve a blocker. Same pair the snapshot
// predicate uses; named here for the TEAM-3755 F9 point-read confirm.
const RESOLVED_BLOCKER_STATUSES = new Set(["done", "cancelled"]);

/**
 * Normalize the `extendedStates` dep into off | shadow | enforce. Backwards
 * compatible with the legacy boolean (true → enforce, false/unset → off) and
 * with legacy string truthies ("on"/"true"/"1" → enforce). Anything
 * unrecognized fails SAFE to shadow (observe-only, zero writes).
 */
export function normalizeExtendedMode(value) {
  if (value === true) return "enforce";
  if (value === false || value === undefined || value === null || value === "") return "off";
  const mode = String(value).trim().toLowerCase();
  if (KNOWN_EXTENDED_MODES.includes(mode)) return mode;
  if (mode === "on" || mode === "true" || mode === "1") return "enforce";
  return "shadow";
}

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
    // Bounded stale-GSI retry (Finding 3 / TEAM-3684). Both injectable so tests
    // use a fake, zero-delay sleep. retryDelayMs gives the eventually-consistent
    // parentId-index a moment to catch up before the single re-fetch.
    retryDelayMs = 300,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // Extended-states (commit 4b) — all optional; guarded by extendedMode.
    // `extendedStates` is off | shadow | enforce (or the legacy boolean).
    extendedStates = false,
    // Level-triggered dispatch (TEAM-4060) — off | shadow | enforce, default off.
    // When enforced, a dependent that becomes dispatchable (blocked/todo → Ready,
    // or already parked in Ready but never claimed) is invoked IN-PROCESS via
    // `dispatchReady` instead of waiting for the provider's Ready-status webhook.
    // This closes the "dispatch dead-zone": the webhook round-trip is edge-
    // triggered, so a Ready→Ready no-op or a dropped webhook left the dependent
    // idle until the 5-min reconcile sweep. `dispatchReady` routes through the
    // same claim CAS the webhook path uses, so a webhook that ALSO fires is a
    // harmless no-op — the CAS is the sole dedup arbiter. off = pure webhook path,
    // byte-identical to pre-4060.
    levelTriggerDispatch = "off",
    dispatchReady,
    lease,
    eventsTable,
    workflowsTable,
    redispatch,
    reawakenGate,
    // TEAM-3755 F9 — STRONGLY-CONSISTENT single-ticket read, used to confirm a
    // dependent's blockers really are resolved before the event path steals a
    // lease and re-dispatches (the snapshot that got us here is an eventually-
    // consistent GSI page). Optional: when unwired the confirm is skipped and
    // behavior is exactly what it was before F9.
    getTicketConsistent,
    // TEAM-3969 — retry budget for the reconcile sweep's stale-lease recovery
    // (workflow-store incrementDeadSessionRetry/setTaskStatus/appendNotification
    // + the failed-invoke ticket parker). Both optional: unwired = the pre-3968
    // uncapped steal, so existing callers and tests are byte-identical.
    store,
    blockTicket,
    // TEAM-4120 FR-3 — optional dead-session escalation tree (page → synthesize
    // → park). Unwired = the bare manager_escalation notification, as before.
    escalate,
  } = deps;

  // One normalization per cascade instance. The commit-4a union (blocked/todo →
  // Ready) is ALWAYS enforced regardless of this — extendedMode gates only the
  // commit-4b extended-state actions (in_progress / in_review).
  const extendedMode = normalizeExtendedMode(extendedStates);
  // Same off|shadow|enforce vocabulary as extendedStates; anything else → off.
  const levelTriggerMode = ["shadow", "enforce"].includes(levelTriggerDispatch)
    ? levelTriggerDispatch
    : "off";

  /**
   * Level-triggered dispatch (TEAM-4060). Invoke a now-dispatchable dependent
   * directly instead of waiting for its Ready webhook. Non-fatal by contract:
   * a throw here NEVER strands the cascade — the Ready transition already
   * happened and the webhook + reconcile sweep remain the backstop. The claim
   * CAS inside dispatchReady dedups against a concurrent webhook delivery.
   *   off     → skip (pure webhook path).
   *   shadow  → count wouldDispatch, no invoke.
   *   enforce → dispatch in-process.
   */
  async function levelDispatch(sibling, workflow, m) {
    if (levelTriggerMode === "off" || typeof dispatchReady !== "function") return;
    if (levelTriggerMode === "shadow") {
      m.wouldDispatch = (m.wouldDispatch || 0) + 1;
      log(`[orchestrator] level-trigger would-dispatch (shadow) — ${sibling.ticketId}`);
      return;
    }
    try {
      await dispatchReady(workflow, sibling);
      m.levelDispatched = (m.levelDispatched || 0) + 1;
      log(`[orchestrator] level-trigger dispatch — ${sibling.ticketId}`);
    } catch (err) {
      m.levelDispatchErrors = (m.levelDispatchErrors || 0) + 1;
      log(`[orchestrator] level-trigger dispatch failed (non-fatal, webhook+sweep backstop) — ${sibling.ticketId}: ${err?.message || err}`);
    }
  }

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
    const m = newMetrics();

    // Dependents whose blocker set wasn't fully resolved in the FIRST snapshot.
    // That snapshot comes from the eventually-consistent parentId-index GSI, so a
    // sibling blocker that already closed can still read non-terminal here — and
    // because that closing ticket won't cascade again, the last unblock would be
    // permanently missed (Finding 3 / TEAM-3684). We collect those and retry ONCE
    // against a fresh snapshot before giving up.
    const deferred = [];

    // Blocker-resolution predicate — UNCHANGED from both original copies: every
    // blockedBy entry is done/cancelled (this one just closed). Evaluated against
    // a supplied snapshot rather than a fresh per-blocker lookup (matches prior
    // code); the retry pass simply re-runs it against a re-fetched snapshot.
    const allBlockersResolved = (sibling, snapshot) =>
      (sibling.blockedBy || []).every((bid) => {
        if (bid === ticketId) return true; // this one is done
        const blocker = snapshot.find((s) => s.ticketId === bid);
        return blocker && (blocker.status === "done" || blocker.status === "cancelled");
      });

    // Handle one dependent whose blockers are all resolved. Per-dependent error
    // isolation (Finding 1 / TEAM-3684): a throw here is logged + counted and the
    // cascade moves on, so one dependent that fails to transition can neither
    // strand its siblings nor abort the caller's agent.complete + completion
    // check. A dependent that threw is NOT added to `unblocked` (no
    // orchestrator.unblocked for a transition that didn't happen).
    const handleDependent = async (sibling) => {
      try {
        // Commit 4a (union). The stream twin previously matched only "blocked";
        // Readying a parked "todo" dependent here is the divergence fix.
        if (sibling.status === "blocked" || sibling.status === "todo") {
          await transitionToReady(sibling);
          unblocked.push(sibling.ticketId);
          // Level-trigger (TEAM-4060): dispatch now instead of waiting for the
          // Ready webhook. No-op when levelTriggerMode is off.
          await levelDispatch(sibling, workflow, m);
          return;
        }
        // Level-trigger (TEAM-4060). A dependent already parked in "ready" whose
        // last blocker just resolved but which was never claimed — the classic
        // Ready→Ready dead-zone (the transition that would have fired the webhook
        // was a no-op). Dispatch it in-process. off → no-op (pre-4060 fall-through
        // to the extended-state checks below, which never matched "ready").
        if (sibling.status === "ready") {
          await levelDispatch(sibling, workflow, m);
          return;
        }
        // Commit 4b (CASCADE_EXTENDED_STATES). The last blocker of an ALREADY-
        // MOVING dependent just resolved. off → no-op (commit-4a only); shadow →
        // observe + would-* metrics, zero writes; enforce → act for real.
        if (extendedMode === "off") return;
        if (sibling.status === "in_progress") {
          await handleInProgressDependent(sibling, ticketId, workflow, m, extendedMode);
        } else if (sibling.status === "in_review") {
          await handleInReviewDependent(sibling, ticketId, workflow, m, extendedMode);
        }
        // done / cancelled / any other terminal state → no-op.
      } catch (err) {
        m.dependentErrors++;
        log(`[orchestrator] cascade dependent error — ${sibling.ticketId}: ${err?.message || err}`);
      }
    };

    for (const sibling of siblings) {
      if (sibling.ticketId === ticketId) continue;
      const blockers = sibling.blockedBy || [];
      if (!blockers.includes(ticketId)) continue;

      if (!allBlockersResolved(sibling, siblings)) {
        // Unresolved means at least one blocker isn't done/cancelled in this
        // snapshot. The ONLY terminal states are done/cancelled, so every
        // unresolved blocker is non-terminal-or-missing — exactly the shape a
        // stale GSI read produces for a blocker that just closed. Defer for one
        // bounded re-fetch rather than skipping outright.
        deferred.push(sibling);
        continue;
      }
      await handleDependent(sibling);
    }

    // Bounded single retry (Finding 3): re-fetch the sibling snapshot ONCE and
    // re-evaluate ONLY the deferred dependents. If a blocker's completion simply
    // hadn't propagated to the GSI yet, the fresh read now sees it and the
    // dependent unblocks; anything still unresolved is skipped as before — no
    // further retries (a genuinely-open blocker will cascade on its own close).
    if (deferred.length) {
      await sleep(retryDelayMs);
      const fresh = await getChildTickets(parentId);
      for (const stale of deferred) {
        // Prefer the fresh row (status may have advanced); fall back to the
        // deferred copy if the GSI momentarily doesn't return it.
        const sibling = fresh.find((s) => s.ticketId === stale.ticketId) || stale;
        if (sibling.ticketId === ticketId) continue;
        if (!allBlockersResolved(sibling, fresh)) continue;
        await handleDependent(sibling);
      }
    }

    log(`[orchestrator] ${ticketId} cascade — unblocked=[${unblocked.join(", ")}] errors=${m.dependentErrors}` +
      (extendedMode !== "off"
        ? ` mode=${extendedMode} nudged=${m.nudged} redispatched=${m.redispatched} reviewReawakened=${m.reviewReawakened}` +
          ` wouldNudge=${m.wouldNudge} wouldSteal=${m.wouldSteal} wouldRedispatch=${m.wouldRedispatch} wouldReviewReawaken=${m.wouldReviewReawaken}` +
          ` blockerConfirmAborted=${m.blockerConfirmAborted}`
        : "") +
      (levelTriggerMode !== "off"
        ? ` levelTrigger=${levelTriggerMode} levelDispatched=${m.levelDispatched || 0}` +
          ` wouldDispatch=${m.wouldDispatch || 0} levelDispatchErrors=${m.levelDispatchErrors || 0}`
        : ""));

    // Journey log: one orchestrator.unblocked per Ready transition. The helper
    // OWNS this event so BOTH call sites emit an identical journal trail (the
    // stream twin previously omitted it entirely).
    for (const unblockedId of unblocked) {
      await publishEvent(unblockedId, "orchestrator.unblocked", {
        ticketId: unblockedId, unblockedBy: ticketId, workflowId: workflow?.id,
      });
    }

    if (hasCascadeActivity(m)) {
      emitCascadeMetrics(m);
    }

    return unblocked;
  }

  // ── Shared R3 invariant primitives ──────────────────────────────────────────
  // The LIVE-nudge and STALE-steal+re-dispatch logic lives here ONCE. Both the
  // cascade (handleInProgressDependent) and the reconciliation sweep
  // (reconcileDependent → reconcile-sweep.mjs) route through these, so there is
  // exactly one implementation of "never steal a live lease" (lease.mjs stays
  // the sole liveness authority — we only call isLeaseLive / stealClaim).

  /** Is this sibling's current claim generation a live lease? (R3, lease.mjs.) */
  async function leaseIsLive(sibling, workflow) {
    const task = workflow?.agentTasks?.[sibling.ticketId];
    const lastActivity = await lease.lastAgentActivity(
      ddb, eventsTable, workflow?.id, sibling.assignee, sibling.ticketId
    );
    return lease.isLeaseLive(task, lastActivity, now());
  }

  /**
   * LIVE lease — context signal ONLY. Zero steal, zero claim (AC-D3.3). In
   * shadow mode the nudge is observed (would-nudge) but not published.
   */
  async function emitNudge(sibling, unblockedBy, workflow, m, mode) {
    const agentId = sibling.assignee;
    m.skippedLiveLease++;
    // The reconcile sweep re-visits every live candidate each cycle. Re-publishing
    // orchestrator.nudge on every visit has no consumer, and it resets every
    // "last activity" clock that filters only agent.streaming (WM watch scan, UI)
    // — a heartbeat the agent never sent, so a run can never look stale
    // (TEAM-3969). Periodic visits are observed, not published; the event-path
    // nudge (a blocker just closed) is unchanged.
    if (unblockedBy === "reconcile-sweep") {
      log(`[orchestrator] cascade live lease (sweep, no nudge) — ${sibling.ticketId} agent=${agentId}`);
      return "live";
    }
    if (mode === "enforce") {
      await publishEvent(sibling.ticketId, "orchestrator.nudge", {
        agentId, unblockedBy, workflowId: workflow?.id,
      });
      m.nudged++;
      log(`[orchestrator] cascade nudge (live lease) — ${sibling.ticketId} agent=${agentId}`);
      return "nudged";
    }
    m.wouldNudge++;
    log(`[orchestrator] cascade would-nudge (shadow, live lease) — ${sibling.ticketId} agent=${agentId}`);
    return "would-nudge";
  }

  /**
   * STALE lease — steal the exact generation (CAS on startedAt), then re-dispatch
   * through the normal claim CAS. Both CAS steps are arbiters: a fresh claim that
   * raced in makes the steal OR the re-dispatch lose, and we stop — a re-dispatch
   * against a live lease is structurally refused. In shadow mode: observe only.
   *
   * TEAM-3755 F7 — TOCTOU re-check before the steal, mirroring the dead-session
   * detector (dead-session-detector.mjs step 1b). The steal CAS keys on the claim
   * GENERATION (startedAt), so an agent that was merely SILENT when we read
   * liveness and then heart-beated in the read→steal window keeps the SAME
   * generation: its claim satisfies the CAS and gets stolen + re-dispatched,
   * double-invoking a live session (R1). The generation CAS cannot see that — only
   * a fresh liveness read can. So re-read activity immediately before the steal
   * and, if the lease came back to life, abort and treat it as what the
   * non-racing ordering would have done: a nudge, zero steal (AC-D3.3).
   */
  async function stealAndRedispatch(sibling, unblockedBy, workflow, m, mode) {
    const agentId = sibling.assignee;
    const task = workflow?.agentTasks?.[sibling.ticketId];
    if (mode !== "enforce") {
      m.wouldSteal++;
      m.wouldRedispatch++;
      log(`[orchestrator] cascade would-steal+redispatch (shadow, stale lease) — ${sibling.ticketId} agent=${agentId}`);
      return "would-steal";
    }
    if (await leaseIsLive(sibling, workflow)) {
      log(`[orchestrator] cascade steal aborted (lease live again on re-check) — ${sibling.ticketId} agent=${agentId}`);
      return emitNudge(sibling, unblockedBy, workflow, m, mode);
    }
    const stole = await lease.stealClaim(
      ddb, workflowsTable, workflow?.id, sibling.ticketId, task?.startedAt
    );
    if (!stole) {
      log(`[orchestrator] cascade steal lost — ${sibling.ticketId} (claim moved)`);
      return "steal-lost";
    }
    const dispatched = await redispatch(workflow, sibling);
    if (dispatched) {
      m.redispatched++;
      log(`[orchestrator] cascade re-dispatch — ${sibling.ticketId} agent=${agentId}`);
      return "redispatched";
    }
    log(`[orchestrator] cascade re-dispatch refused — ${sibling.ticketId} (claim CAS lost)`);
    return "redispatch-refused";
  }

  /**
   * TEAM-3755 F9 — confirm a dependent's blockers really ARE resolved, with a
   * STRONGLY-CONSISTENT point-read per blocker, before the event path steals a
   * lease and re-dispatches.
   *
   * Why the snapshot isn't enough: allBlockersResolved evaluates the
   * parentId-index GSI page this cascade was handed (index.mjs getChildTickets,
   * no ConsistentRead). A stale page can show a blocker that was JUST reopened
   * for rework as still done, or omit a fix ticket that was just filed as a new
   * blocker — and under CASCADE_EXTENDED_STATES=enforce that drives a steal +
   * re-dispatch of an in_progress dependent whose inputs are not actually fixed
   * yet. The reconciliation sweep is protected by its leaseTtlMs quiet period;
   * the event path fires within seconds of the blocker closing and has none, so
   * it confirms by key instead.
   *
   * A blocker that reads non-terminal — or that the point-read cannot find at all
   * — counts as UNRESOLVED: refusing to re-dispatch is the safe direction (the
   * dependent's own unblock will cascade again when the blocker really closes,
   * and the reconcile sweep is the backstop). Returns true when the confirm is
   * unavailable (dep unwired) so the pre-F9 behavior is preserved.
   */
  async function blockersConfirmedResolved(sibling) {
    const blockers = sibling.blockedBy || [];
    if (!getTicketConsistent || !blockers.length) return true;
    for (const bid of blockers) {
      const blocker = await getTicketConsistent(bid);
      if (!blocker || !RESOLVED_BLOCKER_STATUSES.has(blocker.status)) {
        log(`[orchestrator] cascade blocker not confirmed resolved — ${sibling.ticketId} blocker=${bid} status=${blocker?.status ?? "missing"}`);
        return false;
      }
    }
    return true;
  }

  /**
   * A dependent already in_progress whose last blocker just resolved. NEVER
   * steal a live lease and NEVER attempt a claim against one — a live agent is
   * doing the work; a re-dispatch would duplicate the session. The lease check
   * (R3, lease.mjs) is the sole authority for liveness.
   *
   * The F9 blocker confirm runs FIRST and in every mode (it is read-only, and
   * shadow must predict what enforce would do): an unconfirmed blocker means we
   * touch this dependent in no way at all — no nudge either, because the premise
   * of the nudge ("your last blocker resolved") is what turned out to be stale.
   */
  async function handleInProgressDependent(sibling, unblockedBy, workflow, m, mode = "enforce") {
    if (!(await blockersConfirmedResolved(sibling))) {
      m.blockerConfirmAborted++;
      log(`[orchestrator] cascade extended-state action skipped (stale blocker snapshot) — ${sibling.ticketId}`);
      return "blockers-unconfirmed";
    }
    if (await leaseIsLive(sibling, workflow)) {
      return emitNudge(sibling, unblockedBy, workflow, m, mode);
    }
    return stealAndRedispatch(sibling, unblockedBy, workflow, m, mode);
  }

  /**
   * A dependent parked in_review (a human-review gate) whose last blocker just
   * resolved — e.g. a reopened gate whose rework fix children have all closed.
   * Re-wake the gate: emit review.reawakened and re-run the EXISTING gate
   * readiness path (re-parks in_review idempotently + refreshes the reviewer
   * notification if none is open). No ticket-status write beyond what that gate
   * logic itself decides. In shadow mode: observe only (reawakenGate not called).
   */
  async function handleInReviewDependent(sibling, unblockedBy, workflow, m, mode = "enforce") {
    if (mode !== "enforce") {
      m.wouldReviewReawaken++;
      log(`[orchestrator] cascade would-reawaken (shadow) — ${sibling.ticketId}`);
      return "would-review";
    }
    // Idempotent re-wake (Finding 2 / TEAM-3684). Concurrent last-blocker
    // completions each carry a stale in-memory snapshot, so both could re-notify
    // and re-emit review.reawakened for the SAME gate. Run the gate FIRST and let
    // it be the single arbiter: reawakenGate creates the reviewer notification
    // under a CAS keyed on "no open review_needed for this gate" and returns
    // whether THIS call actually (re)notified. Only the winner publishes
    // review.reawakened + counts the metric, so a duplicate is a silent no-op.
    // reawakenGate still never invokes an agent — it only parks + notifies.
    const notified = reawakenGate
      ? await reawakenGate(sibling.ticketId, sibling.assignee, workflow)
      : false;
    if (!notified) {
      log(`[orchestrator] cascade review re-wake — ${sibling.ticketId} (already open, skipped)`);
      return "review-noop";
    }
    await publishEvent(sibling.ticketId, "review.reawakened", {
      gateTicketId: sibling.ticketId, unblockedBy, workflowId: workflow?.id,
    });
    m.reviewReawakened++;
    log(`[orchestrator] cascade review re-wake — ${sibling.ticketId}`);
    return "review-reawakened";
  }

  /**
   * Recover ONE parked/ready dependent whose blockers are ALL resolved but which
   * missed its unblock event (TEAM-3747 D1, used by reconcile-sweep.mjs). This is
   * the single reuse point for the invariant — the sweep NEVER re-implements the
   * lease/steal logic, it routes candidates here.
   *
   * R3 is enforced FIRST and uniformly for every candidate: if the lease is live,
   * we do at most a nudge and NEVER steal — regardless of the board status the
   * scan observed (a board status can lag a just-issued claim). A dead lease then
   * recovers per status:
   *   - in_review          → re-wake the gate (handleInReviewDependent).
   *   - in_progress        → steal the stale generation + re-dispatch.
   *   - ready/todo/blocked → dispatch through the claim CAS (redispatch); a
   *     second sweep over an already-recovered ticket loses that CAS harmlessly.
   *
   * `mode` is the SWEEP's rollout mode (independent of the cascade's) — shadow
   * observes, enforce writes. Returns an outcome string the sweep tallies.
   */
  async function reconcileDependent(sibling, unblockedBy, workflow, m, mode) {
    // TEAM-3973 — an ESCALATED ticket is held for the human, in every status.
    // Escalation used to bind only the in_progress steal path, so the very next
    // sweep re-drove the ticket through the ready/todo/blocked branch and the
    // escalation meant nothing (prod TEAM-3897: escalated 20:54Z, re-dispatched
    // 20:59Z). The park transition cannot carry this on its own — a board with
    // no Blocked transition falls back to To Do, which IS dispatch-eligible.
    if (escalationHeld(sibling, workflow)) {
      m.escalationHeld = (m.escalationHeld || 0) + 1;
      log(`[orchestrator] reconcile hold (escalated, awaiting human) — ${sibling.ticketId} status=${sibling.status}`);
      return "escalation-held";
    }
    if (await leaseIsLive(sibling, workflow)) {
      return emitNudge(sibling, unblockedBy, workflow, m, mode);
    }
    if (sibling.status === "in_review") {
      return handleInReviewDependent(sibling, unblockedBy, workflow, m, mode);
    }
    if (sibling.status === "in_progress") {
      return stealWithRetryBudget(sibling, unblockedBy, workflow, m, mode);
    }
    // ready / todo / blocked — unblocked (or unblockable) but never dispatched.
    // No live claim to steal (the lease gate above already returned for a live
    // one); go straight through the claim CAS, which is the final arbiter.
    if (mode !== "enforce") {
      m.wouldRedispatch++;
      log(`[orchestrator] reconcile would-redispatch (shadow) — ${sibling.ticketId} status=${sibling.status}`);
      return "would-redispatch";
    }
    const dispatched = await redispatch(workflow, sibling);
    if (dispatched) {
      m.redispatched++;
      log(`[orchestrator] reconcile re-dispatch — ${sibling.ticketId} status=${sibling.status}`);
      return "redispatched";
    }
    log(`[orchestrator] reconcile re-dispatch refused — ${sibling.ticketId} (claim CAS lost — already recovered)`);
    return "redispatch-refused";
  }

  /**
   * TEAM-3973 — is this ticket parked on a human after an exhausted retry?
   * TRUE only while BOTH hold: the retry budget is spent AND the task still
   * carries the escalation's `error` status. A human (or the TEAM-3971 wake)
   * re-driving the ticket re-claims it — status leaves `error` — so the hold
   * releases itself with no extra bookkeeping and no permanent dead end.
   */
  function escalationHeld(sibling, workflow) {
    const task = workflow?.agentTasks?.[sibling.ticketId];
    if (task?.status !== "error") return false;
    return (workflow?.deadSessionRetries?.[sibling.ticketId] || 0) >= 1;
  }

  /**
   * TEAM-3969 — the sweep's stale-lease recovery shares the dead-session
   * detector's retry budget (workflow.deadSessionRetries[ticketId]): ONE
   * automatic re-dispatch per ticket, then escalate to a human. Without the cap
   * the sweep re-steals a permanently-dying session every lease TTL forever (an
   * agent parked fail-closed on a human gate is indistinguishable from a dead
   * one), and the detector's once-then-escalate policy never engages because the
   * sweep always steals first. Mirrors dead-session-detector.mjs retryOrEscalate.
   * The counter is bumped only after the steal CAS wins, so a steal aborted by a
   * live re-check never burns the budget. Unwired store = uncapped (pre-3968).
   */
  async function stealWithRetryBudget(sibling, unblockedBy, workflow, m, mode) {
    const ticketId = sibling.ticketId;
    const agentId = sibling.assignee;
    const priorRetries = workflow?.deadSessionRetries?.[ticketId] || 0;
    if (!store || priorRetries === 0) {
      const outcome = await stealAndRedispatch(sibling, unblockedBy, workflow, m, mode);
      // Steal CAS won (whether or not the re-dispatch claim did) → budget spent.
      if (store && (outcome === "redispatched" || outcome === "redispatch-refused")) {
        await store.incrementDeadSessionRetry(workflow.id, ticketId);
      }
      return outcome;
    }
    if (mode !== "enforce") {
      m.wouldRedispatch++;
      log(`[orchestrator] reconcile would-escalate (shadow) — ${ticketId} agent=${agentId} retry exhausted`);
      return "would-escalate";
    }
    const at = new Date(now()).toISOString();
    await publishEvent(ticketId, "agent.escalated", {
      workflowId: workflow.id, ticketId, agentId,
      reason: "dead_session_retry_exhausted", source: unblockedBy,
      claimStartedAt: workflow?.agentTasks?.[ticketId]?.startedAt || null,
    });
    await store.setTaskStatus(workflow.id, ticketId, "error");
    if (blockTicket) await blockTicket(ticketId, "dead_session_retry_exhausted");
    // TEAM-4120 FR-3 — same hook as the detector's twin: with the escalation tree
    // wired, IT writes the notification (with evidence + a resume path);
    // unwired (the default) this is byte-identical to pre-4120.
    if (escalate) {
      await escalate({
        workflow, ticketId, agentId,
        claim: {
          startedAt: workflow?.agentTasks?.[ticketId]?.startedAt,
          lastHeartbeatAt: null,
          source: "reconcile-sweep",
        },
      });
    } else {
      await store.appendNotification(workflow.id, {
        id: `notif_dead_session_${ticketId}_${at}`,
        type: "manager_escalation",
        title: `Dead session (retry exhausted): ${ticketId}`,
        details: `Agent ${agentId} went silent past the lease TTL twice on ${ticketId} (one automatic re-dispatch already spent). Auto-retry is exhausted — needs a human.`,
        reviewer: "reconcile-sweep",
        ticketId,
        timestamp: at,
        acknowledged: false,
      });
    }
    m.escalated = (m.escalated || 0) + 1;
    log(`[orchestrator] reconcile escalate — ${ticketId} agent=${agentId} retry exhausted`);
    return "escalated";
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

  // reconcileDependent + the primitives it composes are exposed so the
  // reconciliation sweep reuses the ONE implementation of the R3 invariant.
  return {
    cascadeUnblock,
    reconcileDependent,
    handleInProgressDependent,
    handleInReviewDependent,
    extendedMode,
  };
}

/** Fresh cascade metrics accumulator (real actions + shadow would-* counters). */
export function newMetrics() {
  return {
    nudged: 0,
    skippedLiveLease: 0,
    redispatched: 0,
    reviewReawakened: 0,
    dependentErrors: 0,
    wouldNudge: 0,
    wouldSteal: 0,
    wouldRedispatch: 0,
    wouldReviewReawaken: 0,
    // TEAM-3755 F9 — extended-state actions refused because a strongly-consistent
    // re-read showed a blocker was NOT actually resolved (stale GSI snapshot).
    blockerConfirmAborted: 0,
    // TEAM-4060 — level-triggered dispatch (in-process invoke on unblock).
    levelDispatched: 0,
    wouldDispatch: 0,
    levelDispatchErrors: 0,
  };
}

/** True when a cascade did anything worth an EMF record (real OR would-* shadow). */
export function hasCascadeActivity(m) {
  return !!(
    m.nudged || m.skippedLiveLease || m.redispatched || m.reviewReawakened ||
    m.dependentErrors || m.wouldNudge || m.wouldSteal || m.wouldRedispatch ||
    m.wouldReviewReawaken || m.blockerConfirmAborted ||
    m.levelDispatched || m.wouldDispatch || m.levelDispatchErrors
  );
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
          { Name: "CascadeDependentErrors", Unit: "Count" },
          { Name: "CascadeWouldNudge", Unit: "Count" },
          { Name: "CascadeWouldSteal", Unit: "Count" },
          { Name: "CascadeWouldRedispatch", Unit: "Count" },
          { Name: "CascadeWouldReviewReawaken", Unit: "Count" },
          { Name: "CascadeBlockerConfirmAborted", Unit: "Count" },
          { Name: "CascadeLevelDispatched", Unit: "Count" },
          { Name: "CascadeWouldDispatch", Unit: "Count" },
          { Name: "CascadeLevelDispatchErrors", Unit: "Count" },
        ],
      }],
    },
    CascadeNudgeLiveLease: m.nudged,
    CascadeSkippedLiveLease: m.skippedLiveLease,
    CascadeRedispatch: m.redispatched,
    CascadeReviewReawaken: m.reviewReawakened,
    CascadeDependentErrors: m.dependentErrors || 0,
    CascadeWouldNudge: m.wouldNudge || 0,
    CascadeWouldSteal: m.wouldSteal || 0,
    CascadeWouldRedispatch: m.wouldRedispatch || 0,
    CascadeWouldReviewReawaken: m.wouldReviewReawaken || 0,
    CascadeBlockerConfirmAborted: m.blockerConfirmAborted || 0,
    CascadeLevelDispatched: m.levelDispatched || 0,
    CascadeWouldDispatch: m.wouldDispatch || 0,
    CascadeLevelDispatchErrors: m.levelDispatchErrors || 0,
  }));
}
