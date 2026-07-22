/**
 * /api/cloud-code/sessions/[id]/artifacts — the web surface for artifact portability.
 *
 * GET  → list everything under the session's tenant-scoped artifact prefixes
 *        (resume/<sessionId>/artifacts/ for uploads + ported outputs, and
 *        checkpoint/<resumeId>/artifacts/ for cloud outputs synced on checkpoint)
 *        with a presigned GET per object, so a generated video/image/export is
 *        reviewable from any device without pulling the session home.
 *
 * POST { name } → { uploadUrl, key, path, contentType } — presigned PUT so the
 *        browser uploads a file straight to the resume prefix (no big body through
 *        the app). The runtime restores that prefix into the workspace's
 *        .cloud-code/artifacts/ on warm, so an uploaded screenshot is visible to
 *        the agent AND listed by GET.
 */

import { NextRequest, NextResponse } from "next/server";
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getOwnedSession } from "@/lib/cloud-code/sessions";
import { getIdentity } from "@/lib/auth/identity";
import { artifactPrefix, artifactKey, checkpointArtifactPrefix } from "@/lib/cloud-code/s3keys";

export const dynamic = "force-dynamic";

const REGION = process.env.AWS_REGION || "us-east-1";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";
const DOWNLOAD_EXPIRES = 900;
const UPLOAD_EXPIRES = 900;

// Sanitize a user-supplied filename into a safe, single-segment key suffix: strip
// any path, drop anything but a conservative charset, cap length. An empty result
// falls back to a generic name so the key is always valid.
function safeName(raw: unknown): string {
  const base = String(raw || "").split(/[\\/]/).pop() || "";
  const clean = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+/, "").slice(0, 128);
  return clean || "upload";
}

// Minimal extension → content-type map so the UI can inline media correctly.
const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

function contentTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!ARTIFACT_BUCKET) {
    return NextResponse.json({ error: "ARTIFACT_BUCKET not configured" }, { status: 503 });
  }
  const { tenantId } = getIdentity(request);
  const session = await getOwnedSession(params.id, tenantId);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Artifacts land under TWO prefixes: the resume/upload prefix (composer uploads
  // + ported outputs, keyed by the cloud session id) and the checkpoint prefix
  // (cloud outputs synced on checkpoint, keyed by the resume/claude session id).
  // List both; dedupe by path (checkpoint = newer cloud output, so it wins).
  const prefixes: string[] = [artifactPrefix(tenantId, params.id)];
  if (session.claudeSessionId) {
    prefixes.push(checkpointArtifactPrefix(tenantId, session.claudeSessionId));
  }
  const s3 = new S3Client({ region: REGION });

  try {
    const byPath = new Map<string, { key: string; bytes: number }>();
    for (const prefix of prefixes) {
      let token: string | undefined;
      do {
        const page = await s3.send(
          new ListObjectsV2Command({ Bucket: ARTIFACT_BUCKET, Prefix: prefix, ContinuationToken: token })
        );
        for (const o of page.Contents || []) {
          if (!o.Key || o.Key === prefix) continue;
          // Later prefix (checkpoint) overwrites the earlier one on a name clash.
          byPath.set(o.Key.slice(prefix.length), { key: o.Key, bytes: o.Size ?? 0 });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    }

    const artifacts = await Promise.all(
      Array.from(byPath.entries()).map(async ([path, o]) => ({
        path,
        bytes: o.bytes,
        contentType: contentTypeFor(path),
        url: await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: o.key }),
          { expiresIn: DOWNLOAD_EXPIRES }
        ),
      }))
    );

    return NextResponse.json({ artifacts });
  } catch (err) {
    console.error("[cloud-code] artifacts list error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!ARTIFACT_BUCKET) {
    return NextResponse.json({ error: "ARTIFACT_BUCKET not configured" }, { status: 503 });
  }
  const { tenantId } = getIdentity(request);
  const session = await getOwnedSession(params.id, tenantId);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const body = await request.json().catch(() => ({}));
  const name = safeName(body.name);
  // Namespace user uploads so they're distinguishable from agent-generated
  // outputs, and give each its own timestamped subdir so two same-named uploads
  // (e.g. two phone screenshots both called image.png) don't overwrite each other.
  const path = `uploads/${Date.now().toString(36)}/${name}`;
  const key = artifactKey(tenantId, params.id, path);

  try {
    const s3 = new S3Client({ region: REGION });
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: ARTIFACT_BUCKET,
        Key: key,
        ContentType: contentTypeFor(name),
      }),
      { expiresIn: UPLOAD_EXPIRES }
    );
    return NextResponse.json({ uploadUrl, key, path, contentType: contentTypeFor(name) });
  } catch (err) {
    console.error("[cloud-code] artifacts upload-presign error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
