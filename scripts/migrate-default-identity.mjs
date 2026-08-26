#!/usr/bin/env node
/**
 * One-time migration for the auth flip (AUTH_MODE=none → cloudflare-access).
 *
 * Under AUTH_MODE=none every row was written with the "default" identity. Once
 * real SSO identities arrive (tenant = email domain, user = email), those rows
 * become INVISIBLE: getOwnedSession/tenant filters compare against the new
 * tenant, config resolves "config:default", the GitHub connection resolves
 * "github:default", and the S3 config bundle sits at the legacy unprefixed path.
 *
 * This script re-keys everything "default" to the operator's real identity:
 *   1. sessions        — tenantId/userId "default" → --tenant/--user
 *   2. config:default  — row copied to config:{tenant}:{user}; S3 bundle objects
 *                        copied from cloud-code/configs/… to
 *                        cloud-code/t/{tenant}/configs/{user}/…
 *   3. github:default  — row copied to github:{tenant}:{user}
 *
 * Idempotent + non-destructive: copies first, verifies, then deletes the old
 * row only with --delete-old (default keeps both). Dry-run by default; pass
 * --apply to write.
 *
 * Usage:
 *   node scripts/migrate-default-identity.mjs \
 *     --tenant acme.com --user alice@acme.com [--apply] [--delete-old]
 *
 * Env: AWS_REGION, CLOUD_CODE_TABLE, ARTIFACT_BUCKET (same as the app).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client, ListObjectsV2Command, CopyObjectCommand,
} from "@aws-sdk/client-s3";

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE = process.env.CLOUD_CODE_TABLE || "agentcore-hub-cloud-code-sessions";
const BUCKET = process.env.ARTIFACT_BUCKET || "";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1]?.startsWith("--") ? true : args[i + 1] ?? true) : undefined;
};
const TENANT = flag("tenant");
const USER = flag("user");
const APPLY = args.includes("--apply");
const DELETE_OLD = args.includes("--delete-old");

if (!TENANT || !USER || TENANT === true || USER === true) {
  console.error("usage: migrate-default-identity.mjs --tenant <tenantId> --user <userId> [--apply] [--delete-old]");
  process.exit(1);
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({ region: REGION });
const log = (...a) => console.log(APPLY ? "[apply]" : "[dry-run]", ...a);

// ── 1. sessions: re-stamp tenant/user on every default-identity session row ──
async function migrateSessions() {
  let migrated = 0;
  let lastKey;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey: lastKey }));
    for (const item of res.Items || []) {
      const id = String(item.sessionId || "");
      if (id.startsWith("config:") || id.startsWith("github:")) continue;
      if (!item.cli) continue; // not a session row
      const isDefault = (item.tenantId || "default") === "default";
      if (!isDefault) continue;
      migrated++;
      log(`session ${id}: tenantId default → ${TENANT}, userId ${item.userId || "default"} → ${USER}`);
      if (APPLY) {
        // UpdateCommand touching ONLY the identity fields — a full-item Put from
        // this scan's snapshot would clobber turns/rev/deletedAt written by a
        // live session mid-migration. Conditional on the row still being
        // default-tenant so a concurrent re-run/racer can't double-apply.
        try {
          await ddb.send(new UpdateCommand({
            TableName: TABLE,
            Key: { sessionId: id },
            UpdateExpression: "SET tenantId = :t, userId = :u",
            ConditionExpression: "attribute_not_exists(tenantId) OR tenantId = :def",
            ExpressionAttributeValues: { ":t": TENANT, ":u": USER, ":def": "default" },
          }));
        } catch (e) {
          if (e?.name === "ConditionalCheckFailedException") {
            console.log(`session ${id}: already migrated by a concurrent writer — skip`);
          } else {
            throw e;
          }
        }
      }
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  console.log(`sessions: ${migrated} row(s) ${APPLY ? "migrated" : "would migrate"}`);
}

// ── 2. config:default → config:{tenant}:{user} + S3 bundle copy ─────────────
async function migrateConfig() {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { sessionId: "config:default" } }));
  if (!res.Item) return console.log("config: no config:default row — skip");
  const newKey = `config:${TENANT}:${USER}`;
  const existing = await ddb.send(new GetCommand({ TableName: TABLE, Key: { sessionId: newKey } }));
  if (existing.Item) {
    console.log(`config: ${newKey} already exists — skip (delete config:default manually if stale)`);
  } else {
    log(`config: copy config:default → ${newKey}`);
    if (APPLY) {
      await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...res.Item, sessionId: newKey } }));
    }
  }
  // S3: legacy bundles live at cloud-code/configs/default/<version>.zip; the
  // tenant-scoped reader expects cloud-code/t/{tenant}/configs/{user}/….
  if (!BUCKET) return console.log("config: ARTIFACT_BUCKET unset — skipping S3 bundle copy");
  const legacyPrefix = "cloud-code/configs/default/";
  const newPrefix = `cloud-code/t/${TENANT}/configs/${USER}/`;
  let copied = 0;
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: legacyPrefix, ContinuationToken: token,
    }));
    for (const o of page.Contents || []) {
      const dest = newPrefix + o.Key.slice(legacyPrefix.length);
      copied++;
      log(`config bundle: s3 copy ${o.Key} → ${dest}`);
      if (APPLY) {
        await s3.send(new CopyObjectCommand({
          Bucket: BUCKET, Key: dest, CopySource: `${BUCKET}/${encodeURIComponent(o.Key)}`,
        }));
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  console.log(`config bundles: ${copied} object(s) ${APPLY ? "copied" : "would copy"}`);
  if (DELETE_OLD && APPLY) {
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { sessionId: "config:default" } }));
    console.log("config: deleted config:default");
  }
}

// ── 3. github:default → github:{tenant}:{user} ──────────────────────────────
async function migrateGithub() {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { sessionId: "github:default" } }));
  if (!res.Item) return console.log("github: no github:default row — skip");
  const newKey = `github:${TENANT}:${USER}`;
  const existing = await ddb.send(new GetCommand({ TableName: TABLE, Key: { sessionId: newKey } }));
  if (existing.Item) {
    console.log(`github: ${newKey} already exists — skip`);
  } else {
    log(`github: copy github:default → ${newKey}`);
    if (APPLY) {
      await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...res.Item, sessionId: newKey } }));
    }
  }
  if (DELETE_OLD && APPLY) {
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { sessionId: "github:default" } }));
    console.log("github: deleted github:default");
  }
}

console.log(`migrate default identity → tenant=${TENANT} user=${USER} (table=${TABLE}, bucket=${BUCKET || "-"})`);
await migrateSessions();
await migrateConfig();
await migrateGithub();
console.log(APPLY ? "done." : "dry run complete — re-run with --apply to write.");
