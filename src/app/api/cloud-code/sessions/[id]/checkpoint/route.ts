/**
 * POST /api/cloud-code/sessions/[id]/checkpoint  → pull a cloud session home
 *
 * The round trip: after working in the cloud (phone/train), this asks the
 * runtime to upload the session's grown transcript back to S3, then returns a
 * presigned GET URL + the cloud branch + the Claude session id. The local
 * `pull-session` MCP fetches the transcript, drops it into ~/.claude/projects,
 * pulls the branch, and `claude --resume <id>` continues on the laptop.
 *
 * Same session id throughout (the cloud appended to the same .jsonl), so the
 * laptop just overwrites its stale copy — no merge, no new session.
 *
 * Response: { transcriptUrl, transcriptKey, claudeSessionId, branch, repo, bytes }
 */

import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getSession } from "@/lib/cloud-code/sessions";
import { checkpointCodingSession, codingRuntimeConfigured } from "@/lib/cloud-code/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const REGION = process.env.AWS_REGION || "us-east-1";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";
const DOWNLOAD_EXPIRES = 900;

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!codingRuntimeConfigured()) {
    return NextResponse.json({ error: "Coding runtime not configured" }, { status: 503 });
  }
  if (!ARTIFACT_BUCKET) {
    return NextResponse.json({ error: "ARTIFACT_BUCKET not configured" }, { status: 503 });
  }
  const session = await getSession(params.id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  if (session.cli !== "claude") {
    return NextResponse.json({ error: "checkpoint/pull is claude-only (codex resume differs)" }, { status: 400 });
  }
  // The conversation's real id is the resume handle (transcript filename). For a
  // ported session that's claudeSessionId; for a cloud-native one it's the same.
  const resumeSessionId = session.claudeSessionId;
  if (!resumeSessionId) {
    return NextResponse.json(
      { error: "session has no claudeSessionId yet (no turns run?) — nothing to pull" },
      { status: 400 }
    );
  }

  const region = request.nextUrl.searchParams.get("region") || undefined;
  try {
    const cp = await checkpointCodingSession({
      sessionId: session.sessionId,
      cli: session.cli,
      repo: session.repo,
      resumeSessionId,
      region,
    });
    if (!cp.key) {
      return NextResponse.json({ error: "runtime did not return a transcript key" }, { status: 502 });
    }

    const s3 = new S3Client({ region: REGION });
    const transcriptUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: cp.key }),
      { expiresIn: DOWNLOAD_EXPIRES }
    );

    return NextResponse.json({
      transcriptUrl,
      transcriptKey: cp.key,
      claudeSessionId: resumeSessionId,
      branch: cp.branch || session.branch,
      repo: session.repo,
      bytes: cp.bytes,
    });
  } catch (err) {
    console.error("[cloud-code] checkpoint error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
