/**
 * GET /api/workflow/[id]/agent-output?agentId=agentcore_hub_ci_agent
 *
 * Returns the agent's output as chronological INVOCATION segments, not one
 * flattened blob and not per-ticket buckets. An agent can be dispatched many
 * times in a workflow — including repeatedly on the SAME ticket (ship-review
 * convergence rounds, retries, nudges) — so ticketId alone cannot separate
 * runs. Instead we walk the events table in time order and cut a new segment
 * at every dispatch boundary:
 *
 *   - agent.invoked / orchestrator.agent_invoked (orchestrator, per dispatch)
 *   - agent.started (runtime, at invocation entry)
 *   - a streamed chunk stamped with a different ticketId than the current segment
 *
 * Consecutive boundary markers with no text between them (invoked → started)
 * collapse into one segment. A workflow.report_completion event closes the
 * current segment and names the completions/{ticketId}.json that holds its
 * summary — so when one ticket is dispatched 6×, only the invocation that
 * actually reported completion gets the summary.
 *
 * Response:
 *   runs: [{ ticketId, invokedAt, stream, summary, startedAt, endedAt, chunks }]
 *         ← chronological (oldest first)
 *   output: string   ← legacy: all segments concatenated (back-compat)
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

interface RawSegment {
  ticketId: string;
  chunks: string[];
  invokedAt: string; // boundary-event timestamp (ISO), "" when only chunks were seen
  startedAt: string; // first chunk timestamp (ISO)
  endedAt: string; // last chunk / completion timestamp (ISO)
  completionTicket?: string; // set when report_completion fired inside this segment
}

interface AgentRun {
  ticketId: string;
  invokedAt: string;
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

  const segments = await fetchSegmentsFromStream(workflowId, agentId);

  // One summary fetch per distinct ticket (a re-dispatched ticket shares one file).
  const tickets = [
    ...new Set(
      segments.map((s) => s.completionTicket || s.ticketId).filter(Boolean)
    ),
  ];
  const summaryByTicket = new Map<string, string>();
  await Promise.all(
    tickets.map(async (t) => summaryByTicket.set(t, await fetchSummaryFromS3(t)))
  );

  // Tickets whose summary is claimed by the segment that reported completion —
  // other same-ticket segments (earlier rounds/holds) must not show it.
  const claimed = new Set(
    segments.filter((s) => s.completionTicket).map((s) => s.completionTicket as string)
  );

  const runs: AgentRun[] = segments.map((s, i) => {
    const streamedOutput = s.chunks.join("");

    let summary = "";
    if (s.completionTicket) {
      summary = summaryByTicket.get(s.completionTicket) || "";
    } else if (s.ticketId && !claimed.has(s.ticketId)) {
      // Legacy runs without report_completion journey events: attach the
      // ticket's summary to its LAST segment only.
      const laterSameTicket = segments
        .slice(i + 1)
        .some((o) => o.ticketId === s.ticketId);
      if (!laterSameTicket) summary = summaryByTicket.get(s.ticketId) || "";
    }

    // The clean S3 summary supersedes the inline "## Summary" the agent streamed
    // at the end (garbled by buffer concatenation) — strip the LAST such heading
    // to end-of-segment. First-match stripping ate everything after an early
    // mid-run Summary heading.
    let cleanStream = streamedOutput;
    if (summary) {
      const headings = [...cleanStream.matchAll(/\n*#{1,3}\s*Summary\b/g)];
      const last = headings[headings.length - 1];
      if (last && last.index !== undefined) {
        cleanStream = cleanStream.slice(0, last.index).trimEnd();
      }
    }

    return {
      ticketId: s.ticketId,
      invokedAt: s.invokedAt,
      stream: cleanStream,
      summary,
      startedAt: s.startedAt || s.invokedAt,
      endedAt: s.endedAt,
      chunks: s.chunks.length,
    };
  });

  // Legacy single-string output: segments concatenated with clear separators, so
  // any older consumer still shows everything (just without the per-run affordances).
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

/** Walk the events table once in time order, cutting a new segment at every
 *  dispatch boundary and appending this agent's text chunks to the current one.
 *  Chunks with no ticketId (operator echoes, older events) join the current
 *  segment — chronology places them correctly. */
async function fetchSegmentsFromStream(
  workflowId: string,
  agentId: string
): Promise<RawSegment[]> {
  const segments: RawSegment[] = [];
  let current: RawSegment | null = null;

  const newSegment = (ticketId: string, invokedAt: string): RawSegment => {
    const seg: RawSegment = { ticketId, chunks: [], invokedAt, startedAt: "", endedAt: "" };
    segments.push(seg);
    return seg;
  };

  const boundary = (ticketId: string, ts: string) => {
    // invoked → started (and orchestrator + runtime doubles) arrive back-to-back
    // for ONE dispatch — only cut when the current segment has content.
    if (current && current.chunks.length === 0 && !current.completionTicket) {
      if (!current.ticketId && ticketId) current.ticketId = ticketId;
      if (!current.invokedAt && ts) current.invokedAt = ts;
      return;
    }
    current = newSegment(ticketId, ts);
  };

  const push = (ticketId: string, chunk: string, ts: string) => {
    if (!chunk) return;
    if (!current) {
      current = newSegment(ticketId, "");
    } else if (ticketId && current.ticketId && ticketId !== current.ticketId) {
      // Chunk stamped with a different ticket = a dispatch whose boundary event
      // we never saw. Cut here so tickets can't bleed into each other.
      current = newSegment(ticketId, "");
    } else if (ticketId && !current.ticketId) {
      current.ticketId = ticketId;
    }
    current.chunks.push(chunk);
    if (!current.startedAt || (ts && ts < current.startedAt)) current.startedAt = ts;
    if (ts && ts > current.endedAt) current.endedAt = ts;
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
      const detail = (item.detail || {}) as Record<string, unknown>;

      // Dispatch boundaries — orchestrator stamps ticketId; runtime's
      // agent.started doesn't (the empty-segment merge above fills it in).
      if (
        eventType === "agent.invoked" ||
        eventType === "orchestrator.agent_invoked" ||
        eventType === "agent.started"
      ) {
        const aid = (detail.agentId as string) || (detail.assignee as string);
        if (aid === agentId) boundary((detail.ticketId as string) || "", ts);
        continue;
      }

      // Completion — names the ticket whose completions/{id}.json belongs to
      // THIS segment (a re-dispatched ticket completes only once).
      if (eventType === "workflow.report_completion" && detail.agentId === agentId) {
        // `current` always aliases the last pushed segment; index into the
        // array so TS's closure-blind narrowing of `current` doesn't bite.
        const seg = segments[segments.length - 1];
        if (seg) {
          seg.completionTicket = (detail.ticketId as string) || seg.ticketId;
          if (ts && ts > seg.endedAt) seg.endedAt = ts;
        }
        continue;
      }

      // Current format: top-level agent_output row
      if (eventType === "agent_output" && (item.agentId as string) === agentId) {
        push((item.ticketId as string) || "", item.chunk as string, ts);
        continue;
      }

      // agent.streaming text (the live pipeline format) — ticketId is in detail
      if (eventType === "agent.streaming") {
        if (detail.agentId === agentId && detail.type === "text") {
          push((detail.ticketId as string) || "", detail.content as string, ts);
        }
      }
    }

    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  // Drop empty boundary-noise segments, but keep the last one (a dispatch that
  // just started — or died silently — should still show its "invoked" marker).
  return segments.filter(
    (s, i) => s.chunks.length > 0 || s.completionTicket || i === segments.length - 1
  );
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
