/**
 * SI recommendation ledger — the durable memory of what self-improvement has
 * ALREADY been asked for, shipped and proven (TEAM-4760 U1).
 *
 * The self-improvement loop reads a finished run, writes recommendations into an
 * analysis row, synthesises a PRD and re-enters the 16-agent pipeline. Nothing in
 * that loop remembered anything ACROSS runs: the same finding could be
 * recommended by three consecutive analyses, batched into three PRDs, and —
 * because nobody ever went back to ask whether the first PRD moved the number —
 * the loop could not tell "not fixed yet" from "fixed, and the metric still
 * looks like that". This module is the one place that memory lives: one row per
 * PATTERN (not per run, not per analysis), keyed `<area>.<slug>`, carrying every
 * occurrence of it, every attempt to fix it, the numbers a fix was expected to
 * move, and the verdicts that judged it afterwards.
 *
 * Two languages, ONE contract. The writers sit in runtimes that cannot share
 * code: the workflow-analyzer and prd-submitter Lambdas (JS) and the Workflow
 * Manager toolkit on the WM harness (Python — deploy/workflow-manager/toolkit/
 * si_ledger.py). Both halves are pinned by a single fixture,
 * deploy/workflow-manager/toolkit/fixtures/si-ledger-contract.json, which both
 * unit suites iterate — the same mechanism fix-lineage.json uses to keep the
 * fix-ticket predicate identical in compute_metrics.py and lambda/cost-report.
 *
 * Why this file is BYTE-COPIED into lambda/prd-submitter/ rather than imported
 * from a lambda/shared/ dir: the CD Deploy stage packages each Lambda by cd'ing
 * into that function's own directory and zipping a per-function file list
 * (`cd "$DIR" && zip -rq /tmp/surface.zip $FILES`, deploy/pipeline/
 * buildspec-deploy.yml), so a module living OUTSIDE the function dir can never
 * reach the Lambda — it would cold-start with ERR_MODULE_NOT_FOUND. The
 * precedent is lambda/agentcore-hub-pipeline-tools/cd-registry.mjs, a byte copy
 * of lambda/orchestrator/cd-registry.mjs pinned by
 * scripts/check-cd-registry-parity.sh.
 *
 * BYTE COPY of lambda/workflow-analyzer/si-ledger.mjs —
 * scripts/check-si-ledger-parity.sh pins them identical; edit the canonical one.
 * The canonical file is lambda/workflow-analyzer/si-ledger.mjs and the copy is
 * lambda/prd-submitter/si-ledger.mjs. This header ships in BOTH files, because a
 * byte copy is a byte copy — whichever of the two you are reading, edit the
 * workflow-analyzer one and re-`cp` it across. The same guard also pins
 * METRIC_NAMES below to the fixture's metricNames list, so the JS enum cannot
 * drift from the contract the Python twin is tested against.
 *
 * The reducers are PURE — they take a row and return a NEW row, never mutating
 * the input — so the fixture can drive them with no AWS in the room, and so a
 * caller can reduce twice before writing once.
 *
 * Row schema (CLOSED — nothing outside these fields is ever written; the table is
 * agentcore-hub-si-ledger, PK `patternKey`):
 *
 *   { patternKey: "harness.silent-death.exit-without-report",  // <area>.<slug>
 *     title:      "one line a human recognises",
 *     status:     "open|batched|in-run|landed|deployed|verified|no-effect|regressed|wont-fix",
 *     firstSeen:  iso, lastSeen: iso,
 *     occurrences: [{ workflowId, analysisId, workflowDefId, severity, at }],
 *     attempts:    [{ prdKey, workflowId, epicId, prNumbers: [], mergedAt, deployedAt,
 *                     outcome: "in-run|landed|deployed|cancelled|error|handoff", note }],
 *     expected:    [{ metric, baseline: { value, runs, window }, target, observeRuns, setAt, prdKey }],
 *     verdicts:    [{ at, prdKey, verdict: "verified|no-effect|regressed|insufficient",
 *                     before, after, note }],
 *     source?:     "backfill" }            // optional provenance, e.g. a backfill
 */

// The DocumentClient itself is INJECTED (see SiLedger) — only the three command
// shapes are imported, so nothing here opens a socket or reads credentials at
// import time and the unit suite can drive the class with a fake client.
// @aws-sdk/lib-dynamodb is provided by the managed Node Lambda runtime, which is
// why lambda/prd-submitter (npm:false in deploy/pipeline/surfaces.json) can hold
// a copy of this file with no node_modules of its own — same as
// lambda/agentcore-hub-tickets.
import { GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

export const SI_LEDGER_TABLE_DEFAULT = "agentcore-hub-si-ledger";

/**
 * The lifecycle of an ask. `open` → `batched` (a PRD is being written) →
 * `in-run` (a pipeline run is carrying it) → `landed` (merged) → `deployed` →
 * `verified` (a verdict says the number moved). `no-effect` / `regressed` are
 * verdict-driven dead ends that go back to `open` (see applyVerdict), and
 * `wont-fix` is the human's off-switch — only an operator sets it, nothing in
 * this module transitions INTO it.
 */
export const STATUSES = Object.freeze([
  "open", "batched", "in-run", "landed", "deployed",
  "verified", "no-effect", "regressed", "wont-fix",
]);

/** How an attempt ended. `handoff` = the PR was opened for another team to merge. */
export const ATTEMPT_OUTCOMES = Object.freeze([
  "in-run", "landed", "deployed", "cancelled", "error", "handoff",
]);

export const VERDICT_VALUES = Object.freeze(["verified", "no-effect", "regressed", "insufficient"]);

/**
 * The metrics a recommendation is allowed to promise to move. A closed list on
 * purpose: "expected impact" as free prose is what made the old loop
 * unfalsifiable — every PRD claimed an improvement and none of them named a
 * number anyone could measure afterwards. Every name here is something the WM
 * toolkit already computes per run, so si_verify can read a before/after without
 * inventing a measurement. Order is part of the contract (the fixture's
 * metricNames array is compared element-wise, in both languages).
 */
export const METRIC_NAMES = Object.freeze([
  "dead_sessions_per_run",
  "missed_rewake_gaps",
  "rework_rounds_v2",
  "rewakes_per_run",
  "ci_recerts_per_run",
  "human_wait_out_of_hours_ms",
  "wm_interventions_per_run",
  "cd_duplicate_executions",
  "analysis_coverage",
  "recommendation_recurrence",
]);

/** How many terminal runs an expectation waits for before a verdict is fair. */
export const DEFAULT_OBSERVE_RUNS = 5;

/** How long a landed/deployed attempt suppresses a re-file (dedupeBlocked). */
export const DEFAULT_FRESH_DAYS = 14;

const KEY_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const KEY_MAX = 120;
const DAY_MS = 86400000;

// ── small helpers ────────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

/**
 * ISO-8601 → epoch ms. Throws rather than returning NaN: every timestamp in this
 * module either orders a row's history or decides whether an ask is fresh, and a
 * silent NaN would quietly answer "not fresh, file it again".
 */
function ms(iso) {
  const t = Date.parse(String(iso ?? ""));
  if (Number.isNaN(t)) throw new Error(`si-ledger: not an ISO-8601 timestamp: ${JSON.stringify(iso)}`);
  return t;
}

function maxIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return ms(b) > ms(a) ? b : a;
}

function minIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return ms(b) < ms(a) ? b : a;
}

function text(value) {
  return value === null || value === undefined ? null : String(value);
}

/** Never store `undefined`: a DDB put drops it, so a row read back would differ. */
function nullish(value) {
  return value === undefined ? null : value;
}

/**
 * Sorted, unique, numeric PR list. Attempts are stamped more than once (a run
 * opens a PR, then merges it), and a number that arrives as the string "1234"
 * from a tool payload must not become a second, different PR.
 */
function prList(values) {
  const out = new Set();
  for (const v of Array.isArray(values) ? values : []) {
    const n = Number(v);
    if (Number.isFinite(n)) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** Deep copy so every reducer can return a new row without touching its input. */
function cloneRow(row) {
  if (!row || typeof row !== "object") throw new Error("si-ledger: reducer needs a ledger row");
  const next = structuredClone(row);
  for (const field of ["occurrences", "attempts", "expected", "verdicts"]) {
    if (!Array.isArray(next[field])) next[field] = [];
  }
  return next;
}

// ── keys ─────────────────────────────────────────────────────────────────────

/**
 * Is this exactly a stable pattern key? `<area>.<slug>` with at least two
 * dot-separated segments, each starting alphanumeric, lower-case, hyphens
 * inside. The two-segment floor is the whole point: `silent-death` alone is not
 * a key anyone can reuse, `harness.silent-death` is — the area is what makes two
 * analyses of different runs land on the SAME row instead of minting a near
 * duplicate.
 */
export function isValidKey(value) {
  const s = String(value ?? "");
  return s.length > 0 && s.length <= KEY_MAX && KEY_RE.test(s);
}

/**
 * Coerce an agent-authored string into a valid key, or throw. Agents mint keys
 * from prose ("Harness silent death: exit without report"), so normalisation is
 * the difference between one row and five. Lower-case, everything outside
 * [a-z0-9._-] becomes a hyphen, repeated hyphens and dots collapse, and each
 * dot-separated segment is trimmed of leading/trailing hyphens. What survives
 * must still satisfy isValidKey — a single-segment key is NOT silently expanded,
 * because guessing an area is worse than making the caller name one.
 */
export function normalizeKey(raw) {
  const lowered = String(raw ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const key = lowered
    .split(".")
    .map((seg) => seg.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join(".");
  if (!isValidKey(key)) {
    throw new Error(
      `si-ledger: invalid patternKey ${JSON.stringify(raw)} (normalised to ${JSON.stringify(key)}) — ` +
      `needs at least two dot-separated segments <area>.<slug>, lower-case, <=${KEY_MAX} chars`,
    );
  }
  return key;
}

// ── row construction + pure reducers ─────────────────────────────────────────

/**
 * A brand-new ledger row: `open`, both timestamps at `at`, all four histories
 * empty. `source` is written only when given (e.g. "backfill" for rows minted
 * from analyses that predate the ledger) so a normal row carries no extra field.
 */
export function newRow({ patternKey, title, at, source } = {}) {
  const when = at || nowIso();
  ms(when);
  const row = {
    patternKey: normalizeKey(patternKey),
    title: String(title ?? "").trim(),
    status: "open",
    firstSeen: when,
    lastSeen: when,
    occurrences: [],
    attempts: [],
    expected: [],
    verdicts: [],
  };
  if (source) row.source = String(source);
  return row;
}

/**
 * Record that this pattern showed up in a run's analysis.
 *
 * Deduped on workflowId + analysisId: re-running ANALYZE over the same run
 * re-files the same findings, and a double-counted occurrence would inflate
 * `recommendation_recurrence` — the very metric the loop uses to decide a
 * pattern is chronic. A duplicate still bumps lastSeen (we DID just look at it),
 * and the first-recorded severity/defId are kept rather than overwritten.
 *
 * Status is deliberately NOT touched. An occurrence on a `verified` row is
 * evidence of a REGRESSION, which only si_verify may rule on (with before/after
 * numbers); auto-reopening here would erase the verified verdict on the strength
 * of one analysis's prose.
 */
export function applyOccurrence(row, occ = {}) {
  const next = cloneRow(row);
  const at = occ.at || nowIso();
  ms(at);
  const workflowId = text(occ.workflowId);
  const analysisId = text(occ.analysisId);
  const already = next.occurrences.some(
    (o) => text(o.workflowId) === workflowId && text(o.analysisId) === analysisId,
  );
  if (!already) {
    next.occurrences.push({
      workflowId,
      analysisId,
      workflowDefId: text(occ.workflowDefId),
      severity: text(occ.severity),
      at,
    });
  }
  next.firstSeen = minIso(next.firstSeen, at);
  next.lastSeen = maxIso(next.lastSeen, at);
  return next;
}

/**
 * Set the lifecycle status.
 *
 * `note` and `at` are accepted for call-site symmetry with the other reducers
 * and are NOT persisted: the row schema is closed, and the durable audit trail
 * of WHY a status moved is attempts[] and verdicts[] — a free-text status log
 * would be a second, unreviewed narrative. Callers log the note themselves.
 */
export function applyStatus(row, status, { note, at } = {}) {
  if (!STATUSES.includes(status)) {
    throw new Error(`si-ledger: invalid status ${JSON.stringify(status)} (expected one of ${STATUSES.join("|")})`);
  }
  void note;
  void at;
  const next = cloneRow(row);
  next.status = status;
  return next;
}

/**
 * Upsert an attempt, keyed on prdKey + workflowId.
 *
 * One SI run is one attempt, stamped repeatedly as it progresses (in-run → PR
 * opened → merged → deployed), so the same prdKey+workflowId must land on the
 * same entry. Only non-null fields are merged, so a later stamp that knows only
 * `deployedAt` cannot blank the mergedAt an earlier one recorded; prNumbers are
 * UNIONed rather than replaced, because a run that opens a second PR must not
 * erase the first link.
 *
 * When the stamp carries an `outcome`, the row's status follows it through
 * statusAfterOutcome — that is how a cancelled or errored SI run returns its
 * keys to `open` instead of leaving them parked in `in-run` forever.
 */
export function applyAttempt(row, attempt = {}) {
  const next = cloneRow(row);
  const prdKey = text(attempt.prdKey);
  const workflowId = text(attempt.workflowId);
  const outcome = attempt.outcome === undefined || attempt.outcome === null ? null : String(attempt.outcome);
  if (outcome !== null && !ATTEMPT_OUTCOMES.includes(outcome)) {
    throw new Error(
      `si-ledger: invalid attempt outcome ${JSON.stringify(attempt.outcome)} ` +
      `(expected one of ${ATTEMPT_OUTCOMES.join("|")})`,
    );
  }

  const existing = next.attempts.find(
    (a) => text(a.prdKey) === prdKey && text(a.workflowId) === workflowId,
  );
  if (existing) {
    if (attempt.epicId !== undefined && attempt.epicId !== null) existing.epicId = text(attempt.epicId);
    if (attempt.mergedAt !== undefined && attempt.mergedAt !== null) existing.mergedAt = text(attempt.mergedAt);
    if (attempt.deployedAt !== undefined && attempt.deployedAt !== null) existing.deployedAt = text(attempt.deployedAt);
    if (attempt.note !== undefined && attempt.note !== null) existing.note = String(attempt.note);
    if (outcome !== null) existing.outcome = outcome;
    if (attempt.prNumbers !== undefined && attempt.prNumbers !== null) {
      existing.prNumbers = prList([...(existing.prNumbers || []), ...attempt.prNumbers]);
    } else {
      existing.prNumbers = prList(existing.prNumbers);
    }
  } else {
    next.attempts.push({
      prdKey,
      workflowId,
      epicId: text(attempt.epicId),
      prNumbers: prList(attempt.prNumbers),
      mergedAt: text(attempt.mergedAt),
      deployedAt: text(attempt.deployedAt),
      outcome: outcome ?? "in-run",
      note: attempt.note === undefined || attempt.note === null ? "" : String(attempt.note),
    });
  }

  if (outcome !== null) next.status = statusAfterOutcome(outcome);
  return next;
}

/**
 * The numbers this attempt promised to move — the falsifiable half of a
 * recommendation. Each entry is validated against METRIC_NAMES (an unnamed
 * metric is a promise nobody can check, so it is rejected loudly), gets
 * observeRuns=5 and setAt=at by default, and is stamped with the prdKey that
 * made the promise. An entry for the same metric + prdKey REPLACES the earlier
 * one: re-synthesising the same PRD restates its expectation, it does not add a
 * second one. Expectations from a DIFFERENT prdKey are kept — that history is
 * how "we tried twice and neither attempt moved it" becomes visible.
 */
export function applyExpected(row, expectedList, { prdKey, at } = {}) {
  const next = cloneRow(row);
  const when = at || nowIso();
  ms(when);
  const stampedPrdKey = text(prdKey);
  const incoming = [];
  for (const raw of Array.isArray(expectedList) ? expectedList : [expectedList]) {
    const entry = raw || {};
    const metric = text(entry.metric);
    if (!METRIC_NAMES.includes(metric)) {
      throw new Error(
        `si-ledger: unknown expected metric ${JSON.stringify(entry.metric)} ` +
        `(expected one of ${METRIC_NAMES.join("|")})`,
      );
    }
    const baseline = entry.baseline && typeof entry.baseline === "object"
      ? {
        value: nullish(entry.baseline.value),
        runs: nullish(entry.baseline.runs),
        window: nullish(entry.baseline.window),
      }
      : null;
    const setAt = entry.setAt || when;
    ms(setAt);
    incoming.push({
      metric,
      baseline,
      target: nullish(entry.target),
      observeRuns: Number.isFinite(Number(entry.observeRuns)) ? Number(entry.observeRuns) : DEFAULT_OBSERVE_RUNS,
      setAt,
      prdKey: entry.prdKey === undefined || entry.prdKey === null ? stampedPrdKey : text(entry.prdKey),
    });
  }
  const replaced = new Set(incoming.map((e) => `${e.metric}|${e.prdKey}`));
  next.expected = [
    ...next.expected.filter((e) => !replaced.has(`${text(e.metric)}|${text(e.prdKey)}`)),
    ...incoming,
  ];
  return next;
}

/**
 * Record si_verify's ruling and move the row accordingly:
 *   verified              → "verified" (the number moved; stop re-filing it)
 *   no-effect | regressed → "open"     (the ask is STILL OWED)
 *   insufficient          → unchanged  (not enough runs yet; ask again later)
 *
 * The attempt is always KEPT. Dropping it on a failed verdict is precisely the
 * bug this feature exists to prevent: the pattern would look untouched, be
 * re-batched into an identical PRD, and the fact that we already tried that fix
 * and it did nothing would be gone.
 */
export function applyVerdict(row, verdict = {}) {
  const value = text(verdict.verdict);
  if (!VERDICT_VALUES.includes(value)) {
    throw new Error(
      `si-ledger: invalid verdict ${JSON.stringify(verdict.verdict)} ` +
      `(expected one of ${VERDICT_VALUES.join("|")})`,
    );
  }
  const next = cloneRow(row);
  const at = verdict.at || nowIso();
  ms(at);
  next.verdicts.push({
    at,
    prdKey: text(verdict.prdKey),
    verdict: value,
    before: verdict.before && typeof verdict.before === "object" ? verdict.before : {},
    after: verdict.after && typeof verdict.after === "object" ? verdict.after : {},
    note: verdict.note === undefined || verdict.note === null ? "" : String(verdict.note),
  });
  if (value === "verified") next.status = "verified";
  else if (value === "no-effect" || value === "regressed") next.status = "open";
  return next;
}

/**
 * Where an attempt's outcome leaves the pattern. `cancelled` and `error` return
 * it to `open` — an SI run that died did not fix anything, and a key left in
 * `in-run` is a recommendation that can never be filed again (dedupeBlocked
 * would suppress it forever). `handoff` counts as `landed`: the PR exists and is
 * out of our hands, so the ask is not still owed to the backlog.
 */
export function statusAfterOutcome(outcome) {
  switch (outcome) {
    case "landed": return "landed";
    case "deployed": return "deployed";
    case "in-run": return "in-run";
    case "cancelled":
    case "error": return "open";
    case "handoff": return "landed";
    default:
      throw new Error(
        `si-ledger: invalid attempt outcome ${JSON.stringify(outcome)} ` +
        `(expected one of ${ATTEMPT_OUTCOMES.join("|")})`,
      );
  }
}

/**
 * May this pattern be filed into a new PRD right now? → { blocked, reason }.
 *
 * The two ways a duplicate ask gets made are "it is already in a run" and "it
 * shipped last week and nobody has measured it yet", so those are the two
 * blocks. A fix that has been out for longer than freshDays with no verdict is
 * NOT blocked — at that point the silence is its own signal and re-filing is the
 * right move. A no-effect/regressed verdict recorded after the attempt shipped
 * unblocks immediately: we know that attempt failed, so the ask is owed again.
 *
 * `reason` is a human sentence, surfaced verbatim by prd-submitter's log line
 * and by the run-analysis skill when it declines to mint a key, so both
 * languages produce the SAME sentence (the fixture pins it).
 */
export function dedupeBlocked(row, { now, freshDays = DEFAULT_FRESH_DAYS } = {}) {
  const nowMs = ms(now || nowIso());
  const key = text(row?.patternKey) || "(unkeyed)";
  const status = text(row?.status) || "open";
  const attempts = Array.isArray(row?.attempts) ? row.attempts : [];
  const verdicts = Array.isArray(row?.verdicts) ? row.verdicts : [];
  const newest = attempts.length ? attempts[attempts.length - 1] : null;

  if (status === "in-run") {
    return {
      blocked: true,
      reason:
        `${key} is already in flight: run ${text(newest?.workflowId) || "unknown"} ` +
        `(PRD ${text(newest?.prdKey) || "unknown"}) is carrying it. File nothing new; let that run land.`,
    };
  }

  if (status === "landed" || status === "deployed") {
    const shippedAt = text(newest?.deployedAt) || text(newest?.mergedAt) || null;
    if (shippedAt && nowMs - ms(shippedAt) <= freshDays * DAY_MS) {
      const refuted = verdicts.some(
        (v) => (v.verdict === "no-effect" || v.verdict === "regressed") && ms(v.at) > ms(shippedAt),
      );
      if (!refuted) {
        const days = Math.floor((nowMs - ms(shippedAt)) / DAY_MS);
        return {
          blocked: true,
          reason:
            `${key} already ${status} ${days}d ago (${shippedAt}, PRD ${text(newest?.prdKey) || "unknown"}) ` +
            `and has no no-effect/regressed verdict since. Let si_verify judge that attempt before filing it again.`,
        };
      }
    }
  }

  return { blocked: false, reason: `${key} is clear to file (status ${status}).` };
}

// ── DynamoDB wrapper ─────────────────────────────────────────────────────────

/**
 * Thin DynamoDB front for the reducers above.
 *
 * The client is INJECTED, never constructed here, so the unit suite drives the
 * whole class with a fake `send()` and never touches AWS (and so a Lambda that
 * already has a DocumentClient does not open a second one).
 *
 * Every write is read-modify-write: get the row, run a pure reducer, `put` the
 * WHOLE reduced row. No UpdateExpressions — the row is four append-only arrays
 * and a status, so an item-level put is both simpler and atomic in the only way
 * that matters here. That is safe because each key has one writer in practice
 * (the analyzer files occurrences, prd-submitter stamps the run that IT
 * submitted, the WM records verdicts one at a time); if that ever stops being
 * true, the fix is a conditional put on a version attribute, not partial
 * updates — the reducers would still be the same code.
 */
export class SiLedger {
  constructor({ ddb, table } = {}) {
    if (!ddb) throw new Error("si-ledger: SiLedger needs an injected DynamoDBDocumentClient ({ ddb })");
    this.ddb = ddb;
    this.table = table || process.env.SI_LEDGER_TABLE || SI_LEDGER_TABLE_DEFAULT;
  }

  /** → the row, or null. Normalises the key so a caller's prose key still hits. */
  async get(key) {
    const patternKey = normalizeKey(key);
    const out = await this.ddb.send(new GetCommand({ TableName: this.table, Key: { patternKey } }));
    return out?.Item || null;
  }

  /**
   * Every row, paged. A Scan is right here and will stay right: the ledger is
   * one row per distinct recommendation pattern — tens, maybe low hundreds — and
   * every consumer (the reuse listing, the markdown render, si_verify's sweep)
   * genuinely wants all of them.
   */
  async list() {
    const rows = [];
    let ExclusiveStartKey;
    do {
      const page = await this.ddb.send(new ScanCommand({
        TableName: this.table,
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }));
      rows.push(...(page?.Items || []));
      ExclusiveStartKey = page?.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return rows;
  }

  /** Full put of an already-reduced row. */
  async put(row) {
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: row }));
    return row;
  }

  /**
   * The create-if-absent entry point — the ONLY method that mints a row, since
   * a pattern exists exactly because some analysis saw it.
   */
  async upsertOccurrence(key, title, occ = {}) {
    const patternKey = normalizeKey(key);
    const current = await this.get(patternKey);
    const base = current || newRow({ patternKey, title, at: occ.at, source: occ.source });
    // A later analysis usually has the better-worded title; keep the existing
    // one when the caller passes nothing rather than blanking it.
    if (current && title && String(title).trim()) base.title = String(title).trim();
    return this.put(applyOccurrence(base, occ));
  }

  /**
   * "These keys are going into a PRD." No attempt is written yet: an attempt
   * needs the run that carries it, and a PRD that is never submitted must not
   * leave a phantom attempt behind. markInRun writes the durable prdKey link.
   * Missing keys are skipped, not fatal — an operator may have deleted a row
   * between synthesis and submission, and that must not fail the submission.
   */
  async markBatched(keys, prdKey) {
    const updated = [];
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const row = await this.get(key);
      if (!row) {
        console.warn(`[si-ledger] markBatched: no row for ${key} — skipped`);
        continue;
      }
      updated.push(await this.put(applyStatus(row, "batched", { note: `batched into ${prdKey}` })));
    }
    return updated;
  }

  /** "A run is carrying these keys" — stamps the in-run attempt on each. */
  async markInRun(keys, { prdKey, workflowId, epicId } = {}) {
    const updated = [];
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const row = await this.get(key);
      if (!row) {
        console.warn(`[si-ledger] markInRun: no row for ${key} — skipped`);
        continue;
      }
      updated.push(await this.put(applyAttempt(row, { prdKey, workflowId, epicId, outcome: "in-run" })));
    }
    return updated;
  }

  /** Progress (or end) the attempt for one key — see applyAttempt. */
  async stampAttempt(key, attempt) {
    const row = await this.requireRow(key, "stampAttempt");
    return this.put(applyAttempt(row, attempt));
  }

  async recordVerdict(key, verdict) {
    const row = await this.requireRow(key, "recordVerdict");
    return this.put(applyVerdict(row, verdict));
  }

  async putExpected(key, expectedList, { prdKey, at } = {}) {
    const row = await this.requireRow(key, "putExpected");
    return this.put(applyExpected(row, expectedList, { prdKey, at }));
  }

  /**
   * Single-key writers throw on a missing row instead of creating one: a verdict
   * or an attempt with no occurrence behind it means the caller invented a key,
   * and inventing keys is how a ledger stops being reusable.
   */
  async requireRow(key, op) {
    const row = await this.get(key);
    if (!row) throw new Error(`si-ledger: ${op}: no row for patternKey ${normalizeKey(key)}`);
    return row;
  }
}
