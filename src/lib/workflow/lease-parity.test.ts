import { describe, it, expect } from "vitest";
import { isLeaseLive as isLeaseLiveTs } from "./lease";
// The orchestrator (Lambda) port. Both copies MUST agree bit-for-bit — a drift
// means retry/dispatch and the board's re-Ready path disagree on whether an
// agent is alive, which is exactly the duplicate-agent bug R3 closes.
import { isLeaseLive as isLeaseLiveMjs } from "../../../lambda/orchestrator/lease.mjs";

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
