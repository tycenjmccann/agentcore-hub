import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-4760 — GET /api/evaluations/si-ledger, the read side of the SI ledger.
 *
 * What these pin, in order of how easily each would regress:
 *
 * 1. **The route never writes.** The ledger's credibility rests on every row
 *    being authored by a writer that computed it; a console-side mutation would
 *    be a number nobody can reproduce. The module must export GET and nothing
 *    else, forever.
 * 2. **Reserved `#…` rows are not patterns.** `#metrics` carries the coverage
 *    series. It must never be addressable as a patternKey and must never be
 *    counted in the tiles — otherwise "12 patterns tracked" quietly includes a
 *    bookkeeping row.
 * 3. **An empty table is a 200, not an error.** Before the backfill runs, and on
 *    a fresh account, the panel's normal state is zero rows. Rendering an error
 *    there would read as "the loop is broken" when the truth is "nothing yet".
 *    A table that does not EXIST yet is the same statement, and gets the same
 *    200 — carrying `unavailable.reason` with the handoff steps, on both the list
 *    and the drill-down. The line is drawn at "missing table" and nowhere else:
 *    AccessDenied, the IAM half of that same handoff, still 500s, because it can
 *    equally mean a real regression and must not be rendered as "nothing yet".
 * 4. **`no-effect` is a verdict, not a status.** A row whose fix did nothing is
 *    put back to `open` with the attempt kept, so it is counted by BOTH tiles.
 *    That double count is the honest answer and is asserted here.
 * 5. **A short read says so.** The list read is page-capped (LIST_MAX_PAGES), so
 *    if the cap ever bites the tiles are counted over a partial table; the route
 *    must pass `truncated` through rather than under-report in silence.
 *
 * Seam-mocked at @/lib/si-ledger (our own helper, not a raw SDK call), like
 * api/evaluations/route.test.ts. The summarize/latest* helpers are NOT mocked —
 * the real ones run, because the tile arithmetic is what is worth testing.
 */

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  coverage: [] as Array<Record<string, unknown>>,
  truncated: false,
  listError: null as Error | null,
  getError: null as Error | null,
  getCalls: [] as string[],
}));

vi.mock("@/lib/si-ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/si-ledger")>()),
  listLedgerRows: vi.fn(async () => {
    if (h.listError) throw h.listError;
    return { rows: h.rows, coverage: h.coverage, truncated: h.truncated };
  }),
  getLedgerRow: vi.fn(async (patternKey: string) => {
    h.getCalls.push(patternKey);
    if (h.getError) throw h.getError;
    return h.rows.find((r) => r.patternKey === patternKey) ?? null;
  }),
}));

const SILENT_DEATH = "harness.silent-death.exit-without-report";
const PAGING = "ops.paging.out-of-hours";

/** A row mid-lifecycle: seen 3 times, fixed once, and the fix did nothing. */
function noEffectRow() {
  return {
    patternKey: PAGING,
    title: "Operator paged outside working hours",
    // Back to open BECAUSE the verdict was no-effect — this is the contract.
    status: "open",
    firstSeen: "2026-08-01T00:00:00.000Z",
    lastSeen: "2026-09-10T00:00:00.000Z",
    occurrences: [
      { workflowId: "aaa", at: "2026-08-01T00:00:00.000Z", severity: "high" },
      { workflowId: "bbb", at: "2026-09-01T00:00:00.000Z", severity: "high" },
      { workflowId: "ccc", at: "2026-09-10T00:00:00.000Z", severity: "medium" },
    ],
    attempts: [
      { prdKey: "si-0001", workflowId: "ddd", prNumbers: [551], mergedAt: "2026-08-20T00:00:00.000Z", deployedAt: "2026-08-20T06:00:00.000Z", outcome: "deployed" },
    ],
    expected: [{ metric: "out_of_hours_pages", baseline: { value: 4, runs: 10 }, target: 0, observeRuns: 10 }],
    verdicts: [
      { at: "2026-09-05T00:00:00.000Z", verdict: "no-effect", before: { out_of_hours_pages: 4 }, after: { out_of_hours_pages: 4 } },
    ],
  };
}

function verifiedRow() {
  return {
    patternKey: SILENT_DEATH,
    title: "Harness exits without reporting completion",
    status: "verified",
    firstSeen: "2026-07-01T00:00:00.000Z",
    lastSeen: "2026-09-12T00:00:00.000Z",
    occurrences: [{ workflowId: "eee", at: "2026-07-01T00:00:00.000Z" }],
    attempts: [
      { prdKey: "si-0002", workflowId: "fff", prNumbers: [612], mergedAt: "2026-09-01T00:00:00.000Z", outcome: "landed" },
      { prdKey: "si-0002", workflowId: "ggg", prNumbers: [620], mergedAt: "2026-09-08T00:00:00.000Z", deployedAt: "2026-09-08T09:00:00.000Z", outcome: "deployed" },
    ],
    expected: [],
    verdicts: [
      { at: "2026-09-02T00:00:00.000Z", verdict: "insufficient", before: {}, after: {} },
      { at: "2026-09-12T00:00:00.000Z", verdict: "verified", before: { silent_deaths: 6 }, after: { silent_deaths: 0 } },
    ],
  };
}

async function get(url: string) {
  vi.resetModules();
  const { GET } = await import("./route");
  const res = await GET(new NextRequest(new URL(url, "http://localhost:3000")));
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  h.rows = [];
  h.coverage = [];
  h.truncated = false;
  h.listError = null;
  h.getError = null;
  h.getCalls = [];
});

describe("GET /api/evaluations/si-ledger (list)", () => {
  it("is a 200 with zero rows and null coverage on an empty table", async () => {
    const { status, body } = await get("/api/evaluations/si-ledger");
    expect(status).toBe(200);
    expect(body.patterns).toEqual([]);
    expect(body.summary.patterns).toBe(0);
    expect(body.summary.openPatterns).toBe(0);
    // Not 0 — there is no coverage measurement yet, and 0 would read as "we
    // analysed none of them" instead of "we have not measured".
    expect(body.summary.analysisCoverage).toBeNull();
    expect(body.coverage).toEqual([]);
  });

  it("flattens rows to counts plus the newest attempt and verdict", async () => {
    h.rows = [noEffectRow(), verifiedRow()];
    const { status, body } = await get("/api/evaluations/si-ledger");
    expect(status).toBe(200);

    const paging = body.patterns.find((p: { patternKey: string }) => p.patternKey === PAGING);
    expect(paging.occurrences).toBe(3);
    expect(paging.attempts).toBe(1);
    expect(paging.latestVerdict.verdict).toBe("no-effect");
    expect(paging.latestVerdict.before).toEqual({ out_of_hours_pages: 4 });
    expect(paging.latestVerdict.after).toEqual({ out_of_hours_pages: 4 });

    // Newest by `at`, not last in the array: `insufficient` came first.
    const death = body.patterns.find((p: { patternKey: string }) => p.patternKey === SILENT_DEATH);
    expect(death.latestVerdict.verdict).toBe("verified");
    expect(death.latestAttempt.prNumbers).toEqual([620]);
  });

  it("counts a no-effect row in BOTH the open and the no-effect tile", async () => {
    h.rows = [noEffectRow(), verifiedRow()];
    const { body } = await get("/api/evaluations/si-ledger");
    expect(body.summary.patterns).toBe(2);
    expect(body.summary.openPatterns).toBe(1);
    expect(body.summary.noEffectFixes).toBe(1);
    expect(body.summary.verifiedFixes).toBe(1);
    expect(body.summary.occurrences).toBe(4);
  });

  it("surfaces the newest coverage day, not the first or an average", async () => {
    h.rows = [verifiedRow()];
    h.coverage = [
      { day: "2026-09-10", analyses: 2, completedRuns: 8, ratio: 0.25 },
      { day: "2026-09-12", analyses: 7, completedRuns: 8, ratio: 0.875 },
      { day: "2026-09-11", analyses: 4, completedRuns: 8, ratio: 0.5 },
    ];
    const { body } = await get("/api/evaluations/si-ledger");
    expect(body.summary.analysisCoverage).toBe(0.875);
    expect(body.summary.analysisCoverageDay).toBe("2026-09-12");
    expect(body.coverage).toHaveLength(3);
  });

  it("explains a table that does not exist yet — 200, not 500", async () => {
    // The table is created by the operator handoff (docs/MODULES.md), not by CD,
    // so a fresh install legitimately has none. A 500 there reads as "the
    // self-improvement loop is broken"; the truth is "nobody has run the handoff".
    const err = new Error("Requested resource not found");
    err.name = "ResourceNotFoundException";
    h.listError = err;
    const { status, body } = await get("/api/evaluations/si-ledger");
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(body.unavailable.reason).toMatch(/does not exist yet/);
    expect(body.unavailable.reason).toMatch(/create-dynamodb-tables\.sh/);
    expect(body.unavailable.reason).toMatch(/SI_LEDGER_TABLE/);
    // ...and the payload still renders: zeroed tiles, no rows, no coverage.
    expect(body.patterns).toEqual([]);
    expect(body.coverage).toEqual([]);
    expect(body.summary.patterns).toBe(0);
    expect(body.summary.analysisCoverage).toBeNull();
  });

  it("still 500s any OTHER read failure — AccessDenied is not 'nothing yet'", async () => {
    // The IAM half of the same handoff, and every real regression, must stay loud:
    // rendering AccessDenied as an empty ledger would hide a broken deploy.
    const err = new Error("User is not authorized to perform: dynamodb:Scan");
    err.name = "AccessDeniedException";
    h.listError = err;
    const { status, body } = await get("/api/evaluations/si-ledger");
    expect(status).toBe(500);
    expect(body.error).toMatch(/not authorized/);
    expect(body.unavailable).toBeUndefined();
  });

  it("flags a truncated read so the tiles are not silently counted short", async () => {
    h.truncated = true;
    h.rows = [verifiedRow()];
    const { status, body } = await get("/api/evaluations/si-ledger");
    expect(status).toBe(200);
    expect(body.truncated).toBe(true);
  });

  it("omits `truncated` entirely on a complete read", async () => {
    h.rows = [verifiedRow()];
    const { body } = await get("/api/evaluations/si-ledger");
    expect(body.truncated).toBeUndefined();
  });
});

describe("GET /api/evaluations/si-ledger?patternKey=", () => {
  it("returns the full row plus the newest attempt and verdict", async () => {
    h.rows = [noEffectRow()];
    const { status, body } = await get(`/api/evaluations/si-ledger?patternKey=${PAGING}`);
    expect(status).toBe(200);
    expect(body.row.patternKey).toBe(PAGING);
    // The drill-down exists to show the history the list collapses to a count.
    expect(body.row.occurrences).toHaveLength(3);
    expect(body.row.expected[0].metric).toBe("out_of_hours_pages");
    expect(body.latestVerdict.verdict).toBe("no-effect");
    expect(body.latestAttempt.prdKey).toBe("si-0001");
  });

  it("404s an unknown key", async () => {
    h.rows = [verifiedRow()];
    const { status, body } = await get("/api/evaluations/si-ledger?patternKey=nope.not.here");
    expect(status).toBe(404);
    expect(body.error).toMatch(/nope\.not\.here/);
  });

  it("400s a malformed key without touching the table", async () => {
    for (const bad of ["Harness.Silent-Death", "no-dots", "trailing.", "sp ace", "has_underscore.x"]) {
      const { status } = await get(`/api/evaluations/si-ledger?patternKey=${encodeURIComponent(bad)}`);
      expect(status, bad).toBe(400);
    }
    expect(h.getCalls).toEqual([]);
  });

  it("400s a reserved bookkeeping key instead of rendering it as a pattern", async () => {
    const { status } = await get("/api/evaluations/si-ledger?patternKey=%23metrics");
    expect(status).toBe(400);
    expect(h.getCalls).toEqual([]);
  });

  it("explains a missing table here too — not a 500, and not a 404", async () => {
    // A 404 would be a lie of a different kind: it says "this pattern is not
    // tracked" when what happened is that there is nowhere to track it yet.
    const err = new Error("Requested resource not found");
    err.name = "ResourceNotFoundException";
    h.getError = err;
    const { status, body } = await get(`/api/evaluations/si-ledger?patternKey=${PAGING}`);
    expect(status).toBe(200);
    expect(body.row).toBeNull();
    expect(body.unavailable.reason).toMatch(/does not exist yet/);
  });

  it("still 500s any OTHER drill-down failure", async () => {
    const err = new Error("User is not authorized to perform: dynamodb:GetItem");
    err.name = "AccessDeniedException";
    h.getError = err;
    const { status, body } = await get(`/api/evaluations/si-ledger?patternKey=${PAGING}`);
    expect(status).toBe(500);
    expect(body.error).toMatch(/not authorized/);
  });
});

describe("write paths", () => {
  it("exports GET and no mutating handler", async () => {
    vi.resetModules();
    const mod = await import("./route");
    expect(typeof mod.GET).toBe("function");
    for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(verb in mod, `${verb} must not exist on the si-ledger route`).toBe(false);
    }
  });
});
