/**
 * Fleet-wide watchdog / heartbeat configuration (D1.1 of TEAM-3618).
 *
 * "Is the agent dead / stuck?" is enforced by three knobs — the SSE/heartbeat
 * cadence, the per-tool subprocess deadline, and the per-turn wall-clock. They
 * were hardcoded in three languages (src/lib/agentcore-sdk.ts, the orchestrator
 * Lambda, deploy/runtime-agent/main.py). This is the single place the app side
 * resolves them; the Lambda mirror lives in lambda/orchestrator/watchdog.mjs and
 * the runtime reads them payload-first in main.py.
 *
 * Resolution order per field (identical in every consumer):
 *   per-agent agents.json watchdog.<field>
 *     → defaults.watchdog.<field>
 *       → env override (WATCHDOG_*)
 *         → hardcoded legacy constant.
 *
 * Backward-compat invariant: an agents.json with NO watchdog blocks resolves to
 * the legacy constants byte-identically (15000 / 600 / 1500 / true).
 *
 * `enabled: false` disables ACTIVE enforcement (the deadline kill) — it must
 * NEVER disable heartbeat EMISSION, because invocation leases (R3) presume an
 * agent alive from its agent.streaming/agent.started events.
 */

import agentsConfig from "../../config/agents.json";

export interface WatchdogConfig {
  enabled: boolean;
  heartbeatIntervalMs: number;
  toolDeadlineSecs: number;
  turnTimeoutSecs: number;
}

export type PartialWatchdog = Partial<WatchdogConfig>;

// Legacy hardcoded constants — the byte-identical fallback when neither
// agents.json nor an env override configures a field.
export const LEGACY_WATCHDOG: WatchdogConfig = {
  enabled: true,
  heartbeatIntervalMs: 15_000,
  toolDeadlineSecs: 600,
  turnTimeoutSecs: 1500,
};

interface AgentEntry {
  agentId?: string;
  watchdog?: PartialWatchdog;
}

function agentWatchdog(agentId?: string): PartialWatchdog {
  if (!agentId) return {};
  const agent = (agentsConfig.agents as AgentEntry[]).find((a) => a.agentId === agentId);
  return agent?.watchdog ?? {};
}

function defaultsWatchdog(): PartialWatchdog {
  return (agentsConfig as { defaults?: { watchdog?: PartialWatchdog } }).defaults?.watchdog ?? {};
}

/** First finite, positive candidate wins; a zero/negative/NaN value is skipped. */
function firstNum(candidates: Array<unknown>): number | undefined {
  for (const c of candidates) {
    if (c === undefined || c === null || c === "") continue;
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/** Parse an env flag; "false"/"0" (any case) → false, anything else present → true. */
function parseEnvBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (s === "") return undefined;
  return !(s === "false" || s === "0" || s === "no" || s === "off");
}

function resolveEnabled(per: PartialWatchdog, def: PartialWatchdog): boolean {
  if (typeof per.enabled === "boolean") return per.enabled;
  if (typeof def.enabled === "boolean") return def.enabled;
  const env = parseEnvBool(process.env.WATCHDOG_ENABLED);
  if (env !== undefined) return env;
  return LEGACY_WATCHDOG.enabled;
}

/**
 * Pure resolution core — given the per-agent and defaults watchdog blocks,
 * apply the env → legacy fallback tail. Exposed so both consumers and tests can
 * exercise the full resolution matrix without a specific agents.json on disk.
 */
export function resolveWatchdogFrom(per: PartialWatchdog, def: PartialWatchdog): WatchdogConfig {
  return {
    enabled: resolveEnabled(per, def),
    heartbeatIntervalMs:
      firstNum([per.heartbeatIntervalMs, def.heartbeatIntervalMs, process.env.WATCHDOG_HEARTBEAT_INTERVAL_MS]) ??
      LEGACY_WATCHDOG.heartbeatIntervalMs,
    toolDeadlineSecs:
      firstNum([per.toolDeadlineSecs, def.toolDeadlineSecs, process.env.WATCHDOG_TOOL_DEADLINE_SECS]) ??
      LEGACY_WATCHDOG.toolDeadlineSecs,
    turnTimeoutSecs:
      firstNum([per.turnTimeoutSecs, def.turnTimeoutSecs, process.env.WATCHDOG_TURN_TIMEOUT_SECS]) ??
      LEGACY_WATCHDOG.turnTimeoutSecs,
  };
}

/**
 * Resolve the effective watchdog config for an agent (or the fleet default when
 * `agentId` is omitted), reading the per-agent + defaults blocks from
 * src/config/agents.json.
 */
export function resolveWatchdog(agentId?: string): WatchdogConfig {
  return resolveWatchdogFrom(agentWatchdog(agentId), defaultsWatchdog());
}
