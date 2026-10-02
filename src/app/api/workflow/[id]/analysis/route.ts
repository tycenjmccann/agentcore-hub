/**
 * GET /api/workflow/[id]/analysis
 *
 * Returns the Workflow Manager analyses for a run plus def-level trend history:
 *   { latest, history, trend }
 *
 * - latest:  most recent full analysis for this workflowId (or null)
 * - history: all analyses for this run, newest first, compact (no summaryMarkdown/metrics)
 * - trend:   compact points across recent runs of the same workflowDefId (GSI)
 *
 * `latestFailure` is the newest workflow.analysis_failed event the analyzer
 * Lambda wrote after the latest analysis (any, if there is none yet), or null —
 * on every GET, so an auto-analysis failure shows without a Run Analysis click
 * (TEAM-5226, TEAM-5240). `?attempt=<id>` (the attemptId POST /analyze returned)
 * narrows it to that attempt's failure, so a concurrent attempt's failure never
 * ends another attempt's poll.
 */

import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type {
  WorkflowAnalysis,
  AnalysisFailure,
  AnalysisResponse,
  AnalysisTrendPoint,
} from "@/lib/workflow/analysis-types";

const REGION = process.env.AWS_REGION || "us-east-1";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const ANALYSES_TABLE = process.env.ANALYSES_TABLE || "agentcore-hub-workflow-analyses";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";
const TREND_LIMIT = 10;
/** Pages of the run's events read newest-first after the latest analysis. */
const FAILURE_MAX_PAGES = 3;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export const dynamic = "force-dynamic";

/**
 * Newest workflow.analysis_failed after `cutoffMs` (optionally one attempt's).
 * eventId is `<ms>-<rand>`, so a key-range on the `<ms>` prefix bounds the read,
 * and reading newest-first means the first match is the answer — the page cap
 * can only bite with pages of newer events on top of it (TEAM-5240).
 * A read failure is null, never a 500 — the analysis itself must still load.
 */
async function latestFailure(
  workflowId: string,
  cutoffMs: number,
  attemptId: string | null,
): Promise<AnalysisFailure | null> {
  try {
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    for (let page = 0; page < FAILURE_MAX_PAGES; page++) {
      const res = await ddb.send(new QueryCommand({
        TableName: EVENTS_TABLE,
        KeyConditionExpression: "workflowId = :w AND eventId >= :cut",
        FilterExpression: attemptId ? "#t = :failed AND #d.attemptId = :a" : "#t = :failed",
        ExpressionAttributeNames: { "#t": "type", ...(attemptId ? { "#d": "detail" } : {}) },
        ExpressionAttributeValues: {
          ":w": workflowId,
          ":cut": String(cutoffMs),
          ":failed": "workflow.analysis_failed",
          ...(attemptId ? { ":a": attemptId } : {}),
        },
        ScanIndexForward: false, // newest first
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }));
      const item = res.Items?.[0];
      if (item) return { eventId: item.eventId, timestamp: item.timestamp, detail: item.detail } as AnalysisFailure;
      ExclusiveStartKey = res.LastEvaluatedKey;
      if (!ExclusiveStartKey) break;
    }
    return null;
  } catch (err) {
    console.warn(`[analysis] failure lookup ${workflowId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const workflowId = params.id;
  const attemptId = req.nextUrl.searchParams.get("attempt") || null;
  try {
    const analysesPage = await ddb.send(new QueryCommand({
      TableName: ANALYSES_TABLE,
      KeyConditionExpression: "workflowId = :w",
      ExpressionAttributeValues: { ":w": workflowId },
      ScanIndexForward: false, // newest first (analysisId is time-sortable)
    }));
    const analyses = (analysesPage.Items || []) as WorkflowAnalysis[];
    const latest = analyses[0] || null;

    // Full records: the panel lets a user select any history entry and renders
    // its metric cards + full report, so history must carry metrics and
    // summaryMarkdown. This is per-run (a handful of re-analyses), not the
    // cross-run set — the compact projection belongs to `trend` below.
    const history = analyses;

    // Def-level trend: resolve workflowDefId (from latest analysis or the run row).
    let workflowDefId: string | undefined = latest?.workflowDefId;
    if (!workflowDefId) {
      const wf = await ddb.send(new GetCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
        ProjectionExpression: "workflowDefId",
      }));
      workflowDefId = (wf.Item?.workflowDefId as string) || undefined;
    }

    let trend: AnalysisTrendPoint[] = [];
    if (workflowDefId) {
      const trendPage = await ddb.send(new QueryCommand({
        TableName: ANALYSES_TABLE,
        IndexName: "workflowDefId-index",
        KeyConditionExpression: "workflowDefId = :d",
        ExpressionAttributeValues: { ":d": workflowDefId },
        ScanIndexForward: false,
        Limit: TREND_LIMIT,
      }));
      trend = (trendPage.Items || []).map((a) => {
        const analysis = a as WorkflowAnalysis;
        const m = analysis.metrics;
        return {
          analysisId: analysis.analysisId,
          workflowId: analysis.workflowId,
          analyzedAt: analysis.analyzedAt,
          runOutcome: analysis.runOutcome,
          overallScore: analysis.scores?.overall ?? null,
          totalDurationMs: m?.totalDurationMs ?? null,
          humanWaitTotalMs: m?.humanWaitTotalMs ?? null,
          changeRequestCount: m?.changeRequests?.count ?? null,
        };
      });
    }

    const body: AnalysisResponse = { latest, history, trend };
    // Only failures newer than the latest analysis: a good re-run supersedes them.
    const analyzedMs = latest ? Date.parse(latest.analyzedAt) : NaN;
    body.latestFailure = await latestFailure(workflowId, Number.isFinite(analyzedMs) ? analyzedMs : 0, attemptId);
    return NextResponse.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // A missing table (before deploy) should read as "no analysis", not a 500.
    if ((err as { name?: string }).name === "ResourceNotFoundException") {
      return NextResponse.json({ latest: null, history: [], trend: [] } as AnalysisResponse);
    }
    console.error(`[analysis] ${workflowId}:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
