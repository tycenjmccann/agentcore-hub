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
