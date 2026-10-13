#!/usr/bin/env node
/**
 * TEAM-5591 — re-stamp SI attempts that were recorded `error` on a run that
 * actually shipped.
 *
 * Before TEAM-5591 the analyzer's attempt stamp collapsed every failed
 * cd-ledger read into one fixed "cd-ledger" + "=absent" note, so runs that
 * merged and deployed were recorded `error` ("nothing shipped, the ask is
 * still owed"). Those rows are
 * now `open`, not `in-run`, so the analyzer's own reap sweep never looks at
 * them again. This script finds them and runs the SAME stamp the analyzer runs
 * — `stampSiAttempt` from lambda/workflow-analyzer/index.mjs, which now reads
 * the Ship artifacts — once per run.
 *
 * Selection: a ledger row whose NEWEST attempt has `outcome: "error"`, whose run
 * is `phase: "complete"`. Only those (row, run) pairs are written: a key the run
 * carried whose newest attempt is something else is refused, so re-stamping a
 * run can never drag a row that has since moved on back to this run's status.
 * The selection scan is not trusted at write time: each row is re-read
 * immediately before its write, and the write is refused unless this run's
 * attempt is STILL the row's newest and STILL `error` — applyAttempt sets the
 * row status from the attempt it is handed, so a stale check would let an old
 * run overwrite the status a newer run just set. (What remains is the window
 * between that read and the put; si-ledger has no conditional write, and
 * closing it belongs there, not here.)
 *
 * TEAM-5770 widened the selection. The analyzer ran without ARTIFACT_BUCKET, so
 * its stamps were `error` with `s3://<ARTIFACT_BUCKET unset>/…` probes, and now
 * `unknown` ("could not look"). Also selected:
 *   - a row whose newest attempt is `unknown`;
 *   - an OLDER attempt (not the row's newest) that is `unknown`, or `error` with
 *     a bucket-unset probe in its note. That attempt is corrected in place and
 *     the row's status is left exactly as it is, because a newer run owns it.
 *
 * A run whose evidence still resolves to `error` or `unknown` is not rewritten:
 * the stamp would change only the note, and that is not a reconciliation.
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
 * Env: ARTIFACT_BUCKET (required for --apply; a dry run without it logs the
 *      analyzer's ERROR and shows every attempt as `unknown`), SI_LEDGER_TABLE,
 *      WORKFLOWS_TABLE, AWS_REGION
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

/** Outcomes that say nothing was proven either way (TEAM-5770 added `unknown`). */
const UNRESOLVED = new Set(["error", "unknown"]);

/** The probe text the analyzer wrote while ARTIFACT_BUCKET was unset. */
const BUCKET_UNSET_PROBE = "<ARTIFACT_BUCKET unset>";

/** An older attempt worth correcting: `unknown`, or an `error` stamped blind. */
function blindAttempt(a) {
  return a?.outcome === "unknown" || (a?.outcome === "error" && String(a?.note || "").includes(BUCKET_UNSET_PROBE));
}

/**
 * Ledger rows → `[{ workflowId, keys: [patternKey…], historical? }]`: every run
 * whose attempt is the newest one on a row and is `error` or `unknown`, plus
 * every run with a blind OLDER attempt (see blindAttempt), grouped so each run
 * is stamped once. `historical` lists the keys where this run's attempt is not
 * the row's newest — present only when non-empty. `workflowId` scopes to one
 * run, which is then always returned (with `keys: []` when no row qualifies)
 * so the operator still sees what its evidence resolves to.
 */
export function selectReconcilable(rows, { workflowId } = {}) {
  const byRun = new Map();
  const add = (id, key, historical) => {
    if (workflowId && id !== workflowId) return;
    if (!byRun.has(id)) byRun.set(id, { keys: [], historical: [] });
    const run = byRun.get(id);
    run.keys.push(key);
    if (historical) run.historical.push(key);
  };
  for (const row of rows || []) {
    const attempts = Array.isArray(row?.attempts) ? row.attempts : [];
    const top = newest(row);
    if (top?.workflowId && UNRESOLVED.has(top.outcome)) add(top.workflowId, row.patternKey, false);
    for (const a of attempts.slice(0, -1)) {
      if (a?.workflowId && a.workflowId !== top?.workflowId && blindAttempt(a)) add(a.workflowId, row.patternKey, true);
    }
  }
  if (workflowId && !byRun.has(workflowId)) byRun.set(workflowId, { keys: [], historical: [] });
  return [...byRun].map(([id, { keys, historical }]) => ({
    workflowId: id,
    keys: keys.sort(),
    ...(historical.length ? { historical: historical.sort() } : {}),
  }));
}

/**
 * Is `row`'s newest attempt still this run's `error`/`unknown` attempt for
 * `prdKey`? → null when it is, else the reason it is not. With `historical`,
 * the attempt need not be the newest, but must still be blind (blindAttempt).
 */
export function movedOn(row, { workflowId, prdKey, historical = false }) {
  const top = newest(row);
  if (!top) return "row has no attempt";
  if (historical) {
    const mine = row.attempts.find((a) => a.workflowId === workflowId && (a.prdKey ?? "") === (prdKey ?? ""));
    if (!mine) return `run ${workflowId} (PRD ${prdKey}) has no attempt on the row any more`;
    if (!blindAttempt(mine)) return `this run's attempt is now ${mine.outcome}, not a blind error/unknown`;
    return null;
  }
  if (top.workflowId !== workflowId || (top.prdKey ?? "") !== (prdKey ?? "")) {
    return `newest attempt is now run ${top.workflowId} (PRD ${top.prdKey}), ${top.outcome}`;
  }
  if (!UNRESOLVED.has(top.outcome)) return `this run's attempt is now ${top.outcome}, not error`;
  return null;
}

/**
 * Re-stamp each selected run. `deps` is `{ stampSiAttempt, applyAttempt }` from
 * the analyzer; `getWorkflow(id)` reads the workflows table.
 *
 * The ledger handed to stampSiAttempt is a guard over the real one: it stamps
 * only the selected keys, re-reads each row right before writing it and
 * refuses one that has moved on since the scan (anything refused throws, which
 * stampSiAttempt records in `failed`), and in a dry run it computes the row
 * applyAttempt WOULD write without writing it. On a `historical` key the row's
 * status is put back after applyAttempt: a newer run owns it.
 */
export async function reconcile({ ledger, getWorkflow, s3, bucket, apply = false, workflowId, deps }) {
  const rows = await ledger.list();
  const byKey = new Map(rows.map((r) => [r.patternKey, r]));
  const report = [];
  for (const { workflowId: id, keys, historical = [] } of selectReconcilable(rows, { workflowId })) {
    const wf = await getWorkflow(id);
    if (!wf) {
      report.push({ workflowId: id, keys, skipped: "run not found" });
      continue;
    }
    if (wf.phase !== "complete" || wf.cancelledAt) {
      report.push({ workflowId: id, keys, skipped: `phase=${wf.phase}${wf.cancelledAt ? " (cancelledAt)" : ""}, not complete` });
      continue;
    }
    const mineOn = (k) => (byKey.get(k)?.attempts || []).find((a) => a.workflowId === id);
    const before = Object.fromEntries(keys.map((k) => [k, (historical.includes(k) ? mineOn(k) : newest(byKey.get(k)))?.outcome ?? null]));
    const guard = {
      async stampAttempt(key, attempt) {
        if (!keys.includes(key)) throw new Error(`not selected: newest attempt on ${key} is not this run's error attempt`);
        const row = await ledger.get(key);
        if (!row) throw new Error(`gone: ${key} was deleted since the scan`);
        const isHistorical = historical.includes(key);
        const reason = movedOn(row, { workflowId: id, prdKey: attempt.prdKey, historical: isHistorical });
        if (reason) throw new Error(`moved on since the scan: ${reason} — nothing written`);
        if (UNRESOLVED.has(attempt.outcome)) throw new Error(`unchanged: evidence still resolves to ${attempt.outcome}, nothing written`);
        const next = deps.applyAttempt(row, attempt);
        if (isHistorical) next.status = row.status;
        return apply ? ledger.put(next) : next;
      },
    };
    const result = await deps.stampSiAttempt(wf, "complete", { ledger: guard, s3, bucket });
    report.push({ workflowId: id, keys, historical, before, ...result, applied: apply && !!result.stamped?.length });
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
    for (const k of r.keys) {
      const older = r.historical?.includes(k) ? " (older attempt; row status kept)" : "";
      out.push(`  ${k}: ${r.before?.[k]} → ${r.stamped?.includes(k) ? r.outcome : "NOT stamped"}${older}`);
    }
    for (const k of r.failed || []) if (!r.keys.includes(k)) out.push(`  ${k}: refused (not selected)`);
    if (!r.keys.length) out.push("  no error/unknown attempt selected on the ledger for this run — evidence shown, nothing written");
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

  // TEAM-5770: a dry run without the bucket still runs, so it shows the
  // analyzer's ERROR line and the `unknown` it would stamp; --apply refuses.
  const bucket = process.env.ARTIFACT_BUCKET || "";
  if (!bucket && apply) throw new Error("--apply needs ARTIFACT_BUCKET (source deploy/config.sh)");
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
