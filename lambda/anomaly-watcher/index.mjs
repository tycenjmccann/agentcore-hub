/**
 * anomaly-watcher Lambda — thin handler (design §0, §4, §5, §6, §7, §9, §10).
 *
 * Trigger: EventBridge Scheduler `agentcore-hub-anomaly-watcher`, rate(10 minutes),
 * IAM-internal. NO function URL, NO API Gateway, NO resource policy. The 10-minute
 * cadence lives in the schedule definition (deploy.sh), never here.
 *
 * Each cycle, in order:
 *   1. Load + validate the bundled bands.yaml. Invalid ⇒ log every error, record
 *      configError in the summary, take ZERO tiered actions (§10.1).
 *   2. INGEST (§4): scan workflows, read each active workflow's events from its
 *      stored cursor, fold them with the PURE aggregate() into hourly bucket
 *      deltas, and persist deltas + cursor in ONE TransactWriteItems. Snapshot
 *      the eval-config counters.
 *   3. DETECT (§3): per metric per group, assemble samples from the aggregate rows
 *      and call the PURE detect(). No statistics live in this file.
 *   4. ACT (§5/§6/§7): highest tier only, and only AFTER a successful conditional
 *      -write claim. T1 logs, T2 diagnoses + pages, T3 files one bug workflow
 *      under the fleet-wide open cap. T2 NEVER calls /api/workflow/start.
 *   5. Emit the §10.2 cycle summary as the last log line. Never throw for retry.
 *
 * All arithmetic that decides an anomaly is in detect.mjs; all schema judgement is
 * in bands-schema.mjs. This file is I/O, ordering and idempotency only.
 *
 * The AWS SDK and js-yaml are imported DYNAMICALLY (inside initClients/loadBands)
 * rather than at module scope, so index.test.mjs can import and unit-test the pure
 * helpers below with no node_modules installed — the same reason
 * routines-runner/index.test.mjs re-declares its payload builder, solved without
 * duplicating the code under test.
 *
 * Environment (§9.2):
 *   EVENTS_TABLE, WORKFLOWS_TABLE, EVAL_CONFIG_TABLE, WATCHER_STATE_TABLE,
 *   WORKFLOW_API_URL, WORKFLOW_ANALYZER_FUNCTION, EVENT_BUS, ANOMALY_REPO_URL,
 *   AWS_REGION
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  aggregate,
  buildEvidenceBundle,
  buildStartPayload,
  canonicalWindowStart,
  detect,
  renderEvidence,
  MAX_RECENT_POINTS,
} from "./detect.mjs";
import { BUCKET_MS, durationToMs, validateBands } from "./bands-schema.mjs";

// ─── constants ────────────────────────────────────────────────────────────────

export const LOG_PREFIX = "[anomaly-watcher]";
/** Canonical cycle length. Must match the schedule's rate(10 minutes) (§5). */
export const CYCLE_MS = 600_000;
/** workflow-analyzer/index.mjs:36 — the fleet's definition of "not open". */
export const TERMINAL_PHASES = new Set(["complete", "cancelled", "error"]);
/** §6 — max OPEN anomaly-filed workflows fleet-wide. */
export const OPEN_WORKFLOW_CAP = 3;
/** TEAM-3334 F3: how many recent ratelimit cycle items supplement the GSI count. */
export const RECENT_FILED_CYCLES = 3;
export const INTAKE_CHANNEL = "anomaly-detector";
export const INTAKE_INDEX = "intakeChannel-index";
export const ANOMALY_PARTITION = "anomaly-watcher";
export const ANOMALY_EVENT_TYPE = "anomaly.detected";
export const EVENT_SOURCE = "agentcore-hub.anomaly-watcher";

/** §4 per-cycle read cap per workflow. Hitting it records truncated:true. */
export const EVENT_PAGE_LIMIT = 500;
export const MAX_EVENT_PAGES = 2;
export const MAX_EVENT_ITEMS = 1000;
/** DynamoDB's hard limit on one TransactWriteItems. */
export const TXN_ITEM_LIMIT = 100;
/** §4.4 — ignore items far behind the cursor's timestamp (mixed eventId formats). */
export const LATE_EVENT_TOLERANCE_MS = 86_400_000;
/** A terminal workflow that started within this window still gets one final drain. */
export const DRAIN_LOOKBACK_MS = 2 * 86_400_000;
/** Bounds one cycle's evaluation fan-out. Truncation is logged, never silent. */
export const MAX_GROUPS_PER_METRIC = 100;

export const CURSOR_TTL_MS = 30 * 86_400_000;
export const POINTS_TTL_MS = 7 * 86_400_000;
export const CONTRIB_TTL_MS = 2 * 86_400_000;
export const RATELIMIT_TTL_MS = 86_400_000;
/** Aggregate/snapshot rows outlive their baseline window by this much (§5). */
export const AGG_TTL_SLACK_MS = 7 * 86_400_000;

export const BANDS_PATH = new URL("./bands.yaml", import.meta.url);

// ─── small pure utilities (exported for index.test.mjs) ───────────────────────

export function errMessage(err) {
  return String(err?.message || err);
}

export function epochMsOf(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new Error(`invalid ISO timestamp: ${iso}`);
  return t;
}

/** Second-precision UTC ISO, the same shape canonicalWindowStart() emits. */
export function isoOf(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Hourly bucket key for an epoch-ms instant, e.g. "2026-08-27T13". */
export function bucketKeyOf(ms) {
  return isoOf(Math.floor(ms / BUCKET_MS) * BUCKET_MS).slice(0, 13);
}

/** Hourly bucket keys covering [startIso, endIso). */
export function bucketRange(startIso, endIso) {
  const end = epochMsOf(endIso);
  const keys = [];
  for (let t = Math.floor(epochMsOf(startIso) / BUCKET_MS) * BUCKET_MS; t < end; t += BUCKET_MS) {
    keys.push(bucketKeyOf(t));
  }
  return keys;
}

/**
 * The scheduled instant for this cycle. Scheduler puts it in `event.time`; the
 * Date.now() fallback exists ONLY here, at entry — never inside detection, and
 * never recomputed per metric, so every metric in a cycle shares one window.
 */
export function resolveScheduledTime(event, fallbackMs) {
  const raw =
    event?.time ?? event?.detail?.time ?? event?.scheduledTime ?? event?.["scheduled-time"];
  const t = typeof raw === "string" ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? t : fallbackMs;
}

/** Minute-precision cycle label used in claim keys and evidence: 2026-08-27T14:20Z. */
export function cycleLabel(canonicalIso) {
  return `${canonicalIso.slice(0, 16)}Z`;
}

/**
 * Absolute window bounds for one metric this cycle.
 *
 * The bounds are snapped DOWN to the hourly aggregate bucket. §5 defines
 * evalEnd = canonicalCycle (10-minute aligned), but the aggregates this watcher
 * reads are hourly (§4): summing the 13:00 bucket while labelling the window
 * 13:20→14:20 would put numbers in a bug report that were never measured over
 * that span. Snapping keeps every reported window exactly the span that was
 * summed, at the cost of evaluating the most recently CLOSED hour. Bucket
 * selection is then exact, so "exclude any bucket overlapping the evaluation
 * window" (§3.2) holds precisely.
 */
export function metricWindows(metric, canonicalCycleIso) {
  const evalMs = durationToMs(metric.evaluationWindow);
  const baselineMs = durationToMs(metric.baselineWindow);
  if (!evalMs || !baselineMs) throw new Error(`metric ${metric.id}: unusable window durations`);
  const evalEndMs = Math.floor(epochMsOf(canonicalCycleIso) / BUCKET_MS) * BUCKET_MS;
  const evalStartMs = evalEndMs - evalMs;
  return {
    baselineStart: isoOf(evalEndMs - baselineMs),
    baselineEnd: isoOf(evalStartMs),
    evalStart: isoOf(evalStartMs),
    evalEnd: isoOf(evalEndMs),
  };
}

// ─── watcher-state keys (§5) ─────────────────────────────────────────────────

export function aggPk(metricId, groupKey) {
  return `agg#${metricId}#${groupKey}`;
}
export function snapPk(agentId) {
  return `snap#eval#${agentId}`;
}
export function cursorPk(workflowId) {
  return `cursor#${workflowId}`;
}
export function pointsPk(metricId, groupKey) {
  return `points#${metricId}#${groupKey}`;
}
export function claimPk(metricId, groupKey) {
  return `claim#${metricId}#${groupKey}`;
}
export const RATELIMIT_PK = "ratelimit#t3";
/**
 * Group registry (addition to §5's table): pk is the ONLY place a groupKey
 * appears in an aggregate key, so there is no query that enumerates the bands of
 * a metric. One row per metric holds its known group keys so every cycle
 * evaluates every warm band — not just the groups that happened to receive
 * events in the last 10 minutes (which would also make the Western Electric
 * point series skip cycles).
 */
export function groupsPk(metricId) {
  return `groups#${metricId}`;
}
/**
 * Per-workflow contribution rows (addition to §5's table): §7 ranks worst
 * offenders across the whole evaluation window, but a cycle only ever holds the
 * last 10 minutes of events in memory. sk = "<bucket>#<workflowId>" so one Query
 * returns the window's attribution.
 */
export function contribPk(metricId, groupKey) {
  return `contrib#${metricId}#${groupKey}`;
}

export function ttlEpoch(fromMs, ttlMs) {
  return Math.floor((fromMs + ttlMs) / 1000);
}

/** §5 — every read of a TTL'd item ALSO checks expiresAt explicitly. */
export function isLive(row, nowEpoch) {
  return !row || !Number.isFinite(row.expiresAt) ? true : row.expiresAt > nowEpoch;
}

// ─── sample assembly (pure) ──────────────────────────────────────────────────

/** Value a single aggregate row contributes as one baseline point (§4). */
export function bucketValue(row, aggregation) {
  if (aggregation === "duration_ms") {
    const n = Number(row?.n) || 0;
    if (n <= 0) return null;
    return { value: Number(row.sum) / n, denominator: n };
  }
  if (aggregation === "rate") {
    const den = Number(row?.den) || 0;
    if (den <= 0) return null;
    return { value: (Number(row.num) || 0) / den, denominator: den };
  }
  return null;
}

/**
 * Fold aggregate rows into detect() samples. Baseline points come from buckets
 * strictly before the evaluation window; the evaluation window's buckets are
 * summed into ONE observed value.
 *
 * evalValue is null — never 0 — when the window has no source data at all: the
 * absent-source rule (§2.2). A zero denominator is absence, not a 0% error rate.
 */
export function buildEventSamples({ rows, metric, windows, nowEpoch }) {
  const evalBuckets = new Set(bucketRange(windows.evalStart, windows.evalEnd));
  const baselinePoints = [];
  let sum = 0;
  let n = 0;
  let num = 0;
  let den = 0;
  for (const row of rows) {
    if (!isLive(row, nowEpoch)) continue;
    if (evalBuckets.has(row.sk)) {
      sum += Number(row.sum) || 0;
      n += Number(row.n) || 0;
      num += Number(row.num) || 0;
      den += Number(row.den) || 0;
      continue;
    }
    const point = bucketValue(row, metric.aggregation);
    if (point) baselinePoints.push({ bucket: row.sk, ...point });
  }
  if (metric.aggregation === "duration_ms") {
    return {
      samples: { baselinePoints, evalValue: n > 0 ? sum / n : null, evalSampleCount: n },
      extras: {},
    };
  }
  return {
    samples: { baselinePoints, evalValue: den > 0 ? num / den : null, evalSampleCount: den },
    extras: { numerator: num, denominator: den },
  };
}

/** Cumulative eval counters → per-bucket averages (§2.2 snapshot_delta_avg). */
export function snapshotTotals(evalScores) {
  let sum = 0;
  let count = 0;
  for (const entry of Object.values(evalScores || {})) {
    sum += Number(entry?.sum) || 0;
    count += Number(entry?.count) || 0;
  }
  return { sum, count };
}

/**
 * Consecutive-snapshot deltas. Rows must be sorted by bucket. A non-positive
 * count delta is dropped: no new scores in that hour (or a counter reset) is
 * absence of data, not a score of zero.
 */
export function snapshotDeltas(rows, nowEpoch) {
  const live = rows.filter((r) => isLive(r, nowEpoch));
  const deltas = [];
  for (let i = 1; i < live.length; i += 1) {
    const prev = live[i - 1];
    const cur = live[i];
    const dCount = (Number(cur.count) || 0) - (Number(prev.count) || 0);
    const dSum = (Number(cur.sum) || 0) - (Number(prev.sum) || 0);
    if (dCount > 0) deltas.push({ bucket: cur.sk, dSum, dCount });
  }
  return deltas;
}

export function buildSnapshotSamples({ rows, windows, nowEpoch }) {
  const evalBuckets = new Set(bucketRange(windows.evalStart, windows.evalEnd));
  const baselinePoints = [];
  let dSum = 0;
  let dCount = 0;
  for (const d of snapshotDeltas(rows, nowEpoch)) {
    if (evalBuckets.has(d.bucket)) {
      dSum += d.dSum;
      dCount += d.dCount;
      continue;
    }
    baselinePoints.push({ bucket: d.bucket, value: d.dSum / d.dCount, denominator: d.dCount });
  }
  return {
    samples: {
      baselinePoints,
      evalValue: dCount > 0 ? dSum / dCount : null,
      evalSampleCount: dCount,
    },
    extras: {},
  };
}

/**
 * Contribution rows → detect() contributors.
 *
 * Rates rank by numerator count (§7). Durations rank by excess over the baseline
 * mean, which is only known after detect() has run — see evaluateGroup's second
 * detect() pass; `sum`/`n` are carried here for it. Snapshot metrics rank by most
 * recent activity for the offending agent.
 */
export function contributorsFrom(rows, metric) {
  const byWorkflow = new Map();
  for (const row of rows) {
    const workflowId = String(row.sk).slice(14); // "<YYYY-MM-DDTHH>#<workflowId>"
    if (!workflowId) continue;
    const cur = byWorkflow.get(workflowId) || { workflowId, sum: 0, n: 0, num: 0, lastBucket: "" };
    cur.sum += Number(row.sum) || 0;
    cur.n += Number(row.n) || 0;
    cur.num += Number(row.num) || 0;
    const bucket = String(row.sk).slice(0, 13);
    if (bucket > cur.lastBucket) cur.lastBucket = bucket;
    byWorkflow.set(workflowId, cur);
  }
  const all = [...byWorkflow.values()];
  if (metric.aggregation === "rate") {
    return all.filter((c) => c.num > 0).map((c) => ({ workflowId: c.workflowId, value: c.num }));
  }
  if (metric.aggregation === "duration_ms") {
    return all.filter((c) => c.n > 0).map((c) => ({ workflowId: c.workflowId, value: c.sum, n: c.n, sum: c.sum }));
  }
  // snapshot_delta_avg: "workflow with most recent activity for the agentId" (§7).
  return all
    .sort((a, b) => (a.lastBucket === b.lastBucket ? b.n - a.n : a.lastBucket < b.lastBucket ? 1 : -1))
    .map((c) => ({ workflowId: c.workflowId, value: c.n || c.num || 1 }));
}

/** Durations: re-rank contributors by excess over the mean once it is known (§7). */
export function excessContributors(contributors, baselineMean) {
  if (!Number.isFinite(baselineMean)) return contributors;
  return contributors
    .map((c) => ({ workflowId: c.workflowId, value: (c.sum ?? c.value) - baselineMean * (c.n ?? 0) }))
    .filter((c) => c.value > 0);
}

// ─── open-count / rate-limit math (pure) ─────────────────────────────────────

/** §6 — open = phase ∉ TERMINAL_PHASES and archived !== true. */
export function openCountFrom(items) {
  return (items || []).filter((w) => !TERMINAL_PHASES.has(w?.phase) && w?.archived !== true).length;
}

/** §6 — cap minus what is open, minus what this cycle already filed. */
export function allowedFilings(openCount, filedThisCycle = 0, cap = OPEN_WORKFLOW_CAP) {
  return Math.max(0, cap - openCount - filedThisCycle);
}

// ─── record builders (pure) ──────────────────────────────────────────────────

/** intervene.py cmd_escalate shape, anomaly flavour (§7). */
export function buildNotification({ cycle, metricId, threshold, details, nowIso }) {
  return {
    id: `notif_aw_${cycle}_${metricId}`,
    type: "anomaly_escalation",
    title: `Anomaly watcher: ${metricId} ≥${threshold}σ`,
    details,
    reviewer: "anomaly-watcher",
    timestamp: nowIso,
    acknowledged: false,
  };
}

/** Fleet-level record under the synthetic workflowId partition (§7). */
export function buildAnomalyEventItem({ eventId, nowIso, bundle, filedWorkflowId }) {
  return {
    workflowId: ANOMALY_PARTITION,
    eventId,
    type: ANOMALY_EVENT_TYPE,
    source: ANOMALY_PARTITION,
    timestamp: nowIso,
    detail: bundle,
    ...(filedWorkflowId ? { filedWorkflowId } : {}),
  };
}

export function buildBusEntry({ bundle, eventBus }) {
  return {
    EventBusName: eventBus,
    Source: EVENT_SOURCE,
    DetailType: ANOMALY_EVENT_TYPE,
    Detail: JSON.stringify(bundle),
  };
}

export function filingFailedMarker(status) {
  return (
    `> ⚠ FILING FAILED (HTTP ${status}) — the watcher tried to file this Tier-3 anomaly ` +
    "as a bug workflow and the intake API rejected the request. Evidence below; file manually."
  );
}

export function filingBlockedMarker(reason) {
  return (
    `> ⚠ NOT FILED — this Tier-3 anomaly met the filing criteria but the watcher could not ` +
    `file it (${reason}). Evidence below; file manually.`
  );
}

/**
 * A metric whose evaluation window could not be fully ingested this cycle.
 * detect() only knows the three cold-start reasons, so §10.1's fourth reason is
 * built here — never file, never page, on partial data.
 */
export function ingestErrorVerdict(metric, groupKey, windows) {
  return {
    metricId: metric.id,
    groupKey,
    status: "insufficient_sample",
    tier: 0,
    observed: null,
    baselineMean: null,
    baselineStddev: null,
    effectiveStddev: null,
    sigma: null,
    direction: metric.direction ?? "upper",
    rulesTriggered: [],
    sampleCount: { baselineBuckets: 0, evalSamples: 0 },
    windows,
    contributors: [],
    insufficientReason: "ingest_error",
  };
}

/** §10.2 — exact key order; durationMs is filled in last. */
export function emptySummary({ cycle, bandsVersion, configHash, configError = null }) {
  return {
    log: "anomaly-watcher.cycle-summary",
    cycle,
    configError,
    bandsVersion,
    configHash,
    ingest: {
      workflowsScanned: 0,
      activeWorkflows: 0,
      eventsRead: 0,
      eventsDeduped: 0,
      truncated: [],
      cursorConflicts: 0,
      evalSnapshots: 0,
      errors: [],
    },
    metrics: [],
    actions: {
      tier1Logged: 0,
      tier2Escalations: 0,
      tier3Filed: [],
      tier3RateLimited: [],
      dedupeSuppressed: [],
      diagnosisInvoked: [],
      failures: [],
    },
    rateLimit: { openCount: null, cap: OPEN_WORKFLOW_CAP, allowed: null },
    durationMs: 0,
  };
}

export function newMetricEntry(metricId) {
  return {
    metricId,
    groups: 0,
    verdicts: { ok: 0, tier1: 0, tier2: 0, tier3: 0, insufficient_sample: 0, disabled: 0 },
  };
}

export function countVerdict(entry, verdict) {
  if (verdict.status === "disabled") entry.verdicts.disabled += 1;
  else if (verdict.status === "insufficient_sample") entry.verdicts.insufficient_sample += 1;
  else if (verdict.tier > 0) entry.verdicts[`tier${verdict.tier}`] += 1;
  else entry.verdicts.ok += 1;
  return entry;
}

/** WE point history is one point per evaluation WINDOW, not per cycle (§3.3). */
export function priorPoints(pointsRow, evalEnd, nowEpoch) {
  if (!pointsRow || !isLive(pointsRow, nowEpoch)) return [];
  return (Array.isArray(pointsRow.recent) ? pointsRow.recent : [])
    .filter((p) => p && Number.isFinite(p.sigma) && String(p.evalEnd) < evalEnd)
    .slice(-MAX_RECENT_POINTS);
}

export function isNewWindow(pointsRow, evalEnd, nowEpoch) {
  if (!pointsRow || !isLive(pointsRow, nowEpoch)) return true;
  const recent = Array.isArray(pointsRow.recent) ? pointsRow.recent : [];
  return !recent.some((p) => String(p?.evalEnd) === evalEnd);
}

export function appendPoint(prior, point) {
  return [...prior, point].slice(-MAX_RECENT_POINTS);
}

/** Sorted union of registry groups and groups touched this cycle, capped. */
export function resolveGroups(registryGroups, touched, cap = MAX_GROUPS_PER_METRIC) {
  const all = [...new Set([...(registryGroups || []), ...(touched || [])])]
    .filter((g) => typeof g === "string" && g.length > 0)
    .sort();
  return { groups: all.slice(0, cap), dropped: Math.max(0, all.length - cap) };
}

export function isConditionalFailure(err) {
  return err?.name === "ConditionalCheckFailedException";
}

/**
 * TEAM-3334 F1: a fetch error thrown before any connection existed (DNS miss,
 * connection refused — Node's fetch wraps the socket error in `cause`) cannot
 * have reached intake, so the request is safe to retry. EVERYTHING else — abort
 * after send, reset mid-response, and any error we cannot place — is ambiguous:
 * the filing may already exist. When in doubt, ambiguous.
 */
export function isPreConnectionError(err) {
  const code = err?.cause?.code || err?.code;
  return code === "ENOTFOUND" || code === "ECONNREFUSED";
}

/** A cancelled transaction whose ONLY condition is the cursor guard (§4). */
export function isCursorConflict(err) {
  if (err?.name !== "TransactionCanceledException") return false;
  const reasons = Array.isArray(err.CancellationReasons) ? err.CancellationReasons : [];
  return reasons.some((r) => r?.Code === "ConditionalCheckFailed");
}

// ─── clients (lazy + injectable) ─────────────────────────────────────────────

export function readEnv(env = process.env) {
  return {
    region: env.AWS_REGION || "us-east-1",
    eventsTable: env.EVENTS_TABLE || "agentcore-hub-events",
    workflowsTable: env.WORKFLOWS_TABLE || "agentcore-hub-workflows",
    evalConfigTable: env.EVAL_CONFIG_TABLE || "agentcore-hub-eval-config",
    stateTable: env.WATCHER_STATE_TABLE || "agentcore-hub-anomaly-watcher-state",
    workflowApiUrl: env.WORKFLOW_API_URL || "",
    analyzerFunction: env.WORKFLOW_ANALYZER_FUNCTION || "agentcore-hub-workflow-analyzer",
    eventBus: env.EVENT_BUS || "default",
    repoUrl: env.ANOMALY_REPO_URL || "",
    // TEAM-3335 F1: proves internal origin to intake for the reserved
    // intakeChannel "anomaly-detector". Empty ⇒ intake fails closed with a 403,
    // which postStart treats as terminal (loud Tier-2 degrade, no retry loop).
    intakeSecret: env.ANOMALY_INTAKE_SECRET || "",
  };
}

let cachedClients = null;

/**
 * Build (once per container) the client bundle every impure function here takes
 * as `ctx.clients`. Commands are handed over as constructors in `cmd` so tests
 * can inject a fake bundle without the SDK on disk.
 */
export async function initClients(env) {
  if (cachedClients) return cachedClients;
  const [dynamo, lib, lambda, eventbridge] = await Promise.all([
    import("@aws-sdk/client-dynamodb"),
    import("@aws-sdk/lib-dynamodb"),
    import("@aws-sdk/client-lambda"),
    import("@aws-sdk/client-eventbridge"),
  ]);
  const ddb = lib.DynamoDBDocumentClient.from(new dynamo.DynamoDBClient({ region: env.region }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  cachedClients = {
    ddb,
    lambda: new lambda.LambdaClient({ region: env.region }),
    events: new eventbridge.EventBridgeClient({ region: env.region }),
    cmd: {
      GetCommand: lib.GetCommand,
      PutCommand: lib.PutCommand,
      UpdateCommand: lib.UpdateCommand,
      DeleteCommand: lib.DeleteCommand,
      QueryCommand: lib.QueryCommand,
      ScanCommand: lib.ScanCommand,
      TransactWriteCommand: lib.TransactWriteCommand,
      InvokeCommand: lambda.InvokeCommand,
      PutEventsCommand: eventbridge.PutEventsCommand,
    },
    fetch: (...args) => fetch(...args),
  };
  return cachedClients;
}

/**
 * Read + validate the bundled bands.yaml. configHash is the SHA-256 of the file
 * BYTES (§8.1), shortened for display in evidence footers; the full digest goes
 * to the log once.
 */
export async function loadBands() {
  let bytes;
  try {
    bytes = readFileSync(BANDS_PATH);
  } catch (err) {
    return { ok: false, errors: [`bands.yaml unreadable: ${errMessage(err)}`], configHash: null, digest: null };
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  const configHash = `sha256:${digest.slice(0, 12)}`;
  let doc;
  try {
    const yaml = await import("js-yaml");
    const load = yaml.load || yaml.default?.load;
    doc = load(bytes.toString("utf8"));
  } catch (err) {
    return { ok: false, errors: [`bands.yaml is not parseable YAML: ${errMessage(err)}`], configHash, digest };
  }
  return { ...validateBands(doc), configHash, digest };
}

// ─── DynamoDB helpers ────────────────────────────────────────────────────────

async function queryAll(ctx, params, { maxPages = 20, failOnTruncation = false } = {}) {
  const items = [];
  let ExclusiveStartKey;
  let pages = 0;
  do {
    const page = await ctx.clients.ddb.send(new ctx.cmd.QueryCommand({ ...params, ExclusiveStartKey }));
    items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
    pages += 1;
  } while (ExclusiveStartKey && pages < maxPages);
  // TEAM-3334 F2: a LastEvaluatedKey surviving the page cap means the result is
  // PARTIAL. Callers whose correctness depends on completeness (the open-count
  // cap, F1 claim verification) pass failOnTruncation to get the error path
  // instead of a silent undercount; the aggregate/snapshot/contrib readers keep
  // the old partial-is-acceptable semantics by not passing it.
  if (ExclusiveStartKey && failOnTruncation) {
    throw new Error(`query truncated after ${pages} pages (LastEvaluatedKey still set)`);
  }
  return items;
}

async function scanAll(ctx, params, { maxPages = 40 } = {}) {
  const items = [];
  let ExclusiveStartKey;
  let pages = 0;
  do {
    const page = await ctx.clients.ddb.send(new ctx.cmd.ScanCommand({ ...params, ExclusiveStartKey }));
    items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
    pages += 1;
  } while (ExclusiveStartKey && pages < maxPages);
  return items;
}

async function getState(ctx, pk, sk) {
  const res = await ctx.clients.ddb.send(
    new ctx.cmd.GetCommand({ TableName: ctx.env.stateTable, Key: { pk, sk } })
  );
  return res.Item || null;
}

// ─── claims (§5) ─────────────────────────────────────────────────────────────

/**
 * Claim-before-act. Success means THIS invocation owns the side effect; a
 * conditional failure means a live claim already covers this (metric, group,
 * tier) and the action is suppressed. Any other error means the state table is
 * unavailable → the action is skipped, never attempted (§10.1).
 */
async function acquireClaim(ctx, { pk, sk, ttlMs, attrs = {}, strict = false }) {
  const Item = {
    pk,
    sk,
    ...attrs,
    claimToken: ctx.requestId,
    createdAt: ctx.nowIso,
    expiresAt: ttlEpoch(ctx.nowMs, ttlMs),
  };
  const params = {
    TableName: ctx.env.stateTable,
    Item,
    ConditionExpression: strict ? "attribute_not_exists(pk)" : "attribute_not_exists(pk) OR expiresAt < :nowEpoch",
  };
  if (!strict) params.ExpressionAttributeValues = { ":nowEpoch": ctx.nowEpoch };
  try {
    await ctx.clients.ddb.send(new ctx.cmd.PutCommand(params));
    return { ok: true };
  } catch (err) {
    if (isConditionalFailure(err)) return { ok: false, duplicate: true };
    return { ok: false, error: errMessage(err) };
  }
}

/** Ownership-conditioned release, so we never delete another invocation's claim. */
async function releaseClaim(ctx, { pk, sk }) {
  try {
    await ctx.clients.ddb.send(
      new ctx.cmd.DeleteCommand({
        TableName: ctx.env.stateTable,
        Key: { pk, sk },
        ConditionExpression: "claimToken = :mine",
        ExpressionAttributeValues: { ":mine": ctx.requestId },
      })
    );
  } catch (err) {
    if (!isConditionalFailure(err)) {
      console.error(`${LOG_PREFIX} claim release failed for ${pk}/${sk}:`, errMessage(err));
    }
  }
}

// TEAM-3334 F1: ownerToken lets the unverified-claim resolver annotate a claim
// created by an EARLIER invocation; default remains this invocation's own claims.
async function annotateClaim(ctx, { pk, sk, fields, ownerToken }) {
  const names = {};
  const values = { ":mine": ownerToken ?? ctx.requestId };
  const sets = [];
  for (const [key, value] of Object.entries(fields)) {
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    sets.push(`#${key} = :${key}`);
  }
  try {
    await ctx.clients.ddb.send(
      new ctx.cmd.UpdateCommand({
        TableName: ctx.env.stateTable,
        Key: { pk, sk },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ConditionExpression: "claimToken = :mine",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
  } catch (err) {
    console.error(`${LOG_PREFIX} claim annotate failed for ${pk}/${sk}:`, errMessage(err));
  }
}

// ─── INGEST (§4) ─────────────────────────────────────────────────────────────

function isActiveWorkflow(w) {
  return !TERMINAL_PHASES.has(w?.phase) && w?.archived !== true;
}

async function scanWorkflows(ctx) {
  return scanAll(ctx, {
    TableName: ctx.env.workflowsTable,
    ProjectionExpression: "workflowId, phase, archived, startedAt",
  });
}

async function readEvents(ctx, workflowId, cursor) {
  const values = { ":w": workflowId };
  let keyExpr = "workflowId = :w";
  if (cursor?.lastEventId) {
    keyExpr = "workflowId = :w AND eventId > :c";
    values[":c"] = cursor.lastEventId;
  }
  const items = [];
  let ExclusiveStartKey;
  let pages = 0;
  let truncated = false;
  do {
    const page = await ctx.clients.ddb.send(
      new ctx.cmd.QueryCommand({
        TableName: ctx.env.eventsTable,
        KeyConditionExpression: keyExpr,
        ExpressionAttributeValues: values,
        Limit: EVENT_PAGE_LIMIT,
        ExclusiveStartKey,
      })
    );
    items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
    pages += 1;
    if (ExclusiveStartKey && (pages >= MAX_EVENT_PAGES || items.length >= MAX_EVENT_ITEMS)) {
      truncated = true;
      break;
    }
  } while (ExclusiveStartKey);
  return { items, truncated };
}

/**
 * §4.4 — the events table holds two eventId formats, both ms-timestamp-prefixed
 * but not mutually ordered. An item far behind the cursor's timestamp is a
 * format artefact, not a late write, and is ignored rather than folded into a
 * bucket days in the past.
 */
function dropStaleItems(items, cursor) {
  if (!cursor?.lastTimestamp) return items;
  let floor;
  try {
    floor = epochMsOf(cursor.lastTimestamp) - LATE_EVENT_TOLERANCE_MS;
  } catch {
    return items;
  }
  return items.filter((it) => {
    const t = Date.parse(it?.timestamp);
    return !Number.isFinite(t) || t >= floor;
  });
}

function buildIngestTxnItems(ctx, { workflowId, phase, cursor, folded, cursorAt }) {
  const items = [];
  const cursorValues = {
    ":new": cursorAt.lastEventId,
    ":ts": cursorAt.lastTimestamp,
    ":phase": phase ?? null,
    ":pairs": folded.openPairs,
    ":now": ctx.nowIso,
    ":ttl": ttlEpoch(ctx.nowMs, CURSOR_TTL_MS),
  };
  if (cursor?.lastEventId) cursorValues[":prev"] = cursor.lastEventId;
  items.push({
    Update: {
      TableName: ctx.env.stateTable,
      Key: { pk: cursorPk(workflowId), sk: "cursor" },
      UpdateExpression:
        "SET lastEventId = :new, lastTimestamp = :ts, #phase = :phase, openPairs = :pairs, updatedAt = :now, expiresAt = :ttl",
      ExpressionAttributeNames: { "#phase": "phase" },
      ExpressionAttributeValues: cursorValues,
      ConditionExpression: cursor?.lastEventId
        ? "attribute_not_exists(lastEventId) OR lastEventId = :prev"
        : "attribute_not_exists(lastEventId)",
    },
  });

  const metricsTouched = new Map();
  for (const delta of folded.bucketDeltas) {
    const metric = ctx.metricsById.get(delta.metricId);
    if (!metric) continue;
    const bucketMs = epochMsOf(`${delta.bucket}:00:00Z`);
    const aggTtl = ttlEpoch(bucketMs, durationToMs(metric.baselineWindow) + AGG_TTL_SLACK_MS);
    const isRate = metric.aggregation === "rate";
    const names = isRate ? { "#num": "num", "#den": "den" } : { "#n": "n", "#sum": "sum", "#sumSq": "sumSq" };
    const values = isRate
      ? { ":dnum": delta.num, ":dden": delta.den, ":ttl": aggTtl, ":now": ctx.nowIso }
      : { ":dn": delta.n, ":dsum": delta.sum, ":dsq": delta.sumSq, ":ttl": aggTtl, ":now": ctx.nowIso };
    items.push({
      Update: {
        TableName: ctx.env.stateTable,
        Key: { pk: aggPk(delta.metricId, delta.groupKey), sk: delta.bucket },
        UpdateExpression: isRate
          ? "SET expiresAt = if_not_exists(expiresAt, :ttl), updatedAt = :now ADD #num :dnum, #den :dden"
          : "SET expiresAt = if_not_exists(expiresAt, :ttl), updatedAt = :now ADD #n :dn, #sum :dsum, #sumSq :dsq",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      },
    });
    // Per-workflow attribution for §7. Safe to attribute the whole delta to this
    // workflow: ingest folds exactly one workflow's events at a time.
    const contribTtl = ttlEpoch(bucketMs, CONTRIB_TTL_MS);
    items.push({
      Update: {
        TableName: ctx.env.stateTable,
        Key: { pk: contribPk(delta.metricId, delta.groupKey), sk: `${delta.bucket}#${workflowId}` },
        UpdateExpression: isRate
          ? "SET expiresAt = if_not_exists(expiresAt, :ttl) ADD #num :dnum, #den :dden"
          : "SET expiresAt = if_not_exists(expiresAt, :ttl) ADD #n :dn, #sum :dsum",
        ExpressionAttributeNames: isRate ? { "#num": "num", "#den": "den" } : { "#n": "n", "#sum": "sum" },
        ExpressionAttributeValues: isRate
          ? { ":dnum": delta.num, ":dden": delta.den, ":ttl": contribTtl }
          : { ":dn": delta.n, ":dsum": delta.sum, ":ttl": contribTtl },
      },
    });
    if (!metricsTouched.has(delta.metricId)) metricsTouched.set(delta.metricId, new Set());
    metricsTouched.get(delta.metricId).add(delta.groupKey);
  }

  for (const [metricId, groups] of metricsTouched) {
    const metric = ctx.metricsById.get(metricId);
    items.push({
      Update: {
        TableName: ctx.env.stateTable,
        Key: { pk: groupsPk(metricId), sk: "groups" },
        UpdateExpression: "SET expiresAt = :ttl ADD #groups :g",
        ExpressionAttributeNames: { "#groups": "groups" },
        ExpressionAttributeValues: {
          ":g": new Set([...groups]),
          ":ttl": ttlEpoch(ctx.nowMs, durationToMs(metric.baselineWindow) + AGG_TTL_SLACK_MS),
        },
      },
    });
  }
  return items;
}

/** Groups this cycle actually wrote to, so a brand-new band is evaluated at once. */
function noteTouchedGroups(ctx, bucketDeltas) {
  for (const delta of bucketDeltas) {
    const touched = ctx.touchedGroups.get(delta.metricId) || new Set();
    touched.add(delta.groupKey);
    ctx.touchedGroups.set(delta.metricId, touched);
  }
}

async function ingestWorkflow(ctx, wf, { drain }) {
  const workflowId = wf.workflowId;
  const cursor = await getState(ctx, cursorPk(workflowId), "cursor");
  // A workflow that went terminal gets exactly one final drain: after this write
  // the cursor records the terminal phase, and it is skipped until it TTLs out.
  // A MISSING cursor must NOT skip: a workflow that started and went terminal
  // between two watcher runs arrives here drain-first, and returning early
  // would orphan all of its events until it ages out of DRAIN_LOOKBACK_MS —
  // its first drain is also its final one.
  if (drain && cursor && TERMINAL_PHASES.has(cursor.phase)) return;

  const { items: raw, truncated } = await readEvents(ctx, workflowId, cursor);
  const usable = dropStaleItems(raw, cursor);
  if (!usable.length) {
    // Stamp the terminal phase even when no cursor row exists yet (UpdateCommand
    // creates it): a cursor-less terminal workflow with nothing to read would
    // otherwise re-enter this drain every cycle until DRAIN_LOOKBACK_MS.
    if (drain) {
      await ctx.clients.ddb.send(
        new ctx.cmd.UpdateCommand({
          TableName: ctx.env.stateTable,
          Key: { pk: cursorPk(workflowId), sk: "cursor" },
          UpdateExpression: "SET #phase = :phase, updatedAt = :now, expiresAt = :ttl",
          ExpressionAttributeNames: { "#phase": "phase" },
          ExpressionAttributeValues: {
            ":phase": wf.phase ?? null,
            ":now": ctx.nowIso,
            ":ttl": ttlEpoch(ctx.nowMs, CURSOR_TTL_MS),
          },
        })
      );
    }
    return;
  }

  // One TransactWriteItems carries the cursor and every delta it accounts for, so
  // an ADD can never be applied without its cursor advance. DynamoDB caps a
  // transaction at 100 items; if a batch touches more, fold a shorter slice
  // (which strictly reduces buckets, so this terminates) and let the rest ride to
  // the next cycle rather than splitting the atomic write.
  let slice = usable;
  let folded;
  let txnItems;
  for (;;) {
    folded = aggregate(slice, ctx.config, { openPairs: cursor?.openPairs || [] });
    const last = slice[slice.length - 1];
    const wholeBatch = slice.length === usable.length;
    const lastRaw = raw[raw.length - 1];
    const cursorAt = wholeBatch
      ? { lastEventId: lastRaw.eventId, lastTimestamp: lastRaw.timestamp ?? last.timestamp ?? ctx.nowIso }
      : { lastEventId: last.eventId, lastTimestamp: last.timestamp ?? ctx.nowIso };
    txnItems = buildIngestTxnItems(ctx, { workflowId, phase: wf.phase, cursor, folded, cursorAt });
    if (txnItems.length <= TXN_ITEM_LIMIT || slice.length <= 1) break;
    slice = slice.slice(0, Math.floor(slice.length / 2));
  }
  if (slice.length !== usable.length) {
    console.warn(
      `${LOG_PREFIX} ${workflowId}: batch split to ${slice.length}/${usable.length} events to fit one transaction`
    );
    ctx.summary.ingest.truncated.push({ workflowId, reason: "transaction_item_limit", events: slice.length });
    // Partial ingest = incomplete eval window. Same fail-closed rule as an
    // ingest error: evaluating a prefix of a workflow's events can fabricate a
    // rate/duration anomaly. The cursor still advances for what WAS folded, so
    // the remainder rides to the next cycle and evaluation resumes then.
    ctx.ingestErrors.events = true;
  }

  try {
    await ctx.clients.ddb.send(new ctx.cmd.TransactWriteCommand({ TransactItems: txnItems }));
  } catch (err) {
    if (isCursorConflict(err)) {
      // The other invocation wrote these same events; nothing is lost and the
      // eval window is NOT incomplete, so metrics stay evaluable this cycle.
      ctx.summary.ingest.cursorConflicts += 1;
      console.warn(`${LOG_PREFIX} cursor conflict on ${workflowId} — skipping, will re-read next cycle`);
      return;
    }
    throw err;
  }

  noteTouchedGroups(ctx, folded.bucketDeltas);
  ctx.summary.ingest.eventsRead += folded.stats.eventsRead;
  ctx.summary.ingest.eventsDeduped += folded.stats.eventsDeduped;
  if (truncated) {
    ctx.summary.ingest.truncated.push({ workflowId, reason: "page_cap", events: folded.stats.eventsRead });
    // Same fail-closed rule: a capped read means this cycle saw only a prefix.
    ctx.ingestErrors.events = true;
  }
  for (const evicted of folded.evictedOpenPairs || []) {
    console.warn(
      `${LOG_PREFIX} ${workflowId}: evicted unmatched ${evicted.type} for ticket ${evicted.ticketId} ` +
        `(openPairs cap reached)`
    );
  }
}

async function snapshotEvalConfig(ctx) {
  let items;
  try {
    items = await scanAll(ctx, { TableName: ctx.env.evalConfigTable });
  } catch (err) {
    ctx.summary.ingest.errors.push({ stage: "evalConfigScan", error: errMessage(err) });
    ctx.ingestErrors.evalConfig = true;
    console.error(`${LOG_PREFIX} eval-config scan failed:`, errMessage(err));
    return;
  }
  const bucket = bucketKeyOf(ctx.nowMs);
  const bucketMs = epochMsOf(`${bucket}:00:00Z`);
  const ttl = ttlEpoch(bucketMs, ctx.snapshotTtlMs);
  const agents = [];
  for (const item of items) {
    const agentId = item?.agentId;
    if (!agentId) continue;
    const totals = snapshotTotals(item.evalScores);
    try {
      await ctx.clients.ddb.send(
        new ctx.cmd.PutCommand({
          TableName: ctx.env.stateTable,
          Item: {
            pk: snapPk(agentId),
            sk: bucket,
            evalScores: item.evalScores || {},
            evalSessionCount: Number(item.evalSessionCount) || 0,
            sum: totals.sum,
            count: totals.count,
            updatedAt: ctx.nowIso,
            expiresAt: ttl,
          },
        })
      );
      agents.push(agentId);
    } catch (err) {
      ctx.summary.ingest.errors.push({ stage: "evalSnapshot", agentId, error: errMessage(err) });
      ctx.ingestErrors.evalConfig = true;
    }
  }
  ctx.summary.ingest.evalSnapshots = agents.length;
  ctx.snapshotAgents = agents.sort();

  // Register the agents so a failed eval-config scan on a later cycle still has a
  // group list to evaluate (and to force ingest_error rather than silence).
  for (const metric of ctx.config?.metrics || []) {
    if (metric.source?.kind !== "eval-config-snapshot" || !agents.length) continue;
    try {
      await ctx.clients.ddb.send(
        new ctx.cmd.UpdateCommand({
          TableName: ctx.env.stateTable,
          Key: { pk: groupsPk(metric.id), sk: "groups" },
          UpdateExpression: "SET expiresAt = :ttl ADD #groups :g",
          ExpressionAttributeNames: { "#groups": "groups" },
          ExpressionAttributeValues: {
            ":g": new Set(agents),
            ":ttl": ttlEpoch(ctx.nowMs, durationToMs(metric.baselineWindow) + AGG_TTL_SLACK_MS),
          },
        })
      );
    } catch (err) {
      ctx.summary.ingest.errors.push({ stage: "groupRegistry", metricId: metric.id, error: errMessage(err) });
    }
  }
}

async function ingest(ctx) {
  // Event folding needs a validated config: advancing cursors without one would
  // silently drop those events from every baseline forever. The eval-config
  // snapshot is config-independent, so it still runs (§10.1).
  if (ctx.summary.configError) {
    ctx.ingestErrors.events = true;
    console.error(`${LOG_PREFIX} bands.yaml invalid — event ingest skipped, cursors left untouched`);
    await snapshotEvalConfig(ctx);
    return;
  }

  let workflows;
  try {
    workflows = await scanWorkflows(ctx);
  } catch (err) {
    ctx.summary.ingest.errors.push({ stage: "workflowScan", error: errMessage(err) });
    ctx.ingestErrors.events = true;
    console.error(`${LOG_PREFIX} workflows scan failed:`, errMessage(err));
    await snapshotEvalConfig(ctx);
    return;
  }

  ctx.summary.ingest.workflowsScanned = workflows.length;
  const active = workflows.filter(isActiveWorkflow);
  ctx.summary.ingest.activeWorkflows = active.length;
  // Terminal-but-recent workflows may still have unread tail events. Bounded by
  // startedAt so this is a handful of extra cursor reads, not a second full pass.
  const draining = workflows.filter(
    (w) =>
      !isActiveWorkflow(w) &&
      w.archived !== true &&
      w.startedAt &&
      Number.isFinite(Date.parse(w.startedAt)) &&
      ctx.nowMs - Date.parse(w.startedAt) <= DRAIN_LOOKBACK_MS
  );

  for (const wf of [...active.map((w) => ({ wf: w, drain: false })), ...draining.map((w) => ({ wf: w, drain: true }))]) {
    try {
      await ingestWorkflow(ctx, wf.wf, { drain: wf.drain });
    } catch (err) {
      // One workflow's failure must not block the others, but it DOES mean the
      // evaluation window is incomplete → every event metric is forced to
      // insufficient_sample this cycle (§10.1: never file on partial data).
      ctx.summary.ingest.errors.push({ stage: "ingestWorkflow", workflowId: wf.wf.workflowId, error: errMessage(err) });
      ctx.ingestErrors.events = true;
      console.error(`${LOG_PREFIX} ingest failed for ${wf.wf.workflowId}:`, errMessage(err));
    }
  }

  await snapshotEvalConfig(ctx);
}

// ─── EVALUATE (§3) ───────────────────────────────────────────────────────────

async function groupsForMetric(ctx, metric) {
  if (metric.source?.groupBy === "fleet") return ["fleet"];
  let registry = [];
  try {
    const row = await getState(ctx, groupsPk(metric.id), "groups");
    if (row && isLive(row, ctx.nowEpoch)) registry = [...(row.groups || [])];
  } catch (err) {
    ctx.summary.actions.failures.push({ metricId: metric.id, stage: "groupRegistry", error: errMessage(err) });
  }
  const touched =
    metric.source?.kind === "eval-config-snapshot" ? ctx.snapshotAgents : [...(ctx.touchedGroups.get(metric.id) || [])];
  const { groups, dropped } = resolveGroups(registry, touched);
  if (dropped > 0) {
    console.warn(`${LOG_PREFIX} metric ${metric.id}: evaluating ${groups.length} groups, ${dropped} dropped this cycle`);
  }
  return groups;
}

async function readAggregateRows(ctx, metric, groupKey, windows) {
  const from = bucketKeyOf(epochMsOf(windows.baselineStart));
  const to = bucketKeyOf(epochMsOf(windows.evalEnd) - BUCKET_MS);
  return queryAll(ctx, {
    TableName: ctx.env.stateTable,
    KeyConditionExpression: "pk = :pk AND sk BETWEEN :a AND :b",
    ExpressionAttributeValues: { ":pk": aggPk(metric.id, groupKey), ":a": from, ":b": to },
  });
}

async function readSnapshotRows(ctx, groupKey, windows) {
  // One bucket before the baseline start, so the first baseline bucket has a
  // predecessor to difference against.
  const from = bucketKeyOf(epochMsOf(windows.baselineStart) - BUCKET_MS);
  const to = bucketKeyOf(epochMsOf(windows.evalEnd) - BUCKET_MS);
  const rows = await queryAll(ctx, {
    TableName: ctx.env.stateTable,
    KeyConditionExpression: "pk = :pk AND sk BETWEEN :a AND :b",
    ExpressionAttributeValues: { ":pk": snapPk(groupKey), ":a": from, ":b": to },
  });
  return rows.sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0));
}

async function readContributorRows(ctx, metric, groupKey, windows) {
  const buckets = bucketRange(windows.evalStart, windows.evalEnd);
  if (!buckets.length) return [];
  // Snapshot metrics have no contribution rows of their own (eval scores are not
  // events). Their §7 target is the workflow most recently active for the same
  // agentId, which the duration metric's attribution already records.
  const sourceMetricId =
    metric.source?.kind === "eval-config-snapshot"
      ? ctx.agentAttributionMetricId
      : metric.id;
  if (!sourceMetricId) return [];
  return queryAll(ctx, {
    TableName: ctx.env.stateTable,
    KeyConditionExpression: "pk = :pk AND sk BETWEEN :a AND :b",
    ExpressionAttributeValues: {
      ":pk": contribPk(sourceMetricId, groupKey),
      // sk is "<bucket>#<workflowId>"; ￿ is the upper bound of the last bucket.
      ":a": `${buckets[0]}#`,
      ":b": `${buckets[buckets.length - 1]}#￿`,
    },
  });
}

async function evaluateGroup(ctx, metric, groupKey, windows, entry) {
  // Incomplete ingest ⇒ no verdict at all this cycle, before any read or action:
  // a partially-ingested window can look calm or catastrophic and neither is
  // evidence (§10.1).
  if (metric.source?.kind === "eval-config-snapshot" ? ctx.ingestErrors.evalConfig : ctx.ingestErrors.events) {
    countVerdict(entry, ingestErrorVerdict(metric, groupKey, windows));
    console.warn(`${LOG_PREFIX} ${metric.id}/${groupKey}: forced insufficient_sample (ingest_error)`);
    return;
  }

  const pointsRow = await getState(ctx, pointsPk(metric.id, groupKey), "points");
  const isSnapshot = metric.source?.kind === "eval-config-snapshot";
  const rows = isSnapshot
    ? await readSnapshotRows(ctx, groupKey, windows)
    : await readAggregateRows(ctx, metric, groupKey, windows);
  const built = isSnapshot
    ? buildSnapshotSamples({ rows, windows, nowEpoch: ctx.nowEpoch })
    : buildEventSamples({ rows, metric, windows, nowEpoch: ctx.nowEpoch });
  const extras = built.extras;

  const contribRows = await readContributorRows(ctx, metric, groupKey, windows);
  const rawContributors = contributorsFrom(contribRows, metric);
  const config = { metric, windows, groupKey };
  const samples = {
    ...built.samples,
    recentPoints: priorPoints(pointsRow, windows.evalEnd, ctx.nowEpoch),
    contributors: rawContributors,
  };

  let verdict = detect(samples, config);
  if (metric.aggregation === "duration_ms" && Number.isFinite(verdict.baselineMean)) {
    // §7 ranks duration offenders by excess over the baseline mean, which only
    // exists after the first pass. detect() is pure, so re-running it with the
    // corrected contributor values changes nothing but the ranking.
    verdict = detect({ ...samples, contributors: excessContributors(rawContributors, verdict.baselineMean) }, config);
  }
  countVerdict(entry, verdict);

  const fresh = isNewWindow(pointsRow, windows.evalEnd, ctx.nowEpoch);
  if (Number.isFinite(verdict.sigma) && fresh) {
    await writePoint(ctx, metric, groupKey, pointsRow, { evalEnd: windows.evalEnd, sigma: verdict.sigma });
  }

  if (verdict.tier <= 0) return;
  // agentIds are only reported when the band IS an agent (groupBy agentId), never
  // inferred for a fleet band — §8.1 keeps relatedIdentifiers observation-only.
  const agentIds = metric.source?.groupBy === "fleet" ? [] : [groupKey];
  const actExtras = { ...extras, agentIds, deployMarkers: [] };
  if (verdict.tier === 1) await tier1(ctx, verdict, fresh);
  else if (verdict.tier === 2) await tier2(ctx, metric, verdict, actExtras, {});
  else await tier3(ctx, metric, verdict, actExtras);
}

async function writePoint(ctx, metric, groupKey, pointsRow, point) {
  const recent = appendPoint(priorPoints(pointsRow, point.evalEnd, ctx.nowEpoch), point);
  try {
    await ctx.clients.ddb.send(
      new ctx.cmd.PutCommand({
        TableName: ctx.env.stateTable,
        Item: {
          pk: pointsPk(metric.id, groupKey),
          sk: "points",
          recent,
          updatedAt: ctx.nowIso,
          expiresAt: ttlEpoch(ctx.nowMs, POINTS_TTL_MS),
        },
      })
    );
  } catch (err) {
    ctx.summary.actions.failures.push({
      metricId: metric.id,
      groupKey,
      stage: "pointHistory",
      error: errMessage(err),
    });
  }
}

// ─── ACT ─────────────────────────────────────────────────────────────────────

async function tier1(ctx, verdict, fresh) {
  if (!fresh) {
    ctx.summary.actions.dedupeSuppressed.push({
      metricId: verdict.metricId,
      groupKey: verdict.groupKey,
      tier: 1,
      reason: "window_already_evaluated",
    });
    return;
  }
  console.log(JSON.stringify({ log: "anomaly-watcher.tier1", cycle: ctx.cycle, verdict }));
  ctx.summary.actions.tier1Logged += 1;
}

function bundleFor(ctx, verdict, extras, { rateLimited = false, requested = [] } = {}) {
  return buildEvidenceBundle(verdict, {
    ...extras,
    rateLimited,
    diagnosis: { requested, via: ctx.env.analyzerFunction },
    cycle: ctx.cycle,
    bandsVersion: ctx.config?.version ?? 1,
    configHash: ctx.configHash,
  });
}

/**
 * Tier 2: read-only diagnosis + operator notification + fleet records.
 * NEVER calls /api/workflow/start — only tier3() files a workflow.
 *
 * Also the degradation path for Tier 3 (rate-limited, or filing rejected): those
 * callers already hold the t3 claim, so `claimed` skips a second claim and
 * `marker` prepends the reason the bug was not filed.
 */
async function tier2(ctx, metric, verdict, extras, { claimed = false, rateLimited = false, marker = null }) {
  const claim = { pk: claimPk(metric.id, verdict.groupKey), sk: "t2" };
  if (!claimed) {
    const got = await acquireClaim(ctx, {
      ...claim,
      ttlMs: durationToMs(metric.suppression?.tier2Ttl || "2h"),
      attrs: {
        tier: 2,
        windowStart: verdict.windows.evalStart,
        windowEnd: verdict.windows.evalEnd,
        sigma: verdict.sigma,
      },
    });
    if (!got.ok) {
      if (got.duplicate) {
        ctx.summary.actions.dedupeSuppressed.push({
          metricId: metric.id,
          groupKey: verdict.groupKey,
          tier: 2,
          reason: "claim_held",
        });
      } else {
        ctx.summary.actions.failures.push({
          metricId: metric.id,
          groupKey: verdict.groupKey,
          stage: "tier2Claim",
          error: got.error,
        });
      }
      return;
    }
  }

  // Diagnosis first, so the evidence records what was actually requested.
  const maxTargets = Number.isFinite(metric.diagnosis?.maxTargets) ? metric.diagnosis.maxTargets : 2;
  const targets = verdict.contributors.slice(0, maxTargets).map((c) => c.workflowId);
  const requested = [];
  if (!targets.length) {
    console.log(
      JSON.stringify({ log: "anomaly-watcher.no_diagnosis_target", cycle: ctx.cycle, metricId: metric.id, groupKey: verdict.groupKey })
    );
  }
  for (const workflowId of targets) {
    try {
      await ctx.clients.lambda.send(
        new ctx.cmd.InvokeCommand({
          FunctionName: ctx.env.analyzerFunction,
          InvocationType: "Event",
          Payload: Buffer.from(JSON.stringify({ workflowId, trigger: "manual" })),
        })
      );
      requested.push(workflowId);
      ctx.summary.actions.diagnosisInvoked.push({ metricId: metric.id, workflowId });
    } catch (err) {
      // Keep the notification: a failed diagnosis must not hide the anomaly.
      ctx.summary.actions.failures.push({
        metricId: metric.id,
        groupKey: verdict.groupKey,
        stage: "diagnosisInvoke",
        workflowId,
        error: errMessage(err),
      });
      console.error(`${LOG_PREFIX} analyzer invoke failed for ${workflowId}:`, errMessage(err));
    }
  }

  const bundle = bundleFor(ctx, verdict, extras, { rateLimited, requested });
  const rendered = renderEvidence(bundle);
  const details = marker ? `${marker}\n\n${rendered}` : rendered;

  const attachTo = verdict.contributors[0]?.workflowId;
  if (attachTo) {
    const notification = buildNotification({
      cycle: ctx.cycle,
      metricId: metric.id,
      threshold: metric.sigmaThresholds?.[`tier${verdict.tier}`] ?? verdict.tier,
      details,
      nowIso: ctx.nowIso,
    });
    try {
      await ctx.clients.ddb.send(
        new ctx.cmd.UpdateCommand({
          TableName: ctx.env.workflowsTable,
          Key: { workflowId: attachTo },
          UpdateExpression:
            "SET humanNotifications = list_append(if_not_exists(humanNotifications, :empty), :n)",
          ConditionExpression: "attribute_exists(workflowId)",
          ExpressionAttributeValues: { ":n": [notification], ":empty": [] },
        })
      );
    } catch (err) {
      ctx.summary.actions.failures.push({
        metricId: metric.id,
        groupKey: verdict.groupKey,
        stage: "notification",
        workflowId: attachTo,
        error: errMessage(err),
      });
    }
  }

  await emitFleetRecords(ctx, metric, verdict, bundle);
  ctx.summary.actions.tier2Escalations += 1;
}

/** Fleet-level record + relay hook — always at tier ≥ 2 (§7). */
async function emitFleetRecords(ctx, metric, verdict, bundle, filedWorkflowId) {
  ctx.seq += 1;
  const eventId = `${ctx.nowMs}-aw${String(ctx.seq).padStart(2, "0")}`;
  try {
    await ctx.clients.ddb.send(
      new ctx.cmd.PutCommand({
        TableName: ctx.env.eventsTable,
        Item: buildAnomalyEventItem({ eventId, nowIso: ctx.nowIso, bundle, filedWorkflowId }),
      })
    );
  } catch (err) {
    ctx.summary.actions.failures.push({
      metricId: metric.id,
      groupKey: verdict.groupKey,
      stage: "anomalyEvent",
      error: errMessage(err),
    });
  }
  try {
    await ctx.clients.events.send(
      new ctx.cmd.PutEventsCommand({ Entries: [buildBusEntry({ bundle, eventBus: ctx.env.eventBus })] })
    );
  } catch (err) {
    ctx.summary.actions.failures.push({
      metricId: metric.id,
      groupKey: verdict.groupKey,
      stage: "putEvents",
      error: errMessage(err),
    });
  }
}

/** §6 step 1 — one open-count query per cycle, memoized. */
async function openState(ctx) {
  if (ctx.openStateCache) return ctx.openStateCache;
  try {
    // TEAM-3334 F2: failOnTruncation — a partial index read must land in the
    // fail-closed catch below, never a silent undercount that bypasses the cap.
    const items = await queryAll(
      ctx,
      {
        TableName: ctx.env.workflowsTable,
        IndexName: INTAKE_INDEX,
        KeyConditionExpression: "intakeChannel = :c",
        ExpressionAttributeValues: { ":c": INTAKE_CHANNEL },
      },
      { failOnTruncation: true }
    );
    // TEAM-3334 F3: the GSI is eventually consistent, so a workflow filed in the
    // last few cycles may not be indexed yet. Union the filed lists recorded on
    // the recent ratelimit cycle items into the count. An id absent from the GSI
    // cannot be proven closed, so it counts as OPEN (fail closed toward the
    // cap); once the GSI catches up, the item's real phase takes over. A failed
    // supplemental read throws into the catch below: fail closed, allowed 0.
    const gsiIds = new Set(items.map((w) => w?.workflowId).filter(Boolean));
    const recentFiled = new Set();
    for (let k = 0; k < RECENT_FILED_CYCLES; k += 1) {
      const sk = cycleLabel(isoOf(epochMsOf(ctx.canonicalCycle) - k * CYCLE_MS));
      const row = await getState(ctx, RATELIMIT_PK, sk);
      if (!row || !isLive(row, ctx.nowEpoch)) continue;
      for (const id of Array.isArray(row.filed) ? row.filed : []) {
        if (typeof id === "string" && id && !gsiIds.has(id)) recentFiled.add(id);
      }
    }
    const openCount = openCountFrom(items) + recentFiled.size;
    ctx.openStateCache = { openCount, cap: OPEN_WORKFLOW_CAP, allowed: allowedFilings(openCount) };
  } catch (err) {
    // Fail CLOSED: an unverifiable cap must never authorise a filing.
    ctx.openStateCache = { openCount: null, cap: OPEN_WORKFLOW_CAP, allowed: 0, error: errMessage(err) };
    console.error(`${LOG_PREFIX} open-count query failed (${INTAKE_INDEX}):`, errMessage(err));
  }
  ctx.summary.rateLimit = {
    openCount: ctx.openStateCache.openCount,
    cap: ctx.openStateCache.cap,
    allowed: ctx.openStateCache.allowed,
  };
  return ctx.openStateCache;
}

/** §6 step 2 — exactly one invocation per canonical cycle may file at all. */
async function cycleFilingClaim(ctx) {
  if (ctx.cycleClaim) return ctx.cycleClaim;
  ctx.cycleClaim = await acquireClaim(ctx, {
    pk: RATELIMIT_PK,
    sk: ctx.cycle,
    ttlMs: RATELIMIT_TTL_MS,
    attrs: { filed: [] },
    strict: true,
  });
  return ctx.cycleClaim;
}

async function postStart(ctx, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const resp = await ctx.clients.fetch(`${ctx.env.workflowApiUrl}/api/workflow/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // TEAM-3335 F1: omitted entirely when unset — an empty header is not a proof.
        ...(ctx.env.intakeSecret ? { "x-intake-internal-secret": ctx.env.intakeSecret } : {}),
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const error = data.error || `HTTP ${resp.status}`;
      console.error(`${LOG_PREFIX} intake ${resp.status}: ${JSON.stringify(data).slice(0, 500)}`);
      // 4xx is permanent: a retry cannot fix a rejected payload. TEAM-3334 F1:
      // a 5xx is AMBIGUOUS, not transient — intake mints a random workflowId per
      // request and may have created the workflow before erroring, so the caller
      // must not release its dedupe claim on this result.
      return {
        ok: false,
        status: resp.status,
        terminal: resp.status >= 400 && resp.status < 500,
        ambiguous: resp.status >= 500,
        error,
      };
    }
    return { ok: true, workflowId: data.workflowId || data.id };
  } catch (err) {
    // TEAM-3334 F1: only a provably pre-connection failure is retriable; an
    // abort/timeout or anything mid-flight may have landed at intake.
    return { ok: false, status: null, terminal: false, ambiguous: !isPreConnectionError(err), error: errMessage(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * TEAM-3334 F1: resolve a t3 claim left `unverified` by an ambiguous POST
 * outcome. The filed title embeds metric + groupKey + cycle (buildStartPayload),
 * so the filing is verifiable: Query the intakeChannel-index for filings started
 * since just before the claim was created, then read each candidate's stored
 * intake payload title (`input.title` on the base table — the GSI projects no
 * title) and match it. Returns:
 *   { released: true }              — VERIFIABLY absent: the stale claim was
 *                                     deleted and the caller may retry filing.
 *   { released: false, filed }      — the filing exists (recorded on the claim,
 *                                     claim kept) or verification itself failed
 *                                     (claim kept untouched). Either way the
 *                                     caller must NOT file: fail closed against
 *                                     duplicating.
 */
async function resolveUnverifiedClaim(ctx, metric, verdict, claimItem) {
  const claim = { pk: claimPk(metric.id, verdict.groupKey), sk: "t3" };
  try {
    const cycleTag = claimItem.unverifiedCycle;
    if (typeof cycleTag !== "string" || !cycleTag) throw new Error("unverified claim has no unverifiedCycle");
    // One cycle of slack below createdAt: intake stamps startedAt with ITS clock.
    const since = isoOf(epochMsOf(claimItem.createdAt || ctx.nowIso) - CYCLE_MS);
    const candidates = await queryAll(
      ctx,
      {
        TableName: ctx.env.workflowsTable,
        IndexName: INTAKE_INDEX,
        KeyConditionExpression: "intakeChannel = :c AND startedAt >= :since",
        ExpressionAttributeValues: { ":c": INTAKE_CHANNEL, ":since": since },
      },
      { failOnTruncation: true }
    );
    let found = null;
    for (const cand of candidates) {
      if (!cand?.workflowId) continue;
      const rows = await queryAll(
        ctx,
        {
          TableName: ctx.env.workflowsTable,
          KeyConditionExpression: "workflowId = :id",
          ProjectionExpression: "workflowId, #in.#title",
          ExpressionAttributeNames: { "#in": "input", "#title": "title" },
          ExpressionAttributeValues: { ":id": cand.workflowId },
        },
        { failOnTruncation: true }
      );
      const title = rows[0]?.input?.title;
      if (
        typeof title === "string" &&
        title.startsWith(`[anomaly] ${metric.id} `) &&
        title.includes(`(${verdict.groupKey})`) &&
        title.includes(cycleTag)
      ) {
        found = cand.workflowId;
        break;
      }
    }

    if (found) {
      // The ambiguous POST DID file. Record the workflowId on the claim and keep
      // it — the suppression it provides is now backed by a real filing. The
      // annotation is owner-conditioned; if it fails, the claim simply stays
      // unverified and the next cycle re-verifies (still no filing either way).
      await annotateClaim(ctx, {
        ...claim,
        fields: { workflowId: found, verifiedAt: ctx.nowIso, unverified: false },
        ownerToken: claimItem.claimToken,
      });
      ctx.summary.actions.dedupeSuppressed.push({
        metricId: metric.id,
        groupKey: verdict.groupKey,
        tier: 3,
        reason: "unverified_claim_verified_filed",
      });
      console.log(`${LOG_PREFIX} unverified t3 claim for ${metric.id}/${verdict.groupKey} resolved: filed as ${found}`);
      return { released: false, filed: found };
    }

    // Verifiably absent: delete the stale claim (guarded by ITS owner token, so a
    // concurrent resolver cannot double-release) and let the caller retry.
    await ctx.clients.ddb.send(
      new ctx.cmd.DeleteCommand({
        TableName: ctx.env.stateTable,
        Key: claim,
        ConditionExpression: "claimToken = :owner",
        ExpressionAttributeValues: { ":owner": claimItem.claimToken },
      })
    );
    console.log(`${LOG_PREFIX} unverified t3 claim for ${metric.id}/${verdict.groupKey} resolved: not filed — released`);
    return { released: true };
  } catch (err) {
    // Verification failed (query error, truncation, lost the delete race): stay
    // unverified. Filing anyway is the one outcome NFR-4 forbids.
    ctx.summary.actions.failures.push({
      metricId: metric.id,
      groupKey: verdict.groupKey,
      stage: "tier3VerifyUnverified",
      error: errMessage(err),
    });
    console.error(`${LOG_PREFIX} unverified-claim verification failed for ${metric.id}/${verdict.groupKey}:`, errMessage(err));
    return { released: false };
  }
}

async function tier3(ctx, metric, verdict, extras) {
  const claim = { pk: claimPk(metric.id, verdict.groupKey), sk: "t3" };
  const ttlMs = durationToMs(metric.suppression?.tier3Ttl || "6h");
  const claimAttrs = {
    tier: 3,
    windowStart: verdict.windows.evalStart,
    windowEnd: verdict.windows.evalEnd,
    sigma: verdict.sigma,
  };
  const suppressed = (reason) =>
    ctx.summary.actions.dedupeSuppressed.push({
      metricId: metric.id,
      groupKey: verdict.groupKey,
      tier: 3,
      reason,
    });

  // TEAM-3334 F1: a claim left `unverified` by an earlier ambiguous POST must be
  // resolved BEFORE any acquire below — both acquire sites overwrite an expired
  // claim, which would erase the marker and re-open the double-filing window.
  // Fail closed: if the claim cannot even be read, take no action this cycle.
  let existingClaim;
  try {
    existingClaim = await getState(ctx, claim.pk, claim.sk);
  } catch (err) {
    ctx.summary.actions.failures.push({
      metricId: metric.id,
      groupKey: verdict.groupKey,
      stage: "tier3ClaimRead",
      error: errMessage(err),
    });
    return;
  }
  if (existingClaim?.unverified) {
    const resolved = await resolveUnverifiedClaim(ctx, metric, verdict, existingClaim);
    if (!resolved.released) return; // verified-filed or unresolved — never file past it
  }

  const state = await openState(ctx);
  const allowed = allowedFilings(state.openCount ?? state.cap, ctx.filedThisCycle);
  const blocked = state.error ? `open-count query failed: ${state.error}` : null;

  // Degradation is never silent: the anomaly still pages an operator with the
  // reason it was not filed (§6).
  if (blocked || allowed <= 0 || !ctx.env.workflowApiUrl) {
    const rateLimited = !blocked && !!ctx.env.workflowApiUrl;
    const reason = blocked || (rateLimited ? null : "WORKFLOW_API_URL is not configured");
    const got = await acquireClaim(ctx, { ...claim, ttlMs, attrs: { ...claimAttrs, rateLimited } });
    if (!got.ok) {
      if (got.duplicate) suppressed("claim_held");
      else
        ctx.summary.actions.failures.push({
          metricId: metric.id,
          groupKey: verdict.groupKey,
          stage: "tier3Claim",
          error: got.error,
        });
      return;
    }
    if (rateLimited) {
      ctx.summary.actions.tier3RateLimited.push({
        metricId: metric.id,
        groupKey: verdict.groupKey,
        sigma: verdict.sigma,
        openCount: state.openCount,
      });
    } else {
      ctx.summary.actions.failures.push({
        metricId: metric.id,
        groupKey: verdict.groupKey,
        stage: "tier3Filing",
        error: reason,
      });
    }
    await tier2(ctx, metric, verdict, extras, {
      claimed: true,
      rateLimited,
      marker: rateLimited ? null : filingBlockedMarker(reason),
    });
    return;
  }

  // Metric claim FIRST: a group still under its suppression claim must bail
  // here, BEFORE the fleet-wide cycle claim is consumed — otherwise one
  // persistent suppressed group that sorts first burns the cycle claim every
  // cycle and no other anomaly can ever file.
  const got = await acquireClaim(ctx, { ...claim, ttlMs, attrs: claimAttrs });
  if (!got.ok) {
    if (got.duplicate) suppressed("claim_held");
    else
      ctx.summary.actions.failures.push({
        metricId: metric.id,
        groupKey: verdict.groupKey,
        stage: "tier3Claim",
        error: got.error,
      });
    return;
  }

  const cycleClaim = await cycleFilingClaim(ctx);
  if (!cycleClaim.ok) {
    // Nothing has left the account — release the metric claim so this group's
    // suppression TTL isn't burned on a filing that never happened; it can
    // retry on a later cycle.
    await releaseClaim(ctx, claim);
    if (cycleClaim.duplicate) suppressed("ratelimit_cycle_claim_held");
    else
      ctx.summary.actions.failures.push({
        metricId: metric.id,
        groupKey: verdict.groupKey,
        stage: "ratelimitClaim",
        error: cycleClaim.error,
      });
    return;
  }

  // Both claims held — only now does anything leave this account.
  const bundle = bundleFor(ctx, verdict, extras, { requested: [] });
  const result = await postStart(ctx, buildStartPayload(bundle, { repoUrl: ctx.env.repoUrl }));

  if (result.ok) {
    ctx.filedThisCycle += 1;
    ctx.summary.actions.tier3Filed.push({
      metricId: metric.id,
      groupKey: verdict.groupKey,
      sigma: verdict.sigma,
      workflowId: result.workflowId,
    });
    await annotateClaim(ctx, { ...claim, fields: { workflowId: result.workflowId ?? null, filedAt: ctx.nowIso } });
    try {
      await ctx.clients.ddb.send(
        new ctx.cmd.UpdateCommand({
          TableName: ctx.env.stateTable,
          Key: { pk: RATELIMIT_PK, sk: ctx.cycle },
          UpdateExpression: "SET filed = list_append(if_not_exists(filed, :empty), :w)",
          ConditionExpression: "claimToken = :mine",
          ExpressionAttributeValues: { ":w": [result.workflowId ?? "unknown"], ":empty": [], ":mine": ctx.requestId },
        })
      );
    } catch (err) {
      console.error(`${LOG_PREFIX} ratelimit filed-list update failed:`, errMessage(err));
    }
    console.log(
      `${LOG_PREFIX} tier3 filed ${metric.id}/${verdict.groupKey} (${verdict.sigma}σ) → workflow ${result.workflowId}`
    );
    await emitFleetRecords(ctx, metric, verdict, bundle, result.workflowId);
    return;
  }

  if (result.terminal) {
    // 4xx: KEEP the claim (retrying the same payload cannot succeed) and page an
    // operator instead, with the failure stated in the notification (§10.1).
    await annotateClaim(ctx, { ...claim, fields: { failed: "4xx", failedStatus: result.status, failedAt: ctx.nowIso } });
    ctx.summary.actions.failures.push({
      metricId: metric.id,
      groupKey: verdict.groupKey,
      stage: "tier3Filing",
      status: result.status,
      error: result.error,
    });
    await tier2(ctx, metric, verdict, extras, { claimed: true, marker: filingFailedMarker(result.status) });
    return;
  }

  if (result.ambiguous) {
    // TEAM-3334 F1: the POST may have been processed (timeout after send, 5xx
    // after intake wrote the workflow, connection lost mid-response) and intake
    // is NOT idempotent — releasing the claim here is exactly how a duplicate
    // gets filed. Keep the claim, mark it unverified, and extend it so the
    // marker outlives the suppression TTL; a later cycle verifies against the
    // intake index (resolveUnverifiedClaim) before releasing or retrying.
    await annotateClaim(ctx, {
      ...claim,
      fields: {
        unverified: true,
        unverifiedAt: ctx.nowIso,
        unverifiedCycle: ctx.cycle,
        unverifiedStatus: result.status ?? null,
        unverifiedError: result.error ?? null,
        expiresAt: ttlEpoch(ctx.nowMs, Math.max(ttlMs, RATELIMIT_TTL_MS)),
      },
    });
    ctx.summary.actions.failures.push({
      metricId: metric.id,
      groupKey: verdict.groupKey,
      stage: "tier3Filing",
      status: result.status,
      error: result.error,
      claim: "unverified",
    });
    return;
  }

  // Pre-connection failure: the request provably never reached intake, so the
  // claim is safe to release for a later cycle to retry. Do NOT rethrow — the
  // summary carries the failure.
  await releaseClaim(ctx, claim);
  ctx.summary.actions.failures.push({
    metricId: metric.id,
    groupKey: verdict.groupKey,
    stage: "tier3Filing",
    status: result.status,
    error: result.error,
    claim: "released",
  });
}

async function evaluateMetric(ctx, metric) {
  const entry = newMetricEntry(metric.id);
  ctx.summary.metrics.push(entry);
  if (metric.enabled === false) {
    countVerdict(entry, { status: "disabled", tier: 0 });
    return;
  }
  const windows = metricWindows(metric, ctx.canonicalCycle);
  const groups = await groupsForMetric(ctx, metric);
  entry.groups = groups.length;
  for (const groupKey of groups) {
    try {
      await evaluateGroup(ctx, metric, groupKey, windows, entry);
    } catch (err) {
      // Per-metric/group isolation (§10.1): log, record, move on.
      ctx.summary.actions.failures.push({
        metricId: metric.id,
        groupKey,
        stage: "evaluate",
        error: errMessage(err),
      });
      console.error(`${LOG_PREFIX} ${metric.id}/${groupKey} failed:`, err);
    }
  }
}

// ─── entry point ─────────────────────────────────────────────────────────────

/**
 * One watcher cycle. Injectable for tests: pass `clients` (see initClients for
 * the shape), `env`, `nowMs` and `bands` (a loadBands() result) to run it without
 * AWS, a clock, or the bundled bands.yaml.
 */
export async function runCycle({ event, context, env, clients, nowMs, bands: injectedBands } = {}) {
  const startedAt = Date.now();
  const resolvedEnv = env || readEnv();
  const nowStamp = Number.isFinite(nowMs) ? nowMs : Date.now();
  const scheduledMs = resolveScheduledTime(event, nowStamp);
  const canonicalCycle = canonicalWindowStart(isoOf(scheduledMs), CYCLE_MS);
  const cycle = cycleLabel(canonicalCycle);

  const bands = injectedBands || (await loadBands());
  let configError = null;
  if (!bands.ok) {
    configError = `bands.yaml invalid: ${bands.errors.length} error(s)`;
    for (const error of bands.errors) console.error(`${LOG_PREFIX} bands.yaml: ${error}`);
  } else {
    console.log(`${LOG_PREFIX} cycle ${cycle} · bands v${bands.config.version} · sha256:${bands.digest}`);
  }

  const summary = emptySummary({
    cycle,
    bandsVersion: bands.config?.version ?? null,
    configHash: bands.configHash,
    configError,
  });

  const ctx = {
    env: resolvedEnv,
    clients: clients || (await initClients(resolvedEnv)),
    cmd: null,
    config: bands.ok ? bands.config : null,
    configHash: bands.configHash,
    metricsById: new Map((bands.config?.metrics || []).map((m) => [m.id, m])),
    canonicalCycle,
    cycle,
    nowMs: nowStamp,
    nowIso: isoOf(nowStamp),
    nowEpoch: Math.floor(nowStamp / 1000),
    requestId: context?.awsRequestId || `local-${cycle}`,
    summary,
    ingestErrors: { events: false, evalConfig: false },
    touchedGroups: new Map(),
    snapshotAgents: [],
    snapshotTtlMs: AGG_TTL_SLACK_MS,
    filedThisCycle: 0,
    openStateCache: null,
    cycleClaim: null,
    seq: 0,
    // Snapshot metrics borrow this metric's per-workflow attribution for their
    // §7 diagnosis target (both are keyed by agentId).
    agentAttributionMetricId: null,
  };
  ctx.cmd = ctx.clients.cmd;
  for (const metric of bands.config?.metrics || []) {
    const span = durationToMs(metric.baselineWindow) || 0;
    if (metric.source?.kind === "eval-config-snapshot") {
      ctx.snapshotTtlMs = Math.max(ctx.snapshotTtlMs, span + AGG_TTL_SLACK_MS);
    }
    if (
      !ctx.agentAttributionMetricId &&
      metric.enabled !== false &&
      metric.source?.kind === "events" &&
      metric.source?.groupBy === "detail.agentId"
    ) {
      ctx.agentAttributionMetricId = metric.id;
    }
  }

  try {
    await ingest(ctx);
  } catch (err) {
    summary.ingest.errors.push({ stage: "ingest", error: errMessage(err) });
    ctx.ingestErrors.events = true;
    ctx.ingestErrors.evalConfig = true;
    console.error(`${LOG_PREFIX} ingest stage failed:`, err);
  }

  // No tiered action at all on an invalid config (§10.1) — never a default band.
  if (bands.ok) {
    // Queried once per cycle even when nothing reaches Tier 3, so the summary
    // always reports the real cap state (and a missing GSI surfaces immediately).
    await openState(ctx);
    for (const metric of bands.config.metrics) {
      try {
        await evaluateMetric(ctx, metric);
      } catch (err) {
        summary.actions.failures.push({ metricId: metric.id, stage: "metric", error: errMessage(err) });
        console.error(`${LOG_PREFIX} metric ${metric.id} failed:`, err);
      }
    }
  }

  summary.durationMs = Date.now() - startedAt;
  console.log(JSON.stringify(summary));
  return summary;
}

/**
 * Lambda entry point. Never throws once past init: a Scheduler retry would only
 * re-run the same cycle, and every side effect is claim-guarded anyway. The
 * summary (§10.2) is always the last line.
 */
export async function handler(event, context) {
  try {
    return await runCycle({ event, context });
  } catch (err) {
    console.error(`${LOG_PREFIX} fatal:`, err);
    const summary = emptySummary({ cycle: null, bandsVersion: null, configHash: null, configError: errMessage(err) });
    summary.actions.failures.push({ stage: "handler", error: errMessage(err) });
    console.log(JSON.stringify(summary));
    return summary;
  }
}
