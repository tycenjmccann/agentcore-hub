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

/**
 * TEAM-4186 F6 — the LEGACY clock's event window, as a named constant.
 *
 * Pre-epic, the analyzer's whole staleness decision was ONE function whose input
 * was a Query with `Limit: 25`:
 *
 *   const page = await ddb.send(new QueryCommand({ …, ScanIndexForward: false, Limit: 25 }));
 *   const item = (page.Items || []).find((e) => !NON_SIGNIFICANT_EVENT_TYPES.has(e.type)) || (page.Items || [])[0];
 *
 * TEAM-4166 D2 raised that Limit to 50 for the liveness clock (which needs more
 * rows to find each ticket's newest agent.streaming) and reused the SAME find
 * over all 50 for the legacy decision. That silently changed the legacy verdict,
 * which is supposed to be byte-identical in `off` and to be the sole driver in
 * `shadow`: a healthy generating agent emits one agent.streaming row per content
 * delta (lambda/orchestrator/agent-invoker.mjs contentBlockDelta;
 * deploy/runtime-agent/main.py), so ≥25 streaming rows being newest is NORMAL.
 * Pre-epic that window held no significant row at all, so the decision fell back
 * to items[0] — a streaming row, age ≈ 0, no fire. Over 50 rows the find instead
 * reaches a significant row at position 26-50 (e.g. an agent.invoked 15 minutes
 * old), so legacyAge ≥ STALE_MS and the watchdog fires MORE on healthy agents,
 * on the DEFAULT path.
 *
 * The fix is to hand the legacy decision exactly the first 25 rows. That is a
 * restoration, not an approximation: the Query carries no FilterExpression, so
 * `Limit: 25` returns PRECISELY the first 25 items of the same
 * `ScanIndexForward: false` ordering that `Limit: 50` returns —
 * i.e. Limit-25 ≡ slice(0, 25) of the Limit-50 page, item for item.
 */
export const LEGACY_EVENT_WINDOW = 25;

/**
 * Not agent activity: streaming chunks are too chatty to mean anything alone,
 * and orchestrator.nudge is a housekeeping event the orchestrator publishes
 * itself (a live lease it chose not to steal) — counting either keeps a run
 * looking fresh no matter what the agent is doing (TEAM-3969).
 *
 * Lives here (rather than in index.mjs) as of TEAM-4186 so the legacy decision
 * and its tests share ONE definition with no AWS import in the way.
 */
export const NON_SIGNIFICANT_EVENT_TYPES = new Set(["agent.streaming", "orchestrator.nudge"]);

/**
 * Age in ms of the newest non-streaming event in `items`, or null if none.
 *
 * The two lines below are the pre-epic `lastSignificantEventAge` body VERBATIM
 * (lambda/workflow-analyzer/index.mjs before TEAM-4166), so byte-identity is
 * inspectable rather than argued. The only change is where the 25 rows come
 * from: the caller slices them (see LEGACY_EVENT_WINDOW) instead of the Query
 * limiting them. Callers MUST pass at most LEGACY_EVENT_WINDOW rows — handing it
 * a deeper window is exactly the F6 regression.
 */
export function legacySignificantEventAge(items, nowMs) {
  const item = (items || []).find((e) => !NON_SIGNIFICANT_EVENT_TYPES.has(e.type)) || (items || [])[0];
  if (!item?.timestamp) return null;
  return nowMs - Date.parse(item.timestamp);
}

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
 * kind (stream, span, event, the window floor, or the claim's startedAt
 * fallback). Returns null when the ticket carries no timestamp at all — the
 * caller treats that as "no evidence → not stale" (fail toward not firing).
 *
 * TEAM-4186 F7 — why `windowFloorAt` belongs in the anchor. The event window is
 * a bounded read (index.mjs recentEventsPaged, hard cap MAX_EVENT_PAGES), so a
 * ticket can legitimately have NO row in it: one sibling streaming for 15
 * minutes emits thousands of agent.streaming rows and can push every other
 * ticket's newest row past the cap. Without a floor such a ticket falls back to
 * startedAt (hours old) and is declared stale purely because it was starved of
 * evidence — a false positive that, in enforce, interrupts a working agent.
 *
 * The floor makes truncation SOUND rather than merely bounded. For a ticket with
 * no row in the window, its newest event is provably OLDER than the oldest row
 * read, so `now − windowFloor` is a LOWER BOUND on its true silence. Anchoring
 * at the floor means stale fires only when even that lower bound crosses the
 * threshold: never a false stale from starvation, at worst a delayed detection
 * (and each later scan reads a fresher window). spanFresh correctly cannot
 * engage on such a ticket — lastStreamAt is unknown, not proven absent.
 */
export function computeSilenceMs(t, nowMs) {
  const anchor = newest(t?.lastStreamAt, t?.lastSpanAt, t?.lastEventAt, t?.windowFloorAt, t?.startedAt);
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
 * TEAM-4289 r3-F2 — the WORKFLOW-level fallback, for a run with nothing to judge.
 *
 * WHY it exists: every per-ticket verdict comes from buildLivenessTickets, whose
 * candidates are activeTicketIds — status running/in_progress, or a live lease.
 * A non-terminal run can legitimately have ZERO of those and still be broken: a
 * completed task whose dependent's Ready webhook was dropped, or a run sitting
 * idle between dispatches. Such a run yields an EMPTY verdict list, and an empty
 * list is not evidence of health — it is the ABSENCE of evidence. Before this
 * fallback, `enforce` read that absence as "nothing stale" and never fired,
 * while the legacy workflow-level clock (legacySignificantEventAge over the
 * 25-row window, else now − startedAt, vs WM_STALE_MINUTES) WOULD have fired —
 * so switching the watchdog to enforce silently LOST coverage on exactly the
 * runs nobody was watching. The reviewer's scratch run is the proof:
 * `legacyFire:true, decision.fire:false` on a non-terminal run with no active
 * tasks.
 *
 * The caller supplies the clock (`idle = { ageMs, thresholdMs }`) rather than
 * this module inventing one — index.mjs passes its EXISTING legacyAge + STALE_MS,
 * which makes enforce a provable SUPERSET of the legacy watchdog's coverage and
 * adds no new threshold knob.
 *
 * Returns null (not a decision) whenever it does not engage, so decideWatch's
 * existing fall-through stays untouched. A run parked on a real human gate is
 * NOT unattended, so isParkedOnHuman vetoes the fallback here as well as in
 * watchScan's pre-filter — the veto is then provable through the pure decision.
 */
export function decideIdleWorkflow(workflow, idle) {
  const ageMs = Number(idle?.ageMs);
  const thresholdMs = Number(idle?.thresholdMs);
  if (!Number.isFinite(ageMs) || !Number.isFinite(thresholdMs)) return null;
  if (isParkedOnHuman(workflow)) return null; // a real human gate is not unattended
  if (ageMs < thresholdMs) return null;
  return { fire: true, reason: "stale:idle", staleAgeMs: ageMs, ticketId: null, verdicts: [] };
}

/**
 * The WATCH decision for one workflow. Returns whether to intervene, and on
 * which ticket (the WORST — longest-silent — stale ticket wins, so a single
 * scan surfaces the most-stalled agent). `verdicts` carries the per-ticket
 * computation for shadow logging + tests.
 *
 * `idle` (TEAM-4289 r3-F2, OPTIONAL) is the workflow-level clock consulted ONLY
 * when there are zero verdicts — see decideIdleWorkflow. Omit it and the
 * behaviour is exactly as before: fire:false on an empty ticket list.
 */
export function decideWatch(workflow, tickets, nowMs, mode, thresholds, idle) {
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
    // TEAM-4289 r3-F2: NO verdicts at all means nothing was ACTIVE to judge, not
    // that the run is healthy — fall back to the caller's workflow-level clock so
    // the run is never left unattended. Gated on verdicts (not on the caller's
    // active-id count) deliberately: a ticket buildLivenessTickets dropped for
    // carrying no timestamp at all is equally unjudged, and equally unattended.
    // With even ONE verdict the per-ticket clocks decide and `idle` is ignored.
    if (!verdicts.length && idle) {
      const idleDecision = decideIdleWorkflow(workflow, idle);
      if (idleDecision) return idleDecision;
    }
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
 * The ticket ids this workflow considers ACTIVE — status running/in_progress, or
 * a live lease per the injected isLeaseLive.
 *
 * TEAM-4186 F7 — extracted so the READ (how deep to page the event window) and
 * the DECISION (buildLivenessTickets) cannot drift on what "active" means: the
 * paging loop stops once every active ticket has a sample, which is only sound
 * if it is asking about exactly the tickets the clock will later judge.
 */
export function activeTicketIds({ agentTasks, isLeaseLive } = {}) {
  return Object.entries(agentTasks || {})
    .filter(([, task]) => ACTIVE_STATUSES.has(task?.status) || !!isLeaseLive?.(task))
    .map(([tid]) => tid);
}

/**
 * The largest PHASE threshold (ms) — the deepest any verdict can look back.
 * spanFreshMs is deliberately excluded: it is not a staleness threshold but the
 * proof-of-life override, and it is the smallest of the five.
 */
export function maxThresholdMs(thresholds) {
  return Math.max(
    thresholds?.devMs || 0,
    thresholds?.verifyMs || 0,
    thresholds?.shipMs || 0,
    thresholds?.defaultMs || 0
  );
}

/** Oldest (min) parseable event timestamp in the window, or null if it has none. */
export function eventsWindowFloor(events) {
  let floor = null;
  for (const e of Array.isArray(events) ? events : []) {
    const ts = toMs(e?.timestamp ?? e?.ts);
    if (ts != null && (floor == null || ts < floor)) floor = ts;
  }
  return floor;
}

/** The active ticket ids with NO row of their own in `events` (starved). */
export function missingSampleTicketIds({ activeTicketIds: ids, events }) {
  const seen = new Set();
  for (const e of Array.isArray(events) ? events : []) {
    const tid = e?.detail?.ticketId;
    if (tid != null && toMs(e.timestamp ?? e.ts) != null) seen.add(tid);
  }
  return (ids || []).filter((tid) => !seen.has(tid));
}

/**
 * TEAM-4186 F7 — may the paging loop stop? True when the window already decides
 * every active ticket, i.e. either
 *   (a) every active id has at least one row of its own in it, or
 *   (b) the OLDEST row read is already older than now − maxThresholdMs.
 * (b) is sound because a starved ticket's newest event is provably older than
 * that floor, so its silence already exceeds every phase threshold — a deeper
 * read can only make it older, and spanFresh cannot engage that far back
 * (spanFreshMs is the smallest threshold). This is the EFFICIENCY stop; the
 * windowFloorAt anchor (see computeSilenceMs) is what makes the hard page cap
 * safe when this never becomes true.
 */
export function livenessWindowSatisfied({ activeTicketIds: ids, events, nowMs, maxThresholdMs: maxMs }) {
  if (!missingSampleTicketIds({ activeTicketIds: ids, events }).length) return true;
  const floor = eventsWindowFloor(events);
  return floor != null && Number.isFinite(nowMs) && Number.isFinite(maxMs) && nowMs - floor > maxMs;
}

/**
 * Bucket a workflow's agentTasks + raw events into per-ticket liveness records
 * — the pure input to computeStaleTickets/decideWatch. Only ACTIVE tickets are
 * candidates (see activeTicketIds). Per ticket:
 *   lastStreamAt  — newest agent.streaming event ts for this ticket
 *   lastEventAt   — newest event of ANY type for this ticket
 *   lastSpanAt    — = lastStreamAt (Q1 proxy: no separate span source yet)
 *   windowFloorAt — TEAM-4186 F7: for a ticket with NO row in the window, the
 *                   oldest row READ (the caller's windowFloorMs) — a sound lower
 *                   bound on its silence. null when the ticket HAS a sample: its
 *                   newest event is then known exactly, so no bound is needed.
 *   startedAt     — the claim's startedAt (last-resort anchor)
 * A ticket with NO timestamp at all — none of lastStreamAt/lastEventAt/
 * windowFloorAt/startedAt — is dropped (fail toward not firing). Event
 * timestamps accept ISO or epoch-ms; phase comes from the injected phaseOf.
 */
export function buildLivenessTickets({ agentTasks, events, nowMs, phaseOf, isLeaseLive, windowFloorMs }) {
  const evs = Array.isArray(events) ? events : [];
  const floorMs = toMs(windowFloorMs);
  const out = [];

  for (const tid of activeTicketIds({ agentTasks, isLeaseLive })) {
    const task = agentTasks[tid];

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
    // Only a STARVED ticket gets the floor: with a sample of its own, its newest
    // event is known exactly and a lower bound would be strictly worse.
    const windowFloorAt = lastStreamAt == null && lastEventAt == null ? floorMs : null;

    if (lastStreamAt == null && lastEventAt == null && windowFloorAt == null && startedAt == null) continue;

    const phase = phaseOf?.(tid, task) ?? "default";
    out.push({
      ticketId: tid,
      agentId: task?.agentId,
      phase,
      active: true,
      lastStreamAt,
      lastEventAt,
      lastSpanAt,
      windowFloorAt,
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
              // TEAM-4186 F7 — how deep the event window had to go, and how often
              // the hard page cap cut it short (the windowFloorAt-anchored path).
              { Name: "LivenessWindowPages", Unit: "Count" },
              { Name: "LivenessWindowTruncated", Unit: "Count" },
            ],
          },
        ],
      },
      LivenessMode: m?.mode,
      LivenessStaleTickets: m?.staleTickets || 0,
      LivenessWatchFired: m?.watchFired || 0,
      LivenessSpanFreshSkips: m?.spanFreshSkips || 0,
      LivenessShadowDivergence: m?.shadowDivergence || 0,
      LivenessWindowPages: m?.windowPages || 0,
      LivenessWindowTruncated: m?.windowTruncated || 0,
    })
  );
}
