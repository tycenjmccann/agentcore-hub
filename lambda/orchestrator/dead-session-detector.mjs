/**
 * Dead-session detector — orchestrator sweep (TEAM-3618 D1.2).
 *
 * A scheduled EventBridge rule (rate(5 minutes)) invokes the orchestrator with
 * the sentinel { source: "orchestrator.sweep", action: "dead_session_sweep" }.
 * This module owns the sweep: find agent claims whose lease is DEAD and whose
 * silence has run past a per-agent threshold, then recover them — steal the
 * stale claim, emit agent.error, and either re-dispatch ONCE or escalate.
 *
 * Hard invariants (see docs/race-condition-study.md):
 *   R2 — every workflows-table write goes through workflow-store.mjs.
 *   R3 — lease semantics are NEVER re-implemented here; liveness/steal come from
 *        lease.mjs. isLeaseLive is the MANDATORY FIRST guard on every candidate:
 *        a session whose heartbeat is within the lease TTL is untouchable, and
 *        the silence threshold is floored at LEASE_TTL_MS so the math can never
 *        fire inside a live lease even if the guard were bypassed.
 *   Steal is never forced — stealClaim only wins against the exact generation
 *        the sweep inspected (its startedAt), so a re-issued claim is safe.
 *
 * Modes (DEAD_SESSION_DETECTOR_MODE): off = skip; shadow (default) = full sweep
 * + logs/metrics + a would-fire dead_session.shadow event (its own type, NOT
 * agent.error — shadow is the default, and every agent.error consumer reads that
 * type as a real failure: UI error cards, anomaly agent_error_retry_rate), but
 * ZERO writes (no steal, no retry, no status change); enforce = full behavior,
 * and only enforce ever publishes a real agent.error. The gate
 * fails SAFE: the value is trimmed + lowercased, and anything that is not
 * exactly off|shadow|enforce is coerced to shadow with a loud warning — only
 * the literal normalized "enforce" may write.
 *
 * Backstop (TEAM-3683): the sweep also picks up tasks a prior enforce sweep
 * stole (status "ready" + deadSessionDetectedAt stamped) but never re-drove
 * because that sweep crashed between the steal and the retry/escalate
 * decision — otherwise those tasks stall silently forever ("ready" is not a
 * live status).
 *
 * Backstop (TEAM-3702): a RUNNING task that still carries a stamp (the
 * resurrected-path clear failed on a transient DynamoDB error, or a sweep
 * crashed between stamp and steal) is re-evaluated on every sweep, never
 * skipped: the clear is retried while the lease is live, and recovery is
 * re-driven on the held stamp once the lease is dead. No state permanently
 * exempts a generation from detection.
 *
 * Testability: all effects (ddb, store, lease, publishEvent, redispatch,
 * blockTicket, getTicket, getAgentDef, clock) are injected via `deps`, so the
 * sweep runs against a stub client + stub store with no AWS.
 */

import { QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
// The ONE open-workflow scan, shared with reconcile-sweep.mjs (TEAM-3839): the
// capped window ROTATES across sweeps (TEAM-3764 F5) so >SWEEP_CAP open
// workflows can never permanently starve the older tail.
import { SWEEP_CAP, createOpenWorkflowScan } from "./sweep-scan.mjs";
// TEAM-4166 §0 — the ONE union-blocker predicate the cascade / reconcile-sweep
// use, so the detector's clean-park anti-thrash decides identically (blockedBy ∪
// preconditionUnmet.awaitingIds, all terminal in the sibling snapshot). Pure.
import { unionBlockersResolved } from "./cascade.mjs";
// TEAM-4184 F1 — the ONE D2 evidence predicate, shared with cascade.mjs so the two
// guards can never diverge. Pure; awaited-ids.mjs has zero AWS imports.
import { parkEvidence, awaitedWaitedMs } from "./awaited-ids.mjs";

// Sweep bounds and threshold knobs. The silence threshold is derived per-agent
// from its own recent run durations; these frame that derivation.
const MEDIAN_WINDOW = 20;           // most-recent completed runs sampled per agent
const MEDIAN_MULTIPLIER = 3;        // silence must exceed 3× the agent's typical run
const FALLBACK_MULTIPLIER = 2;      // cold-start silence = 2× TTL (the stale-claim hatch)
const MIN_SAMPLES = 5;              // below this, the median is untrustworthy → fallback
const MAX_THRESHOLD_MS = 6 * 60 * 60 * 1000; // never wait more than 6h to call it dead
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;     // median cache lifetime (matches the rule)
const LIVE_STATUSES = ["running", "in_progress"];
const MEDIAN_SCAN_PAGES = 10;       // bound the events scan on a cold median miss
const COMPLETION_SCAN_PAGES = 20;   // bound the completion-check query (× 500 items/page,
                                    // same bound as lease.lastAgentActivity)
const KNOWN_MODES = ["off", "shadow", "enforce"];

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

/** Median of a numeric array (0 for empty). Pure. */
function median(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Build a sweep runner bound to its dependencies. The median cache lives in the
 * closure so it survives across sweeps on a warm Lambda but not across cold
 * starts (a cold start just recomputes — correct, never stale).
 */
export function createDetector(deps) {
  const {
    ddb,
    workflowsTable,
    eventsTable,
    store,
    lease,
    getTicket,
    getAgentDef,
    publishEvent,
    redispatch,
    blockTicket,
    // TEAM-4120 FR-3 — optional dead-session escalation tree. When unwired
    // (DEAD_SESSION_ESCALATION_MODE=off, the default) the exhausted-retry path
    // appends the bare manager_escalation notification exactly as before.
    escalate,
    // TEAM-4166 D2 §2.3 — the evidence-gated escalation guard. All optional, so
    // unwired = byte-identical to pre-4166: the retry-exhausted branch escalates
    // exactly as before. The guard engages only when the store exposes the new
    // incrementCleanExitRedispatch CAS (the counter that bounds clean re-wakes
    // WITHOUT burning deadSessionRetries). `awaitedIds` supplies the once-only
    // wait-SLA timeout at the cap; `getLastStreamAt` feeds the escalation
    // evidence payload (null when absent).
    awaitedIds,
    cleanExitRedispatchCap = 3,
    getLastStreamAt,
    // TEAM-4166 §0 — OPTIONAL sibling reader (the same getChildTickets the
    // cascade / reconcile-sweep use). When wired, the clean-park guard checks the
    // union blockers before re-dispatching a parked ticket, so it never thrashes
    // a release manager that is legitimately still waiting on open fixes. When
    // absent the guard keeps its pre-4166 capped-redispatch behavior (the detector
    // has no sibling snapshot of its own, so it cannot see the awaited edges).
    getChildTickets,
    now = () => Date.now(),
    log = (msg) => console.log(`[orchestrator] ${msg}`),
  } = deps;

  const cleanExitCap = Number.isInteger(cleanExitRedispatchCap) && cleanExitRedispatchCap > 0
    ? cleanExitRedispatchCap
    : 3;

  // agentId → { medianMs, sampleCount, computedAt }. Refreshed once per sweep
  // interval; a busy fleet reuses one median across the whole sweep.
  const medianCache = new Map();

  /**
   * Scan workflows in a non-terminal phase, newest first, capped at SWEEP_CAP.
   * Shared implementation (sweep-scan.mjs, TEAM-3839): the previous local copy
   * truncated with a fixed newest-first slice(0, SWEEP_CAP), so with more than
   * SWEEP_CAP open workflows the older tail was NEVER inspected — dead sessions
   * there silently accumulated forever. The shared scan rotates the capped
   * window across sweeps (TEAM-3764 F5, ported from reconcile-sweep), so every
   * open workflow is inspected within ceil(N/SWEEP_CAP) rotation quanta.
   * Returns { workflows, matched, rotation, pages } so the caller can flag
   * truncation. Below the cap this is exactly the old behavior.
   */
  const scanNonTerminalWorkflows = createOpenWorkflowScan({ ddb, workflowsTable, now });

  /**
   * True if an agent.complete for this ticket was published at/after the claim
   * started — i.e. the session finished and this candidate is stale. The task
   * status would normally already read "complete", but the status write and the
   * event aren't atomic; this closes the window where the event landed first.
   * DynamoDB applies Limit BEFORE the filter, so a single small page can miss a
   * match deeper in the partition — paginate until a match or the partition is
   * exhausted, bounded at COMPLETION_SCAN_PAGES × 500 scanned items (the same
   * bound lease.lastAgentActivity uses). The first match suffices.
   */
  async function hasCompletionSince(workflowId, ticketId, sinceIso) {
    let lastKey;
    for (let page = 0; page < COMPLETION_SCAN_PAGES; page++) {
      const res = await ddb.send(new QueryCommand({
        TableName: eventsTable,
        KeyConditionExpression: "workflowId = :w",
        FilterExpression: "#t = :complete AND detail.ticketId = :tid AND #ts >= :since",
        ExpressionAttributeNames: { "#t": "type", "#ts": "timestamp" },
        ExpressionAttributeValues: {
          ":w": workflowId,
          ":complete": "agent.complete",
          ":tid": ticketId,
          ":since": sinceIso || "",
        },
        Limit: 500,
        ExclusiveStartKey: lastKey,
      }));
      if ((res.Items || []).length > 0) return true;
      lastKey = res.LastEvaluatedKey;
      if (!lastKey) break;
    }
    return false;
  }

  /**
   * Rolling median run-duration (ms) for an agent, from its last MEDIAN_WINDOW
   * agent.complete events paired with their agent.started. Cached per sweep
   * interval. Best-effort: an events scan that surfaces fewer than MIN_SAMPLES
   * pairs returns that low count, and the caller falls back to the TTL multiple.
   */
  async function rollingMedian(agentId) {
    const cached = medianCache.get(agentId);
    if (cached && now() - cached.computedAt < SWEEP_INTERVAL_MS) return cached;

    const starts = new Map(); // `${workflowId}:${ticketId}` → latest started ms
    const durations = [];     // most-recent-first
    let lastKey;
    for (let page = 0; page < MEDIAN_SCAN_PAGES; page++) {
      const res = await ddb.send(new ScanCommand({
        TableName: eventsTable,
        FilterExpression: "#t IN (:started, :complete) AND detail.agentId = :aid",
        ExpressionAttributeNames: { "#t": "type" },
        ExpressionAttributeValues: {
          ":started": "agent.started",
          ":complete": "agent.complete",
          ":aid": agentId,
        },
        ExclusiveStartKey: lastKey,
      }));
      for (const e of res.Items || []) {
        const key = `${e.workflowId}:${e.detail?.ticketId || ""}`;
        const ts = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
        if (!Number.isFinite(ts)) continue;
        if (e.type === "agent.started") {
          const prev = starts.get(key);
          if (prev === undefined || ts > prev) starts.set(key, ts);
        }
      }
      // Second pass over the same page: match completes to the started we know.
      for (const e of res.Items || []) {
        if (e.type !== "agent.complete") continue;
        const key = `${e.workflowId}:${e.detail?.ticketId || ""}`;
        const ts = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
        const startedTs = starts.get(key);
        if (!Number.isFinite(ts) || startedTs === undefined || ts < startedTs) continue;
        durations.push({ ts, dur: ts - startedTs });
      }
      lastKey = res.LastEvaluatedKey;
      if (!lastKey) break;
    }
    durations.sort((a, b) => b.ts - a.ts);
    const window = durations.slice(0, MEDIAN_WINDOW).map((d) => d.dur);
    const result = { medianMs: median(window), sampleCount: window.length, computedAt: now() };
    medianCache.set(agentId, result);
    return result;
  }

  /**
   * Silence threshold (ms): 3× the agent's typical run, floored at the lease TTL
   * (so it can never fire inside a live lease) and capped at 6h. Below
   * MIN_SAMPLES the median is untrustworthy — fall back to 2× TTL, the same
   * conservative window the stale-claim escape hatch uses.
   *
   * Deliberately does NOT consume resolveWatchdog()/agents.json watchdog config:
   * the detection threshold is anchored to the R3 lease TTL + observed durations
   * so per-agent config can never undercut the lease (design TEAM-3617
   * §D1.2/§D1.3).
   */
  function computeThreshold(medianMs, sampleCount) {
    if (sampleCount < MIN_SAMPLES) return FALLBACK_MULTIPLIER * lease.LEASE_TTL_MS;
    return clamp(MEDIAN_MULTIPLIER * medianMs, lease.LEASE_TTL_MS, MAX_THRESHOLD_MS);
  }

  /**
   * TEAM-4166 D2 §2.3 — the evidence block attached to an agent.escalated event
   * so an operator can see WHY the orchestrator concluded a session was dead
   * rather than cleanly parked. lastSpanAt/lastStreamAt come from the injected
   * getLastStreamAt dep (null when unwired); lastSpanStatus is "ok" only when the
   * task genuinely completed (never true on this dead escalate path); exitReason
   * is null on the dead path.
   */
  async function buildEscalationEvidence(workflow, ticket, { completedOk = false, exitReason = null, parkEvidence: parkReason = null } = {}) {
    const ticketId = ticket?.ticketId;
    let lastStreamAt = null;
    try {
      lastStreamAt = getLastStreamAt ? await getLastStreamAt(workflow?.id, ticketId) : null;
    } catch {
      lastStreamAt = null;
    }
    const task = workflow?.agentTasks?.[ticketId];
    return {
      lastSpanAt: lastStreamAt,
      lastSpanStatus: completedOk ? "ok" : null,
      lastStreamAt,
      completedAt: task?.completedAt || null,
      preconditionAt: ticket?.preconditionUnmet?.reportedAt || null,
      exitReason: exitReason ?? null,
      // TEAM-4184 F1 — which term of the evidence predicate decided. "stale-stamp"
      // = the ticket carries a preconditionUnmet from an EARLIER claim that was
      // already re-woken once, so it says nothing about this session.
      parkEvidence: parkReason,
    };
  }

  /**
   * Steps 4/5 of the enforce path: retry ONCE, else escalate. The pre-read
   * retry-counter snapshot decides; markDeadSessionDetected admits one
   * decision per claim generation. Deliberately idempotent so the stolen-task
   * backstop can re-drive it after a partial failure: a candidate whose
   * re-dispatch already landed loses the claim CAS inside redispatch
   * harmlessly, and a crash after the counter bump re-drives into escalation
   * (never a retry loop).
   */
  async function retryOrEscalate({ workflow, ticket, ticketId, agentId, detectorMeta, m, startedAtMs, sweepId }) {
    const priorRetries = workflow.deadSessionRetries?.[ticketId] || 0;
    if (priorRetries === 0) {
      await store.incrementDeadSessionRetry(workflow.id, ticketId);
      // Re-dispatch through the NORMAL path: claim CAS → invoke. The CAS is
      // the final arbiter (the steal flipped status→ready, so it wins).
      const redispatched = await redispatch(workflow, ticket);
      if (redispatched) {
        m.retries++;
        log(`detector.retry — re-dispatched ${ticketId} agent=${agentId} (sweep ${sweepId})`);
      } else {
        log(`detector.retry_claim_lost — ${ticketId} lost the re-dispatch claim CAS (sweep ${sweepId})`);
      }
    } else {
      // TEAM-4166 D2 §2.3 — EVIDENCE GUARD. The retry budget is spent, so the
      // pre-4166 code escalated unconditionally here. But a session that
      // genuinely completed (agent.complete since the claim start), or a release
      // manager that parked itself clean (preconditionUnmet stamped), is NOT a
      // dead session — escalating it appends a manager_escalation that trips
      // parkedOnHuman and freezes the run (the f50ucz false positive). Re-wake it
      // instead, capped by cleanExitRedispatches (NOT deadSessionRetries, which
      // is never touched on this clean path); escalation is reserved for the
      // genuinely dead. Engages only when the store exposes the clean-exit CAS —
      // an old store keeps the pre-4166 unconditional escalate.
      const canGuard = typeof store.incrementCleanExitRedispatch === "function";
      const claimStartedAt = workflow.agentTasks?.[ticketId]?.startedAt || detectorMeta?.claimStartedAt || null;
      const completedOk = canGuard && await hasCompletionSince(workflow.id, ticketId, claimStartedAt);
      const cleanRedispatches = workflow?.cleanExitRedispatches?.[ticketId] || 0;

      // TEAM-4166 §0 ANTI-THRASH / TEAM-4184 F1. A cleanly-parked ticket is still
      // legitimately waiting until its awaited fixes close, and "is any awaited id
      // still open" is now also one term of the evidence predicate itself — so the
      // sibling closure is fetched ONCE, here, ahead of the parkedClean decision,
      // and shared by both. The cascade has this snapshot for free; the detector
      // fetches it only when the ticket actually carries a stamp, and only when a
      // reader is wired (index.mjs always wires one; absent, the predicate simply
      // cannot see the edges and falls back to its two timestamp/budget terms).
      let siblings = null;
      if (canGuard && ticket?.preconditionUnmet?.awaitingIds?.length && getChildTickets && workflow?.epicId) {
        try {
          siblings = await getChildTickets(workflow.epicId);
        } catch (err) {
          siblings = null;
          log(`detector.awaited_siblings_error — ${ticketId}: ${err?.message || err} (sweep ${sweepId})`);
        }
      }

      // The SHARED D2 evidence predicate (awaited-ids.mjs) — the same one
      // cascade.stealWithRetryBudget uses. Mere presence of preconditionUnmet used
      // to be enough here, which made a ticket that ever parked permanently
      // un-escalatable: nothing clears the stamp, so a genuinely dead RE-WOKEN
      // session kept reading "parked clean" off the old stamp.
      const parkEv = parkEvidence(ticket, {
        siblings: Array.isArray(siblings) ? siblings : undefined,
        claimStartedAt,
        cleanRedispatches,
      });
      const parkedClean = canGuard && parkEv.parkedClean;
      if (canGuard && (completedOk || parkedClean)) {
        // Still waiting on open work → touch nothing (no redispatch, no budget, no
        // clean-exit counter): the ordinary cascade re-drives it when the last
        // blocker closes.
        if (parkedClean && Array.isArray(siblings) && !unionBlockersResolved(ticket, siblings)) {
          m.awaiting = (m.awaiting || 0) + 1;
          log(`detector.awaiting — ${ticketId} clean park, awaited blockers still open (sweep ${sweepId})`);
          return;
        }
        if (cleanRedispatches >= cleanExitCap) {
          // Re-woken to the cap without landing — advisory wait-SLA timeout ONLY,
          // never a manager_escalation (that is the parkedOnHuman trap this fix
          // removes). An event, not a humanNotification.
          //
          // TEAM-4184 F2: judged against the sibling snapshot fetched above, not
          // against `[]`. Passing no snapshot made every id in the union count as
          // non-terminal, so the event listed ids that had already gone done — the
          // cap path is only reachable once they have. With nothing left awaited the
          // honest report is an empty list under reason=clean_exit_cap; either way
          // the wait is the real one, not 0.
          if (awaitedIds?.emitAwaitTimeoutOnce) {
            const to = awaitedIds.checkAwaitTimeout?.(ticket, Array.isArray(siblings) ? siblings : [], now());
            await awaitedIds.emitAwaitTimeoutOnce(
              workflow, ticketId,
              to?.awaitingIds || [],
              to?.waitedMs ?? awaitedWaitedMs(ticket, now()),
              "dead-session-detector",
              { reason: to ? "await_timeout" : "clean_exit_cap" });
          }
          m.awaiting = (m.awaiting || 0) + 1;
          log(`detector.awaiting — ${ticketId} clean park/exit at clean-exit cap ${cleanExitCap} (sweep ${sweepId})`);
          return;
        }
        // A clean re-wake: count it on cleanExitRedispatches, re-dispatch through
        // the normal claim CAS, and leave deadSessionRetries untouched.
        await store.incrementCleanExitRedispatch(workflow.id, ticketId);
        const redispatched = await redispatch(workflow, ticket);
        m.exitedOk = (m.exitedOk || 0) + 1;
        log(redispatched
          ? `detector.exited_ok — ${ticketId} clean park/exit re-woken (not dead) (sweep ${sweepId})`
          : `detector.exited_ok_claim_lost — ${ticketId} clean re-wake lost the claim CAS (sweep ${sweepId})`);
        return;
      }

      // Genuinely dead — escalate, don't loop. Now carries the §2.3 evidence,
      // including WHICH evidence term ruled the park out (TEAM-4184 F1).
      const evidence = await buildEscalationEvidence(workflow, ticket, { parkEvidence: parkEv.reason });
      await publishEvent(ticketId, "agent.escalated", {
        workflowId: workflow.id, ticketId, agentId,
        reason: "dead_session_retry_exhausted", detectorMeta,
        evidence,
      });
      await store.setTaskStatus(workflow.id, ticketId, "error");
      await blockTicket(ticketId, "dead_session_retry_exhausted");
      // TEAM-4120 FR-3 — when DEAD_SESSION_ESCALATION_MODE is on, the escalation
      // tree (page → synthesize → park) writes the notification instead, with
      // evidence and a resume path. Unwired (`escalate` undefined, the default)
      // this is byte-identical to pre-4120: the bare page below.
      if (escalate) {
        await escalate({
          workflow, ticketId, agentId,
          claim: {
            startedAt: workflow.agentTasks?.[ticketId]?.startedAt,
            lastHeartbeatAt: detectorMeta?.lastHeartbeatAt,
            source: "dead-session-detector",
            detectorMeta,
          },
        });
      } else {
        await store.appendNotification(workflow.id, {
          id: `notif_dead_session_${ticketId}_${new Date(startedAtMs).toISOString()}`,
          type: "manager_escalation",
          title: `Dead session (retry exhausted): ${ticketId}`,
          details: `Agent ${agentId} died twice on ${ticketId} (last heartbeat ${detectorMeta.lastHeartbeatAt || "unknown"}). Auto-retry is exhausted — needs a human.`,
          reviewer: "dead-session-detector",
          ticketId,
          timestamp: new Date(startedAtMs).toISOString(),
          acknowledged: false,
        });
      }
      m.escalations++;
      log(`detector.escalate — ${ticketId} agent=${agentId} retry exhausted (sweep ${sweepId})`);
    }
  }

  /**
   * Run one sweep. `mode` is off | shadow | enforce (anything else is coerced
   * to shadow — fail safe). Returns a metrics summary (also emitted as an EMF
   * record) for observability + tests.
   */
  async function runSweep(mode = "shadow") {
    const startedAtMs = now();
    const sweepId = `sweep_${startedAtMs}_${Math.random().toString(36).slice(2, 8)}`;
    // Mode gate fails SAFE: normalize (trim + lowercase), and coerce anything
    // that is not exactly off|shadow|enforce to shadow (observe-only). A typo
    // or casing slip in the env var must never grant write permission.
    const rawMode = mode;
    mode = String(mode ?? "").trim().toLowerCase();
    if (!KNOWN_MODES.includes(mode)) {
      mode = "shadow";
      log(`detector.unknown_mode — DEAD_SESSION_DETECTOR_MODE=${JSON.stringify(rawMode)} is not off|shadow|enforce; coercing to SHADOW (observe-only, zero writes) (sweep ${sweepId})`);
    }
    const m = {
      sweepId,
      mode,
      candidates: 0,
      skippedLiveLease: 0,
      fired: 0,
      // Of the fired deaths, how many were the "streamed-then-silent" class
      // (FR-D4.1's hung-tool-call target: activity AFTER start, then silence
      // past threshold — a mid-turn hang) vs "silent-since-start" (never
      // heartbeat past the claim). A classification tag on detectorMeta, not a
      // change to detection: both classes were already recovered by the
      // silence-vs-threshold math; this only makes the class observable.
      hungToolCalls: 0,
      retries: 0,
      escalations: 0,
      candidateErrors: 0,
      truncated: false,
      // TEAM-4166 D2 §2.3 — evidence-gated outcomes: a clean re-wake (exitedOk)
      // or a held clean park at the cap (awaiting), NEITHER an escalation.
      exitedOk: 0,
      awaiting: 0,
    };

    if (mode === "off") {
      log(`dead-session sweep skipped (mode=off)`);
      return m;
    }

    const { workflows, matched, rotation, pages } = await scanNonTerminalWorkflows();
    if (matched > SWEEP_CAP) {
      m.truncated = true;
      log(`dead_session.sweep_truncated — ${matched} non-terminal workflows, capped at ${SWEEP_CAP}; inspecting rotating window ${rotation + 1}/${pages} (every window is reached within ${pages} rotation quanta) (sweep ${sweepId})`);
    }

    for (const workflow of workflows) {
      const tasks = workflow.agentTasks || {};
      for (const [ticketId, task] of Object.entries(tasks)) {
        if (!task) continue;
        const live = LIVE_STATUSES.includes(task.status);
        // Stolen-but-stalled (TEAM-3683 backstop): a prior enforce sweep won
        // the stamp + steal but died before its retry/escalate decision
        // landed, leaving status "ready" with deadSessionDetectedAt set — a
        // state no other path revisits ("ready" is not a live status).
        const stalledSteal = task.status === "ready" && !!task.deadSessionDetectedAt;
        if (!live && !stalledSteal) continue;
        // Already stamped for this still-live-STATUS generation (TEAM-3702):
        // never skip it outright. The stamp can be residue of a resurrected-
        // path clear that failed on a transient DynamoDB error (the TEAM-3698
        // clear rethrows anything non-conditional and the catch below swallows
        // it), or of a sweep that crashed between stamp and steal — an
        // unconditional skip would leave this generation permanently exempt
        // from detection. Re-evaluate instead: guard 1 retries the CAS'd clear
        // when the lease is live (and does nothing else — R3), and the enforce
        // path treats the held stamp as already won when the lease is dead.
        const alreadyStamped = live && !!task.deadSessionDetectedAt;

        // Per-candidate isolation (TEAM-3683): one failing candidate must not
        // abort the rest of the sweep — log it, count it, move on.
        try {
          const agentId = task.agentId;
          const ticket = await getTicket(ticketId);
          // Leaf, non-epic, still in_progress on the board. An epic or a ticket a
          // human already moved off in_progress is not a live agent session.
          if (!ticket || ticket.type === "epic") continue;
          if (ticket.status !== "in_progress") continue;

          m.candidates++;

          // ── BACKSTOP: re-drive a stolen-but-stalled task. ────────────────────
          // The lease-liveness guard doesn't apply here — "ready" is not a live
          // claim status; the steal already happened for this generation.
          if (stalledSteal) {
            if (mode === "shadow") {
              log(`detector.would_recover (shadow) — ${ticketId} agent=${agentId} stolen-but-stalled since ${task.deadSessionDetectedAt} (sweep ${sweepId})`);
              continue;
            }
            // The scan snapshot may be stale — re-read, and skip if the claim
            // generation moved (re-claimed, completed, escalated) since then.
            const freshWorkflow = await store.getWorkflow(workflow.id);
            const fresh = freshWorkflow?.agentTasks?.[ticketId];
            if (!fresh || fresh.status !== "ready" || !fresh.deadSessionDetectedAt
              || (fresh.startedAt || null) !== (task.startedAt || null)) {
              log(`detector.recover_skipped — ${ticketId} claim moved since scan (sweep ${sweepId})`);
              continue;
            }
            log(`detector.recover_stalled — ${ticketId} agent=${agentId} re-driving retry/escalate (sweep ${sweepId})`);
            // Idempotent re-drive: the fresh counter read decides retry vs
            // escalate, and a re-dispatch that already landed loses the claim
            // CAS inside redispatch harmlessly.
            await retryOrEscalate({
              workflow: freshWorkflow, ticket, ticketId, agentId,
              detectorMeta: {
                lastHeartbeatAt: null,
                claimStartedAt: task.startedAt || null,
                deadSessionDetectedAt: task.deadSessionDetectedAt,
                recoveredStalledSteal: true,
                sweepId,
              },
              m, startedAtMs, sweepId,
            });
            continue;
          }

          // ── GUARD 1 (MANDATORY, FIRST): the lease must be DEAD. ──────────────
          const lastActivity = await lease.lastAgentActivity(
            ddb, eventsTable, workflow.id, agentId, ticketId
          );
          if (lease.isLeaseLive(task, lastActivity, startedAtMs)) {
            m.skippedLiveLease++;
            // A stamp on a LIVE lease is residue of a clear that failed or
            // raced (TEAM-3702) — retry the generation-CAS'd clear so the
            // task stays cheaply detectable, and do NOTHING else against the
            // live lease (R3). A retry that fails again just repeats here
            // next sweep; even a never-clearing stamp is only hygiene now,
            // because the enforce path below re-drives a stamped generation
            // once its lease actually dies.
            if (alreadyStamped) {
              if (mode === "enforce") {
                const cleared = await store.clearDeadSessionDetected(workflow.id, ticketId, task.startedAt);
                log(cleared
                  ? `detector.stale_stamp_cleared — ${ticketId} stamped but lease live; residual stamp cleared (sweep ${sweepId})`
                  : `detector.stale_stamp_clear_lost — ${ticketId} stamped but lease live; clear CAS lost (claim moved) (sweep ${sweepId})`);
              } else {
                log(`detector.would_clear_stale_stamp (shadow) — ${ticketId} stamped but lease live (sweep ${sweepId})`);
              }
            }
            continue;
          }

          // Session already completed for this generation (event beat the status
          // write) — nothing dead to recover.
          if (await hasCompletionSince(workflow.id, ticketId, task.startedAt)) continue;

          // ── GUARD 2: silence must exceed the per-agent threshold. ────────────
          const { medianMs, sampleCount } = await rollingMedian(agentId);
          const threshold = computeThreshold(medianMs, sampleCount);
          const startedMs = task.startedAt ? Date.parse(task.startedAt) : 0;
          const activityMs = lastActivity ? Date.parse(lastActivity) : 0;
          const lastHeartbeatMs = Math.max(startedMs, activityMs);
          const silence = startedAtMs - lastHeartbeatMs;
          if (silence <= threshold) continue;

          const lastHeartbeatAt = lastHeartbeatMs
            ? new Date(lastHeartbeatMs).toISOString()
            : null;
          // Classify the death (FR-D4.1). "streamed_then_silent" = the session
          // emitted a heartbeat AFTER its claim start (activityMs > startedMs)
          // then fell silent — the hung-tool-call class the watchdog exists to
          // catch. "silent_since_start" = no heartbeat ever cleared the claim
          // start. Both are recovered identically; the tag is purely for
          // observability (metric + event payload), so detection is unchanged.
          const deathClass = activityMs > startedMs ? "streamed_then_silent" : "silent_since_start";
          const detectorMeta = {
            lastHeartbeatAt,
            medianMs,
            sampleCount,
            threshold,
            deathClass,
            claimStartedAt: task.startedAt || null,
            sweepId,
          };

          // ── SHADOW: observe only. Would-fire, flagged, no writes. ────────────
          // The would-fire event is published as dead_session.shadow, NOT
          // agent.error (TEAM-3698): shadow is the DEFAULT mode, and every
          // agent.error consumer treats the type as a real failure — the UI
          // stream maps it to an error card and the anomaly watcher counts it in
          // agent_error_retry_rate. A distinct type keeps the full observation
          // payload without polluting either. Detail is unchanged.
          if (mode === "shadow") {
            m.fired++;
            if (deathClass === "streamed_then_silent") m.hungToolCalls++;
            await publishEvent(ticketId, "dead_session.shadow", {
              workflowId: workflow.id, ticketId, agentId,
              reason: "dead_session", shadow: true, detectorMeta,
            });
            log(`detector.would_fire (shadow) — ${ticketId} agent=${agentId} silence=${silence}ms threshold=${threshold}ms (sweep ${sweepId})`);
            continue;
          }

          // ── ENFORCE: recover the dead session. ───────────────────────────────
          // 1. Sweep-idempotency CAS on the exact claim generation. Lose → skip.
          //    A generation that already carries the stamp (TEAM-3702: residue
          //    of a failed clear, or of a sweep that crashed between stamp and
          //    steal) holds it instead of re-stamping — the attribute_not_exists
          //    arm of markDeadSessionDetected would lose forever. The steal CAS
          //    below still arbitrates on the exact generation, so a stale scan
          //    snapshot (stamp since cleared / claim re-issued) stays safe, and
          //    concurrent sweeps racing through here resolve at the steal.
          const stamped = alreadyStamped
            || await store.markDeadSessionDetected(workflow.id, ticketId, task.startedAt);
          if (!stamped) {
            log(`detector.cas_lost — ${ticketId} (claim moved or already detected) (sweep ${sweepId})`);
            continue;
          }
          // 1b. TOCTOU re-check (TEAM-3683): guard 1 read liveness BEFORE the
          // median/completion work above — an agent that resurrected (heart-
          // beated) in between must not be stolen. Re-read activity now; if the
          // lease is live again, leave it alone — and CLEAR the stamp we just
          // wrote (TEAM-3698), CAS'd to this exact generation so a claim that
          // moved on in the meantime keeps its own state. The clear is hygiene,
          // not the last line of defense: if it fails (transient DynamoDB
          // error) or loses its CAS, later sweeps re-evaluate the stamped
          // generation instead of skipping it (TEAM-3702) — the clear retried
          // while the lease is live, recovery re-driven once it is dead.
          const recheckActivity = await lease.lastAgentActivity(
            ddb, eventsTable, workflow.id, agentId, ticketId
          );
          if (lease.isLeaseLive(task, recheckActivity, now())) {
            m.skippedLiveLease++;
            const cleared = await store.clearDeadSessionDetected(workflow.id, ticketId, task.startedAt);
            if (cleared) {
              log(`detector.resurrected — ${ticketId} lease live again after stamp; skipping steal, stamp cleared, remains recoverable (sweep ${sweepId})`);
            } else {
              // Generation moved between the stamp and the clear (re-claimed,
              // completed, escalated) — safe either way: the stamp we wrote is
              // gone with the old generation, or a new owner holds this entry.
              log(`detector.resurrected — ${ticketId} lease live again after stamp; skipping steal, stamp clear CAS lost (claim moved) (sweep ${sweepId})`);
            }
            continue;
          }
          // 2. Steal the stale claim (never forced — exact generation only).
          const stole = await lease.stealClaim(ddb, workflowsTable, workflow.id, ticketId, task.startedAt);
          if (!stole) {
            log(`detector.steal_lost — ${ticketId} claim moved after stamp (sweep ${sweepId})`);
            continue;
          }
          // 3. Announce the death.
          await publishEvent(ticketId, "agent.error", {
            workflowId: workflow.id, ticketId, agentId,
            reason: "dead_session", detectorMeta,
          });
          m.fired++;
          if (deathClass === "streamed_then_silent") m.hungToolCalls++;

          // 4/5. Retry ONCE, else escalate. The pre-read snapshot count decides;
          // markDeadSessionDetected guarantees one decision per generation.
          await retryOrEscalate({ workflow, ticket, ticketId, agentId, detectorMeta, m, startedAtMs, sweepId });
        } catch (err) {
          // A candidate left mid-recovery is picked up by the stolen-but-
          // stalled backstop on the next sweep; everything else here is
          // CAS-guarded, so continuing is safe.
          m.candidateErrors++;
          log(`detector.candidate_error — ${ticketId} ${err?.name || "Error"}: ${err?.message || err} (sweep ${sweepId})`);
        }
      }
    }

    m.durationMs = now() - startedAtMs;
    emitMetrics(m);
    log(`dead-session sweep done — mode=${mode} candidates=${m.candidates} skippedLiveLease=${m.skippedLiveLease} fired=${m.fired} hungToolCalls=${m.hungToolCalls} retries=${m.retries} escalations=${m.escalations} exitedOk=${m.exitedOk} awaiting=${m.awaiting} candidateErrors=${m.candidateErrors} truncated=${m.truncated} durationMs=${m.durationMs} (sweep ${sweepId})`);
    return m;
  }

  return { runSweep, rollingMedian, computeThreshold, scanNonTerminalWorkflows, hasCompletionSince };
}

/**
 * Emit the sweep summary as a single EMF record (AgentCoreHub/Orchestrator
 * namespace). Same emitter shape as eval-packager's emitEvalMetrics — CloudWatch
 * Logs auto-extracts these into metrics with no SDK call. Healthy sweeps write
 * explicit 0s so a silent detector is distinguishable from a healthy one.
 */
export function emitMetrics(m) {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: "AgentCoreHub/Orchestrator",
        Dimensions: [[]],
        Metrics: [
          { Name: "DetectorSweepDurationMs", Unit: "Milliseconds" },
          { Name: "DetectorCandidates", Unit: "Count" },
          { Name: "DetectorSkippedLiveLease", Unit: "Count" },
          { Name: "DetectorFired", Unit: "Count" },
          { Name: "DetectorHungToolCalls", Unit: "Count" },
          { Name: "DetectorRetries", Unit: "Count" },
          { Name: "DetectorEscalations", Unit: "Count" },
          { Name: "DetectorCandidateErrors", Unit: "Count" },
          { Name: "DetectorSweepTruncated", Unit: "Count" },
          // TEAM-4166 D2 §2.3 — evidence-gated re-wake outcomes.
          { Name: "DetectorExitedOk", Unit: "Count" },
          { Name: "DetectorAwaiting", Unit: "Count" },
        ],
      }],
    },
    DetectorMode: m.mode,
    DetectorSweepDurationMs: m.durationMs || 0,
    DetectorCandidates: m.candidates,
    DetectorSkippedLiveLease: m.skippedLiveLease,
    DetectorFired: m.fired,
    DetectorHungToolCalls: m.hungToolCalls || 0,
    DetectorRetries: m.retries,
    DetectorEscalations: m.escalations,
    DetectorCandidateErrors: m.candidateErrors || 0,
    DetectorSweepTruncated: m.truncated ? 1 : 0,
    DetectorExitedOk: m.exitedOk || 0,
    DetectorAwaiting: m.awaiting || 0,
  }));
}
