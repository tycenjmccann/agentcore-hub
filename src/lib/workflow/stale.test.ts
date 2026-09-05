import { describe, it, expect } from "vitest";
import {
  computeIsStale,
  isLivenessEvent,
  staleThresholdFor,
  STALE_THRESHOLD_DEFAULT_MS,
  STALE_THRESHOLD_CLAUDE_CODE_MS,
} from "@/lib/workflow/stale";

/** Fold an event stream to the last-activity timestamp the way the board does:
 *  only liveness events advance the idle clock. */
function lastActivityFrom(
  events: { type: string; at: number }[],
  seed: number
): number {
  return events.reduce(
    (last, ev) => (isLivenessEvent(ev.type) && ev.at > last ? ev.at : last),
    seed
  );
}

describe("stuck detection vs in-flight tool calls (TEAM-3858 / TEAM-3862)", () => {
  const T0 = 1_000_000; // last streamed text

  it("a fresh tool_use keeps a running agent NOT stuck despite no recent text", () => {
    // Bug scenario: text went quiet at T0, but a tool call started 10 min
    // later and is still in flight — the footer shows "Tool: Tickets → …".
    const lastActivityAt = lastActivityFrom(
      [{ type: "tool_use", at: T0 + 600_000 }],
      T0
    );
    const now = T0 + 700_000; // 11:40 after last text, 1:40 after tool start
    expect(
      computeIsStale({
        now,
        lastActivityAt,
        hasRunningAgent: true,
        thresholdMs: STALE_THRESHOLD_DEFAULT_MS,
      })
    ).toBe(false);
    // Contrast: counting only text (pre-fix behavior) would have tripped STUCK.
    expect(
      computeIsStale({
        now,
        lastActivityAt: T0,
        hasRunningAgent: true,
        thresholdMs: STALE_THRESHOLD_DEFAULT_MS,
      })
    ).toBe(true);
  });

  it("tool_end also counts as liveness", () => {
    const lastActivityAt = lastActivityFrom(
      [{ type: "tool_end", at: T0 + 600_000 }],
      T0
    );
    expect(
      computeIsStale({
        now: T0 + 700_000,
        lastActivityAt,
        hasRunningAgent: true,
        thresholdMs: STALE_THRESHOLD_DEFAULT_MS,
      })
    ).toBe(false);
  });

  it("a genuinely dead agent (no text, no tool events) still trips STUCK", () => {
    const lastActivityAt = lastActivityFrom([], T0);
    expect(
      computeIsStale({
        now: T0 + STALE_THRESHOLD_DEFAULT_MS + 1,
        lastActivityAt,
        hasRunningAgent: true,
        thresholdMs: STALE_THRESHOLD_DEFAULT_MS,
      })
    ).toBe(true);
  });

  it("bookkeeping events (token_usage, agent_status) do not suppress STUCK", () => {
    const lastActivityAt = lastActivityFrom(
      [
        { type: "token_usage", at: T0 + 600_000 },
        { type: "agent_status", at: T0 + 600_000 },
      ],
      T0
    );
    expect(lastActivityAt).toBe(T0);
    expect(
      computeIsStale({
        now: T0 + 700_000,
        lastActivityAt,
        hasRunningAgent: true,
        thresholdMs: STALE_THRESHOLD_DEFAULT_MS,
      })
    ).toBe(true);
  });

  it("streamed text remains liveness", () => {
    expect(isLivenessEvent("agent_output")).toBe(true);
  });

  it("never stuck when no agent is running", () => {
    expect(
      computeIsStale({
        now: T0 + 10 * STALE_THRESHOLD_DEFAULT_MS,
        lastActivityAt: T0,
        hasRunningAgent: false,
        thresholdMs: STALE_THRESHOLD_DEFAULT_MS,
      })
    ).toBe(false);
  });

  it("tiered threshold: claude_code gets the long window", () => {
    expect(staleThresholdFor(true)).toBe(STALE_THRESHOLD_CLAUDE_CODE_MS);
    expect(staleThresholdFor(false)).toBe(STALE_THRESHOLD_DEFAULT_MS);
    // TEAM-3989 D4.3: the claude_code window is now capped at the orchestrator's
    // 10-min stall soft-timeout (was 17 min / 1_020_000). A run dark for 9 min is
    // still healthy under its (now 10-min) window…
    expect(
      computeIsStale({
        now: T0 + 540_000,
        lastActivityAt: T0,
        hasRunningAgent: true,
        thresholdMs: staleThresholdFor(true),
      })
    ).toBe(false);
    // …but past its 10-min ceiling (D4.3: the stall soft-timeout, previously
    // 17 min) it is stuck.
    expect(
      computeIsStale({
        now: T0 + STALE_THRESHOLD_CLAUDE_CODE_MS + 1,
        lastActivityAt: T0,
        hasRunningAgent: true,
        thresholdMs: staleThresholdFor(true),
      })
    ).toBe(true);
  });
});
