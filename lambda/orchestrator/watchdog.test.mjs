import { describe, it, expect, afterEach } from "vitest";
import { resolveWatchdog, setWatchdogSource, resolveStallSoftTimeoutMs, LEGACY_WATCHDOG } from "./watchdog.mjs";
import { STALL_SOFT_TIMEOUT_MS } from "./lease.mjs";

/**
 * D1.1 (TEAM-3618): the orchestrator mirror of the watchdog resolver. Same
 * contract as src/lib/workflow/watchdog.test.ts — per-agent → defaults → env →
 * legacy, backward-compat fallback, and enabled:false semantics. The source is
 * injected via setWatchdogSource() (the S3 agents.json in production).
 */

const WD_ENVS = [
  "WATCHDOG_ENABLED",
  "WATCHDOG_HEARTBEAT_INTERVAL_MS",
  "WATCHDOG_TOOL_DEADLINE_SECS",
  "WATCHDOG_TURN_TIMEOUT_SECS",
];

afterEach(() => {
  for (const k of WD_ENVS) delete process.env[k];
  setWatchdogSource(null); // reset to empty source
});

describe("resolveWatchdog (mjs)", () => {
  it("empty source, no env → legacy constants (backward-compat / roster fallback)", () => {
    setWatchdogSource(null);
    expect(resolveWatchdog("any")).toEqual(LEGACY_WATCHDOG);
    expect(resolveWatchdog()).toEqual({
      enabled: true,
      heartbeatIntervalMs: 15000,
      toolDeadlineSecs: 600,
      turnTimeoutSecs: 1500,
    });
  });

  it("defaults.watchdog fills every field for the fleet", () => {
    setWatchdogSource({
      agents: [{ agentId: "a1" }],
      defaults: { watchdog: { enabled: true, heartbeatIntervalMs: 9000, toolDeadlineSecs: 300, turnTimeoutSecs: 1200 } },
    });
    expect(resolveWatchdog("a1")).toEqual({
      enabled: true,
      heartbeatIntervalMs: 9000,
      toolDeadlineSecs: 300,
      turnTimeoutSecs: 1200,
    });
  });

  it("per-agent override beats defaults per-field", () => {
    setWatchdogSource({
      agents: [{ agentId: "a1", watchdog: { heartbeatIntervalMs: 5000 } }],
      defaults: { watchdog: { heartbeatIntervalMs: 9000, toolDeadlineSecs: 300 } },
    });
    const r = resolveWatchdog("a1");
    expect(r.heartbeatIntervalMs).toBe(5000);
    expect(r.toolDeadlineSecs).toBe(300); // from defaults
    expect(r.turnTimeoutSecs).toBe(1500); // legacy
  });

  it("env override applies only when neither per-agent nor defaults set the field", () => {
    process.env.WATCHDOG_HEARTBEAT_INTERVAL_MS = "7777";
    process.env.WATCHDOG_TOOL_DEADLINE_SECS = "222";
    setWatchdogSource({ agents: [{ agentId: "a1" }], defaults: { watchdog: { toolDeadlineSecs: 300 } } });
    const r = resolveWatchdog("a1");
    expect(r.heartbeatIntervalMs).toBe(7777); // env (unset in config)
    expect(r.toolDeadlineSecs).toBe(300); // defaults beat env
  });

  it("invalid numeric values fall through to the next tier", () => {
    process.env.WATCHDOG_HEARTBEAT_INTERVAL_MS = "nope";
    setWatchdogSource({ agents: [{ agentId: "a1", watchdog: { toolDeadlineSecs: -5 } }], defaults: { watchdog: { toolDeadlineSecs: 0 } } });
    const r = resolveWatchdog("a1");
    expect(r.heartbeatIntervalMs).toBe(15000);
    expect(r.toolDeadlineSecs).toBe(600);
  });

  it("enabled:false per-agent disables enforcement", () => {
    setWatchdogSource({ agents: [{ agentId: "a1", watchdog: { enabled: false } }], defaults: { watchdog: { enabled: true } } });
    expect(resolveWatchdog("a1").enabled).toBe(false);
  });

  it("enabled resolves per-agent → defaults → env → legacy true", () => {
    setWatchdogSource({ agents: [], defaults: { watchdog: { enabled: false } } });
    expect(resolveWatchdog("x").enabled).toBe(false); // defaults
    setWatchdogSource(null);
    process.env.WATCHDOG_ENABLED = "0";
    expect(resolveWatchdog("x").enabled).toBe(false); // env
    delete process.env.WATCHDOG_ENABLED;
    expect(resolveWatchdog("x").enabled).toBe(true); // legacy
  });

  it("unknown agentId falls back to the fleet default", () => {
    setWatchdogSource({ agents: [{ agentId: "a1", watchdog: { heartbeatIntervalMs: 5000 } }], defaults: { watchdog: { heartbeatIntervalMs: 9000 } } });
    expect(resolveWatchdog("nope").heartbeatIntervalMs).toBe(9000);
  });
});

/**
 * TEAM-3992 D4.3 — the stall soft-timeout resolver. A workflow def may raise the
 * shared STALL_SOFT_TIMEOUT_MS default via `stallSoftTimeoutMs`, but the result is
 * ALWAYS floored at 2× the resolved heartbeat interval so the soft-timeout can
 * never fire between two expected heartbeats (a healthy agent that missed one beat
 * is not stalled). Reads the default from lease.mjs (the single source shared with
 * the TS twin), so there is no forked constant here.
 */
describe("resolveStallSoftTimeoutMs (mjs)", () => {
  it("honors a per-def stallSoftTimeoutMs override that clears the floor", () => {
    setWatchdogSource(null); // legacy heartbeat 15000 → floor = 2×15000 = 30000
    expect(resolveStallSoftTimeoutMs({ stallSoftTimeoutMs: 300_000 }, "dev")).toBe(300_000);
  });

  it("floors a too-small override at 2× the resolved heartbeat interval", () => {
    setWatchdogSource(null);
    expect(resolveStallSoftTimeoutMs({ stallSoftTimeoutMs: 1000 }, "dev")).toBe(30_000);
  });

  it("uses the shared lease-constants default when the def sets no override", () => {
    setWatchdogSource(null);
    // Whatever the shared default is, it is still floored at 2× the heartbeat.
    expect(resolveStallSoftTimeoutMs({}, "dev")).toBe(Math.max(STALL_SOFT_TIMEOUT_MS, 30_000));
    expect(resolveStallSoftTimeoutMs(undefined, "dev")).toBe(Math.max(STALL_SOFT_TIMEOUT_MS, 30_000));
  });

  it("floors against a per-agent heartbeat override, not just the legacy 15s", () => {
    setWatchdogSource({ agents: [{ agentId: "slow", watchdog: { heartbeatIntervalMs: 200_000 } }], defaults: {} });
    // 2×200000 = 400000 floor beats the tiny configured value.
    expect(resolveStallSoftTimeoutMs({ stallSoftTimeoutMs: 1000 }, "slow")).toBe(400_000);
  });
});
