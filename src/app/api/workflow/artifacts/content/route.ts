/**
 * /api/workflow/artifacts/content — inline viewing + editing of workflow artifacts.
 *
 * GET  ?key=X            → { content, contentType, lastModified } for text files
 *      ?key=X&presign=1  → { url } presigned GET (media: video needs range requests,
 *                          so we hand the browser S3 directly instead of buffering)
 * PUT  { key, content }  → overwrite the object in place. If the bucket has
 *                          versioning enabled, S3 keeps the prior version; the
 *                          response includes versionId when present.
 */

import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ARTIFACT_BUCKET } from "@/lib/workflow/agent-setup";

const REGION = process.env.AWS_REGION || "us-east-1";
const PRESIGN_EXPIRES = 900;
// Inline text viewer cap — anything bigger should be downloaded instead.
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const TEXT_CONTENT_TYPES: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  yaml: "text/yaml",
  yml: "text/yaml",
  csv: "text/csv",
  html: "text/html",
  css: "text/css",
  xml: "text/xml",
  log: "text/plain",
  ts: "text/plain",
  tsx: "text/plain",
  js: "text/javascript",
  jsx: "text/plain",
  py: "text/plain",
  sh: "text/plain",
  toml: "text/plain",
};

function textContentTypeFor(key: string): string | null {
  const ext = key.split(".").pop()?.toLowerCase() || "";
  return TEXT_CONTENT_TYPES[ext] || null;
}

function validKey(key: string | null): key is string {
  return !!key && key.startsWith("workflows/") && !key.includes("..");
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get("key");
  const presign = searchParams.get("presign");

  if (!validKey(key)) {
    return NextResponse.json({ error: "Invalid key: must be within workflows/ prefix" }, { status: 403 });
  }

  const client = new S3Client({ region: REGION });

  try {
    if (presign) {
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: key }),
        { expiresIn: PRESIGN_EXPIRES }
      );
      return NextResponse.json({ url });
    }

    const response = await client.send(
      new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: key })
    );
    if (!response.Body) {
      return NextResponse.json({ error: "Empty file" }, { status: 404 });
    }
    if ((response.ContentLength ?? 0) > MAX_TEXT_BYTES) {
      return NextResponse.json({ error: "File too large for inline viewing" }, { status: 413 });
    }
    const content = await response.Body.transformToString("utf-8");
    return NextResponse.json({
      content,
      contentType: response.ContentType || textContentTypeFor(key) || "text/plain",
      lastModified: response.LastModified?.toISOString() || null,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to load content";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const key = body?.key as string | undefined;
  const content = body?.content;

  if (!validKey(key ?? null)) {
    return NextResponse.json({ error: "Invalid key: must be within workflows/ prefix" }, { status: 403 });
  }
  if (typeof content !== "string") {
    return NextResponse.json({ error: "content (string) is required" }, { status: 400 });
  }
  const contentType = textContentTypeFor(key!);
  if (!contentType) {
    return NextResponse.json({ error: "Only text artifacts can be edited" }, { status: 400 });
  }

  try {
    const client = new S3Client({ region: REGION });
    const result = await client.send(
      new PutObjectCommand({
        Bucket: ARTIFACT_BUCKET,
        Key: key!,
        Body: content,
        ContentType: `${contentType}; charset=utf-8`,
      })
    );
    return NextResponse.json({ saved: true, versionId: result.VersionId || null });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Save failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
