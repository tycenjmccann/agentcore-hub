/**
 * Cloud Code — GitHub App connection store.
 *
 * Records which GitHub App installation a user connected, so the hub can mint
 * short-lived clone tokens for their sessions. Only the installation_id + display
 * metadata are stored (a DynamoDB row keyed "github:{tenantId}:{userId}" in the
 * sessions table). The App's private key lives in Secrets Manager (see
 * github-secrets.ts); the minted tokens are never persisted.
 *
 * The connection is per (tenant, user): two colleagues in the same tenant each
 * connect their own installation, and a token minted for one never clones with
 * the other's scope.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_TENANT_ID, DEFAULT_USER_ID } from "@/lib/auth/identity";

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE = process.env.CLOUD_CODE_TABLE || "agentcore-hub-cloud-code-sessions";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

// Legacy single-user rows were keyed "github:{userId}"; the default tenant keeps
// that exact key so a pre-tenancy connection keeps resolving with zero migration.
const keyFor = (tenantId: string, userId: string) =>
  tenantId === DEFAULT_TENANT_ID ? `github:${userId}` : `github:${tenantId}:${userId}`;

export interface GithubConnection {
  installationId: string;
  account?: string; // the org/user login the App is installed on
  repoSelection?: "all" | "selected";
  repositories?: string[]; // short names when selection === "selected"
  connectedAt: string;
}

export async function getGithubConnection(
  tenantId: string = DEFAULT_TENANT_ID,
  userId: string = DEFAULT_USER_ID
): Promise<GithubConnection | null> {
  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { sessionId: keyFor(tenantId, userId) },
      ConsistentRead: true,
    })
  );
  const item = res.Item as (GithubConnection & { sessionId: string }) | undefined;
  if (!item?.installationId) return null;
  return {
    installationId: item.installationId,
    account: item.account,
    repoSelection: item.repoSelection,
    repositories: item.repositories,
    connectedAt: item.connectedAt,
  };
}

export async function putGithubConnection(
  conn: GithubConnection,
  tenantId: string = DEFAULT_TENANT_ID,
  userId: string = DEFAULT_USER_ID
): Promise<void> {
  await ddb.send(
    new PutCommand({ TableName: TABLE, Item: { sessionId: keyFor(tenantId, userId), ...conn } })
  );
}

export async function deleteGithubConnection(
  tenantId: string = DEFAULT_TENANT_ID,
  userId: string = DEFAULT_USER_ID
): Promise<void> {
  await ddb.send(
    new DeleteCommand({ TableName: TABLE, Key: { sessionId: keyFor(tenantId, userId) } })
  );
}
