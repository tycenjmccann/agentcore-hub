/**
 * GET /api/evaluations?days=7|30|90|all — evaluation scorecard + per-agent metrics
 *
 * Sources: a Scan of agentcore-hub-eval-config (which agents exist) and a Scan
 * of agentcore-hub-eval-daily — one item per agent per UTC day, written by the
 * token-aggregator (tokens, cache, cost) and eval-packager (sessions, evaluator
 * scores) Lambdas. Every number is folded over the SAME window: today plus the
 * previous (days - 1) UTC days, or every day on record for `days=all`.
 *
 * TEAM-4688: `days` was previously `Number(...)`-parsed and clamped to 14, so a
 * 30- or 90-day request silently returned 14 days. It is now parsed against a
 * closed set (7 | 30 | 90 | all) and an unknown value is a 400 — the operator
 * never gets a period they didn't ask for. The same scan also carries per-agent
 * PERSONA rows (PK `${agentId}#${persona}`), surfaced under `personas`.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAllEvalConfigs, getAllEvalDaily } from "@/lib/eval-config";
import {
  ALLOWED_WINDOW_DAYS,
  normalizeEvaluatorName,
  parseWindow,
  splitDailyItems,
  summarizeDaily,
  windowDaysFor,
  type AgentWindowSummary,
  type Pricing,
} from "@/lib/eval-metrics";
import agentsConfig from "@/config/agents.json";
import pricingConfig from "@/config/pricing.json";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

// src/config/pricing.json is the single source of truth (shared with the
// cost-report Lambda via the S3 config prefix); cache discount/surcharge included.
const PRICING = pricingConfig as unknown as Pricing;

// Agent ID → display name map
const AGENT_DISPLAY_NAMES = new Map(
  agentsConfig.agents
    .filter((a) => a.evaluationsEnabled)
    .map((a) => [a.agentId, a.displayName])
);

// Personas are fleet agentIds that may share a runtime with the anchor agent, so
// they are named off the FULL roster — not just the evaluations-enabled subset.
const ALL_DISPLAY_NAMES = new Map(agentsConfig.agents.map((a) => [a.agentId, a.displayName]));

// In-memory cache, keyed by the window STRING ("7" | "30" | "90" | "all"): keying
// by day-count collided "all" with whatever number of days happened to be present.
const cache = new Map<string, { data: unknown; timestamp: number }>();
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

type EvaluatorScores = Record<string, { avg: number; count: number; passing: number }>;
type Scorecard = Record<string, EvaluatorScores>;

interface PersonaSummary {
  persona: string;
  displayName: string;
  sessions: number;
  calls: number;
  cost: number;
  costPerSession: number;
  scores: EvaluatorScores | null;
}

function scorecardFrom(summary: AgentWindowSummary): EvaluatorScores | null {
  const out: EvaluatorScores = {};
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
  const spec = parseWindow(req.nextUrl.searchParams.get("days"));
  if (!spec) {
    return NextResponse.json(
      { error: `Invalid days: expected one of ${ALLOWED_WINDOW_DAYS.join(", ")} or "all"` },
      { status: 400 }
    );
  }
  const cacheKey = String(spec.days);

  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.timestamp < CACHE_TTL_MS) {
    return NextResponse.json(hit.data);
  }

  try {
    const [items, dailyItems] = await Promise.all([getAllEvalConfigs(), getAllEvalDaily()]);
    const { byAgent, byPersona } = splitDailyItems(dailyItems);
    const days = windowDaysFor(spec);

    const agents: string[] = [];
    const scorecard: Scorecard = {};
    const metrics: Record<string, Omit<AgentWindowSummary, "evalScores">> = {};
    const personas: Record<string, PersonaSummary[]> = {};

    for (const item of items) {
      const agentId = item.agentId as string;
      const displayName = AGENT_DISPLAY_NAMES.get(agentId);
      if (!displayName) continue;
      agents.push(displayName);

      const summary = summarizeDaily(byAgent[agentId], days, PRICING);
      const scores = scorecardFrom(summary);
      if (scores) scorecard[displayName] = scores;

      const { evalScores: _omit, ...rest } = summary;
      void _omit;
      metrics[displayName] = rest;

      const perPersona = Object.entries(byPersona[agentId] || {})
        .map(([persona, daily]): PersonaSummary => {
          const s = summarizeDaily(daily, days, PRICING);
          return {
            persona,
            displayName: ALL_DISPLAY_NAMES.get(persona) || persona,
            sessions: s.sessions,
            calls: s.calls,
            cost: s.cost,
            costPerSession: s.costPerSession,
            scores: scorecardFrom(s),
          };
        })
        .sort((a, b) => b.sessions - a.sessions || a.persona.localeCompare(b.persona));
      if (perPersona.length) personas[displayName] = perPersona;
    }

    // For a fixed window the bounds are the window itself; for "all" they are the
    // oldest/newest day actually on record (retention is the real bound).
    const bounds =
      days === "all"
        ? allTimeBounds(dailyItems)
        : { start: days[0] ?? null, end: days[days.length - 1] ?? null };

    const responseData = {
      agents,
      scorecard,
      metrics,
      personas,
      evaluators: EVALUATORS,
      window: { days: spec.days, start: bounds.start, end: bounds.end, timezone: "UTC" },
      windowLabel: spec.label,
      lastUpdated: new Date().toISOString(),
    };

    cache.set(cacheKey, { data: responseData, timestamp: Date.now() });
    return NextResponse.json(responseData);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function allTimeBounds(dailyItems: Array<Record<string, unknown>>): { start: string | null; end: string | null } {
  let start: string | null = null;
  let end: string | null = null;
  for (const item of dailyItems) {
    const day = typeof item.day === "string" ? item.day : null;
    if (!day) continue;
    if (start === null || day < start) start = day;
    if (end === null || day > end) end = day;
  }
  return { start, end };
}
