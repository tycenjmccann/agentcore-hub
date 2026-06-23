/**
 * GET    /api/cloud-code/sessions/[id]   → full session (turns)
 * DELETE /api/cloud-code/sessions/[id]   → forget the session row
 *
 * Note: DELETE only removes the local session record. The runtime's
 * /mnt/workspace for that runtimeSessionId ages out on the runtime's own idle
 * lifecycle; we don't (yet) actively reap it.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, putSession, deleteSession } from "@/lib/cloud-code/sessions";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/cloud-code/sessions/[id]  → small session mutations.
 * Today: { clearPendingSeed: true } — the terminal calls this once it has typed
 * the resume seed, so reopening the terminal re-attaches via `claude --resume`
 * WITHOUT re-typing the seed (which otherwise stacks in the transcript).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getSession(params.id);
    if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    const body = await request.json().catch(() => ({}));
    if (body.clearPendingSeed) session.pendingSeed = undefined;
    session.updatedAt = new Date().toISOString();
    await putSession(session);
    return NextResponse.json({ session });
  } catch (err) {
    console.error("[cloud-code] patch error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getSession(params.id);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ session });
  } catch (err) {
    console.error("[cloud-code] get error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await deleteSession(params.id);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error("[cloud-code] delete error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
