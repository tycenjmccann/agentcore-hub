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
import { getSession, DEFAULT_USER_ID } from "@/lib/cloud-code/sessions";
import { currentConfigVersion } from "@/lib/cloud-code/config-store";
import { prepareCodingSession } from "@/lib/cloud-code/runtime";

export const dynamic = "force-dynamic";
// Bounded by the prepare race below; the presign itself is instant.
export const maxDuration = 30;

const REGION = process.env.AWS_REGION || "us-east-1";
const RUNTIME_ARN = process.env.CODING_AGENT_RUNTIME_ARN || "";
const EXPIRES = 300; // AgentCore presigned-URL max

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!RUNTIME_ARN) {
    return NextResponse.json(
      { error: "Coding runtime not configured (CODING_AGENT_RUNTIME_ARN unset)" },
      { status: 503 }
    );
  }

  const session = await getSession(params.id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Materialize the user's config bundle (skills/agents/MCP) onto the session's
  // microVM BEFORE the browser opens the PTY — a terminal-only session never runs
  // a chat turn, which is the only other thing that materializes config. Bounded:
  // wait briefly so `claude` reads .mcp.json on first launch, but never block the
  // URL on a cold path (materialization continues server-side; marker dedupes).
  try {
    const userId = session.userId || DEFAULT_USER_ID;
    const configVersion = await currentConfigVersion(userId);
    if (configVersion) {
      await Promise.race([
        prepareCodingSession({
          sessionId: session.sessionId,
          cli: session.cli,
          userId,
          configVersion,
          region: REGION,
        }).catch(() => {}),
        new Promise((r) => setTimeout(r, 4000)),
      ]);
    }
  } catch {
    /* best-effort; the first chat turn (if any) still materializes */
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

    return NextResponse.json({ url, shellId, expiresIn: EXPIRES });
  } catch (err) {
    console.error("[cloud-code] shell presign error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
