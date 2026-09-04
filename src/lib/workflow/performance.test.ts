import { describe, it, expect } from "vitest";
import {
  bandFor, buildFleetView, median, mad, formatKpi, type CardSummary, type PerformanceIndex,
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

describe("formatKpi", () => {
  it("formats units", () => {
    expect(formatKpi("usd", 1234)).toBe("$1.2k");
    expect(formatKpi("usd", 148.4)).toBe("$148");
    expect(formatKpi("ms", 5 * 3_600_000 + 12 * 60_000)).toBe("5h 12m");
    expect(formatKpi("ms", 3 * 86_400_000)).toBe("3d 0h");
    expect(formatKpi("tokens", 12_800_000)).toBe("12.8M");
    expect(formatKpi("count", null)).toBe("—");
  });
});
