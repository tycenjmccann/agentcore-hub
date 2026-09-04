/**
 * bands.yaml validator — PURE (§2.2 of the anomaly-watcher design).
 *
 * Takes an ALREADY-PARSED JS object (the handler owns js-yaml; this module
 * imports nothing) and returns every violation it finds, not just the first:
 *
 *   validateBands(doc) -> { ok: true,  config, errors: [] }
 *                      -> { ok: false,          errors: [string, ...] }
 *
 * A single error disables tiered action for the whole cycle (§2.1), so the
 * errors[] list is what the operator reads to fix the file — one entry per
 * distinct violation, each prefixed with its path (e.g. `metrics[0].id`).
 *
 * There is deliberately NO default fallback: an invalid file never degrades
 * into "run with defaults". Unknown keys at ANY level are hard errors, because
 * a typo'd key (`surpression:`) would otherwise silently disable suppression.
 */

/** Hourly aggregate bucket (§4) — evaluationWindow can never be finer. */
export const BUCKET_MS = 3_600_000;

/**
 * The verified event vocabulary (§1.1). Anything else is a typo or an event
 * nobody writes: counting it would produce a permanently-zero metric that can
 * never fire, which is worse than a validation failure.
 * `agent.streaming` is excluded on purpose — ingest drops it as noise.
 */
export const VERIFIED_EVENT_TYPES = Object.freeze([
  "agent.invoked",
  "agent.complete",
  "workflow.report_completion",
  "agent.error",
  "agent.retry",
  "review.rejected",
  // TEAM-3966 F6: a human-origin advisory-only rejection the orchestrator
  // parks instead of auto-approving (TEAM-3790). A change request that
  // reopened nothing — counted alongside review.rejected, never as a resolution.
  "review.parked_advisory",
  "ticket.created",
]);

const DIRECTIONS = Object.freeze(["upper", "lower", "both"]);
const SOURCE_KINDS = Object.freeze(["events", "eval-config-snapshot"]);
const AGGREGATIONS = Object.freeze(["duration_ms", "rate", "snapshot_delta_avg"]);
/** Allowed source.kind × aggregation combos (§2.2). */
const KIND_AGGREGATIONS = Object.freeze({
  events: ["duration_ms", "rate"],
  "eval-config-snapshot": ["snapshot_delta_avg"],
});
const SUPPORTED_WE_RULES = Object.freeze([1, 2, 3]); // rule 4 deferred in v1

const ID_RE = /^[a-z][a-z0-9_]{2,47}$/;
const DURATION_RE = /^\d+[hd]$/;
const DETAIL_PATH_RE = /^detail\.[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;

const DEFAULT_SIGMA_THRESHOLDS = Object.freeze({ tier1: 1, tier2: 2, tier3: 3 });
const DEFAULT_SUPPRESSION = Object.freeze({ tier3Ttl: "6h", tier2Ttl: "2h" });
const DEFAULT_MAX_TARGETS = 2;

const ROOT_KEYS = ["version", "metrics"];
const METRIC_KEYS = [
  "id", "enabled", "direction", "source", "aggregation", "baselineWindow",
  "evaluationWindow", "sigmaThresholds", "minSamples", "stddevFloor",
  "westernElectric", "suppression", "diagnosis",
];
const SOURCE_KEYS = [
  "kind", "numeratorTypes", "denominatorTypes", "startTypes", "endTypes",
  "where", "groupBy",
];
const SIGMA_KEYS = ["tier1", "tier2", "tier3"];
const MIN_SAMPLE_KEYS = ["baselineBuckets", "evalSamples", "bucketDenominator"];
const STDDEV_FLOOR_KEYS = ["epsilon", "relFloor"];
const WE_KEYS = ["rules"];
const SUPPRESSION_KEYS = ["tier3Ttl", "tier2Ttl"];
const DIAGNOSIS_KEYS = ["maxTargets"];
const MATCHER_KEYS = ["equals", "in", "startsWith"];

// ─── small pure helpers ────────────────────────────────────────────────────────

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isInt(v) {
  return typeof v === "number" && Number.isInteger(v);
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function isScalar(v) {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** Duration string (`^\d+[hd]$`) → milliseconds, or null if malformed. */
export function durationToMs(value) {
  if (typeof value !== "string" || !DURATION_RE.test(value)) return null;
  const n = Number(value.slice(0, -1));
  const unit = value.slice(-1);
  if (!Number.isFinite(n) || n <= 0) return null;
  return unit === "d" ? n * 86_400_000 : n * BUCKET_MS;
}

function unknownKeys(obj, allowed, path, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      errors.push(`${path}: unknown key "${key}" (allowed: ${allowed.join(", ")})`);
    }
  }
}

function requireDuration(value, path, errors, { required = true } = {}) {
  if (value === undefined) {
    if (required) errors.push(`${path}: required`);
    return null;
  }
  const ms = durationToMs(value);
  if (ms === null) {
    errors.push(`${path}: must be a positive duration string matching ^\\d+[hd]$ (got ${JSON.stringify(value)})`);
  }
  return ms;
}

// ─── source.where ──────────────────────────────────────────────────────────────

function validateMatcher(matcher, path, errors) {
  if (!isPlainObject(matcher)) {
    errors.push(`${path}: matcher must be a map with exactly one of ${MATCHER_KEYS.join(" | ")}`);
    return;
  }
  unknownKeys(matcher, MATCHER_KEYS, path, errors);
  const present = MATCHER_KEYS.filter((k) => matcher[k] !== undefined);
  if (present.length !== 1) {
    errors.push(`${path}: matcher must declare exactly one of ${MATCHER_KEYS.join(" | ")} (got ${present.length})`);
    return;
  }
  const [kind] = present;
  const value = matcher[kind];
  if (kind === "equals" && !isScalar(value)) {
    errors.push(`${path}.equals: must be a string, number, or boolean`);
  }
  if (kind === "in" && (!Array.isArray(value) || value.length === 0 || !value.every(isScalar))) {
    errors.push(`${path}.in: must be a non-empty list of scalars`);
  }
  if (kind === "startsWith" && (typeof value !== "string" || value.length === 0)) {
    errors.push(`${path}.startsWith: must be a non-empty string`);
  }
}

/** A map of `detail.<path>` → matcher. */
function validateMatcherMap(map, path, errors) {
  if (!isPlainObject(map)) {
    errors.push(`${path}: must be a map of detail.<path> → matcher`);
    return;
  }
  if (Object.keys(map).length === 0) {
    errors.push(`${path}: must not be empty`);
  }
  for (const [field, matcher] of Object.entries(map)) {
    if (!DETAIL_PATH_RE.test(field)) {
      errors.push(`${path}: matcher field "${field}" must be a detail.<path> reference`);
    }
    validateMatcher(matcher, `${path}.${field}`, errors);
  }
}

/**
 * Two accepted shapes:
 *   flat:  { "detail.agentId": {equals: "x"} }                   — applies to every counted event
 *   roled: { numerator: { <eventType>: { "detail.x": {...} } } } — rate metrics only (§2.3c)
 * The roled form may also name detail paths directly under the role, which then
 * apply to every event type counted for that role.
 */
function validateWhere(where, path, errors, aggregation) {
  if (!isPlainObject(where)) {
    errors.push(`${path}: must be a map`);
    return;
  }
  const roled = Object.keys(where).some((k) => k === "numerator" || k === "denominator");
  if (!roled) {
    validateMatcherMap(where, path, errors);
    return;
  }
  if (aggregation !== "rate") {
    errors.push(`${path}: numerator/denominator matchers are only valid for rate metrics`);
  }
  unknownKeys(where, ["numerator", "denominator"], path, errors);
  for (const role of ["numerator", "denominator"]) {
    const spec = where[role];
    if (spec === undefined) continue;
    if (!isPlainObject(spec)) {
      errors.push(`${path}.${role}: must be a map`);
      continue;
    }
    if (Object.keys(spec).length === 0) {
      errors.push(`${path}.${role}: must not be empty`);
    }
    for (const [key, value] of Object.entries(spec)) {
      if (key.startsWith("detail.")) {
        if (!DETAIL_PATH_RE.test(key)) {
          errors.push(`${path}.${role}: matcher field "${key}" must be a detail.<path> reference`);
        }
        validateMatcher(value, `${path}.${role}.${key}`, errors);
        continue;
      }
      if (!VERIFIED_EVENT_TYPES.includes(key)) {
        errors.push(`${path}.${role}: unknown event type "${key}" — not in the verified vocabulary (${VERIFIED_EVENT_TYPES.join(", ")})`);
      }
      validateMatcherMap(value, `${path}.${role}.${key}`, errors);
    }
  }
}

// ─── source ────────────────────────────────────────────────────────────────────

function validateEventTypeList(value, path, errors, { required }) {
  if (value === undefined) {
    if (required) errors.push(`${path}: required for this aggregation`);
    return;
  }
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path}: must be a non-empty list of event types`);
    return;
  }
  const seen = new Set();
  for (const type of value) {
    if (typeof type !== "string") {
      errors.push(`${path}: event types must be strings (got ${JSON.stringify(type)})`);
      continue;
    }
    if (!VERIFIED_EVENT_TYPES.includes(type)) {
      errors.push(`${path}: unknown event type "${type}" — not in the verified vocabulary (${VERIFIED_EVENT_TYPES.join(", ")})`);
    }
    if (seen.has(type)) {
      errors.push(`${path}: duplicate event type "${type}" — it would be counted twice`);
    }
    seen.add(type);
  }
}

function validateSource(source, path, errors, aggregation) {
  if (!isPlainObject(source)) {
    errors.push(`${path}: required, must be a map`);
    return;
  }
  unknownKeys(source, SOURCE_KEYS, path, errors);

  const kind = source.kind;
  if (kind === undefined) {
    errors.push(`${path}.kind: required`);
  } else if (!SOURCE_KINDS.includes(kind)) {
    errors.push(`${path}.kind: must be one of ${SOURCE_KINDS.join(" | ")} (got ${JSON.stringify(kind)})`);
  }

  if (kind !== undefined && SOURCE_KINDS.includes(kind) && aggregation !== undefined
      && AGGREGATIONS.includes(aggregation)
      && !KIND_AGGREGATIONS[kind].includes(aggregation)) {
    errors.push(`${path}.kind: "${kind}" does not support aggregation "${aggregation}" (allowed: ${KIND_AGGREGATIONS[kind].join(" | ")})`);
  }

  // Which event-type lists this aggregation needs — and which it must not carry.
  const needsRate = aggregation === "rate";
  const needsDuration = aggregation === "duration_ms";
  validateEventTypeList(source.numeratorTypes, `${path}.numeratorTypes`, errors, { required: needsRate });
  validateEventTypeList(source.denominatorTypes, `${path}.denominatorTypes`, errors, { required: needsRate });
  validateEventTypeList(source.startTypes, `${path}.startTypes`, errors, { required: needsDuration });
  validateEventTypeList(source.endTypes, `${path}.endTypes`, errors, { required: needsDuration });
  for (const [key, wanted] of [
    ["numeratorTypes", needsRate], ["denominatorTypes", needsRate],
    ["startTypes", needsDuration], ["endTypes", needsDuration],
  ]) {
    if (!wanted && source[key] !== undefined) {
      errors.push(`${path}.${key}: not valid for aggregation "${aggregation}"`);
    }
  }

  if (source.where !== undefined) validateWhere(source.where, `${path}.where`, errors, aggregation);

  const groupBy = source.groupBy;
  if (groupBy === undefined) {
    errors.push(`${path}.groupBy: required`);
  } else if (typeof groupBy !== "string") {
    errors.push(`${path}.groupBy: must be a string`);
  } else if (kind === "eval-config-snapshot") {
    if (groupBy !== "agentId" && groupBy !== "fleet") {
      errors.push(`${path}.groupBy: eval-config-snapshot supports "agentId" | "fleet" (got ${JSON.stringify(groupBy)})`);
    }
  } else if (groupBy !== "fleet" && !DETAIL_PATH_RE.test(groupBy)) {
    errors.push(`${path}.groupBy: must be "fleet" or a detail.<path> reference (got ${JSON.stringify(groupBy)})`);
  }
}

// ─── metric ────────────────────────────────────────────────────────────────────

function validateSigmaThresholds(value, path, errors) {
  if (value === undefined) return { ...DEFAULT_SIGMA_THRESHOLDS };
  if (!isPlainObject(value)) {
    errors.push(`${path}: must be a map of ${SIGMA_KEYS.join(", ")}`);
    return { ...DEFAULT_SIGMA_THRESHOLDS };
  }
  unknownKeys(value, SIGMA_KEYS, path, errors);
  const resolved = { ...DEFAULT_SIGMA_THRESHOLDS };
  for (const tier of SIGMA_KEYS) {
    if (value[tier] === undefined) continue;
    if (!isFiniteNumber(value[tier]) || value[tier] <= 0) {
      errors.push(`${path}.${tier}: must be a positive number`);
      continue;
    }
    resolved[tier] = value[tier];
  }
  if (!(resolved.tier1 < resolved.tier2 && resolved.tier2 < resolved.tier3)) {
    errors.push(`${path}: must be strictly increasing (tier1 < tier2 < tier3, got ${resolved.tier1} / ${resolved.tier2} / ${resolved.tier3})`);
  }
  return resolved;
}

function validateMinSamples(value, path, errors, aggregation) {
  const resolved = {};
  if (!isPlainObject(value)) {
    errors.push(`${path}: required, must be a map`);
    return resolved;
  }
  unknownKeys(value, MIN_SAMPLE_KEYS, path, errors);

  if (value.baselineBuckets === undefined) {
    errors.push(`${path}.baselineBuckets: required`);
  } else if (!isInt(value.baselineBuckets) || value.baselineBuckets < 2) {
    // n-1 sample stddev is undefined below 2 buckets, so 2 is a hard floor.
    errors.push(`${path}.baselineBuckets: must be an integer >= 2 (got ${JSON.stringify(value.baselineBuckets)})`);
  } else {
    resolved.baselineBuckets = value.baselineBuckets;
  }

  if (value.evalSamples === undefined) {
    errors.push(`${path}.evalSamples: required`);
  } else if (!isInt(value.evalSamples) || value.evalSamples < 1) {
    errors.push(`${path}.evalSamples: must be an integer >= 1 (got ${JSON.stringify(value.evalSamples)})`);
  } else {
    resolved.evalSamples = value.evalSamples;
  }

  const needsDenominator = aggregation === "rate" || aggregation === "snapshot_delta_avg";
  if (value.bucketDenominator === undefined) {
    if (needsDenominator) errors.push(`${path}.bucketDenominator: required for aggregation "${aggregation}"`);
  } else if (!needsDenominator) {
    errors.push(`${path}.bucketDenominator: not valid for aggregation "${aggregation}"`);
  } else if (!isInt(value.bucketDenominator) || value.bucketDenominator < 0) {
    errors.push(`${path}.bucketDenominator: must be an integer >= 0 (got ${JSON.stringify(value.bucketDenominator)})`);
  } else {
    resolved.bucketDenominator = value.bucketDenominator;
  }
  return resolved;
}

function validateStddevFloor(value, path, errors) {
  const resolved = {};
  if (!isPlainObject(value)) {
    errors.push(`${path}: required, must be a map`);
    return resolved;
  }
  unknownKeys(value, STDDEV_FLOOR_KEYS, path, errors);
  if (value.epsilon === undefined) {
    errors.push(`${path}.epsilon: required`);
  } else if (!isFiniteNumber(value.epsilon) || value.epsilon < 0) {
    errors.push(`${path}.epsilon: must be a number >= 0 (got ${JSON.stringify(value.epsilon)})`);
  } else {
    resolved.epsilon = value.epsilon;
  }
  if (value.relFloor === undefined) {
    errors.push(`${path}.relFloor: required`);
  } else if (!isFiniteNumber(value.relFloor) || value.relFloor < 0 || value.relFloor > 1) {
    errors.push(`${path}.relFloor: must be a number in [0, 1] (got ${JSON.stringify(value.relFloor)})`);
  } else {
    resolved.relFloor = value.relFloor;
  }
  return resolved;
}

function validateWesternElectric(value, path, errors) {
  const resolved = { rules: [] };
  if (!isPlainObject(value)) {
    errors.push(`${path}: required, must be a map with a rules list`);
    return resolved;
  }
  unknownKeys(value, WE_KEYS, path, errors);
  const rules = value.rules;
  if (rules === undefined) {
    errors.push(`${path}.rules: required`);
    return resolved;
  }
  if (!Array.isArray(rules) || rules.length === 0) {
    errors.push(`${path}.rules: must be a non-empty list drawn from [${SUPPORTED_WE_RULES.join(", ")}]`);
    return resolved;
  }
  const seen = new Set();
  for (const rule of rules) {
    if (!SUPPORTED_WE_RULES.includes(rule)) {
      errors.push(`${path}.rules: rule ${JSON.stringify(rule)} is not supported in v1 (supported: ${SUPPORTED_WE_RULES.join(", ")})`);
      continue;
    }
    if (seen.has(rule)) {
      errors.push(`${path}.rules: duplicate rule ${rule}`);
      continue;
    }
    seen.add(rule);
  }
  // Rule 1 is the sole Tier-3 trigger — a band with it removed could never file.
  if (!seen.has(1)) errors.push(`${path}.rules: must include rule 1 (the sole Tier-3 trigger)`);
  resolved.rules = SUPPORTED_WE_RULES.filter((r) => seen.has(r));
  return resolved;
}

function validateSuppression(value, path, errors) {
  if (value === undefined) return { ...DEFAULT_SUPPRESSION };
  if (!isPlainObject(value)) {
    errors.push(`${path}: must be a map of ${SUPPRESSION_KEYS.join(", ")}`);
    return { ...DEFAULT_SUPPRESSION };
  }
  unknownKeys(value, SUPPRESSION_KEYS, path, errors);
  const resolved = { ...DEFAULT_SUPPRESSION };
  for (const key of SUPPRESSION_KEYS) {
    if (value[key] === undefined) continue;
    const ms = requireDuration(value[key], `${path}.${key}`, errors, { required: false });
    if (ms !== null) resolved[key] = value[key];
  }
  return resolved;
}

function validateDiagnosis(value, path, errors) {
  if (value === undefined) return { maxTargets: DEFAULT_MAX_TARGETS };
  if (!isPlainObject(value)) {
    errors.push(`${path}: must be a map with maxTargets`);
    return { maxTargets: DEFAULT_MAX_TARGETS };
  }
  unknownKeys(value, DIAGNOSIS_KEYS, path, errors);
  if (value.maxTargets === undefined) return { maxTargets: DEFAULT_MAX_TARGETS };
  if (!isInt(value.maxTargets) || value.maxTargets < 0 || value.maxTargets > 3) {
    errors.push(`${path}.maxTargets: must be an integer in [0, 3] (got ${JSON.stringify(value.maxTargets)})`);
    return { maxTargets: DEFAULT_MAX_TARGETS };
  }
  return { maxTargets: value.maxTargets };
}

function validateMetric(metric, index, errors) {
  const path = `metrics[${index}]`;
  if (!isPlainObject(metric)) {
    errors.push(`${path}: must be a map`);
    return null;
  }
  unknownKeys(metric, METRIC_KEYS, path, errors);

  if (metric.id === undefined) {
    errors.push(`${path}.id: required`);
  } else if (typeof metric.id !== "string" || !ID_RE.test(metric.id)) {
    errors.push(`${path}.id: must match ^[a-z][a-z0-9_]{2,47}$ (got ${JSON.stringify(metric.id)})`);
  }

  if (metric.enabled === undefined) {
    errors.push(`${path}.enabled: required`);
  } else if (typeof metric.enabled !== "boolean") {
    errors.push(`${path}.enabled: must be a boolean (got ${JSON.stringify(metric.enabled)})`);
  }

  if (metric.direction === undefined) {
    errors.push(`${path}.direction: required`);
  } else if (!DIRECTIONS.includes(metric.direction)) {
    errors.push(`${path}.direction: must be one of ${DIRECTIONS.join(" | ")} (got ${JSON.stringify(metric.direction)})`);
  }

  const aggregation = metric.aggregation;
  if (aggregation === undefined) {
    errors.push(`${path}.aggregation: required`);
  } else if (!AGGREGATIONS.includes(aggregation)) {
    errors.push(`${path}.aggregation: must be one of ${AGGREGATIONS.join(" | ")} (got ${JSON.stringify(aggregation)})`);
  }

  validateSource(metric.source, `${path}.source`, errors, aggregation);

  const baselineMs = requireDuration(metric.baselineWindow, `${path}.baselineWindow`, errors);
  const evalMs = requireDuration(metric.evaluationWindow, `${path}.evaluationWindow`, errors);
  if (evalMs !== null) {
    // The aggregate table has 1h resolution (§4), so a finer eval window would
    // read buckets that don't exist.
    if (evalMs < BUCKET_MS) {
      errors.push(`${path}.evaluationWindow: must be >= 1h (the aggregate bucket size)`);
    } else if (evalMs % BUCKET_MS !== 0) {
      errors.push(`${path}.evaluationWindow: must be a whole multiple of the 1h aggregate bucket`);
    }
  }
  if (baselineMs !== null && evalMs !== null && evalMs >= BUCKET_MS) {
    if (baselineMs <= evalMs) {
      errors.push(`${path}.baselineWindow: must be longer than evaluationWindow`);
    } else if (baselineMs % evalMs !== 0) {
      errors.push(`${path}.baselineWindow: must be a whole multiple of evaluationWindow (${metric.baselineWindow} / ${metric.evaluationWindow})`);
    }
  }

  const sigmaThresholds = validateSigmaThresholds(metric.sigmaThresholds, `${path}.sigmaThresholds`, errors);
  const minSamples = validateMinSamples(metric.minSamples, `${path}.minSamples`, errors, aggregation);
  const stddevFloor = validateStddevFloor(metric.stddevFloor, `${path}.stddevFloor`, errors);
  const westernElectric = validateWesternElectric(metric.westernElectric, `${path}.westernElectric`, errors);
  const suppression = validateSuppression(metric.suppression, `${path}.suppression`, errors);
  const diagnosis = validateDiagnosis(metric.diagnosis, `${path}.diagnosis`, errors);

  // Normalized copy — defaults resolved, input untouched.
  const source = isPlainObject(metric.source) ? metric.source : {};
  return {
    id: metric.id,
    enabled: metric.enabled,
    direction: metric.direction,
    source: {
      kind: source.kind,
      ...(source.numeratorTypes !== undefined ? { numeratorTypes: [...source.numeratorTypes] } : {}),
      ...(source.denominatorTypes !== undefined ? { denominatorTypes: [...source.denominatorTypes] } : {}),
      ...(source.startTypes !== undefined ? { startTypes: [...source.startTypes] } : {}),
      ...(source.endTypes !== undefined ? { endTypes: [...source.endTypes] } : {}),
      ...(source.where !== undefined ? { where: source.where } : {}),
      groupBy: source.groupBy,
    },
    aggregation: metric.aggregation,
    baselineWindow: metric.baselineWindow,
    evaluationWindow: metric.evaluationWindow,
    sigmaThresholds,
    minSamples,
    stddevFloor,
    westernElectric,
    suppression,
    diagnosis,
  };
}

/**
 * Validate a parsed bands document.
 *
 * @param {unknown} doc already-parsed YAML (this module never touches js-yaml)
 * @returns {{ok: boolean, config?: object, errors: string[]}} `config` is the
 *   normalized document (defaults resolved) and is present ONLY when ok.
 */
export function validateBands(doc) {
  const errors = [];
  if (!isPlainObject(doc)) {
    return { ok: false, errors: ["bands.yaml: must be a map with version + metrics"] };
  }
  unknownKeys(doc, ROOT_KEYS, "bands.yaml", errors);

  if (doc.version === undefined) {
    errors.push("version: required");
  } else if (!isInt(doc.version) || doc.version !== 1) {
    errors.push(`version: must be the integer 1 (got ${JSON.stringify(doc.version)})`);
  }

  const metrics = [];
  if (doc.metrics === undefined) {
    errors.push("metrics: required");
  } else if (!Array.isArray(doc.metrics)) {
    errors.push("metrics: must be a list");
  } else if (doc.metrics.length === 0) {
    errors.push("metrics: must not be empty");
  } else {
    const seenIds = new Set();
    doc.metrics.forEach((metric, index) => {
      const normalized = validateMetric(metric, index, errors);
      if (normalized) metrics.push(normalized);
      const id = isPlainObject(metric) ? metric.id : undefined;
      if (typeof id === "string") {
        if (seenIds.has(id)) errors.push(`metrics[${index}].id: duplicate metric id "${id}"`);
        seenIds.add(id);
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: { version: 1, metrics }, errors: [] };
}
