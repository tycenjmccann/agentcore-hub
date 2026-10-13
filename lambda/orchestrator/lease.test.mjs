import { describe, it, expect } from "vitest";
import { isLeaseLive, lastAgentActivity, lastStreamedText, hasAgentErrorSince, stealClaim, parkGeneration, PARK_CLAIM_LABEL } from "./lease.mjs";

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

/**
 * TEAM-4739 — the two additive READ SHAPES. Both must leave every existing call
 * byte-equivalent: the `types` default is today's single agent.error filter, and
 * lastStreamedText still returns a bare string unless a caller asks for the
 * clock. `stealClaim` is still the only write in this module.
 */
describe("hasAgentErrorSince types (TEAM-4739)", () => {
  const filterOf = (inputs) => inputs[0].FilterExpression;

  it('the default is byte-equivalent to an explicit ["agent.error"]', async () => {
    const a = eventsPages([{ Items: [] }]);
    await hasAgentErrorSince(a.ddb, "events", "wf_1", "TEAM-2", iso(60_000));
    const b = eventsPages([{ Items: [] }]);
    await hasAgentErrorSince(b.ddb, "events", "wf_1", "TEAM-2", iso(60_000), { types: ["agent.error"] });
    expect(filterOf(a.inputs)).toBe(filterOf(b.inputs));
    expect(a.inputs[0].ExpressionAttributeValues).toEqual(b.inputs[0].ExpressionAttributeValues);
    expect(a.inputs[0].ExpressionAttributeNames).toEqual(b.inputs[0].ExpressionAttributeNames);
    // And it is still exactly today's shape — no OR wrapper, no :died value.
    expect(filterOf(a.inputs)).toContain("detail.reason <> :dead");
    expect(a.inputs[0].ExpressionAttributeValues[":died"]).toBeUndefined();
  });

  it('types:["agent.died"] does NOT apply the dead_session exclusion', async () => {
    // dead_session is the DETECTOR's own agent.error reason; it can never be the
    // reason on an agent.died row, so excluding it there would exclude nothing —
    // and copying the clause would risk dropping deaths that carry a reason.
    const { ddb, inputs } = eventsPages([{ Items: [] }]);
    await hasAgentErrorSince(ddb, "events", "wf_1", "TEAM-2", iso(60_000), { types: ["agent.died"] });
    expect(filterOf(inputs)).toContain("#t = :died");
    expect(filterOf(inputs)).not.toContain(":dead");
    expect(inputs[0].ExpressionAttributeValues[":died"]).toBe("agent.died");
    expect(inputs[0].ExpressionAttributeValues[":err"]).toBeUndefined();
  });

  it("both types OR together, each keeping its own exclusion rule", async () => {
    const { ddb, inputs } = eventsPages([{ Items: [] }]);
    await hasAgentErrorSince(ddb, "events", "wf_1", "TEAM-2", iso(60_000),
      { types: ["agent.error", "agent.died"] });
    const f = filterOf(inputs);
    expect(f).toContain("(#t = :err AND (attribute_not_exists(detail.reason) OR detail.reason <> :dead)) OR #t = :died");
    expect(inputs[0].ExpressionAttributeValues[":err"]).toBe("agent.error");
    expect(inputs[0].ExpressionAttributeValues[":died"]).toBe("agent.died");
  });

  it("an empty types list reads nothing rather than matching everything", async () => {
    const { ddb, inputs } = eventsPages([{ Items: [{ type: "agent.died", detail: { ticketId: "TEAM-2" } }] }]);
    expect(await hasAgentErrorSince(ddb, "events", "wf_1", "TEAM-2", iso(0), { types: [] })).toBe(false);
    expect(inputs).toHaveLength(0);
  });

  it("finds an agent.died row when asked for it", async () => {
    const { ddb } = eventsPages([{ Items: [{ type: "agent.died", detail: { ticketId: "TEAM-2" } }] }]);
    expect(await hasAgentErrorSince(ddb, "events", "wf_1", "TEAM-2", iso(0), { types: ["agent.died"] }))
      .toBe(true);
  });
});

/**
 * TEAM-5784 — `claimGeneration` is an opt-in fence on the `agent.died` arm:
 * a stale fail-closed park (TEAM-5716's claim fence) can be refused AFTER the
 * ticket is re-claimed, so the old invocation's death lands with a timestamp
 * past the NEW claim's startedAt — the `>= sinceIso` read alone cannot tell
 * the generations apart. Every call that omits it stays byte-equivalent to
 * before this option existed.
 */
describe("hasAgentErrorSince claimGeneration (TEAM-5784)", () => {
  const filterOf = (inputs) => inputs[0].FilterExpression;

  it("omitted: the agent.died filter is unchanged — no :gen, no generation clause", async () => {
    const { ddb, inputs } = eventsPages([{ Items: [] }]);
    await hasAgentErrorSince(ddb, "events", "wf_1", "TEAM-2", iso(60_000), { types: ["agent.died"] });
    expect(filterOf(inputs)).toContain("#t = :died");
    expect(filterOf(inputs)).not.toContain("claimStartedAt");
    expect(filterOf(inputs)).not.toContain(":gen");
    expect(inputs[0].ExpressionAttributeValues[":gen"]).toBeUndefined();
  });

  it("provided: the died arm gains a generation-match-or-unstamped clause", async () => {
    const { ddb, inputs } = eventsPages([{ Items: [] }]);
    await hasAgentErrorSince(ddb, "events", "wf_1", "TEAM-2", iso(60_000),
      { types: ["agent.died"], claimGeneration: "2026-09-01T11:00:00.000Z" });
    expect(filterOf(inputs)).toContain(
      "#t = :died AND (attribute_not_exists(detail.claimStartedAt) OR detail.claimStartedAt = :gen)");
    expect(filterOf(inputs)).toContain("detail.ticketId = :tid AND #ts >= :since");
    expect(inputs[0].ExpressionAttributeValues[":gen"]).toBe("2026-09-01T11:00:00.000Z");
  });

  it("the agent.error arm is untouched by claimGeneration", async () => {
    const { ddb, inputs } = eventsPages([{ Items: [] }]);
    await hasAgentErrorSince(ddb, "events", "wf_1", "TEAM-2", iso(60_000),
      { types: ["agent.error"], claimGeneration: "2026-09-01T11:00:00.000Z" });
    expect(filterOf(inputs)).toContain("#t = :err AND (attribute_not_exists(detail.reason) OR detail.reason <> :dead)");
    expect(filterOf(inputs)).not.toContain("claimStartedAt");
    expect(inputs[0].ExpressionAttributeValues[":gen"]).toBeUndefined();
  });

  it("a falsy claimGeneration (empty string) behaves exactly like omitted", async () => {
    const a = eventsPages([{ Items: [] }]);
    await hasAgentErrorSince(a.ddb, "events", "wf_1", "TEAM-2", iso(60_000), { types: ["agent.died"] });
    const b = eventsPages([{ Items: [] }]);
    await hasAgentErrorSince(b.ddb, "events", "wf_1", "TEAM-2", iso(60_000),
      { types: ["agent.died"], claimGeneration: "" });
    expect(filterOf(a.inputs)).toBe(filterOf(b.inputs));
    expect(a.inputs[0].ExpressionAttributeValues).toEqual(b.inputs[0].ExpressionAttributeValues);
  });

  it("the clause rides inside the SAME filter page after page — a stale row cannot hide a match", async () => {
    // Server-side filtering means a generation-mismatched row on an earlier
    // page never short-circuits the search: the query keeps paging (as it
    // already does for any filtered-out page) until it finds the matching row
    // or runs out of pages.
    const { ddb, inputs } = eventsPages([
      { Items: [], LastEvaluatedKey: { k: 1 } }, // page 1: stale-generation row filtered server-side
      { Items: [{ type: "agent.died", detail: { ticketId: "TEAM-2", claimStartedAt: "gen-2" } }] }, // page 2: match
    ]);
    expect(await hasAgentErrorSince(ddb, "events", "wf_1", "TEAM-2", iso(0),
      { types: ["agent.died"], claimGeneration: "gen-2" })).toBe(true);
    expect(inputs).toHaveLength(2);
    expect(inputs[1].ExpressionAttributeValues[":gen"]).toBe("gen-2");
  });
});

describe("lastStreamedText withTimestamp (TEAM-4739)", () => {
  it("returns the bare string by default (every existing caller unchanged)", async () => {
    const { ddb } = eventsPages([{ Items: [streamFrame("hello ")] }]);
    expect(await lastStreamedText(ddb, "events", "wf_1", "dev_agent", "TEAM-2", 600)).toBe("hello ");
  });

  it("withTimestamp returns {text, at} — `at` is the NEWEST matching frame's clock", async () => {
    // Newest-first, so the FIRST match is the latest: "at" must be the newest
    // row's timestamp even though the text is re-joined chronologically.
    const { ddb } = eventsPages([{
      Items: [
        { ...streamFrame("third "), timestamp: "2026-08-30T11:59:00Z" },
        { ...streamFrame("second "), timestamp: "2026-08-30T11:58:00Z" },
        { ...streamFrame("first "), timestamp: "2026-08-30T11:57:00Z" },
      ],
    }]);
    const out = await lastStreamedText(ddb, "events", "wf_1", "dev_agent", "TEAM-2", 600, { withTimestamp: true });
    expect(out).toEqual({ text: "first second third ", at: "2026-08-30T11:59:00Z" });
  });

  it("nothing streamed: {text:'', at:''} rather than a throw or a null", async () => {
    const { ddb } = eventsPages([{ Items: [] }]);
    expect(await lastStreamedText(ddb, "events", "wf_1", "dev_agent", "TEAM-2", 1, { withTimestamp: true }))
      .toEqual({ text: "", at: "" });
  });

  it("a frame for ANOTHER ticket does not set the clock", async () => {
    const { ddb } = eventsPages([{
      Items: [
        { ...streamFrame("theirs ", { ticketId: "TEAM-9" }), timestamp: "2026-08-30T11:59:00Z" },
        { ...streamFrame("mine ", { ticketId: "TEAM-2" }), timestamp: "2026-08-30T11:50:00Z" },
      ],
    }]);
    const out = await lastStreamedText(ddb, "events", "wf_1", "dev_agent", "TEAM-2", 600, { withTimestamp: true });
    expect(out).toEqual({ text: "mine ", at: "2026-08-30T11:50:00Z" });
  });
});

// TEAM-5719 (R1-3): a park releases a claim only when it is attributable to
// THAT claim generation.
describe("parkGeneration", () => {
  const G = "2026-10-13T01:00:00.000Z";
  const OLD = "2026-10-13T00:00:00.000Z";
  const AT = "2026-10-13T01:05:00.000Z";
  const task = { status: "running", startedAt: G };

  it("DDB: parkClaim of this generation, stamped by the same write (at === updatedAt) -> the generation", () => {
    expect(parkGeneration({ parkClaim: { startedAt: G, at: AT }, updatedAt: AT }, task)).toBe(G);
  });
  it("DDB: older generation, a stamp that outlived its write, or a malformed stamp -> null", () => {
    expect(parkGeneration({ parkClaim: { startedAt: OLD, at: AT }, updatedAt: AT }, task)).toBeNull();
    expect(parkGeneration({ parkClaim: { startedAt: G, at: AT }, updatedAt: "2026-10-13T01:06:00.000Z" }, task)).toBeNull();
    expect(parkGeneration({ parkClaim: { startedAt: G }, updatedAt: undefined }, task)).toBeNull();
    expect(parkGeneration({ parkClaim: { startedAt: 42, at: AT }, updatedAt: AT }, task)).toBeNull();
  });
  // TEAM-5729: the Jira label is `park-claim:<gen>:<nonce>` and must be confirmed by the
  // changelog history carrying that nonce (see the TEAM-5729 block below for the rule).
  const hist = (nonce) => ({ id: "9001", created: "2026-10-13T01:01:00.000Z", items: [{ field: "status", fromString: "In Progress", toString: "Blocked" }], historyMetadata: { extraData: { fenceNonce: nonce } } });
  it("Jira: a park-claim label naming this generation, confirmed by its changelog entry -> the generation", () => {
    expect(parkGeneration({ status: "blocked", labels: ["agent:x", `${PARK_CLAIM_LABEL}${G}:n1`], changelog: [hist("n1")] }, task)).toBe(G);
  });
  it("Jira: no label, an older generation's label, or legacy nonce-less labels -> null", () => {
    expect(parkGeneration({ status: "blocked", labels: ["agent:x"], changelog: [hist("n1")] }, task)).toBeNull();
    expect(parkGeneration({ status: "blocked", labels: [`${PARK_CLAIM_LABEL}${OLD}:n1`], changelog: [hist("n1")] }, task)).toBeNull();
    expect(parkGeneration({ status: "blocked", labels: [`${PARK_CLAIM_LABEL}${OLD}`, `${PARK_CLAIM_LABEL}${G}`], changelog: [hist("n1")] }, task)).toBeNull();
  });
  it("no attribution at all, or a claim with no startedAt -> null", () => {
    expect(parkGeneration({}, task)).toBeNull();
    expect(parkGeneration(null, task)).toBeNull();
    expect(parkGeneration({ status: "blocked", labels: [`${PARK_CLAIM_LABEL}`] }, { status: "running", startedAt: "" })).toBeNull();
    expect(parkGeneration({ parkClaim: { startedAt: G, at: AT }, updatedAt: AT }, { status: "running" })).toBeNull();
  });
});

// TEAM-5724 (R2-2): the label set the Jira Lambda leaves behind decides the release.
// Before the fix, a self-park whose fallback transition POST failed left
// `park-claim:<gen>` on a ticket that never moved; a LATER third-party park of that
// ticket then carried the live claim's generation and released it. After the fix the
// jira Lambda takes the label back off (index.test.mjs TEAM-5724 (a): labels end as
// exactly ["wf:wf_1"]), so the same third-party park is unattributable — fail closed.
describe("parkGeneration after a park that did not verify (TEAM-5724)", () => {
  const G = "2026-10-13T02:00:00.000Z";
  const task = { status: "running", startedAt: G };

  it("the label set the jira Lambda now leaves (no park-claim) -> null, claim NOT released", () => {
    expect(parkGeneration({ status: "blocked", labels: ["wf:wf_1"] }, task)).toBeNull();
  });
  it("the leftover label of the LIVE generation — what used to release the claim — releases nothing without its changelog entry (TEAM-5729 R3-2)", () => {
    expect(parkGeneration({ status: "blocked", labels: ["wf:wf_1", `${PARK_CLAIM_LABEL}${G}`] }, task)).toBeNull();
    expect(parkGeneration({ status: "blocked", labels: ["wf:wf_1", `${PARK_CLAIM_LABEL}${G}:n1`], changelog: [] }, task)).toBeNull();
  });
});

// TEAM-5729 (R3-2 / R3-3): on Jira the label is a POINTER — `park-claim:<gen>:<nonce>` —
// and the evidence is the changelog history carrying that nonce in
// historyMetadata.extraData.fenceNonce with exactly one status item into Blocked: the Jira
// Lambda's own verifyExpectedSource rule, re-run here on the `expand=changelog` read the
// blocked-case caller fetches. A label alone (R3-2: failed POST, failed cleanup), a legacy
// nonce-less label, a reverted park (two carriers) or a ticket whose caller fetched no
// changelog all fail CLOSED. The DDB `parkClaim` branch is byte-for-byte unchanged.
describe("parkGeneration — Jira label + confirmed changelog entry (TEAM-5729)", () => {
  const G = "2026-10-13T04:00:00.000Z";
  const OLD = "2026-10-13T03:00:00.000Z";
  const AT = "2026-10-13T04:05:00.000Z";
  const task = { status: "running", startedAt: G };
  const L = (gen, nonce) => `${PARK_CLAIM_LABEL}${gen}:${nonce}`;
  const hist = (nonce, { to = "Blocked", from = "In Progress", items } = {}) => ({
    id: "9001", created: "2026-10-13T04:01:00.000Z",
    items: items || [{ field: "status", fromString: from, toString: to }],
    historyMetadata: { type: "agentcore-hub-jira", extraData: { fenceNonce: nonce, expectedStatus: "in_progress", op: "transition" } },
  });

  it("L1: a live-generation label whose nonce has exactly one carrier into Blocked -> the generation", () => {
    expect(parkGeneration({ status: "blocked", labels: ["wf:wf_1", L(G, "n1")], changelog: [hist("n1")] }, task)).toBe(G);
  });
  it("L2 (R3-2): the label alone — no carrier — releases nothing; neither does a legacy nonce-less label", () => {
    expect(parkGeneration({ status: "blocked", labels: ["wf:wf_1", L(G, "n1")], changelog: [] }, task)).toBeNull();
    expect(parkGeneration({ status: "blocked", labels: ["wf:wf_1", L(G, "n1")], changelog: [hist("other")] }, task)).toBeNull();
    expect(parkGeneration({ status: "blocked", labels: ["wf:wf_1", `${PARK_CLAIM_LABEL}${G}`], changelog: [hist("n1")] }, task)).toBeNull();
  });
  it("L2b: a label but NO changelog on the ticket object (the caller did not fetch it) -> null, fail closed", () => {
    expect(parkGeneration({ status: "blocked", labels: ["wf:wf_1", L(G, "n1")] }, task)).toBeNull();
    expect(parkGeneration({ status: "blocked", labels: ["wf:wf_1", L(G, "n1")], changelog: undefined }, task)).toBeNull();
  });
  it("L3 (R3-3): two same-generation labels, one confirmed -> the generation (a sibling is inert, never a veto)", () => {
    expect(parkGeneration({ status: "blocked", labels: [L(G, "n1"), L(G, "n2")], changelog: [hist("n2")] }, task)).toBe(G);
    expect(parkGeneration({ status: "blocked", labels: [L(G, "n1"), L(G, "n2")], changelog: [hist("n1")] }, task)).toBe(G);
  });
  it("L4: a reverted park — two carriers of the nonce (the park and its revert) -> null", () => {
    expect(parkGeneration({ status: "blocked", labels: [L(G, "n1")], changelog: [hist("n1"), hist("n1", { from: "Blocked", to: "Done" })] }, task)).toBeNull();
  });
  it("L5: a malformed carrier -> null (two status items; into another status; no status item)", () => {
    expect(parkGeneration({ status: "blocked", labels: [L(G, "n1")], changelog: [hist("n1", { items: [{ field: "status", fromString: "In Progress", toString: "Blocked" }, { field: "status", fromString: "Blocked", toString: "Done" }] })] }, task)).toBeNull();
    expect(parkGeneration({ status: "blocked", labels: [L(G, "n1")], changelog: [hist("n1", { to: "In Progress", from: "Blocked" })] }, task)).toBeNull();
    expect(parkGeneration({ status: "blocked", labels: [L(G, "n1")], changelog: [hist("n1", { items: [{ field: "labels", fromString: "", toString: L(G, "n1") }] })] }, task)).toBeNull();
  });
  it("L6: a stale other-generation label beside a confirmed live-generation label -> the generation; the other generation alone -> null", () => {
    expect(parkGeneration({ status: "blocked", labels: [L(OLD, "n1"), L(G, "n2")], changelog: [hist("n2")] }, task)).toBe(G);
    expect(parkGeneration({ status: "blocked", labels: [L(OLD, "n1")], changelog: [hist("n1")] }, task)).toBeNull();
  });
  it("L7: the DDB parkClaim branch is unchanged, and a DDB stamp still takes precedence over labels", () => {
    expect(parkGeneration({ parkClaim: { startedAt: G, at: AT }, updatedAt: AT }, task)).toBe(G);
    expect(parkGeneration({ parkClaim: { startedAt: OLD, at: AT }, updatedAt: AT }, task)).toBeNull();
    expect(parkGeneration({ parkClaim: { startedAt: G, at: AT }, updatedAt: "2026-10-13T04:06:00.000Z" }, task)).toBeNull();
    expect(parkGeneration({ parkClaim: { startedAt: OLD, at: AT }, updatedAt: AT, labels: [L(G, "n1")], changelog: [hist("n1")] }, task)).toBeNull();
    expect(parkGeneration({ status: "blocked", labels: [L(G, "n1")], changelog: [hist("n1")] }, { status: "running" })).toBeNull();
  });
});

// TEAM-5731 (R4-1): TEAM-5729's rule proved the agent parked at SOME point in this claim
// generation, not that the Blocked move being processed IS that park. Agent self-parks with
// all blockers resolved (claim kept under the TEAM-4071 F1 guard; label + carrier stay on the
// ticket), moves the ticket back to In Progress, a third party adds an open blocker and
// Blocks it: label + one carrier into Blocked still read as confirmed and the live claim was
// released -> double dispatch. Now the carrier must be the NEWEST status-changing history by
// `created` (Jira's array order is not a contract: `expand=changelog` is newest-first, the
// dedicated endpoint oldest-first, and the orchestrator must not care), the ticket must still
// be Blocked, the expand page must be complete (Jira's `total`), every status history must
// carry a parseable `created` with no tie on the newest, and when the webhook named its
// changelog id the carrier must be that entry. Anything else fails CLOSED.
describe("parkGeneration — the carrier must be the NEWEST status change (TEAM-5731 R4-1)", () => {
  const G = "2026-10-13T05:00:00.000Z";
  const task = { status: "running", startedAt: G };
  const L = (nonce) => `${PARK_CLAIM_LABEL}${G}:${nonce}`;
  const T = (m) => `2026-10-13T05:0${m}:00.000Z`;
  /** A status history; ours carries the nonce, a foreign one does not. */
  const move = (from, to, { id, created, nonce } = {}) => ({
    id, created, items: [{ field: "status", fromString: from, toString: to }],
    ...(nonce ? { historyMetadata: { type: "agentcore-hub-jira", extraData: { fenceNonce: nonce, expectedStatus: "", op: "transition" } } } : {}),
  });
  const labelOnly = { id: "9010", created: T(9), items: [{ field: "labels", fromString: "", toString: L("n1") }] };
  const older = move("To Do", "In Progress", { id: "9000", created: T(0) });
  const park = move("In Progress", "Blocked", { id: "9001", created: T(1), nonce: "n1" });
  const unpark = move("Blocked", "In Progress", { id: "9002", created: T(2) });
  const foreignBlock = move("In Progress", "Blocked", { id: "9003", created: T(3) });
  const ticket = (changelog, extra = {}) => ({ status: "blocked", labels: ["wf:wf_1", L("n1")], changelog, ...extra });

  it("(a) a historical park followed by a foreign Block: label + carrier present, but the carrier is not the newest status change -> null, in any page order", () => {
    expect(parkGeneration(ticket([foreignBlock, unpark, park]), task)).toBeNull();
    expect(parkGeneration(ticket([park, unpark, foreignBlock]), task)).toBeNull();
    expect(parkGeneration(ticket([unpark, park, foreignBlock]), task)).toBeNull();
    expect(parkGeneration(ticket([foreignBlock, park]), task)).toBeNull();
  });
  it("(b) our own latest park: the carrier is the newest status change -> the generation, wherever the page lists it, beside older moves and a label-only history", () => {
    expect(parkGeneration(ticket([park, older, labelOnly]), task)).toBe(G);
    expect(parkGeneration(ticket([labelOnly, older, park]), task)).toBe(G);
    expect(parkGeneration(ticket([older, unpark, move("In Progress", "Blocked", { id: "9005", created: T(5), nonce: "n1" })]), task)).toBe(G);
    expect(parkGeneration(ticket([park]), task)).toBe(G);
  });
  it("(c) a newer non-Blocked status change after our carrier -> null, whatever the status field says", () => {
    expect(parkGeneration(ticket([unpark, park], { status: "in_progress" }), task)).toBeNull();
    expect(parkGeneration(ticket([unpark, park]), task)).toBeNull();
    expect(parkGeneration(ticket([park, unpark]), task)).toBeNull();
  });
  it("(d) a truncated expand page (Jira's total exceeds the histories returned, or is unreadable) -> null; a complete page releases", () => {
    expect(parkGeneration(ticket([park], { changelogTotal: 101 }), task)).toBeNull();
    expect(parkGeneration(ticket([park], { changelogTotal: 2 }), task)).toBeNull();
    expect(parkGeneration(ticket([park], { changelogTotal: "x" }), task)).toBeNull();
    expect(parkGeneration(ticket([park], { changelogTotal: 1 }), task)).toBe(G);
    expect(parkGeneration(ticket([park, labelOnly], { changelogTotal: 2 }), task)).toBe(G);
  });
  it("(e) the newest status change cannot be identified -> null: any status history without a parseable `created` (ours included), or a `created` tie on the newest", () => {
    expect(parkGeneration(ticket([move("In Progress", "Blocked", { id: "9001", nonce: "n1" })]), task)).toBeNull();
    expect(parkGeneration(ticket([older, move("In Progress", "Blocked", { id: "9001", created: "yesterday", nonce: "n1" })]), task)).toBeNull();
    expect(parkGeneration(ticket([park, move("To Do", "In Progress", { id: "9000" })]), task)).toBeNull();
    expect(parkGeneration(ticket([park, move("To Do", "In Progress", { id: "9000", created: "yesterday" })]), task)).toBeNull();
    expect(parkGeneration(ticket([park, move("To Do", "In Progress", { id: "9004", created: T(1) })]), task)).toBeNull();
    expect(parkGeneration(ticket([park, move("To Do", "In Progress", { id: "9000", created: T(1) })]), task)).toBeNull();
    expect(parkGeneration(ticket([park, { id: "9011", items: [{ field: "labels", fromString: "", toString: "x" }] }]), task)).toBe(G); // a non-status history needs no clock
  });
  it("(f) the webhook's changelog id, when known, must be the carrier's; absent, the newest rule alone decides", () => {
    expect(parkGeneration(ticket([park]), task, "9001")).toBe(G);
    expect(parkGeneration(ticket([park]), task, 9001)).toBe(G);
    expect(parkGeneration(ticket([park]), task, "9003")).toBeNull();
    expect(parkGeneration(ticket([older, park]), task, "9000")).toBeNull();
    expect(parkGeneration(ticket([park]), task, undefined)).toBe(G);
    expect(parkGeneration(ticket([park]), task, null)).toBe(G);
  });
  it("(g) the ticket is no longer Blocked -> null; the DDB parkClaim branch is unchanged and ignores the third argument", () => {
    expect(parkGeneration(ticket([park], { status: "in_progress" }), task)).toBeNull();
    expect(parkGeneration(ticket([park], { status: undefined }), task)).toBeNull();
    const AT = "2026-10-13T05:05:00.000Z";
    expect(parkGeneration({ parkClaim: { startedAt: G, at: AT }, updatedAt: AT }, task, "9999")).toBe(G);
    expect(parkGeneration({ parkClaim: { startedAt: G, at: AT }, updatedAt: AT, status: "in_progress" }, task)).toBe(G);
  });
});
