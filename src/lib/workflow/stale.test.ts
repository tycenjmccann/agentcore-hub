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
    // TEAM-3989 D4.3 tied the claude_code window to the orchestrator's stall
    // soft-timeout; TEAM-4100 F6 set it to soft-timeout + one heartbeat interval
    // (660_000, 11 min) so the board trails the backend. A run dark for 9 min is
    // still healthy under that window…
    expect(
      computeIsStale({
        now: T0 + 540_000,
        lastActivityAt: T0,
        hasRunningAgent: true,
        thresholdMs: staleThresholdFor(true),
      })
    ).toBe(false);
    // …but past its ceiling it is stuck.
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

describe("coding-runtime heartbeat liveness (TEAM-4100 F6)", () => {
  const T0 = 1_000_000; // last streamed text

  it("agent_heartbeat is a liveness event", () => {
    expect(isLivenessEvent("agent_heartbeat")).toBe(true);
  });

  it("a heartbeat within the window keeps a silent claude_code agent NOT stuck", () => {
    // Bug: a long claude_code turn streams no text/tools, only heartbeats every
    // ~60s. The backend lease stays alive on those heartbeats; the UI must too.
    const lastActivityAt = lastActivityFrom(
      [{ type: "agent_heartbeat", at: T0 + 900_000 }], // heartbeat 15 min after last text
      T0
    );
    const now = T0 + 900_000 + 120_000; // 2 min after the last heartbeat
    expect(
      computeIsStale({
        now,
        lastActivityAt,
        hasRunningAgent: true,
        thresholdMs: STALE_THRESHOLD_CLAUDE_CODE_MS,
      })
    ).toBe(false);
    // Contrast: without heartbeats counting (pre-F6), the clock would still sit at
    // T0 — 17 min of "silence" — and the board would falsely paint STUCK.
    expect(
      computeIsStale({
        now,
        lastActivityAt: T0,
        hasRunningAgent: true,
        thresholdMs: STALE_THRESHOLD_CLAUDE_CODE_MS,
      })
    ).toBe(true);
  });

  it("a heartbeat older than the window with no other activity is stuck (heartbeats stopped)", () => {
    const lastActivityAt = lastActivityFrom([{ type: "agent_heartbeat", at: T0 }], T0);
    expect(
      computeIsStale({
        now: T0 + STALE_THRESHOLD_CLAUDE_CODE_MS + 1,
        lastActivityAt,
        hasRunningAgent: true,
        thresholdMs: STALE_THRESHOLD_CLAUDE_CODE_MS,
      })
    ).toBe(true);
  });
});
