/**
 * POST /api/cloud-code/sessions/[id]/stop  → interrupt a running chat turn ("Ctrl-C")
 *
 * Chat turns run headless inside the session microVM (claude --print), so there
 * is no PTY signal to send. Instead we StopRuntimeSession, which tears down the
 * microVM and kills the in-flight CLI. The workspace (EFS) and transcript
 * persist, so the next turn resumes the conversation with any partial work
 * intact — exactly like interrupting a local session.
 *
 * PERSIST THE STOPPED TURN. Aborting the client stream also kills the /message
 * request before its putSession, so the in-flight user message + partial reply
 * would never reach DynamoDB and would vanish on reload. The client hands them
 * to us here ({ prompt, partial }) and we append them to the session row so the
 * chat history survives a refresh / another device.
 *
 * To hide the cold-start the next turn would otherwise pay, we also kick off a
 * background re-warm (config-only prepare → fresh VM). Best-effort and NOT
 * awaited: the response returns immediately so the UI can prompt for the next
 * instruction while the VM warms in parallel. The next real turn re-warms anyway.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getSession,
  getOwnedSession,
  putSession,
  DEFAULT_USER_ID,
  DEFAULT_TENANT_ID,
} from "@/lib/cloud-code/sessions";
import { getIdentity } from "@/lib/auth/identity";
import { stopCodingSession, prepareCodingSession, codingRuntimeConfigured } from "@/lib/cloud-code/runtime";
import { currentConfigVersion } from "@/lib/cloud-code/config-store";
import type { CloudCodeTurn } from "@/lib/cloud-code/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const STOP_NOTE = "⏹ Stopped. What should the agent do instead?";

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!codingRuntimeConfigured()) {
    return NextResponse.json({ error: "Coding runtime not configured" }, { status: 503 });
  }
  const { tenantId } = getIdentity(request);
  const session = await getOwnedSession(params.id, tenantId);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const region = request.nextUrl.searchParams.get("region") || undefined;
  const body = await request.json().catch(() => ({}));
  // The stopped turn's user prompt (display label) + whatever reply text had
  // streamed in before the stop. displayPrompt avoids persisting a huge ported
  // seed as the visible message.
  const prompt: string = (body.displayPrompt || body.prompt || "").trim();
  const partial: string = (body.partial || "").trim();

  try {
    await stopCodingSession({ sessionId: session.sessionId, region });
  } catch (err) {
    console.error("[cloud-code] stop error:", err);
    return NextResponse.json({ stopped: false, error: (err as Error).message }, { status: 200 });
  }

  // Persist the interrupted turn so it survives reload. putSession is a full Put
  // (last writer wins), and the streaming /message route may also persist its own
  // turns when StopRuntimeSession aborts its upstream — a race that could clobber
  // either write. StopRuntimeSession has now torn the VM down, so /message's write
  // has almost certainly landed; RE-READ the latest row and append onto it (rather
  // than the snapshot above) so we merge with, not overwrite, whatever /message wrote.
  try {
    const now = new Date().toISOString();
    const fresh = (await getSession(params.id)) || session;
    // Only append the user message if it isn't already the last turn (the /message
    // route may have written it in); always append the partial + marker.
    const last = fresh.turns[fresh.turns.length - 1];
    if (prompt && !(last?.role === "user" && last.text === prompt)) {
      fresh.turns.push({ role: "user", text: prompt, at: now });
    }
    const agentText = partial ? `${partial}\n\n${STOP_NOTE}` : STOP_NOTE;
    const agentTurn: CloudCodeTurn = { role: "agent", text: agentText, at: now };
    fresh.turns.push(agentTurn);
    if (fresh.title === "New session" && prompt) fresh.title = prompt.slice(0, 80);
    fresh.pendingSeed = undefined;
    fresh.updatedAt = now;
    await putSession(fresh);
  } catch (err) {
    console.error("[cloud-code] stop persist error:", err);
    // Stop itself succeeded; a persist failure shouldn't 500 the action.
  }

  // Background re-warm — DON'T await. Give the teardown a beat so the new VM
  // doesn't race the stop, then materialize config on a fresh microVM so the
  // user's next message lands hot. Failure is non-fatal (the next turn warms).
  const userId = session.userId || DEFAULT_USER_ID;
  const sessionTenant = session.tenantId || DEFAULT_TENANT_ID;
  void (async () => {
    try {
      const configVersion = await currentConfigVersion({ tenantId: sessionTenant, userId });
      await new Promise((r) => setTimeout(r, 1500));
      await prepareCodingSession({
        sessionId: session.sessionId,
        cli: session.cli,
        userId,
        tenantId: sessionTenant,
        configVersion,
        region,
      });
    } catch {
      /* best-effort; the next turn re-warms */
    }
  })();

  return NextResponse.json({ stopped: true, session });
}
