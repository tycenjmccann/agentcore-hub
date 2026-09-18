#!/usr/bin/env node
/**
 * TEAM-4760 U9 — seed `agentcore-hub-si-ledger` from history that predates it.
 *
 * The SI tracker's whole value is the sentence "this ask has been made 8 times
 * and 6 fixes did nothing". A ledger that starts empty cannot say that until
 * months of new runs accumulate, and the two places that already hold the
 * history are:
 *
 *   1. `agentcore-hub-workflow-analyses` (DynamoDB) — one row per analysed run,
 *      each with `findings[]` / `recommendations[]` (the ask) plus `workflowId`,
 *      `createdAt`, `workflowDefId`. Every item here becomes an OCCURRENCE.
 *   2. `s3://$ARTIFACT_BUCKET/workflow-manager/synthesized-prds/*.json` — the
 *      `[SI]` PRDs the Workflow Manager synthesised from those analyses. Every
 *      one becomes an ATTEMPT against the pattern it asked to fix.
 *
 * ── Why the ledger module is imported LAZILY ────────────────────────────────
 * `lambda/workflow-analyzer/si-ledger.mjs` (canonical; byte copy in
 * `lambda/prd-submitter/`) is the only writer of the table. It is imported
 * inside `main()`, never at module top level — exactly the trick
 * `deploy/workflow-manager/toolkit/compute_metrics.py` plays with boto3 in
 * `request_card()`, and for the same reason: the unit tests import THIS module
 * and must run with neither the ledger module nor the AWS SDK resolvable. The
 * AWS SDK clients are lazy for the same reason, so this file stays stdlib-pure
 * at import time.
 *
 * Everything that makes a decision is therefore a pure exported function:
 * `classify` (text -> patternKey), `buildPlan` (data -> the exact ledger call
 * arguments) and `renderPlan` (plan -> operator report). `main()` only does I/O.
 *
 * ── Dry run is the DEFAULT ──────────────────────────────────────────────────
 * A backfill that writes 88 runs of history because someone forgot a flag is
 * the failure mode worth designing out, so `--apply` is explicit and the report
 * is printed identically in both modes.
 *
 * Usage:
 *   node scripts/si-ledger-backfill.mjs [--dry-run]      # dry run (the default)
 *   node scripts/si-ledger-backfill.mjs --apply          # write the ledger
 *   node scripts/si-ledger-backfill.mjs --json           # plan as JSON too
 * Env: ANALYSES_TABLE, SI_LEDGER_TABLE, ARTIFACT_BUCKET, SI_PRD_PREFIX, AWS_REGION
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── Contract mirrors (this file cannot import si-ledger.mjs; see header) ─────

/**
 * Mirrors `isValidKey()` in lambda/workflow-analyzer/si-ledger.mjs: lowercase
 * alnum segments joined by `.` or `-`, with at least two dot-segments. Kept
 * here so PATTERNS below is validated at load and the tests have one copy to
 * check against. If U1's grammar changes, this and the table fail together.
 */
export const KEY_GRAMMAR = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/** True for a `<area>.<slug>` key that satisfies the grammar above. */
export function isValidPatternKey(key) {
  return typeof key === "string" && KEY_GRAMMAR.test(key) && key.split(".").length >= 2;
}

/**
 * Status progress order, mirroring the ledger's "NEVER downgrade" rule. Used
 * only to compute the status a key ENDS at in the report; the ledger itself is
 * the enforcer, this is so the dry run predicts it honestly.
 *
 * The three verdicts (no-effect / regressed / wont-fix) sit ABOVE deployed on
 * purpose: they are a human/judge conclusion about a pattern, and a backfilled
 * attempt must not quietly erase one.
 */
export const STATUS_RANK = {
  open: 0,
  batched: 1,
  "in-run": 2,
  landed: 3,
  deployed: 4,
  "no-effect": 5,
  regressed: 5,
  "wont-fix": 5,
  verified: 6,
};

const rank = (s) => (s in STATUS_RANK ? STATUS_RANK[s] : 0);
/** The higher-ranked of two statuses — never a downgrade. */
export function maxStatus(a, b) {
  if (!a) return b;
  if (!b) return a;
  return rank(b) > rank(a) ? b : a;
}

// ── The keyword map: the ONE judgement call in this unit ─────────────────────
//
// THIS IS THE ONLY PLACE that decides which SI pattern a finding /
// recommendation / PRD is about. It is a keyword map and nothing cleverer on
// purpose: a backfill runs once, an operator has to be able to read the
// mapping and disagree with a single line of it, and a mis-mapped row is
// cheaper to fix than an opaque classifier. Nothing downstream re-derives a
// key — if a phrase is missing, add it HERE.
//
// Order is precedence, most specific first. Every entry's `title` is the
// canonical row title; the ledger never overwrites an existing title, so a row
// that already exists keeps whatever it was named (see buildPlan).
export const PATTERNS = [
  {
    patternKey: "harness.silent-death",
    title: "Harness invocation dies silently mid-run",
    match: [
      /silent[- ]?death/i,
      /(died|dropped|terminated|exited|stopped|vanished)\s+silently/i,
      /silently\s+(died|dropped|terminated|exited|stopped|vanished)/i,
      /went silent/i,
      /\d+[- ]minute silence/i,
      /no (otel )?spans/i,
      /produced no spans/i,
      /stopped emitting spans/i,
      /(died|vanished) mid[- ]\w+/i,
    ],
  },
  {
    patternKey: "harness.timeout",
    title: "Agent turn exceeds the runtime invocation timeout",
    match: [
      /timed[- ]?out/i,
      /timeout/i,
      /exceeded the (runtime|invocation|lambda) (limit|deadline)/i,
      /hit the \d+ ?s(ec|econd)? (cap|limit)/i,
    ],
  },
  {
    patternKey: "orchestrator.dispatch-stall",
    title: "Ready ticket is never dispatched",
    match: [
      /never (got )?dispatch\w*/i,
      /dispatch stall/i,
      /(stuck|sat) in ready/i,
      /no invoke was issued/i,
    ],
  },
  {
    patternKey: "orchestrator.lease-leak",
    title: "Invocation lease or claim is never released",
    match: [/\blease\b/i, /stale claim/i, /claim (was )?never released/i],
  },
  {
    patternKey: "orchestrator.cascade-gap",
    title: "Cascade leaves dependents unready",
    match: [/cascade/i, /dependents? (were|was) never/i, /blocker edge/i],
  },
  {
    patternKey: "orchestrator.scope-creep",
    title: "Fix lands as orchestrator logic instead of a blueprint change",
    match: [/orchestrator (module|logic|state machine)/i, /\b[A-Z0-9_]+_MODE\b/, /DL-009/i],
  },
  {
    patternKey: "blueprint.self-park",
    title: "Agent does not self-park behind its own fix ticket",
    match: [/self[- ]park\w*/i, /did not park/i, /blocked_by/i, /park(ed)? behind/i],
  },
  {
    patternKey: "blueprint.rework-loop",
    title: "Review/fix rework loop fails to converge",
    match: [
      /rework loop/i,
      /review rounds?/i,
      /rounds? of review/i,
      /ping[- ]?pong/i,
      /loop cap/i,
      /\d+ rounds? of/i,
      /re-?verif\w* loop/i,
    ],
  },
  {
    patternKey: "blueprint.evidence-missing",
    title: "Completion reported without persisted evidence",
    match: [
      /report_completion/i,
      /without evidence/i,
      /no evidence/i,
      /evidence (was )?missing/i,
      /did not persist/i,
    ],
  },
  {
    patternKey: "qa.verification-gap",
    title: "QA passes work that is provably broken",
    match: [/qa (passed|signed off|verified)/i, /verification (gap|missed)/i, /live verify/i, /qa checklist/i],
  },
  {
    patternKey: "pipeline.ci-flake",
    title: "CI fails on a flake, not on the change",
    match: [/flak(e|y)/i, /transient (ci|build) fail\w*/i, /install flake/i],
  },
  {
    // BEFORE gate.human-wait on purpose: the deploy gate IS a human gate, so
    // anything that names it specifically must win over the generic wait.
    patternKey: "pipeline.deploy-gate",
    title: "Deploy gate behaves unpredictably",
    match: [/deploy gate/i, /pre-?approv\w*/i, /approval (was )?skipped/i, /manualapproval/i],
  },
  {
    patternKey: "pipeline.build-failure",
    title: "Build breaks on mechanical lint/lockfile errors",
    match: [/build fail\w*/i, /prettier|eslint|lockfile/i, /red build/i],
  },
  {
    // The catch-all for human latency — everything more specific is above it.
    patternKey: "gate.human-wait",
    title: "Human approval gate dominates wall-clock",
    match: [/human (gate|wait|approval)/i, /merge approval/i, /approval (wait|latency)/i, /waiting on a human/i],
  },
  {
    patternKey: "intake.scope",
    title: "Intake plans the wrong amount of work",
    match: [/(over|under)[- ]?scoped/i, /intake plan\w*/i, /too many tickets/i, /missing tickets/i],
  },
  {
    patternKey: "coding.session-loss",
    title: "Coding session state is lost between turns",
    match: [
      /coding session/i,
      /session (was )?lost/i,
      /resumed on the wrong runtime/i,
      /\/mnt\/workspace/i,
      /workspace (was )?wiped/i,
    ],
  },
  {
    patternKey: "coding.deps",
    title: "Dependency provisioning breaks the CLI turn",
    match: [/node_modules/i, /npm (ci|install)/i, /dependenc\w* (provision|install)\w*/i],
  },
  {
    patternKey: "observability.trace-gap",
    title: "Run cannot be explained from its traces",
    match: [/trace gap/i, /no traces/i, /missing traces?/i, /cannot be explained/i, /unexplained/i],
  },
  {
    patternKey: "cost.token-burn",
    title: "Token burn out of proportion to the change",
    match: [/token burn/i, /cost spike/i, /burned \$?\d/i, /(cost|spend) was disproportionate/i],
  },
  {
    patternKey: "tickets.duplicate",
    title: "The same ask is filed as duplicate tickets",
    match: [/duplicate tickets?/i, /filed twice/i, /same ask.*(twice|again)/i],
  },
];

/** Every key this script can emit — the closed set an operator reviews. */
export const PATTERN_KEYS = PATTERNS.map((p) => p.patternKey);

// Fail loudly at load rather than at write time if the table drifts off grammar.
for (const p of PATTERNS) {
  if (!isValidPatternKey(p.patternKey)) {
    throw new Error(`si-ledger-backfill: invalid patternKey in PATTERNS: ${p.patternKey}`);
  }
}

/**
 * Map free text (a finding/recommendation title+body, or a PRD title+body) to a
 * pattern. Returns `{ patternKey, title }`, or null when nothing matches —
 * null is a real answer, and buildPlan reports it under `skipped` rather than
 * inventing a key.
 */
export function classify(text) {
  const s = String(text || "");
  if (!s.trim()) return null;
  for (const p of PATTERNS) {
    if (p.match.some((re) => re.test(s))) return { patternKey: p.patternKey, title: p.title };
  }
  return null;
}

// ── Plan building (pure) ────────────────────────────────────────────────────

/** Recommendations carry P0/P1/P2; the ledger's occurrences speak severity. */
const PRIORITY_TO_SEVERITY = { P0: "critical", P1: "high", P2: "medium" };

/**
 * What an `[SI]` PRD's run actually achieved, from whatever the object records.
 * A PRD is an ATTEMPT at a pattern; how far that attempt got is the status.
 * Deployed beats merged beats still-running beats "written but never run".
 */
export function deriveAttemptOutcome(prd) {
  const run = prd.run || {};
  if (run.deployedAt) return { outcome: "deployed", status: "deployed" };
  if (run.mergedAt) return { outcome: "landed", status: "landed" };
  if (run.workflowId && !run.completedAt) return { outcome: "in-run", status: "in-run" };
  return { outcome: "batched", status: "batched" };
}

const textOf = (...parts) => parts.filter(Boolean).join("\n");

/**
 * Turn history into the exact ledger calls that will replay it.
 *
 * @param analyses      rows from `agentcore-hub-workflow-analyses`
 * @param prds          `[SI]` PRD objects, each `{ key, title, description, sources[], run? }`
 * @param existingRows  rows already in the ledger (`{ patternKey, status, title }`)
 * @returns { occurrences, attempts, skipped, keys }  — `occurrences`/`attempts`
 *          are literal `upsertOccurrence` / `stampAttempt` argument objects, in
 *          replay order, each stamped `source: "backfill"`.
 *
 * Merge, never clobber: a key already in the ledger still gets its occurrences
 * appended, but the emitted `title` is the EXISTING row's title and the
 * reported status starts from the existing status, so no replay can reset a
 * `verified` row to `open` or rename it.
 */
export function buildPlan({ analyses = [], prds = [], existingRows = [] } = {}) {
  const existing = new Map();
  for (const row of existingRows) {
    if (row && row.patternKey) existing.set(row.patternKey, row);
  }

  const occurrences = [];
  const attempts = [];
  const skipped = [];
  /** patternKey -> { title, occurrences, attempts, status, existing } */
  const keys = new Map();
  /** dedupe: one occurrence per (patternKey, analysis) — three findings about
   *  the same silent death in one run are ONE observation of the pattern. */
  const seen = new Set();
  /** dedupe: one attempt per (patternKey, PRD). */
  const seenAttempts = new Set();
  // Seeded from what the ledger already holds, so applying the backfill twice
  // appends nothing the second time. `upsertOccurrence` APPENDS — without this,
  // a re-run would inflate "made 31 times" to 62.
  for (const row of existingRows) {
    for (const o of row?.occurrences || []) {
      seen.add(`${row.patternKey}|${o.workflowId}|${o.analysisId}`);
    }
    for (const a of row?.attempts || []) {
      seenAttempts.add(`${row.patternKey}|${a.prdKey}`);
    }
  }

  const touch = (patternKey, classified) => {
    if (!keys.has(patternKey)) {
      const row = existing.get(patternKey);
      keys.set(patternKey, {
        patternKey,
        // Existing title wins: the ledger never overwrites one, and the plan
        // must say what will actually be on the row.
        title: row?.title || classified.title,
        occurrences: 0,
        attempts: 0,
        status: row?.status || "open",
        existing: Boolean(row),
      });
    }
    return keys.get(patternKey);
  };

  const byCreatedAt = (a, b) => String(a?.createdAt || "").localeCompare(String(b?.createdAt || ""));

  for (const an of [...analyses].sort(byCreatedAt)) {
    const at = an.createdAt;
    const analysisId = an.analysisId;
    const items = [
      ...(an.findings || []).map((f) => ({
        kind: "finding",
        title: f?.title,
        body: textOf(f?.evidence, f?.phase),
        severity: f?.severity || "medium",
      })),
      ...(an.recommendations || []).map((r) => ({
        kind: "recommendation",
        title: r?.title,
        body: textOf(r?.description, r?.expectedImpact, r?.target),
        severity: PRIORITY_TO_SEVERITY[r?.priority] || "medium",
      })),
    ];

    for (const item of items) {
      const classified = classify(textOf(item.title, item.body));
      if (!classified) {
        skipped.push({
          kind: item.kind,
          workflowId: an.workflowId,
          analysisId,
          title: item.title || "(untitled)",
          reason: "no-pattern-match",
        });
        continue;
      }
      const dedupeKey = `${classified.patternKey}|${an.workflowId}|${analysisId}`;
      const entry = touch(classified.patternKey, classified);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      entry.occurrences += 1;
      occurrences.push({
        patternKey: classified.patternKey,
        title: entry.title,
        source: "backfill",
        occurrence: {
          workflowId: an.workflowId,
          analysisId,
          workflowDefId: an.workflowDefId || "software-delivery",
          severity: item.severity,
          at,
        },
      });
    }
  }

  const prdOrder = (p) =>
    String(p?.run?.startedAt || p?.batch?.generatedAt || p?.generatedAt || p?.key || "");
  for (const prd of [...prds].sort((a, b) => prdOrder(a).localeCompare(prdOrder(b)))) {
    const classified = classify(textOf(prd.title, prd.description));
    if (!classified) {
      skipped.push({ kind: "prd", prdKey: prd.key, title: prd.title || "(untitled)", reason: "no-pattern-match" });
      continue;
    }
    const entry = touch(classified.patternKey, classified);
    const { outcome, status } = deriveAttemptOutcome(prd);
    const run = prd.run || {};
    // The status still counts even when the attempt is already on the row: the
    // key's reported status is the furthest any attempt got it.
    entry.status = maxStatus(entry.status, status);
    const attemptKey = `${classified.patternKey}|${prd.key}`;
    if (seenAttempts.has(attemptKey)) continue;
    seenAttempts.add(attemptKey);
    entry.attempts += 1;
    attempts.push({
      patternKey: classified.patternKey,
      source: "backfill",
      status,
      attempt: {
        prdKey: prd.key,
        workflowId: run.workflowId,
        epicId: run.epicId,
        prNumbers: run.prNumbers || [],
        mergedAt: run.mergedAt,
        deployedAt: run.deployedAt,
        outcome,
        note: `backfilled from ${prd.key}`,
      },
    });
  }

  return {
    occurrences,
    attempts,
    skipped,
    keys: [...keys.values()].sort((a, b) => a.patternKey.localeCompare(b.patternKey)),
  };
}

// ── Report ─────────────────────────────────────────────────────────────────

const pad = (s, n) => String(s).padEnd(n);

/** The operator-facing report, printed in dry-run AND apply mode. */
export function renderPlan(plan) {
  const width = Math.max(24, ...plan.keys.map((k) => k.patternKey.length));
  const lines = ["SI ledger backfill plan", "-".repeat(23)];
  for (const k of plan.keys) {
    lines.push(
      `  ${pad(k.patternKey, width)}  occurrences=${pad(k.occurrences, 4)}` +
        `attempts=${pad(k.attempts, 3)}status=${pad(k.status, 10)}` +
        `${k.existing ? "existing (merged)" : "new"}`,
    );
  }
  if (plan.skipped.length) {
    lines.push("", `  skipped (no pattern matched):`);
    for (const s of plan.skipped) {
      lines.push(`    ${s.kind} ${s.prdKey || `${s.workflowId}/${s.analysisId}`}: ${s.title}`);
    }
  }
  const merged = plan.keys.filter((k) => k.existing).length;
  lines.push(
    "",
    `TOTALS  keys=${plan.keys.length}  occurrences=${plan.occurrences.length}` +
      `  attempts=${plan.attempts.length}  skipped=${plan.skipped.length}  merged=${merged}`,
  );
  return lines.join("\n");
}

// ── I/O (main only) ────────────────────────────────────────────────────────

const LEDGER_MODULE = "../lambda/workflow-analyzer/si-ledger.mjs";

/** Paged Scan of the analyses table, minus the synthesis claim row. */
async function readAnalyses(ddb, ScanCommand, table) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: "workflowId <> :claim",
        ExpressionAttributeValues: { ":claim": "#si-synthesis" }, // lambda/workflow-analyzer SI_CLAIM_PK
        ExclusiveStartKey,
      }),
    );
    out.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

/** Every `[SI]` PRD object under the prefix, flattened to `{ key, ...body }`. */
async function readPrds(s3, { ListObjectsV2Command, GetObjectCommand }, bucket, prefix) {
  const out = [];
  let ContinuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken }));
    for (const obj of page.Contents || []) {
      if (!obj.Key.endsWith(".json")) continue;
      const body = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: obj.Key }));
      try {
        out.push({ key: obj.Key, ...JSON.parse(await body.Body.transformToString()) });
      } catch (err) {
        console.error(`  ! skipping unparseable ${obj.Key}: ${err.message}`);
      }
    }
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      [
        "Usage: node scripts/si-ledger-backfill.mjs [--dry-run|--apply] [--json]",
        "",
        "  --dry-run  read history, print the plan, write nothing (THE DEFAULT)",
        "  --apply    replay the plan through lambda/workflow-analyzer/si-ledger.mjs",
        "  --json     also print the plan as JSON",
        "",
        "Env: ANALYSES_TABLE, SI_LEDGER_TABLE, ARTIFACT_BUCKET, SI_PRD_PREFIX, AWS_REGION",
      ].join("\n"),
    );
    return;
  }
  // An unrecognised flag is an error, not a silent default: "--aply" must not
  // look like it worked, and "--dry-run" must never be the thing that got typo'd
  // on the run that writes.
  const KNOWN = ["--dry-run", "--apply", "--json"];
  const unknown = argv.filter((a) => !KNOWN.includes(a));
  if (unknown.length) {
    console.error(`unknown argument(s): ${unknown.join(" ")} (see --help)`);
    process.exitCode = 1;
    return;
  }
  const APPLY = argv.includes("--apply");
  if (APPLY && argv.includes("--dry-run")) {
    console.error("--dry-run and --apply are mutually exclusive");
    process.exitCode = 1;
    return;
  }
  const AS_JSON = argv.includes("--json");
  const region = process.env.AWS_REGION || "us-east-1";
  const analysesTable = process.env.ANALYSES_TABLE || "agentcore-hub-workflow-analyses";
  const ledgerTable = process.env.SI_LEDGER_TABLE || "agentcore-hub-si-ledger";
  const bucket = process.env.ARTIFACT_BUCKET;
  const prefix = process.env.SI_PRD_PREFIX || "workflow-manager/synthesized-prds/";
  if (!bucket) {
    console.error("ARTIFACT_BUCKET is required (source deploy/config.sh)");
    process.exitCode = 1;
    return;
  }

  // Lazy: keeps this module stdlib-pure at import time so the unit tests run
  // with no node_modules and no si-ledger.mjs. See the header.
  const [{ DynamoDBClient }, { DynamoDBDocumentClient, ScanCommand }, s3mod, ledgerMod] = await Promise.all([
    import("@aws-sdk/client-dynamodb"),
    import("@aws-sdk/lib-dynamodb"),
    import("@aws-sdk/client-s3"),
    // Even the dry run needs the ledger: `listRows()` is the only reader of the
    // table, and a plan built without the existing rows would report a `verified`
    // pattern as brand new.
    import(LEDGER_MODULE).catch((err) => {
      throw new Error(
        `cannot load ${LEDGER_MODULE} — it is the ledger's only writer/reader ` +
          `and must exist before a backfill (${err.code || err.message})`,
      );
    }),
  ]);

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const s3 = new s3mod.S3Client({ region });
  const ledger = ledgerMod.makeLedger({ ddb, table: ledgerTable });

  const [analyses, prds, existingRows] = await Promise.all([
    readAnalyses(ddb, ScanCommand, analysesTable),
    readPrds(s3, s3mod, bucket, prefix),
    ledger.listRows(),
  ]);
  console.log(
    `read ${analyses.length} analyses (${analysesTable}), ${prds.length} PRDs ` +
      `(s3://${bucket}/${prefix}), ${existingRows.length} existing ledger rows (${ledgerTable})`,
  );

  const plan = buildPlan({ analyses, prds, existingRows });
  console.log(renderPlan(plan));
  if (AS_JSON) console.log(JSON.stringify(plan, null, 1));

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply to write the ledger.");
    return;
  }

  let wrote = 0;
  for (const args of plan.occurrences) {
    await ledger.upsertOccurrence(args);
    wrote += 1;
  }
  for (const args of plan.attempts) {
    await ledger.stampAttempt(args);
    wrote += 1;
  }
  console.log(`\nApplied ${wrote} ledger writes to ${ledgerTable}.`);
}

// Run only as a script — importing this file (the tests do) must do no I/O.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(process.env.DEBUG ? err : String(err.message || err));
    process.exitCode = 1;
  });
}
