#!/usr/bin/env node
/**
 * TEAM-5591 — re-stamp SI attempts that were recorded `error` on a run that
 * actually shipped.
 *
 * Before TEAM-5591 the analyzer's attempt stamp collapsed every failed
 * cd-ledger read into "cd-ledger=absent", so runs that merged and deployed were
 * recorded `error` ("nothing shipped, the ask is still owed"). Those rows are
 * now `open`, not `in-run`, so the analyzer's own reap sweep never looks at
 * them again. This script finds them and runs the SAME stamp the analyzer runs
 * — `stampSiAttempt` from lambda/workflow-analyzer/index.mjs, which now reads
 * the Ship artifacts — once per run.
 *
 * Selection: a ledger row whose NEWEST attempt has `outcome: "error"`, whose run
 * is `phase: "complete"`. Only those (row, run) pairs are written: a key the run
 * carried whose newest attempt is something else is refused, so re-stamping a
 * run can never drag a row that has since moved on back to this run's status.
 *
 * A run whose evidence still resolves to `error` is not rewritten: the stamp
 * would change only the note, and that is not a reconciliation.
 *
 * Idempotent: applyAttempt dedupes on (prdKey, workflowId), so a second run
 * rewrites the same attempt — and once it is no longer `error` it is not
 * selected at all.
 *
 * ── Dry run is the DEFAULT ──────────────────────────────────────────────────
 * The S3 and DynamoDB reads are real either way; `--apply` is what writes.
 *
 * Usage:
 *   node scripts/si-reconcile-attempts.mjs                       # dry run
 *   node scripts/si-reconcile-attempts.mjs --apply               # write the ledger
 *   node scripts/si-reconcile-attempts.mjs --workflow <wfId>     # one run (also reports a run with no attempt)
 *   node scripts/si-reconcile-attempts.mjs --json
 * Env: ARTIFACT_BUCKET (required), SI_LEDGER_TABLE, WORKFLOWS_TABLE, AWS_REGION
 *
 * The analyzer module and the AWS SDK are imported lazily inside main(), so the
 * pure functions below load with no dependencies (same rule as
 * scripts/si-ledger-backfill.mjs).
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The newest attempt on a row, or null. */
function newest(row) {
  const attempts = Array.isArray(row?.attempts) ? row.attempts : [];
  return attempts.length ? attempts[attempts.length - 1] : null;
}

/**
 * Ledger rows → `[{ workflowId, keys: [patternKey…] }]`: every run whose
 * attempt is the newest one on a row and is `error`, grouped so each run is
 * stamped once. `workflowId` scopes to one run, which is then always returned
 * (with `keys: []` when no row qualifies) so the operator still sees what its
 * evidence resolves to.
 */
export function selectReconcilable(rows, { workflowId } = {}) {
  const byRun = new Map();
  for (const row of rows || []) {
    const a = newest(row);
    if (!a?.workflowId || a.outcome !== "error") continue;
    if (workflowId && a.workflowId !== workflowId) continue;
    if (!byRun.has(a.workflowId)) byRun.set(a.workflowId, []);
    byRun.get(a.workflowId).push(row.patternKey);
  }
  if (workflowId && !byRun.has(workflowId)) byRun.set(workflowId, []);
  return [...byRun].map(([id, keys]) => ({ workflowId: id, keys: keys.sort() }));
}

/**
 * Re-stamp each selected run. `deps` is `{ stampSiAttempt, applyAttempt }` from
 * the analyzer; `getWorkflow(id)` reads the workflows table.
 *
 * The ledger handed to stampSiAttempt is a guard over the real one: it stamps
 * only the selected keys (anything else throws, which stampSiAttempt records in
 * `failed`), and in a dry run it computes the row applyAttempt WOULD write
 * without writing it.
 */
export async function reconcile({ ledger, getWorkflow, s3, bucket, apply = false, workflowId, deps }) {
  const rows = await ledger.list();
  const byKey = new Map(rows.map((r) => [r.patternKey, r]));
  const report = [];
  for (const { workflowId: id, keys } of selectReconcilable(rows, { workflowId })) {
    const wf = await getWorkflow(id);
    if (!wf) {
      report.push({ workflowId: id, keys, skipped: "run not found" });
      continue;
    }
    if (wf.phase !== "complete" || wf.cancelledAt) {
      report.push({ workflowId: id, keys, skipped: `phase=${wf.phase}${wf.cancelledAt ? " (cancelledAt)" : ""}, not complete` });
      continue;
    }
    const before = Object.fromEntries(keys.map((k) => [k, newest(byKey.get(k))?.outcome ?? null]));
    const guard = {
      async stampAttempt(key, attempt) {
        if (!keys.includes(key)) throw new Error(`not selected: newest attempt on ${key} is not this run's error attempt`);
        if (attempt.outcome === before[key]) throw new Error(`unchanged: evidence still resolves to ${attempt.outcome}, nothing written`);
        return apply ? ledger.stampAttempt(key, attempt) : deps.applyAttempt(byKey.get(key), attempt);
      },
    };
    const result = await deps.stampSiAttempt(wf, "complete", { ledger: guard, s3, bucket });
    report.push({ workflowId: id, keys, before, ...result, applied: apply && !!result.stamped?.length });
  }
  return report;
}

/** The report, one block per run. */
export function renderReport(report, { apply }) {
  const out = [`si-reconcile-attempts: ${apply ? "APPLY" : "DRY RUN (no writes)"} — ${report.length} run(s)`];
  for (const r of report) {
    out.push(`\n${r.workflowId}`);
    if (r.skipped) {
      out.push(`  skipped: ${r.skipped}`);
      continue;
    }
    if (r.attempt) {
      out.push(`  outcome:    ${r.outcome}`);
      out.push(`  mergedAt:   ${r.attempt.mergedAt}`);
      out.push(`  deployedAt: ${r.attempt.deployedAt}`);
      out.push(`  prNumbers:  ${JSON.stringify(r.attempt.prNumbers)}`);
      out.push(`  note:       ${r.attempt.note}`);
    }
    if (r.error) out.push(`  error: ${r.error}`);
    for (const k of r.keys) out.push(`  ${k}: ${r.before?.[k]} → ${r.stamped?.includes(k) ? r.outcome : "NOT stamped"}`);
    for (const k of r.failed || []) if (!r.keys.includes(k)) out.push(`  ${k}: refused (not selected)`);
    if (!r.keys.length) out.push("  no error attempt selected on the ledger for this run — evidence shown, nothing written");
  }
  return out.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const asJson = argv.includes("--json");
  const wi = argv.indexOf("--workflow");
  const workflowId = wi >= 0 ? argv[wi + 1] : undefined;
  const known = new Set(["--apply", "--dry-run", "--json", "--workflow"]);
  for (const [i, a] of argv.entries()) {
    if (a.startsWith("--") && !known.has(a)) throw new Error(`unknown flag ${a}`);
    if (!a.startsWith("--") && argv[i - 1] !== "--workflow") throw new Error(`unexpected argument ${a}`);
  }
  if (apply && argv.includes("--dry-run")) throw new Error("--apply and --dry-run are mutually exclusive");
  if (wi >= 0 && !workflowId) throw new Error("--workflow needs a workflow id");

  const bucket = process.env.ARTIFACT_BUCKET;
  if (!bucket) throw new Error("ARTIFACT_BUCKET is required (source deploy/config.sh)");
  const region = process.env.AWS_REGION || "us-east-1";
  const workflowsTable = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
  // The analyzer reads WORKFLOW_MANAGER_ARN only inside its handler.
  const analyzer = await import("../lambda/workflow-analyzer/index.mjs");
  const { SiLedger, SI_LEDGER_TABLE_DEFAULT, applyAttempt } = await import("../lambda/workflow-analyzer/si-ledger.mjs");
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, GetCommand } = await import("@aws-sdk/lib-dynamodb");
  const { S3Client } = await import("@aws-sdk/client-s3");

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } });
  const ledger = new SiLedger({ ddb, table: process.env.SI_LEDGER_TABLE || SI_LEDGER_TABLE_DEFAULT });
  const report = await reconcile({
    ledger,
    getWorkflow: async (id) => (await ddb.send(new GetCommand({ TableName: workflowsTable, Key: { workflowId: id } }))).Item,
    s3: new S3Client({ region }),
    bucket,
    apply,
    workflowId,
    deps: { stampSiAttempt: analyzer.stampSiAttempt, applyAttempt },
  });
  console.log(renderReport(report, { apply }));
  if (asJson) console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`si-reconcile-attempts: ${err?.message || err}`);
    process.exit(1);
  });
}
