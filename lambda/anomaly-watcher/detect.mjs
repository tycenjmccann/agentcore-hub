/**
 * anomaly-watcher detection core — PURE (§3, §4.1–§4.2, §5, §8 of the design).
 *
 * ABSOLUTE constraints, enforced by review + a test that asserts on this file's
 * import list: no AWS SDK client, no network call, no clock read, no randomness,
 * no model client. The only import allowed is the sibling bands-schema.mjs
 * (itself import-free). Time enters ONLY as caller-supplied instants, so the
 * sole Date uses here take an explicit argument — parse an ISO string, format an
 * epoch — and the literal banned tokens are absent from this file on purpose, so
 * a text-scanning purity test stays green.
 *
 * Consequences that callers rely on:
 *   - same input ⇒ same output, forever (fixtures in detect.test.mjs are stable)
 *   - inputs are never mutated (Object.freeze'd fixtures are safe)
 *   - every absolute time the module needs is supplied by the caller: the handler
 *     canonicalizes the Scheduler event's `time` once, at entry (§5).
 *
 * Exports:
 *   detect(samples, config)          → Verdict (§3.1)
 *   aggregate(events, config, prior) → {bucketDeltas, newCursor, openPairs, …} (§4)
 *   canonicalWindowStart(t, lenMs)   → ISO window floor (§5)
 *   renderEvidence(bundle)           → operator-facing markdown (§8.2)
 *   buildEvidenceBundle(verdict, x)  → canonical evidence JSON (§8.1)
 *   buildStartPayload(bundle, opts)  → /api/workflow/start body (§8.3)
 */

import { BUCKET_MS } from "./bands-schema.mjs";

/** Max unmatched agent.invoked entries carried on a cursor row (§4). */
export const MAX_OPEN_PAIRS = 25;
/** Contributors reported per verdict (§3.1). */
export const MAX_CONTRIBUTORS = 3;
/** Prior verdict points kept for Western Electric rules 2–3 (§5). */
export const MAX_RECENT_POINTS = 5;

const DEFAULT_SIGMA_THRESHOLDS = { tier1: 1, tier2: 2, tier3: 3 };
const RATE_AGGREGATIONS = new Set(["rate", "snapshot_delta_avg"]);
const STREAMING_TYPE = "agent.streaming";

// ─── time helpers (caller-supplied instants only — never a clock) ──────────────

/** ISO-8601 | epoch ms | Date → epoch ms. Throws on anything unparseable. */
function epochMs(t) {
  if (t instanceof Date) {
    const ms = t.getTime();
    if (Number.isFinite(ms)) return ms;
  } else if (typeof t === "number" && Number.isFinite(t)) {
    return t;
  } else if (typeof t === "string") {
    const ms = Date.parse(t);
    if (Number.isFinite(ms)) return ms;
  }
  throw new TypeError(`not a parseable instant: ${JSON.stringify(t)}`);
}

/** Epoch ms → `2026-08-27T14:20:00Z` (second precision, the design's ISO style). */
function toIso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Floor an instant to its window (§5): floor(epochMs(t)/lenMs) × lenMs, UTC.
 * Deterministic and caller-driven — this is how the handler derives the canonical
 * cycle, so two overlapping invocations of the same cycle compute the same claim
 * key and one of them loses the conditional write.
 */
export function canonicalWindowStart(t, lenMs) {
  if (!Number.isFinite(lenMs) || lenMs <= 0) {
    throw new TypeError(`window length must be a positive number of ms: ${JSON.stringify(lenMs)}`);
  }
  return toIso(Math.floor(epochMs(t) / lenMs) * lenMs);
}

/** ISO timestamp → hourly aggregate bucket key `2026-08-26T14` (§4.4). */
export function hourBucket(timestamp) {
  return toIso(Math.floor(epochMs(timestamp) / BUCKET_MS) * BUCKET_MS).slice(0, 13);
}

// ─── detect (§3) ───────────────────────────────────────────────────────────────

function safeNumber(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function normalizeWindows(windows) {
  const w = windows && typeof windows === "object" ? windows : {};
  return {
    baselineStart: w.baselineStart ?? null,
    baselineEnd: w.baselineEnd ?? null,
    evalStart: w.evalStart ?? null,
    evalEnd: w.evalEnd ?? null,
  };
}

/**
 * Deviation is the anomalous-side magnitude: only a POSITIVE deviation can
 * classify, so a "lower" metric that spikes upward is `ok`, not an anomaly.
 */
function deviationOf(sigma, direction) {
  if (sigma === null) return null;
  if (direction === "lower") return -sigma;
  if (direction === "both") return Math.abs(sigma);
  return sigma; // "upper" (and the defensive default)
}

/**
 * Top-N contributors with their share of the observed total.
 * Sorted by value desc, ties broken by workflowId asc so the order — and hence
 * the diagnosis targets the handler invokes — is stable across cycles.
 * `share` is against the sum of ALL contributors, not just the ones kept.
 */
function rankContributors(contributors) {
  const items = (Array.isArray(contributors) ? contributors : [])
    .filter((c) => c && typeof c === "object" && Number.isFinite(c.value))
    .map((c) => ({ workflowId: String(c.workflowId ?? ""), value: c.value }));
  const total = items.reduce((acc, c) => acc + c.value, 0);
  return items
    .slice()
    .sort((a, b) => (b.value - a.value) || (a.workflowId < b.workflowId ? -1 : a.workflowId > b.workflowId ? 1 : 0))
    .slice(0, MAX_CONTRIBUTORS)
    .map((c) => ({ workflowId: c.workflowId, value: c.value, share: total > 0 ? c.value / total : 0 }));
}

/**
 * Western Electric rules 2–3 (§3.3): k of the last n points beyond a threshold,
 * on the SAME side. The series is samples.recentPoints (oldest → newest) plus
 * the current point appended last. Too few points ⇒ the rule cannot trigger.
 */
function runRule(series, direction, windowSize, needed, threshold) {
  if (series.length < windowSize) return false;
  const window = series.slice(-windowSize);
  const current = series[series.length - 1];
  const side = Math.sign(current);
  let hits = 0;
  for (const sigma of window) {
    if (direction === "both") {
      // "same side" has to be checked explicitly here: |sigma| discards the sign.
      if (side !== 0 && Math.sign(sigma) === side && Math.abs(sigma) > threshold) hits += 1;
    } else if (deviationOf(sigma, direction) > threshold) {
      hits += 1;
    }
  }
  return hits >= needed;
}

/**
 * Classify one metric+group for one evaluation window.
 *
 * @param {object} samples {baselinePoints, evalValue, evalSampleCount, recentPoints, contributors}
 * @param {object} config  {metric, windows, groupKey?} — `metric` is one validated
 *   bands.yaml entry; `windows` are absolute ISO bounds computed by the handler.
 * @returns {object} Verdict, exact §3.1 shape.
 */
export function detect(samples, config) {
  const cfg = config && typeof config === "object" ? config : {};
  const metric = cfg.metric && typeof cfg.metric === "object" ? cfg.metric : {};
  const s = samples && typeof samples === "object" ? samples : {};
  const windows = normalizeWindows(cfg.windows);
  const direction = metric.direction ?? "upper";
  const groupBy = metric.source?.groupBy;
  const groupKey = cfg.groupKey ?? s.groupKey ?? (groupBy === "fleet" ? "fleet" : "");
  const thresholds = { ...DEFAULT_SIGMA_THRESHOLDS, ...(metric.sigmaThresholds || {}) };
  const minSamples = metric.minSamples && typeof metric.minSamples === "object" ? metric.minSamples : {};
  const floors = metric.stddevFloor && typeof metric.stddevFloor === "object" ? metric.stddevFloor : {};
  const enabledRules = new Set(
    Array.isArray(metric.westernElectric?.rules) ? metric.westernElectric.rules : [1, 2, 3]
  );

  const evalValue = safeNumber(s.evalValue);
  const evalSampleCount = Number.isFinite(s.evalSampleCount) ? s.evalSampleCount : 0;

  const verdict = (fields) => ({
    metricId: metric.id ?? null,
    groupKey,
    status: fields.status,
    tier: fields.tier,
    observed: fields.observed ?? null,
    baselineMean: fields.baselineMean ?? null,
    baselineStddev: fields.baselineStddev ?? null,
    effectiveStddev: fields.effectiveStddev ?? null,
    sigma: fields.sigma ?? null,
    direction,
    rulesTriggered: fields.rulesTriggered ?? [],
    sampleCount: {
      baselineBuckets: fields.baselineBuckets ?? 0,
      evalSamples: evalSampleCount,
    },
    windows,
    contributors: fields.contributors ?? [],
    insufficientReason: fields.insufficientReason ?? null,
  });

  // Guard 1 — disabled metrics are never evaluated (§3.5).
  if (metric.enabled === false) {
    return verdict({ status: "disabled", tier: 0 });
  }

  // Qualifying baseline buckets (§3.2). Rate/snapshot buckets whose denominator
  // is too thin are dropped BEFORE the mean/stddev: a 1-invocation hour at 100%
  // error rate is noise, and left in it would inflate the baseline stddev enough
  // to mask real anomalies.
  const needsDenominator = RATE_AGGREGATIONS.has(metric.aggregation);
  const minDenominator = Number.isFinite(minSamples.bucketDenominator) ? minSamples.bucketDenominator : 0;
  const qualifying = (Array.isArray(s.baselinePoints) ? s.baselinePoints : []).filter((p) => {
    if (!p || typeof p !== "object" || !Number.isFinite(p.value)) return false;
    if (!needsDenominator) return true;
    const den = Number.isFinite(p.denominator) ? p.denominator : 0;
    return den >= minDenominator;
  });
  const n = qualifying.length;
  const contributors = rankContributors(s.contributors);

  // Guard 2 — no source events in the evaluation window. NEVER a zero-valued
  // anomaly: absent data is absent data (§2.2 absent-source rule).
  if (evalValue === null) {
    return verdict({
      status: "insufficient_sample", tier: 0, baselineBuckets: n, contributors,
      insufficientReason: "no_source_events_in_window",
    });
  }

  // Guard 3 — too few samples inside the evaluation window.
  const minEvalSamples = Number.isFinite(minSamples.evalSamples) ? minSamples.evalSamples : 1;
  if (evalSampleCount < minEvalSamples) {
    return verdict({
      status: "insufficient_sample", tier: 0, observed: evalValue, baselineBuckets: n,
      contributors, insufficientReason: "below_min_eval_samples",
    });
  }

  // Guard 4 — baseline too short to have a shape. `n < 2` is also a hard stop
  // regardless of config: the n−1 sample stddev is undefined there.
  const minBaselineBuckets = Number.isFinite(minSamples.baselineBuckets) ? minSamples.baselineBuckets : 2;
  if (n < minBaselineBuckets || n < 2) {
    return verdict({
      status: "insufficient_sample", tier: 0, observed: evalValue, baselineBuckets: n,
      contributors, insufficientReason: "below_min_baseline_buckets",
    });
  }

  // Two-pass sample stddev (n−1) — §3.2.
  const mean = qualifying.reduce((acc, p) => acc + p.value, 0) / n;
  const variance = qualifying.reduce((acc, p) => acc + (p.value - mean) ** 2, 0) / (n - 1);
  const stddev = Math.sqrt(variance);

  // §3.4 — floors applied unconditionally, so a quiet metric with a near-zero
  // raw stddev cannot manufacture a 40σ "anomaly" out of ordinary jitter.
  const epsilon = Number.isFinite(floors.epsilon) ? floors.epsilon : 0;
  const relFloor = Number.isFinite(floors.relFloor) ? floors.relFloor : 0;
  const effectiveStddev = Math.max(stddev, epsilon, relFloor * Math.abs(mean));

  // effectiveStddev === 0 means zero variance AND zero floors: there is no scale
  // to measure a deviation against, so report 0σ rather than ±Infinity.
  const sigma = effectiveStddev > 0 ? (evalValue - mean) / effectiveStddev : 0;
  const deviation = deviationOf(sigma, direction);

  const priorSigmas = (Array.isArray(s.recentPoints) ? s.recentPoints : [])
    .filter((p) => p && Number.isFinite(p.sigma))
    .slice(-MAX_RECENT_POINTS)
    .map((p) => p.sigma);
  const series = [...priorSigmas, sigma];

  // rulesTriggered lists EVERY satisfied rule even when a higher tier wins, so
  // the evidence bundle shows the full picture (§3.3).
  const rulesTriggered = [];
  const rule1 = enabledRules.has(1) && deviation >= thresholds.tier3;
  const rule2 = enabledRules.has(2) && runRule(series, direction, 3, 2, thresholds.tier2);
  const rule3 = enabledRules.has(3) && runRule(series, direction, 5, 4, thresholds.tier1);
  if (rule1) rulesTriggered.push("we1");
  if (rule2) rulesTriggered.push("we2");
  if (rule3) rulesTriggered.push("we3");

  // Tier resolution — highest only, thresholds INCLUSIVE (§3.3).
  let tier = 0;
  if (rule1) tier = 3;
  else if (deviation >= thresholds.tier2 || rule2 || rule3) tier = 2;
  else if (deviation >= thresholds.tier1) tier = 1;

  return verdict({
    status: tier > 0 ? "anomaly" : "ok",
    tier,
    observed: evalValue,
    baselineMean: mean,
    baselineStddev: stddev,
    effectiveStddev,
    sigma,
    rulesTriggered,
    baselineBuckets: n,
    contributors,
  });
}

// ─── aggregate (§4.1–§4.2) ─────────────────────────────────────────────────────

function detailOf(item) {
  return item && typeof item.detail === "object" && item.detail !== null ? item.detail : {};
}

/** Read `detail.a.b` off an event item. Returns undefined for any missing hop. */
function readPath(item, path) {
  if (typeof path !== "string") return undefined;
  const parts = path.split(".");
  let cursor = item;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function matches(value, matcher) {
  if (!matcher || typeof matcher !== "object") return true;
  if (matcher.equals !== undefined) return value === matcher.equals;
  if (matcher.in !== undefined) return Array.isArray(matcher.in) && matcher.in.includes(value);
  if (matcher.startsWith !== undefined) {
    return typeof value === "string" && value.startsWith(matcher.startsWith);
  }
  return true;
}

function matchesFieldMap(item, fieldMap) {
  for (const [path, matcher] of Object.entries(fieldMap)) {
    if (!matches(readPath(item, path), matcher)) return false;
  }
  return true;
}

/**
 * Apply `source.where` to one event. Two shapes (both validated upstream):
 *   flat:  {"detail.agentId": {...}}                         — applies to every event
 *   roled: {numerator: {"agent.invoked": {"detail.x": {...}}}} — per role, per type
 */
function passesWhere(item, where, role) {
  if (!where || typeof where !== "object") return true;
  const roled = "numerator" in where || "denominator" in where;
  if (!roled) return matchesFieldMap(item, where);
  const spec = role && where[role];
  if (!spec || typeof spec !== "object") return true;
  for (const [key, value] of Object.entries(spec)) {
    if (key.startsWith("detail.")) {
      if (!matches(readPath(item, key), value)) return false;
    } else if (key === item.type) {
      if (!matchesFieldMap(item, value)) return false;
    }
  }
  return true;
}

/**
 * Group key for one event under a metric's groupBy. `null` means "cannot
 * attribute" — the event is skipped for that metric rather than folded into an
 * "unknown" band, which would be a band nobody can act on.
 */
function groupKeyFor(item, groupBy) {
  if (groupBy === "fleet") return "fleet";
  const value = readPath(item, groupBy);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function deltaFor(map, metricId, groupKey, bucket, shape) {
  const key = `${metricId} ${groupKey} ${bucket}`;
  let delta = map.get(key);
  if (!delta) {
    delta = shape === "duration"
      ? { metricId, groupKey, bucket, n: 0, sum: 0, sumSq: 0 }
      : { metricId, groupKey, bucket, num: 0, den: 0 };
    map.set(key, delta);
  }
  return delta;
}

function trimForOpenPair(item, metricId) {
  const d = detailOf(item);
  return {
    metricId,
    ticketId: String(d.ticketId ?? ""),
    workflowId: item.workflowId ?? null,
    eventId: item.eventId ?? null,
    type: item.type ?? null,
    timestamp: item.timestamp ?? null,
    detail: { ticketId: d.ticketId ?? null, agentId: d.agentId ?? null, phase: d.phase ?? null },
  };
}

/**
 * Fold a raw batch of events-table items into per-metric hourly bucket deltas.
 *
 * Pure: no clock, no I/O. Everything time-related comes off each item's own ISO
 * `timestamp` attribute — never `eventId` (§4.4), so a late-arriving event lands
 * in its true past bucket and the handler's `ADD` merges it there.
 *
 * @param {Array<object>} events raw (already unmarshalled) events-table items
 * @param {object} bandsConfig validated bands config ({version, metrics})
 * @param {object} [prior] carried state, `{openPairs: [...]}` off the cursor rows
 * @returns {{bucketDeltas: Array, newCursor: object, openPairs: Array,
 *            evictedOpenPairs: Array, stats: object}}
 *   `bucketDeltas` — sorted, ready for the §4.3 TransactWriteItems `ADD`s.
 *   `newCursor`    — per-workflowId `{lastEventId, lastTimestamp, count}`; the max
 *                    is taken over ALL items read (streaming included) so dropped
 *                    noise still advances the cursor instead of being re-read.
 *   `openPairs`    — unmatched starts to carry forward, ≤ MAX_OPEN_PAIRS, oldest
 *                    evicted into `evictedOpenPairs` for the caller to log.
 */
export function aggregate(events, bandsConfig, prior = {}) {
  const items = (Array.isArray(events) ? events : []).filter((e) => e && typeof e === "object");
  const metrics = Array.isArray(bandsConfig?.metrics) ? bandsConfig.metrics : [];

  // Cursor first, over the raw batch — including the events we are about to drop.
  const newCursor = {};
  for (const item of items) {
    const wf = String(item.workflowId ?? "");
    const cursor = newCursor[wf] || (newCursor[wf] = { lastEventId: null, lastTimestamp: null, count: 0 });
    cursor.count += 1;
    const eventId = typeof item.eventId === "string" ? item.eventId : null;
    if (eventId !== null && (cursor.lastEventId === null || eventId > cursor.lastEventId)) {
      cursor.lastEventId = eventId;
    }
    const ts = typeof item.timestamp === "string" ? item.timestamp : null;
    if (ts !== null && (cursor.lastTimestamp === null || ts > cursor.lastTimestamp)) {
      cursor.lastTimestamp = ts;
    }
  }

  // Deterministic fold order regardless of how DynamoDB paginated the read.
  const sorted = items.slice().sort((a, b) => {
    const ta = String(a.timestamp ?? "");
    const tb = String(b.timestamp ?? "");
    if (ta !== tb) return ta < tb ? -1 : 1;
    const ea = String(a.eventId ?? "");
    const eb = String(b.eventId ?? "");
    if (ea !== eb) return ea < eb ? -1 : 1;
    const tya = String(a.type ?? "");
    const tyb = String(b.type ?? "");
    return tya < tyb ? -1 : tya > tyb ? 1 : 0;
  });

  // Dedupe (§1.1 fact 2): the same logical event is written twice — once via the
  // EventBridge path, once directly — with different eventIds. Counting both
  // would double every rate numerator.
  const seen = new Set();
  const deduped = [];
  let dropped = 0;
  let dedupedCount = 0;
  let skipped = 0;
  for (const item of sorted) {
    if (item.type === STREAMING_TYPE) { dropped += 1; continue; }
    if (typeof item.timestamp !== "string" || !Number.isFinite(Date.parse(item.timestamp))) {
      skipped += 1; // unbucketable — no usable timestamp attribute
      continue;
    }
    const d = detailOf(item);
    const key = [
      String(item.workflowId ?? ""), String(item.type ?? ""), item.timestamp,
      String(d.ticketId ?? ""), String(d.agentId ?? ""),
    ].join(" ");
    if (seen.has(key)) { dedupedCount += 1; continue; }
    seen.add(key);
    deduped.push(item);
  }

  const deltas = new Map();
  // Carried-in pairs come off a persisted cursor row, so treat them as untrusted:
  // an unparseable timestamp would throw mid-fold and fail the whole ingest.
  const priorOpen = (Array.isArray(prior?.openPairs) ? prior.openPairs : []).filter(
    (p) => p && typeof p === "object" && typeof p.timestamp === "string"
      && Number.isFinite(Date.parse(p.timestamp))
  );
  const carriedOpen = [];

  for (const metric of metrics) {
    const metricId = metric?.id;
    if (!metricId) continue;
    const groupBy = metric.source?.groupBy;
    const where = metric.source?.where;

    if (metric.aggregation === "rate") {
      const numeratorTypes = new Set(metric.source?.numeratorTypes || []);
      const denominatorTypes = new Set(metric.source?.denominatorTypes || []);
      for (const item of deduped) {
        const isNum = numeratorTypes.has(item.type) && passesWhere(item, where, "numerator");
        const isDen = denominatorTypes.has(item.type) && passesWhere(item, where, "denominator");
        if (!isNum && !isDen) continue;
        const groupKey = groupKeyFor(item, groupBy);
        if (groupKey === null) continue;
        const delta = deltaFor(deltas, metricId, groupKey, hourBucket(item.timestamp), "rate");
        if (isNum) delta.num += 1;
        if (isDen) delta.den += 1;
      }
      continue;
    }

    if (metric.aggregation !== "duration_ms") continue; // snapshot_delta_avg is not event-sourced

    // Duration pairing (§1.1 fact 1): agent.invoked → agent.complete /
    // workflow.report_completion per ticketId. agent.started is unusable — its
    // detail carries no workflowId, so those rows live in another partition.
    const startTypes = new Set(metric.source?.startTypes || []);
    const endTypes = new Set(metric.source?.endTypes || []);
    const starts = new Map(); // ticketId → earliest start item
    const ends = new Map();   // ticketId → latest terminal item

    // Starts left open by an earlier cycle are candidates for pairing now.
    for (const open of priorOpen) {
      if (open.metricId !== metricId) continue;
      const ticketId = String(open.ticketId ?? "");
      if (!ticketId) continue;
      const existing = starts.get(ticketId);
      if (!existing || open.timestamp < existing.timestamp) starts.set(ticketId, open);
    }
    for (const item of deduped) {
      const ticketId = detailOf(item).ticketId;
      if (typeof ticketId !== "string" || ticketId.length === 0) continue;
      if (startTypes.has(item.type) && passesWhere(item, where, "start")) {
        const existing = starts.get(ticketId);
        if (!existing || item.timestamp < existing.timestamp) starts.set(ticketId, item);
      }
      if (endTypes.has(item.type) && passesWhere(item, where, "end")) {
        const existing = ends.get(ticketId);
        if (!existing || item.timestamp > existing.timestamp) ends.set(ticketId, item);
      }
    }

    for (const [ticketId, start] of starts) {
      const end = ends.get(ticketId);
      // No terminal event yet (or one that predates the invoke, i.e. a stale
      // completion from a previous attempt): carry the start, don't guess.
      if (!end || end.timestamp < start.timestamp) {
        carriedOpen.push(trimForOpenPair(start, metricId));
        continue;
      }
      const groupKey = groupKeyFor(start, groupBy) ?? groupKeyFor(end, groupBy);
      if (groupKey === null) continue;
      const durationMs = Math.max(0, epochMs(end.timestamp) - epochMs(start.timestamp));
      // Bucketed by the TERMINAL event: that is when the sample became observable.
      const delta = deltaFor(deltas, metricId, groupKey, hourBucket(end.timestamp), "duration");
      delta.n += 1;
      delta.sum += durationMs;
      delta.sumSq += durationMs * durationMs;
    }
  }

  // Newest-first eviction keeps the pairs most likely to still complete (§4).
  const openSorted = carriedOpen
    .slice()
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  const evictedOpenPairs = openSorted.slice(0, Math.max(0, openSorted.length - MAX_OPEN_PAIRS));
  const openPairs = openSorted.slice(Math.max(0, openSorted.length - MAX_OPEN_PAIRS));

  const bucketDeltas = [...deltas.values()].sort((a, b) => (
    a.metricId < b.metricId ? -1 : a.metricId > b.metricId ? 1
      : a.groupKey < b.groupKey ? -1 : a.groupKey > b.groupKey ? 1
        : a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0
  ));

  return {
    bucketDeltas,
    newCursor,
    openPairs,
    evictedOpenPairs,
    stats: {
      eventsRead: items.length,
      eventsDeduped: dedupedCount,
      streamingDropped: dropped,
      unbucketable: skipped,
      bucketsTouched: bucketDeltas.length,
      openPairs: openPairs.length,
    },
  };
}

// ─── evidence bundle + rendering (§8) ──────────────────────────────────────────

function isFiniteNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Build the canonical §8.1 evidence JSON from a verdict.
 *
 * @param {object} verdict from detect()
 * @param {object} [extras] {rateLimited, numerator, denominator, agentIds,
 *   deployMarkers, diagnosis:{requested, via}, cycle, bandsVersion, configHash}
 */
export function buildEvidenceBundle(verdict, extras = {}) {
  const v = verdict && typeof verdict === "object" ? verdict : {};
  const x = extras && typeof extras === "object" ? extras : {};
  const contributors = (Array.isArray(v.contributors) ? v.contributors : [])
    .map((c) => ({ workflowId: c.workflowId, value: c.value, share: c.share }));
  const windows = v.windows || {};
  const evaluation = {
    window: { start: windows.evalStart ?? null, end: windows.evalEnd ?? null },
    samples: v.sampleCount?.evalSamples ?? 0,
  };
  if (isFiniteNum(x.numerator)) evaluation.numerator = x.numerator;
  if (isFiniteNum(x.denominator)) evaluation.denominator = x.denominator;

  return {
    kind: "anomaly-evidence/v1",
    metricId: v.metricId ?? null,
    groupKey: v.groupKey ?? null,
    tier: v.tier ?? 0,
    rateLimited: x.rateLimited === true,
    observed: v.observed ?? null,
    baseline: {
      mean: v.baselineMean ?? null,
      stddev: v.baselineStddev ?? null,
      effectiveStddev: v.effectiveStddev ?? null,
      buckets: v.sampleCount?.baselineBuckets ?? 0,
      window: { start: windows.baselineStart ?? null, end: windows.baselineEnd ?? null },
    },
    sigma: v.sigma ?? null,
    direction: v.direction ?? null,
    rulesTriggered: [...(v.rulesTriggered || [])],
    evaluation,
    contributors,
    relatedIdentifiers: {
      workflowIds: contributors.map((c) => c.workflowId),
      // deployMarkers are only ever OBSERVED (§8.1) — never inferred from timing.
      agentIds: [...(Array.isArray(x.agentIds) ? x.agentIds : [])],
      deployMarkers: [...(Array.isArray(x.deployMarkers) ? x.deployMarkers : [])],
    },
    diagnosis: {
      requested: [...(Array.isArray(x.diagnosis?.requested) ? x.diagnosis.requested : [])],
      via: x.diagnosis?.via ?? "agentcore-hub-workflow-analyzer",
    },
    watcher: {
      cycle: x.cycle ?? null,
      bandsVersion: x.bandsVersion ?? 1,
      configHash: x.configHash ?? null,
    },
  };
}

/** The §6 degradation banner — a rate-limited Tier 3 is never silent. */
const RATE_LIMIT_BANNER =
  "> ⚠ RATE-LIMITED — NOT FILED: Tier-3 anomaly met filing criteria but the fleet " +
  "cap (3 open anomaly-filed workflows) is reached. Evidence below; file manually " +
  "or close an open anomaly workflow.";

function fmtNum(v) {
  if (!isFiniteNum(v)) return "n/a";
  if (Number.isInteger(v)) return String(v);
  const abs = Math.abs(v);
  const fixed = abs >= 1000 ? v.toFixed(0) : abs >= 1 ? v.toFixed(2) : v.toFixed(4);
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

function fmtSigma(v, { signed = false } = {}) {
  if (!isFiniteNum(v)) return "n/a";
  const body = v.toFixed(1);
  return signed && v >= 0 ? `+${body}` : body;
}

/**
 * Human label for the baseline span. The baseline window EXCLUDES the evaluation
 * window (§3.2), so a 7d band spans 7d − evaluationWindow (167h for a 1h eval
 * window). Snap to the nearest whole day within half a day so the label reads as
 * the configured band — "7-day", as §8.2 does — instead of "167-hour".
 */
function fmtSpan(startIso, endIso) {
  const DAY_MS = 86_400_000;
  try {
    const span = epochMs(endIso) - epochMs(startIso);
    if (span <= 0) return "rolling";
    const days = Math.round(span / DAY_MS);
    if (days >= 1 && Math.abs(span - days * DAY_MS) <= 12 * BUCKET_MS) return `${days}-day`;
    const hours = Math.round(span / BUCKET_MS);
    if (hours >= 1) return `${hours}-hour`;
    return `${Math.round(span / 60_000)}-minute`;
  } catch {
    return "rolling";
  }
}

function fmtShare(share) {
  return isFiniteNum(share) ? `${Math.round(share * 100)}%` : "n/a";
}

/**
 * Render an evidence bundle as the operator-facing markdown of §8.2 — the same
 * text goes into the Tier-2 humanNotifications entry and the Tier-3 bug
 * description, so an operator reading either sees identical numbers.
 */
export function renderEvidence(bundle) {
  const b = bundle && typeof bundle === "object" ? bundle : {};
  const baseline = b.baseline || {};
  const baselineWindow = baseline.window || {};
  const evaluation = b.evaluation || {};
  const evalWindow = evaluation.window || {};
  const contributors = Array.isArray(b.contributors) ? b.contributors : [];
  const agentIds = Array.isArray(b.relatedIdentifiers?.agentIds) ? b.relatedIdentifiers.agentIds : [];
  const requested = Array.isArray(b.diagnosis?.requested) ? b.diagnosis.requested : [];
  const rules = Array.isArray(b.rulesTriggered) ? b.rulesTriggered : [];
  const watcher = b.watcher || {};

  const counts = isFiniteNum(evaluation.numerator) && isFiniteNum(evaluation.denominator)
    ? ` (${fmtNum(evaluation.numerator)} / ${fmtNum(evaluation.denominator)})`
    : "";
  const ruleLabel = rules.length
    ? rules.map((r) => String(r).replace(/^we/, "")).join(", ")
    : "none";

  const lines = [
    `## ⚠ Anomaly detected: ${b.metricId} (${b.groupKey}) — Tier ${b.tier} (${fmtSigma(b.sigma)}σ)`,
    "",
    `**What:** ${b.metricId} over the evaluation window is ${fmtNum(b.observed)}${counts} against a ` +
    `${fmtSpan(baselineWindow.start, baselineWindow.end)} baseline of ${fmtNum(baseline.mean)} ± ` +
    `${fmtNum(baseline.effectiveStddev)} (effective σ; raw σ ${fmtNum(baseline.stddev)}, ` +
    `${baseline.buckets ?? 0} hourly buckets). Deviation: **${fmtSigma(b.sigma, { signed: true })}σ** ` +
    `(direction: ${b.direction}). Western Electric rules: **${ruleLabel}**.`,
    "",
    "**Windows (UTC):**",
    `- Evaluation: ${evalWindow.start} → ${evalWindow.end} (${evaluation.samples ?? 0} samples)`,
    `- Baseline:   ${baselineWindow.start} → ${baselineWindow.end} (${baseline.buckets ?? 0} qualifying buckets)`,
    "",
    "**Worst offenders in the window:**",
  ];
  if (contributors.length === 0) {
    lines.push("- (none attributable — no per-workflow contributor in the window)");
  } else {
    for (const c of contributors) {
      lines.push(`- ${c.workflowId} — ${fmtNum(c.value)} (${fmtShare(c.share)} of the observed total)`);
    }
  }
  lines.push(
    "",
    `**Agents involved:** ${agentIds.length ? agentIds.join(", ") : "(none identified)"}`,
    "",
    "**Actions taken by the watcher:**"
  );
  if (requested.length) {
    lines.push(
      `- Read-only Workflow Manager diagnosis requested for ${requested.join(", ")}`,
      `  (via ${b.diagnosis?.via ?? "agentcore-hub-workflow-analyzer"}, trigger=manual).`
    );
  } else {
    lines.push("- No diagnosis was requested (no eligible target workflow).");
  }
  lines.push(
    "- This report. No remediation was or will be attempted by the watcher.",
    "",
    `*anomaly-watcher cycle ${watcher.cycle} · bands.yaml v${watcher.bandsVersion} (${watcher.configHash})*`
  );

  const body = lines.join("\n");
  return b.rateLimited === true ? `${RATE_LIMIT_BANNER}\n\n${body}` : body;
}

/**
 * Build the Tier-3 POST /api/workflow/start body (§8.3). The rendered markdown
 * is the human-readable half; the JSON bundle is appended in a fenced block so
 * the bug-fix pipeline can parse the exact numbers it was filed on.
 *
 * @param {object} bundle from buildEvidenceBundle()
 * @param {object} [opts] {repoUrl, defaultBranch} — repoUrl is env ANOMALY_REPO_URL
 */
export function buildStartPayload(bundle, opts = {}) {
  const b = bundle && typeof bundle === "object" ? bundle : {};
  const o = opts && typeof opts === "object" ? opts : {};
  const repos = o.repoUrl
    ? [{ url: o.repoUrl, defaultBranch: o.defaultBranch || "main" }]
    : [];
  const description = `${renderEvidence(b)}\n\n\`\`\`json\n${JSON.stringify(b, null, 2)}\n\`\`\``;
  return {
    title: `[anomaly] ${b.metricId} ${fmtSigma(b.sigma)}σ over baseline (${b.groupKey}) — ${b.watcher?.cycle ?? ""}`,
    description,
    workflowDefId: "bug-fix",
    workflowType: "bug",
    sources: [],
    repoConfig: { layout: "multi-repo", repos },
    intakeChannel: "anomaly-detector",
  };
}
