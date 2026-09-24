/**
 * POST /api/models/registry/rollback (TEAM-4997) — undo the last routing change.
 *
 * `config/models.prev.json` is written by the save sequence whenever routing
 * changes, so it always holds the document that was live before the current one.
 * Rollback re-enters the SAME save sequence with that document as the body: it
 * validates, it takes the version forward (never backward — history is append
 * only), it writes a new prev, it reprojects pricing and it repins the harnesses.
 *
 * Only one step back. A second rollback undoes the first, because the prev
 * written by rollback #1 is the document rollback #1 replaced.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAdmin } from "@/lib/auth/identity";
import { loadPreviousModelsRegistry } from "@/lib/models-registry";
import { assertSameOrigin } from "@/lib/models/request-guard";
import { NO_STORE, actorFor, runSaveSequence } from "../save";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAdmin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403, ...NO_STORE });
  const crossOrigin = assertSameOrigin(req);
  if (crossOrigin) return crossOrigin;

  let body: { baseVersion?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400, ...NO_STORE });
  }

  const baseVersion = Number(body.baseVersion);
  if (!Number.isFinite(baseVersion)) {
    return NextResponse.json({ error: "bad_request", detail: "baseVersion is required" }, { status: 400, ...NO_STORE });
  }

  const previous = await loadPreviousModelsRegistry();
  if (!previous) {
    return NextResponse.json({ error: "no_previous" }, { status: 404, ...NO_STORE });
  }

  console.log(`[models] registry.rollback base=${baseVersion} to=${previous.version}`);
  return runSaveSequence({
    candidate: previous,
    baseVersion,
    actor: actorFor(req),
    reason: `rollback-to-${previous.version}`,
    // Every target in prev was live routing when prev was written, so a rollback
    // adopts nothing — and a gate that could refuse one removes the recovery path.
    adoptionGate: false,
  });
}
