import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { CardSummary, PerformanceIndex } from "@/lib/workflow/performance";

/**
 * TEAM-4483 — GET /api/workflow/list joins each run's hero KPI headline off
 * performance/index.json.
 *
 * Two properties matter more than the join itself:
 *  - it is ADDITIVE: every field the workflows table already returned is passed
 *    through untouched, so no existing consumer moves;
 *  - it is BEST EFFORT: performance/index.json is a derived artifact, so an
 *    unreadable index degrades the KPI column to null and must never turn the
 *    workflow list — the main screen of the app — into a 500.
 *
 * Mocked at the module seam (the idiom of [id]/tickets/transition/route.test.ts)
 * because both dependencies are our own helpers, not raw SDK calls.
 */

const h = vi.hoisted(() => ({
  state: {
    workflows: [] as Array<Record<string, unknown>>,
    index: { version: 1, updatedAt: null, cards: [], infra: null } as PerformanceIndex,
    indexError: null as Error | null,
    lastListOptions: undefined as { includeArchived?: boolean } | undefined,
  },
}));

vi.mock("@/lib/workflow/dynamo-read", () => ({
  listWorkflowsFromDynamo: vi.fn(async (options?: { includeArchived?: boolean }) => {
    h.state.lastListOptions = options;
    return h.state.workflows;
  }),
}));

vi.mock("@/lib/workflow/performance-index", () => ({
  loadIndex: vi.fn(async () => {
    if (h.state.indexError) throw h.state.indexError;
    return h.state.index;
  }),
}));

const { GET } = await import("./route");

/** A v5 summary, shaped as the cost-report Lambda's index rows are. */
function summary(over: {
  workflowId: string;
  total?: number;
  wall?: number;
  costMissing?: boolean;
  kpi?: CardSummary["kpi"];
}): CardSummary {
  return {
    workflowId: over.workflowId,
    cost: { total: over.total ?? 42.5 },
    time: { wall: over.wall ?? 3_600_000 },
    quality: {},
    agents: {},
    ...(over.costMissing === undefined ? {} : { costMissing: over.costMissing }),
    kpi:
      over.kpi === undefined
        ? { version: 1, quality: { score: 74, grade: "C", confidence: "full" } }
        : over.kpi,
  } as unknown as CardSummary;
}

const get = (query = "") => GET(new NextRequest(`http://localhost/api/workflow/list${query}`));

beforeEach(() => {
  h.state.workflows = [];
  h.state.index = { version: 1, updatedAt: null, cards: [], infra: null };
  h.state.indexError = null;
  h.state.lastListOptions = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/workflow/list — hero KPI join", () => {
  it("joins the KPI headline for a run that has one", async () => {
    h.state.workflows = [{ workflowId: "wf_1", phase: "complete", startedAt: "2026-09-01T00:00:00Z" }];
    h.state.index.cards = [summary({ workflowId: "wf_1" })];

    const res = await get();
    expect(res.status).toBe(200);
    const { workflows } = await res.json();
    expect(workflows).toHaveLength(1);
    expect(workflows[0].kpi).toEqual({
      version: 1,
      // cost.usd off summary.cost.total, time.wallMs off summary.time.wall —
      // the index uses the short names, the API uses the unit-suffixed ones.
      cost: { usd: 42.5 },
      time: { wallMs: 3_600_000 },
      quality: { score: 74, grade: "C", confidence: "full" },
    });
  });

  it("passes every pre-existing field through untouched", async () => {
    const row = {
      workflowId: "wf_1",
      phase: "complete",
      startedAt: "2026-09-01T00:00:00Z",
      epicId: "TEAM-4477",
      workflowDefId: "software-delivery",
      title: "Hero KPIs",
      archived: false,
    };
    h.state.workflows = [row];
    h.state.index.cards = [summary({ workflowId: "wf_1" })];

    const { workflows } = await (await get()).json();
    expect(workflows[0]).toMatchObject(row);
    // `kpi` is the only key the join adds.
    expect(Object.keys(workflows[0]).sort()).toEqual([...Object.keys(row), "kpi"].sort());
  });

  it("kpi is null for a run with no card, and for a card with no kpi block", async () => {
    h.state.workflows = [{ workflowId: "wf_1" }, { workflowId: "wf_2" }, { workflowId: "wf_3" }];
    h.state.index.cards = [
      summary({ workflowId: "wf_1" }),
      summary({ workflowId: "wf_2", kpi: null }),
      // wf_3 has no summary at all.
    ];

    const { workflows } = await (await get()).json();
    expect(workflows[0].kpi).not.toBeNull();
    expect(workflows[1].kpi).toBeNull();
    expect(workflows[2].kpi).toBeNull();
  });

  it("reports unknown cost as null, never as 0 — costMissing and a $0 total alike", async () => {
    h.state.workflows = [{ workflowId: "wf_missing" }, { workflowId: "wf_zero" }, { workflowId: "wf_priced" }];
    h.state.index.cards = [
      summary({ workflowId: "wf_missing", total: 42.5, costMissing: true }),
      summary({ workflowId: "wf_zero", total: 0 }),
      summary({ workflowId: "wf_priced", total: 0.01 }),
    ];

    const { workflows } = await (await get()).json();
    expect(workflows[0].kpi.cost.usd).toBeNull();
    expect(workflows[1].kpi.cost.usd).toBeNull();
    expect(workflows[2].kpi.cost.usd).toBe(0.01);
  });

  it("forwards an unscored run as score/grade null with its confidence intact", async () => {
    h.state.workflows = [{ workflowId: "wf_1" }];
    h.state.index.cards = [
      summary({
        workflowId: "wf_1",
        kpi: { version: 1, quality: { score: null, grade: null, confidence: "insufficient" } },
      }),
    ];

    const { workflows } = await (await get()).json();
    expect(workflows[0].kpi).toEqual({
      version: 1,
      cost: { usd: 42.5 },
      time: { wallMs: 3_600_000 },
      quality: { score: null, grade: null, confidence: "insufficient" },
    });
  });

  it("reports a missing wall clock as null", async () => {
    h.state.workflows = [{ workflowId: "wf_1" }];
    const s = summary({ workflowId: "wf_1" });
    (s as { time?: unknown }).time = {};
    h.state.index.cards = [s];

    const { workflows } = await (await get()).json();
    expect(workflows[0].kpi.time.wallMs).toBeNull();
  });
});

describe("GET /api/workflow/list — the index is never allowed to break the list", () => {
  it("still 200s with kpi:null on every row when loadIndex throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.state.workflows = [{ workflowId: "wf_1", phase: "complete" }, { workflowId: "wf_2", phase: "error" }];
    h.state.indexError = new Error("AccessDenied: arn:aws:sts::123456789012:assumed-role/x");

    const res = await get();
    expect(res.status).toBe(200);
    const { workflows } = await res.json();
    expect(workflows).toHaveLength(2);
    expect(workflows.map((w: { kpi: unknown }) => w.kpi)).toEqual([null, null]);
    expect(workflows[0].phase).toBe("complete");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("tolerates an index with no cards array", async () => {
    h.state.workflows = [{ workflowId: "wf_1" }];
    h.state.index = { version: 1, updatedAt: null, infra: null } as unknown as PerformanceIndex;
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).workflows[0].kpi).toBeNull();
  });

  it("still forwards includeArchived and still 500s when the table read fails", async () => {
    await get("?includeArchived=1");
    expect(h.state.lastListOptions).toEqual({ includeArchived: true });
    await get();
    expect(h.state.lastListOptions).toEqual({ includeArchived: false });

    vi.spyOn(console, "error").mockImplementation(() => {});
    const dynamo = await import("@/lib/workflow/dynamo-read");
    vi.mocked(dynamo.listWorkflowsFromDynamo).mockRejectedValueOnce(new Error("boom"));
    const res = await get();
    expect(res.status).toBe(500);
    expect((await res.json()).workflows).toEqual([]);
  });
});
