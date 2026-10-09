import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-4688 — GET /api/evaluations/results, the paginated verdict list.
 *
 * What matters here:
 *  - the filter set reaches the query layer verbatim (agentId/persona/workflowId
 *    pick the index; from/to are a day range), because a dropped filter returns
 *    the WRONG rows rather than erroring;
 *  - the cursor round-trips: the `cursor` handed back drives the next page, and a
 *    hand-edited one must not 500 (decodeCursor swallows garbage, so the route
 *    degrades to the first page);
 *  - rows are grouped per session WITHIN a page, and a group that can straddle a
 *    page boundary is flagged `partial` — the per-session route is authoritative.
 *
 * @/lib/eval-results is mocked at the module seam (its own DDB wiring is covered
 * by src/lib/eval-results.test.ts).
 */

const h = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  pages: [] as Array<{ items: unknown[]; cursor: string | null; index: string | null }>,
  error: null as Error | null,
}));

vi.mock("@/lib/eval-results", async () => {
  // isDayKey is pure validation the route shares — keep the real one.
  const actual = await vi.importActual<typeof import("@/lib/eval-results")>("@/lib/eval-results");
  return {
    isDayKey: actual.isDayKey,
    queryResults: vi.fn(async (opts: Record<string, unknown>) => {
      h.calls.push(opts);
      if (h.error) throw h.error;
      return h.pages.shift() ?? { items: [], cursor: null, index: null };
    }),
  };
});

const { GET } = await import("./route");

const get = (query: string) => GET(new NextRequest(`http://localhost/api/evaluations/results${query}`));

function row(over: Record<string, unknown> = {}) {
  return {
    agentId: "runtime_a",
    sk: "2026-09-15T10:00:00.000Z#a",
    sessionId: "sess-1",
    persona: "persona_one",
    workflowId: "wf_1",
    ticketId: "TEAM-1",
    evaluator: "Helpfulness",
    score: 0.9,
    scoreLabel: "PASS",
    status: "COMPLETED",
    evaluatedAt: "2026-09-15T10:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  h.calls = [];
  h.pages = [];
  h.error = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/evaluations/results — filters reach the query layer", () => {
  it("forwards agentId, persona, workflowId, from, to and limit", async () => {
    const res = await get("?agentId=runtime_a&persona=persona_one&workflowId=wf_1&from=2026-09-01&to=2026-09-15&limit=25");
    expect(res.status).toBe(200);
    expect(h.calls[0]).toEqual({
      agentId: "runtime_a",
      persona: "persona_one",
      workflowId: "wf_1",
      from: "2026-09-01",
      to: "2026-09-15",
      cursor: null,
      limit: 25,
    });
  });

  it("workflowId alone is enough; agentId alone is enough; neither is a 400", async () => {
    expect((await get("?workflowId=wf_1")).status).toBe(200);
    expect((await get("?agentId=runtime_a")).status).toBe(200);
    const res = await get("?persona=persona_one");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/agentId or workflowId/);
  });

  it("400s on a malformed day range or limit instead of widening the query", async () => {
    for (const q of ["?agentId=a&from=yesterday", "?agentId=a&to=2026-9-1", "?agentId=a&limit=lots", "?agentId=a&limit=-3"]) {
      const res = await get(q);
      expect(res.status, q).toBe(400);
    }
    expect(h.calls).toHaveLength(0);
  });
});

describe("GET /api/evaluations/results — grouping", () => {
  it("collapses each session's evaluator rows into one entry with the latest timestamp", async () => {
    h.pages = [{
      index: null,
      cursor: null,
      items: [
        row({ evaluator: "Helpfulness", score: 0.9, evaluatedAt: "2026-09-15T10:00:00.000Z" }),
        row({ evaluator: "Correctness", score: 0.2, scoreLabel: "FAIL", status: "COMPLETED", evaluatedAt: "2026-09-15T10:00:05.000Z" }),
        row({ sessionId: "sess-2", workflowId: undefined, ticketId: undefined, persona: undefined, evaluator: "Helpfulness", score: null, scoreLabel: undefined, status: "ERROR", evaluatedAt: "2026-09-14T09:00:00.000Z" }),
      ],
    }];

    const { sessions, cursor } = await (await get("?agentId=runtime_a")).json();
    expect(cursor).toBeNull();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toEqual({
      sessionId: "sess-1",
      agentId: "runtime_a",
      persona: "persona_one",
      workflowId: "wf_1",
      ticketId: "TEAM-1",
      evaluatedAt: "2026-09-15T10:00:05.000Z", // the latest of the two rows
      evaluators: {
        Helpfulness: { score: 0.9, scoreLabel: "PASS", status: "COMPLETED" },
        Correctness: { score: 0.2, scoreLabel: "FAIL", status: "COMPLETED" },
      },
      resultCount: 2,
      partial: false,
    });
    // Missing joins are null, never undefined-shaped holes in the JSON.
    expect(sessions[1]).toMatchObject({
      sessionId: "sess-2",
      workflowId: null,
      ticketId: null,
      persona: null,
      evaluators: { Helpfulness: { score: null, scoreLabel: null, status: "ERROR" } },
    });
  });

  it("preserves the newest-first row order the query layer returns", async () => {
    h.pages = [{
      index: null,
      cursor: null,
      items: [
        row({ sessionId: "newest", evaluatedAt: "2026-09-15T10:00:00.000Z" }),
        row({ sessionId: "older", evaluatedAt: "2026-09-14T10:00:00.000Z" }),
        row({ sessionId: "oldest", evaluatedAt: "2026-09-13T10:00:00.000Z" }),
      ],
    }];
    const { sessions } = await (await get("?agentId=runtime_a")).json();
    expect(sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(["newest", "older", "oldest"]);
  });

  it("flags the groups a page boundary can cut in half", async () => {
    h.pages = [
      { index: null, cursor: "CURSOR-1", items: [row({ sessionId: "a" }), row({ sessionId: "b" })] },
      { index: null, cursor: null, items: [row({ sessionId: "b" }), row({ sessionId: "c" })] },
    ];
    const first = await (await get("?agentId=runtime_a&limit=2")).json();
    expect(first.sessions.map((s: { partial: boolean }) => s.partial)).toEqual([false, true]);

    const second = await (await get(`?agentId=runtime_a&limit=2&cursor=${first.cursor}`)).json();
    // Reached BY a cursor, so its leading group may continue the previous page.
    expect(second.sessions.map((s: { partial: boolean }) => s.partial)).toEqual([true, false]);
  });
});

describe("GET /api/evaluations/results — cursor", () => {
  it("hands back the next cursor and forwards it verbatim on the next call", async () => {
    h.pages = [
      { index: null, cursor: "OPAQUE-CURSOR", items: [row({ sessionId: "s1" })] },
      { index: null, cursor: null, items: [row({ sessionId: "s2" })] },
    ];

    const page1 = await (await get("?agentId=runtime_a&limit=1")).json();
    expect(page1.cursor).toBe("OPAQUE-CURSOR");
    expect(page1.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(["s1"]);

    const page2 = await (await get(`?agentId=runtime_a&limit=1&cursor=${page1.cursor}`)).json();
    expect(h.calls[1].cursor).toBe("OPAQUE-CURSOR");
    expect(page2.cursor).toBeNull();
    expect(page2.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(["s2"]);
  });

  it("a real encoded cursor survives the URL round trip untouched", async () => {
    const { encodeCursor } = await vi.importActual<typeof import("@/lib/eval-results")>("@/lib/eval-results");
    const cursor = encodeCursor({ agentId: "runtime_a", sk: "2026-09-15T10:00:00.000Z#a" })!;
    h.pages = [{ index: null, cursor: null, items: [] }];
    await get(`?agentId=runtime_a&cursor=${encodeURIComponent(cursor)}`);
    expect(h.calls[0].cursor).toBe(cursor);
  });

  it("a hand-edited cursor is 200 + first page, never a 500", async () => {
    h.pages = [{ index: null, cursor: null, items: [row()] }];
    const res = await get("?agentId=runtime_a&cursor=%7Bnot-a-cursor%7D");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessions).toHaveLength(1);
    // The route passes it through; decodeCursor (unit-tested separately) drops it.
    expect(h.calls[0].cursor).toBe("{not-a-cursor}");
  });

  it("500s with the message when the query itself fails", async () => {
    h.error = new Error("ResourceNotFoundException: table missing");
    const res = await get("?agentId=runtime_a");
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/ResourceNotFoundException/);
  });
});
