/**
 * POST /api/cloud-code/sessions/[id]/warm  → pre-warm a ported session's microVM
 *
 * Called by the port-session MCP right after it uploads the transcript to S3.
 * Fires a setup-only invoke (clone + checkout branch + install transcript, no
 * CLI run) so the workspace is hot by the time the user opens the deep link.
 * Best-effort: returns 202 immediately and lets the warm run in the background;
 * a failure here just means the first real turn does the clone itself.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, DEFAULT_USER_ID } from "@/lib/cloud-code/sessions";
import { warmCodingSession, codingRuntimeConfigured } from "@/lib/cloud-code/runtime";
import { currentConfigVersion } from "@/lib/cloud-code/config-store";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!codingRuntimeConfigured()) {
    return NextResponse.json({ error: "Coding runtime not configured" }, { status: 503 });
  }
  const session = await getSession(params.id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  // Only ported sessions (with a transcript to install) need pre-warming.
  if (!session.resumeTranscriptKey) {
    return NextResponse.json({ warmed: false, reason: "nothing to warm" });
  }

  const region = request.nextUrl.searchParams.get("region") || undefined;
  const userId = session.userId || DEFAULT_USER_ID;
  const configVersion = await currentConfigVersion(userId);
  try {
    await warmCodingSession({
      sessionId: session.sessionId,
      cli: session.cli,
      repo: session.repo,
      branch: session.branch,
      resumeTranscriptKey: session.resumeTranscriptKey,
      resumeSessionId: session.claudeSessionId,
      userId,
      configVersion,
      region,
    });
    return NextResponse.json({ warmed: true });
  } catch (err) {
    // Non-fatal — the first turn will clone on demand.
    console.error("[cloud-code] warm error:", err);
    return NextResponse.json({ warmed: false, error: (err as Error).message }, { status: 200 });
  }
}
