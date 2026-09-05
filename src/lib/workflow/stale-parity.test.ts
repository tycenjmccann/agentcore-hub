import { describe, it, expect } from "vitest";
import {
  computeStaleAgentIds,
  STALE_THRESHOLD_CLAUDE_CODE_MS,
  STALL_SOFT_TIMEOUT_MS,
  HEARTBEAT_SLACK_MS,
} from "@/lib/workflow/stale";
import leaseConstants from "../../config/lease-constants.json";

/**
 * TEAM-3989 D4.3 item 5 / TEAM-4100 F6 — the relationship between the UI's
 * claude_code stale window and the orchestrator's absolute stall soft-timeout.
 *
 * D4.3 tied the UI ceiling to the backend soft-timeout so the board and the stall
 * detector agree on when a silent claude_code agent is stuck. F6 then made the UI
 * count coding heartbeats (agent_heartbeat) toward liveness — the SAME agent.streaming
 * signal the backend lease renews on — so both now measure silence from the same
 * anchor. The remaining asymmetry is delivery lag: a heartbeat can renew the backend
 * lease an interval before it reaches the browser. So the UI window is soft-timeout
 * PLUS one heartbeat interval of slack (HEARTBEAT_SLACK_MS) — the board must never be
 * the FIRST to give up (a premature STUCK exposes the manual Restart → duplicate
 * session, D1.5). It stays well under the pre-D4.3 17-min ceiling.
 */
describe("stale UI ↔ orchestrator soft-timeout parity (TEAM-3989 D4.3 / TEAM-4100 F6)", () => {
  it("constant identity: UI claude_code ceiling === soft-timeout + one heartbeat interval of slack", () => {
    // Backend soft-timeout: one number, one source of truth (lease-constants.json).
    expect(STALL_SOFT_TIMEOUT_MS).toBe(leaseConstants.stallSoftTimeoutMs);
    expect(STALL_SOFT_TIMEOUT_MS).toBe(600_000); // 10 min
    // UI window = soft-timeout + heartbeat slack, so the UI trails (never leads)
    // the backend once heartbeats stop. 600_000 + 60_000 = 660_000 (11 min).
    expect(HEARTBEAT_SLACK_MS).toBe(60_000);
    expect(STALE_THRESHOLD_CLAUDE_CODE_MS).toBe(STALL_SOFT_TIMEOUT_MS + HEARTBEAT_SLACK_MS);
    expect(STALE_THRESHOLD_CLAUDE_CODE_MS).toBe(660_000);
    // Still under the old 17-min window, and the UI is never earlier than backend.
    expect(STALE_THRESHOLD_CLAUDE_CODE_MS).toBeLessThan(1_020_000);
    expect(STALE_THRESHOLD_CLAUDE_CODE_MS).toBeGreaterThanOrEqual(STALL_SOFT_TIMEOUT_MS);
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
