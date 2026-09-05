import { describe, it, expect } from "vitest";
import {
  computeStaleAgentIds,
  STALE_THRESHOLD_CLAUDE_CODE_MS,
  STALL_SOFT_TIMEOUT_MS,
} from "@/lib/workflow/stale";
import leaseConstants from "../../config/lease-constants.json";

/**
 * TEAM-3989 D4.3 item 5 — parity between the UI's claude_code stale threshold
 * and the orchestrator's absolute stall soft-timeout. The board (UI) and the
 * stall detector agent (backend) must agree on when a silent claude_code agent
 * is stuck; if the UI window were longer, the board would still paint an agent
 * "live" after the orchestrator had already reclaimed its lease.
 */
describe("stale UI ↔ orchestrator soft-timeout parity (TEAM-3989 D4.3)", () => {
  it("constant identity: UI claude_code ceiling === orchestrator soft-timeout === lease-constants value", () => {
    // One number, one source of truth (lease-constants.json). 600_000 = 10 min.
    expect(STALL_SOFT_TIMEOUT_MS).toBe(leaseConstants.stallSoftTimeoutMs);
    expect(STALL_SOFT_TIMEOUT_MS).toBe(600_000);
    expect(STALE_THRESHOLD_CLAUDE_CODE_MS).toBe(STALL_SOFT_TIMEOUT_MS);
    expect(STALE_THRESHOLD_CLAUDE_CODE_MS).toBe(600_000);
  });

  it('shared fixture "4v1ykk TEAM-2609": 1,439,754 ms of claude_code silence is STALE on the UI path', () => {
    // Replay of the real incident: a running agent whose last tool was
    // claude_code emitted zero liveness events for 1,439,754 ms (~24 min). That
    // far exceeds the 10-min claude_code ceiling, so the board's per-agent
    // verdict (computeStaleAgentIds) flags it. The orchestrator detector's
    // leaseVerdict flags this SAME silence via its hard-timeout, so UI and
    // backend converge on the one real incident rather than disagreeing.
    const agentId = "4v1ykk";
    const SILENCE_MS = 1_439_754;
    const now = 10_000_000;
    const opts = {
      now,
      tasks: { [agentId]: { status: "running" } },
      lastActivityByAgent: { [agentId]: now - SILENCE_MS },
      lastToolByAgent: { [agentId]: "claude_code" },
    };
    expect(computeStaleAgentIds(opts)).toContain(agentId);
  });
});
