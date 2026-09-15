/**
 * GET /api/evaluations/timeseries?agentId=&persona=&days=7|30|90|all
 *
 * The per-day series behind the trend chart: one point per UTC day with that
 * day's session count and per-evaluator average. Read off the SAME
 * agentcore-hub-eval-daily rows /api/evaluations folds — `bucketFromDailyItem`
 * (via splitDailyItems) owns the flat `e|<evaluator>|sum/count` layout, so this
 * route never re-parses attribute names.
 *
 * `persona` is optional: without it the runtime-level rows (PK `agentId`) are
 * used, with it the persona rows (PK `${agentId}#${persona}`).
 *
 * Day coverage: for a fixed window every day in the window is emitted, zeros
 * included, so the chart's x-axis is the window and gaps read as gaps. For
 * `days=all` only days that have rows are emitted (there is no defined start).
 */

import { NextRequest, NextResponse } from "next/server";
import { getAllEvalDaily } from "@/lib/eval-config";
import {
  ALLOWED_WINDOW_DAYS,
  normalizeEvaluatorName,
  parseWindow,
  splitDailyItems,
  windowDaysFor,
  type DailyBucket,
} from "@/lib/eval-metrics";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface SeriesPoint {
  day: string;
  sessions: number;
  evaluators: Record<string, { avg: number; count: number }>;
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const agentId = (params.get("agentId") || "").trim();
  const persona = (params.get("persona") || "").trim();

  if (!agentId) {
    return NextResponse.json({ error: "agentId is required" }, { status: 400 });
  }

  const spec = parseWindow(params.get("days"));
  if (!spec) {
    return NextResponse.json(
      { error: `Invalid days: expected one of ${ALLOWED_WINDOW_DAYS.join(", ")} or "all"` },
      { status: 400 }
    );
  }

  try {
    const dailyItems = await getAllEvalDaily();
    const { byAgent, byPersona } = splitDailyItems(dailyItems);
    const daily: Record<string, Partial<DailyBucket>> =
      (persona ? byPersona[agentId]?.[persona] : byAgent[agentId]) || {};

    const resolved = windowDaysFor(spec);
    const days = resolved === "all" ? Object.keys(daily).sort() : resolved;

    const series: SeriesPoint[] = days.map((day) => {
      const bucket = daily[day];
      const evaluators: Record<string, { avg: number; count: number }> = {};
      for (const [rawEvaluator, s] of Object.entries(bucket?.evalScores || {})) {
        const count = Number(s?.count) || 0;
        if (!count) continue;
        const sum = Number(s?.sum) || 0;
        evaluators[normalizeEvaluatorName(rawEvaluator)] = {
          avg: Math.round((sum / count) * 100) / 100,
          count,
        };
      }
      return { day, sessions: Number(bucket?.sessions) || 0, evaluators };
    });

    return NextResponse.json({
      agentId,
      persona: persona || null,
      series,
      window: {
        days: spec.days,
        start: series[0]?.day ?? null,
        end: series[series.length - 1]?.day ?? null,
        timezone: "UTC",
      },
      windowLabel: spec.label,
      lastUpdated: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
