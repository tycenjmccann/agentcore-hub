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
 * Logs Insights or Cost Explorer calls happen on the request path.
 */

import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { ARTIFACT_BUCKET } from "@/lib/workflow/agent-setup";
import { buildFleetView, type PerformanceIndex } from "@/lib/workflow/performance";

export const dynamic = "force-dynamic";

const REGION = process.env.AWS_REGION || "us-east-1";
const INDEX_KEY = process.env.PERFORMANCE_INDEX_KEY || "performance/index.json";
const INDEX_TTL_MS = 60_000;

const s3 = new S3Client({ region: REGION });
let indexCache: { at: number; value: PerformanceIndex } | null = null;

async function getJson<T>(key: string): Promise<T | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: key }));
    return JSON.parse(await res.Body!.transformToString()) as T;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "NoSuchKey" || name === "NotFound") return null;
    throw err;
  }
}

async function loadIndex(): Promise<PerformanceIndex> {
  if (indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.value;
  const idx = await getJson<PerformanceIndex>(INDEX_KEY);
  const value: PerformanceIndex = idx && Array.isArray(idx.cards) ? idx : { version: 1, updatedAt: null, cards: [], infra: null };
  indexCache = { at: Date.now(), value };
  return value;
}

export async function GET(request: NextRequest) {
  if (!ARTIFACT_BUCKET) {
    return NextResponse.json({ error: "ARTIFACT_BUCKET not configured" }, { status: 500 });
  }
  const params = request.nextUrl.searchParams;
  try {
    const workflowId = params.get("workflowId");
    if (workflowId) {
      if (!/^[\w-]+$/.test(workflowId)) return NextResponse.json({ error: "invalid workflowId" }, { status: 400 });
      const card = await getJson<Record<string, unknown>>(`workflows/${workflowId}/shared/performance-card.json`);
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
