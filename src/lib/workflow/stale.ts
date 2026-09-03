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

/** The STUCK verdict: a running agent whose idle time exceeds the threshold. */
export function computeIsStale(opts: {
  now: number;
  lastActivityAt: number;
  hasRunningAgent: boolean;
  thresholdMs: number;
}): boolean {
  return opts.hasRunningAgent && opts.now - opts.lastActivityAt > opts.thresholdMs;
}
