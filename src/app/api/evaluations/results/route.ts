/**
 * GET /api/evaluations/results?agentId=&persona=&workflowId=&from=&to=&cursor=&limit=
 *
 * The paginated verdict list: one row per evaluator in agentcore-hub-eval-results,
 * collapsed to one entry per session for display. Newest first.
 *
 * PAGING CONTRACT (read before changing this): pages are DynamoDB
 * `LastEvaluatedKey` pages over the raw ROW stream, and sessions are grouped
 * WITHIN a page. A session with several evaluator rows can therefore straddle a
 * page boundary and appear — partially — on both pages. That is deliberate: the
 * alternative (buffering until a session is provably complete) needs an unbounded
 * read-ahead over a table that grows with traffic. The authoritative per-session
 * view is GET /api/evaluations/sessions/[sessionId], which reads the whole
 * bySession partition; the UI must link to it rather than treat a page entry's
 * evaluator set as complete. `partial: true` marks the groups where a straddle is
 * possible: the last group of a page that has a next cursor, and the first group
 * of any page reached BY a cursor.
 */

import { NextRequest, NextResponse } from "next/server";
import { isDayKey, queryResults, type EvalResultRow } from "@/lib/eval-results";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface SessionEntry {
  sessionId: string;
  agentId: string | null;
  persona: string | null;
  workflowId: string | null;
  ticketId: string | null;
  /** Latest verdict timestamp in this group — what the list sorts by. */
  evaluatedAt: string | null;
  evaluators: Record<string, { score: number | null; scoreLabel: string | null; status: string | null }>;
  resultCount: number;
  /** This group may straddle a page boundary — see the paging contract above. */
  partial: boolean;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const agentId = (params.get("agentId") || "").trim();
  const persona = (params.get("persona") || "").trim();
  const workflowId = (params.get("workflowId") || "").trim();
  const from = (params.get("from") || "").trim();
  const to = (params.get("to") || "").trim();
  const cursor = params.get("cursor");
  const limitParam = params.get("limit");

  if (!agentId && !workflowId) {
    return NextResponse.json({ error: "agentId or workflowId is required" }, { status: 400 });
  }
  for (const [name, value] of [["from", from], ["to", to]] as const) {
    if (value && !isDayKey(value)) {
      return NextResponse.json({ error: `Invalid ${name}: expected a UTC day, YYYY-MM-DD` }, { status: 400 });
    }
  }
  if (limitParam !== null && !/^\d+$/.test(limitParam.trim())) {
    return NextResponse.json({ error: "Invalid limit: expected a positive integer" }, { status: 400 });
  }

  try {
    // A garbage cursor decodes to undefined (first page) instead of throwing.
    const page = await queryResults({
      agentId: agentId || null,
      persona: persona || null,
      workflowId: workflowId || null,
      from: from || null,
      to: to || null,
      cursor,
      limit: limitParam === null ? null : Number(limitParam),
    });

    const sessions = groupBySession(page.items, {
      hasNextPage: page.cursor !== null,
      // A cursor means this is not the first page, so the leading group may be
      // the tail of the previous page's last session.
      hasPrevPage: Boolean(cursor),
    });

    return NextResponse.json({
      sessions,
      cursor: page.cursor,
      index: page.index,
      lastUpdated: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Collapse a page of rows into per-session entries, preserving row order. */
function groupBySession(
  rows: EvalResultRow[],
  edges: { hasNextPage: boolean; hasPrevPage: boolean }
): SessionEntry[] {
  const bySession = new Map<string, SessionEntry>();

  for (const row of rows) {
    const sessionId = str(row.sessionId);
    if (!sessionId) continue;
    let entry = bySession.get(sessionId);
    if (!entry) {
      entry = {
        sessionId,
        agentId: str(row.agentId),
        persona: str(row.persona),
        workflowId: str(row.workflowId),
        ticketId: str(row.ticketId),
        evaluatedAt: str(row.evaluatedAt),
        evaluators: {},
        resultCount: 0,
        partial: false,
      };
      bySession.set(sessionId, entry);
    }
    entry.resultCount += 1;
    entry.workflowId ||= str(row.workflowId);
    entry.ticketId ||= str(row.ticketId);
    entry.persona ||= str(row.persona);
    const at = str(row.evaluatedAt);
    if (at && (!entry.evaluatedAt || at > entry.evaluatedAt)) entry.evaluatedAt = at;
    const evaluator = str(row.evaluator);
    if (evaluator) {
      entry.evaluators[evaluator] = {
        score: typeof row.score === "number" ? row.score : null,
        scoreLabel: str(row.scoreLabel),
        status: str(row.status),
      };
    }
  }

  const entries = [...bySession.values()];
  // Only the groups at the page edges can be cut in half by a page boundary.
  if (entries.length) {
    if (edges.hasNextPage) entries[entries.length - 1].partial = true;
    if (edges.hasPrevPage) entries[0].partial = true;
  }
  return entries;
}
