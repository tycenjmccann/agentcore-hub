/**
 * TEAM-4113 — rework-loop cap (per-workflow-phase lineage backstop).
 *
 * The review-cap (review-cap.mjs, TEAM-3619) caps the review→rework loop keyed
 * by the GATE TICKET id. That is exactly right for the loop where one gate keeps
 * re-rejecting the same diff. But it resets to zero whenever the loop hops to a
 * NEW ticket id — a fresh gate ticket spawned by a dedupe miss, a bug-fix reopen
 * that files a brand-new QA/review ticket, or a phase (dev, QA) that has no gate
 * ticket at all and so is never counted. Those are precisely the runs that spin
 * for hours filing qa_fix #1..#9 against the same phase and never converge,
 * because nothing counts the loop across the changing ticket ids.
 *
 * This is the lineage backstop: count rework ROUNDS per (workflowId, phase),
 * NOT per ticket id, so distinct fix-ticket ids in the same phase accumulate.
 * A "round" is one distinct fix ticket (spawnedBy.kind ∈ review_fix|qa_fix|
 * codex_fix) reaching Done in that phase. When the count crosses the lineage
 * cap the loop is provably runaway.
 *
 * Fail-safe direction is the OPPOSITE of the ship gates. A ship gate that
 * over-fires wedges a run (bad), so unknown modes fail to `off`. Here the
 * dangerous failure is the reverse — an unbounded rework loop that silently
 * burns hours and dollars — so an unknown/garbage mode falls to `shadow`
 * (observe-only), never off: we always at least MEASURE the loop.
 *
 *   off      byte-identical to today (caller never invokes observe()).
 *   shadow   full ledger + ReworkLoop* metrics + WOULD-cap log; zero events,
 *            zero human-facing side effects.
 *   enforce  additionally publishes `rework.cap_reached` (which the Workflow
 *            Manager WATCH + system-SI loop already consume) and best-effort
 *            parks the run's OPEN release-manager escalation gate via the
 *            injected parkRunEscalationGate. It NEVER creates a ticket, NEVER
 *            refuses fix creation, and NEVER blocks the cascade — the run keeps
 *            flowing while a human is paged. (Creating a per-phase human gate
 *            for a gate-less phase, and refusing further fix creation in the
 *            tickets Lambda, are the documented Phase-2 follow-ups.)
 *
 * Observed at BOTH ticket-done paths (Jira `handleTicketDoneUnified` + DDB
 * `handleTicketDone`) the instant a fix ticket completes. Ledger writes go
 * through workflow-store.mjs (R2 — the store is the sole workflows-table
 * writer), mirroring the review-cap's reviewGateHistory ledger exactly.
 */

import { openEscalation, parseDecision } from "./review-cap.mjs";

/** Lineage cap. One above the review-cap's per-gate default (3) so this is a
 * true BACKSTOP: the per-gate cap stops a single stuck gate first; this catches
 * the loop only once it has hopped ticket ids enough to evade that. */
export const REWORK_LOOP_CAP_DEFAULT_MAX = 4;

const MODES = new Set(["off", "shadow", "enforce"]);
const LEGACY_ENFORCE = new Set(["on", "true", "1", "yes", "enabled"]);
const DEFAULT_FIX_KINDS = new Set(["review_fix", "qa_fix", "codex_fix"]);

/**
 * Mode normalization — fail-safe to SHADOW (observe-only), never off. Legacy
 * truthy strings mean enforce (an operator who set "on" wanted the cap active).
 * Only an explicit "off" turns it off; anything unrecognized still measures.
 */
export function normalizeReworkLoopMode(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "off") return "off";
  if (MODES.has(v)) return v;
  if (LEGACY_ENFORCE.has(v)) return "enforce";
  return "shadow";
}

export const lineageKey = (workflowId, phase) => `${workflowId}:${phase}`;

const idOf = (t) => t?.ticketId || t?.id || t?.key || null;

/** A rework round = a completed fix ticket (spawnedBy.kind is a fix kind). */
export function isReworkFix(ticket, fixKinds = DEFAULT_FIX_KINDS) {
  const kind = ticket?.spawnedBy?.kind;
  return typeof kind === "string" && fixKinds.has(kind);
}

/**
 * Effective rounds for a lineage ledger: DISTINCT fix-ticket ids recorded,
 * minus the reset baseline a human `DECISION: continue` authorization set. A
 * re-Done of the SAME fix ticket is not a new round (dedupe by ticketId), which
 * keeps a double-transition (mark_done + report_completion) from inflating the
 * count — the same hazard the review-cap dedupes by round number.
 */
export function effectiveReworkRounds(ledger) {
  const rounds = Array.isArray(ledger?.rounds) ? ledger.rounds : [];
  const distinct = new Set(rounds.map((r) => r?.ticketId).filter(Boolean)).size;
  const auths = Array.isArray(ledger?.authorizations) ? ledger.authorizations : [];
  const baseline = auths.reduce(
    (m, a) => (typeof a?.resetAtRound === "number" ? Math.max(m, a.resetAtRound) : m),
    0
  );
  return Math.max(0, distinct - baseline);
}

/**
 * EMF metric emitter (same namespace/shape as the ship gates). `counter` is one
 * of the keys below, or null for an all-zero heartbeat.
 */
export function emitReworkLoopMetrics(counter, now = Date.now) {
  const m = { round: 0, wouldCap: 0, capReached: 0, authorized: 0, failOpen: 0 };
  if (counter && counter in m) m[counter] = 1;
  console.log(JSON.stringify({
    _aws: {
      Timestamp: typeof now === "function" ? now() : now,
      CloudWatchMetrics: [{
        Namespace: "AgentCoreHub/Orchestrator",
        Dimensions: [[]],
        Metrics: [
          { Name: "ReworkLoopRound", Unit: "Count" },
          { Name: "ReworkLoopWouldCap", Unit: "Count" },
          { Name: "ReworkLoopCapReached", Unit: "Count" },
          { Name: "ReworkLoopAuthorized", Unit: "Count" },
          { Name: "ReworkLoopFailOpen", Unit: "Count" },
        ],
      }],
    },
    ReworkLoopRound: m.round,
    ReworkLoopWouldCap: m.wouldCap,
    ReworkLoopCapReached: m.capReached,
    ReworkLoopAuthorized: m.authorized,
    ReworkLoopFailOpen: m.failOpen,
  }));
}

/**
 * @param {object}   deps
 * @param {object}   deps.store                 workflow-store (append{ReworkRound,ReworkEscalation,ReworkAuthorization})
 * @param {function} deps.publishEvent          (ticketId, name, detail) => Promise
 * @param {function} [deps.parkRunEscalationGate] (workflow, phase) => Promise<boolean>; enforce-only, best-effort
 * @param {function} [deps.emitMetrics]         (counter, now) => void
 * @param {number}   [deps.maxRounds]           lineage cap (default 4)
 * @param {Set}      [deps.fixKinds]            spawnedBy.kind values that count
 * @param {string}   [deps.mode]                off|shadow|enforce (already normalized)
 * @param {function} [deps.now]                 () => Date
 * @param {function} [deps.log]                 (msg) => void
 */
export function createReworkLoopCap(deps) {
  const {
    store,
    publishEvent,
    parkRunEscalationGate = null,
    emitMetrics = emitReworkLoopMetrics,
    maxRounds = REWORK_LOOP_CAP_DEFAULT_MAX,
    fixKinds = DEFAULT_FIX_KINDS,
    mode = "off",
    now = () => new Date(),
    log = () => {},
  } = deps;

  /**
   * Observe one just-completed ticket. Returns a decision object; performs the
   * ledger write + (enforce) side effects itself. NEVER throws — a ledger or
   * publish failure fails OPEN (observe-only), because this must never block
   * the done cascade it hangs off.
   */
  async function observe({ workflow, ticket, phase, feedback }) {
    if (mode === "off") return { action: "disabled" };
    if (!workflow?.id || !ticket) return { action: "no-input" };
    if (!isReworkFix(ticket, fixKinds)) return { action: "not-a-fix" };
    // Unclassifiable phase (e.g. a human gate whose assignee has no agent phase)
    // is deliberately NOT counted — same fail-safe as the ship-dispatch gate.
    if (!phase) return { action: "no-phase" };

    const key = lineageKey(workflow.id, phase);
    const ticketId = idOf(ticket);

    // Human override, parity with the review-cap: an explicit `DECISION: continue`
    // while an escalation is open authorizes another `maxRounds` and resets the
    // count. Only reached when this lineage is already escalated, so the normal
    // fix-done path skips the extra read entirely.
    const prior = workflow?.reworkLineage?.[key] || null;
    const open = openEscalation(prior);
    if (open && parseDecision(feedback) === "continue") {
      const auth = {
        decision: "continue",
        resetAtRound: open.escalatedAtRound,
        forEscalationAtRound: open.escalatedAtRound,
        decidedAt: now().toISOString(),
        source: ticketId,
      };
      try { await store.appendReworkAuthorization(workflow.id, key, auth); }
      catch (err) { log(`[rework-loop-cap] authorization persist failed for ${key} (non-fatal): ${err.message}`); }
      try {
        await publishEvent(ticketId, "rework.cap_authorized", {
          workflowId: workflow.id, lineageKey: key, phase, resetAtRound: auth.resetAtRound,
        });
      } catch (err) { log(`[rework-loop-cap] cap_authorized publish failed (non-fatal): ${err.message}`); }
      emitMetrics("authorized");
      return { action: "authorized", phase, resetAtRound: auth.resetAtRound };
    }

    // Record this round. Use the POST-write ledger so a concurrent fix-done in
    // the same lineage is counted (list_append, never a whole-array rewrite).
    let ledger;
    try {
      ledger = await store.appendReworkRound(workflow.id, key, { ticketId, at: now().toISOString() });
    } catch (err) {
      log(`[rework-loop-cap] ledger write failed for ${key} (fail-open, observe-only): ${err.message}`);
      emitMetrics("failOpen");
      return { action: "ledger-failed" };
    }
    if (!ledger) return { action: "ledger-missing" }; // row gone; don't invent a count

    const rounds = effectiveReworkRounds(ledger);
    emitMetrics("round");

    if (rounds < maxRounds) return { action: "recorded", phase, rounds };

    // Cap tripped. Idempotent: an already-open escalation for this lineage is
    // not re-signalled (a subsequent fix-done just re-reads it as still-open).
    if (openEscalation(ledger)) return { action: "still-escalated", phase, rounds };

    if (mode === "shadow") {
      log(`[rework-loop-cap] WOULD cap ${key} at ${rounds} rework rounds (max ${maxRounds}) — shadow`);
      emitMetrics("wouldCap");
      return { action: "would-cap", phase, rounds };
    }

    // enforce: persist the escalation marker (idempotency key + audit),
    // signal it, best-effort park the run's open escalation gate. Nothing here
    // stops the cascade or the loop's fix creation — it only pages a human.
    try {
      await store.appendReworkEscalation(workflow.id, key, {
        escalatedAtRound: rounds, decision: null, escalatedAt: now().toISOString(),
      });
    } catch (err) { log(`[rework-loop-cap] escalation persist failed for ${key} (signalling anyway): ${err.message}`); }
    try {
      await publishEvent(ticketId, "rework.cap_reached", {
        workflowId: workflow.id, lineageKey: key, phase, rounds, max: maxRounds,
      });
    } catch (err) { log(`[rework-loop-cap] cap_reached publish failed (non-fatal): ${err.message}`); }
    emitMetrics("capReached");

    let parked = false;
    if (parkRunEscalationGate) {
      try { parked = (await parkRunEscalationGate(workflow, phase)) === true; }
      catch (err) { log(`[rework-loop-cap] park failed (non-fatal): ${err.message}`); }
    }
    return { action: "capped", phase, rounds, parked };
  }

  return { observe, mode };
}
