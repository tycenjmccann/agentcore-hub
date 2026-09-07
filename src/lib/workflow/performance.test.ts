import { describe, it, expect } from "vitest";
import {
  bandFor, buildFleetView, median, mad, formatKpi, FLEET_KPIS, type CardSummary, type PerformanceIndex,
} from "./performance";

function card(over: Partial<CardSummary> & { completedAt: string; total?: number }): CardSummary {
  const { total: totalOpt, ...rest } = over;
  const total = totalOpt ?? 100;
  const base: CardSummary = {
    workflowId: `wf_${over.completedAt}`,
    epicId: "TEAM-1", workflowDefId: "software-delivery", title: "t", outcome: "complete",
    startedAt: null, completedAt: over.completedAt, prUrl: null,
    cost: { total, persona: total * 0.9, coding: total * 0.1, tokens: total * 1e5, tokensIn: 0, tokensOut: 0, cached: 0, byEngine: { persona: total * 0.9, claude_code: total * 0.1 } },
    time: { wall: 3_600_000, active: 3_000_000, agentWork: 1_800_000, humanWait: 600_000, idle: 1_200_000, utilization: 0.6 },
    quality: { tasks: 8, reworkRounds: 1, changeRequests: 1, fixTickets: 0, loops: 1, nudges: 0, errors: 0, gateRounds: 2, firstPassYield: 0.9, humanGates: 2 },
    agents: { dev: { usd: total * 0.5, workMs: 900_000, tasks: 4, reworkRounds: 1 } },
    status: "ok", anomalies: [], gaps: 0,
  };
  return { ...base, ...rest };
}

describe("robust stats", () => {
  it("median handles odd/even", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
  it("mad is zero for a flat series", () => {
    expect(mad([5, 5, 5, 5, 5])).toBe(0);
  });
  it("bandFor floors sigma and classifies z", () => {
    const flat = [100, 100, 100, 100, 100];
    const b = bandFor(flat, 130, 5)!;
    // sigma = max(0, 10, 5) = 10 → z = 3 → alert
    expect(b.sigma).toBe(10);
    expect(b.status).toBe("alert");
    expect(bandFor(flat, 125, 5)!.status).toBe("warn");
    expect(bandFor(flat, 110, 5)!.status).toBe("ok");
  });
  it("bandFor flips the sign for lower-is-worse KPIs", () => {
    const flat = [0.9, 0.9, 0.9, 0.9, 0.9];
    // sigma = max(0, 0.09, 0.1) = 0.1 → 0.6 is z=3 → alert; 1.0 is better → ok
    expect(bandFor(flat, 0.6, 0.1, "lower")!.status).toBe("alert");
    expect(bandFor(flat, 1.0, 0.1, "lower")!.status).toBe("ok");
    expect(bandFor(flat, 0.6, 0.1, "lower")!.warnAbove).toBeCloseTo(0.7);
  });
  it("bandFor needs the minimum baseline", () => {
    expect(bandFor([1, 2, 3], 5, 1)).toBeNull();
  });
});

describe("buildFleetView", () => {
  const now = new Date("2026-09-04T00:00:00Z");
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  const index: PerformanceIndex = {
    version: 1, updatedAt: now.toISOString(), infra: { updatedAt: now.toISOString(), coreTotal: 900, runsInWindow: 30, perRunCoreUsd: 30, perRunRuntimeUsd: 15 },
    cards: [
      // baseline / prior week: cheap runs
      ...[8, 9, 10, 11, 12, 13].map((d) => card({ completedAt: day(d), total: 100 })),
      // current week: one normal, two expensive
      card({ completedAt: day(1), total: 110, workflowId: "a" }),
      card({ completedAt: day(2), total: 400, workflowId: "b" }),
      card({ completedAt: day(3), total: 420, workflowId: "c" }),
      // other def, current week — excluded when scoped
      card({ completedAt: day(1), total: 50, workflowDefId: "bug-fix", workflowId: "d" }),
      // zero-cost card = span gap, never counted
      card({ completedAt: day(1), total: 0, workflowId: "z" }),
    ],
  };

  it("splits current vs prior windows and flags a cost spike", () => {
    const v = buildFleetView(index, { days: 7, workflowDefId: "software-delivery", now });
    expect(v.runs.map((r) => r.workflowId)).toEqual(["a", "b", "c"]);
    expect(v.priorRuns).toBe(6);
    const cost = v.kpis.find((k) => k.key === "cost.total")!;
    expect(cost.current?.median).toBe(400);
    expect(cost.prior?.median).toBe(100);
    expect(cost.deltaPct).toBe(3);
    expect(cost.status).toBe("alert");
    expect(v.status).toBe("alert");
    expect(v.anomalies.map((a) => a.kpi)).toContain("cost.total");
  });

  it("aggregates agents and engines over the current window", () => {
    const v = buildFleetView(index, { days: 7, workflowDefId: "all", now });
    expect(v.runs).toHaveLength(4);
    expect(v.agents[0].agentId).toBe("dev");
    expect(v.agents[0].runs).toBe(4);
    expect(v.engines.persona).toBeCloseTo((110 + 400 + 420 + 50) * 0.9);
    expect(v.defIds).toEqual(["bug-fix", "software-delivery"]);
    expect(v.infraPerRun).toEqual({ core: 30, runtime: 15 });
  });

  it("reports insufficient when the baseline is thin", () => {
    const thin: PerformanceIndex = { ...index, cards: index.cards.slice(-5) };
    const v = buildFleetView(thin, { days: 7, workflowDefId: "software-delivery", now });
    expect(v.kpis.find((k) => k.key === "cost.total")!.status).toBe("insufficient");
  });
});

describe("cache-aware cost metrics", () => {
  const now = new Date("2026-09-04T00:00:00Z");
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

  // A card carrying the optional cache fields on cost. Merges into the base
  // card factory so the rest of the shape stays valid.
  function cacheCard(over: Partial<CardSummary> & { completedAt: string; total?: number }, cache: { cacheRead?: number; cacheWrite?: number; personaCacheHitRate?: number; cacheHitRate?: number }): CardSummary {
    const c = card(over);
    return { ...c, cost: { ...c.cost, ...cache } };
  }

  it("bands cost.personaCacheHitRate as lower-is-worse through buildFleetView", () => {
    const baseHitRate = 0.6;
    const index: PerformanceIndex = {
      version: 1, updatedAt: now.toISOString(), infra: null,
      cards: [
        // baseline / prior week: healthy persona cache hit rate
        ...[8, 9, 10, 11, 12, 13].map((d) => cacheCard({ completedAt: day(d), total: 100 }, { personaCacheHitRate: baseHitRate })),
        // current week: hit rate collapsed → lower is worse
        cacheCard({ completedAt: day(1), total: 100, workflowId: "a" }, { personaCacheHitRate: 0.2 }),
        cacheCard({ completedAt: day(2), total: 100, workflowId: "b" }, { personaCacheHitRate: 0.2 }),
        cacheCard({ completedAt: day(3), total: 100, workflowId: "c" }, { personaCacheHitRate: 0.2 }),
      ],
    };
    const v = buildFleetView(index, { days: 7, workflowDefId: "software-delivery", now });
    const hr = v.kpis.find((k) => k.key === "cost.personaCacheHitRate")!;
    expect(hr.direction).toBe("lower");
    // baseline flat at 0.6, sigma floored at 0.1 → current median 0.2 is z=4 → alert
    expect(hr.current?.median).toBe(0.2);
    expect(hr.status).toBe("alert");
    expect(v.anomalies.map((a) => a.kpi)).toContain("cost.personaCacheHitRate");
  });

  it("does not flag a HIGHER persona cache hit rate", () => {
    const index: PerformanceIndex = {
      version: 1, updatedAt: now.toISOString(), infra: null,
      cards: [
        ...[8, 9, 10, 11, 12, 13].map((d) => cacheCard({ completedAt: day(d), total: 100 }, { personaCacheHitRate: 0.6 })),
        cacheCard({ completedAt: day(1), total: 100, workflowId: "a" }, { personaCacheHitRate: 0.9 }),
        cacheCard({ completedAt: day(2), total: 100, workflowId: "b" }, { personaCacheHitRate: 0.95 }),
        cacheCard({ completedAt: day(3), total: 100, workflowId: "c" }, { personaCacheHitRate: 0.9 }),
      ],
    };
    const v = buildFleetView(index, { days: 7, workflowDefId: "software-delivery", now });
    const hr = v.kpis.find((k) => k.key === "cost.personaCacheHitRate")!;
    expect(hr.status).toBe("ok");
    expect(v.anomalies.map((a) => a.kpi)).not.toContain("cost.personaCacheHitRate");
  });

  it("accumulates cacheRead / cacheWrite across runs in the window", () => {
    const index: PerformanceIndex = {
      version: 1, updatedAt: now.toISOString(), infra: null,
      cards: [
        cacheCard({ completedAt: day(1), total: 100, workflowId: "a" }, { cacheRead: 1000, cacheWrite: 200 }),
        cacheCard({ completedAt: day(2), total: 100, workflowId: "b" }, { cacheRead: 500, cacheWrite: 50 }),
      ],
    };
    const v = buildFleetView(index, { days: 7, workflowDefId: "software-delivery", now });
    expect(v.totals.cacheRead).toBe(1500);
    expect(v.totals.cacheWrite).toBe(250);
  });

  it("back-compat: cards without cache fields pass through with no NaN", () => {
    // Plain cards from the base factory — none carry cacheRead/cacheWrite/personaCacheHitRate.
    const index: PerformanceIndex = {
      version: 1, updatedAt: now.toISOString(), infra: null,
      cards: [8, 9, 10, 11, 12, 13, 1, 2, 3].map((d) => card({ completedAt: day(d), total: 100 })),
    };
    const v = buildFleetView(index, { days: 7, workflowDefId: "software-delivery", now });
    // Missing fields treated as 0, never NaN.
    expect(v.totals.cacheRead).toBe(0);
    expect(v.totals.cacheWrite).toBe(0);
    expect(Number.isNaN(v.totals.cacheRead)).toBe(false);
    // KPI series just omits the absent metric — no stats, status insufficient/unknown, no throw.
    const hr = v.kpis.find((k) => k.key === "cost.personaCacheHitRate")!;
    expect(hr.current).toBeNull();
    expect(hr.series).toHaveLength(0);
    expect(["insufficient", "unknown"]).toContain(hr.status);
  });
});

describe("formatKpi", () => {
  it("formats units", () => {
    expect(formatKpi("usd", 1234)).toBe("$1.2k");
    expect(formatKpi("usd", 148.4)).toBe("$148");
    expect(formatKpi("ms", 5 * 3_600_000 + 12 * 60_000)).toBe("5h 12m");
    expect(formatKpi("ms", 3 * 86_400_000)).toBe("3d 0h");
    expect(formatKpi("tokens", 12_800_000)).toBe("12.8M");
    expect(formatKpi("count", null)).toBe("—");
  });

  it("clamps a ratio to [0,1] on display (legacy unclamped utilization)", () => {
    // A pre-fix cost-report stored busy/active without clamping — 981.51 must
    // read as a sane 100%, not "98151%". Negatives floor to 0%.
    expect(formatKpi("ratio", 981.51)).toBe("100%");
    expect(formatKpi("ratio", 1)).toBe("100%");
    expect(formatKpi("ratio", -0.5)).toBe("0%");
    expect(formatKpi("ratio", 0.6)).toBe("60%");
  });
});

describe("time.utilization KPI (D3a)", () => {
  const now = new Date("2026-09-04T00:00:00Z");
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  const utilCard = (over: Partial<CardSummary> & { completedAt: string; total?: number }, util: number): CardSummary => {
    const c = card(over);
    return { ...c, time: { ...c.time, utilization: util } };
  };

  it("is a banded, lower-is-worse fleet KPI in the time group", () => {
    const k = FLEET_KPIS.find((x) => x.key === "time.utilization");
    expect(k).toBeDefined();
    expect(k!.direction).toBe("lower");
    expect(k!.group).toBe("time");
    expect(k!.unit).toBe("ratio");

    const index: PerformanceIndex = {
      version: 1, updatedAt: now.toISOString(), infra: null,
      cards: [
        ...[8, 9, 10, 11, 12, 13].map((d) => utilCard({ completedAt: day(d), total: 100 }, 0.6)),
        utilCard({ completedAt: day(1), total: 100, workflowId: "a" }, 0.3),
        utilCard({ completedAt: day(2), total: 100, workflowId: "b" }, 0.3),
        utilCard({ completedAt: day(3), total: 100, workflowId: "c" }, 0.3),
      ],
    };
    const v = buildFleetView(index, { days: 7, workflowDefId: "software-delivery", now });
    const u = v.kpis.find((x) => x.key === "time.utilization")!;
    expect(u.band).not.toBeNull();
    expect(u.current?.median).toBe(0.3);
  });
});
