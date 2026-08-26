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
  getOwnedSession,
  mutateSession,
  STOP_MARKER,
  DEFAULT_USER_ID,
  DEFAULT_TENANT_ID,
} from "@/lib/cloud-code/sessions";
import { getIdentity } from "@/lib/auth/identity";
import { stopCodingSession, prepareCodingSession, codingRuntimeConfigured } from "@/lib/cloud-code/runtime";
import { currentConfigVersion } from "@/lib/cloud-code/config-store";
import type { CloudCodeTurn } from "@/lib/cloud-code/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Must start with STOP_MARKER so the /message writer can detect a stop-recorded
// turn on re-read and avoid clobbering it.
const STOP_NOTE = `${STOP_MARKER} What should the agent do instead?`;

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
  // The stopped turn's attachments — the killed /message request never persisted
  // them, so without this a stopped attachment turn loses its files on reload.
  // Same sanitation as the message route (untrusted paths → S3-key material).
  const attachments: { path: string; name: string; contentType?: string }[] = Array.isArray(body.attachments)
    ? body.attachments
        .map((a: { path?: unknown; name?: unknown; contentType?: unknown }) => ({
          path: String(a?.path || "").replace(/^\/+/, ""),
          name: String(a?.name || "").slice(0, 256),
          contentType: typeof a?.contentType === "string" ? a.contentType : undefined,
        }))
        .filter((a: { path: string }) => a.path && !a.path.includes("..") && a.path.length < 1024)
        .slice(0, 20)
    : [];

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
  // Merged row we return to the client. Defaults to the entry snapshot so a
  // persist failure still returns *something*; on success it's the row with the
  // interrupted turn appended — the client does setActive(data.session), so this
  // MUST carry the stopped turn or the on-screen message + partial reply vanish.
  // mutateSession is an optimistic-concurrency read-modify-write, so this
  // serializes with the /message stream's persist for the same turn (last-writer
  // clobber avoided) rather than racing it on a plain re-read + Put.
  let persisted = session;
  try {
    const updated = await mutateSession(params.id, (fresh) => {
      const now = new Date().toISOString();
      // Only append the user message if it isn't already the last turn (the
      // /message route may have written it in); always append the partial + marker.
      // An attachment-only turn has an empty prompt but must still persist its
      // user turn (the attachments ARE the message).
      const last = fresh.turns[fresh.turns.length - 1];
      if ((prompt || attachments.length) && !(last?.role === "user" && last.text === prompt)) {
        fresh.turns.push({
          role: "user",
          text: prompt,
          at: now,
          ...(attachments.length ? { attachments } : {}),
        });
      }
      const agentText = partial ? `${partial}\n\n${STOP_NOTE}` : STOP_NOTE;
      const agentTurn: CloudCodeTurn = { role: "agent", text: agentText, at: now };
      fresh.turns.push(agentTurn);
      if (fresh.title === "New session" && prompt) fresh.title = prompt.slice(0, 80);
      fresh.pendingSeed = undefined;
      fresh.updatedAt = now;
      return fresh;
    });
    if (updated) persisted = updated;
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

  return NextResponse.json({ stopped: true, session: persisted });
}
