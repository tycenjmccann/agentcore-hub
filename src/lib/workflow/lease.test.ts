import { describe, it, expect } from "vitest";
import { isLeaseLive, stealClaim } from "./lease";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/**
 * R3 (docs/race-condition-study.md): the lease is what stops retry/dispatch
 * from stealing a ticket out from under a LIVE agent (duplicate PRs). Pin the
 * liveness math and the CAS steal semantics.
 */

const TTL = 30 * 60_000;
const NOW = Date.parse("2026-08-30T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("isLeaseLive", () => {
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

describe("stealClaim", () => {
  function stub(failCondition: boolean) {
    const calls: Array<Record<string, unknown>> = [];
    const ddb = {
      async send(cmd: { input: Record<string, unknown> }) {
        calls.push(cmd.input);
        if (failCondition) {
          const err = new Error("moved");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
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
