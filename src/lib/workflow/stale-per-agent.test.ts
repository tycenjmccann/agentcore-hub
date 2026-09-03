import { describe, it, expect } from "vitest";
import {
  computeStaleAgentIds,
  isStaleEligibleStatus,
  seedLastActivityByAgent,
  seedLastToolByAgent,
  STALE_THRESHOLD_DEFAULT_MS,
  STALE_THRESHOLD_CLAUDE_CODE_MS,
} from "@/lib/workflow/stale";

// TEAM-3881: per-agent staleness. The TEAM-3862 fix tracked one board-global
// activity clock, so one busy agent's liveness suppressed STUCK for every
// sibling; the seeding path also classified liveness differently from the
// live path. These tests exercise the extracted derivation with a fake clock.
describe("per-agent stuck detection (TEAM-3881)", () => {
  const T0 = 1_000_000;

  it("F1: busy agent A does not keep silent agent B alive — only B trips STUCK", () => {
    const lastActivityByAgent: Record<string, number> = {
      // A emitted tool_use just now; B has been silent since T0.
      agentA: T0 + STALE_THRESHOLD_DEFAULT_MS + 30_000,
      agentB: T0,
    };
    const stale = computeStaleAgentIds({
      now: T0 + STALE_THRESHOLD_DEFAULT_MS + 60_000,
      tasks: { agentA: { status: "running" }, agentB: { status: "running" } },
      lastActivityByAgent,
      lastToolByAgent: {},
    });
    expect(stale).toEqual(["agentB"]);
  });

  it("F1: a first-observed agent anchors at now and still trips after a full threshold", () => {
    const lastActivityByAgent: Record<string, number> = {};
    // First tick: agent never seen before — anchored, not instantly stale.
    expect(
      computeStaleAgentIds({
        now: T0,
        tasks: { agentB: { status: "running" } },
        lastActivityByAgent,
        lastToolByAgent: {},
      })
    ).toEqual([]);
    expect(lastActivityByAgent.agentB).toBe(T0);
    // A full threshold of silence later it trips — no over-suppression.
    expect(
      computeStaleAgentIds({
        now: T0 + STALE_THRESHOLD_DEFAULT_MS + 1,
        tasks: { agentB: { status: "running" } },
        lastActivityByAgent,
        lastToolByAgent: {},
      })
    ).toEqual(["agentB"]);
  });

  it("F1/F2: thresholds are per agent — a claude_code sibling does not lend its long window", () => {
    const lastActivityByAgent: Record<string, number> = { agentA: T0, agentB: T0 };
    const stale = computeStaleAgentIds({
      now: T0 + 600_000, // 10 min of silence for both
      tasks: { agentA: { status: "running" }, agentB: { status: "running" } },
      lastActivityByAgent,
      lastToolByAgent: { agentA: "claude_code" }, // A is dark in claude_code (17 min window)
    });
    // B gets the 3-min window regardless of A's tool; A is still healthy.
    expect(stale).toEqual(["agentB"]);
  });

  it("F2: the verdict follows the CURRENT task set after a mid-phase change", () => {
    const lastActivityByAgent: Record<string, number> = { agentA: T0, agentB: T0 };
    const lastToolByAgent = { agentB: "claude_code" };
    const now = T0 + 600_000; // 10 min silence
    // Old task set: A running (normal tools) → stale.
    expect(
      computeStaleAgentIds({
        now,
        tasks: { agentA: { status: "running" }, agentB: { status: "complete" } },
        lastActivityByAgent,
        lastToolByAgent,
      })
    ).toEqual(["agentA"]);
    // Mid-phase change: A completed, B started in claude_code. The same
    // derivation over the NEW task set must apply B's 17-min window — the
    // pre-fix interval kept judging the task set captured at effect setup.
    expect(
      computeStaleAgentIds({
        now,
        tasks: { agentA: { status: "complete" }, agentB: { status: "running" } },
        lastActivityByAgent,
        lastToolByAgent,
      })
    ).toEqual([]);
    expect(
      computeStaleAgentIds({
        now: T0 + STALE_THRESHOLD_CLAUDE_CODE_MS + 1,
        tasks: { agentA: { status: "complete" }, agentB: { status: "running" } },
        lastActivityByAgent,
        lastToolByAgent,
      })
    ).toEqual(["agentB"]);
  });

  it("F3: waiting_response is stale-eligible under the same predicate as running", () => {
    expect(isStaleEligibleStatus("running")).toBe(true);
    expect(isStaleEligibleStatus("waiting_response")).toBe(true);
    expect(isStaleEligibleStatus("complete")).toBe(false);
    expect(isStaleEligibleStatus("pending")).toBe(false);
    expect(isStaleEligibleStatus(undefined)).toBe(false);
    const stale = computeStaleAgentIds({
      now: T0 + STALE_THRESHOLD_DEFAULT_MS + 1,
      tasks: { agentA: { status: "waiting_response" } },
      lastActivityByAgent: { agentA: T0 },
      lastToolByAgent: {},
    });
    expect(stale).toEqual(["agentA"]);
  });

  it("F4: seeding counts tool_end via the shared liveness source", () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    const seeded = seedLastActivityByAgent([
      { type: "tool_use", agentId: "agentA", timestamp: iso(T0) },
      { type: "tool_end", agentId: "agentA", timestamp: iso(T0 + 120_000) },
    ]);
    // Pre-fix seeding ignored tool_end → seeded T0 → STUCK at T0+3min even
    // though live-path liveness ran until T0+2min (trip at T0+5min).
    expect(seeded.agentA).toBe(T0 + 120_000);
  });

  it("TEAM-3888: a re-dispatch AFTER the last liveness event advances the seeded clock", () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    const T1 = T0; // run 1's last tool event
    const T2 = T1 + STALE_THRESHOLD_DEFAULT_MS + 60_000; // run 2 dispatched later
    const history = [
      { type: "tool_use", agentId: "agentX", timestamp: iso(T1) },
      { type: "agent_status", agentId: "agentX", status: "running", timestamp: iso(T2) },
    ];
    const seeded = seedLastActivityByAgent(history);
    // Pre-fix: run-1 liveness (T1) shadowed the newer run-2 dispatch, so a
    // page reload right after re-dispatch tripped a false STUCK on the first
    // interval tick before run 2 emitted anything.
    expect(seeded.agentX).toBe(T2);
    expect(
      computeStaleAgentIds({
        now: T2 + 60_000,
        tasks: { agentX: { status: "running" } },
        lastActivityByAgent: { ...seeded },
        lastToolByAgent: {},
      })
    ).toEqual([]);
    // Control: the same history WITHOUT the post-T1 dispatch IS stale — the
    // dispatch anchor must not weaken genuine dead-agent detection.
    const control = seedLastActivityByAgent([history[0]]);
    expect(control.agentX).toBe(T1);
    expect(
      computeStaleAgentIds({
        now: T2 + 60_000,
        tasks: { agentX: { status: "running" } },
        lastActivityByAgent: { ...control },
        lastToolByAgent: {},
      })
    ).toEqual(["agentX"]);
  });

  it("TEAM-3888: a dispatch OLDER than the last liveness event does not rewind the clock", () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    const seeded = seedLastActivityByAgent([
      { type: "agent_status", agentId: "agentX", status: "running", timestamp: iso(T0) },
      { type: "tool_use", agentId: "agentX", timestamp: iso(T0 + 60_000) },
    ]);
    expect(seeded.agentX).toBe(T0 + 60_000);
  });

  it("TEAM-3890: a re-dispatch drops the previous run's claude_code tier", () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    const T1 = T0; // run 1's last tool call was claude_code
    const T2 = T1 + 300_000; // run 2 dispatched
    const history = [
      { type: "tool_use", agentId: "agentX", toolName: "claude_code", timestamp: iso(T1) },
      { type: "agent_status", agentId: "agentX", status: "running", timestamp: iso(T2) },
    ];
    const lastToolByAgent = seedLastToolByAgent(history);
    // Pre-fix: run 1's claude_code survived the dispatch, so a run 2 that
    // died before its first tool call inherited the 17-min window instead of
    // the default 3-min tier.
    expect(lastToolByAgent.agentX).toBeUndefined();
    const lastActivityByAgent = { ...seedLastActivityByAgent(history) }; // clock = T2 (TEAM-3888)
    expect(lastActivityByAgent.agentX).toBe(T2);
    // Dead run 2 (no events after dispatch) trips STUCK at T2 + 4min…
    expect(
      computeStaleAgentIds({
        now: T2 + 240_000,
        tasks: { agentX: { status: "running" } },
        lastActivityByAgent,
        lastToolByAgent,
      })
    ).toEqual(["agentX"]);
    // …control 1: but not at T2 + 1min (dispatch anchor intact).
    expect(
      computeStaleAgentIds({
        now: T2 + 60_000,
        tasks: { agentX: { status: "running" } },
        lastActivityByAgent,
        lastToolByAgent,
      })
    ).toEqual([]);
  });

  it("TEAM-3890: a tool_use AFTER the dispatch restores that run's own tier", () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    const T2 = T0 + 300_000;
    const T3 = T2 + 30_000; // run 2 goes dark inside its own claude_code call
    const history = [
      { type: "tool_use", agentId: "agentX", toolName: "claude_code", timestamp: iso(T0) },
      { type: "agent_status", agentId: "agentX", status: "running", timestamp: iso(T2) },
      { type: "tool_use", agentId: "agentX", toolName: "claude_code", timestamp: iso(T3) },
    ];
    const lastToolByAgent = seedLastToolByAgent(history);
    expect(lastToolByAgent.agentX).toBe("claude_code");
    // Run 2 earned the 17-min window itself: not stale 4min into its call…
    expect(
      computeStaleAgentIds({
        now: T3 + 240_000,
        tasks: { agentX: { status: "running" } },
        lastActivityByAgent: { ...seedLastActivityByAgent(history) },
        lastToolByAgent,
      })
    ).toEqual([]);
    // …and still trips past the long window.
    expect(
      computeStaleAgentIds({
        now: T3 + STALE_THRESHOLD_CLAUDE_CODE_MS + 1,
        tasks: { agentX: { status: "running" } },
        lastActivityByAgent: { ...seedLastActivityByAgent(history) },
        lastToolByAgent,
      })
    ).toEqual(["agentX"]);
  });

  it("F4: agent_status/agent_complete are not liveness for seeding, but anchor a never-emitting agent", () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    const seeded = seedLastActivityByAgent([
      { type: "tool_use", agentId: "agentA", timestamp: iso(T0) },
      { type: "agent_status", agentId: "agentA", timestamp: iso(T0 + 300_000) },
      // agentB was dispatched and never emitted anything — its dispatch time
      // anchors the clock so it still trips immediately on page load.
      { type: "agent_status", agentId: "agentB", timestamp: iso(T0) },
    ]);
    expect(seeded.agentA).toBe(T0); // status did not extend A's liveness
    expect(seeded.agentB).toBe(T0); // anchor fallback for a liveness-less agent
  });
});
