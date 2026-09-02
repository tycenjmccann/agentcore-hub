/**
 * GET /api/workflow/[id]/agent-output?agentId=agentcore_hub_ci_agent
 *
 * Returns per-RUN output for an agent, not one flattened blob. An agent can be
 * dispatched many times in a workflow (each dispatch = its own ticket: CI here
 * ran 7×, TEAM-3622/3692/3697/3701/3704/3706/3709). Every streaming chunk is
 * stamped with its ticketId (runtime main.py:2497), and every run writes its
 * own completions/{ticketId}.json summary — so runs are fully separable.
 *
 * Response:
 *   runs: [{ ticketId, stream, summary, startedAt, endedAt, chunks }]  ← ascending by startedAt
 *   output: string   ← legacy: all runs concatenated (back-compat)
 *
 * Streaming chunks: agentcore-hub-events table (agent_output / agent.streaming text)
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

interface RawRun {
  ticketId: string;
  chunks: string[];
  startedAt: string; // first chunk timestamp (ISO)
  endedAt: string; // last chunk timestamp (ISO)
}

interface AgentRun {
  ticketId: string;
  stream: string;
  summary: string;
  startedAt: string;
  endedAt: string;
  chunks: number;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const workflowId = params.id;
  const agentId = req.nextUrl.searchParams.get("agentId");

  if (!agentId) {
    return NextResponse.json({ error: "agentId query param required" }, { status: 400 });
  }

  const rawRuns = await fetchRunsFromStream(workflowId, agentId);

  // Fetch each run's own summary in parallel (one S3 object per run ticket).
  const summaries = await Promise.all(
    rawRuns.map((r) => fetchSummaryFromS3(r.ticketId))
  );

  const runs: AgentRun[] = rawRuns.map((r, i) => {
    const streamedOutput = r.chunks.join("");
    const summary = summaries[i];

    // The clean S3 summary supersedes any inline "## Summary" the agent streamed
    // (the streamed one is garbled by buffer concatenation) — strip it from the stream.
    let cleanStream = streamedOutput;
    if (summary) {
      const m = cleanStream.match(/\n*#{1,3}\s*Summary[\s\S]*$/);
      if (m && m.index !== undefined) cleanStream = cleanStream.slice(0, m.index).trimEnd();
    }

    return {
      ticketId: r.ticketId,
      stream: cleanStream,
      summary,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      chunks: r.chunks.length,
    };
  });

  // Legacy single-string output: runs concatenated with clear separators, so any
  // older consumer still shows everything (just without the per-run affordances).
  const output = runs
    .map((r) => {
      const head = r.stream || "";
      const tail = r.summary ? `\n\n---\n\n## Summary\n\n${r.summary}` : "";
      return (head + tail).trim();
    })
    .filter(Boolean)
    .join("\n\n---\n\n");

  return NextResponse.json(
    { agentId, workflowId, runs, output, chunks: runs.reduce((n, r) => n + r.chunks, 0) },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/** Walk the events table once, bucketing this agent's text chunks by the
 *  ticketId stamped on each event. Runs are ordered by first-chunk time. */
async function fetchRunsFromStream(workflowId: string, agentId: string): Promise<RawRun[]> {
  const byTicket = new Map<string, RawRun>();
  // Chunks with no ticketId (older events) collapse into one implicit run so
  // nothing is dropped; keyed by "" and sorted first.
  const push = (ticketId: string, chunk: string, ts: string) => {
    if (!chunk) return;
    let run = byTicket.get(ticketId);
    if (!run) {
      run = { ticketId, chunks: [], startedAt: ts, endedAt: ts };
      byTicket.set(ticketId, run);
    }
    run.chunks.push(chunk);
    if (ts && ts < run.startedAt) run.startedAt = ts;
    if (ts && ts > run.endedAt) run.endedAt = ts;
  };

  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: EVENTS_TABLE,
        KeyConditionExpression: "workflowId = :wid",
        ExpressionAttributeValues: { ":wid": workflowId },
        ScanIndexForward: true,
        ExclusiveStartKey: lastKey,
      })
    );

    for (const item of result.Items || []) {
      const eventType = item.type as string;
      const ts = (item.timestamp as string) || "";

      // Current format: top-level agent_output row
      if (eventType === "agent_output" && (item.agentId as string) === agentId) {
        push((item.ticketId as string) || "", item.chunk as string, ts);
        continue;
      }

      // agent.streaming text (the live pipeline format) — ticketId is in detail
      if (eventType === "agent.streaming") {
        const detail = (item.detail || {}) as Record<string, unknown>;
        if (detail.agentId === agentId && detail.type === "text") {
          push((detail.ticketId as string) || "", detail.content as string, ts);
        }
      }
    }

    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return [...byTicket.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

async function fetchSummaryFromS3(ticketId: string): Promise<string> {
  if (!ticketId || !BUCKET) return "";
  try {
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: `completions/${ticketId}.json` })
    );
    const body = await obj.Body?.transformToString();
    if (!body) return "";
    const report = JSON.parse(body);
    return report.summary || "";
  } catch {
    return ""; // no completion file for this run (e.g. still running)
  }
}
