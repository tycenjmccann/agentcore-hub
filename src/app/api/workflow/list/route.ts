import { NextRequest, NextResponse } from "next/server";
import { listWorkflowsFromDynamo } from "@/lib/workflow/dynamo-read";
import { hasCostData, type CardSummary } from "@/lib/workflow/performance";
import { loadIndex } from "@/lib/workflow/performance-index";

export const dynamic = "force-dynamic";

/** The hero KPI headline for one run, as the list rows carry it. */
interface RowKpi {
  version: number;
  cost: { usd: number | null };
  time: { wallMs: number | null };
  quality: { score: number | null; grade: string | null; confidence: string };
}

/**
 * performance/index.json keyed by workflowId. Best effort by design: the index
 * is a derived artifact maintained by the cost-report Lambda, so a missing,
 * stale or unreadable index must degrade the KPI column to "unknown" and never
 * fail the workflow list itself.
 */
async function loadKpisByWorkflowId(): Promise<Map<string, CardSummary>> {
  const byId = new Map<string, CardSummary>();
  try {
    const index = await loadIndex();
    for (const card of index.cards || []) {
      if (card?.workflowId) byId.set(card.workflowId, card);
    }
  } catch (err) {
    console.warn("[list] performance index unavailable, listing without KPIs:", err);
  }
  return byId;
}

/**
 * `null` everywhere means UNKNOWN, never zero — a run whose cost spans never
 * matched has no cost, and rendering that as $0.00 would read as "free".
 */
function toRowKpi(summary: CardSummary | undefined): RowKpi | null {
  if (!summary?.kpi) return null;
  return {
    version: summary.kpi.version,
    cost: { usd: hasCostData(summary) && !summary.costMissing ? summary.cost.total : null },
    time: { wallMs: summary.time?.wall ?? null },
    quality: {
      score: summary.kpi.quality?.score ?? null,
      grade: summary.kpi.quality?.grade ?? null,
      confidence: summary.kpi.quality?.confidence,
    },
  };
}

export async function GET(request: NextRequest) {
  try {
    const includeArchived = request.nextUrl.searchParams.get("includeArchived") === "1";
    const workflows = await listWorkflowsFromDynamo({ includeArchived });
    // Additive: every pre-existing field of every row is passed through as-is.
    const byId = await loadKpisByWorkflowId();
    const withKpis = workflows.map((item) => ({
      ...item,
      kpi: toRowKpi(byId.get(item.workflowId as string)),
    }));
    return NextResponse.json({ workflows: withKpis });
  } catch (err) {
    console.error("[list] Error listing workflows:", err);
    return NextResponse.json(
      { error: `Failed to list workflows: ${(err as Error).message}`, workflows: [] },
      { status: 500 }
    );
  }
}
