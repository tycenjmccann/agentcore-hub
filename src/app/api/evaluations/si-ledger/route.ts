/**
 * GET /api/evaluations/si-ledger            — every tracked pattern + hero tiles
 * GET /api/evaluations/si-ledger?patternKey= — one pattern's full history
 *
 * The read side of the SI ledger (agentcore-hub-si-ledger). READ-ONLY by design:
 * there is no POST/PUT/DELETE here and there must never be one. Rows are authored
 * by the loop itself — the WM toolkit on ANALYZE/SYNTHESIZE, prd-submitter when a
 * PRD becomes a run, workflow-analyzer when that run ends — so a hand-edit from
 * the console would be a number nobody can reproduce. The whole point of the
 * ledger is that every status and every verdict is traceable to a writer that
 * computed it arithmetically.
 *
 * The list response is the panel's entire payload (tiles + rows) in one request:
 * the table is tens of rows, so paging it would add a cursor contract for no gain.
 * The drill-down exists because a single row's `occurrences[]` can hold dozens of
 * sightings and the list view only renders counts.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getLedgerRow,
  isReservedKey,
  isValidPatternKey,
  latestAttempt,
  latestVerdict,
  listLedgerRows,
  summarizeLedger,
} from "@/lib/si-ledger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const patternKey = (req.nextUrl.searchParams.get("patternKey") || "").trim();

  if (patternKey) {
    // Reject a malformed key before spending a GetItem, and never let a caller
    // address a reserved `#…` bookkeeping row through the pattern API.
    if (isReservedKey(patternKey) || !isValidPatternKey(patternKey)) {
      return NextResponse.json({ error: "Invalid patternKey" }, { status: 400 });
    }
    try {
      const row = await getLedgerRow(patternKey);
      if (!row) {
        return NextResponse.json({ error: `No ledger row for ${patternKey}` }, { status: 404 });
      }
      return NextResponse.json({
        row,
        latestVerdict: latestVerdict(row),
        latestAttempt: latestAttempt(row),
        lastUpdated: new Date().toISOString(),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  try {
    const { rows, coverage } = await listLedgerRows();
    return NextResponse.json({
      summary: summarizeLedger(rows, coverage),
      // Flattened for the table: the panel renders counts and the newest
      // attempt/verdict, so it does not need the full history per row.
      patterns: rows.map((row) => ({
        patternKey: row.patternKey,
        title: row.title ?? null,
        status: row.status ?? null,
        firstSeen: row.firstSeen ?? null,
        lastSeen: row.lastSeen ?? null,
        occurrences: (row.occurrences || []).length,
        attempts: (row.attempts || []).length,
        source: row.source ?? null,
        latestAttempt: latestAttempt(row),
        latestVerdict: latestVerdict(row),
        expected: row.expected || [],
      })),
      coverage,
      lastUpdated: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
