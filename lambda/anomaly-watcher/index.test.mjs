/**
 * Handler tests for the anomaly watcher — the acceptance criteria that live on
 * the I/O side of the module boundary.
 *   npm install && node --test        (from lambda/anomaly-watcher/)
 *
 * detect.test.mjs covers the pure detection matrix (§3.6) and needs no deps.
 * This file needs js-yaml (to parse bands.yaml and the §2.4 invalid fixture) and
 * nothing else: the AWS clients are injected, so no @aws-sdk import is reached.
 *
 * Everything below drives the real runCycle() with a fake client bundle in the
 * shape initClients() returns. The fake state table is a Map and it IMPLEMENTS
 * the ConditionExpression semantics the claims rely on:
 *   - "attribute_not_exists(pk)"                          → strict, one winner ever
 *   - "attribute_not_exists(pk) OR expiresAt < :nowEpoch"  → TTL'd claim
 *   - "claimToken = :mine"                                 → ownership guard
 * A conditional miss throws a real ConditionalCheckFailedException, which is the
 * only thing isConditionalFailure() keys on. The check-and-write is synchronous
 * inside send(), mirroring DynamoDB's atomicity; the `await` at the top of send()
 * is what lets two concurrent invocations interleave and race for a claim.
 *
 * The statistics fixture is deliberately exact (no tolerances): 167 baseline
 * buckets of 1/20 = 0.05 each ⇒ mean 0.05, raw σ 0, effective σ
 * max(0, epsilon 0.05, 0.25 × 0.05) = 0.05. So an observed 0.75 is exactly 14σ
 * (Tier 3, rule 1) and an observed 0.175 is exactly 2.5σ (Tier 2, no rule 1).
 */
import test from "node:test";
import assert from "node:assert/strict";
import yaml from "js-yaml";

import {
  allowedFilings,
  bucketKeyOf,
  cycleLabel,
  dropStaleItems,
  epochMsOf,
  filingFailedMarker,
  INTAKE_CHANNEL,
  INTAKE_INDEX,
  LATE_EVENT_TOLERANCE_MS,
  loadBands,
  metricWindows,
  openCountFrom,
  OPEN_WORKFLOW_CAP,
  RATELIMIT_PK,
  readEnv,
  resolveScheduledTime,
  runCycle,
} from "./index.mjs";
import {
  buildEvidenceBundle,
  buildStartPayload,
  canonicalWindowStart,
  renderEvidence,
} from "./detect.mjs";
import { validateBands, VERIFIED_EVENT_TYPES } from "./bands-schema.mjs";

// ─── fixtures ────────────────────────────────────────────────────────────────

const ENV = Object.freeze({
  region: "us-east-1",
  eventsTable: "agentcore-hub-events",
  workflowsTable: "agentcore-hub-workflows",
  evalConfigTable: "agentcore-hub-eval-config",
  stateTable: "agentcore-hub-anomaly-watcher-state",
  workflowApiUrl: "https://hub.example.com",
  analyzerFunction: "agentcore-hub-workflow-analyzer",
  eventBus: "agentcore-hub-bus",
  repoUrl: "https://github.com/tycenjmccann/agentcore-hub",
});

/** 14:27:31 → canonical cycle 14:20Z → evaluation window 13:00Z → 14:00Z. */
const EVENT = Object.freeze({ time: "2026-08-27T14:27:31Z" });
const NOW_MS = Date.parse("2026-08-27T14:27:35Z");
const CYCLE = "2026-08-27T14:20Z";
const FIXTURE_HASH = "sha256:0123456789ab";

const BASELINE_START_MS = Date.parse("2026-08-20T14:00:00Z");
const EVAL_BUCKET = "2026-08-27T13";
const TIER3_EVAL = { num: 15, den: 20 }; // 0.75  → 14σ
const TIER2_EVAL = { num: 7, den: 40 }; //  0.175 → 2.5σ

function rateMetricYaml(id) {
  return `  - id: ${id}
    enabled: true
    direction: upper
    source:
      kind: events
      numeratorTypes: [agent.error, agent.retry]
      denominatorTypes: [agent.invoked]
      groupBy: fleet
    aggregation: rate
    baselineWindow: 7d
    evaluationWindow: 1h
    sigmaThresholds: { tier1: 1, tier2: 2, tier3: 3 }
    minSamples: { baselineBuckets: 24, evalSamples: 5, bucketDenominator: 5 }
    stddevFloor: { epsilon: 0.05, relFloor: 0.25 }
    westernElectric: { rules: [1, 2, 3] }
    suppression: { tier3Ttl: 6h, tier2Ttl: 2h }
    diagnosis: { maxTargets: 2 }
`;
}

/**
 * Bands fixtures go through the REAL validator, so the metric objects the handler
 * sees are normalized exactly as a loadBands() result would be.
 */
function bandsFixture(...metricIds) {
  const text = `version: 1\nmetrics:\n${metricIds.map(rateMetricYaml).join("\n")}`;
  const res = validateBands(yaml.load(text));
  assert.ok(res.ok, `bands fixture is invalid: ${(res.errors || []).join(" | ")}`);
  return { ...res, configHash: FIXTURE_HASH, digest: "0".repeat(64) };
}

/** 167 baseline buckets at 1/20, then the evaluation bucket. */
function aggRows(evalBucket) {
  const rows = [];
  for (let i = 0; i < 167; i += 1) {
    rows.push({ sk: bucketKeyOf(BASELINE_START_MS + i * 3_600_000), num: 1, den: 20 });
  }
  rows.push({ sk: EVAL_BUCKET, ...evalBucket });
  return rows;
}

const CONTRIB_ROWS = Object.freeze([
  { sk: `${EVAL_BUCKET}#wf_1`, num: 10 },
  { sk: `${EVAL_BUCKET}#wf_2`, num: 5 },
]);

/** State-table rows a metric needs to reach the given tier. */
function rowsFor(metricId, evalBucket) {
  return {
    [`agg#${metricId}#fleet`]: aggRows(evalBucket),
    [`contrib#${metricId}#fleet`]: [...CONTRIB_ROWS],
  };
}

function openWorkflow(workflowId) {
  return { workflowId, intakeChannel: INTAKE_CHANNEL, phase: "development", archived: false };
}

function conditionalFailure() {
  const err = new Error("The conditional request failed");
  err.name = "ConditionalCheckFailedException";
  return err;
}

function okResponse(body = { workflowId: "wf_filed_1" }) {
  return { ok: true, status: 200, json: async () => body };
}

function errResponse(status, body = { error: `HTTP ${status}` }) {
  return { ok: false, status, json: async () => body };
}

// ─── the fake client bundle ──────────────────────────────────────────────────

function mkCommand(name) {
  return class {
    constructor(params) {
      Object.assign(this, params);
      this.__cmd = name;
    }
  };
}

const CMD = Object.freeze({
  GetCommand: mkCommand("Get"),
  PutCommand: mkCommand("Put"),
  UpdateCommand: mkCommand("Update"),
  DeleteCommand: mkCommand("Delete"),
  QueryCommand: mkCommand("Query"),
  ScanCommand: mkCommand("Scan"),
  TransactWriteCommand: mkCommand("Transact"),
  InvokeCommand: mkCommand("Invoke"),
  PutEventsCommand: mkCommand("PutEvents"),
});

/**
 * @param {object} opts
 *   store       shared Map for the state table (pass the same one to two
 *               harnesses to simulate two invocations against one table)
 *   rows        {pk: [row, …]} answers for state-table Query
 *   openItems   items returned by the intakeChannel-index Query
 *   workflows   items returned by the workflows Scan
 *   evalConfig  items returned by the eval-config Scan
 *   responses   array of fetch responses, consumed in order (default: 200 OK)
 *   failPut     (pk, sk) => boolean — throw a GENERIC (non-conditional) error
 *   failGet     (pk, sk) => boolean — same, on Get
 */
function makeHarness(opts = {}) {
  const store = opts.store || new Map();
  const rows = opts.rows || {};
  const calls = [];
  const fetchCalls = [];
  const invokes = [];
  const busEntries = [];
  const notifications = [];
  const anomalyEvents = [];
  const transactions = [];
  const responses = [...(opts.responses || [])];
  const keyOf = (pk, sk) => `${pk}\u0000${sk}`;

  function conditionHolds(cmd, existing) {
    const cond = cmd.ConditionExpression || "";
    if (!cond.includes("attribute_not_exists(pk)")) return true;
    if (!existing) return true;
    if (!cond.includes("expiresAt <")) return false; // strict
    const nowEpoch = cmd.ExpressionAttributeValues?.[":nowEpoch"];
    return Number.isFinite(existing.expiresAt) && Number.isFinite(nowEpoch) && existing.expiresAt < nowEpoch;
  }

  // TEAM-3334: ownership guards come in two spellings now — ":mine" (this
  // invocation's claims) and ":owner" (the unverified-claim resolver acting on
  // an EARLIER invocation's claim). Enforce whichever the expression names.
  function checkClaimToken(cmd, existing) {
    const ref = cmd.ConditionExpression?.match(/claimToken = (:\w+)/);
    if (!ref) return;
    const want = cmd.ExpressionAttributeValues?.[ref[1]];
    if (!existing || existing.claimToken !== want) throw conditionalFailure();
  }

  const ddb = {
    async send(cmd) {
      // Yield BEFORE handling so two in-flight cycles interleave here; the
      // condition check + write below is synchronous, i.e. atomic, as in DynamoDB.
      await Promise.resolve();
      calls.push(cmd);
      switch (cmd.__cmd) {
        case "Get": {
          if (opts.failGet?.(cmd.Key.pk, cmd.Key.sk)) throw new Error("state get failed");
          return { Item: store.get(keyOf(cmd.Key.pk, cmd.Key.sk)) };
        }
        case "Put": {
          if (cmd.TableName === ENV.eventsTable) {
            anomalyEvents.push(cmd.Item);
            return {};
          }
          if (cmd.TableName !== ENV.stateTable) return {};
          if (opts.failPut?.(cmd.Item.pk, cmd.Item.sk)) throw new Error("state put failed");
          const key = keyOf(cmd.Item.pk, cmd.Item.sk);
          if (!conditionHolds(cmd, store.get(key))) throw conditionalFailure();
          store.set(key, { ...cmd.Item });
          return {};
        }
        case "Update": {
          if (cmd.TableName === ENV.workflowsTable) {
            const entry = cmd.ExpressionAttributeValues?.[":n"]?.[0];
            if (entry) notifications.push({ workflowId: cmd.Key.workflowId, notification: entry });
            return {};
          }
          const key = keyOf(cmd.Key.pk, cmd.Key.sk);
          const existing = store.get(key);
          checkClaimToken(cmd, existing);
          const merged = { ...(existing || { pk: cmd.Key.pk, sk: cmd.Key.sk }) };
          if (cmd.UpdateExpression?.includes("list_append") && cmd.ExpressionAttributeValues?.[":w"]) {
            // TEAM-3334: the only state-table list_append is the ratelimit filed
            // list — apply real append semantics so tests can read it back.
            merged.filed = [
              ...(Array.isArray(existing?.filed) ? existing.filed : []),
              ...cmd.ExpressionAttributeValues[":w"],
            ];
          } else {
            for (const [name, value] of Object.entries(cmd.ExpressionAttributeValues || {})) {
              if (name === ":mine" || name === ":empty" || name === ":owner") continue;
              merged[name.slice(1)] = value;
            }
          }
          store.set(key, merged);
          return {};
        }
        case "Delete": {
          const key = keyOf(cmd.Key.pk, cmd.Key.sk);
          const existing = store.get(key);
          checkClaimToken(cmd, existing);
          store.delete(key);
          return {};
        }
        case "Query": {
          if (cmd.TableName === ENV.workflowsTable) {
            const items = opts.openItems || [];
            // TEAM-3334 F1: the resolver bounds its index read by startedAt and
            // reads a candidate's stored intake payload from the base table.
            const since = cmd.ExpressionAttributeValues?.[":since"];
            if (since !== undefined) return { Items: items.filter((w) => String(w?.startedAt ?? "") >= since) };
            const id = cmd.ExpressionAttributeValues?.[":id"];
            if (id !== undefined) return { Items: items.filter((w) => w?.workflowId === id) };
            return { Items: items };
          }
          if (cmd.TableName === ENV.eventsTable) return { Items: [] };
          const pk = cmd.ExpressionAttributeValues?.[":pk"];
          const lo = cmd.ExpressionAttributeValues?.[":a"];
          const hi = cmd.ExpressionAttributeValues?.[":b"];
          const all = rows[pk] || [];
          return { Items: all.filter((r) => String(r.sk) >= lo && String(r.sk) <= hi) };
        }
        case "Scan": {
          if (cmd.TableName === ENV.workflowsTable) return { Items: opts.workflows || [] };
          if (cmd.TableName === ENV.evalConfigTable) return { Items: opts.evalConfig || [] };
          return { Items: [] };
        }
        case "Transact": {
          transactions.push(cmd.TransactItems);
          return {};
        }
        default:
          throw new Error(`unexpected command ${cmd.__cmd}`);
      }
    },
  };

  const clients = {
    ddb,
    lambda: {
      async send(cmd) {
        invokes.push({
          FunctionName: cmd.FunctionName,
          InvocationType: cmd.InvocationType,
          payload: JSON.parse(Buffer.from(cmd.Payload).toString("utf8")),
        });
        return {};
      },
    },
    events: {
      async send(cmd) {
        busEntries.push(...cmd.Entries);
        return {};
      },
    },
    cmd: CMD,
    async fetch(url, init) {
      fetchCalls.push({ url, method: init?.method, headers: init?.headers || {}, body: JSON.parse(init.body) });
      return responses.length ? responses.shift() : okResponse();
    },
  };

  return { clients, store, calls, fetchCalls, invokes, busEntries, notifications, anomalyEvents, transactions };
}

const startPosts = (h) => h.fetchCalls.filter((c) => c.url.endsWith("/api/workflow/start"));

/**
 * Run one cycle with the console captured — runCycle logs a summary line and a
 * warning per suppressed action, which would otherwise bury the test output.
 */
async function runWatcher({ harness, bands, event = EVENT, nowMs = NOW_MS, requestId = "req-a", env = ENV }) {
  const logs = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ["log", "warn", "error"]) {
    console[level] = (...args) => logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  }
  try {
    const summary = await runCycle({
      event,
      context: { awsRequestId: requestId },
      env,
      clients: harness.clients,
      nowMs,
      bands,
    });
    return { summary, logs };
  } finally {
    Object.assign(console, original);
  }
}

/** A ready-to-run single-metric cycle at the given tier. */
function scenario(overrides = {}) {
  const metricId = overrides.metricId || "fleet_rate_a";
  const evalBucket = overrides.evalBucket || TIER3_EVAL;
  const harness = makeHarness({
    rows: rowsFor(metricId, evalBucket),
    openItems: overrides.openItems || [],
    responses: overrides.responses,
    store: overrides.store,
    failPut: overrides.failPut,
    failGet: overrides.failGet,
  });
  return { harness, bands: bandsFixture(metricId), metricId };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. bands.yaml — the shipped file and the §2.4 invalid fixture
// ═════════════════════════════════════════════════════════════════════════════

test("the shipped bands.yaml loads, validates, and hashes", async () => {
  const bands = await loadBands();
  assert.ok(bands.ok, `bands.yaml should be valid: ${(bands.errors || []).join(" | ")}`);
  assert.equal(bands.config.version, 1);
  assert.equal(bands.config.metrics.length, 4);
  assert.deepEqual(
    bands.config.metrics.map((m) => m.id),
    ["agent_task_duration_ms", "agent_error_retry_rate", "ci_failure_rate", "eval_score_avg"]
  );
  assert.match(bands.configHash, /^sha256:[0-9a-f]{12}$/);
  assert.match(bands.digest, /^[0-9a-f]{64}$/);
  assert.equal(bands.configHash, `sha256:${bands.digest.slice(0, 12)}`);
  // Every metric ends up normalized enough for the handler to window it.
  for (const metric of bands.config.metrics) {
    const w = metricWindows(metric, "2026-08-27T14:20:00Z");
    assert.equal(w.baselineEnd, w.evalStart);
    assert.ok(Date.parse(w.baselineStart) < Date.parse(w.evalStart));
  }
});

/**
 * §2.4 verbatim. Note `enabled: yes`: the doc annotates it "ok (YAML bool)", but
 * js-yaml 4 is YAML 1.2, where `yes` is the STRING "yes" — so the fixture yields
 * one error MORE than the doc's ✗ marks, and that extra error is real (a string
 * is not a boolean). Same for `bucketDenominator`, which §2.3 requires for rate
 * metrics and the fixture omits.
 */
const INVALID_BANDS_YAML = `version: 1
metrics:
  - id: CI-fail%                     # ✗ id violates ^[a-z][a-z0-9_]{2,47}$
    enabled: yes                     # ok (YAML bool)
    # ✗ direction missing (required)
    source:
      kind: events
      numeratorTypes: [ci.failed]    # ✗ unknown event type
      groupBy: fleet
      # ✗ denominatorTypes missing but aggregation is rate
    aggregation: rate
    baselineWindow: 7 days           # ✗ must match ^\\d+[hd]$
    evaluationWindow: 30m            # ✗ smaller than the 1h aggregate bucket
    sigmaThresholds: { tier1: 2, tier2: 2, tier3: 1.5 }   # ✗ not strictly increasing
    minSamples: { baselineBuckets: 1, evalSamples: 0 }    # ✗ <2; ✗ <1
    stddevFloor: { epsilon: -0.1 }   # ✗ epsilon < 0; ✗ relFloor missing
    westernElectric: { rules: [2, 4] } # ✗ rule 1 missing; ✗ rule 4 unsupported
    surpression: { tier3Ttl: 6h }    # ✗ unknown key (typo) — hard error
`;

test("the §2.4 invalid fixture produces every annotated error, each distinct", () => {
  const res = validateBands(yaml.load(INVALID_BANDS_YAML));
  assert.equal(res.ok, false);
  assert.equal(new Set(res.errors).size, res.errors.length, "errors must be distinct");
  assert.equal(res.errors.length, 16);

  const has = (needle) =>
    assert.ok(
      res.errors.some((e) => e.includes(needle)),
      `expected an error containing ${JSON.stringify(needle)}, got:\n${res.errors.join("\n")}`
    );

  has('unknown key "surpression"');
  has('metrics[0].id: must match ^[a-z][a-z0-9_]{2,47}$ (got "CI-fail%")');
  has("metrics[0].enabled: must be a boolean"); // YAML 1.2: "yes" is a string
  has("metrics[0].direction: required");
  has('metrics[0].source.numeratorTypes: unknown event type "ci.failed"');
  has("metrics[0].source.denominatorTypes: required for this aggregation");
  has("metrics[0].baselineWindow: must be a positive duration string");
  has("metrics[0].evaluationWindow: must be a positive duration string"); // "30m": sub-hour AND malformed
  has("metrics[0].sigmaThresholds: must be strictly increasing");
  has("metrics[0].minSamples.baselineBuckets: must be an integer >= 2");
  has("metrics[0].minSamples.evalSamples: must be an integer >= 1");
  has('metrics[0].minSamples.bucketDenominator: required for aggregation "rate"');
  has("metrics[0].stddevFloor.epsilon: must be a number >= 0");
  has("metrics[0].stddevFloor.relFloor: required");
  has("rule 4 is not supported in v1");
  has("must include rule 1 (the sole Tier-3 trigger)");
});

/**
 * A sub-hour evaluation window can only ever arrive as a malformed duration:
 * ^\d+[hd]$ plus the positivity check means every ACCEPTED duration is already
 * >= 1h, so the explicit ">= 1h (the aggregate bucket size)" guard in
 * bands-schema.mjs is unreachable belt-and-braces. Both reachable window guards
 * are pinned here instead.
 */
test("sub-hour and non-multiple evaluation windows are both rejected", () => {
  const withWindows = (evaluationWindow, baselineWindow = "7d") =>
    validateBands(
      yaml.load(
        `version: 1\nmetrics:\n${rateMetricYaml("windowed_rate")
          .replace("evaluationWindow: 1h", `evaluationWindow: ${evaluationWindow}`)
          .replace("baselineWindow: 7d", `baselineWindow: ${baselineWindow}`)}`
      )
    );

  for (const bad of ["30m", "0h", "90s", "1"]) {
    const res = withWindows(bad);
    assert.equal(res.ok, false, `${bad} should be rejected`);
    assert.ok(
      res.errors.some((e) => e.includes("evaluationWindow: must be a positive duration string")),
      `${bad}: ${res.errors.join("\n")}`
    );
  }
  // 168h / 5h is not a whole number of evaluation windows.
  assert.ok(
    withWindows("5h").errors.some((e) => e.includes("must be a whole multiple of evaluationWindow")),
    withWindows("5h").errors.join("\n")
  );
  // A baseline no longer than the evaluation window leaves nothing to compare to.
  assert.ok(
    withWindows("6h", "6h").errors.some((e) => e.includes("baselineWindow: must be longer than evaluationWindow")),
    withWindows("6h", "6h").errors.join("\n")
  );
  assert.equal(withWindows("6h").ok, true, "168h / 6h is fine");
});

test("an invalid config takes NO tiered action for the whole cycle", async () => {
  const bad = validateBands(yaml.load(INVALID_BANDS_YAML));
  const harness = makeHarness({ rows: rowsFor("fleet_rate_a", TIER3_EVAL), workflows: [openWorkflow("wf_1")] });
  const { summary } = await runWatcher({
    harness,
    bands: { ...bad, configHash: FIXTURE_HASH, digest: "0".repeat(64) },
  });

  assert.equal(summary.configError, "bands.yaml invalid: 16 error(s)");
  assert.equal(summary.configHash, FIXTURE_HASH);
  assert.equal(summary.bandsVersion, null);
  assert.deepEqual(summary.metrics, []);
  assert.equal(summary.actions.tier1Logged, 0);
  assert.equal(summary.actions.tier2Escalations, 0);
  assert.deepEqual(summary.actions.tier3Filed, []);
  assert.deepEqual(summary.actions.tier3RateLimited, []);
  assert.deepEqual(summary.actions.dedupeSuppressed, []);
  assert.deepEqual(summary.actions.diagnosisInvoked, []);
  assert.deepEqual(summary.actions.failures, []);
  // Nothing left the account, and no cursor was advanced.
  assert.equal(harness.fetchCalls.length, 0);
  assert.equal(harness.invokes.length, 0);
  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.busEntries.length, 0);
  assert.equal(harness.transactions.length, 0);
  // The rate-limit query is not even attempted when there is no valid config.
  assert.equal(harness.calls.filter((c) => c.IndexName === INTAKE_INDEX).length, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Evidence formatter (AC-5.1)
// ═════════════════════════════════════════════════════════════════════════════

function syntheticBundle(extras = {}) {
  const verdict = {
    metricId: "agent_error_retry_rate",
    groupKey: "fleet",
    status: "anomaly",
    tier: 3,
    observed: 0.75,
    baselineMean: 0.05,
    baselineStddev: 0.012,
    effectiveStddev: 0.05,
    sigma: 14,
    direction: "upper",
    rulesTriggered: ["we1", "we2"],
    sampleCount: { baselineBuckets: 167, evalSamples: 20 },
    windows: {
      baselineStart: "2026-08-20T14:00:00Z",
      baselineEnd: "2026-08-27T13:00:00Z",
      evalStart: "2026-08-27T13:00:00Z",
      evalEnd: "2026-08-27T14:00:00Z",
    },
    contributors: [
      { workflowId: "wf_1", value: 10, share: 2 / 3 },
      { workflowId: "wf_2", value: 5, share: 1 / 3 },
    ],
  };
  return buildEvidenceBundle(verdict, {
    numerator: 15,
    denominator: 20,
    agentIds: ["agentcore_hub_dev_agent"],
    deployMarkers: [],
    diagnosis: { requested: ["wf_1", "wf_2"], via: ENV.analyzerFunction },
    cycle: CYCLE,
    bandsVersion: 1,
    configHash: FIXTURE_HASH,
    ...extras,
  });
}

test("renderEvidence carries every §8.2 field an operator needs", () => {
  const text = renderEvidence(syntheticBundle());

  assert.ok(text.includes("agent_error_retry_rate"), "metric name");
  assert.ok(text.includes("0.75"), "observed value");
  assert.ok(text.includes("(15 / 20)"), "numerator/denominator");
  assert.ok(text.includes("0.05"), "baseline mean + effective stddev");
  assert.ok(text.includes("raw σ 0.012"), "raw stddev");
  assert.ok(text.includes("14.0σ"), "sigma magnitude");
  assert.ok(text.includes("+14.0σ"), "signed sigma");
  assert.ok(text.includes("direction: upper"), "direction");
  // Absolute ISO bounds for BOTH windows — never "the last 7 days".
  assert.ok(text.includes("2026-08-27T13:00:00Z → 2026-08-27T14:00:00Z"), "evaluation window");
  assert.ok(text.includes("2026-08-20T14:00:00Z → 2026-08-27T13:00:00Z"), "baseline window");
  assert.ok(text.includes("(20 samples)"), "evaluation sample count");
  assert.ok(text.includes("167 hourly buckets"), "baseline bucket count");
  assert.ok(text.includes("167 qualifying buckets"), "baseline bucket count in the window block");
  assert.ok(text.includes("Western Electric rules: **1, 2**"), "triggered rules");
  assert.ok(text.includes("wf_1 — 10 (67% of the observed total)"), "related run id + share");
  assert.ok(text.includes("wf_2 — 5 (33% of the observed total)"), "second related run id");
  assert.ok(text.includes("agentcore_hub_dev_agent"), "agents involved");
  assert.ok(text.includes("diagnosis requested for wf_1, wf_2"), "diagnosis targets");
  assert.ok(text.includes(ENV.analyzerFunction), "diagnosis route");
  assert.ok(text.includes("No remediation was or will be attempted"), "watcher never remediates");
  assert.ok(text.includes(`cycle ${CYCLE}`), "cycle label");
  assert.ok(text.includes(`bands.yaml v1 (${FIXTURE_HASH})`), "config provenance");
  assert.ok(!text.includes("RATE-LIMITED"), "no banner when not rate limited");
});

test("renderEvidence prepends the RATE-LIMITED banner when rateLimited", () => {
  const text = renderEvidence(syntheticBundle({ rateLimited: true }));
  assert.ok(text.startsWith("> ⚠ RATE-LIMITED — NOT FILED:"), text.slice(0, 120));
  assert.ok(text.includes("RATE-LIMITED — NOT FILED"));
  assert.ok(text.includes("fleet cap (3 open anomaly-filed workflows) is reached"));
  // The banner is additive: the evidence itself is unchanged.
  assert.ok(text.includes("## ⚠ Anomaly detected: agent_error_retry_rate (fleet) — Tier 3 (14.0σ)"));
});

test("renderEvidence says so when nothing is attributable", () => {
  const bundle = syntheticBundle();
  bundle.contributors = [];
  bundle.relatedIdentifiers.workflowIds = [];
  const text = renderEvidence(bundle);
  assert.ok(text.includes("(none attributable — no per-workflow contributor in the window)"));
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. buildStartPayload (§8.3)
// ═════════════════════════════════════════════════════════════════════════════

test("buildStartPayload is a bug-fix filing on the anomaly-detector channel", () => {
  const bundle = syntheticBundle();
  const payload = buildStartPayload(bundle, { repoUrl: ENV.repoUrl });

  assert.equal(payload.title, `[anomaly] agent_error_retry_rate 14.0σ over baseline (fleet) — ${CYCLE}`);
  assert.equal(payload.workflowDefId, "bug-fix");
  assert.equal(payload.workflowType, "bug");
  assert.equal(payload.intakeChannel, INTAKE_CHANNEL);
  assert.equal(payload.intakeChannel, "anomaly-detector");
  assert.deepEqual(payload.sources, []);
  assert.deepEqual(payload.repoConfig, {
    layout: "multi-repo",
    repos: [{ url: ENV.repoUrl, defaultBranch: "main" }],
  });

  // The description is the rendered markdown, then the exact bundle in a fence.
  assert.ok(payload.description.startsWith(renderEvidence(bundle)));
  const fence = payload.description.match(/```json\n([\s\S]+?)\n```/);
  assert.ok(fence, "description must contain a ```json fence");
  assert.deepEqual(JSON.parse(fence[1]), bundle);
});

test("buildStartPayload omits repos when no repo is configured", () => {
  const payload = buildStartPayload(syntheticBundle(), {});
  assert.deepEqual(payload.repoConfig, { layout: "multi-repo", repos: [] });
  assert.equal(payload.intakeChannel, "anomaly-detector");
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Rate-limit math (AC-6.1) — the off-by-one lives here
// ═════════════════════════════════════════════════════════════════════════════

test("openCountFrom counts only non-terminal, non-archived workflows", () => {
  const items = [
    { workflowId: "a", phase: "development" },
    { workflowId: "b", phase: "review" },
    { workflowId: "c", phase: "complete" }, // terminal
    { workflowId: "d", phase: "cancelled" }, // terminal
    { workflowId: "e", phase: "error" }, // terminal
    { workflowId: "f", phase: "development", archived: true }, // archived
    { workflowId: "g", phase: "complete", archived: true }, // both
    { workflowId: "h", phase: "requirements", archived: false },
  ];
  assert.equal(openCountFrom(items), 3); // a, b, h
  assert.equal(openCountFrom([]), 0);
  assert.equal(openCountFrom(null), 0);
  assert.equal(openCountFrom(undefined), 0);
  // A missing phase is NOT terminal — an in-flight row without a phase counts.
  assert.equal(openCountFrom([{ workflowId: "x" }]), 1);
});

test("allowedFilings is inclusive-capped: 3 open blocks, 2 open allows exactly one", () => {
  assert.equal(OPEN_WORKFLOW_CAP, 3);
  assert.equal(allowedFilings(0), 3);
  assert.equal(allowedFilings(1), 2);
  assert.equal(allowedFilings(2), 1); // ← 2 open ⇒ 1 allowed
  assert.equal(allowedFilings(3), 0); // ← exactly 3 open ⇒ blocked
  assert.equal(allowedFilings(4), 0); // never negative
  // What this cycle already filed counts against the cap too.
  assert.equal(allowedFilings(2, 1), 0);
  assert.equal(allowedFilings(0, 3), 0);
  assert.equal(allowedFilings(1, 1), 1);
});

test("the cap counts open workflows, not rows on the index", async () => {
  const openItems = [
    openWorkflow("wf_open_1"),
    openWorkflow("wf_open_2"),
    { workflowId: "wf_done", intakeChannel: INTAKE_CHANNEL, phase: "complete" },
    { workflowId: "wf_gone", intakeChannel: INTAKE_CHANNEL, phase: "development", archived: true },
  ];
  const { harness, bands } = scenario({ openItems });
  const { summary } = await runWatcher({ harness, bands });

  assert.deepEqual(summary.rateLimit, { openCount: 2, cap: 3, allowed: 1 });
  assert.equal(startPosts(harness).length, 1, "2 open ⇒ 1 filing allowed");
});

test("exactly three open workflows block the filing", async () => {
  const { harness, bands } = scenario({
    openItems: [openWorkflow("wf_o1"), openWorkflow("wf_o2"), openWorkflow("wf_o3")],
  });
  const { summary } = await runWatcher({ harness, bands });

  assert.deepEqual(summary.rateLimit, { openCount: 3, cap: 3, allowed: 0 });
  assert.equal(startPosts(harness).length, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Dedupe (AC-6.2 / AC-6.3)
// ═════════════════════════════════════════════════════════════════════════════

test("a second sequential cycle for the same window files nothing", async () => {
  const store = new Map();
  const metricId = "fleet_rate_a";
  const bands = bandsFixture(metricId);
  const rows = rowsFor(metricId, TIER3_EVAL);

  const first = makeHarness({ rows, store });
  const a = await runWatcher({ harness: first, bands, requestId: "req-a" });
  assert.equal(startPosts(first).length, 1);
  assert.equal(a.summary.actions.tier3Filed.length, 1);

  // Same scheduled time ⇒ same cycle key. The metric claim is checked BEFORE
  // the cycle claim (a suppressed group must not consume the fleet-wide cycle
  // claim), so the duplicate is attributed to the metric claim.
  const second = makeHarness({ rows, store });
  const b = await runWatcher({ harness: second, bands, requestId: "req-b" });
  assert.equal(startPosts(second).length, 0, "no second filing");
  assert.deepEqual(b.summary.actions.tier3Filed, []);
  assert.deepEqual(b.summary.actions.dedupeSuppressed, [
    { metricId, groupKey: "fleet", tier: 3, reason: "claim_held" },
  ]);
  assert.deepEqual(b.summary.actions.failures, []);

  assert.equal(startPosts(first).length + startPosts(second).length, 1, "exactly ONE filing");
});

test("a later cycle in the same suppression window is stopped by the metric claim", async () => {
  const store = new Map();
  const metricId = "fleet_rate_a";
  const bands = bandsFixture(metricId);
  const rows = rowsFor(metricId, TIER3_EVAL);

  const first = makeHarness({ rows, store });
  await runWatcher({ harness: first, bands, requestId: "req-a" });
  assert.equal(startPosts(first).length, 1);
  assert.ok(store.has(`claim#${metricId}#fleet\u0000t3`), "t3 claim is held");

  // Ten minutes later: a NEW cycle key (so the ratelimit claim is fresh) but the
  // same evaluation window and a live 6h tier-3 claim.
  const later = makeHarness({ rows, store });
  const b = await runWatcher({
    harness: later,
    bands,
    event: { time: "2026-08-27T14:37:31Z" },
    nowMs: Date.parse("2026-08-27T14:37:35Z"),
    requestId: "req-c",
  });

  assert.equal(cycleLabel(canonicalWindowStart("2026-08-27T14:37:31Z", 600_000)), "2026-08-27T14:30Z");
  assert.equal(startPosts(later).length, 0);
  assert.deepEqual(b.summary.actions.dedupeSuppressed, [
    { metricId, groupKey: "fleet", tier: 3, reason: "claim_held" },
  ]);
  assert.equal(startPosts(first).length + startPosts(later).length, 1, "exactly ONE filing");
});

test("two CONCURRENT invocations of the same cycle produce exactly one filing", async () => {
  const store = new Map();
  const metricId = "fleet_rate_a";
  const bands = bandsFixture(metricId);
  const rows = rowsFor(metricId, TIER3_EVAL);

  const h1 = makeHarness({ rows, store, responses: [okResponse({ workflowId: "wf_race_1" })] });
  const h2 = makeHarness({ rows, store, responses: [okResponse({ workflowId: "wf_race_2" })] });

  const [a, b] = await Promise.all([
    runWatcher({ harness: h1, bands, requestId: "req-1" }),
    runWatcher({ harness: h2, bands, requestId: "req-2" }),
  ]);

  const posts = startPosts(h1).length + startPosts(h2).length;
  assert.equal(posts, 1, "the conditional claim admits exactly one filer");

  const filed = [...a.summary.actions.tier3Filed, ...b.summary.actions.tier3Filed];
  assert.equal(filed.length, 1);
  const suppressed = [...a.summary.actions.dedupeSuppressed, ...b.summary.actions.dedupeSuppressed];
  assert.equal(suppressed.length, 1);
  assert.ok(
    ["ratelimit_cycle_claim_held", "claim_held"].includes(suppressed[0].reason),
    `unexpected suppression reason ${suppressed[0].reason}`
  );
  // Neither invocation recorded an error: losing a claim race is not a failure.
  assert.deepEqual([...a.summary.actions.failures, ...b.summary.actions.failures], []);
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Tier behaviour end to end (AC-4.2 / AC-4.3)
// ═════════════════════════════════════════════════════════════════════════════

test("Tier 2 diagnoses and notifies and NEVER posts to /api/workflow/start", async () => {
  const { harness, bands, metricId } = scenario({ evalBucket: TIER2_EVAL });
  const { summary } = await runWatcher({ harness, bands });

  const entry = summary.metrics.find((m) => m.metricId === metricId);
  assert.deepEqual(entry.verdicts, { ok: 0, tier1: 0, tier2: 1, tier3: 0, insufficient_sample: 0, disabled: 0 });
  assert.equal(summary.actions.tier2Escalations, 1);
  assert.deepEqual(summary.actions.tier3Filed, []);

  // AC-4.2: no filing at Tier 2, at all.
  assert.equal(harness.fetchCalls.length, 0);

  // Read-only diagnosis for the two worst offenders (diagnosis.maxTargets: 2).
  assert.equal(harness.invokes.length, 2);
  assert.deepEqual(
    harness.invokes.map((i) => i.payload.workflowId),
    ["wf_1", "wf_2"]
  );
  for (const invoke of harness.invokes) {
    assert.equal(invoke.FunctionName, ENV.analyzerFunction);
    assert.equal(invoke.InvocationType, "Event", "diagnosis must be fire-and-forget");
    assert.equal(invoke.payload.trigger, "manual");
  }
  assert.deepEqual(summary.actions.diagnosisInvoked, [
    { metricId, workflowId: "wf_1" },
    { metricId, workflowId: "wf_2" },
  ]);

  // Operator notification on the worst offender's workflow.
  assert.equal(harness.notifications.length, 1);
  const { workflowId, notification } = harness.notifications[0];
  assert.equal(workflowId, "wf_1");
  assert.equal(notification.id, `notif_aw_${CYCLE}_${metricId}`);
  assert.equal(notification.type, "anomaly_escalation");
  assert.equal(notification.title, `Anomaly watcher: ${metricId} ≥2σ`);
  assert.equal(notification.reviewer, "anomaly-watcher");
  assert.equal(notification.acknowledged, false);
  assert.ok(notification.details.includes("Tier 2 (2.5σ)"));
  assert.ok(notification.details.includes("diagnosis requested for wf_1, wf_2"));

  // Fleet records: one events row + one bus entry.
  assert.equal(harness.anomalyEvents.length, 1);
  const row = harness.anomalyEvents[0];
  assert.equal(row.workflowId, "anomaly-watcher");
  assert.equal(row.type, "anomaly.detected");
  assert.equal(row.detail.tier, 2);
  // 7/40 and 1/20 are not exact binaries, so σ is 2.5 to within a few ulps.
  assert.ok(Math.abs(row.detail.sigma - 2.5) < 1e-12, `σ ${row.detail.sigma}`);
  assert.ok(!("filedWorkflowId" in row), "nothing was filed at tier 2");
  assert.equal(harness.busEntries.length, 1);
  assert.equal(harness.busEntries[0].DetailType, "anomaly.detected");
  assert.equal(harness.busEntries[0].EventBusName, ENV.eventBus);
  assert.equal(JSON.parse(harness.busEntries[0].Detail).tier, 2);
});

test("Tier 3 posts exactly one filing with the evidence and the intake channel", async () => {
  const { harness, bands, metricId } = scenario({ responses: [okResponse({ workflowId: "wf_filed_9" })] });
  const { summary } = await runWatcher({ harness, bands });

  const entry = summary.metrics.find((m) => m.metricId === metricId);
  assert.equal(entry.verdicts.tier3, 1);
  assert.deepEqual(summary.rateLimit, { openCount: 0, cap: 3, allowed: 3 });

  const posts = startPosts(harness);
  assert.equal(posts.length, 1, "exactly one POST /api/workflow/start");
  assert.equal(posts[0].url, `${ENV.workflowApiUrl}/api/workflow/start`);
  assert.equal(posts[0].method, "POST");
  const body = posts[0].body;
  assert.equal(body.intakeChannel, "anomaly-detector");
  assert.equal(body.workflowDefId, "bug-fix");
  assert.equal(body.title, `[anomaly] ${metricId} 14.0σ over baseline (fleet) — ${CYCLE}`);
  assert.ok(body.description.includes("## ⚠ Anomaly detected"), "rendered evidence");
  assert.ok(body.description.includes("2026-08-27T13:00:00Z → 2026-08-27T14:00:00Z"), "absolute windows");
  assert.ok(body.description.includes("```json"), "machine-readable bundle");
  assert.equal(JSON.parse(body.description.match(/```json\n([\s\S]+?)\n```/)[1]).sigma, 14);
  assert.ok(!body.description.includes("RATE-LIMITED"));

  assert.deepEqual(summary.actions.tier3Filed, [
    { metricId, groupKey: "fleet", sigma: 14, workflowId: "wf_filed_9" },
  ]);
  assert.equal(summary.actions.tier2Escalations, 0, "tier 3 is not also a tier 2");
  assert.equal(harness.invokes.length, 0, "the bug workflow does the diagnosis now");
  assert.equal(harness.notifications.length, 0);

  // The claim records the filing, and the cycle claim records the workflow id.
  const claim = harness.store.get(`claim#${metricId}#fleet\u0000t3`);
  assert.equal(claim.tier, 3);
  assert.equal(claim.workflowId, "wf_filed_9");
  assert.equal(claim.windowStart, "2026-08-27T13:00:00Z");
  assert.equal(claim.windowEnd, "2026-08-27T14:00:00Z");
  assert.ok(harness.store.has(`${RATELIMIT_PK}\u0000${CYCLE}`));

  // The fleet record links the filed workflow.
  assert.equal(harness.anomalyEvents.length, 1);
  assert.equal(harness.anomalyEvents[0].filedWorkflowId, "wf_filed_9");
});

test("Tier 3 at the cap files nothing and pages an operator instead", async () => {
  const { harness, bands, metricId } = scenario({
    openItems: [openWorkflow("wf_o1"), openWorkflow("wf_o2"), openWorkflow("wf_o3")],
  });
  const { summary } = await runWatcher({ harness, bands });

  assert.equal(harness.fetchCalls.length, 0, "no filing when the cap is reached");
  assert.deepEqual(summary.actions.tier3Filed, []);
  assert.deepEqual(summary.actions.tier3RateLimited, [
    { metricId, groupKey: "fleet", sigma: 14, openCount: 3 },
  ]);
  // Degradation is never silent: a T2-style notification carries the banner.
  assert.equal(summary.actions.tier2Escalations, 1);
  assert.equal(harness.notifications.length, 1);
  const details = harness.notifications[0].notification.details;
  assert.ok(details.startsWith("> ⚠ RATE-LIMITED — NOT FILED:"), details.slice(0, 140));
  assert.ok(details.includes("Tier 3 (14.0σ)"), "the evidence still says Tier 3");
  assert.equal(harness.notifications[0].notification.title, `Anomaly watcher: ${metricId} ≥3σ`);
  assert.equal(harness.invokes.length, 2, "diagnosis still runs");
  assert.equal(harness.anomalyEvents.length, 1);
  assert.equal(harness.anomalyEvents[0].detail.rateLimited, true);
  // The t3 claim is still taken, so the next cycle does not re-page.
  assert.equal(harness.store.get(`claim#${metricId}#fleet\u0000t3`).rateLimited, true);
  assert.equal(harness.store.has(`${RATELIMIT_PK}\u0000${CYCLE}`), false, "no cycle claim was needed");
});

test("an unverifiable open count fails CLOSED", async () => {
  const { harness, bands } = scenario();
  const original = harness.clients.ddb.send.bind(harness.clients.ddb);
  harness.clients.ddb.send = async (cmd) => {
    if (cmd.__cmd === "Query" && cmd.IndexName === INTAKE_INDEX) throw new Error("index not found");
    return original(cmd);
  };
  const { summary } = await runWatcher({ harness, bands });

  assert.deepEqual(summary.rateLimit, { openCount: null, cap: 3, allowed: 0 });
  assert.equal(harness.fetchCalls.length, 0, "an unverifiable cap must not authorise a filing");
  assert.equal(harness.notifications.length, 1, "but the anomaly is still reported");
  assert.ok(harness.notifications[0].notification.details.includes("NOT FILED"));
  assert.ok(
    summary.actions.failures.some((f) => f.stage === "tier3Filing" && /index not found/.test(f.error)),
    JSON.stringify(summary.actions.failures)
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Fail-safe behaviour (§10.1)
// ═════════════════════════════════════════════════════════════════════════════

// TEAM-3334 F1: intake is not idempotent, so a 5xx (which may have landed AFTER
// the workflow was created) no longer releases the claim — it is kept, marked
// unverified, for a later cycle to verify against the intake index.
test("a 5xx from intake KEEPS the claim marked unverified and does not throw", async () => {
  const { harness, bands, metricId } = scenario({ responses: [errResponse(500, { error: "boom" })] });
  const { summary } = await runWatcher({ harness, bands });

  assert.equal(startPosts(harness).length, 1, "it did try");
  assert.deepEqual(summary.actions.tier3Filed, []);
  const failure = summary.actions.failures.find((f) => f.stage === "tier3Filing");
  assert.equal(failure.status, 500);
  assert.equal(failure.claim, "unverified");
  assert.equal(failure.metricId, metricId);

  // The claim survives, ownership-annotated as unverified — the ambiguous POST
  // may have filed, so releasing here could double-file next cycle.
  assert.equal(harness.calls.filter((c) => c.__cmd === "Delete").length, 0, "the claim must NOT be deleted");
  const claim = harness.store.get(`claim#${metricId}#fleet\u0000t3`);
  assert.ok(claim, "the claim survives an ambiguous outcome");
  assert.equal(claim.unverified, true);
  assert.equal(claim.unverifiedCycle, CYCLE);
  assert.equal(claim.unverifiedStatus, 500);

  // A transient failure is not an escalation — no duplicate operator page.
  assert.equal(summary.actions.tier2Escalations, 0);
  assert.equal(harness.notifications.length, 0);
});

test("a 4xx from intake KEEPS the claim and degrades to a marked notification", async () => {
  const { harness, bands, metricId } = scenario({ responses: [errResponse(400, { error: "bad payload" })] });
  const { summary } = await runWatcher({ harness, bands });

  assert.equal(startPosts(harness).length, 1);
  assert.deepEqual(summary.actions.tier3Filed, []);
  const failure = summary.actions.failures.find((f) => f.stage === "tier3Filing");
  assert.equal(failure.status, 400);
  assert.equal(failure.error, "bad payload");
  assert.ok(!("claim" in failure), "a 4xx must NOT release the claim");

  // Claim kept, and annotated with the terminal-failure marker.
  const claimKey = `claim#${metricId}#fleet\u0000t3`;
  assert.ok(harness.store.has(claimKey), "the claim survives a 4xx — a retry cannot help");
  assert.equal(harness.store.get(claimKey).failed, "4xx");
  assert.equal(harness.store.get(claimKey).failedStatus, 400);
  const annotate = harness.calls.find(
    (c) => c.__cmd === "Update" && c.TableName === ENV.stateTable && c.ExpressionAttributeValues?.[":failed"]
  );
  assert.equal(annotate.ExpressionAttributeValues[":failed"], "4xx");
  assert.equal(annotate.ConditionExpression, "claimToken = :mine");
  assert.equal(harness.calls.filter((c) => c.__cmd === "Delete").length, 0);

  // The operator is told, in the notification, that the filing failed.
  assert.equal(summary.actions.tier2Escalations, 1);
  assert.equal(harness.notifications.length, 1);
  const details = harness.notifications[0].notification.details;
  assert.ok(details.startsWith(filingFailedMarker(400)), details.slice(0, 200));
  // NB: the marker renders the numeric status ("HTTP 400"), not the class "4xx" —
  // "4xx" is what goes on the claim row. Both are asserted above.
  assert.ok(details.includes("FILING FAILED (HTTP 400)"));
  assert.ok(details.includes("Tier 3 (14.0σ)"));
});

test("a generic state-table claim error skips the action with no side effect", async () => {
  const { harness, bands, metricId } = scenario({ failPut: (pk) => pk.startsWith("claim#") });
  const { summary } = await runWatcher({ harness, bands });

  assert.deepEqual(summary.actions.failures, [
    { metricId, groupKey: "fleet", stage: "tier3Claim", error: "state put failed" },
  ]);
  assert.deepEqual(summary.actions.tier3Filed, []);
  assert.deepEqual(summary.actions.dedupeSuppressed, []);
  assert.equal(summary.actions.tier2Escalations, 0);
  // Nothing was attempted: an unavailable state table means "skip", not "act".
  assert.equal(harness.fetchCalls.length, 0);
  assert.equal(harness.invokes.length, 0);
  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.anomalyEvents.length, 0);
  assert.equal(harness.busEntries.length, 0);
});

test("one failing metric does not stop the next metric's evaluation", async () => {
  const bands = bandsFixture("fleet_rate_a", "fleet_rate_b");
  const harness = makeHarness({
    rows: { ...rowsFor("fleet_rate_a", TIER3_EVAL), ...rowsFor("fleet_rate_b", TIER3_EVAL) },
    failGet: (pk) => pk === "points#fleet_rate_a#fleet",
    responses: [okResponse({ workflowId: "wf_filed_b" })],
  });
  const { summary } = await runWatcher({ harness, bands });

  assert.deepEqual(
    summary.metrics.map((m) => m.metricId),
    ["fleet_rate_a", "fleet_rate_b"]
  );
  assert.deepEqual(summary.metrics[0].verdicts, {
    ok: 0,
    tier1: 0,
    tier2: 0,
    tier3: 0,
    insufficient_sample: 0,
    disabled: 0,
  });
  assert.deepEqual(summary.actions.failures, [
    { metricId: "fleet_rate_a", groupKey: "fleet", stage: "evaluate", error: "state get failed" },
  ]);
  // The second metric ran to completion, including its filing.
  assert.equal(summary.metrics[1].verdicts.tier3, 1);
  assert.deepEqual(summary.actions.tier3Filed, [
    { metricId: "fleet_rate_b", groupKey: "fleet", sigma: 14, workflowId: "wf_filed_b" },
  ]);
  assert.equal(startPosts(harness).length, 1);
});

test("a disabled metric is counted and never evaluated", async () => {
  const bands = bandsFixture("fleet_rate_a");
  bands.config.metrics[0].enabled = false;
  const harness = makeHarness({ rows: rowsFor("fleet_rate_a", TIER3_EVAL) });
  const { summary } = await runWatcher({ harness, bands });

  assert.equal(summary.metrics[0].verdicts.disabled, 1);
  assert.equal(summary.metrics[0].groups, 0);
  assert.equal(harness.fetchCalls.length, 0);
  assert.deepEqual(summary.actions.failures, []);
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Window canonicalization (§5)
// ═════════════════════════════════════════════════════════════════════════════

test("canonicalWindowStart floors to the cycle, never rounds", () => {
  const floor = (t) => canonicalWindowStart(t, 600_000);
  assert.equal(floor("2026-08-27T14:20:00Z"), "2026-08-27T14:20:00Z");
  assert.equal(floor("2026-08-27T14:27:31Z"), "2026-08-27T14:20:00Z");
  assert.equal(floor("2026-08-27T14:29:59.999Z"), "2026-08-27T14:20:00Z");
  assert.equal(floor("2026-08-27T14:30:00Z"), "2026-08-27T14:30:00Z");
  assert.equal(floor("2026-08-27T00:00:00Z"), "2026-08-27T00:00:00Z");
  assert.equal(floor("2026-08-26T23:59:59Z"), "2026-08-26T23:50:00Z");
  assert.equal(cycleLabel("2026-08-27T14:20:00Z"), "2026-08-27T14:20Z");
});

test("metricWindows snaps the evaluation window down to the hourly bucket", () => {
  const [metric] = bandsFixture("fleet_rate_a").config.metrics;
  const w = metricWindows(metric, "2026-08-27T14:20:00Z");
  assert.deepEqual(w, {
    baselineStart: "2026-08-20T14:00:00Z",
    baselineEnd: "2026-08-27T13:00:00Z",
    evalStart: "2026-08-27T13:00:00Z",
    evalEnd: "2026-08-27T14:00:00Z",
  });
  // Every 10-minute cycle inside one hour reports the same closed hour, so the
  // numbers in a bug report are exactly the span that was summed.
  for (const at of ["2026-08-27T14:00:00Z", "2026-08-27T14:10:00Z", "2026-08-27T14:50:00Z"]) {
    assert.deepEqual(metricWindows(metric, at), w);
  }
  assert.equal(metricWindows(metric, "2026-08-27T15:00:00Z").evalEnd, "2026-08-27T15:00:00Z");
});

test("resolveScheduledTime prefers the scheduled instant over the clock", () => {
  const fallback = Date.parse("2020-01-01T00:00:00Z");
  assert.equal(resolveScheduledTime({ time: "2026-08-27T14:20:00Z" }, fallback), Date.parse("2026-08-27T14:20:00Z"));
  assert.equal(
    resolveScheduledTime({ detail: { time: "2026-08-27T14:20:00Z" } }, fallback),
    Date.parse("2026-08-27T14:20:00Z")
  );
  assert.equal(resolveScheduledTime({ "scheduled-time": "2026-08-27T14:20:00Z" }, fallback), Date.parse("2026-08-27T14:20:00Z"));
  assert.equal(resolveScheduledTime({}, fallback), fallback);
  assert.equal(resolveScheduledTime({ time: "not a date" }, fallback), fallback);
  assert.equal(resolveScheduledTime(undefined, fallback), fallback);
});

test("two invocations of the same scheduled cycle agree on label and windows", async () => {
  const bands = bandsFixture("fleet_rate_a");
  const rows = rowsFor("fleet_rate_a", TIER3_EVAL);
  // Different wall clocks, different points inside the same 10-minute cycle.
  const a = makeHarness({ rows });
  const b = makeHarness({ rows });
  const ra = await runWatcher({
    harness: a,
    bands,
    event: { time: "2026-08-27T14:20:04Z" },
    nowMs: Date.parse("2026-08-27T14:20:09Z"),
    requestId: "req-x",
  });
  const rb = await runWatcher({
    harness: b,
    bands,
    event: { time: "2026-08-27T14:29:59Z" },
    nowMs: Date.parse("2026-08-27T14:30:02Z"),
    requestId: "req-y",
  });

  assert.equal(ra.summary.cycle, CYCLE);
  assert.equal(rb.summary.cycle, CYCLE);
  const wa = a.anomalyEvents[0].detail;
  const wb = b.anomalyEvents[0].detail;
  assert.deepEqual(wa.evaluation.window, { start: "2026-08-27T13:00:00Z", end: "2026-08-27T14:00:00Z" });
  assert.deepEqual(wb.evaluation.window, wa.evaluation.window);
  assert.deepEqual(wb.baseline.window, wa.baseline.window);
  assert.equal(wb.watcher.cycle, wa.watcher.cycle);
  // The claim keys they compute are identical — which is what makes the
  // conditional write a mutual exclusion rather than a coincidence.
  assert.deepEqual([...a.store.keys()].sort(), [...b.store.keys()].sort());
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. TEAM-3334 — ambiguous filings (F1), truncated counts (F2), GSI lag (F3)
// ═════════════════════════════════════════════════════════════════════════════

/** 14:37:31 → the cycle AFTER `CYCLE` (14:30Z), same evaluation window. */
const EVENT_NEXT = Object.freeze({ time: "2026-08-27T14:37:31Z" });
const NOW_NEXT_MS = Date.parse("2026-08-27T14:37:35Z");
const CYCLE_NEXT = "2026-08-27T14:30Z";

/** A post-send network death: ambiguous — the request MAY have been processed. */
function ambiguousNetworkError() {
  return Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
}

/** Record the POST in fetchCalls, then throw `err` (opts.responses cannot throw). */
function throwingFetch(harness, err, onBody) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    harness.fetchCalls.push({ url, method: init?.method, body });
    if (onBody) onBody(body);
    throw err;
  };
}

test("a lost response to a processed POST never double-files (F1)", async () => {
  const store = new Map();
  const metricId = "fleet_rate_a";
  const bands = bandsFixture(metricId);
  const rows = rowsFor(metricId, TIER3_EVAL);
  const openItems = []; // what intake actually recorded, GSI + base table

  // Cycle N: intake processes the filing, but the response never arrives.
  const first = makeHarness({ rows, store, openItems });
  first.clients.fetch = throwingFetch(first, ambiguousNetworkError(), (body) => {
    openItems.push({
      workflowId: "wf_ghost",
      intakeChannel: body.intakeChannel,
      phase: "development",
      startedAt: "2026-08-27T14:27:36Z",
      input: { title: body.title },
    });
  });
  const a = await runWatcher({ harness: first, bands, requestId: "req-a" });

  assert.equal(startPosts(first).length, 1, "the first cycle did POST");
  assert.deepEqual(a.summary.actions.tier3Filed, []);
  const claimKey = `claim#${metricId}#fleet\u0000t3`;
  assert.equal(store.get(claimKey).unverified, true, "ambiguous outcome keeps the claim, unverified");
  assert.equal(store.get(claimKey).unverifiedCycle, CYCLE);

  // Cycle N+1: same anomaly, and verification finds the ghost on the channel.
  const second = makeHarness({ rows, store, openItems });
  const b = await runWatcher({ harness: second, bands, event: EVENT_NEXT, nowMs: NOW_NEXT_MS, requestId: "req-b" });

  assert.equal(startPosts(second).length, 0, "NO second filing");
  assert.deepEqual(b.summary.actions.tier3Filed, []);
  assert.deepEqual(b.summary.actions.dedupeSuppressed, [
    { metricId, groupKey: "fleet", tier: 3, reason: "unverified_claim_verified_filed" },
  ]);
  assert.deepEqual(b.summary.actions.failures, []);
  // The GSI shows the ghost by now, so the cap counts it too (no F3 double count).
  assert.deepEqual(b.summary.rateLimit, { openCount: 1, cap: 3, allowed: 2 });
  // The claim now records the verified filing and stops being unverified.
  const claim = store.get(claimKey);
  assert.equal(claim.workflowId, "wf_ghost");
  assert.equal(claim.unverified, false);
  assert.equal(claim.claimToken, "req-a", "still the original owner's claim — never re-acquired");
  assert.equal(startPosts(first).length + startPosts(second).length, 1, "exactly ONE filing ever");
});

test("an unverified claim whose filing is verifiably absent is released and retried (F1)", async () => {
  const store = new Map();
  const metricId = "fleet_rate_a";
  const bands = bandsFixture(metricId);
  const rows = rowsFor(metricId, TIER3_EVAL);

  // Cycle N: the POST dies ambiguously and intake recorded NOTHING.
  const first = makeHarness({ rows, store });
  first.clients.fetch = throwingFetch(first, ambiguousNetworkError());
  const a = await runWatcher({ harness: first, bands, requestId: "req-a" });

  const claimKey = `claim#${metricId}#fleet\u0000t3`;
  assert.equal(store.get(claimKey).unverified, true);
  const failure = a.summary.actions.failures.find((f) => f.stage === "tier3Filing");
  assert.equal(failure.claim, "unverified");
  assert.equal(failure.status, null);
  assert.equal(first.calls.filter((c) => c.__cmd === "Delete").length, 0, "an ambiguous outcome never releases");

  // Cycle N+1: the intake channel provably has no matching filing → the stale
  // claim is released (owner-conditioned) and the retry files this cycle.
  const second = makeHarness({ rows, store, responses: [okResponse({ workflowId: "wf_retry_1" })] });
  const b = await runWatcher({ harness: second, bands, event: EVENT_NEXT, nowMs: NOW_NEXT_MS, requestId: "req-b" });

  assert.equal(startPosts(second).length, 1, "the retry files");
  assert.deepEqual(b.summary.actions.tier3Filed, [
    { metricId, groupKey: "fleet", sigma: 14, workflowId: "wf_retry_1" },
  ]);
  const del = second.calls.find((c) => c.__cmd === "Delete");
  assert.ok(del, "the stale claim was deleted before retrying");
  assert.deepEqual(del.Key, { pk: `claim#${metricId}#fleet`, sk: "t3" });
  assert.equal(del.ConditionExpression, "claimToken = :owner");
  assert.equal(del.ExpressionAttributeValues[":owner"], "req-a", "guarded by the ORIGINAL owner's token");
  const claim = store.get(claimKey);
  assert.equal(claim.claimToken, "req-b", "a fresh claim replaced the released one");
  assert.equal(claim.workflowId, "wf_retry_1");
  assert.ok(!claim.unverified, "no unverified marker on the fresh claim");
  // The retry's filing is on the new cycle's ratelimit filed list (F3 feed).
  assert.deepEqual(store.get(`${RATELIMIT_PK}\u0000${CYCLE_NEXT}`).filed, ["wf_retry_1"]);
});

test("an unverified claim stays put when verification itself fails (F1 fail-closed)", async () => {
  const store = new Map();
  const metricId = "fleet_rate_a";
  const bands = bandsFixture(metricId);
  const rows = rowsFor(metricId, TIER3_EVAL);

  const first = makeHarness({ rows, store });
  first.clients.fetch = throwingFetch(first, ambiguousNetworkError());
  await runWatcher({ harness: first, bands, requestId: "req-a" });
  const claimKey = `claim#${metricId}#fleet\u0000t3`;
  assert.equal(store.get(claimKey).unverified, true);

  // Cycle N+1: only the verification read (the :since-bounded index Query)
  // fails; the open-count query still works, so the ONLY blocker is F1.
  const second = makeHarness({ rows, store });
  const original = second.clients.ddb.send.bind(second.clients.ddb);
  second.clients.ddb.send = async (cmd) => {
    if (cmd.__cmd === "Query" && cmd.IndexName === INTAKE_INDEX && cmd.ExpressionAttributeValues?.[":since"]) {
      throw new Error("gsi unavailable");
    }
    return original(cmd);
  };
  const b = await runWatcher({ harness: second, bands, event: EVENT_NEXT, nowMs: NOW_NEXT_MS, requestId: "req-b" });

  assert.equal(startPosts(second).length, 0, "fail closed: never file past an unresolved claim");
  assert.deepEqual(b.summary.actions.tier3Filed, []);
  assert.ok(
    b.summary.actions.failures.some((f) => f.stage === "tier3VerifyUnverified" && /gsi unavailable/.test(f.error)),
    JSON.stringify(b.summary.actions.failures)
  );
  const claim = store.get(claimKey);
  assert.equal(claim.unverified, true, "the claim is untouched");
  assert.equal(claim.claimToken, "req-a");
  assert.equal(second.calls.filter((c) => c.__cmd === "Delete").length, 0, "nothing was released");
});

test("a pre-connection failure (ECONNREFUSED) still releases the claim for retry (F1)", async () => {
  const { harness, bands, metricId } = scenario({});
  harness.clients.fetch = throwingFetch(
    harness,
    Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })
  );
  const { summary } = await runWatcher({ harness, bands });

  assert.equal(startPosts(harness).length, 1, "it did try");
  assert.deepEqual(summary.actions.tier3Filed, []);
  const failure = summary.actions.failures.find((f) => f.stage === "tier3Filing");
  assert.equal(failure.claim, "released", "nothing reached intake — provably safe to retry");
  const del = harness.calls.find((c) => c.__cmd === "Delete");
  assert.ok(del, "the claim is deleted");
  assert.equal(del.ConditionExpression, "claimToken = :mine");
  assert.equal(harness.store.has(`claim#${metricId}#fleet\u0000t3`), false);
});

test("a truncated open-count query fails CLOSED and blocks the filing (F2)", async () => {
  const { harness, bands, metricId } = scenario({ openItems: [openWorkflow("wf_open_1")] });
  const original = harness.clients.ddb.send.bind(harness.clients.ddb);
  harness.clients.ddb.send = async (cmd) => {
    const res = await original(cmd);
    if (cmd.__cmd === "Query" && cmd.IndexName === INTAKE_INDEX) {
      // Every page still points onward: the page cap leaves a PARTIAL list.
      return { ...res, LastEvaluatedKey: { workflowId: "wf_more" } };
    }
    return res;
  };
  const { summary } = await runWatcher({ harness, bands });

  assert.deepEqual(summary.rateLimit, { openCount: null, cap: 3, allowed: 0 });
  assert.equal(harness.fetchCalls.length, 0, "a partial count must never authorise a filing");
  assert.ok(
    summary.actions.failures.some(
      (f) => f.stage === "tier3Filing" && f.metricId === metricId && /truncated after 20 pages/.test(f.error)
    ),
    JSON.stringify(summary.actions.failures)
  );
  // Degradation is not silent: the operator is paged with the blocked reason.
  assert.equal(harness.notifications.length, 1);
  assert.ok(harness.notifications[0].notification.details.includes("NOT FILED"));
});

test("a workflow filed last cycle but missing from the GSI still counts toward the cap (F3)", async () => {
  const store = new Map();
  const metricId = "fleet_rate_a";
  const bands = bandsFixture(metricId);
  // Cycle N-1 (14:10Z) filed wf_ghost_1, but the eventually-consistent GSI still
  // shows only the two older open filings.
  store.set(`${RATELIMIT_PK}\u00002026-08-27T14:10Z`, {
    pk: RATELIMIT_PK,
    sk: "2026-08-27T14:10Z",
    claimToken: "req-past",
    filed: ["wf_ghost_1"],
    expiresAt: Math.floor(NOW_MS / 1000) + 3600,
  });
  const harness = makeHarness({
    rows: rowsFor(metricId, TIER3_EVAL),
    store,
    openItems: [openWorkflow("wf_o1"), openWorkflow("wf_o2")],
  });
  const { summary } = await runWatcher({ harness, bands });

  assert.deepEqual(summary.rateLimit, { openCount: 3, cap: 3, allowed: 0 });
  assert.equal(startPosts(harness).length, 0, "the not-yet-indexed filing closes the cap");
  assert.deepEqual(summary.actions.tier3RateLimited, [
    { metricId, groupKey: "fleet", sigma: 14, openCount: 3 },
  ]);
});

test("a filed id already visible in the GSI is not double-counted (F3)", async () => {
  const store = new Map();
  const metricId = "fleet_rate_a";
  const bands = bandsFixture(metricId);
  store.set(`${RATELIMIT_PK}\u00002026-08-27T14:10Z`, {
    pk: RATELIMIT_PK,
    sk: "2026-08-27T14:10Z",
    claimToken: "req-past",
    filed: ["wf_ghost_1"],
    expiresAt: Math.floor(NOW_MS / 1000) + 3600,
  });
  // The GSI has caught up: wf_ghost_1 is indexed (open) alongside one other.
  const harness = makeHarness({
    rows: rowsFor(metricId, TIER3_EVAL),
    store,
    openItems: [openWorkflow("wf_ghost_1"), openWorkflow("wf_o1")],
  });
  const { summary } = await runWatcher({ harness, bands });

  assert.deepEqual(summary.rateLimit, { openCount: 2, cap: 3, allowed: 1 });
  assert.equal(startPosts(harness).length, 1, "2 open ⇒ still 1 filing allowed");
});

test("readEnv picks up ANOMALY_INTAKE_SECRET, empty when unset (TEAM-3335 F2)", () => {
  assert.equal(readEnv({ ANOMALY_INTAKE_SECRET: "s3cret" }).intakeSecret, "s3cret");
  assert.equal(readEnv({}).intakeSecret, "");
});

test("postStart sends x-intake-internal-secret when the secret is set (TEAM-3335 F2)", async () => {
  const { harness, bands } = scenario({ responses: [okResponse()] });
  await runWatcher({ harness, bands, env: { ...ENV, intakeSecret: "s3cret" } });

  const posts = startPosts(harness);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].headers["x-intake-internal-secret"], "s3cret");
});

test("postStart OMITS the x-intake-internal-secret header entirely when the secret is empty (TEAM-3335 F2)", async () => {
  const { harness, bands } = scenario({ responses: [okResponse()] });
  // ENV carries no intakeSecret — an empty header would read as a (wrong) proof.
  await runWatcher({ harness, bands });

  const posts = startPosts(harness);
  assert.equal(posts.length, 1);
  assert.ok(!("x-intake-internal-secret" in posts[0].headers), "no empty header sent");
});

// ═════════════════════════════════════════════════════════════════════════════
// TEAM-3966 F6 — review.parked_advisory (TEAM-3790: a human-origin advisory-only
// rejection the orchestrator parks instead of auto-approving) is part of the
// verified vocabulary, so a bands metric may count it without a validation error.
// ═════════════════════════════════════════════════════════════════════════════

test("TEAM-3966 F6: review.parked_advisory is a verified event type and validates as a numerator", () => {
  assert.ok(VERIFIED_EVENT_TYPES.includes("review.parked_advisory"));
  assert.ok(VERIFIED_EVENT_TYPES.includes("review.rejected"), "sibling change-request type still present");

  const text =
    `version: 1\nmetrics:\n` +
    rateMetricYaml("change_request_rate").replace(
      "numeratorTypes: [agent.error, agent.retry]",
      "numeratorTypes: [review.rejected, review.parked_advisory]"
    );
  const res = validateBands(yaml.load(text));
  assert.ok(res.ok, `expected valid, got: ${(res.errors || []).join(" | ")}`);
  assert.deepEqual(res.config.metrics[0].source.numeratorTypes, ["review.rejected", "review.parked_advisory"]);
});

// ═════════════════════════════════════════════════════════════════════════════
// TEAM-4120 FR-2 — the ingest cursor vs. the NEW deterministic eventId format.
//
// event-id.mjs mints ids as `<13-digit decimal ms>-<8 hex>` precisely so they
// stay in the same lexicographic ordering class as the pre-4120 direct-write ids
// (`${Date.now()}-${random}`), which readEvents' `eventId > :cursor`
// KeyConditionExpression compares as STRINGS. These tests document that the new
// format cursors correctly — and re-document the pre-existing blind spot the
// deterministic format does NOT fix: the events-writer's base36 ids
// (`<ms base36 padStart 9>-<counter>`) start with a letter for every plausible
// timestamp, so they sort AFTER any decimal id and a decimal cursor never
// advances past them. dropStaleItems (§4.4) is the guard that keeps that
// mismatch from folding a stale row into a bucket days in the past.
// Pure helpers only — no AWS wiring is touched.
// ═════════════════════════════════════════════════════════════════════════════

const DECIMAL_CURSOR_ID = "1757040000000-ab12";        // legacy direct-write id
const DECIMAL_CURSOR_TS = "2026-09-05T12:00:00.000Z";  // in-window
const DETERMINISTIC_ID = "1757040000500-1a2b3c4d";     // TEAM-4120 id, 500ms later

test("TEAM-4120: a deterministic eventId sorts AFTER a legacy decimal cursor (same 13-digit prefix class)", () => {
  // What readEvents' `eventId > :c` evaluates to inside DynamoDB.
  assert.ok(DETERMINISTIC_ID > DECIMAL_CURSOR_ID, "new id is strictly greater as a string");
  // Same prefix width is what makes string compare == time order.
  assert.equal(DECIMAL_CURSOR_ID.split("-")[0].length, 13);
  assert.equal(DETERMINISTIC_ID.split("-")[0].length, 13);
  assert.ok(Number(DETERMINISTIC_ID.split("-")[0]) > Number(DECIMAL_CURSOR_ID.split("-")[0]));
});

test("TEAM-4120: dropStaleItems KEEPS a deterministic-id item whose timestamp is inside the tolerance", () => {
  const cursor = { lastEventId: DECIMAL_CURSOR_ID, lastTimestamp: DECIMAL_CURSOR_TS };
  const item = { eventId: DETERMINISTIC_ID, timestamp: "2026-09-05T12:00:00.500Z", type: "agent.complete" };
  assert.deepEqual(dropStaleItems([item], cursor), [item]);

  // Boundary: exactly at the floor is kept, one ms before it is dropped.
  const floorMs = epochMsOf(DECIMAL_CURSOR_TS) - LATE_EVENT_TOLERANCE_MS;
  const atFloor = { eventId: "1757040000001-deadbeef", timestamp: new Date(floorMs).toISOString() };
  const belowFloor = { eventId: "1757040000002-deadbeef", timestamp: new Date(floorMs - 1).toISOString() };
  assert.deepEqual(dropStaleItems([atFloor, belowFloor], cursor), [atFloor]);
});

test("TEAM-4120: a base36 events-writer id sorts BEFORE any decimal cursor — the pre-existing blind spot", () => {
  const base36 = "0lq7k2x00-0001";
  // Digits sort before letters, but this id is zero-padded to 9 chars, so it is
  // "0lq…" vs "175…": '0' < '1', hence it can NEVER exceed a decimal cursor.
  assert.ok(base36 < DECIMAL_CURSOR_ID, "base36 id is below the decimal cursor as a string");
  // Un-padded (>= 1985 in base36 ms) it starts with a letter and would sort
  // AFTER instead — the two formats are simply not mutually ordered, which is
  // §4.4's whole premise and why dropStaleItems exists.
  assert.ok("lq7k2x00-0001" > DECIMAL_CURSOR_ID);
  // dropStaleItems is what keeps such a row from being folded days in the past.
  const stale = { eventId: base36, timestamp: "2026-08-01T00:00:00.000Z" };
  const cursor = { lastEventId: DECIMAL_CURSOR_ID, lastTimestamp: DECIMAL_CURSOR_TS };
  assert.deepEqual(dropStaleItems([stale], cursor), [], "far-behind format artefact is ignored");
  // Under EVENT_DEDUPE_MODE=enforce the events-writer stops minting base36 ids
  // for non-streaming events, so this class of row simply stops appearing.
});
