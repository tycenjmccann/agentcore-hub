import { describe, it, expect, vi } from "vitest";
import { buildAddBlockerUpdates, normalizePreserveStatuses, applyBlockerEdge, createdTicketId } from "./ticket-blockers.mjs";

/**
 * TEAM-4130 F1 — the blocker-edge write, the one place that decides whether
 * blocking a ticket also PARKS it.
 *
 * The defect: live-reverify blocks the run's open ship tickets on the re-verify
 * ticket, and the single write it used also set `status = "blocked"`. A release
 * manager already `in_progress` therefore lost its status, and from `blocked`
 * the tickets Lambda has no `done` transition row — `to_status:"done"` only
 * resolves through the `skip` row's `to` alias (pinned by a test in
 * lambda/agentcore-hub-tickets/index.test.mjs), so the agent's own
 * report_completion could no longer close cleanly.
 *
 * The fix is a two-attempt conditional write, and the reason these tests exist
 * at the module level rather than against index.mjs is that the DECISION must be
 * inside the condition: a read-then-write would race the agent's own transition.
 * So the fake below is not a call recorder — it EVALUATES the ConditionExpression
 * against a row and applies the UpdateExpression, which is the only way to assert
 * that the two conditions are mutually exclusive and jointly exhaustive.
 */

const TABLE = "tickets";
const NOW = "2026-09-06T12:00:00.000Z";

/** Evaluate the clause vocabulary these two conditions are built from. */
function evalCondition(expr, item, values) {
  const js = expr
    .replace(/attribute_not_exists\(#s\)/g, () => JSON.stringify(item.status === undefined))
    .replace(/attribute_not_exists\(blockedBy\)/g, () => JSON.stringify(item.blockedBy === undefined))
    .replace(/contains\(blockedBy, :id\)/g, () =>
      JSON.stringify(Array.isArray(item.blockedBy) && item.blockedBy.includes(values[":id"])))
    .replace(/#s IN \(([^)]*)\)/g, (_, list) =>
      JSON.stringify(list.split(",").map((v) => values[v.trim()]).includes(item.status)))
    .replace(/\bNOT\b/g, "!")
    .replace(/\bAND\b/g, "&&")
    .replace(/\bOR\b/g, "||");
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${js});`)();
}

/** Apply the SET clauses this module emits (and only those). */
function applyUpdate(expr, item, values) {
  if (expr.includes("blockedBy = list_append(if_not_exists(blockedBy, :empty), :one)")) {
    item.blockedBy = [...(item.blockedBy ?? values[":empty"]), ...values[":one"]];
  }
  if (/#s = :blocked/.test(expr)) item.status = values[":blocked"];
  if (/#u = :now/.test(expr)) item.updatedAt = values[":now"];
}

/**
 * A DDB doc-client stand-in over one row. `throwOn` injects a non-conditional
 * failure on the Nth send (1-indexed) to exercise the warn path.
 */
function fakeDdb(item, { throwOn = 0 } = {}) {
  const sends = [];
  const send = async (input) => {
    sends.push(input);
    if (sends.length === throwOn) throw new Error("ProvisionedThroughputExceeded");
    const values = input.ExpressionAttributeValues || {};
    // DynamoDB rejects an ExpressionAttributeValue that no expression uses, so
    // an unused placeholder is a real (and easily-missed) bug, not cosmetics.
    for (const key of Object.keys(values)) {
      const used = input.UpdateExpression.includes(key) || (input.ConditionExpression || "").includes(key);
      expect(used, `unused ExpressionAttributeValue ${key}`).toBe(true);
    }
    if (!evalCondition(input.ConditionExpression, item, values)) {
      const err = new Error("The conditional request failed");
      err.name = "ConditionalCheckFailedException";
      throw err;
    }
    applyUpdate(input.UpdateExpression, item, values);
    return {};
  };
  return { send, sends, item };
}

const edge = (over = {}) => ({
  table: TABLE, ticketId: "TEAM-4066", blockerId: "TEAM-4200", now: NOW, ...over,
});

describe("normalizePreserveStatuses", () => {
  it("defaults to [] for anything that is not an array of strings", () => {
    for (const bad of [undefined, null, "in_progress", 7, {}]) {
      expect(normalizePreserveStatuses(bad)).toEqual([]);
    }
    expect(normalizePreserveStatuses([1, null, {}, "  "])).toEqual([]);
  });

  it("lowercases, trims and dedupes (the board stores lowercase)", () => {
    expect(normalizePreserveStatuses([" In Progress ", "in_review", "IN_REVIEW"]))
      .toEqual(["in progress", "in_review"]);
  });
});

describe("buildAddBlockerUpdates — the exact writes", () => {
  it("no preserveStatusIf → ONE write, byte-for-byte the pre-4130 one", () => {
    const updates = buildAddBlockerUpdates(edge());
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      TableName: TABLE,
      Key: { ticketId: "TEAM-4066" },
      UpdateExpression:
        "SET blockedBy = list_append(if_not_exists(blockedBy, :empty), :one), #s = :blocked, #u = :now",
      ConditionExpression: "attribute_not_exists(blockedBy) OR NOT contains(blockedBy, :id)",
      ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
      ExpressionAttributeValues: {
        ":empty": [], ":one": ["TEAM-4200"], ":id": "TEAM-4200",
        ":blocked": "blocked", ":now": NOW,
      },
    });
  });

  it("with preserveStatusIf → two writes with mutually exclusive conditions", () => {
    const [a1, a2] = buildAddBlockerUpdates(edge({ preserveStatusIf: ["in_progress", "in_review"] }));
    expect(a1.ConditionExpression).toBe(
      "(attribute_not_exists(blockedBy) OR NOT contains(blockedBy, :id))" +
      " AND (attribute_not_exists(#s) OR NOT (#s IN (:ps0, :ps1)))"
    );
    expect(a2.ConditionExpression).toBe(
      "(attribute_not_exists(blockedBy) OR NOT contains(blockedBy, :id)) AND #s IN (:ps0, :ps1)"
    );
    expect(a1.ExpressionAttributeValues[":ps0"]).toBe("in_progress");
    expect(a1.ExpressionAttributeValues[":ps1"]).toBe("in_review");
    // Attempt 2 is edge-only: no status assignment, and therefore no :blocked.
    expect(a2.UpdateExpression).toBe(
      "SET blockedBy = list_append(if_not_exists(blockedBy, :empty), :one), #u = :now"
    );
    expect(a2.UpdateExpression).not.toContain("#s = ");
    expect(a2.ExpressionAttributeValues[":blocked"]).toBeUndefined();
    // #s is still NAMED, because the condition references it.
    expect(a2.ExpressionAttributeNames["#s"]).toBe("status");
  });

  it("the placeholder list tracks the caller's array length", () => {
    const [a1] = buildAddBlockerUpdates(edge({ preserveStatusIf: ["in_progress"] }));
    expect(a1.ConditionExpression).toContain("#s IN (:ps0)");
    expect(a1.ExpressionAttributeValues[":ps1"]).toBeUndefined();
  });
});

describe("applyBlockerEdge — preserveStatusIf empty (every pre-4130 caller)", () => {
  it("a single write; the status IS overwritten to blocked", async () => {
    const db = fakeDdb({ ticketId: "TEAM-4065", status: "in_progress" });
    const out = await applyBlockerEdge({ ...edge({ ticketId: "TEAM-4065" }), send: db.send });

    expect(out).toBe("blocked");
    expect(db.sends).toHaveLength(1);
    expect(db.item).toMatchObject({ status: "blocked", blockedBy: ["TEAM-4200"], updatedAt: NOW });
  });

  it("an already-present edge is ONE conditional failure and nothing else", async () => {
    const db = fakeDdb({ ticketId: "TEAM-4065", status: "blocked", blockedBy: ["TEAM-4200"] });
    const out = await applyBlockerEdge({ ...edge({ ticketId: "TEAM-4065" }), send: db.send });

    expect(out).toBe("present");
    expect(db.sends).toHaveLength(1);
    expect(db.item.blockedBy).toEqual(["TEAM-4200"]);
  });
});

describe("applyBlockerEdge — preserveStatusIf set (live-reverify)", () => {
  const PRESERVE = ["in_progress", "in_review"];

  it.each([["in_progress"], ["in_review"]])(
    "a LIVE ship ticket (%s) gets the edge and KEEPS its status", async (status) => {
      const db = fakeDdb({ ticketId: "TEAM-4066", status });
      const out = await applyBlockerEdge({ ...edge({ preserveStatusIf: PRESERVE }), send: db.send });

      // Attempt 1 is refused by the status clause, attempt 2 lands.
      expect(out).toBe("preserved");
      expect(db.sends).toHaveLength(2);
      expect(db.item.status).toBe(status);
      expect(db.item.blockedBy).toEqual(["TEAM-4200"]);
      expect(db.item.updatedAt).toBe(NOW);
    }
  );

  it.each([["ready"], ["todo"], ["blocked"]])(
    "a non-live open ship ticket (%s) is parked on the FIRST attempt", async (status) => {
      const db = fakeDdb({ ticketId: "TEAM-4066", status });
      const out = await applyBlockerEdge({ ...edge({ preserveStatusIf: PRESERVE }), send: db.send });

      expect(out).toBe("blocked");
      expect(db.sends).toHaveLength(1);
      expect(db.item).toMatchObject({ status: "blocked", blockedBy: ["TEAM-4200"] });
    }
  );

  it("a row with no status at all is parked (attribute_not_exists branch)", async () => {
    const db = fakeDdb({ ticketId: "TEAM-4066" });
    const out = await applyBlockerEdge({ ...edge({ preserveStatusIf: PRESERVE }), send: db.send });

    expect(out).toBe("blocked");
    expect(db.sends).toHaveLength(1);
    expect(db.item.status).toBe("blocked");
  });

  it("an already-present edge fails BOTH conditions → present, not added", async () => {
    const db = fakeDdb({ ticketId: "TEAM-4066", status: "in_progress", blockedBy: ["TEAM-4200"] });
    const out = await applyBlockerEdge({ ...edge({ preserveStatusIf: PRESERVE }), send: db.send });

    expect(out).toBe("present");
    expect(db.sends).toHaveLength(2); // attempt 1 CCFE, attempt 2 CCFE
    expect(db.item.status).toBe("in_progress");
    expect(db.item.blockedBy).toEqual(["TEAM-4200"]); // no duplicate edge
  });

  it("a SECOND blocker still appends onto a preserved live ticket", async () => {
    const db = fakeDdb({ ticketId: "TEAM-4066", status: "in_progress", blockedBy: ["TEAM-4199"] });
    const out = await applyBlockerEdge({
      ...edge({ preserveStatusIf: PRESERVE }), send: db.send,
    });

    expect(out).toBe("preserved");
    expect(db.item.blockedBy).toEqual(["TEAM-4199", "TEAM-4200"]);
    expect(db.item.status).toBe("in_progress");
  });
});

describe("applyBlockerEdge — a non-conditional failure never throws", () => {
  it("attempt 1 throws → warned, reported as error (caller must not count it)", async () => {
    const warn = vi.fn();
    const db = fakeDdb({ ticketId: "TEAM-4066", status: "ready" }, { throwOn: 1 });
    const out = await applyBlockerEdge({ ...edge({ preserveStatusIf: ["in_progress"] }), send: db.send, warn });

    expect(out).toBe("error");
    expect(db.sends).toHaveLength(1); // no attempt 2 on a non-CCFE failure
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("TEAM-4066 += TEAM-4200 failed (non-fatal)");
    expect(db.item.blockedBy).toBeUndefined();
  });

  it("attempt 2 throws → warned, reported as error", async () => {
    const warn = vi.fn();
    const db = fakeDdb({ ticketId: "TEAM-4066", status: "in_progress" }, { throwOn: 2 });
    const out = await applyBlockerEdge({ ...edge({ preserveStatusIf: ["in_progress"] }), send: db.send, warn });

    expect(out).toBe("error");
    expect(db.sends).toHaveLength(2);
    expect(warn.mock.calls[0][0]).toContain("(status-preserving) failed (non-fatal)");
    expect(db.item.status).toBe("in_progress"); // untouched
  });

  it("no warn dep and no send at all is still not a throw", async () => {
    const out = await applyBlockerEdge({
      ...edge(), send: async () => { throw new Error("boom"); },
    });
    expect(out).toBe("error");
  });
});

// ─── TEAM-4156 F1 ────────────────────────────────────────────────────────────

/**
 * The accessor exists because the two ticket backends have always disagreed about
 * what a created ticket looks like, and every producer in the orchestrator read
 * only the DynamoDB spelling. Under TICKET_PROVIDER=jira (what `.env.example` and
 * the Dockerfile ship) that read null for a ticket that really existed, and each
 * caller then took its fail-open branch: sync-main let CI certify an unmergeable
 * branch, live-reverify handed back its CAS slot, dead-session-escalation opened
 * no gate.
 *
 * It lives in this module for one reason: zero imports, so all three producers can
 * share it with no chance of a cycle.
 */
describe("createdTicketId — one reader for both providers' create_ticket answers", () => {
  it("reads the dynamodb shapes", () => {
    // lambda/agentcore-hub-tickets/index.mjs answers both spellings at once.
    expect(createdTicketId({ key: "TEAM-1", status: "created", ticket: { key: "TEAM-1" } })).toBe("TEAM-1");
    expect(createdTicketId({ key: "TEAM-1" })).toBe("TEAM-1");
    expect(createdTicketId({ ticket: { key: "TEAM-1" } })).toBe("TEAM-1");
    expect(createdTicketId({ ticket: { ticketId: "TEAM-1" } })).toBe("TEAM-1");
  });

  it("reads the jira shapes — a fresh create AND a summary-dedupe hit", () => {
    // Fresh: `{ ticketId, status, message }`. Dedupe: `{ ...mapIssue(dup),
    // deduplicated: true }`, which is also ticketId-spelled. Both are real tickets
    // that something must block on.
    expect(createdTicketId({ ticketId: "TEAM-1", status: "todo", message: "Created TEAM-1: x" })).toBe("TEAM-1");
    expect(createdTicketId({ ticketId: "TEAM-1", title: "x", status: "in_progress", deduplicated: true })).toBe("TEAM-1");
  });

  it("`key` wins over `ticketId` — the seam normalizes onto `key`, so they agree by construction", () => {
    expect(createdTicketId({ key: "TEAM-1", ticketId: "TEAM-1" })).toBe("TEAM-1");
  });

  it("no id at all → null, which is every caller's fail-open input", () => {
    for (const v of [null, undefined, {}, [], "TEAM-1", 7, { error: "Unknown tool: Tickets___create_ticket" }, { content: [{ text: "boom" }] }]) {
      expect(createdTicketId(v)).toBeNull();
    }
  });

  it("a non-string id is NOT an id — it must never reach a blocker edge or a record", () => {
    // `addBlockers(ci, [{value:…}])` would write a corrupt edge that nothing can
    // ever resolve, which is strictly worse than the fail-open path.
    expect(createdTicketId({ key: 500 })).toBeNull();
    expect(createdTicketId({ key: { value: "TEAM-1" } })).toBeNull();
    expect(createdTicketId({ ticketId: ["TEAM-1"] })).toBeNull();
    expect(createdTicketId({ key: "" })).toBeNull();
    expect(createdTicketId({ key: "   " })).toBeNull();
    // …but a garbage `key` next to a usable `ticketId` still yields the ticket:
    // the point is to find the id, not to punish the provider.
    expect(createdTicketId({ key: 500, ticketId: "TEAM-1" })).toBe("TEAM-1");
    expect(createdTicketId({ key: "", ticket: { key: "TEAM-1" } })).toBe("TEAM-1");
  });

  it("trims — a padded id would not match any ticket read back by key", () => {
    expect(createdTicketId({ key: " TEAM-1 " })).toBe("TEAM-1");
  });

  it("never throws, whatever it is handed", () => {
    expect(() => createdTicketId(Object.create(null))).not.toThrow();
    expect(createdTicketId(new Error("boom"))).toBeNull();
  });
});
