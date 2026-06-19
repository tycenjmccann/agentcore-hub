/**
 * POST /api/cloud-code/sessions/port  → "port my laptop session to the cloud"
 *
 * Called by the local `port-session` MCP server after it has committed+pushed
 * the user's in-flight work to a branch. We create a Cloud Code session and hand
 * back a presigned S3 PUT URL; the MCP uploads the RAW Claude transcript (.jsonl)
 * straight to S3. On open, the runtime downloads that transcript, drops it into
 * the workspace's project slug, and runs `claude --resume <sessionId>` — a native,
 * lossless continuation of the exact laptop conversation (no summary, no re-read).
 *
 * We do NOT run a turn here. The session records the transcript's S3 key + the
 * Claude session id inside it; the first turn (auto-fired on open) carries those
 * so the runtime resumes. Instant + serverless-robust — the user can close the
 * laptop immediately.
 *
 * Request:  { repo, branch?, claudeSessionId, cli?, title?, firstPrompt?, transcriptBytes? }
 * Response: { session, url, uploadUrl, transcriptKey }
 *   - url           = deep link to open on any device
 *   - uploadUrl     = presigned S3 PUT; MCP uploads the .jsonl here
 *   - transcriptKey = S3 key the runtime will fetch
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { putSession, DEFAULT_USER_ID } from "@/lib/cloud-code/sessions";
import type { CloudCodeSession, CloudCodeCli } from "@/lib/cloud-code/types";

export const dynamic = "force-dynamic";

const REGION = process.env.AWS_REGION || "us-east-1";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";
const UPLOAD_EXPIRES = 900; // 15 min to push the transcript

// First-prompt hint the auto-fired seed turn sends to the resumed agent. Kept
// short — the real context lives in the resumed transcript, not in this prompt.
function buildResumePrompt(opts: { branch?: string; firstPrompt?: string }): string {
  const { branch, firstPrompt } = opts;
  if (firstPrompt) return firstPrompt;
  return (
    "You've been resumed in the cloud from the laptop session" +
    (branch ? ` (branch \`${branch}\`)` : "") +
    ". In one line, confirm where things stand, then continue where we left off."
  );
}

export async function POST(request: NextRequest) {
  try {
    if (!ARTIFACT_BUCKET) {
      return NextResponse.json({ error: "ARTIFACT_BUCKET not configured" }, { status: 503 });
    }
    const body = await request.json().catch(() => ({}));
    const repo: string = (body.repo || "").trim();
    if (!repo) {
      return NextResponse.json({ error: "repo is required (owner/name or clone URL)" }, { status: 400 });
    }
    const claudeSessionId: string = (body.claudeSessionId || "").trim();
    if (!claudeSessionId) {
      return NextResponse.json({ error: "claudeSessionId is required (the id of the transcript being ported)" }, { status: 400 });
    }

    const cli: CloudCodeCli = body.cli === "codex" ? "codex" : "claude";
    const branch: string | undefined = body.branch?.trim() || undefined;
    const firstPrompt: string | undefined = body.firstPrompt?.trim() || undefined;
    const title: string = (body.title?.trim() || `Ported: ${repo}`).slice(0, 120);
    // Surface the session opens in (sidebar tap restores it). Terminal only
    // makes sense for claude (--resume); codex always opens chat.
    const defaultView: "chat" | "terminal" =
      body.view === "terminal" && cli === "claude" ? "terminal" : "chat";

    const sessionId = `cc-${randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();

    // Transcript lands in the shared artifact bucket, namespaced per session.
    const transcriptKey = `cloud-code/resume/${sessionId}/${claudeSessionId}.jsonl`;

    const session: CloudCodeSession = {
      sessionId,
      userId: DEFAULT_USER_ID,
      title,
      cli,
      repo,
      branch,
      // Resume the laptop conversation natively from the uploaded transcript.
      claudeSessionId,
      resumeTranscriptKey: transcriptKey,
      defaultView,
      pendingSeed: buildResumePrompt({ branch, firstPrompt }),
      createdAt: now,
      updatedAt: now,
      turns: [],
    };
    await putSession(session);

    const s3 = new S3Client({ region: REGION });
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: ARTIFACT_BUCKET,
        Key: transcriptKey,
        ContentType: "application/x-ndjson",
      }),
      { expiresIn: UPLOAD_EXPIRES }
    );

    const base = process.env.DEPLOYMENT_URL || request.nextUrl.origin || "";
    const url = `${base.replace(/\/$/, "")}/cloud-code?session=${sessionId}`;

    return NextResponse.json({ session, url, uploadUrl, transcriptKey }, { status: 201 });
  } catch (err) {
    console.error("[cloud-code] port error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
