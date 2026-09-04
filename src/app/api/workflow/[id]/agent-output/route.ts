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
  /** Summary snapshot from THIS segment's report_completion journey event
   *  (truncated at source). completions/{ticket}.json is overwritten on every
   *  completion, so for a re-completed ticket only the LAST segment may use the
   *  S3 file — earlier rounds fall back to their own event snapshot. */
  eventSummary?: string;
  /** Which boundary-event kinds this (still-empty) segment has absorbed. One
   *  dispatch emits each kind at most once (agent.invoked → orchestrator.
   *  agent_invoked → agent.started), so a REPEATED kind = a new dispatch —
   *  that's how a silently-dead invocation's retry cuts a fresh segment
   *  instead of being folded into the empty one. */
  boundaryKinds: Set<string>;
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

  // Tickets whose summary is claimed by a completing segment — other
  // same-ticket segments (earlier rounds/holds) must not show it.
  const claimed = new Set(
    segments.filter((s) => s.completionTicket).map((s) => s.completionTicket as string)
  );

  const runs: AgentRun[] = segments.map((s, i) => {
    const streamedOutput = s.chunks.join("");

    let summary = "";
    if (s.completionTicket) {
      // completions/{ticket}.json is OVERWRITTEN on re-completion (review
      // rejection reopens a ticket), so only the ticket's LAST completing
      // segment may use the S3 file; earlier rounds keep their own event
      // snapshot rather than displaying the final round's result.
      const laterCompletion = segments
        .slice(i + 1)
        .some((o) => o.completionTicket === s.completionTicket);
      summary = laterCompletion
        ? s.eventSummary || ""
        : summaryByTicket.get(s.completionTicket) || s.eventSummary || "";
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
 *  dispatch boundary and appending this agent's text chunks to that dispatch's
 *  segment. One ACTIVE segment per ticket — the orchestrator can dispatch two
 *  sibling tickets to the same assignee concurrently, so their stamped chunks
 *  interleave and must not cut each other. Chunks with no ticketId (operator
 *  echoes from older runtimes, legacy events) join the last-touched segment —
 *  chronology places them correctly. */
async function fetchSegmentsFromStream(
  workflowId: string,
  agentId: string
): Promise<RawSegment[]> {
  const segments: RawSegment[] = [];
  const active = new Map<string, RawSegment>(); // ticketId → its in-flight segment
  let lastTouched: RawSegment | null = null; // target for unstamped chunks
  // publishEvent double-writes (direct DDB + EventBridge copy) share one
  // timestamp — dedupe boundary/completion events on (kind, ticket, ts).
  const seenMarkers = new Set<string>();

  const newSegment = (ticketId: string, invokedAt: string): RawSegment => {
    const seg: RawSegment = {
      ticketId, chunks: [], invokedAt, startedAt: "", endedAt: "",
      boundaryKinds: new Set(),
    };
    segments.push(seg);
    return seg;
  };

  const isMergeable = (s: RawSegment | undefined | null, kind: string) =>
    !!s && s.chunks.length === 0 && !s.completionTicket && !s.boundaryKinds.has(kind);

  const boundary = (kind: string, ticketId: string, ts: string) => {
    // The boundary kinds of ONE dispatch (agent.invoked → orchestrator.
    // agent_invoked → agent.started) each fire at most once, so an empty
    // segment absorbs a NEW kind — but a REPEATED kind is a re-dispatch (e.g.
    // the retry of a silently-dead invocation) and cuts a fresh segment, so
    // the dead one stays visible instead of being folded into its retry.
    const cur = ticketId
      ? active.get(ticketId)
      // Unstamped kinds (runtime's agent.started carries no ticket): merge into
      // the most recent empty segment still missing this kind.
      : [...segments].reverse().find((s) => isMergeable(s, kind));
    if (isMergeable(cur, kind)) {
      const seg = cur as RawSegment;
      seg.boundaryKinds.add(kind);
      if (!seg.invokedAt && ts) seg.invokedAt = ts;
      if (ticketId && !seg.ticketId) {
        seg.ticketId = ticketId;
        active.set(ticketId, seg);
      }
      return;
    }
    // A stamped boundary may claim an empty unticketed segment (agent.started
    // that arrived before the orchestrator's stamped events).
    if (ticketId) {
      const orphan = [...segments].reverse().find((s) => !s.ticketId && isMergeable(s, kind));
      if (orphan) {
        orphan.ticketId = ticketId;
        orphan.boundaryKinds.add(kind);
        if (!orphan.invokedAt && ts) orphan.invokedAt = ts;
        active.set(ticketId, orphan);
        return;
      }
    }
    const seg = newSegment(ticketId, ts);
    seg.boundaryKinds.add(kind);
    if (ticketId) active.set(ticketId, seg);
  };

  const push = (ticketId: string, chunk: string, ts: string) => {
    if (!chunk) return;
    let seg = ticketId ? active.get(ticketId) : lastTouched;
    if (!seg && ticketId) {
      // First stamped chunk after an unticketed boundary — adopt that segment.
      seg = [...segments].reverse().find((s) => !s.ticketId && s.chunks.length === 0 && !s.completionTicket);
      if (seg) {
        seg.ticketId = ticketId;
        active.set(ticketId, seg);
      }
    }
    if (!seg) {
      seg = newSegment(ticketId, "");
      if (ticketId) active.set(ticketId, seg);
    }
    seg.chunks.push(chunk);
    if (!seg.startedAt || (ts && ts < seg.startedAt)) seg.startedAt = ts;
    if (ts && ts > seg.endedAt) seg.endedAt = ts;
    lastTouched = seg;
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
        if (aid === agentId) {
          const tid = (detail.ticketId as string) || "";
          const marker = `${eventType}#${tid}#${ts}`;
          if (!seenMarkers.has(marker)) {
            seenMarkers.add(marker);
            boundary(eventType, tid, ts);
          }
        }
        continue;
      }

      // Completion — closes THIS ticket's in-flight segment and snapshots the
      // event's summary for it (the S3 file gets overwritten on re-completion).
      if (eventType === "workflow.report_completion" && detail.agentId === agentId) {
        const tid = (detail.ticketId as string) || "";
        const marker = `completion#${tid}#${ts}`;
        if (seenMarkers.has(marker)) continue;
        seenMarkers.add(marker);
        const seg = (tid && active.get(tid)) || lastTouched || segments[segments.length - 1];
        if (seg) {
          seg.completionTicket = tid || seg.ticketId;
          seg.eventSummary = (detail.summary as string) || "";
          if (ts && ts > seg.endedAt) seg.endedAt = ts;
          if (seg.ticketId) active.delete(seg.ticketId); // a later dispatch = new segment
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
