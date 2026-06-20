/**
 * Cloud Code — per-user CLI config bundle store.
 *
 * A "config bundle" is the user's dialed-in Claude Code / Codex setup
 * (MCP servers, skills, custom agents, prefs) zipped as `claude/...` + `codex/...`.
 * Uploaded once, reused on every session: the runtime fetches the *current*
 * version from S3 and materializes it into the CLI config dirs at turn start.
 *
 * Storage:
 *   - Bundle bytes → S3 at cloud-code/configs/{userId}/{version}.zip
 *   - Metadata     → DynamoDB row in the sessions table, key "config:{userId}"
 *     ({ versions[], currentVersion }). Single-table to avoid new infra.
 *
 * Single-user today (userId "default"); swap for the Cognito sub later.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_USER_ID } from "./sessions";

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE = process.env.CLOUD_CODE_TABLE || "agentcore-hub-cloud-code-sessions";
export const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export interface ConfigVersion {
  version: string; // sortable id (timestamp-based)
  label?: string;
  sizeBytes: number;
  fileCount: number;
  createdAt: string;
}

export interface UserConfig {
  userId: string;
  versions: ConfigVersion[];
  currentVersion?: string;
  updatedAt: string;
}

const keyFor = (userId: string) => `config:${userId}`;

export function s3KeyFor(userId: string, version: string): string {
  return `cloud-code/configs/${userId}/${version}.zip`;
}

/**
 * Merge a single CLI's subtree (claude/... or codex/...) into the current bundle
 * and write a NEW version zip. The bundle layout keys top-level dirs by CLI, so
 * syncing `codex` keeps the existing `claude/...` entries and vice versa. Returns
 * the merged zip bytes + file count; caller registers the version + uploads.
 *
 * `currentZip` is the bytes of the current version (or null if none yet);
 * `incomingZip` carries only `<scope>/...` entries.
 */
export async function mergeScopedBundle(
  currentZip: Buffer | null,
  incomingZip: Buffer,
  scope: "claude" | "codex"
): Promise<{ zip: Buffer; fileCount: number }> {
  const JSZip = (await import("jszip")).default;
  const out = new JSZip();

  // Carry over the OTHER CLI's files from the current bundle untouched.
  if (currentZip) {
    const cur = await JSZip.loadAsync(currentZip);
    await Promise.all(
      Object.values(cur.files).map(async (f) => {
        if (f.dir) return;
        if (f.name.startsWith(`${scope}/`)) return; // replaced by the incoming subtree
        out.file(f.name, await f.async("nodebuffer"));
      })
    );
  }
  // Add the incoming CLI's subtree (only its own scope).
  const inc = await JSZip.loadAsync(incomingZip);
  await Promise.all(
    Object.values(inc.files).map(async (f) => {
      if (f.dir || !f.name.startsWith(`${scope}/`)) return;
      out.file(f.name, await f.async("nodebuffer"));
    })
  );

  const zip = await out.generateAsync({ type: "nodebuffer" });
  const fileCount = Object.values(out.files).filter((f) => !f.dir).length;
  return { zip, fileCount };
}

/** Fetch the current version's zip bytes from S3 (null if none / not found). */
export async function getCurrentBundleZip(userId: string = DEFAULT_USER_ID): Promise<Buffer | null> {
  const cfg = await getUserConfig(userId);
  if (!cfg.currentVersion || !ARTIFACT_BUCKET) return null;
  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region: REGION });
  try {
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: s3KeyFor(userId, cfg.currentVersion) })
    );
    const bytes = await obj.Body!.transformToByteArray();
    return Buffer.from(bytes);
  } catch {
    return null;
  }
}

export async function getUserConfig(userId: string = DEFAULT_USER_ID): Promise<UserConfig> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { sessionId: keyFor(userId) }, ConsistentRead: true })
  );
  const item = res.Item as (UserConfig & { sessionId: string }) | undefined;
  if (!item) return { userId, versions: [], updatedAt: new Date().toISOString() };
  return {
    userId,
    versions: item.versions || [],
    currentVersion: item.currentVersion,
    updatedAt: item.updatedAt,
  };
}

export async function saveUserConfig(cfg: UserConfig): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { sessionId: keyFor(cfg.userId), ...cfg },
    })
  );
}

/** The version a new session should launch with (caller passes it to the runtime). */
export async function currentConfigVersion(
  userId: string = DEFAULT_USER_ID
): Promise<string | undefined> {
  return (await getUserConfig(userId)).currentVersion;
}
