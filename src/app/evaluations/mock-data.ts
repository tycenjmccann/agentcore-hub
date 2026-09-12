import pricing from "@/config/pricing.json";
import type { AgentMetrics, EvalData, ModelCost, ScorecardEntry } from "./types";

/**
 * Demo fixture for /evaluations?mock=1. Trimmed to 5 runtimes, 4 models and
 * 8 evaluators so operational metrics and evaluator scores fit one screen.
 * Display names must exist in agents.json so the SI-loop toggles resolve.
 */
export const MOCK_AGENTS = [
  "Hub Agent (Shared Runtime)",
  "Workflow Manager",
  "Builder",
  "Coding Runtime",
  "Fleet Improver",
];

const MODEL = {
  fable: "us.anthropic.claude-fable-5-1",
  opus: "us.anthropic.claude-opus-5",
  sonnet: "us.anthropic.claude-sonnet-5",
  haiku: "us.anthropic.claude-haiku-4-5-20251001",
};

const EVALUATORS = [
  "GoalSuccessRate",
  "Correctness",
  "InstructionFollowing",
  "ToolSelectionAccuracy",
  "ToolParameterAccuracy",
  "Helpfulness",
  "Faithfulness",
  "Coherence",
];

const PRICES = pricing.models as Record<string, { input: number; output: number }>;
const CACHE_READ = pricing.cachedInputDiscount;
const CACHE_WRITE = pricing.cacheWriteMultiplier.default;

// Cost is derived from tokens via the hub's own pricing table so the fixture
// stays internally consistent (tokens ↔ cache hit ↔ cost). `tokensIn` is the
// full prompt (cache reads/writes included), matching the live aggregator.
function model(
  id: string,
  tokensIn: number,
  tokensOut: number,
  cacheHit: number,
  cacheWriteShare = 0.04,
): ModelCost {
  const price = PRICES[id];
  const cacheRead = Math.round(tokensIn * cacheHit);
  const cacheWrite = Math.round(tokensIn * cacheWriteShare);
  const uncached = tokensIn - cacheRead - cacheWrite;
  const cost =
    (uncached * price.input +
      cacheRead * price.input * CACHE_READ +
      cacheWrite * price.input * CACHE_WRITE +
      tokensOut * price.output) /
    1_000_000;
  return { model: id, input: tokensIn, output: tokensOut, cacheRead, cacheWrite, calls: Math.round(tokensIn / 45_000), cost };
}

function agent(sessions: number, models: ModelCost[]): AgentMetrics {
  const sum = (f: (m: ModelCost) => number) => models.reduce((s, m) => s + f(m), 0);
  const cost = sum((m) => m.cost);
  return {
    sessions,
    tokensIn: sum((m) => m.input),
    tokensOut: sum((m) => m.output),
    cacheRead: sum((m) => m.cacheRead ?? 0),
    cacheWrite: sum((m) => m.cacheWrite ?? 0),
    calls: sum((m) => m.calls ?? 0),
    cost,
    costPerSession: cost / sessions,
    models,
  };
}

function scores(count: number, avgs: number[]): Record<string, ScorecardEntry> {
  const out: Record<string, ScorecardEntry> = {};
  EVALUATORS.forEach((ev, i) => {
    out[`Builtin.${ev}`] = { avg: avgs[i], count, passing: Math.round(count * avgs[i]) };
  });
  return out;
}

function rollingWindow(days: number) {
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return { days, start: day(start), end: day(end), timezone: "UTC" };
}

export const MOCK_EVAL_DATA: EvalData = {
  agents: MOCK_AGENTS,
  evaluators: EVALUATORS,
  window: rollingWindow(7),
  lastUpdated: new Date().toISOString(),
  // Model story: Fable = persona reasoning only; Opus = planning + complex coding
  // on the CLI runtime; Sonnet = CLI execution workhorse; Haiku = routing,
  // triage polling and sub-agent summaries - meaningful, but under Sonnet.
  metrics: {
    "Hub Agent (Shared Runtime)": agent(38, [
      model(MODEL.fable, 480_000_000, 4_800_000, 0.80),
      model(MODEL.haiku, 42_000_000, 900_000, 0.60, 0.03),
    ]),
    "Workflow Manager": agent(9, [
      model(MODEL.fable, 130_000_000, 1_900_000, 0.70),
      model(MODEL.haiku, 60_000_000, 400_000, 0.85, 0.02),
    ]),
    "Builder": agent(12, [
      model(MODEL.sonnet, 28_000_000, 600_000, 0.55, 0.05),
      model(MODEL.haiku, 9_000_000, 200_000, 0.50, 0.05),
    ]),
    "Coding Runtime": agent(47, [
      model(MODEL.opus, 750_000_000, 7_000_000, 0.90),
      model(MODEL.sonnet, 2_400_000_000, 21_000_000, 0.94, 0.03),
      model(MODEL.haiku, 380_000_000, 3_100_000, 0.92, 0.03),
    ]),
    "Fleet Improver": agent(3, [
      model(MODEL.fable, 6_000_000, 90_000, 0.50, 0.05),
    ]),
  },
  scorecard: {
    "Hub Agent (Shared Runtime)": scores(38, [0.94, 0.92, 0.96, 0.91, 0.89, 0.93, 0.95, 0.97]),
    "Workflow Manager": scores(9, [0.88, 0.90, 0.93, 0.86, 0.84, 0.89, 0.92, 0.94]),
    "Builder": scores(12, [0.97, 0.95, 0.98, 0.96, 0.95, 0.94, 0.97, 0.98]),
    "Coding Runtime": scores(47, [0.91, 0.89, 0.92, 0.94, 0.93, 0.90, 0.88, 0.95]),
    "Fleet Improver": scores(3, [0.72, 0.81, 0.90, 0.78, 0.74, 0.83, 0.85, 0.91]),
  },
};
