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
import { getOwnedSession, DEFAULT_USER_ID, DEFAULT_TENANT_ID } from "@/lib/cloud-code/sessions";
import { warmCodingSession, codingRuntimeConfigured } from "@/lib/cloud-code/runtime";
import { currentConfigVersion } from "@/lib/cloud-code/config-store";
import { cloneTokenForUser } from "@/lib/cloud-code/github-app";
import { getIdentity } from "@/lib/auth/identity";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!codingRuntimeConfigured()) {
    return NextResponse.json({ error: "Coding runtime not configured" }, { status: 503 });
  }
  const { userId: requesterId, tenantId } = getIdentity(request);
  const session = await getOwnedSession(params.id, tenantId);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  // Only ported sessions (with a transcript to install) need pre-warming.
  if (!session.resumeTranscriptKey) {
    return NextResponse.json({ warmed: false, reason: "nothing to warm" });
  }

  const region = request.nextUrl.searchParams.get("region") || undefined;
  const userId = session.userId || DEFAULT_USER_ID;
  const sessionTenant = session.tenantId || DEFAULT_TENANT_ID;
  const configVersion = await currentConfigVersion({ tenantId: sessionTenant, userId });
  // Warming clones the repo, so it needs the same scoped clone token a turn gets
  // — bound to the verified requester (tenant sessions are shared; minting off
  // the creator would hand a coworker the creator's repo access). EXCEPTION:
  // a service principal (svc:<tokenName> — the port-session MCP calling warm
  // right after a port) has no GitHub connection of its own; it acts on behalf
  // of the session owner, so mint with the OWNER's connection. Without this,
  // every post-flip MCP warm reported connected:false and the runtime fell back
  // to the deploy-wide PAT for what may be an App-connected owner.
  const mintAs = requesterId.startsWith("svc:") ? userId : requesterId;
  const { token: githubToken, connected: githubAppConnected } = await cloneTokenForUser(
    tenantId,
    mintAs,
    session.repo ?? session.cloneUrl
  );
  try {
    await warmCodingSession({
      sessionId: session.sessionId,
      cli: session.cli,
      repo: session.repo,
      branch: session.branch,
      resumeTranscriptKey: session.resumeTranscriptKey,
      resumeSessionId: session.claudeSessionId,
      gitMode: session.gitMode,
      cloneUrl: session.cloneUrl,
      resumeBundleKey: session.resumeBundleKey,
      userId,
      tenantId: sessionTenant,
      configVersion,
      region,
      githubToken,
      githubAppConnected,
    });
    return NextResponse.json({ warmed: true });
  } catch (err) {
    // Non-fatal — the first turn will clone on demand.
    console.error("[cloud-code] warm error:", err);
    return NextResponse.json({ warmed: false, error: (err as Error).message }, { status: 200 });
  }
}
