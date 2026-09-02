import { describe, it, expect, afterEach } from "vitest";
import { resolveWatchdog, resolveWatchdogFrom, LEGACY_WATCHDOG } from "./watchdog";

/**
 * D1.1 (TEAM-3618): fleet-wide watchdog resolution. Pins the per-field order
 * per-agent → defaults → env → legacy, the byte-identical backward-compat
 * fallback, and the enabled:false semantics (enforcement off, emission on).
 */

const WD_ENVS = [
  "WATCHDOG_ENABLED",
  "WATCHDOG_HEARTBEAT_INTERVAL_MS",
  "WATCHDOG_TOOL_DEADLINE_SECS",
  "WATCHDOG_TURN_TIMEOUT_SECS",
];

afterEach(() => {
  for (const k of WD_ENVS) delete process.env[k];
});

describe("resolveWatchdogFrom", () => {
  it("absent config, no env → legacy constants (backward-compat invariant)", () => {
    expect(resolveWatchdogFrom({}, {})).toEqual({
      enabled: true,
      heartbeatIntervalMs: 15000,
      toolDeadlineSecs: 600,
      turnTimeoutSecs: 1500,
    });
    expect(resolveWatchdogFrom({}, {})).toEqual(LEGACY_WATCHDOG);
  });

  it("defaults-only fills every field", () => {
    const def = { enabled: true, heartbeatIntervalMs: 9000, toolDeadlineSecs: 300, turnTimeoutSecs: 1200 };
    expect(resolveWatchdogFrom({}, def)).toEqual(def);
  });

  it("per-agent override beats defaults per-field", () => {
    const def = { heartbeatIntervalMs: 9000, toolDeadlineSecs: 300, turnTimeoutSecs: 1200 };
    const per = { heartbeatIntervalMs: 5000 };
    const r = resolveWatchdogFrom(per, def);
    expect(r.heartbeatIntervalMs).toBe(5000); // per-agent wins
    expect(r.toolDeadlineSecs).toBe(300); // falls through to defaults
    expect(r.turnTimeoutSecs).toBe(1200);
  });

  it("env override applies only when neither per-agent nor defaults set the field", () => {
    process.env.WATCHDOG_HEARTBEAT_INTERVAL_MS = "7777";
    process.env.WATCHDOG_TOOL_DEADLINE_SECS = "222";
    // defaults set toolDeadlineSecs, so env is masked there but used for heartbeat.
    const r = resolveWatchdogFrom({}, { toolDeadlineSecs: 300 });
    expect(r.heartbeatIntervalMs).toBe(7777); // env used (unset in config)
    expect(r.toolDeadlineSecs).toBe(300); // defaults beat env (order)
    expect(r.turnTimeoutSecs).toBe(1500); // legacy
  });

  it("invalid numeric values (0 / negative / NaN) fall through to the next tier", () => {
    process.env.WATCHDOG_HEARTBEAT_INTERVAL_MS = "not-a-number";
    const r = resolveWatchdogFrom({ toolDeadlineSecs: -5 }, { toolDeadlineSecs: 0 });
    expect(r.heartbeatIntervalMs).toBe(15000); // bad env → legacy
    expect(r.toolDeadlineSecs).toBe(600); // per-agent -5 & default 0 skipped → legacy
  });

  it("enabled:false per-agent disables enforcement (never disables emission wiring)", () => {
    expect(resolveWatchdogFrom({ enabled: false }, { enabled: true }).enabled).toBe(false);
  });

  it("enabled resolves per-agent → defaults → env → legacy true", () => {
    expect(resolveWatchdogFrom({}, { enabled: false }).enabled).toBe(false); // defaults
    process.env.WATCHDOG_ENABLED = "false";
    expect(resolveWatchdogFrom({}, {}).enabled).toBe(false); // env
    delete process.env.WATCHDOG_ENABLED;
    expect(resolveWatchdogFrom({}, {}).enabled).toBe(true); // legacy
  });
});

describe("resolveWatchdog (agents.json-backed)", () => {
  it("fleet default matches the committed defaults.watchdog block (== legacy today)", () => {
    // The committed agents.json defaults.watchdog mirrors the legacy constants,
    // so the fleet default with no per-agent override must equal them.
    expect(resolveWatchdog()).toEqual(LEGACY_WATCHDOG);
  });

  it("unknown agentId falls back to the fleet default", () => {
    expect(resolveWatchdog("does_not_exist")).toEqual(resolveWatchdog());
  });
});
