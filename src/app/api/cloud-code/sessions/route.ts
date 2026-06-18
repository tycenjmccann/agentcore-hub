/**
 * GET  /api/cloud-code/sessions          → list sessions (sidebar)
 * POST /api/cloud-code/sessions          → create a new session (no turn yet)
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { listSessions, putSession, DEFAULT_USER_ID } from "@/lib/cloud-code/sessions";
import type { CloudCodeSession, CloudCodeCli } from "@/lib/cloud-code/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sessions = await listSessions(DEFAULT_USER_ID);
    return NextResponse.json({ sessions });
  } catch (err) {
    console.error("[cloud-code] list error:", err);
    return NextResponse.json(
      { error: (err as Error).message, sessions: [] },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const cli: CloudCodeCli = body.cli === "codex" ? "codex" : "claude";
    const repo: string | undefined = body.repo?.trim() || undefined;
    const title: string = (body.title?.trim() || "New session").slice(0, 120);

    // runtimeSessionId must be >= 33 chars for AgentCore; uuid (no dashes) = 32 + prefix.
    const sessionId = `cc-${randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();

    const session: CloudCodeSession = {
      sessionId,
      userId: DEFAULT_USER_ID,
      title,
      cli,
      repo,
      createdAt: now,
      updatedAt: now,
      turns: [],
    };
    await putSession(session);
    return NextResponse.json({ session }, { status: 201 });
  } catch (err) {
    console.error("[cloud-code] create error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
