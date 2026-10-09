import { describe, it, expect } from "vitest";
import {
  windowDays,
  windowDaysFor,
  parseWindow,
  modelCost,
  rateFor,
  summarizeDaily,
  bucketFromDailyItem,
  groupDailyItems,
  splitDailyItems,
  normalizeEvaluatorName,
  type Pricing,
} from "./eval-metrics";

// TEAM-4997: Fable 5.1 is 11/55, not 20/100. The old fixture carried a rate that
// pricing.json itself had already corrected, so every cost expectation below was
// asserting arithmetic no deployment would ever produce.
const pricing: Pricing = {
  models: { "us.anthropic.claude-fable-5-1": { input: 11, output: 55 }, "claude-opus-4-8": { input: 5.5, output: 27.5 } },
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
  it("crosses month boundaries and falls back to the default for a junk length", () => {
    expect(windowDays(3, new Date("2026-09-01T00:10:00Z"))).toEqual(["2026-08-30", "2026-08-31", "2026-09-01"]);
    expect(windowDays(0, new Date("2026-09-07T00:00:00Z"))).toHaveLength(7);
    expect(windowDays(-5, new Date("2026-09-07T00:00:00Z"))).toHaveLength(1);
  });

  // TEAM-4688: MAX_WINDOW_DAYS = 14 used to silently truncate a 30/90-day
  // request to 14 days. Nothing clamps the length any more.
  it("honours windows longer than the old 14-day retention clamp", () => {
    const now = new Date("2026-09-07T00:00:00Z");
    expect(windowDays(30, now)).toHaveLength(30);
    expect(windowDays(30, now)[0]).toBe("2026-08-09");
    const ninety = windowDays(90, now);
    expect(ninety).toHaveLength(90);
    expect(ninety[0]).toBe("2026-06-10");
    expect(ninety[89]).toBe("2026-09-07");
  });
});

describe("parseWindow", () => {
  it("accepts exactly 7 | 30 | 90 | all and labels each", () => {
    expect(parseWindow("7")).toEqual({ days: 7, label: "last 7 days" });
    expect(parseWindow("30")).toEqual({ days: 30, label: "last 30 days" });
    expect(parseWindow("90")).toEqual({ days: 90, label: "last 90 days" });
    expect(parseWindow("all")).toEqual({ days: "all", label: "all time" });
    expect(parseWindow(" ALL ")).toEqual({ days: "all", label: "all time" });
  });

  it("defaults a missing or empty param to the 7-day window", () => {
    expect(parseWindow(null)).toEqual({ days: 7, label: "last 7 days" });
    expect(parseWindow(undefined)).toEqual({ days: 7, label: "last 7 days" });
    expect(parseWindow("")).toEqual({ days: 7, label: "last 7 days" });
  });

  it("rejects anything else so the caller can 400 instead of serving a different period", () => {
    for (const bad of ["14", "0", "-7", "7.5", "9999", "week", "7d", "NaN", "Infinity", "all-time"]) {
      expect(parseWindow(bad), bad).toBeNull();
    }
  });

  it("windowDaysFor resolves a spec to day keys, or the 'all' sentinel", () => {
    const now = new Date("2026-09-07T00:00:00Z");
    expect(windowDaysFor({ days: 7, label: "x" }, now)).toHaveLength(7);
    expect(windowDaysFor({ days: "all", label: "x" }, now)).toBe("all");
  });
});

describe("normalizeEvaluatorName", () => {
  it("strips the Builtin. prefix and maps the dependency-chain evaluator", () => {
    expect(normalizeEvaluatorName("Builtin.Helpfulness")).toBe("Helpfulness");
    expect(normalizeEvaluatorName("custom_dependency_chain_compliance_v2")).toBe("DependencyChainCompliance");
    expect(normalizeEvaluatorName("Correctness")).toBe("Correctness");
  });
});

describe("modelCost", () => {
  it("discounts cache reads and surcharges cache writes by TTL", () => {
    // 1M full input: 800K cache read, 100K cache write (all 1h), 100K uncached; 10K out
    const usd = modelCost("us.anthropic.claude-fable-5-1", { input: 1_000_000, cacheRead: 800_000, cacheWrite: 100_000, cacheWrite1h: 100_000, output: 10_000 }, pricing);
    // input: (100K + 80K + 200K) * $11/M = $4.18 ; output: 10K * $55/M = $0.55
    expect(usd).toBeCloseTo(4.73, 6);
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

describe("modelCost cacheReadInput override", () => {
  it("bills cache reads at the model's absolute rate when present", () => {
    const p: Pricing = { ...pricing, models: { f: { input: 11, output: 55, cacheReadInput: 0.275 } } };
    // 1M read @ 0.275 (not 11 * 0.1 = 1.1); no uncached, no writes, no output.
    expect(modelCost("f", { input: 1_000_000, cacheRead: 1_000_000 }, p)).toBeCloseTo(0.275, 6);
  });
});

// TEAM-4997: OpenAI's long-context tier. The threshold is a per-REQUEST prompt
// size, and the boundary is the whole point of the function, so both sides of it
// are pinned exactly.
describe("rateFor", () => {
  const sol = { input: 3, output: 12, cacheReadInput: 0.3, longContext: { thresholdInputTokens: 272_000, input: 6, output: 24, cacheReadInput: 0.6 } };

  it("bills exactly 272000 prompt tokens at the standard rate, and 272001 at the long-context rate", () => {
    expect(rateFor(sol, 272_000)).toEqual({ input: 3, output: 12, cacheReadInput: 0.3 });
    expect(rateFor(sol, 272_001)).toEqual({ input: 6, output: 24, cacheReadInput: 0.6 });
  });

  it("stays standard for everything below the threshold, including 0 and junk", () => {
    // NaN/Infinity are not "a huge prompt" — they are a broken counter, and the
    // cheap rate is the honest answer to an unknown size.
    for (const tokens of [0, 1, 271_999, NaN, Infinity] as number[]) {
      expect(rateFor(sol, tokens), String(tokens)).toMatchObject({ input: 3, output: 12 });
    }
  });

  it("is a no-op for a model with no long-context tier, and omits an absent cacheReadInput", () => {
    expect(rateFor({ input: 11, output: 55 }, 10_000_000)).toEqual({ input: 11, output: 55 });
    expect(rateFor({ input: 11, output: 55, cacheReadInput: 0.275 }, 1)).toEqual({ input: 11, output: 55, cacheReadInput: 0.275 });
  });

  // The day-bucket path must NOT pick up long-context rates: a bucket is a sum
  // over a day and has no per-request size to compare (see modelCost's comment).
  it("does not leak into modelCost, however large the bucket's input is", () => {
    const p: Pricing = { ...pricing, models: { sol } };
    expect(modelCost("sol", { input: 10_000_000, output: 0 }, p)).toBeCloseTo(30, 6); // 10M * $3/M, not $6/M
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
    expect(s).toMatchObject({ sessions: 0, tokensIn: 0, cost: 0, costPerSession: 0, models: [], evalScores: {}, unpricedModels: [] });
  });

  // TEAM-4997: an id with no pricing row is billed at pricing.default, which makes
  // a wrong cost look exactly like a right one. The gap is now reported.
  it("reports the models that fell through to pricing.default, sorted and distinct", () => {
    expect(summarizeDaily(daily, days, pricing).unpricedModels).toEqual([]);

    const withGaps = {
      "2026-09-06": { byModel: { "zz.unknown-model": { input: 1_000_000 }, "us.anthropic.claude-fable-5-1": { input: 1_000_000 } } },
      // Seen on two days and alongside a priced model — still one entry, sorted.
      "2026-09-07": { byModel: { "zz.unknown-model": { input: 1_000_000 }, "aa.other-unknown": { input: 1_000_000 } } },
    };
    const s = summarizeDaily(withGaps, days, pricing);
    expect(s.unpricedModels).toEqual(["aa.other-unknown", "zz.unknown-model"]);
    // The cost is still reported — the gap is a caveat on it, not a refusal.
    // 3M unpriced tokens at the $5.5/M default + 1M priced at $11/M.
    expect(s.cost).toBeCloseTo(3 * 5.5 + 11, 6);
  });

  // TEAM-4688: the all-time view has no day list to intersect with.
  it("folds EVERY day present when days is 'all' or null", () => {
    for (const all of ["all", null, undefined] as const) {
      const s = summarizeDaily(daily, all, pricing);
      // 99 + 2 + 1 — the 2026-08-20 bucket the 7-day window excludes is included.
      expect(s.sessions, String(all)).toBe(102);
      expect(s.evalScores).toEqual({ Helpfulness: { sum: 101, count: 102 }, Correctness: { sum: 1, count: 1 } });
      expect(s.tokensIn).toBe(1510 + 999);
    }
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

describe("splitDailyItems", () => {
  const items = [
    { agentId: "runtime_a", day: "2026-09-07", sessions: 5, "e|Builtin.Helpfulness|sum": 4, "e|Builtin.Helpfulness|count": 5 },
    { agentId: "runtime_a", day: "2026-09-06", sessions: 2 },
    { agentId: "runtime_a#persona_one", day: "2026-09-07", sessions: 3, "e|Builtin.Helpfulness|sum": 2.4, "e|Builtin.Helpfulness|count": 3 },
    { agentId: "runtime_a#persona_two", day: "2026-09-07", sessions: 2 },
    { agentId: "runtime_b", day: "2026-09-07", sessions: 1 },
    { agentId: "runtime_c#", day: "2026-09-07", sessions: 9 }, // empty persona → dropped
    { agentId: "#orphan", day: "2026-09-07", sessions: 9 },    // empty agentId → dropped
    { agentId: "runtime_a" },                                  // no day → dropped
  ];

  it("separates runtime rows from ${agentId}#${persona} rows in ONE pass", () => {
    const { byAgent, byPersona } = splitDailyItems(items);
    expect(Object.keys(byAgent).sort()).toEqual(["runtime_a", "runtime_b"]);
    expect(Object.keys(byAgent.runtime_a).sort()).toEqual(["2026-09-06", "2026-09-07"]);
    expect(Object.keys(byPersona)).toEqual(["runtime_a"]);
    expect(Object.keys(byPersona.runtime_a).sort()).toEqual(["persona_one", "persona_two"]);
    // Persona rows never leak into the runtime family (they would double-count).
    expect(byAgent["runtime_a#persona_one"]).toBeUndefined();
    expect(byAgent.runtime_c).toBeUndefined();
  });

  it("hands each persona a bucket map summarizeDaily can fold directly", () => {
    const { byPersona } = splitDailyItems(items);
    const s = summarizeDaily(byPersona.runtime_a.persona_one, "all", pricing);
    expect(s.sessions).toBe(3);
    expect(s.evalScores).toEqual({ "Builtin.Helpfulness": { sum: 2.4, count: 3 } });
  });
});
