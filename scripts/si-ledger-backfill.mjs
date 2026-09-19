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
 * arguments) and `renderPlan` (plan -> operator report). The one function that
 * TOUCHES the ledger, `applyPlan`, takes it as an argument, so `main()` only
 * does I/O — and the unit suite can drive the real SiLedger through the real
 * call sites over a fake DynamoDB client. That coverage is not optional: with
 * the ledger behind a lazy import, nothing else in the repo checks that this
 * script and si-ledger.mjs still agree on method names and argument order.
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
 * Mirrors `statusAfterOutcome()` in lambda/workflow-analyzer/si-ledger.mjs: the
 * status an attempt drives its row to. Kept here ONLY so the dry run can predict
 * honestly what `--apply` will leave on the table; the ledger is the enforcer.
 *
 * This replaced a `STATUS_RANK`/`maxStatus` "never downgrade" mirror that the
 * ledger does not actually implement. `applyAttempt` assigns
 * `statusAfterOutcome(outcome)` on EVERY stamp, so a key's status is what its
 * NEWEST attempt says — not the furthest any attempt ever got. The two disagree
 * exactly where it matters: `harness.silent-death` has three deployed fixes and
 * then a run still in flight, and the row is `in-run` (which is what stops
 * dedupeBlocked from letting a fourth PRD be filed against it), while the ranking
 * mirror printed `deployed`. The dry run must not promise a status the apply
 * cannot produce, so there is one rule now and it is the ledger's.
 * `si-ledger-backfill.test.mjs` section 7 pins this map against the real
 * `statusAfterOutcome` for every ATTEMPT_OUTCOMES member.
 */
export const STATUS_AFTER_OUTCOME = Object.freeze({
  "in-run": "in-run",
  landed: "landed",
  deployed: "deployed",
  cancelled: "open",
  error: "open",
  handoff: "landed",
});

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
 * Deployed beats merged beats still-running.
 *
 * `null` for a PRD that was written but NEVER RUN. That is not an attempt: the
 * ledger's `attempts[]` entry is keyed on the run that carried it and its
 * `outcome` is validated against si-ledger.mjs ATTEMPT_OUTCOMES
 * (`in-run|landed|deployed|cancelled|error|handoff`), which has no member for
 * "nobody ever started it" — `applyAttempt` would throw. Nor may it be replayed
 * as a `batched` STATUS write: `applyStatus` sets the status unconditionally, so
 * a never-run PRD naming an already-`verified` pattern would silently downgrade
 * it. So it is REPORTED under `skipped` and nothing is written. The mirror of
 * this rule is `statusAfterOutcome` in lambda/workflow-analyzer/si-ledger.mjs.
 */
export function deriveAttemptOutcome(prd) {
  const run = prd.run || {};
  const at = (outcome) => ({ outcome, status: STATUS_AFTER_OUTCOME[outcome] });
  if (run.deployedAt) return at("deployed");
  if (run.mergedAt) return at("landed");
  if (!run.workflowId) return null;
  // The run's own terminal phase, when the cd-ledger left no stamp (runs that
  // predate cd-ledger.json, or never reached ship). `complete` on a hub run is a
  // merge — the hub repo is CD-registered, so a run cannot complete unmerged —
  // but it is recorded WITHOUT a mergedAt: the ledger's 14-day dedupe window
  // must never start on a guessed date (see cdStamps in workflow-analyzer).
  const phase = String(run.phase || "");
  if (phase === "cancelled") return at("cancelled");
  if (phase === "error") return at("error");
  if (phase === "complete") return at(run.deliveryMode === "handoff" ? "handoff" : "landed");
  if (RUN_BLOCKED_PHASES.has(phase)) return at("error"); // ended without shipping the fix
  if (!run.completedAt) return at("in-run");
  return null;
}

/**
 * Terminal phases on which a run ENDED without shipping: the attempt is over and
 * the pattern is open again (mirrors SHIP_BLOCKED_OUTCOMES in the orchestrator's
 * completion.mjs; kept as data here so the backfill stays stdlib-pure).
 */
export const RUN_BLOCKED_PHASES = new Set([
  "static-ci-only", "deploy-blocked", "ship-blocked", "merge-blocked", "blocked", "failed",
]);

/**
 * Link every PRD to the `[SI]` run that carried it. A PRD object in S3 knows
 * nothing about its run — the link lives on the workflows row: `input.si.prdKey`
 * (runs started after #637) or, for everything older, the run title, which
 * prd-submitter has always built as `"[SI] " + prd.title`. Several runs for one
 * title (a PRD re-submitted after a cancel) → the NEWEST run is the attempt that
 * counts, which is also what `applyAttempt`'s last-write status rule expects.
 *
 * @param prds  `{ key, title, ... }[]`
 * @param runs  `{ workflowId, phase, startedAt, completedAt, epicId, deliveryMode, title, prdKey, mergedAt, deployedAt }[]`
 * @returns the same PRDs with `run` attached where one matched
 */
export function attachRuns(prds, runs = []) {
  const norm = (t) => String(t || "").replace(/^\[SI\]\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
  const byPrdKey = new Map();
  const byTitle = new Map();
  for (const r of runs) {
    if (!r?.workflowId) continue;
    if (r.prdKey) byPrdKey.set(r.prdKey, newer(byPrdKey.get(r.prdKey), r));
    const t = norm(r.title);
    if (t && t !== "undefined") byTitle.set(t, newer(byTitle.get(t), r));
  }
  return prds.map((prd) => {
    if (prd.run) return prd;
    const r = byPrdKey.get(prd.key) || byTitle.get(norm(prd.title));
    if (!r) return prd;
    const { title: _t, prdKey: _k, ...run } = r;
    return { ...prd, run };
  });
}

function newer(a, b) {
  if (!a) return b;
  return String(b.startedAt || "") > String(a.startedAt || "") ? b : a;
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
    const derived = deriveAttemptOutcome(prd);
    if (!derived) {
      // Written, never run — no attempt exists to record. See deriveAttemptOutcome.
      skipped.push({
        kind: "prd",
        prdKey: prd.key,
        patternKey: classified.patternKey,
        title: prd.title || "(untitled)",
        reason: "prd-never-run",
      });
      continue;
    }
    const { outcome, status } = derived;
    const run = prd.run || {};
    const attemptKey = `${classified.patternKey}|${prd.key}`;
    if (seenAttempts.has(attemptKey)) continue;
    seenAttempts.add(attemptKey);
    entry.attempts += 1;
    // Newest REPLAYED attempt wins, because that is what applyAttempt does — it
    // assigns statusAfterOutcome(outcome) on every stamp. PRDs are replayed
    // oldest-first, so the last assignment here is the last write there. A key
    // whose attempts are all already on the row keeps the row's own status: an
    // occurrence never touches it. See STATUS_AFTER_OUTCOME.
    entry.status = status;
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

  // `stampAttempt` is a single-key writer: si-ledger.mjs requireRow() THROWS
  // rather than mint a row, because an attempt with no occurrence behind it
  // means the caller invented a key. So an attempt whose key will have neither a
  // pre-existing row nor an occurrence replayed before it is not writable — drop
  // it from the plan and say so, instead of letting --apply die mid-replay.
  const writableKeys = new Set([
    ...existing.keys(),
    ...occurrences.map((o) => o.patternKey),
  ]);
  const writableAttempts = [];
  for (const a of attempts) {
    if (writableKeys.has(a.patternKey)) {
      writableAttempts.push(a);
      continue;
    }
    const entry = keys.get(a.patternKey);
    if (entry) {
      entry.attempts -= 1;
      // Every attempt for such a key is unbackable (the key has no occurrence at
      // all), so the status this one predicted is withdrawn with it.
      entry.status = existing.get(a.patternKey)?.status || "open";
    }
    skipped.push({
      kind: "prd",
      prdKey: a.attempt.prdKey,
      patternKey: a.patternKey,
      title: entry?.title || a.patternKey,
      reason: "attempt-without-occurrence",
    });
  }

  return {
    occurrences,
    attempts: writableAttempts,
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
    // The reason is printed because they are no longer all the same: a PRD can
    // also be skipped for naming no pattern, for never having run, or for
    // naming a key with no occurrence to hang the attempt on.
    lines.push("", `  skipped (nothing written):`);
    for (const s of plan.skipped) {
      lines.push(`    [${s.reason}] ${s.kind} ${s.prdKey || `${s.workflowId}/${s.analysisId}`}: ${s.title}`);
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

// ── Replay ─────────────────────────────────────────────────────────────────

/**
 * Replay a plan through a REAL `SiLedger` (lambda/workflow-analyzer/si-ledger.mjs).
 *
 * The ledger is injected rather than constructed so this function — the ONLY
 * place the backfill calls the ledger's API — stays importable with no AWS SDK
 * and no ledger module resolvable, and so the unit suite drives these exact call
 * sites against the real class over a fake DocumentClient. That matters: this
 * script cannot import si-ledger.mjs at module scope (see the header), so a
 * rename or a signature change on the other side is invisible to `node --check`
 * and to every pure test. Covering `applyPlan` is what makes that drift fail a
 * test instead of failing an operator's `--apply` half way through a write.
 *
 * Occurrences first, then attempts: `upsertOccurrence` is the only method that
 * mints a row and `stampAttempt` throws on a missing one (buildPlan already
 * drops attempts that no occurrence can back).
 *
 * @param ledger  an `SiLedger` instance (or anything with the same two methods)
 * @param plan    the output of `buildPlan`
 * @returns { occurrences, attempts } counts actually written
 */
export async function applyPlan(ledger, plan) {
  let occurrences = 0;
  let attempts = 0;
  for (const o of plan.occurrences) {
    // `source` rides inside the occurrence because that is where newRow() reads
    // it from (si-ledger.mjs upsertOccurrence → newRow({ source: occ.source })),
    // so only a row this backfill MINTED gets stamped source:"backfill".
    await ledger.upsertOccurrence(o.patternKey, o.title, { ...o.occurrence, source: o.source });
    occurrences += 1;
  }
  for (const a of plan.attempts) {
    await ledger.stampAttempt(a.patternKey, a.attempt);
    attempts += 1;
  }
  return { occurrences, attempts };
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

/**
 * Every SYSTEM `[SI]` PRD object under the prefix, flattened to `{ key, ...body }`.
 * The prefix also holds the agent-eval loop's PRDs (`prd-<agentId>-<ts>.json`,
 * "Improve X based on evaluation findings"); those are a different loop and
 * match no system pattern, so only basenames matching `filter` are read.
 */
async function readPrds(s3, { ListObjectsV2Command, GetObjectCommand }, bucket, prefix, filter = /^system-/) {
  const out = [];
  let ContinuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken }));
    for (const obj of page.Contents || []) {
      if (!obj.Key.endsWith(".json")) continue;
      if (filter && !filter.test(obj.Key.slice(prefix.length))) continue;
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

/**
 * Every `[SI]` run on the workflows table, reduced to what attachRuns() and
 * deriveAttemptOutcome() read. `mergedAt` / `deployedAt` come from the run's
 * `shared/cd-ledger.json` when it exists (same fields the analyzer's cdStamps
 * reads); absent ledger → both null and the terminal phase decides.
 */
async function readSiRuns(ddb, ScanCommand, table, s3, { GetObjectCommand }, bucket) {
  const rows = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: table,
      FilterExpression: "begins_with(#i.title, :p)",
      ExpressionAttributeNames: { "#i": "input" },
      ExpressionAttributeValues: { ":p": "[SI]" },
      ProjectionExpression: "workflowId, phase, startedAt, createdAt, completedAt, finalizedAt, updatedAt, epicId, delivery, #i.title, #i.si",
      ExclusiveStartKey,
    }));
    rows.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  const out = [];
  for (const r of rows) {
    const terminal = ["complete", "cancelled", "error"].includes(r.phase) || RUN_BLOCKED_PHASES.has(String(r.phase));
    let mergedAt = null;
    let deployedAt = null;
    if (r.phase === "complete") {
      try {
        const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `workflows/${r.workflowId}/shared/cd-ledger.json` }));
        const cd = JSON.parse(await obj.Body.transformToString());
        const at = r.finalizedAt || r.completedAt || r.updatedAt || null;
        if (cd?.mergeCommit) mergedAt = cd.mergedAt || at;
        if (cd?.executionId) deployedAt = cd.deployedAt || at;
      } catch { /* no ledger: the phase decides */ }
    }
    out.push({
      workflowId: r.workflowId,
      phase: r.phase,
      startedAt: r.startedAt || r.createdAt || null,
      completedAt: terminal ? (r.finalizedAt || r.completedAt || r.updatedAt || null) : null,
      epicId: r.epicId || null,
      deliveryMode: r.delivery?.mode || null,
      title: r.input?.title || "",
      prdKey: r.input?.si?.prdKey || null,
      mergedAt,
      deployedAt,
    });
  }
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
        "Env: ANALYSES_TABLE, WORKFLOWS_TABLE, SI_LEDGER_TABLE, ARTIFACT_BUCKET, SI_PRD_PREFIX",
        "     (default fleet-imp-agent/prd/), SI_PRD_FILTER (regex on the basename, default ^system-), AWS_REGION",
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
  const workflowsTable = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
  const ledgerTable = process.env.SI_LEDGER_TABLE || "agentcore-hub-si-ledger";
  const bucket = process.env.ARTIFACT_BUCKET;
  // Where prd-submitter's S3 trigger listens (deploy/continuous-improvement): the
  // WM's si-synthesis skill writes system-<ts>.json there.
  const prefix = process.env.SI_PRD_PREFIX || "fleet-imp-agent/prd/";
  const prdFilter = new RegExp(process.env.SI_PRD_FILTER || "^system-");
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
    // Even the dry run needs the ledger: `SiLedger.list()` is the only reader of
    // the table, and a plan built without the existing rows would report a
    // `verified` pattern as brand new.
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
  const ledger = new ledgerMod.SiLedger({ ddb, table: ledgerTable });

  const [analyses, rawPrds, runs, existingRows] = await Promise.all([
    readAnalyses(ddb, ScanCommand, analysesTable),
    readPrds(s3, s3mod, bucket, prefix, prdFilter),
    readSiRuns(ddb, ScanCommand, workflowsTable, s3, s3mod, bucket),
    ledger.list(),
  ]);
  const prds = attachRuns(rawPrds, runs);
  const linked = prds.filter((p) => p.run).length;
  console.log(
    `read ${analyses.length} analyses (${analysesTable}), ${prds.length} PRDs ` +
      `(s3://${bucket}/${prefix}, ${prdFilter}), ${runs.length} [SI] runs (${workflowsTable}), ` +
      `${linked} PRDs linked to a run, ${existingRows.length} existing ledger rows (${ledgerTable})`,
  );

  const plan = buildPlan({ analyses, prds, existingRows });
  console.log(renderPlan(plan));
  if (AS_JSON) console.log(JSON.stringify(plan, null, 1));

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply to write the ledger.");
    return;
  }

  const wrote = await applyPlan(ledger, plan);
  console.log(
    `\nApplied ${wrote.occurrences + wrote.attempts} ledger writes to ${ledgerTable} ` +
      `(${wrote.occurrences} occurrences, ${wrote.attempts} attempts).`,
  );
}

// Run only as a script — importing this file (the tests do) must do no I/O.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(process.env.DEBUG ? err : String(err.message || err));
    process.exitCode = 1;
  });
}
