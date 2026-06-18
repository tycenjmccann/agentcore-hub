/**
 * POST /api/cloud-code/sessions/[id]/message  → run one coding turn
 *
 * Invokes the coding runtime with the same runtimeSessionId (warm microVM) and
 * the session's stored claudeSessionId (resumes the CLI conversation), persists
 * the user + agent turns, and returns the agent reply.
 *
 * Request/response today — the reply returns when the CLI finishes the turn.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, putSession, DEFAULT_USER_ID } from "@/lib/cloud-code/sessions";
import { invokeCodingTurn, codingRuntimeConfigured } from "@/lib/cloud-code/runtime";
import { currentConfigVersion } from "@/lib/cloud-code/config-store";
import type { CloudCodeTurn } from "@/lib/cloud-code/types";

export const dynamic = "force-dynamic";
// A coding turn can be long; allow the route plenty of headroom.
export const maxDuration = 800;

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!codingRuntimeConfigured()) {
    return NextResponse.json(
      { error: "Coding runtime not configured (CODING_AGENT_RUNTIME_ARN unset)" },
      { status: 503 }
    );
  }

  const session = await getSession(params.id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const prompt: string = (body.prompt || "").trim();
  if (!prompt) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }

  const userTurn: CloudCodeTurn = { role: "user", text: prompt, at: new Date().toISOString() };

  try {
    const result = await invokeCodingTurn({
      sessionId: session.sessionId,
      prompt,
      cli: session.cli,
      repo: session.repo,
      claudeSessionId: session.claudeSessionId,
      userId: session.userId || DEFAULT_USER_ID,
      configVersion: await currentConfigVersion(session.userId || DEFAULT_USER_ID),
      region: request.nextUrl.searchParams.get("region") || undefined,
    });

    const agentTurn: CloudCodeTurn = {
      role: "agent",
      text: result.response,
      at: new Date().toISOString(),
    };

    session.turns.push(userTurn, agentTurn);
    if (result.claudeSessionId) session.claudeSessionId = result.claudeSessionId;
    // First user message becomes the title if it's still the default.
    if (session.title === "New session") session.title = prompt.slice(0, 80);
    session.updatedAt = new Date().toISOString();
    await putSession(session);

    return NextResponse.json({ reply: agentTurn, session });
  } catch (err) {
    // Persist the user turn even on failure so the conversation isn't lost.
    session.turns.push(userTurn);
    session.updatedAt = new Date().toISOString();
    await putSession(session).catch(() => {});
    console.error("[cloud-code] turn error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
