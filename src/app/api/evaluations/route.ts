/**
 * GET /api/evaluations?days=7 — Fetch evaluation scorecard + per-agent metrics
 *
 * Sources: a Scan of agentcore-hub-eval-config (which agents exist) and a Scan
 * of agentcore-hub-eval-daily — one item per agent per UTC day, written by the
 * token-aggregator (tokens, cache, cost) and eval-packager (sessions, evaluator
 * scores) Lambdas. Every number is folded over the SAME rolling window — today
 * plus the previous (days - 1) UTC days; `days` clamps to 1..14 (bucket TTL).
 * No weekly reset, no all-time counters.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAllEvalConfigs, getAllEvalDaily } from "@/lib/eval-config";
import {
  DEFAULT_WINDOW_DAYS,
  groupDailyItems,
  summarizeDaily,
  windowDays,
  type AgentWindowSummary,
  type Pricing,
} from "@/lib/eval-metrics";
import agentsConfig from "@/config/agents.json";
import pricingConfig from "@/config/pricing.json";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

// Map raw CW Logs evaluator names to UI display names
function normalizeEvaluatorName(raw: string): string {
  if (raw.startsWith("Builtin.")) return raw.slice(8);
  if (raw.includes("dependency_chain_compliance")) return "DependencyChainCompliance";
  return raw;
}

// src/config/pricing.json is the single source of truth (shared with the
// cost-report Lambda via the S3 config prefix); cache discount/surcharge included.
const PRICING = pricingConfig as unknown as Pricing;

// Agent ID → display name map
const AGENT_DISPLAY_NAMES = new Map(
  agentsConfig.agents
    .filter((a) => a.evaluationsEnabled)
    .map((a) => [a.agentId, a.displayName])
);

// In-memory cache, per window length
const cache = new Map<number, { data: unknown; timestamp: number }>();
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

const EVALUATORS = [
  "ToolSelectionAccuracy",
  "ToolParameterAccuracy",
  "InstructionFollowing",
  "GoalSuccessRate",
  "Correctness",
  "Coherence",
  "Faithfulness",
  "Helpfulness",
  "Conciseness",
  "ResponseRelevance",
  "DependencyChainCompliance",
];

type Scorecard = Record<string, Record<string, { avg: number; count: number; passing: number }>>;

function scorecardFrom(summary: AgentWindowSummary): Record<string, { avg: number; count: number; passing: number }> | null {
  const out: Record<string, { avg: number; count: number; passing: number }> = {};
  for (const [rawEvaluator, data] of Object.entries(summary.evalScores)) {
    if (!data.count) continue;
    const avg = data.sum / data.count;
    // Estimate passing rate: scores >= 0.7 (avg as proxy since we store sum/count)
    out[normalizeEvaluatorName(rawEvaluator)] = {
      avg: Math.round(avg * 100) / 100,
      count: data.count,
      passing: avg >= 0.7 ? 100 : Math.round(avg * 100),
    };
  }
  return Object.keys(out).length ? out : null;
}

export async function GET(req: NextRequest) {
  const requested = Number(req.nextUrl.searchParams.get("days"));
  const days = windowDays(Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_WINDOW_DAYS);
  const windowLen = days.length;

  const hit = cache.get(windowLen);
  if (hit && Date.now() - hit.timestamp < CACHE_TTL_MS) {
    return NextResponse.json(hit.data);
  }

  try {
    const [items, dailyItems] = await Promise.all([getAllEvalConfigs(), getAllEvalDaily()]);
    const dailyByAgent = groupDailyItems(dailyItems);

    const agents: string[] = [];
    const scorecard: Scorecard = {};
    const metrics: Record<string, Omit<AgentWindowSummary, "evalScores">> = {};

    for (const item of items) {
      const agentId = item.agentId as string;
      const displayName = AGENT_DISPLAY_NAMES.get(agentId);
      if (!displayName) continue;
      agents.push(displayName);

      const summary = summarizeDaily(dailyByAgent[agentId], days, PRICING);
      const scores = scorecardFrom(summary);
      if (scores) scorecard[displayName] = scores;

      const { evalScores: _omit, ...rest } = summary;
      void _omit;
      metrics[displayName] = rest;
    }

    const responseData = {
      agents,
      scorecard,
      metrics,
      evaluators: EVALUATORS,
      window: { days: windowLen, start: days[0], end: days[days.length - 1], timezone: "UTC" },
      lastUpdated: new Date().toISOString(),
    };

    cache.set(windowLen, { data: responseData, timestamp: Date.now() });
    return NextResponse.json(responseData);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
