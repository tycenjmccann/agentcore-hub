import { describe, it, expect } from "vitest";
import { isLeaseLive, lastAgentActivity, lastStreamedText, hasAgentErrorSince, stealClaim } from "./lease.mjs";

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

/**
 * TEAM-4120 FR-3 — the two read-only queries the escalation tree needs. They
 * live in lease.mjs so every events-table query keeps ONE shape and one paging
 * bound; check-workflow-writes.sh still allows exactly one write here
 * (stealClaim), so these must never grow an Update/Put.
 */
function eventsPages(pages) {
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

const streamFrame = (content, over = {}) => ({
  type: "agent.streaming",
  detail: { agentId: "dev_agent", type: "text", content, ...over },
});

describe("lastStreamedText (TEAM-4120 FR-3)", () => {
  it("queries newest-first for this agent's text/reasoning frames only", async () => {
    const { ddb, inputs } = eventsPages([{ Items: [] }]);
    await lastStreamedText(ddb, "events", "wf_1", "dev_agent", "TEAM-2", 600);
    const q = inputs[0];
    expect(q.TableName).toBe("events");
    expect(q.KeyConditionExpression).toBe("workflowId = :w");
    expect(q.FilterExpression).toContain("#t = :streaming");
    expect(q.FilterExpression).toContain("detail.agentId = :aid");
    expect(q.FilterExpression).toContain("detail.#dt IN (:text, :reasoning)");
    expect(q.ExpressionAttributeNames).toMatchObject({ "#t": "type", "#dt": "type" });
    expect(q.ExpressionAttributeValues[":streaming"]).toBe("agent.streaming");
    expect(q.ExpressionAttributeValues[":aid"]).toBe("dev_agent");
    expect(q.ExpressionAttributeValues[":text"]).toBe("text");
    expect(q.ExpressionAttributeValues[":reasoning"]).toBe("reasoning");
    // Newest-first is what makes "the LAST words" cheap.
    expect(q.ScanIndexForward).toBe(false);
    expect(q.Limit).toBe(500);
  });

  it("re-joins newest-first pages back into chronological order", async () => {
    // The table hands back "third", "second" then "first"; the caller wants the
    // text in the order the human would have watched it stream.
    const { ddb } = eventsPages([
      { Items: [streamFrame("third "), streamFrame("second ")], LastEvaluatedKey: { k: 1 } },
      { Items: [streamFrame("first ")] },
    ]);
    expect(await lastStreamedText(ddb, "events", "wf_1", "dev_agent", "TEAM-2", 600))
      .toBe("first second third ");
  });

  it("stops as soon as maxChars is collected (no needless pages)", async () => {
    const { ddb, inputs } = eventsPages([
      { Items: [streamFrame("z".repeat(40)), streamFrame("y".repeat(40))], LastEvaluatedKey: { k: 1 } },
      { Items: [streamFrame("x".repeat(40))] },
    ]);
    const out = await lastStreamedText(ddb, "events", "wf_1", "dev_agent", "TEAM-2", 50);
    expect(inputs).toHaveLength(1);
    // Both frames from the first page are kept — the budget is a floor to stop
    // paging at, and the CALLER clips to its exact character budget.
    expect(out).toBe("y".repeat(40) + "z".repeat(40));
  });

  it("skips frames stamped with a DIFFERENT ticket, keeps unstamped ones", async () => {
    const { ddb } = eventsPages([{
      Items: [
        streamFrame("mine ", { ticketId: "TEAM-2" }),
        streamFrame("theirs ", { ticketId: "TEAM-9" }),
        streamFrame("unstamped "),
      ],
    }]);
    expect(await lastStreamedText(ddb, "events", "wf_1", "dev_agent", "TEAM-2", 600))
      .toBe("unstamped mine ");
  });

  it("ignores non-string / empty content and returns '' when nothing streamed", async () => {
    const { ddb } = eventsPages([{ Items: [streamFrame(""), streamFrame(undefined), { detail: {} }] }]);
    expect(await lastStreamedText(ddb, "events", "wf_1", "dev_agent", "TEAM-2", 600)).toBe("");
  });

  it("bounds paging at 20 pages even when the table keeps handing back a cursor", async () => {
    const { ddb, inputs } = eventsPages([{ Items: [], LastEvaluatedKey: { k: 1 } }]);
    await lastStreamedText(ddb, "events", "wf_1", "dev_agent", "TEAM-2", 600);
    expect(inputs).toHaveLength(20);
  });
});

describe("hasAgentErrorSince (TEAM-4120 FR-3)", () => {
  const errRow = (over = {}) => ({ type: "agent.error", detail: { ticketId: "TEAM-2", ...over } });

  it("filters to agent.error on this ticket since the claim, excluding dead_session", async () => {
    const { ddb, inputs } = eventsPages([{ Items: [] }]);
    await hasAgentErrorSince(ddb, "events", "wf_1", "TEAM-2", iso(10 * 60_000));
    const q = inputs[0];
    expect(q.FilterExpression).toContain("#t = :err");
    expect(q.FilterExpression).toContain("detail.ticketId = :tid");
    expect(q.FilterExpression).toContain("#ts >= :since");
    // The detector's own death announcement is not the AGENT reporting failure —
    // counting it would suppress synthesis for every dead session.
    expect(q.FilterExpression).toContain("detail.reason <> :dead");
    expect(q.ExpressionAttributeValues[":err"]).toBe("agent.error");
    expect(q.ExpressionAttributeValues[":dead"]).toBe("dead_session");
    expect(q.ExpressionAttributeNames).toMatchObject({ "#t": "type", "#ts": "timestamp" });
  });

  it("true on the first non-empty page, false when nothing matched", async () => {
    const { ddb } = eventsPages([{ Items: [errRow({ reason: "tool_failure" })] }]);
    expect(await hasAgentErrorSince(ddb, "events", "wf_1", "TEAM-2", iso(0))).toBe(true);

    const empty = eventsPages([{ Items: [] }]);
    expect(await hasAgentErrorSince(empty.ddb, "events", "wf_1", "TEAM-2", iso(0))).toBe(false);
  });

  it("no claim start = nothing to compare against: false without a single read", async () => {
    const { ddb, inputs } = eventsPages([{ Items: [errRow()] }]);
    expect(await hasAgentErrorSince(ddb, "events", "wf_1", "TEAM-2", undefined)).toBe(false);
    expect(inputs).toHaveLength(0);
  });
});
