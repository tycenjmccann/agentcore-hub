/**
 * GET /api/evaluations/sessions/[sessionId]
 *
 * The authoritative per-session view: EVERY evaluator verdict recorded for one
 * session, read off the bySession GSI (paged to exhaustion), plus the two
 * cross-links an operator wants next:
 *   tracesHref   → /agents/<agentId>?session_id=<sessionId>  (the agent trace
 *                  page filters on session_id; the trace API uses the same param)
 *   workflowHref → /workflow?id=<workflowId>, only when the rows carry one.
 *                  Ad-hoc invocations have no run, so the link is null there.
 *
 * Unlike /api/evaluations/results — which pages raw rows and therefore groups a
 * session only within one page — this route always returns the complete verdict
 * set for the session. 404 when the session has no rows at all.
 */

import { NextResponse } from "next/server";
import { queryBySession, type EvalResultRow } from "@/lib/eval-results";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** First non-empty value of `key` across the rows — the join fields are per-session. */
function firstOf(rows: EvalResultRow[], key: keyof EvalResultRow): string | null {
  for (const row of rows) {
    const v = str(row[key]);
    if (v) return v;
  }
  return null;
}

export async function GET(
  _req: Request,
  { params }: { params: { sessionId: string } }
) {
  const sessionId = decodeURIComponent(params.sessionId || "").trim();
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  try {
    const rows = await queryBySession(sessionId);
    if (rows.length === 0) {
      return NextResponse.json({ error: `No evaluation results for session ${sessionId}` }, { status: 404 });
    }

    const agentId = firstOf(rows, "agentId");
    const workflowId = firstOf(rows, "workflowId");

    const results = rows.map((row) => ({
      evaluator: str(row.evaluator),
      score: typeof row.score === "number" ? row.score : null,
      scoreLabel: str(row.scoreLabel),
      explanation: str(row.explanation),
      explanationTruncated: row.explanationTruncated === true,
      errorType: str(row.errorType),
      errorMessage: str(row.errorMessage),
      status: str(row.status),
      statusReason: str(row.statusReason),
      traceId: str(row.traceId),
      spanId: str(row.spanId),
      requestId: str(row.requestId),
      logGroup: str(row.logGroup),
      evaluatedAt: str(row.evaluatedAt),
      day: str(row.day),
      source: str(row.source),
    }));

    return NextResponse.json({
      sessionId,
      agentId,
      persona: firstOf(rows, "persona"),
      workflowId,
      ticketId: firstOf(rows, "ticketId"),
      evaluatedAt: results.reduce<string | null>(
        (latest, r) => (r.evaluatedAt && (!latest || r.evaluatedAt > latest) ? r.evaluatedAt : latest),
        null
      ),
      results,
      // Shape is fixed by the trace page + trace API (both take `session_id`).
      tracesHref: agentId ? `/agents/${agentId}?session_id=${encodeURIComponent(sessionId)}` : null,
      workflowHref: workflowId ? `/workflow?id=${workflowId}` : null,
      lastUpdated: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
