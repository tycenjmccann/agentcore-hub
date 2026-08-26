/**
 * GET  /api/cloud-code/sessions          → list sessions (sidebar)
 * POST /api/cloud-code/sessions          → create a new session (no turn yet)
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { listSessions, putSession } from "@/lib/cloud-code/sessions";
import { getIdentity } from "@/lib/auth/identity";
import type { CloudCodeSession, CloudCodeCli } from "@/lib/cloud-code/types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    // Identity is stamped by middleware; AUTH_MODE=none → "default" (legacy).
    // Sidebar is tenant-scoped: colleagues in a tenant share the session list.
    const { tenantId } = getIdentity(request);
    let sessions = await listSessions(tenantId);
    // Workflow board: link each agent task to the coding session(s) it ran.
    const workflowId = request.nextUrl.searchParams.get("workflowId");
    const agentId = request.nextUrl.searchParams.get("agentId");
    if (workflowId) sessions = sessions.filter((s) => s.workflowId === workflowId);
    if (agentId) sessions = sessions.filter((s) => s.agentId === agentId);
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
    const { userId, tenantId } = getIdentity(request);
    const body = await request.json().catch(() => ({}));
    const cli: CloudCodeCli = body.cli === "codex" ? "codex" : "claude";
    const repo: string | undefined = body.repo?.trim() || undefined;
    const title: string = (body.title?.trim() || "New session").slice(0, 120);

    // runtimeSessionId must be >= 33 chars for AgentCore; uuid (no dashes) = 32 + prefix.
    const sessionId = `cc-${randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();

    const session: CloudCodeSession = {
      sessionId,
      userId,
      tenantId,
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
