import { describe, it, expect } from "vitest";
import { isLeaseLive as isLeaseLiveTs, leaseVerdict as leaseVerdictTs, STALL_SOFT_TIMEOUT_MS as SOFT_TS } from "./lease";
// The orchestrator (Lambda) port. Both copies MUST agree bit-for-bit — a drift
// means retry/dispatch and the board's re-Ready path disagree on whether an
// agent is alive, which is exactly the duplicate-agent bug R3 closes.
import {
  isLeaseLive as isLeaseLiveMjs,
  leaseVerdict as leaseVerdictMjs,
  STALL_SOFT_TIMEOUT_MS as SOFT_MJS,
} from "../../../lambda/orchestrator/lease.mjs";

/**
 * TEAM-3618 parity contract: feed the SAME (claim entry × activity timestamp ×
 * now) matrix through both isLeaseLive implementations and assert identical
 * booleans. This is the guard that keeps the hand-port honest.
 */

const TTL = 30 * 60_000;
const NOW = Date.parse("2026-08-30T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

// Corner cases spanning every branch: status gate, missing timestamps, the
// exact TTL boundary, activity-renews-old-claim, and both-stale.
const STATUSES = ["running", "in_progress", "error", "complete", "ready", undefined];
const OFFSETS: Array<number | null> = [
  null, // absent
  0, // exactly now
  5 * 60_000, // fresh
  TTL - 1, // just inside the window
  TTL, // exactly the boundary (nowMs - freshest < ttl → false)
  TTL + 1, // just outside
  45 * 60_000, // well beyond
  3 * 60 * 60_000, // hours old
];

describe("isLeaseLive parity: lease.ts ≡ lease.mjs", () => {
  it("agrees on every claim-status × startedAt × lastActivity combination", () => {
    let compared = 0;
    for (const status of STATUSES) {
      for (const startOff of OFFSETS) {
        for (const actOff of OFFSETS) {
          const task =
            status === undefined && startOff === null
              ? undefined
              : {
                  status,
                  ...(startOff === null ? {} : { startedAt: iso(startOff) }),
                };
          const lastActivity = actOff === null ? null : iso(actOff);
          const ts = isLeaseLiveTs(task, lastActivity, NOW, TTL);
          const mjs = isLeaseLiveMjs(task, lastActivity, NOW, TTL);
          expect(
            mjs,
            `mismatch for status=${String(status)} startOff=${String(startOff)} actOff=${String(actOff)}`
          ).toBe(ts);
          compared++;
        }
      }
    }
    // Guard against the loop silently short-circuiting to zero comparisons.
    expect(compared).toBe(STATUSES.length * OFFSETS.length * OFFSETS.length);
  });

  it("agrees with the default (env-derived) TTL argument omitted", () => {
    const task = { status: "running", startedAt: iso(5 * 60_000) };
    expect(isLeaseLiveMjs(task, null, NOW)).toBe(isLeaseLiveTs(task, null, NOW));
  });
});

/**
 * TEAM-3992 D4.3 parity: leaseVerdict (the soft-timeout refinement) must also
 * agree bit-for-bit across the twins — the detector reads the .mjs verdict, the
 * board/UI shares the same soft-timeout constant, and any drift re-opens the
 * duplicate-agent window on the softer threshold. The matrix crosses claim
 * status × start × stream activity × OTEL signal (the undefined/null/string
 * sentinel) × soft/hard option overrides.
 */
const SOFT = 10 * 60_000;
const HARD = 2 * SOFT;
// The OTEL sentinel is the crux: undefined = unknown/not queried, null =
// confirmed no span, a string = newest span timestamp.
const OTEL: Array<string | null | undefined> = [undefined, null, iso(0), iso(SOFT - 1), iso(SOFT), iso(TTL + 1)];

describe("leaseVerdict parity: lease.ts ≡ lease.mjs", () => {
  it("exposes the SAME STALL_SOFT_TIMEOUT_MS constant from the shared file", () => {
    expect(SOFT_MJS).toBe(SOFT_TS);
    expect(SOFT_TS).toBe(600_000);
  });

  it("agrees on every status × start × activity × otel × options combination", () => {
    let compared = 0;
    for (const status of STATUSES) {
      for (const startOff of OFFSETS) {
        for (const actOff of OFFSETS) {
          for (const otel of OTEL) {
            const task =
              status === undefined && startOff === null
                ? undefined
                : { status, ...(startOff === null ? {} : { startedAt: iso(startOff) }) };
            const lastActivity = actOff === null ? null : iso(actOff);
            const opts = { ttlMs: TTL, softTimeoutMs: SOFT, hardTimeoutMs: HARD };
            const ts = leaseVerdictTs(task, lastActivity, otel, NOW, opts);
            const mjs = leaseVerdictMjs(task, lastActivity, otel, NOW, opts);
            expect(
              mjs,
              `mismatch status=${String(status)} start=${String(startOff)} act=${String(actOff)} otel=${String(otel)}`
            ).toBe(ts);
            compared++;
          }
        }
      }
    }
    expect(compared).toBe(STATUSES.length * OFFSETS.length * OFFSETS.length * OTEL.length);
  });

  it("agrees with the default soft/hard/ttl options omitted", () => {
    const task = { status: "running", startedAt: iso(SOFT + 1) };
    expect(leaseVerdictMjs(task, null, undefined, NOW)).toBe(leaseVerdictTs(task, null, undefined, NOW));
  });

  // The named verdict transitions the detector depends on (documents intent
  // beyond the exhaustive-but-opaque parity sweep).
  it("classifies the canonical cases", () => {
    const running = (startOff: number) => ({ status: "running", startedAt: iso(startOff) });
    const opts = { ttlMs: TTL, softTimeoutMs: SOFT, hardTimeoutMs: HARD };
    // Fresh heartbeat → live.
    expect(leaseVerdictTs(running(SOFT - 1), null, undefined, NOW, opts)).toBe("live");
    // Silent past soft, OTEL unknown, below hard → soft-stale (needs confirm).
    expect(leaseVerdictTs(running(SOFT + 1), null, undefined, NOW, opts)).toBe("soft-stale");
    // Silent past soft, OTEL confirmed no span → stale.
    expect(leaseVerdictTs(running(SOFT + 1), null, null, NOW, opts)).toBe("stale");
    // Silent past soft, OTEL span recent → live again.
    expect(leaseVerdictTs(running(SOFT + 1), null, iso(1_000), NOW, opts)).toBe("live");
    // Past the hard ceiling with OTEL still unknown → stale (4v1ykk).
    expect(leaseVerdictTs(running(HARD + 1), null, undefined, NOW, opts)).toBe("stale");
    // Lease dead per TTL → stale outright, soft-timeout irrelevant.
    expect(leaseVerdictTs(running(TTL + 1), null, iso(0), NOW, opts)).toBe("stale");
  });
});
