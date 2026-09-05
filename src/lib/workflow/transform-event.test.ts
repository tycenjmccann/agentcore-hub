import { describe, it, expect } from "vitest";
import { transformEvent } from "./transform-event";

/**
 * The DynamoDB → UI event mapping is the single source of truth for both the
 * live SSE stream and the replay JSON. These pin the shapes consumers depend
 * on, and — TEAM-3698 F2 — that the dead-session detector's shadow observation
 * is NOT surfaced as a UI event and does NOT masquerade as a real failure.
 */

const TS = "2026-09-01T12:00:00Z";

describe("transformEvent — agent.error (real failure)", () => {
  it("maps to a UI error event", () => {
    const out = transformEvent({
      type: "agent.error",
      timestamp: TS,
      detail: { agentId: "dev", error: "boom" },
    });
    expect(out).toEqual({ type: "error", agentId: "dev", error: "boom", timestamp: TS });
  });

  it("still maps to error even for a dead-session enforce death (no shadow leakage concern)", () => {
    const out = transformEvent({
      type: "agent.error",
      timestamp: TS,
      detail: { agentId: "dev", ticketId: "TEAM-2", reason: "dead_session" },
    });
    expect(out).toMatchObject({ type: "error", agentId: "dev" });
  });
});

describe("transformEvent — agent.streaming subtypes (TEAM-4100 F6)", () => {
  const streaming = (detail: Record<string, unknown>) =>
    transformEvent({ type: "agent.streaming", timestamp: TS, detail });

  it("text → agent_output (unchanged)", () => {
    expect(streaming({ agentId: "dev", type: "text", content: "hi", ticketId: "TEAM-2" })).toEqual({
      type: "agent_output",
      agentId: "dev",
      chunk: "hi",
      ticketId: "TEAM-2",
      timestamp: TS,
    });
  });

  it("trace → tool_use (unchanged)", () => {
    expect(streaming({ agentId: "dev", type: "trace", toolName: "claude_code" })).toEqual({
      type: "tool_use",
      agentId: "dev",
      toolName: "claude_code",
      timestamp: TS,
    });
  });

  it("heartbeat → agent_heartbeat liveness event (agentId + ticketId, no chunk)", () => {
    const out = streaming({ agentId: "dev", type: "heartbeat", ticketId: "TEAM-2", turn_id: "t1", poll_status: "running" });
    expect(out).toEqual({ type: "agent_heartbeat", agentId: "dev", ticketId: "TEAM-2", timestamp: TS });
    // Not transcript text — nothing to render/accumulate.
    expect(out).not.toHaveProperty("chunk");
    expect(out).not.toHaveProperty("content");
  });

  it("an unknown agent.streaming subtype is still dropped (null)", () => {
    expect(streaming({ agentId: "dev", type: "keepalive-legacy" })).toBeNull();
  });
});

describe("transformEvent — dead_session.shadow (TEAM-3698 F2)", () => {
  it("is dropped (null): a shadow observation is not a UI event", () => {
    const out = transformEvent({
      type: "dead_session.shadow",
      timestamp: TS,
      detail: {
        workflowId: "wf_1",
        ticketId: "TEAM-2",
        agentId: "dev",
        reason: "dead_session",
        shadow: true,
        detectorMeta: { claimStartedAt: "2026-09-01T00:00:00Z" },
      },
    });
    expect(out).toBeNull();
  });

  it("never leaks through the default passthrough branch as an error", () => {
    const out = transformEvent({ type: "dead_session.shadow", timestamp: TS, detail: { shadow: true } });
    // Explicit case: no {type:"error"} and no unknown passthrough object.
    expect(out).toBeNull();
  });
});
