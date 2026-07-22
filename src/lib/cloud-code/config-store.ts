/**
 * Cloud Code — per-user CLI config bundle store.
 *
 * A "config bundle" is the user's dialed-in Claude Code / Codex setup
 * (MCP servers, skills, custom agents, prefs) zipped as `claude/...` + `codex/...`.
 * Uploaded once, reused on every session: the runtime fetches the *current*
 * version from S3 and materializes it into the CLI config dirs at turn start.
 *
 * Storage (per-tenant, per-user):
 *   - Bundle bytes → S3 via configKey(tenantId, userId, version)
 *   - Metadata     → DynamoDB row in the sessions table, key "config:{tenantId}:{userId}"
 *     ({ versions[], currentVersion }). Single-table to avoid new infra.
 *
 * Backward-compat: the "default" tenant+user keeps the legacy row key
 * "config:default" and the legacy unprefixed S3 path, so pre-tenancy bundles
 * still resolve with zero migration.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_USER_ID, DEFAULT_TENANT_ID } from "@/lib/auth/identity";
import { configKey } from "./s3keys";

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

/** Who a config bundle belongs to. tenantId is the isolation boundary; userId
 *  is the individual within it. Both "default" in no-auth deploys. */
export interface ConfigScope {
  tenantId: string;
  userId: string;
}

export const DEFAULT_SCOPE: ConfigScope = {
  tenantId: DEFAULT_TENANT_ID,
  userId: DEFAULT_USER_ID,
};

export interface UserConfig {
  tenantId: string;
  userId: string;
  versions: ConfigVersion[];
  currentVersion?: string;
  updatedAt: string;
}

// Legacy single-user row key was "config:default"; keep it for the default scope
// so pre-tenancy metadata still resolves. Real tenants key "config:{tenant}:{user}".
const keyFor = ({ tenantId, userId }: ConfigScope): string =>
  tenantId === DEFAULT_TENANT_ID && userId === DEFAULT_USER_ID
    ? `config:${DEFAULT_USER_ID}`
    : `config:${tenantId}:${userId}`;

export function s3KeyFor(scope: ConfigScope, version: string): string {
  return configKey(scope.tenantId, scope.userId, version);
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
export async function getCurrentBundleZip(scope: ConfigScope = DEFAULT_SCOPE): Promise<Buffer | null> {
  const cfg = await getUserConfig(scope);
  if (!cfg.currentVersion || !ARTIFACT_BUCKET) return null;
  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region: REGION });
  try {
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: s3KeyFor(scope, cfg.currentVersion) })
    );
    const bytes = await obj.Body!.transformToByteArray();
    return Buffer.from(bytes);
  } catch {
    return null;
  }
}

export async function getUserConfig(scope: ConfigScope = DEFAULT_SCOPE): Promise<UserConfig> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { sessionId: keyFor(scope) }, ConsistentRead: true })
  );
  const item = res.Item as (UserConfig & { sessionId: string }) | undefined;
  if (!item) {
    return { tenantId: scope.tenantId, userId: scope.userId, versions: [], updatedAt: new Date().toISOString() };
  }
  return {
    tenantId: scope.tenantId,
    userId: scope.userId,
    versions: item.versions || [],
    currentVersion: item.currentVersion,
    updatedAt: item.updatedAt,
  };
}

export async function saveUserConfig(cfg: UserConfig): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { sessionId: keyFor({ tenantId: cfg.tenantId, userId: cfg.userId }), ...cfg },
    })
  );
}

/** The version a new session should launch with (caller passes it to the runtime). */
export async function currentConfigVersion(
  scope: ConfigScope = DEFAULT_SCOPE
): Promise<string | undefined> {
  return (await getUserConfig(scope)).currentVersion;
}
