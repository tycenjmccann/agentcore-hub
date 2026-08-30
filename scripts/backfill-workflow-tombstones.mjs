#!/usr/bin/env node
/**
 * Backfill tombstone rows for workflow ids that appear on Jira tickets
 * (`wf:<id>` labels) but no longer exist in the workflows table — these were
 * hard-deleted before the delete route learned to tombstone, and their
 * tickets show up as "Other" on the dashboard.
 *
 * The def is inferred from the workflow's ticket shapes:
 *   - any Bug issue, or "Triage:" summary            → bug-fix
 *   - "Sweep"/dead-code in summaries                 → dead-code-sweep
 *   - marketing agents in summaries                  → marketing
 *   - otherwise, phase-named tickets (Design/Dev...) → software-delivery
 *
 * Dry run by default. Pass --apply to write.
 *
 * Usage:
 *   AWS_PROFILE=tycenj-prod node scripts/backfill-workflow-tombstones.mjs [--apply]
 * Requires JIRA_SITE_URL / JIRA_EMAIL / JIRA_API_TOKEN (or .env.local at repo root).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const APPLY = process.argv.includes("--apply");
const REGION = process.env.AWS_REGION || "us-east-1";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";

// Load .env.local for Jira creds if not already in env
if (!process.env.JIRA_SITE_URL) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* fall through to the env check below */ }
}

const { JIRA_SITE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || "TEAM";
if (!JIRA_SITE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
  console.error("Missing JIRA_SITE_URL / JIRA_EMAIL / JIRA_API_TOKEN");
  process.exit(1);
}

const auth = `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64")}`;

async function jiraSearch(jql, fields) {
  const issues = [];
  let nextPageToken;
  do {
    const params = new URLSearchParams({ jql, fields, maxResults: "100" });
    if (nextPageToken) params.set("nextPageToken", nextPageToken);
    const res = await fetch(`https://${JIRA_SITE_URL}/rest/api/3/search/jql?${params}`, {
      headers: { Authorization: auth, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Jira ${res.status}: ${await res.text()}`);
    const data = await res.json();
    issues.push(...(data.issues || []));
    nextPageToken = data.isLast === false ? data.nextPageToken : undefined;
  } while (nextPageToken);
  return issues;
}

function inferDefId(tickets) {
  const summaries = tickets.map((t) => (t.fields?.summary || "").toLowerCase());
  const types = tickets.map((t) => t.fields?.issuetype?.name);
  if (types.includes("Bug") || summaries.some((s) => s.startsWith("triage:"))) return "bug-fix";
  if (summaries.some((s) => s.includes("dead-code") || s.includes("dead code") || s.startsWith("sweep"))) return "dead-code-sweep";
  if (summaries.some((s) => s.includes("marketing") || s.includes("content_creator") || s.includes("brand_"))) return "marketing";
  return "software-delivery";
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

// 1. Existing workflow ids
const existing = new Set();
let lastKey;
do {
  const res = await ddb.send(new ScanCommand({
    TableName: WORKFLOWS_TABLE,
    ProjectionExpression: "workflowId",
    ExclusiveStartKey: lastKey,
  }));
  for (const it of res.Items || []) existing.add(it.workflowId);
  lastKey = res.LastEvaluatedKey;
} while (lastKey);
console.log(`${existing.size} rows in ${WORKFLOWS_TABLE}`);

// 2. All wf: labels on tickets + per-wf ticket details
const issues = await jiraSearch(
  `project = ${JIRA_PROJECT_KEY} AND labels IS NOT EMPTY`,
  "labels,summary,issuetype,created,resolutiondate"
);
const byWf = new Map();
for (const iss of issues) {
  const wf = (iss.fields?.labels || []).find((l) => l.startsWith("wf:"))?.slice(3);
  if (!wf || existing.has(wf) || !/^wf_\d+_/.test(wf)) continue;
  if (!byWf.has(wf)) byWf.set(wf, []);
  byWf.get(wf).push(iss);
}
console.log(`${byWf.size} orphaned workflow ids referenced by tickets`);

// 3. Tombstone each orphan
for (const [wfId, tickets] of byWf) {
  const defId = inferDefId(tickets);
  const startedAt = new Date(Number(wfId.split("_")[1])).toISOString();
  const resolvedDates = tickets.map((t) => t.fields?.resolutiondate).filter(Boolean).sort();
  const completedAt = resolvedDates.at(-1) || undefined;
  console.log(`${APPLY ? "WRITE" : "dry-run"}  ${wfId}  def=${defId}  tickets=${tickets.length}  completedAt=${completedAt || "-"}`);
  if (!APPLY) continue;
  await ddb.send(new PutCommand({
    TableName: WORKFLOWS_TABLE,
    Item: {
      workflowId: wfId,
      id: wfId,
      deleted: true,
      deletedAt: new Date().toISOString(),
      backfilled: true,
      phase: "complete",
      workflowDefId: defId,
      startedAt,
      ...(completedAt ? { completedAt } : {}),
    },
  }));
}
console.log(APPLY ? "Done." : "Dry run complete — re-run with --apply to write.");
