import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-4688 — src/lib/eval-results.ts, the query layer over
 * agentcore-hub-eval-results.
 *
 * Two things here are easy to get silently wrong and expensive in prod:
 *
 *  1. INDEX SELECTION. Every access pattern is a Query on a different key, and
 *     picking the wrong one doesn't error — it returns the wrong rows (or falls
 *     back to a partition scan of the busiest agent). So the IndexName +
 *     KeyConditionExpression the helper builds are asserted directly, off a fake
 *     `send`, rather than trusted.
 *  2. THE CURSOR. It is user-supplied (it rides in the URL), so decodeCursor must
 *     degrade to "first page" on anything malformed instead of throwing — a
 *     hand-edited `?cursor=` must never 500 the results route.
 *
 * The AWS SDK is mocked at the module seam (the idiom of api/bugs/route.test.ts),
 * so the module-level DocumentClient construction is inert and no AWS is touched.
 */

const h = vi.hoisted(() => ({
  sends: [] as Array<Record<string, unknown>>,
  /** Queued responses, shifted per send; default is an empty last page. */
  queue: [] as Array<{ Items?: unknown[]; LastEvaluatedKey?: Record<string, unknown> }>,
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class QueryCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    QueryCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        async send(cmd: { input: Record<string, unknown> }) {
          h.sends.push(cmd.input);
          return h.queue.shift() ?? { Items: [] };
        },
      }),
    },
  };
});

const {
  buildResultsQuery,
  decodeCursor,
  encodeCursor,
  isDayKey,
  queryBySession,
  queryResults,
  DEFAULT_RESULTS_LIMIT,
  MAX_RESULTS_LIMIT,
} = await import("./eval-results");

beforeEach(() => {
  h.sends = [];
  h.queue = [];
});

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a LastEvaluatedKey", () => {
    const key = { agentId: "runtime_a", sk: "2026-09-07T10:00:00.000Z#abc" };
    const cursor = encodeCursor(key);
    expect(typeof cursor).toBe("string");
    expect(decodeCursor(cursor)).toEqual(key);
  });

  it("round-trips an index key (4 attributes) and is URL-safe", () => {
    const key = { gsi2pk: "runtime_a#persona_one", sk: "2026-09-07T10:00:00.000Z#abc", agentId: "runtime_a", n: 3 };
    const cursor = encodeCursor(key)!;
    expect(cursor).not.toMatch(/[+/=]/); // base64url — safe in a query string
    expect(decodeCursor(cursor)).toEqual(key);
  });

  it("encodes 'no next page' as null", () => {
    expect(encodeCursor(undefined)).toBeNull();
    expect(encodeCursor(null)).toBeNull();
    expect(encodeCursor({})).toBeNull();
  });

  it("returns undefined — never throws — for a hand-edited cursor", () => {
    const garbage = [
      "",
      "not-base64!!",
      Buffer.from("not json").toString("base64url"),
      Buffer.from("[1,2,3]").toString("base64url"),        // array, not an object
      Buffer.from("null").toString("base64url"),
      Buffer.from('"a string"').toString("base64url"),
      Buffer.from("{}").toString("base64url"),             // empty key
      Buffer.from('{"a":{"nested":1}}').toString("base64url"), // non-scalar attr
      Buffer.from('{"a":1,"b":2,"c":3,"d":4,"e":5}').toString("base64url"), // too many attrs
    ];
    for (const bad of garbage) {
      expect(() => decodeCursor(bad), bad).not.toThrow();
      expect(decodeCursor(bad), bad).toBeUndefined();
    }
    expect(decodeCursor(null)).toBeUndefined();
    expect(decodeCursor(undefined)).toBeUndefined();
  });
});

describe("isDayKey", () => {
  it("accepts a UTC day key and nothing else", () => {
    expect(isDayKey("2026-09-07")).toBe(true);
    for (const bad of ["2026-9-7", "2026-09-07T00:00:00Z", "yesterday", "", 20260907, null]) {
      expect(isDayKey(bad), String(bad)).toBe(false);
    }
  });
});

describe("buildResultsQuery — index selection", () => {
  it("uses the base table (PK agentId) when only agentId is given", () => {
    const { index, input } = buildResultsQuery({ agentId: "runtime_a" });
    expect(index).toBeNull();
    expect(input.IndexName).toBeUndefined();
    expect(input.KeyConditionExpression).toBe("#pk = :pk");
    expect(input.ExpressionAttributeNames).toEqual({ "#pk": "agentId" });
    expect(input.ExpressionAttributeValues).toEqual({ ":pk": "runtime_a" });
    expect(input.TableName).toBe("agentcore-hub-eval-results");
    expect(input.ScanIndexForward).toBe(false); // newest first
    expect(input.Limit).toBe(DEFAULT_RESULTS_LIMIT);
  });

  it("uses byPersona with the composite ${agentId}#${persona} key when persona is given", () => {
    const { index, input } = buildResultsQuery({ agentId: "runtime_a", persona: "persona_one" });
    expect(index).toBe("byPersona");
    expect(input.IndexName).toBe("byPersona");
    expect(input.ExpressionAttributeNames).toEqual({ "#pk": "gsi2pk" });
    expect(input.ExpressionAttributeValues).toEqual({ ":pk": "runtime_a#persona_one" });
  });

  it("uses byWorkflow — and needs no agentId — when workflowId is given", () => {
    const { index, input } = buildResultsQuery({ workflowId: "wf_1" });
    expect(index).toBe("byWorkflow");
    expect(input.ExpressionAttributeNames).toEqual({ "#pk": "gsi3pk" });
    expect(input.ExpressionAttributeValues).toEqual({ ":pk": "wf_1" });
  });

  it("prefers byWorkflow over byPersona — one run is the narrower question", () => {
    const { index } = buildResultsQuery({ agentId: "runtime_a", persona: "persona_one", workflowId: "wf_1" });
    expect(index).toBe("byWorkflow");
  });

  it("throws when there is no partition to query", () => {
    expect(() => buildResultsQuery({})).toThrow(/agentId or workflowId/);
    expect(() => buildResultsQuery({ persona: "persona_one" })).toThrow(/agentId or workflowId/);
  });
});

describe("buildResultsQuery — the day range rides the sort key", () => {
  it("BETWEENs a multi-day range, with the upper bound covering the whole last day", () => {
    const { input } = buildResultsQuery({ agentId: "runtime_a", from: "2026-09-01", to: "2026-09-07" });
    expect(input.KeyConditionExpression).toBe("#pk = :pk AND #sk BETWEEN :from AND :to");
    expect(input.ExpressionAttributeNames).toEqual({ "#pk": "agentId", "#sk": "sk" });
    const values = input.ExpressionAttributeValues as Record<string, string>;
    expect(values[":from"]).toBe("2026-09-01");
    // sk = `${evaluatedAt}#${dedupKey}`, so 2026-09-07T23:59 must still be <= :to.
    expect(values[":to"] > "2026-09-07T23:59:59.999Z#zzz").toBe(true);
    expect(values[":to"] < "2026-09-08").toBe(true);
  });

  it("collapses a single-day range to begins_with", () => {
    const { input } = buildResultsQuery({ agentId: "runtime_a", from: "2026-09-07", to: "2026-09-07" });
    expect(input.KeyConditionExpression).toBe("#pk = :pk AND begins_with(#sk, :day)");
    expect(input.ExpressionAttributeValues).toEqual({ ":pk": "runtime_a", ":day": "2026-09-07" });
  });

  it("handles a one-sided range and ignores a malformed day", () => {
    expect(buildResultsQuery({ agentId: "a", from: "2026-09-01" }).input.KeyConditionExpression)
      .toBe("#pk = :pk AND #sk >= :from");
    expect(buildResultsQuery({ agentId: "a", to: "2026-09-07" }).input.KeyConditionExpression)
      .toBe("#pk = :pk AND #sk <= :to");
    // Junk bounds are dropped, not passed to DDB as a key condition.
    expect(buildResultsQuery({ agentId: "a", from: "last tuesday", to: "" }).input.KeyConditionExpression)
      .toBe("#pk = :pk");
  });
});

describe("buildResultsQuery — limit + cursor", () => {
  it("clamps the limit and defaults a junk one", () => {
    expect(buildResultsQuery({ agentId: "a", limit: 10 }).input.Limit).toBe(10);
    expect(buildResultsQuery({ agentId: "a", limit: 10_000 }).input.Limit).toBe(MAX_RESULTS_LIMIT);
    expect(buildResultsQuery({ agentId: "a", limit: 0 }).input.Limit).toBe(DEFAULT_RESULTS_LIMIT);
    expect(buildResultsQuery({ agentId: "a", limit: NaN }).input.Limit).toBe(DEFAULT_RESULTS_LIMIT);
    expect(buildResultsQuery({ agentId: "a", limit: null }).input.Limit).toBe(DEFAULT_RESULTS_LIMIT);
  });

  it("forwards a decoded cursor as ExclusiveStartKey, and drops a garbage one", () => {
    const key = { agentId: "a", sk: "2026-09-07T00:00:00.000Z#x" };
    expect(buildResultsQuery({ agentId: "a", cursor: encodeCursor(key) }).input.ExclusiveStartKey).toEqual(key);
    expect(buildResultsQuery({ agentId: "a", cursor: "not-a-cursor" }).input.ExclusiveStartKey).toBeUndefined();
    expect(buildResultsQuery({ agentId: "a", cursor: null }).input.ExclusiveStartKey).toBeUndefined();
  });
});

describe("queryResults", () => {
  it("returns the page items plus an encoded next cursor", async () => {
    const lastKey = { agentId: "runtime_a", sk: "2026-09-06T00:00:00.000Z#z" };
    h.queue = [{ Items: [{ sessionId: "s1", evaluator: "Helpfulness" }], LastEvaluatedKey: lastKey }];

    const page = await queryResults({ agentId: "runtime_a", limit: 1 });
    expect(page.items).toEqual([{ sessionId: "s1", evaluator: "Helpfulness" }]);
    expect(page.index).toBeNull();
    expect(decodeCursor(page.cursor)).toEqual(lastKey);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].Limit).toBe(1);
  });

  it("cursor is null on the last page, and a returned cursor drives the next query", async () => {
    const lastKey = { agentId: "runtime_a", sk: "2026-09-06T00:00:00.000Z#z" };
    h.queue = [
      { Items: [{ sessionId: "s1" }], LastEvaluatedKey: lastKey },
      { Items: [{ sessionId: "s2" }] },
    ];

    const first = await queryResults({ agentId: "runtime_a", limit: 1 });
    const second = await queryResults({ agentId: "runtime_a", limit: 1, cursor: first.cursor });
    expect(second.items).toEqual([{ sessionId: "s2" }]);
    expect(second.cursor).toBeNull();
    expect(h.sends[0].ExclusiveStartKey).toBeUndefined();
    expect(h.sends[1].ExclusiveStartKey).toEqual(lastKey);
  });
});

describe("queryBySession", () => {
  it("queries bySession ascending and pages to exhaustion", async () => {
    h.queue = [
      { Items: [{ evaluator: "Coherence" }], LastEvaluatedKey: { gsi1pk: "sess-1", gsi1sk: "Coherence#t" } },
      { Items: [{ evaluator: "Helpfulness" }] },
    ];

    const rows = await queryBySession("sess-1");
    expect(rows.map((r) => r.evaluator)).toEqual(["Coherence", "Helpfulness"]);
    expect(h.sends).toHaveLength(2);
    expect(h.sends[0]).toMatchObject({
      IndexName: "bySession",
      KeyConditionExpression: "#pk = :sid",
      ExpressionAttributeNames: { "#pk": "gsi1pk" },
      ExpressionAttributeValues: { ":sid": "sess-1" },
      ScanIndexForward: true,
    });
    expect(h.sends[1].ExclusiveStartKey).toEqual({ gsi1pk: "sess-1", gsi1sk: "Coherence#t" });
  });

  it("returns [] for an unknown session", async () => {
    expect(await queryBySession("nope")).toEqual([]);
  });
});
