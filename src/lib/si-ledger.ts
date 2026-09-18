/**
 * Read helpers over agentcore-hub-si-ledger — the SI recommendation ledger.
 *
 * One row per PATTERN (not per run, not per analysis): a defect class the
 * Workflow Manager has recommended fixing, tracked from its first sighting to a
 * measured verdict. Before this table existed the only follow-through record was
 * prose in `workflow-manager/knowledge/<def>.md`, rewritten on every ANALYZE and
 * never linked to a PR — so a cancelled SI run's asks simply vanished and the WM
 * re-derived them days later (the same theme was re-synthesized up to 8 times).
 *
 * Shape is fixed by the writers (`lambda/workflow-analyzer/si-ledger.mjs` and its
 * Python twin `deploy/workflow-manager/toolkit/si_ledger.py`) and mirrored here:
 *
 *   PK  patternKey (S)   `<area>.<slug>`, lowercase, stable — e.g.
 *                        `harness.silent-death.exit-without-report`
 *
 * There is no GSI and no TTL. The table is small (one row per defect class, tens
 * of rows) and permanent: a measured "this fix did nothing" is only worth having
 * if it survives long enough to stop the next re-synthesis of the same ask.
 *
 * Reserved rows: a key beginning with `#` is NOT a pattern. `#metrics` carries
 * the daily `analysis_coverage` series the panel shows. The pattern-key grammar
 * (`^[a-z0-9]…`) can never produce a leading `#`, so the two namespaces cannot
 * collide — the same trick the analyses table uses for its `#si-synthesis` claim
 * row. Every read below splits them apart, so a caller cannot accidentally
 * render a bookkeeping row as a pattern.
 *
 * This module is READ-ONLY by contract: the Evaluations panel never writes to
 * the ledger. Writes belong to the analyzer, prd-submitter, the WM toolkit and
 * the backfill script.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE = process.env.SI_LEDGER_TABLE || "agentcore-hub-si-ledger";

/** Reserved non-pattern row holding the daily analysis-coverage series (D5). */
export const SI_METRICS_KEY = "#metrics";

/** A key starting with this is bookkeeping, never a pattern. */
export const RESERVED_KEY_PREFIX = "#";

/**
 * The status vocabulary, in lifecycle order. `no-effect` and `regressed` are
 * TERMINAL VERDICTS, not statuses: `si_verify.py` records the verdict and puts
 * the row back to `open` with the attempt kept, which is what stops the ask from
 * being silently dropped.
 */
export const SI_STATUSES = [
  "open",
  "batched",
  "in-run",
  "landed",
  "deployed",
  "verified",
  "no-effect",
  "regressed",
  "wont-fix",
] as const;
export type SiStatus = (typeof SI_STATUSES)[number];

export type SiAttemptOutcome = "in-run" | "landed" | "deployed" | "cancelled" | "error" | "handoff";
export type SiVerdictValue = "verified" | "no-effect" | "regressed" | "insufficient";

/** One sighting of the pattern in one run's analysis. */
export interface SiOccurrence {
  workflowId?: string;
  analysisId?: string;
  workflowDefId?: string;
  severity?: string;
  at?: string;
}

/** One attempt to fix the pattern — an SI PRD that became a run. */
export interface SiAttempt {
  prdKey?: string;
  workflowId?: string;
  epicId?: string;
  prNumbers?: number[];
  mergedAt?: string | null;
  deployedAt?: string | null;
  outcome?: SiAttemptOutcome;
  note?: string;
}

/** What the PRD said we should see afterwards, and the baseline it promised it against. */
export interface SiExpected {
  metric?: string;
  baseline?: { value?: number | null; runs?: number | null; window?: string | null };
  target?: number | string | null;
  observeRuns?: number;
  setAt?: string;
  prdKey?: string;
}

/** The arithmetic answer. `before`/`after` are metric → value maps. */
export interface SiVerdict {
  at?: string;
  prdKey?: string;
  verdict?: SiVerdictValue;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  note?: string;
}

export interface SiLedgerRow {
  patternKey: string;
  title?: string;
  status?: SiStatus;
  firstSeen?: string;
  lastSeen?: string;
  occurrences?: SiOccurrence[];
  attempts?: SiAttempt[];
  expected?: SiExpected[];
  verdicts?: SiVerdict[];
  /** `"backfill"` on rows seeded from the pre-ledger analyses. */
  source?: string;
}

/** One UTC day of the analysis-coverage ratio, from the reserved `#metrics` row. */
export interface SiCoverageDay {
  day: string;
  analyses?: number;
  completedRuns?: number;
  /** analyses / completedRuns, 0-1. Null when there were no completed runs. */
  ratio?: number | null;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export function isReservedKey(patternKey: string): boolean {
  return patternKey.startsWith(RESERVED_KEY_PREFIX);
}

/**
 * The pattern-key grammar: `<area>.<slug>[.<slug>…]`, lowercase, segments joined
 * by `.`, words inside a segment joined by `-`. At least one `.` is required —
 * a bare `harness` is a namespace, not a defect class, and keys are only useful
 * for dedupe if two people describing the same defect land on the same string.
 *
 * This mirrors `isValidKey` in `lambda/workflow-analyzer/si-ledger.mjs` and
 * `is_valid_key` in `deploy/workflow-manager/toolkit/si_ledger.py`, which are
 * pinned to each other by `scripts/check-si-ledger-parity.sh` and the shared
 * `fixtures/si-ledger-contract.json`. Keep all three in step: this is the one
 * TypeScript copy, so nothing else in `src/` should re-derive it.
 */
const PATTERN_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

export function isValidPatternKey(patternKey: string): boolean {
  return PATTERN_KEY_RE.test(patternKey);
}

/** Newest verdict by `at`, or null. Order in the array is not trusted. */
export function latestVerdict(row: SiLedgerRow): SiVerdict | null {
  const list = (row.verdicts || []).filter((v) => !!v);
  if (!list.length) return null;
  return [...list].sort((a, b) => String(a.at || "").localeCompare(String(b.at || ""))).at(-1) || null;
}

/**
 * Newest attempt, by whichever of deployedAt / mergedAt it reached, else by the
 * order it was appended (an in-run attempt has neither timestamp yet).
 */
export function latestAttempt(row: SiLedgerRow): SiAttempt | null {
  const list = (row.attempts || []).filter((a) => !!a);
  if (!list.length) return null;
  const stamp = (a: SiAttempt) => String(a.deployedAt || a.mergedAt || "");
  const stamped = list.filter((a) => stamp(a));
  if (!stamped.length) return list[list.length - 1];
  return [...stamped].sort((a, b) => stamp(a).localeCompare(stamp(b))).at(-1) || null;
}

export interface SiLedgerSummary {
  patterns: number;
  openPatterns: number;
  verifiedFixes: number;
  noEffectFixes: number;
  inRun: number;
  occurrences: number;
  /** Latest day's ratio (0-1), or null when the coverage series is empty. */
  analysisCoverage: number | null;
  analysisCoverageDay: string | null;
}

/**
 * Hero tiles. Counted over statuses and recorded verdicts only — nothing here is
 * inferred. `noEffectFixes` counts rows whose LATEST verdict was `no-effect` or
 * `regressed`; those rows are back to `open`, so they are deliberately counted
 * twice (once as open work, once as a fix that did not work) — the two tiles
 * answer different questions.
 */
export function summarizeLedger(rows: SiLedgerRow[], coverage: SiCoverageDay[] = []): SiLedgerSummary {
  let openPatterns = 0;
  let verifiedFixes = 0;
  let noEffectFixes = 0;
  let inRun = 0;
  let occurrences = 0;
  for (const row of rows) {
    if (row.status === "open") openPatterns++;
    if (row.status === "verified") verifiedFixes++;
    if (row.status === "in-run") inRun++;
    occurrences += (row.occurrences || []).length;
    const v = latestVerdict(row)?.verdict;
    if (v === "no-effect" || v === "regressed") noEffectFixes++;
  }
  const days = [...coverage].sort((a, b) => String(a.day).localeCompare(String(b.day)));
  const newest = days.at(-1) || null;
  return {
    patterns: rows.length,
    openPatterns,
    verifiedFixes,
    noEffectFixes,
    inRun,
    occurrences,
    analysisCoverage: newest && typeof newest.ratio === "number" ? newest.ratio : null,
    analysisCoverageDay: newest?.day ?? null,
  };
}

/** Newest activity on a row — what the panel sorts by. */
function activityAt(row: SiLedgerRow): string {
  return String(latestVerdict(row)?.at || row.lastSeen || row.firstSeen || "");
}

export interface SiLedgerListing {
  rows: SiLedgerRow[];
  coverage: SiCoverageDay[];
}

/**
 * Whole-table read, newest activity first. A Scan is the right call here and will
 * stay right: the table holds one row per defect class, so it is tens of rows,
 * and there is no access pattern that a GSI would serve better.
 */
export async function listLedgerRows(): Promise<SiLedgerListing> {
  const rows: SiLedgerRow[] = [];
  let coverage: SiCoverageDay[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey }));
    for (const item of (page.Items || []) as SiLedgerRow[]) {
      if (!item?.patternKey) continue;
      if (item.patternKey === SI_METRICS_KEY) {
        coverage = ((item as unknown as { coverage?: SiCoverageDay[] }).coverage || []).filter((d) => !!d?.day);
        continue;
      }
      if (isReservedKey(item.patternKey)) continue;
      rows.push(item);
    }
    ExclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);

  rows.sort((a, b) => activityAt(b).localeCompare(activityAt(a)));
  return { rows, coverage };
}

/** One pattern, for the drill-down. `null` when the key has no row. */
export async function getLedgerRow(patternKey: string): Promise<SiLedgerRow | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { patternKey } }));
  const item = res.Item as SiLedgerRow | undefined;
  return item?.patternKey ? item : null;
}
