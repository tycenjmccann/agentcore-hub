import { describe, it, expect } from "vitest";
import { isLeaseLive, lastAgentActivity, stealClaim } from "./lease.mjs";

/**
 * TEAM-3618: the orchestrator port of the lease primitives. Same contract as
 * src/lib/workflow/lease.test.ts — pin the liveness math, the paged heartbeat
 * scan, and the CAS steal so this copy can never drift from the app-side one
 * (parity enforced separately by src/lib/workflow/lease-parity.test.ts).
 */

const TTL = 30 * 60_000;
const NOW = Date.parse("2026-08-30T12:00:00Z");
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

describe("isLeaseLive (mjs)", () => {
  it("live: claim started within TTL, no events yet", () => {
    expect(isLeaseLive({ status: "running", startedAt: iso(5 * 60_000) }, null, NOW, TTL)).toBe(true);
  });

  it("live: old claim kept alive by recent agent activity (long coding turn)", () => {
    const task = { status: "running", startedAt: iso(3 * 60 * 60_000) };
    expect(isLeaseLive(task, iso(2 * 60_000), NOW, TTL)).toBe(true);
  });

  it("expired: old claim, last activity beyond TTL", () => {
    const task = { status: "running", startedAt: iso(3 * 60 * 60_000) };
    expect(isLeaseLive(task, iso(45 * 60_000), NOW, TTL)).toBe(false);
  });

  it("no lease: entry is not running", () => {
    expect(isLeaseLive({ status: "error", startedAt: iso(0) }, iso(0), NOW, TTL)).toBe(false);
    expect(isLeaseLive({ status: "complete", startedAt: iso(0) }, iso(0), NOW, TTL)).toBe(false);
  });

  it("no lease: missing entry or no timestamps at all", () => {
    expect(isLeaseLive(undefined, null, NOW, TTL)).toBe(false);
    expect(isLeaseLive({ status: "running" }, null, NOW, TTL)).toBe(false);
  });
});

describe("lastAgentActivity (mjs)", () => {
  function eventsStub(pages) {
    const inputs = [];
    let i = 0;
    const ddb = {
      async send(cmd) {
        inputs.push(cmd.input);
        return pages[Math.min(i++, pages.length - 1)];
      },
    };
    return { ddb, inputs };
  }

  it("filters server-side to heartbeat types + agentId within the TTL window", async () => {
    const { ddb, inputs } = eventsStub([{ Items: [] }]);
    await lastAgentActivity(ddb, "events", "wf_1", "dev_agent", undefined, TTL);
    const q = inputs[0];
    expect(q.FilterExpression).toContain("#t IN (:hb1, :hb2)");
    expect(q.FilterExpression).toContain("detail.agentId = :aid");
    expect(q.FilterExpression).toContain("#ts >= :cutoff");
    expect(q.ExpressionAttributeValues[":hb1"]).toBe("agent.streaming");
    expect(q.ExpressionAttributeValues[":hb2"]).toBe("agent.started");
  });

  it("paginates past pages the filter emptied (busy sibling flood)", async () => {
    const heartbeat = { type: "agent.streaming", timestamp: iso(60_000), detail: { agentId: "dev_agent" } };
    const { ddb, inputs } = eventsStub([
      { Items: [], LastEvaluatedKey: { workflowId: "wf_1", eventId: "x" } },
      { Items: [heartbeat] },
    ]);
    const ts = await lastAgentActivity(ddb, "events", "wf_1", "dev_agent", undefined, TTL);
    expect(ts).toBe(heartbeat.timestamp);
    expect(inputs.length).toBe(2);
  });

  it("skips events stamped with a different ticket, keeps unstamped ones", async () => {
    const sibling = { type: "agent.streaming", timestamp: iso(30_000), detail: { agentId: "dev_agent", ticketId: "TEAM-9" } };
    const unstamped = { type: "agent.streaming", timestamp: iso(90_000), detail: { agentId: "dev_agent" } };
    const { ddb } = eventsStub([{ Items: [sibling, unstamped] }]);
    const ts = await lastAgentActivity(ddb, "events", "wf_1", "dev_agent", "TEAM-2", TTL);
    expect(ts).toBe(unstamped.timestamp);
  });
});

describe("stealClaim (mjs)", () => {
  function stub(failCondition) {
    const calls = [];
    const ddb = {
      async send(cmd) {
        calls.push(cmd.input);
        if (failCondition) {
          const err = new Error("moved");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        return {};
      },
    };
    return { ddb, calls };
  }

  it("steals only the inspected claim generation (CAS on startedAt)", async () => {
    const { ddb, calls } = stub(false);
    const won = await stealClaim(ddb, "wf-table", "wf_1", "TEAM-2", "2026-08-30T10:00:00Z");
    expect(won).toBe(true);
    const input = calls[0];
    expect(input.ConditionExpression).toContain("agentTasks.#tid.startedAt = :exp");
    expect(input.UpdateExpression).toBe("SET agentTasks.#tid.#st = :ready");
  });

  it("loses when the claim moved (completed or re-claimed)", async () => {
    const { ddb } = stub(true);
    expect(await stealClaim(ddb, "wf-table", "wf_1", "TEAM-2", "2026-08-30T10:00:00Z")).toBe(false);
  });
});
