/**
 * GET /api/workflow/[id]/analysis
 *
 * Returns the Workflow Manager analyses for a run plus def-level trend history:
 *   { latest, history, trend }
 *
 * - latest:  most recent full analysis for this workflowId (or null)
 * - history: all analyses for this run, newest first, compact (no summaryMarkdown/metrics)
 * - trend:   compact points across recent runs of the same workflowDefId (GSI)
 */

import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type {
  WorkflowAnalysis,
  AnalysisResponse,
  AnalysisTrendPoint,
} from "@/lib/workflow/analysis-types";

const REGION = process.env.AWS_REGION || "us-east-1";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const ANALYSES_TABLE = process.env.ANALYSES_TABLE || "agentcore-hub-workflow-analyses";
const TREND_LIMIT = 10;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const workflowId = params.id;
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
