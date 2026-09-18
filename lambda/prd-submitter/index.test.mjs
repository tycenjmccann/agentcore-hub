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

function fakeFetch({ ok = true, status = 200, body = { workflowId: "wf-1", epicId: "TEAM-9001" } } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, payload: JSON.parse(init.body) });
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
