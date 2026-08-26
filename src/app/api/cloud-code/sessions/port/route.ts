/**
 * POST /api/cloud-code/sessions/port  → "port my laptop session to the cloud"
 *
 * Called by the local `port-session` MCP server after it has prepared the git
 * handoff. We create a Cloud Code session and hand back a presigned S3 PUT URL;
 * the MCP uploads the RAW Claude transcript (.jsonl) straight to S3. On open,
 * the runtime downloads that transcript, drops it into the workspace's project
 * slug, and runs `claude --resume <sessionId>` — a native, lossless continuation
 * of the exact laptop conversation (no summary, no re-read).
 *
 * We do NOT run a turn here. The session records the transcript's S3 key + the
 * Claude session id inside it; the first turn (auto-fired on open) carries those
 * so the runtime resumes. Instant + serverless-robust — the user can close the
 * laptop immediately.
 *
 * Git is FLEXIBLE (see the port-session MCP): gitMode is "pushed" (branch on
 * origin), "bundle" (origin read-only → a git bundle the runtime layers on top),
 * "selfContained" (NO usable remote → a `bundle --all` of the whole repo the
 * runtime rebuilds standalone, nothing leaves the account), or "none" (truly
 * empty — conversation resumes in a bare workspace). repo/cloneUrl is only
 * required for pushed/bundle; the transcript ships in every mode.
 *
 * Request:  { gitMode?, repo?, cloneUrl?, branch?, wantBundleUpload?,
 *             claudeSessionId, cli?, title?, firstPrompt?, view?, artifacts? }
 * Response: { session, url, uploadUrl, transcriptKey, bundleUploadUrl?,
 *             bundleKey?, artifactUploads? }
 *   - url             = deep link to open on any device
 *   - uploadUrl       = presigned S3 PUT; MCP uploads the .jsonl here
 *   - transcriptKey   = S3 key the runtime will fetch
 *   - bundleUploadUrl = presigned S3 PUT for the git bundle (bundle + selfContained)
 *   - artifactUploads = presigned PUT per validated artifact rel path
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { putSession } from "@/lib/cloud-code/sessions";
import { getIdentity } from "@/lib/auth/identity";
import {
  resumeTranscriptKey,
  artifactKey as buildArtifactKey,
  safeRelPath,
  tenantRoot,
} from "@/lib/cloud-code/s3keys";
import type { CloudCodeSession, CloudCodeCli } from "@/lib/cloud-code/types";

export const dynamic = "force-dynamic";

const REGION = process.env.AWS_REGION || "us-east-1";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";
const UPLOAD_EXPIRES = 900; // 15 min to push the transcript
// Server-side guard on the artifact manifest: a sane ceiling on how many PUTs we
// presign per port (the MCP already applies its own count/size caps; this is the
// untrusted-input backstop). Over-cap entries are dropped, not errored.
const MAX_ARTIFACTS = 200;

/**
 * Validate an untrusted cloneUrl before it reaches `git clone` on the runtime.
 * https-only (the runtime's PAT rewriting + App tokens are https; the MCP
 * normalizes ssh→https before sending), no userinfo (nothing credential-shaped
 * persists), and no private/link-local/loopback literals — an authenticated
 * caller must not be able to point the runtime's git at VPC-internal targets
 * (SSRF). Hostname-based private targets can't be fully resolved here, but the
 * runtime egresses through its own network policy; this strips the cheap cases.
 */
function safeCloneUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:") return undefined;
  if (u.username || u.password) return undefined;
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host === "0.0.0.0" ||
    host === "[::1]" || host === "::1"
  ) {
    return undefined;
  }
  return u.toString();
}

// Best-effort owner/name from any clone URL (for the default session title).
function parseRepoFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const m = url.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : undefined;
}

// First-prompt hint the auto-fired seed turn sends to the resumed agent. Kept
// short — the real context lives in the resumed transcript, not in this prompt.
//
// Always prepend an ORIENTATION line: the agent doesn't otherwise know it's in a
// fresh cloud microVM, nor that the session's untracked deliverables (gitignored
// media/exports/datasets) were shipped out of band and staged under
// .cloud-code/artifacts/<same-relative-path-as-the-laptop>. Without this it
// inspects the original tree, sees the files "missing" (gitignored → not in the
// branch), and wrongly concludes they didn't come over. The orientation rides
// even when the user supplied a firstPrompt.
function buildResumePrompt(opts: {
  branch?: string;
  firstPrompt?: string;
  hasArtifacts?: boolean;
  hasCode?: boolean; // false for gitMode "none" — bare workspace, nothing checked out
}): string {
  const { branch, firstPrompt, hasArtifacts, hasCode } = opts;
  const orientation =
    "[Cloud Code] You've been resumed in a fresh cloud microVM from a laptop session" +
    (branch ? ` (branch \`${branch}\`)` : "") +
    "." +
    (hasCode ? " Your code is checked out here." : "") +
    (hasArtifacts
      ? " Untracked deliverables this session produced (gitignored media, " +
        "exports, datasets — anything NOT in the git branch) were shipped " +
        "separately and restored under `.cloud-code/artifacts/`, each at the SAME " +
        "path it had on the laptop (e.g. a file that was `out/render.mp4` is now " +
        "`.cloud-code/artifacts/out/render.mp4`). If you can't find a generated/" +
        "gitignored file at its original path, look under `.cloud-code/artifacts/` " +
        "before assuming it didn't transfer."
      : "");
  if (firstPrompt) return `${orientation}\n\n${firstPrompt}`;
  return `${orientation} In one line, confirm where things stand, then continue where we left off.`;
}

export async function POST(request: NextRequest) {
  try {
    if (!ARTIFACT_BUCKET) {
      return NextResponse.json({ error: "ARTIFACT_BUCKET not configured" }, { status: 503 });
    }
    const body = await request.json().catch(() => ({}));
    const gitMode: "pushed" | "bundle" | "selfContained" | "none" =
      body.gitMode === "bundle" ? "bundle"
      : body.gitMode === "selfContained" ? "selfContained"
      : body.gitMode === "none" ? "none"
      : "pushed";
    const repo: string = (body.repo || "").trim();
    const cloneUrl: string | undefined = safeCloneUrl(body.cloneUrl);
    if (body.cloneUrl?.trim() && !cloneUrl) {
      return NextResponse.json(
        { error: "cloneUrl must be a public https URL (no credentials, no private hosts)" },
        { status: 400 }
      );
    }
    // pushed/bundle need SOMETHING to clone — either owner/name (github) or an
    // explicit cloneUrl (non-github / self-hosted origins where remoteRepo is
    // undefined). selfContained ships a bundle --all instead (no origin); "none"
    // ships the transcript only.
    if ((gitMode === "pushed" || gitMode === "bundle") && !repo && !cloneUrl) {
      return NextResponse.json({ error: "repo or cloneUrl is required for gitMode pushed/bundle" }, { status: 400 });
    }
    const claudeSessionId: string = (body.claudeSessionId || "").trim();
    if (!claudeSessionId) {
      return NextResponse.json({ error: "claudeSessionId is required (the id of the transcript being ported)" }, { status: 400 });
    }

    const cli: CloudCodeCli = body.cli === "codex" ? "codex" : "claude";
    // Both bundle (commits-on-top) and selfContained (whole-repo --all) upload a
    // bundle; the runtime tells them apart by gitMode.
    const wantBundleUpload: boolean =
      Boolean(body.wantBundleUpload) && (gitMode === "bundle" || gitMode === "selfContained");
    const branch: string | undefined = body.branch?.trim() || undefined;
    const firstPrompt: string | undefined = body.firstPrompt?.trim() || undefined;
    const titleBase = repo || parseRepoFromUrl(cloneUrl) || "session";
    const title: string = (body.title?.trim() || `Ported: ${titleBase}`).slice(0, 120);
    // Surface the session opens in (sidebar tap restores it). Both CLIs write a
    // PTY resume hint (claude --resume / codex resume), so a terminal port
    // auto-resumes the conversation for each.
    const defaultView: "chat" | "terminal" =
      body.view === "terminal" ? "terminal" : "chat";

    // The port-session MCP authenticates as the porting user; middleware stamps
    // their identity (default in no-auth deploys). The cloud session is owned by
    // that tenant so it shows in the right sidebar and is IAM-scoped correctly.
    const { userId, tenantId } = getIdentity(request);

    const sessionId = `cc-${randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();

    // Transcript lands in the shared artifact bucket under the tenant prefix.
    const transcriptKey = resumeTranscriptKey(tenantId, sessionId, claudeSessionId);
    const bundleKey = wantBundleUpload
      ? `${tenantRoot(tenantId)}/resume/${sessionId}/work.bundle`
      : undefined;

    // Artifact manifest (touched-but-untracked deliverables the MCP detected).
    // Validate every rel path against traversal, dedupe, and cap the count —
    // this is untrusted input that becomes S3 keys. Each survivor gets a
    // presigned PUT the MCP streams the file to.
    const rawArtifacts: Array<{ rel?: unknown }> = Array.isArray(body.artifacts) ? body.artifacts : [];
    const artifactRels: string[] = [];
    const seenRel = new Set<string>();
    for (const a of rawArtifacts) {
      if (artifactRels.length >= MAX_ARTIFACTS) break;
      const safe = safeRelPath(typeof a?.rel === "string" ? a.rel : "");
      if (!safe || seenRel.has(safe)) continue;
      seenRel.add(safe);
      artifactRels.push(safe);
    }
    const hasArtifacts = artifactRels.length > 0;

    const session: CloudCodeSession = {
      sessionId,
      userId,
      tenantId,
      title,
      cli,
      repo: repo || undefined,
      branch,
      gitMode,
      cloneUrl,
      resumeBundleKey: bundleKey,
      // Resume the laptop conversation natively from the uploaded transcript.
      claudeSessionId,
      resumeTranscriptKey: transcriptKey,
      defaultView,
      pendingSeed: buildResumePrompt({ branch, firstPrompt, hasArtifacts, hasCode: gitMode !== "none" }),
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
    const bundleUploadUrl = bundleKey
      ? await getSignedUrl(
          s3,
          new PutObjectCommand({
            Bucket: ARTIFACT_BUCKET,
            Key: bundleKey,
            ContentType: "application/octet-stream",
          }),
          { expiresIn: UPLOAD_EXPIRES }
        )
      : undefined;

    // A presigned PUT per validated artifact rel. The MCP streams each file here.
    const artifactUploads = await Promise.all(
      artifactRels.map(async (rel) => ({
        rel,
        url: await getSignedUrl(
          s3,
          new PutObjectCommand({
            Bucket: ARTIFACT_BUCKET,
            Key: buildArtifactKey(tenantId, sessionId, rel),
            ContentType: "application/octet-stream",
          }),
          { expiresIn: UPLOAD_EXPIRES }
        ),
      }))
    );

    const base = process.env.DEPLOYMENT_URL || request.nextUrl.origin || "";
    const url = `${base.replace(/\/$/, "")}/cloud-code?session=${sessionId}`;

    return NextResponse.json(
      { session, url, uploadUrl, transcriptKey, bundleUploadUrl, bundleKey, artifactUploads },
      { status: 201 }
    );
  } catch (err) {
    console.error("[cloud-code] port error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
