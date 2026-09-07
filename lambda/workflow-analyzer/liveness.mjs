/**
 * Liveness clock — the analyzer's ONE per-phase staleness verdict (TEAM-4166 D2,
 * §2.1/§2.2/§2.4/§2.5). Pure: no AWS, no clock, no env read except through the
 * explicit `env` argument of thresholdsFromEnv. Every effect (the DynamoDB scan,
 * the events query, the harness invoke) stays in index.mjs; this module only
 * DECIDES, so it runs against plain objects in the unit + replay suites.
 *
 * WHY it exists: the pre-4166 WATCH scan judged staleness off a single
 * event-age window (WM_STALE_MINUTES) applied to every phase — so a dev agent
 * mid-claude_code (legitimately dark for ~15m) tripped the same clock as a ship
 * gate that should never sit silent. D2 gives each phase its own threshold and
 * treats a fresh span/stream as proof-of-life (the span-fresh override): a
 * ticket streaming every 20s is NEVER stale, in any phase.
 *
 * Fail-safe direction is SHADOW, not off: an unrecognized WM_LIVENESS_MODE
 * coerces to shadow (compute + log + metrics, ZERO intervention), never to off
 * — a typo must not silently blind the watchdog.
 */

import {
  LIVENESS_DEV_MS,
  LIVENESS_VERIFY_MS,
  LIVENESS_SHIP_MS,
  LIVENESS_SPAN_FRESH_MS,
  LIVENESS_DEFAULT_MS,
} from "./liveness-constants.mjs";

/** The allow-list. Order is documentation only. */
export const LIVENESS_MODES = ["off", "shadow", "enforce"];

/** Agent-task statuses that mean "a session is (or should be) live". */
const ACTIVE_STATUSES = new Set(["running", "in_progress"]);

/**
 * off | shadow | enforce. Anything else — a typo, an empty string, undefined —
 * coerces to SHADOW (observe-only) with a loud log, NEVER to off. This is the
 * deliberate inverse of the sync-main normalizer (which fail-safes to off,
 * because enforce there PUSHES to a shared branch): a liveness typo that
 * silently disabled the watchdog is worse than one that leaves it observing.
 */
export function normalizeLivenessMode(v, log) {
  const raw = v;
  const mode = String(v ?? "").trim().toLowerCase();
  if (LIVENESS_MODES.includes(mode)) return mode;
  const msg = `liveness.unknown_mode — WM_LIVENESS_MODE=${JSON.stringify(raw)} is not off|shadow|enforce; coercing to SHADOW (observe-only, zero intervention)`;
  if (typeof log === "function") log(msg);
  else console.warn(`[analyzer] ${msg}`);
  return "shadow";
}

/** A finite, strictly-positive minute count → ms; anything else → the default. */
function envMs(env, key, defMs) {
  const minutes = Number(env?.[key]);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : defMs;
}

/**
 * Resolve the per-phase thresholds from env, defaulting to the shared constants
 * (liveness-constants.mjs, mirror of src/config/liveness-constants.json). A
 * non-numeric or ≤0 override falls back to the default for THAT knob only.
 */
export function thresholdsFromEnv(env = process.env) {
  return {
    devMs: envMs(env, "WM_LIVENESS_DEV_MINUTES", LIVENESS_DEV_MS),
    verifyMs: envMs(env, "WM_LIVENESS_VERIFY_MINUTES", LIVENESS_VERIFY_MS),
    shipMs: envMs(env, "WM_LIVENESS_SHIP_MINUTES", LIVENESS_SHIP_MS),
    spanFreshMs: envMs(env, "WM_LIVENESS_SPAN_FRESH_MINUTES", LIVENESS_SPAN_FRESH_MS),
    defaultMs: envMs(env, "WM_LIVENESS_DEFAULT_MINUTES", LIVENESS_DEFAULT_MS),
  };
}

/** ISO string or epoch-ms → epoch-ms; anything unparseable → null. */
function toMs(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const parsed = Date.parse(v);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Newest (max) of the supplied timestamps, ignoring null/undefined. */
function newest(...vals) {
  let best = null;
  for (const v of vals) if (v != null && (best == null || v > best)) best = v;
  return best;
}

/**
 * ms of silence for one liveness ticket: now minus its newest signal of ANY
 * kind (stream, span, event, or the claim's startedAt fallback). Returns null
 * when the ticket carries no timestamp at all — the caller treats that as "no
 * evidence → not stale" (fail toward not firing).
 */
export function computeSilenceMs(t, nowMs) {
  const anchor = newest(t?.lastStreamAt, t?.lastSpanAt, t?.lastEventAt, t?.startedAt);
  if (anchor == null) return null;
  return nowMs - anchor;
}

/**
 * The stale threshold (ms) for a ticket in `phase`, given its recent-activity
 * ctx. The span-fresh override wins first: if a stream/span landed within
 * spanFreshMs the agent is DEMONSTRABLY alive, so the threshold is Infinity (it
 * can never be stale) regardless of phase. Otherwise per-phase:
 * development→devMs, verification→verifyMs, ship|gate→shipMs, else defaultMs.
 */
export function thresholdFor(phase, ctx, thresholds) {
  const nowMs = ctx?.nowMs;
  const freshest = newest(ctx?.lastStreamAt, ctx?.lastSpanAt);
  if (freshest != null && Number.isFinite(nowMs) && nowMs - freshest < thresholds.spanFreshMs) {
    return Infinity;
  }
  switch (phase) {
    case "development":
      return thresholds.devMs;
    case "verification":
      return thresholds.verifyMs;
    case "ship":
    case "gate":
      return thresholds.shipMs;
    default:
      return thresholds.defaultMs;
  }
}

/**
 * The subset of `tickets` whose silence has crossed their per-phase threshold,
 * each annotated with { staleAgeMs, thresholdMs }. A ticket with no evidence
 * (computeSilenceMs → null) or a span-fresh Infinity threshold is never stale.
 */
export function computeStaleTickets(tickets, nowMs, thresholds) {
  const stale = [];
  for (const t of tickets || []) {
    const thresholdMs = thresholdFor(
      t.phase,
      { nowMs, lastStreamAt: t.lastStreamAt, lastSpanAt: t.lastSpanAt },
      thresholds
    );
    if (!Number.isFinite(thresholdMs)) continue; // span-fresh → alive
    const staleAgeMs = computeSilenceMs(t, nowMs);
    if (staleAgeMs == null) continue; // no evidence → fail toward not firing
    if (staleAgeMs >= thresholdMs) stale.push({ ...t, staleAgeMs, thresholdMs });
  }
  return stale;
}

/**
 * The WATCH decision for one workflow. Returns whether to intervene, and on
 * which ticket (the WORST — longest-silent — stale ticket wins, so a single
 * scan surfaces the most-stalled agent). `verdicts` carries the per-ticket
 * computation for shadow logging + tests.
 */
export function decideWatch(workflow, tickets, nowMs, mode, thresholds) {
  const verdicts = (tickets || []).map((t) => {
    const thresholdMs = thresholdFor(
      t.phase,
      { nowMs, lastStreamAt: t.lastStreamAt, lastSpanAt: t.lastSpanAt },
      thresholds
    );
    const staleAgeMs = computeSilenceMs(t, nowMs);
    const spanFresh = !Number.isFinite(thresholdMs);
    const stale = !spanFresh && staleAgeMs != null && staleAgeMs >= thresholdMs;
    return { ticketId: t.ticketId, phase: t.phase, staleAgeMs, thresholdMs, spanFresh, stale };
  });

  const stale = verdicts.filter((v) => v.stale);
  if (!stale.length) {
    return { fire: false, reason: null, staleAgeMs: 0, ticketId: null, verdicts };
  }
  const worst = stale.reduce((a, b) => (b.staleAgeMs > a.staleAgeMs ? b : a));
  return {
    fire: true,
    reason: `stale:${worst.phase}`,
    staleAgeMs: worst.staleAgeMs,
    ticketId: worst.ticketId,
    verdicts,
  };
}

/**
 * Bucket a workflow's agentTasks + raw events into per-ticket liveness records
 * — the pure input to computeStaleTickets/decideWatch. Only ACTIVE tickets are
 * candidates (status running/in_progress, or a live lease per the injected
 * isLeaseLive). Per ticket:
 *   lastStreamAt — newest agent.streaming event ts for this ticket
 *   lastEventAt  — newest event of ANY type for this ticket
 *   lastSpanAt   — = lastStreamAt (Q1 proxy: no separate span source yet)
 *   startedAt    — the claim's startedAt (fallback anchor)
 * A ticket with NO timestamp at all is dropped (fail toward not firing). Event
 * timestamps accept ISO or epoch-ms; phase comes from the injected phaseOf.
 */
export function buildLivenessTickets({ agentTasks, events, nowMs, phaseOf, isLeaseLive }) {
  const evs = Array.isArray(events) ? events : [];
  const out = [];

  for (const [tid, task] of Object.entries(agentTasks || {})) {
    const active = ACTIVE_STATUSES.has(task?.status) || !!isLeaseLive?.(task);
    if (!active) continue;

    let lastStreamAt = null;
    let lastEventAt = null;
    for (const e of evs) {
      if (e?.detail?.ticketId !== tid) continue;
      const ts = toMs(e.timestamp ?? e.ts);
      if (ts == null) continue;
      if (lastEventAt == null || ts > lastEventAt) lastEventAt = ts;
      if (e.type === "agent.streaming" && (lastStreamAt == null || ts > lastStreamAt)) {
        lastStreamAt = ts;
      }
    }

    const startedAt = toMs(task?.startedAt);
    const lastSpanAt = lastStreamAt; // Q1 proxy

    if (lastStreamAt == null && lastEventAt == null && startedAt == null) continue;

    const phase = phaseOf?.(tid, task) ?? "default";
    out.push({
      ticketId: tid,
      agentId: task?.agentId,
      phase,
      active: true,
      lastStreamAt,
      lastEventAt,
      lastSpanAt,
      startedAt,
    });
  }
  return out;
}

/**
 * Map an agent id (+ the workflow's phase) to a liveness phase bucket. A human
 * gate (human:*) is a gate; the fleet roles map by function; anything else
 * falls back to the workflow phase (or "default"). Substring match keeps this
 * robust to the account-prefixed harness names (agentcore_hub_backend_dev, …)
 * without hardcoding the roster.
 */
export function phaseForAgent(agentId, workflowPhase) {
  const id = String(agentId || "").toLowerCase();
  if (id.startsWith("human:")) return "gate";
  if (id.includes("release_manager")) return "ship";
  if (id.includes("_dev") || id.endsWith("dev") || id.includes("developer")) return "development";
  if (id.includes("qa") || id.includes("ci_agent") || id.includes("code_reviewer") || id.includes("reviewer")) {
    return "verification";
  }
  return workflowPhase || "default";
}

/**
 * §2.4 ALWAYS-ON human-gate predicate. A workflow is parked on a human ONLY for
 * a gate a human genuinely owns — the f50ucz trap was a bare manager_escalation
 * (no gateTicketId) freezing a whole run against a human nudge that never came.
 *   review_needed      → parks iff humanAssignee starts with "human:". A legacy
 *                        row lacking humanAssignee parks iff its ticket's agent
 *                        (agentTasks[ticketId].agentId) starts with "human:";
 *                        otherwise it does NOT park.
 *   manager_escalation → parks ONLY when gateTicketId is a non-empty string.
 * Acknowledged notifications never park.
 */
export function isParkedOnHuman(wf) {
  const notifs = wf?.humanNotifications || [];
  const tasks = wf?.agentTasks || {};
  return notifs.some((n) => {
    if (!n || n.acknowledged) return false;
    if (n.type === "review_needed") {
      if (typeof n.humanAssignee === "string") return n.humanAssignee.startsWith("human:");
      const agentId = tasks[n.ticketId]?.agentId;
      return typeof agentId === "string" && agentId.startsWith("human:");
    }
    if (n.type === "manager_escalation") {
      return typeof n.gateTicketId === "string" && n.gateTicketId.length > 0;
    }
    return false;
  });
}
/** Alias — some call sites read parkedOnHuman, others isParkedOnHuman. */
export const parkedOnHuman = isParkedOnHuman;

/**
 * One EMF record per WATCH scan (AgentCoreHub/Orchestrator) — same envelope as
 * the reconcile sweep + dead-session detector. Explicit zeros so a healthy scan
 * is distinguishable from a silent (never-ran) one.
 */
export function emitLivenessMetrics(m) {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: "AgentCoreHub/Orchestrator",
            Dimensions: [[]],
            Metrics: [
              { Name: "LivenessStaleTickets", Unit: "Count" },
              { Name: "LivenessWatchFired", Unit: "Count" },
              { Name: "LivenessSpanFreshSkips", Unit: "Count" },
              { Name: "LivenessShadowDivergence", Unit: "Count" },
            ],
          },
        ],
      },
      LivenessMode: m?.mode,
      LivenessStaleTickets: m?.staleTickets || 0,
      LivenessWatchFired: m?.watchFired || 0,
      LivenessSpanFreshSkips: m?.spanFreshSkips || 0,
      LivenessShadowDivergence: m?.shadowDivergence || 0,
    })
  );
}
