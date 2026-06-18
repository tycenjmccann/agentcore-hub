/**
 * GET    /api/cloud-code/sessions/[id]   → full session (turns)
 * DELETE /api/cloud-code/sessions/[id]   → forget the session row
 *
 * Note: DELETE only removes the local session record. The runtime's
 * /mnt/workspace for that runtimeSessionId ages out on the runtime's own idle
 * lifecycle; we don't (yet) actively reap it.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, deleteSession } from "@/lib/cloud-code/sessions";

export const dynamic = "force-dynamic";

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
