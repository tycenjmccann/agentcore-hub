import { describe, it, expect } from "vitest";
import { windowDays, modelCost, summarizeDaily, bucketFromDailyItem, groupDailyItems, type Pricing } from "./eval-metrics";

const pricing: Pricing = {
  models: { "us.anthropic.claude-fable-5-1": { input: 20, output: 100 }, "claude-opus-4-8": { input: 5.5, output: 27.5 } },
  default: { input: 5.5, output: 27.5 },
  cachedInputDiscount: 0.1,
  cacheWriteMultiplier: { "5m": 1.25, "1h": 2.0, default: 1.25, _basis: "x" },
};

describe("windowDays", () => {
  it("returns today and the previous days-1 UTC days, ascending", () => {
    const now = new Date("2026-09-07T18:30:00Z");
    expect(windowDays(7, now)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07"]);
    expect(windowDays(1, now)).toEqual(["2026-09-07"]);
  });
  it("crosses month boundaries and clamps to the retention max", () => {
    expect(windowDays(3, new Date("2026-09-01T00:10:00Z"))).toEqual(["2026-08-30", "2026-08-31", "2026-09-01"]);
    expect(windowDays(99, new Date("2026-09-07T00:00:00Z"))).toHaveLength(14);
    expect(windowDays(0, new Date("2026-09-07T00:00:00Z"))).toHaveLength(7);
  });
});

describe("modelCost", () => {
  it("discounts cache reads and surcharges cache writes by TTL", () => {
    // 1M full input: 800K cache read, 100K cache write (all 1h), 100K uncached; 10K out
    const usd = modelCost("us.anthropic.claude-fable-5-1", { input: 1_000_000, cacheRead: 800_000, cacheWrite: 100_000, cacheWrite1h: 100_000, output: 10_000 }, pricing);
    // input: (100K + 80K + 200K) * $20/M = $7.6 ; output: 10K * $100/M = $1.0
    expect(usd).toBeCloseTo(8.6, 6);
  });
  it("uses the 5m multiplier for writes without the 1h TTL and default pricing for unknown models", () => {
    const usd = modelCost("mystery-model", { input: 1_000_000, cacheRead: 0, cacheWrite: 1_000_000, cacheWrite1h: 0, output: 0 }, pricing);
    expect(usd).toBeCloseTo(1_000_000 * 1.25 * 5.5 / 1e6, 6);
  });
  it("never lets cache counts exceed the input", () => {
    const usd = modelCost("claude-opus-4-8", { input: 100, cacheRead: 500, cacheWrite: 500, output: 0 }, pricing);
    expect(usd).toBeCloseTo(100 * 0.1 * 5.5 / 1e6, 9);
  });
});

describe("summarizeDaily", () => {
  const daily = {
    "2026-08-20": { tokensIn: 999, sessions: 99, byModel: { "claude-opus-4-8": { input: 999, output: 9 } }, evalScores: { Helpfulness: { sum: 99, count: 99 } } },
    "2026-09-06": { sessions: 2, calls: 3, byModel: { "us.anthropic.claude-fable-5-1": { input: 1000, output: 100, cacheRead: 800, cacheWrite: 0, calls: 3 } }, evalScores: { Helpfulness: { sum: 1.5, count: 2 } } },
    "2026-09-07": { sessions: 1, calls: 1, byModel: { "us.anthropic.claude-fable-5-1": { input: 500, output: 50, cacheRead: 100, calls: 1 }, "claude-opus-4-8": { input: 10, output: 1, calls: 1 } }, evalScores: { Helpfulness: { sum: 0.5, count: 1 }, Correctness: { sum: 1, count: 1 } } },
  };
  const days = windowDays(7, new Date("2026-09-07T12:00:00Z"));

  it("folds only the buckets inside the window", () => {
    const s = summarizeDaily(daily, days, pricing);
    expect(s.sessions).toBe(3);
    expect(s.calls).toBe(4);
    expect(s.tokensIn).toBe(1510);
    expect(s.tokensOut).toBe(151);
    expect(s.cacheRead).toBe(900);
    expect(s.evalScores).toEqual({ Helpfulness: { sum: 2, count: 3 }, Correctness: { sum: 1, count: 1 } });
    expect(s.models.map((m) => m.model)).toEqual(["us.anthropic.claude-fable-5-1", "claude-opus-4-8"]);
    expect(s.models[0]).toMatchObject({ input: 1500, output: 150, cacheRead: 900, calls: 4 });
    expect(s.cost).toBeCloseTo(s.models[0].cost + s.models[1].cost, 1);
    expect(s.costPerSession).toBeCloseTo(s.cost / 3, 1);
  });

  it("returns zeros for agents with no buckets", () => {
    const s = summarizeDaily(undefined, days, pricing);
    expect(s).toMatchObject({ sessions: 0, tokensIn: 0, cost: 0, costPerSession: 0, models: [], evalScores: {} });
  });
});

describe("bucketFromDailyItem / groupDailyItems", () => {
  it("lifts flat m|model|field and e|evaluator|sum/count attributes into the nested bucket", () => {
    const item = {
      agentId: "agentcore_hub_agent", day: "2026-09-07", tokensIn: 1510, tokensOut: 151, cacheRead: 900, calls: 5, sessions: 3,
      "m|us.anthropic.claude-fable-5-1|input": 1500, "m|us.anthropic.claude-fable-5-1|output": 150, "m|us.anthropic.claude-fable-5-1|cacheRead": 900,
      "m|us.anthropic.claude-sonnet-4-5-20250929-v1:0|input": 10, "m|us.anthropic.claude-sonnet-4-5-20250929-v1:0|output": 1,
      "e|Builtin.Helpfulness|sum": 2, "e|Builtin.Helpfulness|count": 3, "e|Builtin.Correctness|sum": 1, "e|Builtin.Correctness|count": 1,
      "m|junk": 1, "e|junk|median": 1, expiresAt: 1, updatedAt: "x",
    };
    const b = bucketFromDailyItem(item);
    expect(b).toMatchObject({ tokensIn: 1510, tokensOut: 151, cacheRead: 900, calls: 5, sessions: 3 });
    expect(b.byModel).toEqual({
      "us.anthropic.claude-fable-5-1": { input: 1500, output: 150, cacheRead: 900 },
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0": { input: 10, output: 1 },
    });
    expect(b.evalScores).toEqual({ "Builtin.Helpfulness": { sum: 2, count: 3 }, "Builtin.Correctness": { sum: 1, count: 1 } });
  });

  it("groups items by agent and day and feeds summarizeDaily", () => {
    const grouped = groupDailyItems([
      { agentId: "a", day: "2026-09-07", sessions: 1, "m|x|input": 10, "m|x|output": 1 },
      { agentId: "a", day: "2026-09-06", sessions: 2, "m|x|input": 20, "m|x|output": 2 },
      { agentId: "b", day: "2026-09-07", sessions: 5 },
      { agentId: "bad" },
    ]);
    expect(Object.keys(grouped).sort()).toEqual(["a", "b"]);
    const s = summarizeDaily(grouped.a, windowDays(7, new Date("2026-09-07T12:00:00Z")), pricing);
    expect(s).toMatchObject({ sessions: 3, tokensIn: 30, tokensOut: 3 });
  });
});
