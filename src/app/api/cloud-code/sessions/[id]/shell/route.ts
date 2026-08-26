/**
 * POST /api/cloud-code/sessions/[id]/shell  → mint a presigned wss:// URL
 *
 * Returns a short-lived (max 300s) SigV4-presigned WebSocket URL that the
 * browser (xterm.js) connects to DIRECTLY — the live PTY into the session's
 * microVM. App Runner only signs the URL; it does not proxy the socket.
 *
 * Wire protocol on that socket: Kubernetes channel-prefix frames
 * ([1-byte channel][payload]) — see src/lib/cloud-code/shell-protocol.ts.
 */

import { NextRequest, NextResponse } from "next/server";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { getOwnedSession, DEFAULT_USER_ID, DEFAULT_TENANT_ID } from "@/lib/cloud-code/sessions";
import { currentConfigVersion } from "@/lib/cloud-code/config-store";
import { prepareCodingSession, warmCodingSession } from "@/lib/cloud-code/runtime";
import { cloneTokenForUser } from "@/lib/cloud-code/github-app";
import { getIdentity } from "@/lib/auth/identity";

export const dynamic = "force-dynamic";
// Bounded by the prepare/warm race below; the presign itself is instant. A
// ported session must finish its clone + transcript install before the PTY's
// server-side resume runs, and a cold clone can take 10-30s — so allow longer.
export const maxDuration = 60;

const REGION = process.env.AWS_REGION || "us-east-1";
const RUNTIME_ARN = process.env.CODING_AGENT_RUNTIME_ARN || "";
const EXPIRES = 300; // AgentCore presigned-URL max

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!RUNTIME_ARN) {
    return NextResponse.json(
      { error: "Coding runtime not configured (CODING_AGENT_RUNTIME_ARN unset)" },
      { status: 503 }
    );
  }

  const { userId: requesterId, tenantId } = getIdentity(request);
  const session = await getOwnedSession(params.id, tenantId);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Ready the session's microVM BEFORE the browser opens the PTY. Two cases:
  //
  //   • Ported session (resumeTranscriptKey set): shell-init auto-runs
  //     `claude --resume <id>` the instant the PTY opens — that id only exists
  //     once the transcript is installed on disk, which warmCodingSession does
  //     (clone + checkout + install + write the resume hint). If we don't AWAIT
  //     it, the server-side resume races the background warm and claude reports
  //     "conversation not found". So block on the full warm (bounded).
  //   • Anything else: config-only prepare (cheap). It also restores the durable
  //     resume hint on a recycled VM, so a session with prior turns still lands
  //     in the live TUI rather than a bare shell.
  //
  // resumeReady gates the client's first-prompt seed: the seed is meant for the
  // resumed CLI's TUI. If the warm timed out/failed there's no hint and the PTY
  // is a bare shell — typing the seed there would run it as a shell command. A
  // timeout wins the race → resumeReady stays false → the client holds the seed.
  let resumeReady = false;
  try {
    const userId = session.userId || DEFAULT_USER_ID;
    const sessionTenant = session.tenantId || DEFAULT_TENANT_ID;
    const configVersion = await currentConfigVersion({ tenantId: sessionTenant, userId });
    // Mint the clone token for the VERIFIED REQUESTER (whoever is opening this
    // terminal), not the session creator — tenant sessions are shared, and the
    // Terminal exposes git/gh directly, so it must carry the opener's scope.
    const { token: githubToken, connected: githubAppConnected } = await cloneTokenForUser(
      tenantId,
      requesterId,
      session.repo ?? session.cloneUrl
    );
    if (session.resumeTranscriptKey) {
      const warmed = await Promise.race([
        warmCodingSession({
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
          region: REGION,
          githubToken,
          githubAppConnected,
        }).catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), 50_000)),
      ]);
      resumeReady = Boolean(warmed?.resumeReady);
    } else {
      const prepared = await Promise.race([
        prepareCodingSession({
          sessionId: session.sessionId,
          cli: session.cli,
          userId,
          tenantId: sessionTenant,
          configVersion,
          region: REGION,
          // A terminal-only session readies its VM only through prepare (no chat
          // turn runs _configure_git), so the scoped token must ride here too —
          // otherwise Terminal git/gh uses the deploy-wide GITHUB_PAT.
          githubToken,
          githubAppConnected,
        }).catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), 4000)),
      ]);
      resumeReady = Boolean(prepared?.resumeReady);
    }
  } catch {
    /* best-effort; the PTY still opens — worst case a bare shell */
  }

  // A shell id is the reconnect handle for this PTY; one per attach is fine.
  const shellId = `sh-${params.id}`.slice(0, 60);
  const host = `bedrock-agentcore.${REGION}.amazonaws.com`;
  const path = `/runtimes/${encodeURIComponent(RUNTIME_ARN)}/ws/shells`;

  const signer = new SignatureV4({
    service: "bedrock-agentcore",
    region: REGION,
    credentials: defaultProvider(),
    sha256: Sha256,
    // Default uriEscapePath:true — the canonical request double-encodes the
    // already-%-encoded ARN in the path (arn%253A…), matching the platform's
    // botocore presigner. Setting it false → 403.
  });

  try {
    const signed = await signer.presign(
      {
        method: "GET",
        protocol: "https:",
        hostname: host,
        path,
        headers: { host },
        query: {
          qualifier: "DEFAULT",
          shellId,
          // Routes to (and warms) the same microVM as this session's turns.
          "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": session.sessionId,
        },
      },
      { expiresIn: EXPIRES }
    );

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(signed.query || {})) {
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
      else if (v != null) qs.append(k, String(v));
    }
    const url = `wss://${host}${path}?${qs.toString()}`;

    return NextResponse.json({ url, shellId, expiresIn: EXPIRES, resumeReady });
  } catch (err) {
    console.error("[cloud-code] shell presign error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
