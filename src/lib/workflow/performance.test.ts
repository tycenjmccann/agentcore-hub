import { describe, it, expect } from "vitest";
import {
  bandFor, buildFleetView, median, mad, formatKpi, type CardSummary, type PerformanceIndex,
  computeKpi, readKpi, hasCostData, isValidCard, round4,
  CURRENT_REPORT_VERSION, FLEET_KPIS, KPI_CONFIG,
  type KpiCap, type PerformanceCardInput,
} from "./performance";
// The rubric fixture is OWNED BY THE LAMBDA SIDE (TEAM-4484) precisely so both
// scorers are pinned by the same bytes. Importing it across the boundary is the
// house pattern for parity tests — see completion-evidence-parity.test.ts.
import KPI_FIXTURE from "../../../lambda/cost-report/fixtures/kpi-cases.json";

// ─── kpi-cases.json fixture typing ────────────────────────────────────────────
// The JSON's inferred type is a union across 17 dissimilar cases, so it is cast
// once here through a hand-written shape. No `any`, and production types stay strict.

interface ExpectedComponent { key: string; points: number | null; included?: boolean; normalized?: number }
interface ExpectedKpi {
  score: number | null;
  grade: string | null;
  confidence: string;
  evidenceWeight: number;
  excluded: string[];
  capsApplied: KpiCap[];
  costUsd: number | null;
  components: ExpectedComponent[];
}
interface FixtureCase {
  name: string;
  kind: "compute" | "tolerate";
  derivation?: string;
  card: PerformanceCardInput;
  expected?: ExpectedKpi;
}
interface FixtureFile { reportVersion: number; kpiVersion: number; cases: FixtureCase[] }

const FIXTURE = KPI_FIXTURE as unknown as FixtureFile;
const COMPUTE_CASES = FIXTURE.cases.filter((c) => c.kind === "compute");
const TOLERATE_CASES = FIXTURE.cases.filter((c) => c.kind === "tolerate");

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
      // zero-cost card = the cost spans didn't match. Since TEAM-4483 (FR-4.2) it
      // is still a REAL run: it counts in runs/totals/time/quality, and is left
      // out only of the cost KPIs and the money totals.
      card({ completedAt: day(1), total: 0, workflowId: "z" }),
    ],
  };

  it("splits current vs prior windows and flags a cost spike", () => {
    const v = buildFleetView(index, { days: 7, workflowDefId: "software-delivery", now });
    // `a` and `z` share day(1); sort is stable, so the fixture order breaks the tie.
    expect(v.runs.map((r) => r.workflowId)).toEqual(["a", "z", "b", "c"]);
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
    expect(v.runs).toHaveLength(5); // a, b, c, d + the $0 card z
    expect(v.agents[0].agentId).toBe("dev");
    expect(v.agents[0].runs).toBe(5); // z's agent worked, even though we can't price it
    // …but z contributes no money: engines still sum only the priced runs.
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
});

// ─── Deterministic quality score ──────────────────────────────────────────────

describe("computeKpi — kpi-cases.json parity", () => {
  it("runs the whole fixture (a shrinking fixture must fail loudly)", () => {
    expect(COMPUTE_CASES).toHaveLength(16);
    expect(TOLERATE_CASES.length).toBeGreaterThan(0);
  });

  it.each(COMPUTE_CASES.map((c) => [c.name, c] as [string, FixtureCase]))("%s", (_name, c) => {
    const e = c.expected!;
    const kpi = computeKpi(c.card);

    expect(kpi.quality.score).toBe(e.score);
    expect(kpi.quality.grade).toBe(e.grade);
    expect(kpi.quality.confidence).toBe(e.confidence);
    expect(kpi.quality.evidenceWeight).toBe(e.evidenceWeight);
    expect(kpi.quality.excluded).toEqual(e.excluded);
    expect(kpi.quality.capsApplied).toEqual(e.capsApplied);
    expect(kpi.cost.usd).toBe(e.costUsd);
    expect(kpi.version).toBe(FIXTURE.kpiVersion);
    // PURE: computedAt is the card's own generatedAt, never a clock read — so
    // rescoring the same card twice is byte-identical.
    expect(kpi.computedAt).toBe(c.card.generatedAt);
    expect(kpi.quality.outcome).toBe(c.card.run?.outcome);

    // Components come back in rubric order, with points at 4 dp.
    expect(kpi.quality.components.map((x) => x.key)).toEqual(e.components.map((x) => x.key));
    for (const exp of e.components) {
      const got = kpi.quality.components.find((x) => x.key === exp.key)!;
      if (exp.points === null) {
        expect(got.points).toBeNull();
        expect(got.included).toBe(false);
        expect(got.note).toBeTruthy(); // an exclusion always says why
        expect(kpi.quality.excluded).toContain(exp.key);
      } else {
        expect(got.included).toBe(true);
        expect(got.points).toBeCloseTo(exp.points, 4);
        expect(got.points).toBe(round4(got.points as number));
      }
      if (exp.included !== undefined) expect(got.included).toBe(exp.included);
      // The unclamped normalized value is part of the contract (clamp-loops-12
      // reports -0.5 while scoring 0), so pin it wherever the fixture states it.
      if (exp.normalized !== undefined) expect(got.normalized).toBeCloseTo(exp.normalized, 10);
    }
  });

  it("echoes the card's time axis and leaves the bands for the fleet pass", () => {
    const kpi = computeKpi(COMPUTE_CASES[0].card);
    expect(kpi.time.wallMs).toBe(3_600_000);
    expect(kpi.time.activeMs).toBe(3_000_000);
    expect(kpi.time.humanWaitMs).toBe(600_000);
    expect(kpi.cost.band).toBe("unknown");
    expect(kpi.time.band).toBe("unknown");
    expect(kpi.quality.band).toBe("unknown");
    expect(kpi.quality.z).toBeNull();
  });

  it("is total: an empty card scores insufficient instead of throwing", () => {
    const kpi = computeKpi({});
    expect(kpi.quality.score).toBeNull();
    expect(kpi.quality.grade).toBeNull();
    expect(kpi.quality.confidence).toBe("insufficient");
    expect(kpi.quality.evidenceWeight).toBe(0);
    expect(kpi.quality.outcome).toBe("unknown");
    expect(kpi.cost.usd).toBeNull();
    expect(kpi.computedAt).toBeNull();
  });
});

describe("kpi rubric contract", () => {
  it("pins the versions the fixture was hand-derived against", () => {
    expect(CURRENT_REPORT_VERSION).toBe(FIXTURE.reportVersion);
    expect(KPI_CONFIG.kpiVersion).toBe(FIXTURE.kpiVersion);
  });

  it("component weights sum to 100, so evidenceWeight 100 means full evidence", () => {
    expect(KPI_CONFIG.quality.components.reduce((s, c) => s + c.weight, 0)).toBe(100);
  });

  it("grades descend to a zero floor, so every score in 0..100 grades", () => {
    const mins = KPI_CONFIG.grades.map((g) => g.min);
    expect([...mins].sort((a, b) => b - a)).toEqual(mins);
    expect(mins[mins.length - 1]).toBe(0);
  });

  it("minEvidenceWeight is a real bar (>0) and reachable (<=100)", () => {
    expect(KPI_CONFIG.quality.minEvidenceWeight).toBeGreaterThan(0);
    expect(KPI_CONFIG.quality.minEvidenceWeight).toBeLessThanOrEqual(100);
  });
});

describe("FLEET_KPIS quality.score", () => {
  // The Lambda's BAND_KPIS row for this path, as DATA. lambda/cost-report/index.mjs
  // builds AWS SDK clients at module scope, so it cannot be imported into vitest —
  // this literal is the mirror the two sides are reviewed against.
  const LAMBDA_BAND_KPI = { path: "quality.score", label: "Quality score", unit: "count", floor: 5, direction: "lower" };

  it("bands lower-is-worse with the same floor the Lambda uses", () => {
    const k = FLEET_KPIS.find((x) => x.key === LAMBDA_BAND_KPI.path);
    expect(k).toBeDefined();
    expect(k!.floor).toBe(LAMBDA_BAND_KPI.floor);
    expect(k!.direction).toBe(LAMBDA_BAND_KPI.direction);
    expect(k!.label).toBe(LAMBDA_BAND_KPI.label);
    expect(k!.unit).toBe(LAMBDA_BAND_KPI.unit);
    expect(k!.group).toBe("quality");
  });

  it("KPI keys stay unique", () => {
    expect(new Set(FLEET_KPIS.map((k) => k.key)).size).toBe(FLEET_KPIS.length);
  });
});

describe("readKpi", () => {
  it.each(TOLERATE_CASES.map((c) => [c.name, c] as [string, FixtureCase]))("%s → null, no throw", (_name, c) => {
    expect(readKpi(c.card)).toBeNull();
    // A pre-v5 card must also still SCORE rather than blow up.
    expect(() => computeKpi(c.card)).not.toThrow();
  });

  it("null / undefined / unversioned blocks all read as not-scored", () => {
    expect(readKpi(null)).toBeNull();
    expect(readKpi(undefined)).toBeNull();
    expect(readKpi({})).toBeNull();
    expect(readKpi({ kpi: null })).toBeNull();
    expect(readKpi({ kpi: "1" })).toBeNull();
    expect(readKpi({ kpi: {} })).toBeNull();
    expect(readKpi({ kpi: { version: "1" } })).toBeNull();
    expect(readKpi({ kpi: { version: NaN } })).toBeNull();
  });

  it("returns the stored block once it carries a numeric version", () => {
    const stored = computeKpi(COMPUTE_CASES[0].card);
    expect(readKpi({ kpi: stored })).toBe(stored);
  });
});

describe("$0 runs (FR-4.2)", () => {
  const now = new Date("2026-09-04T00:00:00Z");
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  const opts = { days: 7, workflowDefId: "software-delivery", now };

  const baselineCards = [8, 9, 10, 11, 12, 13].map((d) => card({ completedAt: day(d), total: 100 }));
  const pricedCurrent = [
    card({ completedAt: day(1), total: 100, workflowId: "a" }),
    card({ completedAt: day(2), total: 100, workflowId: "b" }),
  ];
  const priced: PerformanceIndex = { version: 1, updatedAt: null, infra: null, cards: [...baselineCards, ...pricedCurrent] };
  const withZero: PerformanceIndex = {
    ...priced,
    cards: [...priced.cards, card({ completedAt: day(3), total: 0, workflowId: "z" })],
  };

  it("a run is valid once it has completedAt; cost data is a separate gate", () => {
    expect(isValidCard(card({ completedAt: day(1), total: 0 }))).toBe(true);
    expect(isValidCard(card({ completedAt: day(1), total: 100 }))).toBe(true);
    expect(isValidCard({ ...card({ completedAt: day(1) }), completedAt: "" })).toBe(false);
    expect(hasCostData(card({ completedAt: day(1), total: 0 }))).toBe(false);
    expect(hasCostData(card({ completedAt: day(1), total: 0.0001 }))).toBe(true);
  });

  it("an unpriced run raises run/quality counts and leaves money untouched", () => {
    const a = buildFleetView(priced, opts);
    const b = buildFleetView(withZero, opts);
    const n = (v: typeof a, key: string) => v.kpis.find((k) => k.key === key)!.current?.n ?? 0;

    // Counted as a run, and in every non-money rollup.
    expect(b.totals.runs).toBe(a.totals.runs + 1);
    expect(b.runs.map((r) => r.workflowId)).toContain("z");
    expect(n(b, "quality.tasks")).toBe(n(a, "quality.tasks") + 1);
    expect(b.totals.loops).toBe(a.totals.loops + 1);
    expect(b.totals.agentWorkMs).toBeGreaterThan(a.totals.agentWorkMs);

    // Invisible to money: totals, engines and the cost KPI's sample size.
    expect(b.totals.cost).toBeCloseTo(a.totals.cost);
    expect(b.totals.tokens).toBe(a.totals.tokens);
    expect(b.engines.persona).toBeCloseTo(a.engines.persona);
    expect(n(b, "cost.total")).toBe(n(a, "cost.total"));
    expect(b.kpis.find((k) => k.key === "cost.total")!.current?.median)
      .toBe(a.kpis.find((k) => k.key === "cost.total")!.current?.median);

    // Agent rollup: same split — work from every run, usd only from priced ones.
    const [devA, devB] = [a.agents[0], b.agents[0]];
    expect(devB.runs).toBe(devA.runs + 1);
    expect(devB.workMs).toBeGreaterThan(devA.workMs);
    expect(devB.usd).toBeCloseTo(devA.usd);
  });

  it("a fully priced window is unchanged — cost KPIs still see every run", () => {
    const v = buildFleetView(priced, opts);
    expect(v.totals.runs).toBe(2);
    expect(v.kpis.find((k) => k.key === "cost.total")!.current?.n).toBe(v.totals.runs);
    expect(v.totals.cost).toBeCloseTo(200);
    expect(v.engines.persona).toBeCloseTo(200 * 0.9);
    expect(v.agents[0].runs).toBe(2);
  });
});

describe("pre-v5 summaries in the fleet view", () => {
  const now = new Date("2026-09-04T00:00:00Z");
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  const opts = { days: 7, workflowDefId: "software-delivery", now };

  it("aggregate without throwing and leave quality.score unscored", () => {
    // The base factory emits exactly a pre-v5 summary: no `kpi`, no
    // `quality.score`, no `costMissing`.
    const cards = [8, 9, 10, 11, 12, 13, 1, 2, 3].map((d) => card({ completedAt: day(d), total: 100 }));
    const v = buildFleetView({ version: 1, updatedAt: null, infra: null, cards }, opts);
    const q = v.kpis.find((k) => k.key === "quality.score")!;
    expect(q.current).toBeNull();
    expect(q.series).toHaveLength(0);
    expect(["insufficient", "unknown"]).toContain(q.status);
    for (const [key, value] of Object.entries(v.totals)) {
      expect(Number.isNaN(value), key).toBe(false);
    }
  });

  it("a v5 summary carrying a score feeds the quality.score KPI", () => {
    const scored = (d: number, score: number, workflowId: string) => {
      const c = card({ completedAt: day(d), total: 100, workflowId });
      return { ...c, quality: { ...c.quality, score }, kpi: { version: 1, quality: { score, grade: "B", confidence: "full" } } };
    };
    const cards = [scored(1, 80, "a"), scored(2, 90, "b"), scored(3, 70, "c")];
    const v = buildFleetView({ version: 1, updatedAt: null, infra: null, cards }, opts);
    const q = v.kpis.find((k) => k.key === "quality.score")!;
    expect(q.current?.n).toBe(3);
    expect(q.current?.median).toBe(80);
    expect(q.series.map((p) => p.v)).toEqual([70, 90, 80]); // oldest first
  });
});

describe("computeKpi monotonicity", () => {
  interface Q {
    tasks: number; reworkRounds: number; loops: number; errors: number;
    nudges: number; interventions: number; gateRounds: number;
    firstPassYield: number; ci: { verdict: string };
  }
  const mk = (q: Q, outcome = "complete"): PerformanceCardInput => ({
    reportVersion: CURRENT_REPORT_VERSION,
    generatedAt: "2026-09-11T00:00:00.000Z",
    run: { outcome },
    cost: { totalUsd: 10 },
    time: { wallMs: 3_600_000, activeMs: 3_000_000, humanWaitMs: 600_000, humanGates: 2 },
    quality: { ...q },
    dataQuality: { costMissing: false },
  });

  // Each perturbation makes the run objectively worse without changing which
  // components have evidence, so the score may only fall or hold.
  const PERTURB: Array<[string, (q: Q) => Q]> = [
    ["loops+1", (q) => ({ ...q, loops: q.loops + 1 })],
    ["reworkRounds+1", (q) => ({ ...q, reworkRounds: q.reworkRounds + 1 })],
    ["errors+1", (q) => ({ ...q, errors: q.errors + 1 })],
    ["gateRounds+1", (q) => ({ ...q, gateRounds: q.gateRounds + 1 })],
    ["ci pass→fail", (q) => ({ ...q, ci: { verdict: "fail" } })],
    ["firstPassYield down", (q) => ({ ...q, firstPassYield: round4(q.firstPassYield / 2) })],
  ];

  for (const tasks of [1, 5, 18]) {
    for (const loops of [0, 3, 8, 12]) {
      for (const errors of [0, 2, 6]) {
        it(`tasks=${tasks} loops=${loops} errors=${errors}`, () => {
          const q: Q = {
            tasks, reworkRounds: 1, loops, errors,
            nudges: 0, interventions: 0, gateRounds: 2,
            firstPassYield: 0.8, ci: { verdict: "pass" },
          };
          const before = computeKpi(mk(q));
          expect(before.quality.score).not.toBeNull();
          expect(before.quality.evidenceWeight).toBe(100);

          const violations: string[] = [];
          for (const [name, worsen] of PERTURB) {
            const after = computeKpi(mk(worsen(q)));
            if (after.quality.evidenceWeight !== before.quality.evidenceWeight) {
              violations.push(`${name}: inclusion set changed`);
              continue;
            }
            if (!((after.quality.score as number) <= (before.quality.score as number))) {
              violations.push(`${name}: ${after.quality.score} > ${before.quality.score}`);
            }
          }
          // An outcome cap is the seventh direction: it can only lower.
          const capped = computeKpi(mk(q, "deploy-blocked"));
          if (!((capped.quality.score as number) <= (before.quality.score as number))) {
            violations.push(`outcome cap: ${capped.quality.score} > ${before.quality.score}`);
          }
          expect(violations).toEqual([]);
        });
      }
    }
  }
});
