import { describe, it, expect } from "vitest";
import { commandGroupId, commandDedupId } from "./command-queue";

/**
 * R1 (docs/race-condition-study.md): the FIFO grouping/dedup keys are the
 * serialization contract — a wrong group id silently re-introduces
 * intra-workflow concurrency, a wrong dedup id either drops real events or
 * lets Jira redeliveries through. Pin both.
 */
describe("commandGroupId", () => {
  it("groups a sub-task under its parent (workflow root)", () => {
    expect(commandGroupId("TEAM-102", "TEAM-100")).toBe("TEAM-100");
  });

  it("groups a root issue (epic/Bug) under its own key", () => {
    expect(commandGroupId("TEAM-100", undefined)).toBe("TEAM-100");
  });
});

describe("commandDedupId", () => {
  it("is identical across redeliveries of the same event", () => {
    const a = commandDedupId("TEAM-102", "ready", 1725000000000);
    const b = commandDedupId("TEAM-102", "ready", 1725000000000);
    expect(a).toBe(b);
  });

  it("differs for a later re-transition to the same status", () => {
    const first = commandDedupId("TEAM-102", "ready", 1725000000000);
    const later = commandDedupId("TEAM-102", "ready", 1725000099000);
    expect(first).not.toBe(later);
  });

  it("differs across statuses of the same delivery burst", () => {
    expect(commandDedupId("TEAM-102", "ready", 1725000000000)).not.toBe(
      commandDedupId("TEAM-102", "in_progress", 1725000000000)
    );
  });

  it("falls back to a unique id when Jira omits the timestamp", () => {
    const a = commandDedupId("TEAM-102", "ready", undefined);
    const b = commandDedupId("TEAM-102", "ready", undefined);
    // Better to process a guarded duplicate than drop a real event.
    expect(a).not.toBe(b);
  });

  it("stays within SQS constraints (charset + 128 chars)", () => {
    const id = commandDedupId("TEAM-102 weird/key", "in progress", 1725000000000);
    expect(id).toMatch(/^[a-zA-Z0-9:_.-]+$/);
    expect(id.length).toBeLessThanOrEqual(128);
  });
});
