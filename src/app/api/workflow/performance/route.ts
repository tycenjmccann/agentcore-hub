/**
 * /api/workflow/performance — fleet + per-run performance cards.
 *
 *   GET ?days=7&defId=all|<workflowDefId>  → FleetView (cost / time / quality
 *        medians for the window vs the prior window, anomaly bands against the
 *        prior 28 days, by-agent and by-engine rollups, infra allocation)
 *   GET ?workflowId=<id>                    → that run's performance-card.json
 *
 * Reads only what the cost-report Lambda already wrote to the artifact bucket
 * (performance/index.json + workflows/{id}/shared/performance-card.json); no
 * Logs Insights or Cost Explorer calls happen on the request path. The index
 * cache lives in @/lib/workflow/performance-index so the list route shares it.
 */

import { NextRequest, NextResponse } from "next/server";
import { ARTIFACT_BUCKET } from "@/lib/workflow/agent-setup";
import { buildFleetView } from "@/lib/workflow/performance";
import { getJson, loadIndex } from "@/lib/workflow/performance-index";

export const dynamic = "force-dynamic";

/** Shared by every branch that takes a workflowId, so the guard can't drift. */
const WORKFLOW_ID_RE = /^[\w-]+$/;
const BAD_ID = { error: "invalid workflowId" };
const CARD_KEY = (workflowId: string) => `workflows/${workflowId}/shared/performance-card.json`;

export async function GET(request: NextRequest) {
  if (!ARTIFACT_BUCKET) {
    return NextResponse.json({ error: "ARTIFACT_BUCKET not configured" }, { status: 500 });
  }
  const params = request.nextUrl.searchParams;
  try {
    const workflowId = params.get("workflowId");
    if (workflowId) {
      if (!WORKFLOW_ID_RE.test(workflowId)) return NextResponse.json(BAD_ID, { status: 400 });
      const card = await getJson<Record<string, unknown>>(CARD_KEY(workflowId));
      if (!card) return NextResponse.json({ error: "no performance card for this run yet" }, { status: 404 });
      return NextResponse.json({ card });
    }
    const days = Number(params.get("days") || 7);
    const defId = params.get("defId") || "all";
    const index = await loadIndex();
    const view = buildFleetView(index, { days: Number.isFinite(days) ? days : 7, workflowDefId: defId });
    return NextResponse.json(view);
  } catch (err) {
    console.error("[performance] error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
