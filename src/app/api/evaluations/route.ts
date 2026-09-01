/**
 * GET /api/evaluations — Fetch evaluation scorecard + per-agent metrics
 *
 * Sources: Single DynamoDB Scan on agentcore-hub-eval-config table.
 * Token usage and eval scores are pre-aggregated by subscription-filter Lambdas.
 */

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getAllEvalConfigs } from "@/lib/eval-config";
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

// Per-model pricing (per 1M tokens) — src/config/pricing.json is the single
// source of truth, shared with the cost-report Lambda via the S3 config prefix.
const MODEL_PRICING: Record<string, { input: number; output: number }> =
  pricingConfig.models;
const DEFAULT_PRICING = pricingConfig.default;

// Agent ID → display name map
const AGENT_DISPLAY_NAMES = new Map(
  agentsConfig.agents
    .filter((a) => a.evaluationsEnabled)
    .map((a) => [a.agentId, a.displayName])
);

// In-memory cache
let cachedResponse: { data: unknown; timestamp: number } | null = null;
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

export async function GET() {
  await headers();

  if (cachedResponse && Date.now() - cachedResponse.timestamp < CACHE_TTL_MS) {
    return NextResponse.json(cachedResponse.data);
  }

  try {
    // Single DDB Scan — returns all agent configs with pre-aggregated metrics
    const items = await getAllEvalConfigs();

    const agents: string[] = [];
    const scorecardSummary: Record<string, Record<string, { avg: number; count: number; passing: number }>> = {};
    const metrics: Record<string, {
      sessions: number;
      tokensIn: number;
      tokensOut: number;
      cost: number;
      costPerSession: number;
      models: Array<{ model: string; input: number; output: number; cost: number }>;
    }> = {};

    for (const item of items) {
      const agentId = item.agentId as string;
      const displayName = AGENT_DISPLAY_NAMES.get(agentId);
      if (!displayName) continue;

      agents.push(displayName);

      // ─── Eval Scores (pre-aggregated by eval-packager Lambda) ───────
      const evalScores = (item.evalScores || {}) as Record<string, { sum: number; count: number }>;
      const sessions = (item.evalSessionCount as number) || 0;

      if (Object.keys(evalScores).length > 0) {
        scorecardSummary[displayName] = {};
        for (const [rawEvaluator, data] of Object.entries(evalScores)) {
          const evaluator = normalizeEvaluatorName(rawEvaluator);
          if (data.count === 0) continue;
          const avg = data.sum / data.count;
          // Estimate passing rate: scores >= 0.7 (using avg as proxy since we store sum/count)
          const passing = avg >= 0.7 ? 100 : Math.round(avg * 100);
          scorecardSummary[displayName][evaluator] = {
            avg: Math.round(avg * 100) / 100,
            count: data.count,
            passing,
          };
        }
      }

      // ─── Token Metrics (pre-aggregated by token-aggregator Lambda) ──
      const tokensIn = (item.tokenTotalInput as number) || 0;
      const tokensOut = (item.tokenTotalOutput as number) || 0;
      const tokenByModel = (item.tokenByModel || {}) as Record<string, { input: number; output: number }>;

      let totalCost = 0;
      const modelBreakdown: Array<{ model: string; input: number; output: number; cost: number }> = [];
      for (const [model, usage] of Object.entries(tokenByModel)) {
        const pricing = MODEL_PRICING[model] || DEFAULT_PRICING;
        const modelCost = (usage.input / 1_000_000 * pricing.input) + (usage.output / 1_000_000 * pricing.output);
        totalCost += modelCost;
        modelBreakdown.push({
          model,
          input: Math.round(usage.input),
          output: Math.round(usage.output),
          cost: Math.round(modelCost * 100) / 100,
        });
      }

      const costPerSession = sessions > 0 ? totalCost / sessions : 0;

      metrics[displayName] = {
        sessions,
        tokensIn: Math.round(tokensIn),
        tokensOut: Math.round(tokensOut),
        cost: Math.round(totalCost * 100) / 100,
        costPerSession: Math.round(costPerSession * 100) / 100,
        models: modelBreakdown,
      };
    }

    const responseData = {
      agents,
      scorecard: scorecardSummary,
      metrics,
      evaluators: [
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
      ],
      lastUpdated: new Date().toISOString(),
    };

    cachedResponse = { data: responseData, timestamp: Date.now() };
    return NextResponse.json(responseData);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
