/**
 * lambda/prd-submitter/index.test.mjs
 *
 * The submission gate, driven end to end with fakes. si-ledger.test.mjs proves the
 * reducers; this suite proves the LAMBDA uses them — that a PRD which cannot be
 * judged never becomes a run, that a pattern already in flight is not answered a
 * second time, and that a run which IS started always carries `si` and always
 * leaves the ledger pointing at it.
 *
 * Hermetic and offline: `run()` takes its three collaborators as arguments
 * (`s3`, `ledger`, `fetchImpl`), so there is no module mocking — which matters on
 * Node 20, where `mock.module` does not exist. The ledger fake is the REAL
 * SiLedger over an in-memory table, so every status here is produced by the same
 * reducers the Lambda will run in prod; only the transport is fake.
 *
 * The regressions these lock:
 *   - a system PRD with no `si.expected[]` must not start a run (an unfalsifiable
 *     ask is how the old loop re-filed the same PRD for weeks);
 *   - a key another run is already carrying must be refused with the LEDGER's
 *     sentence, not a paraphrase;
 *   - a ledger write that fails AFTER the run started must not throw, because a
 *     rejected invocation makes EventBridge redeliver and start a second run for
 *     the same fix;
 *   - the fleet improver's own PRDs (no `si`) must keep working untouched.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

process.env.ARTIFACT_BUCKET = "test-bucket";
process.env.WORKFLOW_API_URL = "https://workflow.test";
process.env.FLEET_REPO_URL = "https://github.com/test/fleet";
process.env.SI_LEDGER_TABLE = "test-si-ledger";
process.env.AWS_REGION = "us-east-1";

const mod = await import("./index.mjs");
const ledgerMod = await import("./si-ledger.mjs");

const { run, prdKeyFor, collectKeys, validateSi, gate, expectedFor, snapshotKey, buildPayload, isSystemPrd } = mod;
const { SiLedger, newRow, applyOccurrence, applyAttempt, dedupeBlocked } = ledgerMod;

const HUB = "https://github.com/test/hub";
const KEY_A = "harness.silent-death.exit-without-report";
const KEY_B = "ops.paging.out-of-hours";

// ── fakes ────────────────────────────────────────────────────────────────────

/** An in-memory DynamoDB the real SiLedger can drive (Get/Put/Scan by name). */
function fakeDdb(rows = []) {
  const items = new Map(rows.map((r) => [r.patternKey, r]));
  return {
    items,
    failPuts: false,
    async send(cmd) {
      const name = cmd.constructor.name;
      if (name === "GetCommand") return { Item: items.get(cmd.input.Key.patternKey) };
      if (name === "PutCommand") {
        if (this.failPuts) throw new Error("ProvisionedThroughputExceededException");
        items.set(cmd.input.Item.patternKey, cmd.input.Item);
        return {};
      }
      if (name === "ScanCommand") return { Items: [...items.values()] };
      throw new Error(`fakeDdb: unexpected ${name}`);
    },
  };
}

function fakeS3(prd) {
  return {
    puts: [],
    async send(cmd) {
      const name = cmd.constructor.name;
      if (name === "GetObjectCommand") {
        // Nothing has ever been held in this fake's bucket.
        if (cmd.input.Key.startsWith("prd-submitter/")) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
        return { Body: { transformToString: async () => JSON.stringify(prd) } };
      }
      if (name === "PutObjectCommand") {
        this.puts.push({ Key: cmd.input.Key, body: JSON.parse(cmd.input.Body) });
        return {};
      }
      throw new Error(`fakeS3: unexpected ${name}`);
    },
  };
}

// The three 2xx bodies src/app/api/workflow/start/route.ts actually returns.
// Fresh start: StartSuccess (route.ts:679-684), returned at :834 (jira) / :1018.
const START_FRESH = { workflowId: "wf-1", epicId: "TEAM-9001", materialized: ["TEAM-9002"], deferred: [] };
// Coalesced onto the run that owns the sourceTicket — no epicId (:612, :755, :952).
const START_COALESCED = { workflowId: "wf-1", deduplicated: true };
// Sweep-preflight skip — 200, no run at all (:649, shape from recordSweepSkip :254).
const START_SWEEP_SKIP = { skipped: true, reason: "nothing to sweep", prs: [], mainSha: null };

function fakeFetch({ ok = true, status = 200, body = START_FRESH, throws } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, payload: JSON.parse(init.body) });
    if (throws) throw throws;
    return {
      ok,
      status,
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  };
  fn.calls = calls;
  return fn;
}

/** A ledger row that exists because some analysis saw the pattern. */
function seen(patternKey, { at = "2026-09-01T00:00:00.000Z", title = "silent death" } = {}) {
  return applyOccurrence(newRow({ patternKey, title, at }), {
    workflowId: "wf-old",
    analysisId: "an-old",
    workflowDefId: "software-delivery",
    severity: "P1",
    at,
  });
}

function systemPrd(overrides = {}) {
  return {
    title: "system: stop losing sessions",
    description: "## Deliverables\n1. do the thing\n\n## Expected improvements\n| … |",
    repoUrl: HUB,
    sources: [{ type: "s3", value: "s3://test-bucket/analyses/a.json", label: "analysis a" }],
    batch: { analysisIds: ["wf-old/an-old"], generatedAt: "2026-09-18T00:00:00.000Z" },
    si: {
      patternKeys: [KEY_A],
      expected: [{
        patternKey: KEY_A,
        metric: "dead_sessions_per_run",
        baseline: { value: 2.4, runs: 5, window: { defIds: ["software-delivery"], since: "2026-08-01T00:00:00.000Z" } },
        target: 0,
        observeRuns: 5,
      }],
    },
    ...overrides,
  };
}

const EVENT = { detail: { object: { key: "fleet-imp-agent/prd/system-20260918T120000.json" } } };

/** Swallow the handler's logs, but keep them for assertions. */
function captureLogs(fn) {
  const errors = [];
  const logs = [];
  const realError = console.error;
  const realLog = console.log;
  const realWarn = console.warn;
  console.error = (...a) => errors.push(a.join(" "));
  console.log = (...a) => logs.push(a.join(" "));
  console.warn = (...a) => errors.push(a.join(" "));
  const restore = () => {
    console.error = realError;
    console.log = realLog;
    console.warn = realWarn;
  };
  return Promise.resolve()
    .then(fn)
    .then((value) => { restore(); return { value, errors, logs }; })
    .catch((e) => { restore(); throw e; });
}

/** One submission: returns the result plus every fake for assertions. */
async function submit(prd, { rows = [], fetchOpts, event = EVENT } = {}) {
  const ddb = fakeDdb(rows);
  const s3 = fakeS3(prd);
  const ledger = new SiLedger({ ddb, table: "test-si-ledger" });
  const fetchImpl = fakeFetch(fetchOpts);
  const { value, errors, logs } = await captureLogs(() => run(event, { s3, ledger, fetchImpl }));
  return { result: value, ddb, s3, fetchImpl, errors, logs };
}

// ── pure helpers ─────────────────────────────────────────────────────────────

describe("prdKeyFor", () => {
  it("is the object's basename, so a row's history points back at the PRD document", () => {
    assert.equal(prdKeyFor("fleet-imp-agent/prd/system-20260918T120000.json"), "system-20260918T120000");
  });

  it("is stable across re-reads of the same object", () => {
    const k = "fleet-imp-agent/prd/system-1.json";
    assert.equal(prdKeyFor(k), prdKeyFor(k));
  });

  it("never returns empty", () => {
    assert.equal(prdKeyFor(""), "unknown-prd");
    assert.equal(prdKeyFor(undefined), "unknown-prd");
  });
});

describe("isSystemPrd", () => {
  it("is true for an si-synthesis PRD (si block or analysis batch)", () => {
    assert.equal(isSystemPrd({ si: { patternKeys: [] } }), true);
    assert.equal(isSystemPrd({ batch: { analysisIds: ["a/b"] } }), true);
  });

  it("is false for the fleet improver's agent PRD, which must keep working", () => {
    assert.equal(isSystemPrd({ title: "t", description: "d" }), false);
    assert.equal(isSystemPrd({ batch: { evalIds: ["x"] } }), false);
  });
});

describe("collectKeys", () => {
  it("unions patternKeys with expected[].patternKey and dedupes", () => {
    const keys = collectKeys({ si: { patternKeys: [KEY_A], expected: [{ patternKey: KEY_A }, { patternKey: KEY_B }] } });
    assert.deepEqual(keys, [KEY_A, KEY_B]);
  });

  it("normalises a prose-cased key so it hits the same row", () => {
    assert.deepEqual(collectKeys({ si: { patternKeys: ["Harness.Silent-Death.Exit-Without-Report"] } }), [KEY_A]);
  });

  it("drops anything that is not a pattern key rather than minting a junk row", () => {
    assert.deepEqual(collectKeys({ si: { patternKeys: ["not a key", "", null, 7, "no-dot"] } }), []);
  });
});

describe("validateSi", () => {
  it("accepts a complete si block", () => {
    assert.equal(validateSi(systemPrd()).ok, true);
  });

  it("rejects a missing si block", () => {
    const v = validateSi({ batch: { analysisIds: ["a/b"] } });
    assert.equal(v.ok, false);
    assert.match(v.reason, /no `si` block/);
  });

  it("rejects an empty expected[] and says why it is not bureaucracy", () => {
    const v = validateSi(systemPrd({ si: { patternKeys: [KEY_A], expected: [] } }));
    assert.equal(v.ok, false);
    assert.match(v.reason, /cannot be verified after it ships/);
  });

  it("rejects an unmeasurable metric and lists the ones that exist", () => {
    const v = validateSi(systemPrd({ si: { patternKeys: [KEY_A], expected: [{ patternKey: KEY_A, metric: "vibes" }] } }));
    assert.equal(v.ok, false);
    assert.match(v.reason, /"vibes" is not measurable/);
    assert.match(v.reason, /dead_sessions_per_run/);
  });

  it("rejects a malformed patternKey inside expected[]", () => {
    const v = validateSi(systemPrd({
      si: { patternKeys: [KEY_A], expected: [{ patternKey: "Not A Key", metric: "dead_sessions_per_run" }] },
    }));
    assert.equal(v.ok, false);
    assert.match(v.reason, /is not a <area>\.<slug> pattern key/);
  });

  it("rejects an si block whose keys are all junk — nothing to track against", () => {
    const v = validateSi({ si: { patternKeys: ["junk"], expected: [{ patternKey: "junk", metric: "dead_sessions_per_run" }] } });
    assert.equal(v.ok, false);
  });
});

describe("expectedFor", () => {
  it("stores exactly what applyExpected would, so payload and row agree", () => {
    const prd = systemPrd();
    const entries = expectedFor(KEY_A, prd, "prd-1", "2026-09-18T12:00:00.000Z");
    assert.deepEqual(entries, [{
      metric: "dead_sessions_per_run",
      baseline: { value: 2.4, runs: 5, window: { defIds: ["software-delivery"], since: "2026-08-01T00:00:00.000Z" } },
      target: 0,
      observeRuns: 5,
      setAt: "2026-09-18T12:00:00.000Z",
      prdKey: "prd-1",
    }]);
  });

  it("defaults observeRuns to 5 and an unmeasured baseline to null, never to 0", () => {
    const prd = systemPrd({ si: { patternKeys: [KEY_A], expected: [{ patternKey: KEY_A, metric: "rewakes_per_run" }] } });
    const [entry] = expectedFor(KEY_A, prd, "prd-1", "2026-09-18T12:00:00.000Z");
    assert.equal(entry.observeRuns, 5);
    assert.equal(entry.baseline, null);
    assert.equal(entry.target, null);
  });

  it("returns only this pattern's promises", () => {
    const prd = systemPrd({
      si: {
        patternKeys: [KEY_A, KEY_B],
        expected: [
          { patternKey: KEY_A, metric: "dead_sessions_per_run" },
          { patternKey: KEY_B, metric: "human_wait_out_of_hours_ms" },
        ],
      },
    });
    assert.deepEqual(expectedFor(KEY_B, prd, "p", "2026-09-18T12:00:00.000Z").map((e) => e.metric), ["human_wait_out_of_hours_ms"]);
  });
});

describe("gate", () => {
  const now = "2026-09-18T12:00:00.000Z";

  it("clears a key whose row is open", () => {
    assert.deepEqual(gate([KEY_A], { [KEY_A]: seen(KEY_A) }, now), []);
  });

  it("blocks a key with no row — an invented key would be silently untracked", () => {
    const [blocked] = gate([KEY_A], {}, now);
    assert.equal(blocked.patternKey, KEY_A);
    assert.match(blocked.reason, /has no ledger row/);
  });

  it("uses the ledger's own sentence for an in-run key, verbatim", () => {
    const row = applyAttempt(seen(KEY_A), { prdKey: "prd-0", workflowId: "wf-0", outcome: "in-run" });
    const [blocked] = gate([KEY_A], { [KEY_A]: row }, now);
    assert.equal(blocked.reason, dedupeBlocked(row, { now }).reason);
  });
});

describe("snapshotKey", () => {
  it("is namespaced per PRD, so a second attempt does not overwrite the first's evidence", () => {
    assert.equal(snapshotKey("prd-1", KEY_A), `si-ledger/prd-1/${KEY_A}.json`);
    assert.notEqual(snapshotKey("prd-1", KEY_A), snapshotKey("prd-2", KEY_A));
  });
});

describe("buildPayload", () => {
  it("omits si entirely when there are no keys, leaving the fleet PRD shape untouched", () => {
    const payload = buildPayload({ prd: { title: "t", description: "d" }, repoUrl: HUB, prdKey: "p", keys: [], expected: [], sources: [] });
    assert.equal("si" in payload, false);
    assert.equal(payload.title, "[SI] t");
  });

  it("puts si in the BODY, which is what /api/workflow/start persists as input.si", () => {
    const payload = buildPayload({
      prd: { title: "t", description: "d" }, repoUrl: HUB, prdKey: "p",
      keys: [KEY_A], expected: [{ metric: "dead_sessions_per_run" }], sources: [],
    });
    assert.deepEqual(payload.si, { prdKey: "p", patternKeys: [KEY_A], expected: [{ metric: "dead_sessions_per_run" }] });
  });

  it("starts a system PRD on the operator def and leaves an agent PRD on the default", () => {
    const base = { prd: { title: "t", description: "d" }, repoUrl: HUB, prdKey: "p", keys: [], expected: [], sources: [] };
    assert.equal(buildPayload({ ...base, system: true }).workflowDefId, "operator");
    assert.equal("workflowDefId" in buildPayload(base), false);
  });
});

// ── the handler ──────────────────────────────────────────────────────────────

describe("run: what is not submitted", () => {
  it("skips a non-json object", async () => {
    const { result, fetchImpl } = await submit(systemPrd(), { event: { key: "fleet-imp-agent/prd/README.md" } });
    assert.equal(result.body, "Skipped");
    assert.equal(fetchImpl.calls.length, 0);
  });

  it("rejects an object that is not a synthesized PRD, without retrying forever", async () => {
    const { result, fetchImpl } = await submit({ evalIds: ["x"] });
    assert.equal(result.statusCode, 200);
    assert.match(result.body, /not a synthesized PRD/);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it("rejects a system PRD with no si.expected[] — no run, no ledger write, 200", async () => {
    const prd = systemPrd({ si: { patternKeys: [KEY_A] } });
    const { result, fetchImpl, ddb, errors } = await submit(prd, { rows: [seen(KEY_A)] });
    assert.equal(result.statusCode, 200);
    assert.match(result.body, /Rejected:/);
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(ddb.items.get(KEY_A).status, "open");
    assert.equal(ddb.items.get(KEY_A).attempts.length, 0);
    assert.ok(errors.some((e) => /si\.expected\[\]` is empty/.test(e)), errors.join("\n"));
  });

  it("rejects a PRD whose batch has no si block at all", async () => {
    const prd = systemPrd();
    delete prd.si;
    const { result, fetchImpl } = await submit(prd);
    assert.match(result.body, /Rejected:/);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it("rejects an in-run key with the ledger's reason, verbatim, and starts nothing", async () => {
    const row = applyAttempt(seen(KEY_A), { prdKey: "prd-0", workflowId: "wf-0", epicId: "TEAM-1", outcome: "in-run" });
    const { result, fetchImpl, ddb, errors } = await submit(systemPrd(), { rows: [row] });
    assert.equal(result.statusCode, 200);
    assert.match(result.body, /already being answered/);
    assert.match(result.body, new RegExp(KEY_A));
    assert.equal(fetchImpl.calls.length, 0);
    const expectedReason = dedupeBlocked(ddb.items.get(KEY_A), { now: new Date().toISOString() }).reason;
    assert.ok(errors.some((e) => e.includes(expectedReason)), `wanted the ledger sentence\n${expectedReason}\ngot\n${errors.join("\n")}`);
    // The other run's attempt is untouched.
    assert.deepEqual(ddb.items.get(KEY_A).attempts.map((a) => a.workflowId), ["wf-0"]);
  });

  it("rejects a key that shipped inside the freshness window and has no verdict yet", async () => {
    const shipped = applyAttempt(seen(KEY_A), {
      prdKey: "prd-0", workflowId: "wf-0", outcome: "deployed",
      deployedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    });
    const { result, fetchImpl } = await submit(systemPrd(), { rows: [shipped] });
    assert.match(result.body, /already being answered/);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it("rejects a key with no ledger row — it was invented at synthesis time", async () => {
    const { result, fetchImpl, errors } = await submit(systemPrd(), { rows: [] });
    assert.match(result.body, /already being answered/);
    assert.equal(fetchImpl.calls.length, 0);
    assert.ok(errors.some((e) => /has no ledger row/.test(e)));
  });

  it("rejects the WHOLE PRD when only one of its keys is blocked", async () => {
    const blocked = applyAttempt(seen(KEY_B, { title: "paging" }), { prdKey: "prd-0", workflowId: "wf-0", outcome: "in-run" });
    const prd = systemPrd({
      si: {
        patternKeys: [KEY_A, KEY_B],
        expected: [
          { patternKey: KEY_A, metric: "dead_sessions_per_run", target: 0 },
          { patternKey: KEY_B, metric: "human_wait_out_of_hours_ms", target: 0 },
        ],
      },
    });
    const { result, fetchImpl, ddb } = await submit(prd, { rows: [seen(KEY_A), blocked] });
    assert.match(result.body, /1 pattern\(s\)/);
    assert.equal(fetchImpl.calls.length, 0);
    // and the clear key was NOT half-filed
    assert.equal(ddb.items.get(KEY_A).status, "open");
    assert.equal(ddb.items.get(KEY_A).expected.length, 0);
  });
});

describe("run: an accepted system PRD", () => {
  let submitted;

  before(async () => {
    submitted = await submit(systemPrd(), { rows: [seen(KEY_A)] });
  });

  it("starts exactly one run, against the hub repo the PRD named", () => {
    assert.equal(submitted.fetchImpl.calls.length, 1);
    const { url, payload } = submitted.fetchImpl.calls[0];
    assert.equal(url, "https://workflow.test/api/workflow/start");
    assert.equal(payload.repoConfig.repos[0].url, HUB);
    assert.equal(payload.title, "[SI] system: stop losing sessions");
  });

  it("carries si:{prdKey, patternKeys, expected} in the payload body", () => {
    const { payload } = submitted.fetchImpl.calls[0];
    assert.equal(payload.si.prdKey, "system-20260918T120000");
    assert.deepEqual(payload.si.patternKeys, [KEY_A]);
    assert.equal(payload.si.expected.length, 1);
    assert.equal(payload.si.expected[0].metric, "dead_sessions_per_run");
    assert.equal(payload.si.expected[0].baseline.value, 2.4);
    assert.equal(payload.si.expected[0].observeRuns, 5);
  });

  it("snapshots the row as it looked BEFORE the fix and hands it over as an s3 source", () => {
    const snapshot = submitted.s3.puts.find((p) => p.Key === snapshotKey("system-20260918T120000", KEY_A));
    assert.ok(snapshot, `no snapshot in ${submitted.s3.puts.map((p) => p.Key).join(", ")}`);
    assert.equal(snapshot.body.prdKey, "system-20260918T120000");
    assert.equal(snapshot.body.row.patternKey, KEY_A);
    assert.equal(snapshot.body.row.status, "open", "the snapshot is pre-submission: not yet in-run");
    assert.equal(snapshot.body.row.occurrences.length, 1);

    const { payload } = submitted.fetchImpl.calls[0];
    assert.deepEqual(payload.sources, [
      { type: "s3", value: "s3://test-bucket/analyses/a.json", label: "analysis a" },
      { type: "s3", value: `s3://test-bucket/${snapshotKey("system-20260918T120000", KEY_A)}`, label: `si-ledger ${KEY_A}` },
    ]);
  });

  it("flips the row to in-run with the run and epic that carry it", () => {
    const row = submitted.ddb.items.get(KEY_A);
    assert.equal(row.status, "in-run");
    assert.equal(row.attempts.length, 1);
    assert.deepEqual(
      { prdKey: row.attempts[0].prdKey, workflowId: row.attempts[0].workflowId, epicId: row.attempts[0].epicId, outcome: row.attempts[0].outcome },
      { prdKey: "system-20260918T120000", workflowId: "wf-1", epicId: "TEAM-9001", outcome: "in-run" },
    );
  });

  it("records the promise on the row, so si_verify can judge it later", () => {
    const row = submitted.ddb.items.get(KEY_A);
    assert.equal(row.expected.length, 1);
    assert.equal(row.expected[0].metric, "dead_sessions_per_run");
    assert.equal(row.expected[0].target, 0);
    assert.equal(row.expected[0].prdKey, "system-20260918T120000");
  });

  it("returns the run and the keys it stamped", () => {
    const body = JSON.parse(submitted.result.body);
    assert.deepEqual(body, {
      workflowId: "wf-1", epicId: "TEAM-9001",
      prdKey: "system-20260918T120000", patternKeys: [KEY_A],
    });
  });

  it("does not overwrite the occurrence history it snapshotted", () => {
    assert.equal(submitted.ddb.items.get(KEY_A).occurrences.length, 1);
    assert.equal(submitted.ddb.items.get(KEY_A).firstSeen, "2026-09-01T00:00:00.000Z");
  });
});

describe("run: multi-pattern PRD", () => {
  it("marks every key in-run against the one run", async () => {
    const prd = systemPrd({
      si: {
        patternKeys: [KEY_A, KEY_B],
        expected: [
          { patternKey: KEY_A, metric: "dead_sessions_per_run", target: 0 },
          { patternKey: KEY_B, metric: "human_wait_out_of_hours_ms", target: 3600000 },
        ],
      },
    });
    const { ddb, s3, fetchImpl } = await submit(prd, { rows: [seen(KEY_A), seen(KEY_B, { title: "paging" })] });
    for (const key of [KEY_A, KEY_B]) {
      const row = ddb.items.get(key);
      assert.equal(row.status, "in-run", key);
      assert.equal(row.attempts[0].workflowId, "wf-1", key);
      assert.equal(row.expected.length, 1, key);
    }
    assert.equal(s3.puts.length, 2);
    assert.equal(fetchImpl.calls[0].payload.si.expected.length, 2);
  });

  it("keeps two metrics for one pattern — both must hold before it is verified", async () => {
    const prd = systemPrd({
      si: {
        patternKeys: [KEY_A],
        expected: [
          { patternKey: KEY_A, metric: "dead_sessions_per_run", target: 0 },
          { patternKey: KEY_A, metric: "rework_rounds_v2", target: 1 },
        ],
      },
    });
    const { ddb } = await submit(prd, { rows: [seen(KEY_A)] });
    assert.deepEqual(ddb.items.get(KEY_A).expected.map((e) => e.metric).sort(), ["dead_sessions_per_run", "rework_rounds_v2"]);
  });
});

describe("run: the fleet improver's PRD is unaffected", () => {
  it("submits with no si block, no ledger read and no snapshot", async () => {
    const prd = { title: "agent: sharpen the reviewer prompt", description: "…", sources: [] };
    const { result, fetchImpl, s3, ddb } = await submit(prd);
    assert.equal(result.statusCode, 200);
    assert.equal(fetchImpl.calls.length, 1);
    const { payload } = fetchImpl.calls[0];
    assert.equal("si" in payload, false);
    assert.equal(payload.repoConfig.repos[0].url, "https://github.com/test/fleet");
    assert.equal(s3.puts.length, 0);
    assert.equal(ddb.items.size, 0);
  });

  it("tolerates a fleet PRD that happens to carry patternKeys, by holding it to the same standard", async () => {
    // `si` present ⇒ system PRD ⇒ expected[] required. An agent-loop PRD that
    // wants to name patterns must also name numbers; one that names neither is
    // untouched by this feature (previous test).
    const prd = { title: "agent: x", description: "…", si: { patternKeys: [KEY_A] } };
    const { result, fetchImpl } = await submit(prd, { rows: [seen(KEY_A)] });
    assert.match(result.body, /Rejected:/);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

describe("run: failures", () => {
  it("returns the API's status and leaves the ledger alone when the run never started", async () => {
    const { result, ddb } = await submit(systemPrd(), {
      rows: [seen(KEY_A)],
      fetchOpts: { ok: false, status: 503, body: "upstream down" },
    });
    assert.equal(result.statusCode, 503);
    const row = ddb.items.get(KEY_A);
    assert.equal(row.status, "open");
    assert.equal(row.attempts.length, 0);
    assert.equal(row.expected.length, 0);
  });

  it("does NOT throw when the ledger write fails after the run started — a retry would start a second run", async () => {
    const prd = systemPrd();
    const ddb = fakeDdb([seen(KEY_A)]);
    const s3 = fakeS3(prd);
    const ledger = new SiLedger({ ddb, table: "test-si-ledger" });
    const fetchImpl = fakeFetch();
    // Reads (the gate) still succeed; only writes blow up — which is the shape of
    // a throttled or newly-created table.
    ddb.failPuts = true;
    const { value, errors } = await captureLogs(() => run(EVENT, { s3, ledger, fetchImpl }));
    assert.equal(value.statusCode, 200);
    assert.equal(JSON.parse(value.body).workflowId, "wf-1");
    assert.ok(errors.some((e) => /si-ledger write FAILED/.test(e)), errors.join("\n"));
  });

  it("lets a gate read failure throw, so EventBridge retries before any run exists", async () => {
    const prd = systemPrd();
    const s3 = fakeS3(prd);
    const fetchImpl = fakeFetch();
    const ledger = { async get() { throw new Error("ResourceNotFoundException: table not found"); } };
    await assert.rejects(
      () => captureLogs(() => run(EVENT, { s3, ledger, fetchImpl })),
      /ResourceNotFoundException/,
    );
    assert.equal(fetchImpl.calls.length, 0);
  });
});

// ── TEAM-5771: the approver-window hold ─────────────────────────────────────
//
// The hold's whole point is durability, so its fake S3 is a real little object
// store: ETags, IfNoneMatch/IfMatch preconditions (412 like S3), List and
// Delete. A "cold start" is a fresh import of the module over the SAME store.

const { tick, status, deferralKey, sourceTicketFor, startedRun, startFailure, DEFERRED_PREFIX, DONE_PREFIX } = mod;

const WINDOW_ENV = { SI_APPROVER_HOURS: "15-22", SI_APPROVER_DAYS: "1-5" };
const SUNDAY = "2026-10-11T11:43:00.000Z";
const MONDAY_OPEN = "2026-10-12T15:00:00.000Z";
const SYS_KEY = "fleet-imp-agent/prd/system-20261011T114300.json";
const SYS_PRD_KEY = "system-20261011T114300";

function s3Error(name, status) {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

function fakeStore(initial = {}) {
  let n = 0;
  const objects = new Map();
  const put = (key, body) => {
    const etag = `"e${++n}"`;
    objects.set(key, { body, etag });
    return etag;
  };
  for (const [key, value] of Object.entries(initial)) put(key, JSON.stringify(value));
  return {
    objects,
    failPut: null, // (key) => boolean
    failDelete: null, // (key) => boolean
    json(key) {
      const o = objects.get(key);
      return o ? JSON.parse(o.body) : undefined;
    },
    keys(prefix) {
      return [...objects.keys()].filter((k) => k.startsWith(prefix));
    },
    async send(cmd) {
      await Promise.resolve(); // yield, so concurrent ticks really interleave
      const name = cmd.constructor.name;
      const { Key, IfNoneMatch, IfMatch, Prefix } = cmd.input;
      if (name === "GetObjectCommand") {
        const o = objects.get(Key);
        if (!o) throw s3Error("NoSuchKey", 404);
        return { ETag: o.etag, Body: { transformToString: async () => o.body } };
      }
      if (name === "PutObjectCommand") {
        if (this.failPut?.(Key)) throw s3Error("InternalError", 500);
        const o = objects.get(Key);
        if (IfNoneMatch === "*" && o) throw s3Error("PreconditionFailed", 412);
        if (IfMatch !== undefined && (!o || o.etag !== IfMatch)) throw s3Error("PreconditionFailed", 412);
        return { ETag: put(Key, cmd.input.Body) };
      }
      if (name === "ListObjectsV2Command") {
        return { Contents: this.keys(Prefix).map((k) => ({ Key: k })), IsTruncated: false };
      }
      if (name === "DeleteObjectCommand") {
        if (this.failDelete?.(Key)) throw s3Error("AccessDenied", 403);
        objects.delete(Key);
        return {};
      }
      throw new Error(`fakeStore: unexpected ${name}`);
    },
  };
}

/** One submission against a shared store/ledger, at a fixed instant. */
async function submitAt(prd, { key = SYS_KEY, now = SUNDAY, env = WINDOW_ENV, store, ddb, fetchOpts, runFn = run } = {}) {
  store ||= fakeStore();
  store.objects.set(key, { body: JSON.stringify(prd), etag: '"prd"' });
  ddb ||= fakeDdb([seen(KEY_A)]);
  const ledger = new SiLedger({ ddb, table: "test-si-ledger" });
  const fetchImpl = fakeFetch(fetchOpts);
  const { value, errors, logs } = await captureLogs(() => runFn({ detail: { object: { key } } }, { s3: store, ledger, fetchImpl, now, env }));
  return { result: value, store, ddb, ledger, fetchImpl, errors, logs };
}

async function tickAt(now, { store, ddb, fetchOpts, tickFn = tick } = {}) {
  const ledger = new SiLedger({ ddb, table: "test-si-ledger" });
  const fetchImpl = fakeFetch(fetchOpts);
  const { value, errors, logs } = await captureLogs(() => tickFn({ s3: store, ledger, fetchImpl, now }));
  return { result: value, fetchImpl, errors, logs, counts: JSON.parse(value.body) };
}

describe("approver window (a): a system PRD inside the window", () => {
  it("starts immediately, holds nothing, and links the run as today", async () => {
    const s = await submitAt(systemPrd(), { now: "2026-10-13T16:00:00.000Z" });
    assert.equal(s.fetchImpl.calls.length, 1);
    assert.equal(s.fetchImpl.calls[0].payload.sourceTicket, undefined, "the unheld payload is unchanged");
    assert.deepEqual(s.store.keys(DEFERRED_PREFIX), []);
    const row = s.ddb.items.get(KEY_A);
    assert.equal(row.status, "in-run");
    assert.equal(row.attempts.length, 1);
    assert.equal(row.attempts[0].workflowId, "wf-1");
  });
});

describe("approver window (b): a system PRD on a Sunday morning", () => {
  it("is held until Monday 15:00Z; keys flip to in-run now; nothing starts", async () => {
    const s = await submitAt(systemPrd());
    assert.equal(s.fetchImpl.calls.length, 0);
    const body = JSON.parse(s.result.body);
    assert.deepEqual(
      { deferred: body.deferred, prdKey: body.prdKey, arrivedAt: body.arrivedAt, scheduledStartAt: body.scheduledStartAt },
      { deferred: true, prdKey: SYS_PRD_KEY, arrivedAt: SUNDAY, scheduledStartAt: MONDAY_OPEN },
    );

    const record = s.store.json(deferralKey(SYS_PRD_KEY));
    assert.equal(record.state, "pending");
    assert.equal(record.arrivedAt, SUNDAY);
    assert.equal(record.scheduledStartAt, MONDAY_OPEN);
    assert.equal(record.payload.sourceTicket, sourceTicketFor(SYS_PRD_KEY));
    assert.equal(record.payload.workflowDefId, "operator");
    assert.deepEqual(record.payload.si.patternKeys, [KEY_A]);

    const row = s.ddb.items.get(KEY_A);
    assert.equal(row.status, "in-run", "SYNTHESIZE must not re-file a held key");
    assert.equal(row.attempts.length, 1);
    assert.equal(row.attempts[0].workflowId, null);
    assert.match(row.attempts[0].note, /deferred: start scheduled 2026-10-12T15:00:00.000Z/);
    assert.equal(row.expected.length, 1);
    assert.equal(dedupeBlocked(row, { now: SUNDAY }).blocked, true);

    const line = s.logs.find((l) => l.includes("DEFERRED"));
    assert.ok(line, s.logs.join("\n"));
    assert.match(line, new RegExp(`${SYS_PRD_KEY} arrived=${SUNDAY} scheduledStart=${MONDAY_OPEN}`));
  });

  it("any Sunday 11:43Z schedules the following Monday 15:00Z", async () => {
    for (let week = 0; week < 6; week++) {
      const sunday = new Date(Date.UTC(2026, 9, 11 + week * 7, 11, 43)).toISOString();
      const monday = new Date(Date.UTC(2026, 9, 12 + week * 7, 15, 0)).toISOString();
      const key = `fleet-imp-agent/prd/system-sunday-${week}.json`;
      const s = await submitAt(systemPrd(), { key, now: sunday });
      assert.equal(s.fetchImpl.calls.length, 0);
      assert.equal(s.store.json(deferralKey(`system-sunday-${week}`)).scheduledStartAt, monday);
    }
  });
});

describe("approver window (c): no other source is ever held", () => {
  it("an agent PRD on the prd/ prefix starts immediately, outside the window", async () => {
    const s = await submitAt({ title: "tune agent x", description: "make it better" }, { key: "fleet-imp-agent/prd/agent-tune-x.json" });
    assert.equal(s.fetchImpl.calls.length, 1);
    assert.deepEqual(s.store.keys(DEFERRED_PREFIX), []);
  });

  it("a system-shaped PRD under another prefix starts immediately", async () => {
    const s = await submitAt(systemPrd(), { key: "other-prefix/system-20261011.json" });
    assert.equal(s.fetchImpl.calls.length, 1);
    assert.deepEqual(s.store.keys(DEFERRED_PREFIX), []);
    assert.equal(s.ddb.items.get(KEY_A).attempts[0].workflowId, "wf-1");
  });

  it("a system-shaped PRD on the prd/ prefix but not named system-* starts immediately", async () => {
    const s = await submitAt(systemPrd(), { key: "fleet-imp-agent/prd/manual-20261011.json" });
    assert.equal(s.fetchImpl.calls.length, 1);
    assert.deepEqual(s.store.keys(DEFERRED_PREFIX), []);
  });

  it("with the window unset or off, even a Sunday system PRD starts immediately", async () => {
    for (const env of [{}, { SI_APPROVER_HOURS: "off" }]) {
      const s = await submitAt(systemPrd(), { env });
      assert.equal(s.fetchImpl.calls.length, 1);
      assert.deepEqual(s.store.keys(DEFERRED_PREFIX), []);
    }
  });
});

describe("approver window (d): the hold survives a cold start", () => {
  it("a fresh module instance's tick starts it once at the window, and never again", async () => {
    const held = await submitAt(systemPrd());
    const { store, ddb } = held;

    // Cold start: a new module instance (fresh lazily-built clients and state)
    // over the same durable store. Nothing in memory carries the hold.
    const cold = await import("./index.mjs?cold-start");
    assert.notEqual(cold.tick, tick);

    const early = await tickAt("2026-10-12T14:59:00.000Z", { store, ddb, tickFn: cold.tick });
    assert.equal(early.fetchImpl.calls.length, 0);
    assert.equal(early.counts.waiting, 1);

    const open = await tickAt("2026-10-12T15:02:00.000Z", { store, ddb, tickFn: cold.tick });
    assert.equal(open.fetchImpl.calls.length, 1);
    const { url, payload } = open.fetchImpl.calls[0];
    assert.equal(url, "https://workflow.test/api/workflow/start");
    assert.equal(payload.sourceTicket, sourceTicketFor(SYS_PRD_KEY));
    assert.equal(payload.si.prdKey, SYS_PRD_KEY);
    assert.equal(open.counts.started, 1);
    assert.equal(open.counts.linked, 1);
    assert.ok(open.logs.some((l) => l.includes(`STARTED ${SYS_PRD_KEY} wf-1`)), open.logs.join("\n"));

    assert.deepEqual(store.keys(DEFERRED_PREFIX), [], "a finished hold leaves the pending prefix");
    const done = store.json(`${DONE_PREFIX}${SYS_PRD_KEY}.json`);
    assert.equal(done.state, "started");
    assert.equal(done.workflowId, "wf-1");
    assert.equal(done.ledgerLinked, true);

    const row = ddb.items.get(KEY_A);
    assert.equal(row.status, "in-run");
    assert.equal(row.attempts.length, 1, "the held attempt is filled in place, not appended to");
    assert.equal(row.attempts[0].workflowId, "wf-1");
    assert.equal(row.attempts[0].epicId, "TEAM-9001");
    assert.match(row.attempts[0].note, /deferred 2026-10-11T11:43:00.000Z -> started 2026-10-12T15:02:00.000Z/);

    const again = await tickAt("2026-10-12T15:07:00.000Z", { store, ddb, tickFn: cold.tick });
    assert.equal(again.fetchImpl.calls.length, 0);
  });

  it("two concurrent ticks start a due hold exactly once", async () => {
    const { store, ddb } = await submitAt(systemPrd());
    const ledger = new SiLedger({ ddb, table: "test-si-ledger" });
    const fetchImpl = fakeFetch();
    await captureLogs(() => Promise.all([
      tick({ s3: store, ledger, fetchImpl, now: "2026-10-12T15:02:00.000Z" }),
      tick({ s3: store, ledger, fetchImpl, now: "2026-10-12T15:02:00.000Z" }),
    ]));
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(ddb.items.get(KEY_A).attempts.length, 1);
  });
});

describe("approver window: write order and recovery", () => {
  it("a failed record write throws (EventBridge retries) and leaves no in-run row behind", async () => {
    const store = fakeStore();
    store.failPut = (k) => k.startsWith(DEFERRED_PREFIX);
    const ddb = fakeDdb([seen(KEY_A)]);
    await assert.rejects(() => submitAt(systemPrd(), { store, ddb }));
    assert.equal(ddb.items.get(KEY_A).status, "open");
    assert.equal(ddb.items.get(KEY_A).attempts.length, 0);
  });

  it("a ledger failure after the record throws; the redelivery resumes without re-gating", async () => {
    const store = fakeStore();
    const ddb = fakeDdb([seen(KEY_A)]);
    ddb.failPuts = true;
    await assert.rejects(() => submitAt(systemPrd(), { store, ddb }));
    assert.equal(store.json(deferralKey(SYS_PRD_KEY)).state, "pending");

    ddb.failPuts = false;
    const retry = await submitAt(systemPrd(), { store, ddb });
    assert.equal(JSON.parse(retry.result.body).deferred, true);
    assert.equal(retry.fetchImpl.calls.length, 0);
    const row = ddb.items.get(KEY_A);
    assert.equal(row.status, "in-run");
    assert.equal(row.attempts.length, 1);
  });

  it("a hold whose ledger write never landed is backfilled by the tick", async () => {
    const store = fakeStore();
    const ddb = fakeDdb([seen(KEY_A)]);
    ddb.failPuts = true;
    await assert.rejects(() => submitAt(systemPrd(), { store, ddb }));
    ddb.failPuts = false;

    const t = await tickAt("2026-10-12T15:02:00.000Z", { store, ddb });
    assert.equal(t.fetchImpl.calls.length, 1);
    const row = ddb.items.get(KEY_A);
    assert.equal(row.status, "in-run");
    assert.equal(row.attempts.length, 1);
    assert.equal(row.attempts[0].workflowId, "wf-1");
    assert.equal(row.expected.length, 1);
  });

  it("a throttled start (429, only ever from in front of the route) returns to pending and is retried", async () => {
    const { store, ddb } = await submitAt(systemPrd());
    const failed = await tickAt("2026-10-12T15:02:00.000Z", { store, ddb, fetchOpts: { ok: false, status: 429, body: "slow down" } });
    assert.equal(failed.counts.failed, 1);
    const record = store.json(deferralKey(SYS_PRD_KEY));
    assert.equal(record.state, "pending");
    assert.match(record.lastError, /API 429: slow down/);

    const ok = await tickAt("2026-10-12T15:07:00.000Z", { store, ddb });
    assert.equal(ok.fetchImpl.calls.length, 1);
    assert.equal(store.json(`${DONE_PREFIX}${SYS_PRD_KEY}.json`).lastError, undefined);
  });

  // Each class of non-2xx route.ts / middleware.ts can return (see startFailure).
  for (const [label, status, body, rejected] of [
    ["500 after the workflow row was written (intake ticket failed, row marked terminal — route.ts:1022 → :662)", 500,
      { error: "Failed to create requirements ticket: ticket-tools timeout" }, false],
    ["500 before any write (route.ts:495)", 500, { error: 'Default workflow def "operator" unavailable' }, false],
    ["503 from the load balancer", 503, "Service Unavailable", false],
    ["400 validation (route.ts:421)", 400, { error: "title is required" }, true],
    ["422 source validation (route.ts:590)", 422, { error: "Source validation failed" }, true],
    ["401 from the auth middleware (middleware.ts:49)", 401, { error: "Unauthorized" }, true],
  ]) {
    it(`${label}: flagged STUCK, never re-POSTed`, async () => {
      const { store, ddb } = await submitAt(systemPrd());
      const first = await tickAt("2026-10-12T15:02:00.000Z", { store, ddb, fetchOpts: { ok: false, status, body } });
      assert.equal(first.fetchImpl.calls.length, 1);
      assert.equal(first.counts.stuck, 1);
      assert.equal(first.counts.failed, 0);
      const record = store.json(deferralKey(SYS_PRD_KEY));
      assert.equal(record.state, "starting");
      assert.equal(record.uncertain, true);
      assert.equal(record.rejected, rejected ? true : undefined);
      assert.match(record.lastError, new RegExp(`^API ${status}: `));
      assert.ok(first.errors.some((l) => l.includes(rejected ? "the start was rejected" : "start outcome unknown")), first.errors.join("\n"));

      for (const now of ["2026-10-12T15:07:00.000Z", "2026-10-12T16:30:00.000Z"]) {
        const later = await tickAt(now, { store, ddb });
        assert.equal(later.fetchImpl.calls.length, 0, `no second POST at ${now}`);
        assert.equal(later.counts.stuck, 1);
      }
    });
  }

  it("startFailure classifies by what the status proves", () => {
    assert.equal(startFailure(429), "retry");
    for (const s of [400, 401, 403, 404, 422]) assert.equal(startFailure(s), "rejected", String(s));
    for (const s of [0, 500, 502, 503, 504, 599, 302]) assert.equal(startFailure(s), "unknown", String(s));
  });


  it("a claim left by a dead tick is flagged STUCK for a human, never re-POSTed", async () => {
    const { store, ddb } = await submitAt(systemPrd());
    const key = deferralKey(SYS_PRD_KEY);
    store.objects.set(key, {
      body: JSON.stringify({ ...store.json(key), state: "starting", claimedAt: "2026-10-12T15:00:00.000Z" }),
      etag: '"dead"',
    });

    const fresh = await tickAt("2026-10-12T15:05:00.000Z", { store, ddb });
    assert.equal(fresh.fetchImpl.calls.length, 0, "a live claim is left alone");
    assert.equal(fresh.counts.waiting, 1);

    // The dead tick's POST may have created a run that has since gone terminal;
    // the route would re-point its dedup marker and fork a second run.
    for (const now of ["2026-10-12T15:11:00.000Z", "2026-10-13T15:11:00.000Z"]) {
      const stale = await tickAt(now, { store, ddb });
      assert.equal(stale.fetchImpl.calls.length, 0);
      assert.equal(stale.counts.stuck, 1);
      assert.ok(stale.errors.some((l) => l.includes(`STUCK ${SYS_PRD_KEY}`) && l.includes(sourceTicketFor(SYS_PRD_KEY))), stale.errors.join("\n"));
    }
    assert.equal(store.objects.get(key).etag, '"dead"', "left exactly as found");
    const listed = JSON.parse((await status({ s3: store, now: "2026-10-12T15:11:00.000Z" })).body).deferred;
    assert.match(listed[0].stuck, /never re-POSTed automatically/);
  });

  for (const [label, fetchOpts] of [
    ["the start request throws", { throws: new Error("socket hang up") }],
    ["the gateway answers 504", { ok: false, status: 504, body: "Gateway Timeout" }],
    ["the gateway answers 502", { ok: false, status: 502, body: "Bad Gateway" }],
  ]) {
    it(`${label}: the outcome is unknown, so the claim is flagged and never retried`, async () => {
      const { store, ddb } = await submitAt(systemPrd());
      const first = await tickAt("2026-10-12T15:02:00.000Z", { store, ddb, fetchOpts });
      assert.equal(first.fetchImpl.calls.length, 1);
      assert.equal(first.counts.stuck, 1);
      const record = store.json(deferralKey(SYS_PRD_KEY));
      assert.equal(record.state, "starting");
      assert.equal(record.uncertain, true);
      assert.ok(record.lastError);

      const later = await tickAt("2026-10-12T15:07:00.000Z", { store, ddb });
      assert.equal(later.fetchImpl.calls.length, 0, "not even inside the claim's ten minutes");
      assert.equal(later.counts.stuck, 1);
    });
  }

  it("a human resolves a stuck claim either way: pending re-starts it, started links it", async () => {
    const key = deferralKey(SYS_PRD_KEY);
    {
      const { store, ddb } = await submitAt(systemPrd());
      await tickAt("2026-10-12T15:02:00.000Z", { store, ddb, fetchOpts: { throws: new Error("timeout") } });
      store.objects.set(key, { body: JSON.stringify({ ...store.json(key), state: "pending" }), etag: '"human"' });
      const t = await tickAt("2026-10-12T15:30:00.000Z", { store, ddb });
      assert.equal(t.fetchImpl.calls.length, 1);
      assert.equal(t.counts.linked, 1);
      assert.equal(store.json(`${DONE_PREFIX}${SYS_PRD_KEY}.json`).uncertain, undefined);
    }
    {
      const { store, ddb } = await submitAt(systemPrd());
      await tickAt("2026-10-12T15:02:00.000Z", { store, ddb, fetchOpts: { throws: new Error("timeout") } });
      store.objects.set(key, { body: JSON.stringify({ ...store.json(key), state: "started", workflowId: "wf_found" }), etag: '"human"' });
      const t = await tickAt("2026-10-12T15:30:00.000Z", { store, ddb });
      assert.equal(t.fetchImpl.calls.length, 0);
      assert.equal(t.counts.linked, 1);
      const row = ddb.items.get(KEY_A);
      assert.equal(row.attempts.length, 1);
      assert.equal(row.attempts[0].workflowId, "wf_found");
    }
  });

});

describe("approver window: status", () => {
  it("lists a hold while pending and after it started, so it never reads as dropped", async () => {
    const { store, ddb } = await submitAt(systemPrd());
    const before = JSON.parse((await status({ s3: store })).body);
    assert.deepEqual(before.deferred, [{ key: deferralKey(SYS_PRD_KEY), prdKey: SYS_PRD_KEY, arrivedAt: SUNDAY, scheduledStartAt: MONDAY_OPEN, state: "pending" }]);

    await tickAt("2026-10-12T15:02:00.000Z", { store, ddb });
    const after = JSON.parse((await status({ s3: store })).body);
    assert.deepEqual(after.deferred, [{ key: `${DONE_PREFIX}${SYS_PRD_KEY}.json`, prdKey: SYS_PRD_KEY, arrivedAt: SUNDAY, scheduledStartAt: MONDAY_OPEN, state: "started", workflowId: "wf-1" }]);
  });
});

describe("approver window: records the tick cannot act on", () => {
  // The two probe objects the live S3 check left in the real prefix, byte for byte.
  const LEFTOVERS = {
    "prd-submitter/deferred/te5771-livecheck-1791917319.json": '{"state":"pending"}',
    "prd-submitter/deferred/te5771-livecheck-1791917342.json": '{"state":"starting"}',
  };

  function leftoverStore() {
    const store = fakeStore();
    for (const [key, body] of Object.entries(LEFTOVERS)) store.objects.set(key, { body, etag: `"${key}"` });
    return store;
  }

  it("never POSTs, never throws, never rewrites the live-check leftovers", async () => {
    const store = leftoverStore();
    const ddb = fakeDdb([seen(KEY_A)]);
    for (const now of ["2026-10-12T15:02:00.000Z", "2027-01-01T00:00:00.000Z"]) {
      const t = await tickAt(now, { store, ddb });
      assert.equal(t.fetchImpl.calls.length, 0);
      assert.deepEqual(t.counts, { held: 2, waiting: 0, started: 0, linked: 0, unlinked: 0, failed: 0, skipped: 0, malformed: 2, stuck: 0 });
      for (const key of Object.keys(LEFTOVERS)) assert.ok(t.logs.concat(t.errors).some((l) => l.includes(`malformed hold ${key}`)), key);
    }
    for (const [key, body] of Object.entries(LEFTOVERS)) {
      assert.equal(store.objects.get(key).body, body, `${key} is left exactly as found`);
      assert.equal(store.objects.get(key).etag, `"${key}"`);
    }
    assert.deepEqual(store.keys(DONE_PREFIX), []);
    assert.deepEqual(ddb.items.get(KEY_A).attempts || [], [], "no ledger write");
  });

  it("a real hold beside them still starts", async () => {
    const { store, ddb } = await submitAt(systemPrd());
    for (const [key, body] of Object.entries(LEFTOVERS)) store.objects.set(key, { body, etag: `"${key}"` });
    const t = await tickAt("2026-10-12T15:02:00.000Z", { store, ddb });
    assert.equal(t.fetchImpl.calls.length, 1);
    assert.equal(t.fetchImpl.calls[0].payload.sourceTicket, sourceTicketFor(SYS_PRD_KEY));
    assert.equal(t.counts.malformed, 2);
    assert.equal(t.counts.linked, 1);
  });

  it("an unparseable body is malformed, not a tick failure", async () => {
    const store = fakeStore();
    store.objects.set(`${DEFERRED_PREFIX}junk.json`, { body: "{not json", etag: '"j"' });
    const t = await tickAt("2026-10-12T15:02:00.000Z", { store, ddb: fakeDdb([]) });
    assert.equal(t.fetchImpl.calls.length, 0);
    assert.equal(t.counts.malformed, 1);
    assert.equal(t.counts.failed, 0);
  });

  it("status lists them, flagged, by S3 key", async () => {
    const out = JSON.parse((await status({ s3: leftoverStore() })).body);
    assert.deepEqual(out.deferred.map((d) => [d.key, d.state, Boolean(d.malformed)]), [
      ["prd-submitter/deferred/te5771-livecheck-1791917319.json", "pending", true],
      ["prd-submitter/deferred/te5771-livecheck-1791917342.json", "starting", true],
    ]);
  });

  it("a failed archive delete is non-fatal and never re-POSTs", async () => {
    const { store, ddb } = await submitAt(systemPrd());
    store.failDelete = () => true;
    const first = await tickAt("2026-10-12T15:02:00.000Z", { store, ddb });
    assert.equal(first.fetchImpl.calls.length, 1);
    assert.equal(first.counts.linked, 1);
    assert.equal(first.counts.failed, 0);
    assert.equal(store.json(`${DONE_PREFIX}${SYS_PRD_KEY}.json`).state, "started");
    assert.equal(store.json(deferralKey(SYS_PRD_KEY)).state, "started", "left in place");

    const second = await tickAt("2026-10-12T15:07:00.000Z", { store, ddb });
    assert.equal(second.fetchImpl.calls.length, 0, "a started record is never started again");
    store.failDelete = null;
    const third = await tickAt("2026-10-12T15:12:00.000Z", { store, ddb });
    assert.equal(third.fetchImpl.calls.length, 0);
    assert.deepEqual(store.keys(DEFERRED_PREFIX), []);
    assert.equal(ddb.items.get(KEY_A).attempts.length, 1);
  });
});

describe("approver window: a redelivered PRD after its hold started", () => {
  const sysEvent = { detail: { object: { key: SYS_KEY } } };

  async function redeliver({ store, ddb, env = WINDOW_ENV, now = "2026-10-12T15:04:00.000Z" }) {
    const fetchImpl = fakeFetch();
    const ledger = new SiLedger({ ddb, table: "test-si-ledger" });
    const { value } = await captureLogs(() => run(sysEvent, { s3: store, ledger, fetchImpl, now, env }));
    return { result: value, fetchImpl };
  }

  function assertOneLinkedAttempt(ddb) {
    const row = ddb.items.get(KEY_A);
    assert.equal(row.status, "in-run");
    assert.equal(row.attempts.length, 1, JSON.stringify(row.attempts));
    assert.equal(row.attempts.at(-1).workflowId, "wf-1", "the newest attempt names the run, so si-reap sees it");
  }

  it("linked but not yet archived (delete failed): no second, run-less attempt", async () => {
    const { store, ddb } = await submitAt(systemPrd());
    store.failDelete = () => true;
    await tickAt("2026-10-12T15:02:00.000Z", { store, ddb });
    assert.equal(store.json(deferralKey(SYS_PRD_KEY)).state, "started");

    const r = await redeliver({ store, ddb });
    assert.equal(r.fetchImpl.calls.length, 0);
    assert.equal(JSON.parse(r.result.body).started, true);
    assertOneLinkedAttempt(ddb);
  });

  it("archived: not held again, not started again — even with the window turned off", async () => {
    const { store, ddb } = await submitAt(systemPrd());
    await tickAt("2026-10-12T15:02:00.000Z", { store, ddb });
    assert.deepEqual(store.keys(DEFERRED_PREFIX), []);

    for (const env of [WINDOW_ENV, {}]) {
      for (const now of ["2026-10-12T15:04:00.000Z", "2026-10-18T11:00:00.000Z"]) {
        const r = await redeliver({ store, ddb, env, now });
        assert.equal(r.fetchImpl.calls.length, 0, `${JSON.stringify(env)} ${now}`);
        assert.deepEqual(store.keys(DEFERRED_PREFIX), []);
      }
    }
    assertOneLinkedAttempt(ddb);
  });

  it("a key the tick already linked is skipped even while the record still reads pre-start", async () => {
    const { store, ddb } = await submitAt(systemPrd());
    const key = deferralKey(SYS_PRD_KEY);
    const before = store.json(key);
    await tickAt("2026-10-12T15:02:00.000Z", { store, ddb });
    // A redelivery that read the record before the tick wrote `started`.
    store.objects.set(key, { body: JSON.stringify({ ...before, state: "starting", claimedAt: "2026-10-12T15:02:00.000Z" }), etag: '"old"' });

    const r = await redeliver({ store, ddb });
    assert.equal(r.fetchImpl.calls.length, 0);
    assertOneLinkedAttempt(ddb);
  });
});

describe("approver window: a malformed object at a PRD's own hold key", () => {
  it("rejects the redelivery loudly instead of reporting it held", async () => {
    const store = fakeStore();
    store.objects.set(deferralKey(SYS_PRD_KEY), { body: '{"state":"pending"}', etag: '"x"' });
    const s = await submitAt(systemPrd(), { store });
    assert.equal(s.fetchImpl.calls.length, 0);
    assert.match(s.result.body, /^Rejected: hold record .* malformed/);
    assert.ok(s.errors.some((l) => l.includes("malformed")), s.errors.join("\n"));
    assert.deepEqual(s.ddb.items.get(KEY_A).attempts || [], []);
  });
});

describe("the start route's real 2xx shapes", () => {
  it("startedRun reads each shape route.ts returns", () => {
    assert.deepEqual(startedRun(START_FRESH), { workflowId: "wf-1", epicId: "TEAM-9001" });
    assert.deepEqual(startedRun(START_COALESCED), { workflowId: "wf-1", epicId: null });
    assert.equal(startedRun(START_SWEEP_SKIP), null);
    assert.equal(startedRun(null), null);
  });

  it("tick: a coalesced start links the run with no epicId and does not break", async () => {
    const { store, ddb } = await submitAt(systemPrd());
    const t = await tickAt("2026-10-12T15:02:00.000Z", { store, ddb, fetchOpts: { body: START_COALESCED } });
    assert.equal(t.counts.started, 1);
    assert.equal(t.counts.linked, 1);
    const done = store.json(`${DONE_PREFIX}${SYS_PRD_KEY}.json`);
    assert.equal(done.workflowId, "wf-1");
    assert.equal(done.epicId, null);
    const row = ddb.items.get(KEY_A);
    assert.equal(row.attempts.length, 1);
    assert.equal(row.attempts[0].workflowId, "wf-1");
    assert.ok(!row.attempts[0].epicId);
    assert.ok(t.logs.some((l) => l.includes("epic: none")), t.logs.join("\n"));
  });

  it("tick: a 2xx that started nothing is flagged for a human, never linked or retried", async () => {
    const { store, ddb } = await submitAt(systemPrd());
    const t = await tickAt("2026-10-12T15:02:00.000Z", { store, ddb, fetchOpts: { body: START_SWEEP_SKIP } });
    assert.equal(t.counts.stuck, 1);
    assert.equal(t.counts.linked, 0);
    const record = store.json(deferralKey(SYS_PRD_KEY));
    assert.equal(record.state, "starting");
    assert.match(record.lastError, /named no run/);
    assert.equal(ddb.items.get(KEY_A).attempts[0].workflowId, null, "still the run-less hold attempt");
    const again = await tickAt("2026-10-12T15:30:00.000Z", { store, ddb });
    assert.equal(again.fetchImpl.calls.length, 0);
  });

  it("run: an in-window coalesced start marks in-run with the run and no epicId", async () => {
    const s = await submitAt(systemPrd(), { now: "2026-10-13T16:00:00.000Z", fetchOpts: { body: START_COALESCED } });
    assert.equal(s.result.statusCode, 200);
    const row = s.ddb.items.get(KEY_A);
    assert.equal(row.status, "in-run");
    assert.equal(row.attempts[0].workflowId, "wf-1");
    assert.ok(!row.attempts[0].epicId);
  });

  it("run: a 2xx that started nothing leaves the ledger alone", async () => {
    const s = await submitAt(systemPrd(), { now: "2026-10-13T16:00:00.000Z", fetchOpts: { body: START_SWEEP_SKIP } });
    assert.equal(s.result.statusCode, 200);
    assert.equal(JSON.parse(s.result.body).started, false);
    const row = s.ddb.items.get(KEY_A);
    assert.notEqual(row.status, "in-run");
    assert.deepEqual(row.attempts || [], []);
  });
});
