/**
 * GET  /api/cloud-code/config   → list config-bundle versions + which is current
 * POST /api/cloud-code/config   → upload a bundle (zip) → S3, register version.
 *                                 multipart: bundle (zip), label?, scope?
 *                                 scope=claude|codex → MERGE that CLI's subtree
 *                                 into the current bundle (keeps the other CLI's
 *                                 files); absent → full-replace. The port-session
 *                                 MCP's sync_cli_config uses scope.
 * PUT  /api/cloud-code/config   → set the current version  { version }
 *
 * A bundle is the user's Claude Code / Codex setup (MCP servers, skills, custom
 * agents, prefs) zipped as `claude/...` + `codex/...`. The runtime materializes
 * the current version into the CLI config dirs on each turn. Single-user today.
 */

import { NextRequest, NextResponse } from "next/server";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DEFAULT_USER_ID } from "@/lib/cloud-code/sessions";
import {
  getUserConfig,
  saveUserConfig,
  s3KeyFor,
  mergeScopedBundle,
  getCurrentBundleZip,
  ARTIFACT_BUCKET,
  type ConfigVersion,
} from "@/lib/cloud-code/config-store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const REGION = process.env.AWS_REGION || "us-east-1";
const s3 = new S3Client({ region: REGION });
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — configs are small

export async function GET() {
  const cfg = await getUserConfig(DEFAULT_USER_ID);
  return NextResponse.json(cfg);
}

export async function POST(request: NextRequest) {
  if (!ARTIFACT_BUCKET) {
    return NextResponse.json({ error: "ARTIFACT_BUCKET not configured" }, { status: 503 });
  }
  const form = await request.formData().catch(() => null);
  const file = form?.get("bundle");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "multipart field 'bundle' (a .zip) is required" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "bundle exceeds 25 MB" }, { status: 413 });
  }
  const label = (form?.get("label") as string) || undefined;
  // scope=claude|codex → merge only that CLI's subtree into the current bundle
  // (syncing one CLI keeps the other's files). Absent → full-replace (legacy).
  const scopeRaw = (form?.get("scope") as string) || "";
  const scope = scopeRaw === "claude" || scopeRaw === "codex" ? scopeRaw : undefined;
  let bytes = Buffer.from(await file.arrayBuffer());

  // Cheap zip sanity (PK\x03\x04 magic).
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    return NextResponse.json({ error: "bundle must be a .zip" }, { status: 400 });
  }

  // Scoped sync: fold the incoming CLI subtree into the current bundle so the
  // other CLI's config survives. The merged zip becomes the new version.
  if (scope) {
    const current = await getCurrentBundleZip(DEFAULT_USER_ID);
    const merged = await mergeScopedBundle(current, bytes, scope);
    bytes = Buffer.from(merged.zip);
  }
  const fileCount = countZipEntries(bytes);

  // Sortable, human-traceable version id. (Date is fine here — server runtime.)
  const version = `v${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: ARTIFACT_BUCKET,
      Key: s3KeyFor(DEFAULT_USER_ID, version),
      Body: bytes,
      ContentType: "application/zip",
    })
  );

  const cfg = await getUserConfig(DEFAULT_USER_ID);
  const entry: ConfigVersion = {
    version,
    label,
    sizeBytes: bytes.length,
    fileCount,
    createdAt: new Date().toISOString(),
  };
  cfg.versions = [entry, ...cfg.versions].slice(0, 20); // keep last 20
  cfg.currentVersion = version; // newest becomes current
  cfg.updatedAt = new Date().toISOString();
  await saveUserConfig(cfg);

  return NextResponse.json({ version: entry, currentVersion: cfg.currentVersion }, { status: 201 });
}

export async function PUT(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const version: string | undefined = body.version;
  const cfg = await getUserConfig(DEFAULT_USER_ID);
  // null/empty → disable the bundle (launch with no user config).
  if (version && !cfg.versions.some((v) => v.version === version)) {
    return NextResponse.json({ error: "unknown version" }, { status: 404 });
  }
  cfg.currentVersion = version || undefined;
  cfg.updatedAt = new Date().toISOString();
  await saveUserConfig(cfg);
  return NextResponse.json({ currentVersion: cfg.currentVersion });
}

/** Count local-file-header records in a zip without unzipping. */
function countZipEntries(buf: Buffer): number {
  let count = 0;
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x03 && buf[i + 3] === 0x04) {
      count++;
    }
  }
  return count;
}
