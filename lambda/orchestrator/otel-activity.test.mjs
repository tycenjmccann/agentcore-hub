import { describe, it, expect, vi } from "vitest";
import { createOtelActivity } from "./otel-activity.mjs";

/**
 * TEAM-3992 D4.3 — the OTEL span confirmation probe. The dead-session detector
 * only steals a soft-stale claim once this returns null (confirmed no span) or
 * the hard ceiling passes; a string renews liveness, undefined leaves it
 * soft-stale (never steals on a probe failure). These pin the sentinel contract
 * and the two cost guards (flag + per-sweep budget).
 */

const COMPLETE = (isoOrNull) => ({
  status: "Complete",
  results: isoOrNull ? [[{ field: "lastSpan", value: isoOrNull }]] : [[]],
});

function harness(overrides = {}) {
  const startQuery = overrides.startQuery ?? vi.fn(async () => ({ queryId: "q-1" }));
  const getQueryResults =
    overrides.getQueryResults ?? vi.fn(async () => COMPLETE("2026-09-05 11:00:00.000"));
  const env = { OTEL_ACTIVITY_CONFIRM: "on", ...overrides.env };
  const otel = createOtelActivity({
    startQuery,
    getQueryResults,
    env,
    now: overrides.now ?? (() => Date.parse("2026-09-05T11:05:00Z")),
    log: () => {},
  });
  return { otel, startQuery, getQueryResults };
}

describe("lastOtelActivity (D4.3)", () => {
  it("flag off (default) → undefined, and never touches the client", async () => {
    const { otel, startQuery } = harness({ env: { OTEL_ACTIVITY_CONFIRM: "off" } });
    const res = await otel.lastOtelActivity({ sessionId: "s1", ticketId: "TEAM-1", windowMs: 3_600_000 });
    expect(res).toBeUndefined();
    expect(startQuery).not.toHaveBeenCalled();
  });

  it("the query string filters on BOTH the session id and the ticket id", async () => {
    const { otel, startQuery } = harness();
    await otel.lastOtelActivity({ sessionId: "sess-abc", ticketId: "TEAM-2609", windowMs: 3_600_000 });
    const q = startQuery.mock.calls[0][0].queryString;
    expect(q).toContain('attributes.session.id = "sess-abc"');
    expect(q).toContain('attributes.ticket.id = "TEAM-2609"');
    expect(q).toContain("stats max(@timestamp) as lastSpan");
    expect(startQuery.mock.calls[0][0].logGroupName).toBe("aws/spans");
  });

  it("Complete with a max timestamp → that span's ISO string", async () => {
    const { otel } = harness();
    const res = await otel.lastOtelActivity({ ticketId: "TEAM-1", windowMs: 3_600_000 });
    expect(res).toBe(new Date(Date.parse("2026-09-05T11:00:00Z")).toISOString());
  });

  it("Complete with NO rows → null (queried, confirmed no span)", async () => {
    const { otel } = harness({ getQueryResults: vi.fn(async () => COMPLETE(null)) });
    const res = await otel.lastOtelActivity({ ticketId: "TEAM-1", windowMs: 3_600_000 });
    expect(res).toBeNull();
  });

  it("a Failed query → undefined (unknown, never confirms death)", async () => {
    const { otel } = harness({ getQueryResults: vi.fn(async () => ({ status: "Failed" })) });
    expect(await otel.lastOtelActivity({ ticketId: "TEAM-1", windowMs: 3_600_000 })).toBeUndefined();
  });

  it("a query that never Completes → undefined once the timeout elapses", async () => {
    // now() advances 6s per call so the 15s timeout trips after a few polls.
    let t = Date.parse("2026-09-05T11:05:00Z");
    const { otel, getQueryResults } = harness({
      now: () => (t += 6_000),
      getQueryResults: vi.fn(async () => ({ status: "Running" })),
      env: { OTEL_ACTIVITY_CONFIRM: "on", OTEL_QUERY_TIMEOUT_MS: "15000" },
    });
    const res = await otel.lastOtelActivity({ ticketId: "TEAM-1", windowMs: 3_600_000 });
    expect(res).toBeUndefined();
    expect(getQueryResults).toHaveBeenCalled();
  });

  it("budget exhausted → undefined WITHOUT calling StartQuery", async () => {
    const { otel, startQuery } = harness();
    const budget = { remaining: 0 };
    const res = await otel.lastOtelActivity({ ticketId: "TEAM-1", windowMs: 3_600_000 }, budget);
    expect(res).toBeUndefined();
    expect(startQuery).not.toHaveBeenCalled();
  });

  it("each real query charges the budget", async () => {
    const { otel, startQuery } = harness();
    const budget = { remaining: 2 };
    await otel.lastOtelActivity({ ticketId: "A", windowMs: 3_600_000 }, budget);
    await otel.lastOtelActivity({ ticketId: "B", windowMs: 3_600_000 }, budget);
    await otel.lastOtelActivity({ ticketId: "C", windowMs: 3_600_000 }, budget);
    expect(budget.remaining).toBe(0);
    expect(startQuery).toHaveBeenCalledTimes(2); // the third was over budget
  });

  it("neither id → undefined, no query (nothing to key on)", async () => {
    const { otel, startQuery } = harness();
    expect(await otel.lastOtelActivity({ windowMs: 3_600_000 })).toBeUndefined();
    expect(startQuery).not.toHaveBeenCalled();
  });
});
