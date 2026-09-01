/**
 * Fleet-wide watchdog / heartbeat configuration — orchestrator (Lambda) mirror
 * of src/lib/workflow/watchdog.ts (D1.1 of TEAM-3618).
 *
 * The orchestrator already loads agents.json from S3 on cold start
 * (index.mjs loadAgentRoster). It calls setWatchdogSource() with that config so
 * this resolver has the per-agent + defaults watchdog blocks WITHOUT a second
 * fetch. When the roster load falls back (no ARTIFACT_BUCKET / S3 error), the
 * source stays empty and resolution drops straight to env → legacy constants.
 *
 * Resolution order per field (IDENTICAL to the app-side helper):
 *   per-agent agents.json watchdog.<field>
 *     → defaults.watchdog.<field>
 *       → env override (WATCHDOG_*)
 *         → hardcoded legacy constant (15000 / 600 / 1500 / true).
 *
 * `enabled: false` disables ACTIVE enforcement only — never heartbeat emission.
 */

// Legacy hardcoded constants — the byte-identical fallback when neither
// agents.json nor an env override configures a field.
export const LEGACY_WATCHDOG = {
  enabled: true,
  heartbeatIntervalMs: 15_000,
  toolDeadlineSecs: 600,
  turnTimeoutSecs: 1500,
};

let _source = { perAgent: {}, defaults: {} };

/**
 * Populate the resolver from a parsed agents.json (as loaded from S3). Safe to
 * call repeatedly; the last config wins. A null/garbage config resets to empty
 * (env → legacy).
 */
export function setWatchdogSource(config) {
  const perAgent = {};
  for (const a of config?.agents || []) {
    if (a?.agentId) perAgent[a.agentId] = a.watchdog || {};
  }
  _source = { perAgent, defaults: config?.defaults?.watchdog || {} };
}

/** Exposed for tests — the current resolution source. */
export function _getWatchdogSource() {
  return _source;
}

/** First finite, positive candidate wins; a zero/negative/NaN value is skipped. */
function firstNum(candidates) {
  for (const c of candidates) {
    if (c === undefined || c === null || c === "") continue;
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/** Parse an env flag; "false"/"0" (any case) → false, anything else present → true. */
function parseEnvBool(v) {
  if (v === undefined) return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === "") return undefined;
  return !(s === "false" || s === "0" || s === "no" || s === "off");
}

function resolveEnabled(per, def) {
  if (typeof per.enabled === "boolean") return per.enabled;
  if (typeof def.enabled === "boolean") return def.enabled;
  const env = parseEnvBool(process.env.WATCHDOG_ENABLED);
  if (env !== undefined) return env;
  return LEGACY_WATCHDOG.enabled;
}

/**
 * Resolve the effective watchdog config for an agent (or the fleet default when
 * `agentId` is omitted/unknown).
 */
export function resolveWatchdog(agentId) {
  const per = (agentId && _source.perAgent[agentId]) || {};
  const def = _source.defaults || {};
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
