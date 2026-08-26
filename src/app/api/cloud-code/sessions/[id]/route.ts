/**
 * GET    /api/cloud-code/sessions/[id]   → full session (turns)
 * DELETE /api/cloud-code/sessions/[id]   → soft-delete (tombstone + TTL)
 *
 * DELETE hides the row immediately and arms a short DynamoDB TTL; the table
 * stream's REMOVE event fires the session-reaper Lambda, which stops the
 * microVM and purges the session's EFS workspace, transcripts, and S3
 * artifacts (deploy/session-reaper). An S3 lifecycle rule backstops any miss.
 */

import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getOwnedSession, putSession, softDeleteSession } from "@/lib/cloud-code/sessions";
import { getIdentity } from "@/lib/auth/identity";
import { artifactKey } from "@/lib/cloud-code/s3keys";
import type { CloudCodeSession } from "@/lib/cloud-code/types";

export const dynamic = "force-dynamic";

const REGION = process.env.AWS_REGION || "us-east-1";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";

// Presign a short-lived GET for each chat attachment so a reloaded session can
// render image thumbnails. Adds a transient `url` per attachment (not
// persisted). Best-effort — a failure just leaves the chip without a preview.
async function withAttachmentUrls(session: CloudCodeSession, tenantId: string): Promise<CloudCodeSession> {
  if (!ARTIFACT_BUCKET) return session;
  const hasAny = session.turns?.some((t) => t.attachments?.length);
  if (!hasAny) return session;
  const s3 = new S3Client({ region: REGION });
  const turns = await Promise.all(
    session.turns.map(async (t) => {
      if (!t.attachments?.length) return t;
      const attachments = await Promise.all(
        t.attachments.map(async (a) => {
          try {
            const url = await getSignedUrl(
              s3,
              new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: artifactKey(tenantId, session.sessionId, a.path) }),
              { expiresIn: 900 }
            );
            return { ...a, url };
          } catch {
            return a;
          }
        })
      );
      return { ...t, attachments };
    })
  );
  return { ...session, turns };
}

/**
 * PATCH /api/cloud-code/sessions/[id]  → small session mutations.
 * Today: { clearPendingSeed: true } — the terminal calls this once it has typed
 * the resume seed, so reopening the terminal re-attaches via `claude --resume`
 * WITHOUT re-typing the seed (which otherwise stacks in the transcript).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { tenantId } = getIdentity(request);
    const session = await getOwnedSession(params.id, tenantId);
    if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    const body = await request.json().catch(() => ({}));
    if (body.clearPendingSeed) session.pendingSeed = undefined;
    session.updatedAt = new Date().toISOString();
    await putSession(session);
    return NextResponse.json({ session });
  } catch (err) {
    console.error("[cloud-code] patch error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { tenantId } = getIdentity(request);
    const session = await getOwnedSession(params.id, tenantId);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ session: await withAttachmentUrls(session, tenantId) });
  } catch (err) {
    console.error("[cloud-code] get error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Only delete a row this tenant owns — a foreign/missing id is a no-op 404,
    // so a probe can't delete (or confirm the existence of) another tenant's row.
    // Soft-delete: the row is tombstoned (hidden immediately) with a short TTL;
    // when DynamoDB expires it, the table stream fires the reaper Lambda which
    // stops the microVM and purges the session's EFS workspace + S3 artifacts.
    const { tenantId } = getIdentity(request);
    const deleted = await softDeleteSession(params.id, tenantId);
    if (!deleted) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error("[cloud-code] delete error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
