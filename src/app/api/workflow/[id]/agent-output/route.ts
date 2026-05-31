/**
 * GET /api/workflow/[id]/agent-output?agentId=agentcore_hub_frontend_dev
 *
 * Returns ALL text output for a specific agent in a workflow.
 * Streaming chunks: agentcore-hub-events table
 * Summary: S3 completions/${ticketId}.json (written by report_completion)
 */

import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

export const dynamic = "force-dynamic";

const REGION = process.env.AWS_REGION || "us-east-1";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";
const BUCKET = process.env.ARTIFACT_BUCKET || "";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({ region: REGION });

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const workflowId = params.id;
  const agentId = req.nextUrl.searchParams.get("agentId");

  if (!agentId) {
    return NextResponse.json({ error: "agentId query param required" }, { status: 400 });
  }

  // Fetch streaming chunks and summary in parallel
  const [textChunks, summaryText] = await Promise.all([
    fetchStreamingChunks(workflowId, agentId),
    fetchSummaryFromS3(workflowId, agentId),
  ]);

  // Token-level chunks join directly — text already contains its own formatting
  const streamedOutput = textChunks.join("");

  // Always prefer S3 summary (clean markdown) over inline stream summary (garbled from buffering).
  // If stream contains a "## Summary" section, strip it and use S3 version instead.
  let cleanStream = streamedOutput;
  if (summaryText) {
    // Remove any inline summary the agent wrote (it's garbled from buffer concatenation)
    const summaryMatch = cleanStream.match(/\n*#{1,3}\s*Summary[\s\S]*$/);
    if (summaryMatch && summaryMatch.index !== undefined) {
      cleanStream = cleanStream.slice(0, summaryMatch.index).trimEnd();
    }
  }

  const fullOutput = cleanStream && summaryText
    ? cleanStream + "\n\n---\n\n## Summary\n\n" + summaryText
    : cleanStream || summaryText;

  return NextResponse.json({
    agentId,
    workflowId,
    output: fullOutput,
    chunks: textChunks.length,
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}

async function fetchStreamingChunks(workflowId: string, agentId: string): Promise<string[]> {
  const textChunks: string[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await ddb.send(new QueryCommand({
      TableName: EVENTS_TABLE,
      KeyConditionExpression: "workflowId = :wid",
      ExpressionAttributeValues: { ":wid": workflowId },
      ScanIndexForward: true,
      ExclusiveStartKey: lastKey,
    }));

    for (const item of result.Items || []) {
      const eventType = item.type as string;
      const itemAgentId = item.agentId as string | undefined;

      if (eventType === "agent_output" && itemAgentId === agentId) {
        const chunk = item.chunk as string;
        if (chunk) textChunks.push(chunk);
      }

      // Legacy format
      if (eventType === "agent.streaming" && !itemAgentId) {
        const detail = (item.detail || {}) as Record<string, unknown>;
        if (detail.agentId === agentId && detail.type === "text") {
          const content = detail.content as string;
          if (content) textChunks.push(content);
        }
      }
    }

    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return textChunks;
}

async function fetchSummaryFromS3(workflowId: string, agentId: string): Promise<string> {
  try {
    // Get ticket IDs for this agent from the workflow state (agentTasks map)
    const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
    const wfResult = await ddb.send(new QueryCommand({
      TableName: WORKFLOWS_TABLE,
      KeyConditionExpression: "workflowId = :wid",
      ExpressionAttributeValues: { ":wid": workflowId },
    }));

    const workflow = wfResult.Items?.[0];
    if (!workflow) return "";

    const agentTasks = (workflow.agentTasks || {}) as Record<string, { agentId?: string }>;
    const ticketIds = Object.entries(agentTasks)
      .filter(([, task]) => task.agentId === agentId)
      .map(([ticketId]) => ticketId);

    if (ticketIds.length === 0) return "";

    // Read completion report from S3 (try each ticket — agent may have multiple)
    for (const ticketId of ticketIds) {
      try {
        const obj = await s3.send(new GetObjectCommand({
          Bucket: BUCKET,
          Key: `completions/${ticketId}.json`,
        }));
        const body = await obj.Body?.transformToString();
        if (body) {
          const report = JSON.parse(body);
          if (report.summary) return report.summary;
        }
      } catch {
        // No completion file for this ticket — try next
      }
    }
    return "";
  } catch {
    return "";
  }
}
