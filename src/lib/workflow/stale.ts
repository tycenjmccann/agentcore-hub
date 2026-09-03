// Stale ("STUCK") verdict for a running workflow agent — TEAM-3858/TEAM-3862.
//
// The board marks an agent STUCK when no liveness signal arrives for a full
// threshold window. Liveness is streamed text OR tool activity: a long tool
// call emits no text, so counting only text growth made in-flight tool calls
// (claude_code runs, ticket-tool bursts) trip the badge while the agent was
// demonstrably working. Bookkeeping events (token_usage, status churn) do NOT
// count — a genuinely dead session must still cross the threshold and trip.

/** Normal tools return in seconds — 3 min of total silence means stuck. */
export const STALE_THRESHOLD_DEFAULT_MS = 180_000;
/** claude_code goes dark for the whole run: 15 min timeout + 2 min buffer. */
export const STALE_THRESHOLD_CLAUDE_CODE_MS = 1_020_000;

export function staleThresholdFor(anyAgentInClaudeCode: boolean): number {
  return anyAgentInClaudeCode ? STALE_THRESHOLD_CLAUDE_CODE_MS : STALE_THRESHOLD_DEFAULT_MS;
}

const LIVENESS_EVENT_TYPES = new Set(["agent_output", "tool_use", "tool_end"]);

/** True if this SSE event proves the agent is alive (resets the idle clock). */
export function isLivenessEvent(type: string): boolean {
  return LIVENESS_EVENT_TYPES.has(type);
}

/** True if this event is a dispatch — the orchestrator (re)starting the agent
 *  (agent_status → running). A dispatch is NOT liveness (a dead session emits
 *  no more of them), but it anchors/restarts the agent's idle clock: the live
 *  handler and page-load seeding must classify it identically, or a reload
 *  right after a re-dispatch falsely trips STUCK off the previous run's last
 *  liveness timestamp (TEAM-3888). */
export function isDispatchEvent(type: string, status?: string): boolean {
  return type === "agent_status" && status === "running";
}

/** The STUCK verdict: a running agent whose idle time exceeds the threshold. */
export function computeIsStale(opts: {
  now: number;
  lastActivityAt: number;
  hasRunningAgent: boolean;
  thresholdMs: number;
}): boolean {
  return opts.hasRunningAgent && opts.now - opts.lastActivityAt > opts.thresholdMs;
}

/** Statuses an agent can be marked stale in — the ONE predicate shared by the
 *  board card, the modal prop, and the interval verdict (TEAM-3881 F3). */
export function isStaleEligibleStatus(status?: string): boolean {
  return status === "running" || status === "waiting_response";
}

/** Per-agent STUCK verdicts (TEAM-3881 F1): each agent is judged against its
 *  OWN activity clock and its OWN tiered threshold, so one busy agent cannot
 *  keep a dead sibling looking alive (nor lend it the long claude_code
 *  window). Mutates lastActivityByAgent to anchor a first-observed agent at
 *  `now` — a never-emitting agent starts its idle clock when first seen
 *  running and still trips after a full threshold of silence. */
export function computeStaleAgentIds(opts: {
  now: number;
  tasks: Record<string, { status?: string }>;
  lastActivityByAgent: Record<string, number>;
  lastToolByAgent: Record<string, string>;
}): string[] {
  const stale: string[] = [];
  for (const [agentId, task] of Object.entries(opts.tasks)) {
    if (!isStaleEligibleStatus(task.status)) continue;
    let lastActivityAt = opts.lastActivityByAgent[agentId];
    if (lastActivityAt === undefined) {
      opts.lastActivityByAgent[agentId] = opts.now;
      lastActivityAt = opts.now;
    }
    if (
      computeIsStale({
        now: opts.now,
        lastActivityAt,
        hasRunningAgent: true,
        thresholdMs: staleThresholdFor(opts.lastToolByAgent[agentId] === "claude_code"),
      })
    ) {
      stale.push(agentId);
    }
  }
  return stale;
}

/** Seed per-agent activity clocks from historical events (page-load catch-up),
 *  classified by the same predicates the live path uses: isLivenessEvent
 *  (tool_end counts, agent_status/agent_complete don't — TEAM-3881 F4) and
 *  isDispatchEvent (a re-dispatch restarts the clock, exactly like the live
 *  handler's agent_status → running anchor — TEAM-3888; without it, run 1's
 *  old liveness timestamp shadows a newer run-2 dispatch and a reload before
 *  run 2's first output falsely trips STUCK). An agent with NO liveness or
 *  dispatch events anchors at its last event of any kind, so a session that
 *  died before emitting anything still trips immediately on load instead of
 *  a full threshold later. */
export function seedLastActivityByAgent(
  events: { type: string; agentId?: string; status?: string; timestamp?: string }[]
): Record<string, number> {
  const clock: Record<string, number> = {};
  const anchor: Record<string, number> = {};
  for (const ev of events) {
    if (!ev.agentId) continue;
    const ts = ev.timestamp ? new Date(ev.timestamp).getTime() : NaN;
    if (isNaN(ts) || ts <= 0) continue;
    if (isLivenessEvent(ev.type) || isDispatchEvent(ev.type, ev.status)) {
      clock[ev.agentId] = Math.max(clock[ev.agentId] ?? 0, ts);
    }
    anchor[ev.agentId] = ts;
  }
  const seeded: Record<string, number> = {};
  for (const agentId of Object.keys(anchor)) {
    seeded[agentId] = clock[agentId] ?? anchor[agentId];
  }
  return seeded;
}
