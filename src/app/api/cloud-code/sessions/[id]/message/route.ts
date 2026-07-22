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
import { getOwnedSession, mutateSession, STOP_MARKER, DEFAULT_USER_ID, DEFAULT_TENANT_ID } from "@/lib/cloud-code/sessions";
import { invokeCodingTurn, invokeCodingTurnStream, codingRuntimeConfigured } from "@/lib/cloud-code/runtime";
import { currentConfigVersion } from "@/lib/cloud-code/config-store";
import { cloneTokenForUser } from "@/lib/cloud-code/github-app";
import { getIdentity } from "@/lib/auth/identity";
import { sseData } from "@/lib/sse";
import type { CloudCodeTurn, CloudCodeSession } from "@/lib/cloud-code/types";

export const dynamic = "force-dynamic";
// A coding turn can be long; allow the route plenty of headroom.
export const maxDuration = 800;

/**
 * Persist a completed/errored turn without clobbering a concurrent /stop write.
 * Goes through mutateSession (optimistic-concurrency read-modify-write) so a
 * late stream completion and the /stop persist for the SAME interrupted turn
 * serialize deterministically instead of last-writer-wins. If /stop already
 * recorded this turn (its agent turn starts with STOP_MARKER), we opt out.
 */
async function persistTurn(
  sessionId: string,
  snapshot: CloudCodeSession,
  userTurn: CloudCodeTurn,
  agentText: string | null,
  prompt: string
): Promise<CloudCodeSession | null> {
  return mutateSession(sessionId, (fresh) => {
    const last = fresh.turns[fresh.turns.length - 1];
    // /stop landed first for this turn — don't overwrite its record.
    if (last?.role === "agent" && last.text.startsWith(STOP_MARKER)) return null;
    const now = new Date().toISOString();
    if (!(last?.role === "user" && last.text === userTurn.text)) {
      fresh.turns.push(userTurn);
    }
    if (agentText !== null) fresh.turns.push({ role: "agent", text: agentText, at: now });
    if (fresh.title === "New session") fresh.title = prompt.slice(0, 80);
    if (snapshot.claudeSessionId) fresh.claudeSessionId = snapshot.claudeSessionId;
    fresh.pendingSeed = undefined;
    fresh.updatedAt = now;
    return fresh;
  });
}

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

  const { tenantId } = getIdentity(request);
  const session = await getOwnedSession(params.id, tenantId);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const prompt: string = (body.prompt || "").trim();
  if (!prompt) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }
  // For the ported seed, the prompt is a huge transcript; displayPrompt is the
  // short label we persist/render in the chat instead of the raw seed.
  const displayPrompt: string = (body.displayPrompt || "").trim();

  const userTurn: CloudCodeTurn = {
    role: "user",
    text: displayPrompt || prompt,
    at: new Date().toISOString(),
  };
  const wantStream =
    request.nextUrl.searchParams.get("stream") === "1" && session.cli === "claude";
  const userId = session.userId || DEFAULT_USER_ID;
  const sessionTenant = session.tenantId || DEFAULT_TENANT_ID;
  const configVersion = await currentConfigVersion({ tenantId: sessionTenant, userId });
  const region = request.nextUrl.searchParams.get("region") || undefined;

  // Mint a short-lived GitHub App clone token for the session owner, scoped to
  // this repo. Absent when the App isn't set up or the owner hasn't connected —
  // the runtime then falls back to GITHUB_PAT. `connected` tells the runtime NOT
  // to fall back when a connected owner's scoped mint was denied.
  const { token: githubToken, connected: githubAppConnected } = await cloneTokenForUser(
    sessionTenant,
    userId,
    session.repo
  );

  // Ported-session first turn: tell the runtime to check out the pushed branch
  // and natively resume the laptop transcript. Only on the seeding turn (while
  // pendingSeed is set + no turns yet) — afterwards it resumes by session id.
  const isPortSeed = Boolean(session.pendingSeed) && session.turns.length === 0;
  const resumeFields = isPortSeed
    ? {
        branch: session.branch,
        resumeTranscriptKey: session.resumeTranscriptKey,
        resumeSessionId: session.claudeSessionId,
      }
    : {};

  // ── Streaming path (claude): relay SSE, persist on the terminal 'done' frame.
  if (wantStream) {
    let upstream: ReadableStream<Uint8Array>;
    try {
      upstream = await invokeCodingTurnStream({
        sessionId: session.sessionId, prompt, cli: session.cli, repo: session.repo,
        claudeSessionId: session.claudeSessionId, userId, tenantId: sessionTenant, configVersion, region,
        githubToken, githubAppConnected, ...resumeFields,
      });
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 502 });
    }

    const enc = new TextEncoder();
    let fullText = "";

    const out = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          // sseData parses the upstream frames; we tee text/done to persist and
          // relay each frame to the browser verbatim.
          for await (const json of sseData(upstream)) {
            let obj: Record<string, unknown>;
            try { obj = JSON.parse(json); } catch { continue; }
            if (obj.type === "text") {
              fullText += String(obj.text || "");
            } else if (obj.type === "done") {
              if (obj.claude_session_id) session.claudeSessionId = String(obj.claude_session_id);
              fullText = String(obj.response || fullText);
            }
            controller.enqueue(enc.encode(`data: ${json}\n\n`));
          }
          // Persist the completed turn (re-read + merge so a /stop write for this
          // same interrupted turn isn't clobbered).
          await persistTurn(session.sessionId, session, userTurn, fullText, prompt).catch(() => {});
        } catch (err) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "error", error: (err as Error).message })}\n\n`));
          await persistTurn(session.sessionId, session, userTurn, null, prompt).catch(() => {});
        } finally {
          controller.close();
        }
      },
    });

    return new Response(out, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  // ── Buffered path (codex, or stream not requested).
  try {
    const result = await invokeCodingTurn({
      sessionId: session.sessionId, prompt, cli: session.cli, repo: session.repo,
      claudeSessionId: session.claudeSessionId, userId, tenantId: sessionTenant, configVersion, region,
      githubToken, githubAppConnected, ...resumeFields,
    });

    const agentTurn: CloudCodeTurn = { role: "agent", text: result.response, at: new Date().toISOString() };
    if (result.claudeSessionId) session.claudeSessionId = result.claudeSessionId;
    const saved = await persistTurn(session.sessionId, session, userTurn, result.response, prompt);
    return NextResponse.json({ reply: agentTurn, session: saved ?? session });
  } catch (err) {
    await persistTurn(session.sessionId, session, userTurn, null, prompt).catch(() => {});
    console.error("[cloud-code] turn error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
