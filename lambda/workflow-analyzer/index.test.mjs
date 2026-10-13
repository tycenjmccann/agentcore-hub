/**
 * lambda/workflow-analyzer/index.test.mjs
 *
 * The analyzer's TEAM-4760 surfaces: closing out the SI attempt a finished run
 * was carrying, the D5 "did ANALYZE actually persist anything?" check, and the
 * daily SI-VERIFY dispatch.
 *
 * si-ledger.test.mjs proves the reducers; this suite proves the LAMBDA reads a
 * real run correctly — that a cancelled SI run hands its patterns back to `open`
 * instead of wedging them at `in-run` forever, that a merged-but-never-deployed
 * run is not recorded as deployed, and that a run which delivered nothing is
 * never recorded as if it had.
 *
 * Hermetic and offline. The new functions take their collaborators as arguments
 * (`ledger`, `s3`, `client`, `invoke`), so there is no module mocking — which
 * matters on Node 20, where `mock.module` does not exist. The ledger is the REAL
 * SiLedger over an in-memory table, so every status asserted here is produced by
 * the same reducers that will run in prod; only the transport is fake.
 *
 * Not covered here, deliberately: `handler`'s dispatch lines and `invokeHarness`,
 * which are one-liners over a live AgentCore endpoint — exercising them would
 * mean a network call. The payload that reaches them is pinned instead
 * (SI_VERIFY_PROMPT below, and the rule Input in deploy/workflow-manager/deploy.sh).
 *
 * Run: `node --test lambda/workflow-analyzer/index.test.mjs` from the repo root.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.AWS_REGION = "us-east-1";
process.env.ARTIFACT_BUCKET = "test-bucket";
process.env.SI_LEDGER_TABLE = "test-si-ledger";
process.env.ANALYSES_TABLE = "test-analyses";
process.env.WORKFLOWS_TABLE = "test-workflows";
process.env.EVENTS_TABLE = "test-events";

const {
  siBlock,
  prNumbersFrom,
  cdStamps,
  siOutcome,
  readCdLedger,
  shipTicketCandidates,
  stampSiAttempt,
  terminalPhaseOf,
  siReapScan,
  watchScan,
  analysisIdsFor,
  analysisDelta,
  siVerify,
  SI_VERIFY_PROMPT,
  SI_BUCKET_UNSET_MSG,
} = await import("./index.mjs");
const { SiLedger, newRow, applyOccurrence, applyAttempt } = await import("./si-ledger.mjs");

const KEY_A = "harness.silent-death.exit-without-report";
const KEY_B = "ops.paging.out-of-hours";
const PRD = "system-20260918T120000";
const WF = "wf-si-1";
const LAST_MODIFIED = new Date("2026-09-17T11:22:33.000Z");

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

/**
 * S3 holding (or not holding) one cd-ledger object, plus any other `objects`
 * by key (a string body, or an Error to throw). Every other key is a 404 — so
 * a completion-record probe never accidentally reads the ledger's body.
 */
function fakeS3(cd, { lastModified = LAST_MODIFIED, error, objects = {} } = {}) {
  const notFound = () => Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
  return {
    gets: [],
    async send(cmd) {
      const key = cmd.input.Key;
      this.gets.push(key);
      let body;
      if (key.endsWith("/shared/cd-ledger.json")) {
        if (error) throw error;
        if (!cd) throw notFound();
        body = typeof cd === "string" ? cd : JSON.stringify(cd);
      } else if (key in objects) {
        if (objects[key] instanceof Error) throw objects[key];
        body = typeof objects[key] === "string" ? objects[key] : JSON.stringify(objects[key]);
      } else {
        throw notFound();
      }
      return { LastModified: lastModified, Body: { transformToString: async () => body } };
    },
  };
}

/** An in-memory workflows table: Get by workflowId, Scan, plus watchScan's reads. */
function fakeWorkflows(rows = []) {
  const items = new Map(rows.map((r) => [r.workflowId, r]));
  return {
    items,
    gets: [],
    async send(cmd) {
      const name = cmd.constructor.name;
      if (name === "GetCommand") {
        this.gets.push(cmd.input.Key.workflowId);
        return { Item: items.get(cmd.input.Key.workflowId) };
      }
      if (name === "ScanCommand") return { Items: [...items.values()] };
      if (name === "QueryCommand") return { Items: [] }; // no events → watchScan falls back to startedAt
      if (name === "UpdateCommand") return {};
      throw new Error(`fakeWorkflows: unexpected ${name}`);
    },
  };
}

/** The analyses table, paged, keyed by workflowId. */
function fakeAnalyses(pages, { error } = {}) {
  let call = 0;
  return {
    calls: [],
    async send(cmd) {
      this.calls.push(cmd.input);
      if (error) throw error;
      return pages[Math.min(call++, pages.length - 1)];
    },
  };
}

/** A ledger row that an analysis has seen and prd-submitter marked in-run. */
function inRunRow(patternKey, { prdKey = PRD, workflowId = WF } = {}) {
  const seen = applyOccurrence(newRow({ patternKey, title: "silent death", at: "2026-09-01T00:00:00.000Z" }), {
    workflowId: "wf-old",
    analysisId: "an-old",
    workflowDefId: "software-delivery",
    severity: "critical",
    at: "2026-09-01T00:00:00.000Z",
  });
  return applyAttempt(seen, { prdKey, workflowId, epicId: "TEAM-9001", outcome: "in-run" });
}

function siRun(overrides = {}) {
  return {
    workflowId: WF,
    epicId: "TEAM-9001",
    phase: "complete",
    completedAt: "2026-09-17T12:00:00.000Z",
    input: { title: "[SI] stop losing sessions", si: { prdKey: PRD, patternKeys: [KEY_A] } },
    agentTasks: {
      "TEAM-9001-3": { agentId: "backend_developer", prUrl: "https://github.com/o/r/pull/641" },
    },
    delivery: { mode: "cd", pipeline: "hub-r-deploy", prUrl: "https://github.com/o/r/pull/641" },
    ...overrides,
  };
}

/**
 * Swallow the logs the helpers write, but keep them for assertions. `errors`
 * holds the console.error lines alone, for tests that pin the log LEVEL.
 */
async function quiet(fn) {
  const lines = [];
  const errors = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => lines.push(a.join(" "));
  console.warn = (...a) => lines.push(a.join(" "));
  console.error = (...a) => {
    lines.push(a.join(" "));
    errors.push(a.join(" "));
  };
  try {
    return { value: await fn(), lines, errors };
  } finally {
    Object.assign(console, real);
  }
}

// ── siBlock ──────────────────────────────────────────────────────────────────

describe("siBlock", () => {
  it("is null for a run that carried no SI attempt", () => {
    assert.equal(siBlock({ input: { title: "ordinary feature" } }), null);
    assert.equal(siBlock({}), null);
    assert.equal(siBlock(null), null);
  });

  it("is null when the si block names no usable key", async () => {
    assert.equal(siBlock({ input: { si: { prdKey: PRD, patternKeys: [] } } }), null);
    const { value } = await quiet(() => siBlock({ input: { si: { prdKey: PRD, patternKeys: ["", "Not A Key!!"] } } }));
    assert.equal(value, null);
  });

  it("normalises and dedupes the keys, so a prose-cased key still hits its row", () => {
    const si = siBlock({ input: { si: { prdKey: PRD, patternKeys: ["Harness.Silent-Death.Exit-Without-Report", KEY_A, KEY_B] } } });
    assert.deepEqual(si, { prdKey: PRD, patternKeys: [KEY_A, KEY_B] });
  });

  it("tolerates a missing prdKey rather than dropping the whole attempt", () => {
    assert.deepEqual(siBlock({ input: { si: { patternKeys: [KEY_A] } } }), { prdKey: "", patternKeys: [KEY_A] });
  });
});

// ── prNumbersFrom ────────────────────────────────────────────────────────────

describe("prNumbersFrom", () => {
  it("unions the per-ticket PRs with the delivery PR, sorted and deduped", () => {
    assert.deepEqual(
      prNumbersFrom({
        agentTasks: {
          a: { prUrl: "https://github.com/o/r/pull/641" },
          b: { prUrl: "https://github.com/o/r/pull/638" },
          c: { prUrl: "https://github.com/o/r/pull/641" },
          d: {},
        },
        delivery: { prUrl: "https://github.com/o/r/pull/700" },
      }),
      [638, 641, 700],
    );
  });

  it("finds the handoff PR when it is the only one on the row", () => {
    assert.deepEqual(prNumbersFrom({ delivery: { mode: "handoff", prUrl: "https://github.com/o/r/pull/12" } }), [12]);
  });

  it("unions all four sources — agentTasks, delivery, cd-ledger prUrl, ship pr_url — each a distinct PR", () => {
    assert.deepEqual(
      prNumbersFrom(
        { agentTasks: { a: { prUrl: "https://github.com/o/r/pull/1" } }, delivery: { prUrl: "https://github.com/o/r/pull/2" } },
        ["https://github.com/o/r/pull/3", "https://github.com/o/r/pull/4", null],
      ),
      [1, 2, 3, 4],
    );
    // and each extra source alone is enough
    assert.deepEqual(prNumbersFrom({}, ["https://github.com/o/r/pull/3"]), [3]);
    assert.deepEqual(prNumbersFrom({}, [undefined, "https://github.com/o/r/pull/4"]), [4]);
  });

  it("is empty — never [NaN] — when nothing on the run is a PR url", () => {
    assert.deepEqual(prNumbersFrom({ agentTasks: { a: { prUrl: "https://github.com/o/r/compare/x" } } }), []);
    assert.deepEqual(prNumbersFrom({}), []);
  });
});

// ── cdStamps ─────────────────────────────────────────────────────────────────

describe("cdStamps", () => {
  it("stamps nothing when there is no cd-ledger", () => {
    assert.deepEqual(cdStamps(null, { lastModified: LAST_MODIFIED }), { mergedAt: null, deployedAt: null });
  });

  it("dates a succeeded ledger from startedAt / deployCompletedAt", () => {
    assert.deepEqual(
      cdStamps(
        { mergeCommit: "abc123", executionId: "e-1", terminal: true, succeeded: true, startedAt: "2026-10-09T07:46Z", deployCompletedAt: "2026-10-09T08:33:23Z" },
        { lastModified: LAST_MODIFIED },
      ),
      { mergedAt: "2026-10-09T07:46:00.000Z", deployedAt: "2026-10-09T08:33:23.000Z" },
    );
  });

  it("falls back to LastModified when a succeeded ledger carries no times", () => {
    assert.deepEqual(
      cdStamps({ mergeCommit: "abc123", executionId: "e-1", terminal: true, succeeded: true }, { lastModified: LAST_MODIFIED, fallbackAt: "2026-01-01T00:00:00.000Z" }),
      { mergedAt: LAST_MODIFIED.toISOString(), deployedAt: LAST_MODIFIED.toISOString() },
    );
  });

  it("never dates a deploy off an execution id alone — it is written before the gate", () => {
    const stamps = cdStamps({ mergeCommit: "abc123", executionId: "e-1" }, { lastModified: LAST_MODIFIED });
    assert.equal(stamps.mergedAt, LAST_MODIFIED.toISOString());
    assert.equal(stamps.deployedAt, null);
    assert.equal(cdStamps({ mergeCommit: "a", executionId: "e-1", terminal: true, succeeded: false }, { lastModified: LAST_MODIFIED }).deployedAt, null);
  });

  it("leaves mergedAt null when nothing merged, even if the deploy succeeded", () => {
    assert.deepEqual(cdStamps({ executionId: "e-1", terminal: true, succeeded: true }, { lastModified: LAST_MODIFIED }), {
      mergedAt: null,
      deployedAt: LAST_MODIFIED.toISOString(),
    });
  });

  it("prefers an explicit field over LastModified, and falls back to the caller's time", () => {
    assert.equal(
      cdStamps({ mergeCommit: "a", mergedAt: "2026-09-16T00:00:00Z" }, { lastModified: LAST_MODIFIED }).mergedAt,
      "2026-09-16T00:00:00.000Z",
    );
    assert.equal(
      cdStamps({ mergeCommit: "a" }, { fallbackAt: "2026-09-17T12:00:00.000Z" }).mergedAt,
      "2026-09-17T12:00:00.000Z",
    );
  });
});

// ── siOutcome ────────────────────────────────────────────────────────────────

const SUCCEEDED_CD = { pipeline: "hub-r-deploy", executionId: "e-1", mergeCommit: "abc", terminal: true, succeeded: true };
const SHIP = {
  ticket_id: "TEAM-9001-9",
  merge_commit: "abc123def456",
  pr_url: "https://github.com/o/r/pull/641",
  pipeline_execution_id: "e-1",
  outcome: "shipped",
  completed_at: "2026-09-17T11:50:00.000Z",
};

describe("siOutcome", () => {
  it("records a cancelled run as cancelled, with the phase in the note", () => {
    const { outcome, note } = siOutcome({ phase: "cancelled", workflow: siRun({ phase: "cancelled", delivery: undefined }) });
    assert.equal(outcome, "cancelled");
    assert.match(note, /cancelled before the fix shipped/);
    assert.match(note, /phase=cancelled/);
  });

  it("records an errored run as error", () => {
    assert.equal(siOutcome({ phase: "error", workflow: siRun({ phase: "error" }) }).outcome, "error");
  });

  it("is deployed when the cd-ledger says the deploy succeeded", () => {
    const out = siOutcome({ phase: "complete", workflow: siRun(), cd: SUCCEEDED_CD });
    assert.equal(out.outcome, "deployed");
    assert.match(out.note, /deployed via hub-r-deploy/);
  });

  it("is NOT deployed on an execution id alone — no succeeded ledger, no shipped record", () => {
    const out = siOutcome({ phase: "complete", workflow: siRun(), cd: { executionId: "e-1", mergeCommit: "abc" } });
    assert.equal(out.outcome, "error");
  });

  it("(a′) is deployed when the ship record reports shipped for the ledger's own execution", () => {
    const out = siOutcome({ phase: "complete", workflow: siRun(), cd: { pipeline: "p", executionId: "e-1", mergeCommit: "abc" }, ship: SHIP });
    assert.equal(out.outcome, "deployed");
    assert.equal(out.deployedAt, SHIP.completed_at);
    assert.match(out.note, /deployedAt from ship record TEAM-9001-9 \(cd-ledger has no deployCompletedAt\)/);
    // A shipped report for a DIFFERENT execution proves nothing about this one.
    const other = siOutcome({ phase: "complete", workflow: siRun(), cd: { executionId: "e-2", mergeCommit: "abc" }, ship: SHIP });
    assert.equal(other.outcome, "landed");
  });

  it("is landed — not deployed — when the ship record has a merge commit but no succeeded deploy", () => {
    const out = siOutcome({ phase: "complete", workflow: siRun(), cd: null, ship: { ...SHIP, outcome: null, pipeline_execution_id: null } });
    assert.equal(out.outcome, "landed");
    assert.equal(out.mergedAt, SHIP.completed_at);
    assert.equal(out.deployedAt, null);
    assert.match(out.note, /no succeeded deploy recorded/);
  });

  it("never calls a ship-blocked run deployed, even though start_deploy wrote an execution id", () => {
    // The execution id is written the moment start_deploy returns — i.e. BEFORE
    // the approval gate the human then rejected. deploy-blocked = merged, not out.
    const blocked = siOutcome({ phase: "deploy-blocked", workflow: siRun({ phase: "deploy-blocked" }), cd: { executionId: "e-1", mergeCommit: "abc" }, lastModified: LAST_MODIFIED });
    assert.equal(blocked.outcome, "landed");
    assert.match(blocked.note, /merged but never deployed/);

    const nothing = siOutcome({ phase: "static-ci-only", workflow: siRun({ phase: "static-ci-only", delivery: undefined }), cd: null });
    assert.equal(nothing.outcome, "error");
    assert.match(nothing.note, /nothing merged/);
  });

  it("records a registry-out repo's open PR as a handoff", () => {
    const wf = siRun({ delivery: { mode: "handoff", prUrl: "https://github.com/o/r/pull/12" }, agentTasks: {} });
    const out = siOutcome({ phase: "complete", workflow: wf, cd: null });
    assert.equal(out.outcome, "handoff");
    assert.match(out.note, /left open for the owning team/);
  });

  it("refuses to imply delivery when a completed run has no merge evidence, and says what it probed", () => {
    const probes = [
      { uri: "s3://b/workflows/wf/shared/cd-ledger.json", result: "404" },
      { uri: "s3://b/completions/TEAM-1.json", result: "no merge_commit" },
    ];
    const out = siOutcome({ phase: "complete", workflow: siRun({ delivery: { mode: "cd" }, agentTasks: {} }), cd: null, probes });
    assert.equal(out.outcome, "error");
    assert.match(out.note, /nothing shipped, the ask is still owed/);
    assert.match(out.note, /probed: s3:\/\/b\/workflows\/wf\/shared\/cd-ledger\.json \(404\), s3:\/\/b\/completions\/TEAM-1\.json \(no merge_commit\)/);
    assert.doesNotMatch(out.note, /cd-ledger=absent/);
  });
});

// ── readCdLedger ─────────────────────────────────────────────────────────────

describe("readCdLedger", () => {
  it("reads the run's shared/cd-ledger.json and keeps its LastModified", async () => {
    const s3 = fakeS3({ pipeline: "hub-r-deploy", executionId: "e-1", mergeCommit: "abc" });
    const { value } = await quiet(() => readCdLedger(WF, { s3, bucket: "test-bucket" }));
    assert.deepEqual(s3.gets, [`workflows/${WF}/shared/cd-ledger.json`]);
    assert.equal(value.cd.executionId, "e-1");
    assert.equal(value.lastModified, LAST_MODIFIED);
    assert.deepEqual(value.probe, { uri: `s3://test-bucket/workflows/${WF}/shared/cd-ledger.json`, result: "200" });
  });

  it("reports a 404 as a 404 — the run simply never triggered a deploy", async () => {
    const { value } = await quiet(() => readCdLedger(WF, { s3: fakeS3(null), bucket: "test-bucket" }));
    assert.equal(value.cd, null);
    assert.equal(value.probe.result, "404");
  });

  it("names each failure — AccessDenied, a parse error, an unset bucket — never as a 404", async () => {
    const denied = Object.assign(new Error("Access Denied"), { name: "AccessDenied" });
    const a = await quiet(() => readCdLedger(WF, { s3: fakeS3(null, { error: denied }), bucket: "test-bucket" }));
    assert.equal(a.value.cd, null);
    assert.equal(a.value.probe.result, "AccessDenied");
    assert.ok(a.lines.some((l) => /read failed/.test(l)), "a failed look must be logged, not silent");

    const noModule = Object.assign(new Error("Cannot find package '@aws-sdk/client-s3'"), { code: "ERR_MODULE_NOT_FOUND" });
    const m = await quiet(() => readCdLedger(WF, { s3: fakeS3(null, { error: noModule }), bucket: "test-bucket" }));
    assert.equal(m.value.probe.result, "ERR_MODULE_NOT_FOUND");

    const p = await quiet(() => readCdLedger(WF, { s3: fakeS3("{not json"), bucket: "test-bucket" }));
    assert.equal(p.value.cd, null);
    assert.equal(p.value.probe.result, "parse-error");

    const s3 = fakeS3({ executionId: "e-1" });
    const u = await quiet(() => readCdLedger(WF, { s3, bucket: "" }));
    assert.equal(u.value.cd, null);
    assert.equal(u.value.probe.result, "bucket-unset");
    assert.deepEqual(s3.gets, [], "no S3 call without a bucket");
  });
});

// ── stampSiAttempt ───────────────────────────────────────────────────────────

describe("stampSiAttempt", () => {
  const ledgerOver = (rows) => {
    const ddb = fakeDdb(rows);
    return { ddb, ledger: new SiLedger({ ddb, table: "test-si-ledger" }) };
  };

  it("cancelled SI run flips keys to open with the attempt kept", async () => {
    // The regression this whole branch exists for: an unstamped cancelled run
    // leaves the pattern at `in-run`, and dedupeBlocked then suppresses that
    // recommendation from EVERY future PRD, with no staleness escape.
    const { ddb, ledger } = ledgerOver([inRunRow(KEY_A), inRunRow(KEY_B)]);
    const workflow = siRun({
      phase: "cancelled",
      cancelledAt: "2026-09-17T12:30:00.000Z",
      completedAt: undefined,
      delivery: undefined,
      input: { si: { prdKey: PRD, patternKeys: [KEY_A, KEY_B] } },
    });

    const { value } = await quiet(() => stampSiAttempt(workflow, "cancelled", { ledger, s3: fakeS3(null), bucket: "test-bucket" }));
    assert.deepEqual(value.stamped, [KEY_A, KEY_B]);
    assert.equal(value.outcome, "cancelled");

    for (const key of [KEY_A, KEY_B]) {
      const row = ddb.items.get(key);
      assert.equal(row.status, "open", `${key} must be filable again`);
      assert.equal(row.attempts.length, 1, "the attempt is KEPT — that we tried is the history");
      assert.equal(row.attempts[0].outcome, "cancelled");
      assert.equal(row.attempts[0].workflowId, WF);
      assert.equal(row.attempts[0].prdKey, PRD);
      assert.match(row.attempts[0].note, /cancelled before the fix shipped/);
      assert.equal(row.attempts[0].mergedAt, null);
      assert.equal(row.attempts[0].deployedAt, null);
    }
  });

  it("stamps a deployed run with its PRs and both dates, and moves the row to deployed", async () => {
    const { ddb, ledger } = ledgerOver([inRunRow(KEY_A)]);
    const s3 = fakeS3({ ...SUCCEEDED_CD, executionId: "e-99", mergeCommit: "abc123def456" });

    const { value } = await quiet(() => stampSiAttempt(siRun(), "complete", { ledger, s3, bucket: "test-bucket" }));
    assert.equal(value.outcome, "deployed");
    assert.deepEqual(s3.gets, [`workflows/${WF}/shared/cd-ledger.json`], "a succeeded ledger is the first hit — nothing else is read");

    const row = ddb.items.get(KEY_A);
    assert.equal(row.status, "deployed");
    assert.equal(row.attempts.length, 1);
    assert.deepEqual(row.attempts[0].prNumbers, [641]);
    assert.equal(row.attempts[0].mergedAt, LAST_MODIFIED.toISOString());
    assert.equal(row.attempts[0].deployedAt, LAST_MODIFIED.toISOString());
    assert.equal(row.attempts[0].epicId, "TEAM-9001");
  });

  it("is idempotent: a re-analysis updates the same attempt instead of adding one", async () => {
    const { ddb, ledger } = ledgerOver([inRunRow(KEY_A)]);
    const s3 = () => fakeS3(SUCCEEDED_CD);
    await quiet(() => stampSiAttempt(siRun(), "complete", { ledger, s3: s3(), bucket: "test-bucket" }));
    await quiet(() => stampSiAttempt(siRun(), "complete", { ledger, s3: s3(), bucket: "test-bucket" }));
    const row = ddb.items.get(KEY_A);
    assert.equal(row.attempts.length, 1);
    assert.equal(row.status, "deployed");
  });

  it("skips a run that carried no SI attempt without touching the ledger", async () => {
    const { ddb, ledger } = ledgerOver([]);
    const { value } = await quiet(() => stampSiAttempt({ workflowId: "wf-plain", input: { title: "feature" } }, "complete", { ledger, s3: fakeS3(null) }));
    assert.deepEqual(value, { skipped: "run carried no input.si" });
    assert.equal(ddb.items.size, 0);
  });

  it("closes out the keys it can when one row has gone missing", async () => {
    // A row deleted between submission and completion must not strand the rest.
    const { ddb, ledger } = ledgerOver([inRunRow(KEY_A)]);
    const workflow = siRun({ input: { si: { prdKey: PRD, patternKeys: [KEY_A, KEY_B] } } });
    const s3 = fakeS3(null, { objects: { "completions/TEAM-9001-3.json": { ...SHIP, outcome: null } } });
    const { value, lines } = await quiet(() => stampSiAttempt(workflow, "complete", { ledger, s3, bucket: "test-bucket" }));
    assert.deepEqual(value.stamped, [KEY_A]);
    assert.deepEqual(value.failed, [KEY_B]);
    assert.equal(ddb.items.get(KEY_A).status, "landed");
    assert.ok(lines.some((l) => l.includes(`${KEY_B} NOT stamped`)));
  });

  it("never throws — an ANALYZE must not be lost to a ledger write failure", async () => {
    const { ddb, ledger } = ledgerOver([inRunRow(KEY_A)]);
    ddb.failPuts = true;
    const { value, lines } = await quiet(() =>
      stampSiAttempt(siRun(), "complete", { ledger, s3: fakeS3({ mergeCommit: "abc" }), bucket: "test-bucket" }));
    assert.deepEqual(value.failed, [KEY_A]);
    assert.deepEqual(value.stamped, []);
    assert.ok(lines.some((l) => /NOT stamped/.test(l)));
  });
});

// ── Ship-phase evidence: the four real runs (TEAM-5591) ──────────────────────
//
// fixtures/si-evidence-*.json hold the S3 bodies of each run's cd-ledger and
// ship completion record byte-for-byte (as strings), plus the workflow row's
// agentTasks / delivery / input.si. All four were recorded `error` with
// "cd-ledger=absent" while these exact objects existed.

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/si-evidence-${name}.json`, import.meta.url), "utf8"));

/** The fixture's S3 objects, served from their real keys; anything else is a 404. */
function fixtureS3(fx, { withLedger = true, withShip = true } = {}) {
  const objects = {};
  if (withShip && fx.shipRecord) objects[fx.shipRecord.key] = fx.shipRecord.body;
  return fakeS3(withLedger ? fx.cdLedger.body : null, { lastModified: new Date(fx.cdLedger.lastModified), objects });
}

/** The fixture's run, as stampSiAttempt sees it (input.si filled in when the run carried none). */
function fixtureRun(fx) {
  const wf = structuredClone(fx.workflow);
  if (!wf.input?.si) wf.input = { si: { prdKey: "fixture-prd", patternKeys: [KEY_A] } };
  return wf;
}

async function stampFixture(fx, opts) {
  const ddb = fakeDdb([]);
  const ledger = new SiLedger({ ddb, table: "test-si-ledger" });
  const wf = fixtureRun(fx);
  for (const key of wf.input.si.patternKeys) {
    await ledger.put(applyAttempt(inRunRow(key), { prdKey: wf.input.si.prdKey, workflowId: wf.workflowId, outcome: "in-run" }));
  }
  const s3 = fixtureS3(fx, opts);
  const { value } = await quiet(() => stampSiAttempt(wf, "complete", { ledger, s3, bucket: "test-bucket" }));
  return { value, ddb, s3, wf };
}

describe("Ship-phase evidence — real fixtures", () => {
  it("db9sx9: a succeeded cd-ledger → deployed at deployCompletedAt, merged at startedAt, PR #828 with prUrl null", async () => {
    const fx = fixture("db9sx9");
    assert.equal(fx.workflow.prUrl, null);
    const { value, ddb, s3 } = await stampFixture(fx);
    assert.equal(value.outcome, "deployed");
    assert.deepEqual(s3.gets, [fx.cdLedger.key], "first hit: no completion record is read");
    const a = ddb.items.get("orchestrator.cascade-gap").attempts.at(-1);
    assert.equal(a.outcome, "deployed");
    assert.equal(a.deployedAt, "2026-10-09T08:33:23.000Z");
    assert.equal(a.mergedAt, "2026-10-09T07:46:00.000Z");
    assert.deepEqual(a.prNumbers, [828]);
    assert.match(a.note, /merge afb659ee83c6/);
    assert.equal(ddb.items.get("orchestrator.cascade-gap").status, "deployed");
  });

  for (const [name, ticket, pr, merge, keys] of [
    ["nmc86c", "TEAM-5433", 826, "1c14e7045e82", ["orchestrator.verdict-blind-flow", "intake.scope"]],
    ["17w716", "TEAM-5434", 825, "7c9e0a8e0f57", ["metrics.card.time-blind-spot"]],
    ["j2cawv", "TEAM-5454", 830, "3e03176a4cab", [KEY_A]],
  ]) {
    it(`${name}: ledger without terminal/succeeded + shipped ${ticket} → deployed (a′), PR #${pr}`, async () => {
      const fx = fixture(name);
      const ship = JSON.parse(fx.shipRecord.body);
      const { value, ddb, s3 } = await stampFixture(fx);
      assert.equal(value.outcome, "deployed");
      assert.equal(s3.gets[1], `completions/${ticket}.json`, "the agentTasks-tagged ship ticket is probed first");
      for (const key of keys) {
        const a = ddb.items.get(key).attempts.at(-1);
        assert.equal(a.outcome, "deployed");
        assert.equal(a.deployedAt, ship.completed_at);
        assert.equal(a.mergedAt, new Date(fx.cdLedger.lastModified).toISOString());
        assert.deepEqual(a.prNumbers, [pr]);
        assert.match(a.note, /deployedAt from ship record .* \(cd-ledger has no deployCompletedAt\)/);
        assert.match(a.note, new RegExp(`merge ${merge}`));
      }
    });
  }

  it("negative: a ledger that terminated succeeded:false, no ship record → error, with the reason probed", async () => {
    const fx = fixture("negative-deploy-failed");
    const { value, ddb, wf } = await stampFixture(fx);
    assert.equal(value.outcome, "error");
    const a = ddb.items.get(wf.input.si.patternKeys[0]).attempts.at(-1);
    assert.equal(a.deployedAt, null);
    assert.equal(a.mergedAt, null);
    assert.match(a.note, /cd-ledger\.json \(present-not-succeeded\)/);
    assert.equal(ddb.items.get(wf.input.si.patternKeys[0]).status, "open");
  });

  it("synthetic: delivery=cd, prUrl null — valid ledger → deployed; ledger deleted → error naming every probed key", async () => {
    const fx = fixture("db9sx9");
    const present = await stampFixture(fx);
    assert.equal(present.value.outcome, "deployed");

    // Deleted ledger AND no ship report (the shipped record would rightly make it `landed`).
    const gone = await stampFixture(fx, { withLedger: false, withShip: false });
    assert.equal(gone.value.outcome, "error");
    const note = gone.value.attempt.note;
    assert.match(note, new RegExp(`probed: s3://test-bucket/workflows/${fx.workflowId}/shared/cd-ledger\\.json \\(404\\)`));
    assert.match(note, /s3:\/\/test-bucket\/completions\/TEAM-5431\.json \(404\)/);
    assert.doesNotMatch(note, /cd-ledger=absent/);
  });

  it("ledger deleted but the ship record survives → landed at the record's time, never error", async () => {
    const fx = fixture("17w716");
    const { value } = await stampFixture(fx, { withLedger: false });
    assert.equal(value.outcome, "landed");
    assert.equal(value.attempt.mergedAt, JSON.parse(fx.shipRecord.body).completed_at);
    assert.deepEqual(value.attempt.prNumbers, [825]);
  });

  // Finding: the resolver stopped at the first merge record before checking a
  // later one against the ledger's execution. The ledger here is nmc86c's real
  // (unwatched) one, so e1 is its executionId and TEAM-5433 its real record.
  const twoShips = (newerExecution) => {
    const fx = fixture("nmc86c");
    const cd = JSON.parse(fx.cdLedger.body);
    const wf = fixtureRun(fx);
    wf.agentTasks["TEAM-9999"] = { ticketId: "TEAM-9999", agentId: "release-manager", outcome: "shipped", mergeCommit: "ffff", completedAt: "2099-01-01T00:00:00.000Z" };
    const newer = { ticket_id: "TEAM-9999", outcome: "shipped", merge_commit: "ffff0000ffff0000", pipeline_execution_id: newerExecution, completed_at: "2026-10-10T00:00:00.000Z" };
    const s3 = fakeS3(fx.cdLedger.body, {
      lastModified: new Date(fx.cdLedger.lastModified),
      objects: { "completions/TEAM-9999.json": newer, [fx.shipRecord.key]: fx.shipRecord.body },
    });
    return { fx, cd, wf, s3 };
  };

  it("a newer ship record for another execution does not hide the older one that confirms the ledger (a′)", async () => {
    const { fx, cd, wf, s3 } = twoShips("e2-not-the-ledgers");
    const { value } = await quiet(() => stampSiAttempt(wf, "complete", { ledger: new SiLedger({ ddb: fakeDdb([]), table: "test-si-ledger" }), s3, bucket: "test-bucket" }));
    assert.equal(s3.gets[1], "completions/TEAM-9999.json", "the newer tagged ticket is probed first");
    assert.equal(value.outcome, "deployed");
    assert.equal(value.attempt.deployedAt, JSON.parse(fx.shipRecord.body).completed_at);
    assert.match(value.attempt.note, new RegExp(`execution ${cd.executionId}`));
    assert.match(value.attempt.note, /ship record TEAM-5433/);
    assert.match(value.attempt.note, /completions\/TEAM-9999\.json \(merge_commit, execution e2-not-the-ledgers is not the ledger's\)/);
  });

  it("when no record confirms the ledger's execution, the first merge record still lands it (b)", async () => {
    const { fx, wf } = twoShips("e2-not-the-ledgers");
    const s3 = fakeS3(fx.cdLedger.body, {
      lastModified: new Date(fx.cdLedger.lastModified),
      objects: { "completions/TEAM-9999.json": { outcome: "shipped", merge_commit: "ffff0000ffff0000", pipeline_execution_id: "e2-not-the-ledgers", completed_at: "2026-10-10T00:00:00.000Z" } },
    });
    const { value } = await quiet(() => stampSiAttempt(wf, "complete", { ledger: new SiLedger({ ddb: fakeDdb([]), table: "test-si-ledger" }), s3, bucket: "test-bucket" }));
    assert.equal(value.outcome, "landed");
    assert.equal(value.attempt.mergedAt, "2026-10-10T00:00:00.000Z");
    assert.match(value.attempt.note, /ship record TEAM-9999/);
  });

  it("a Build record with pr_url and no merge_commit ahead of the ship ticket: probed, skipped, its PR not counted", async () => {
    const url = (n) => `https://github.com/o/r/pull/${n}`;
    const wf = {
      workflowId: "wf-si-union",
      phase: "complete",
      input: { si: { prdKey: PRD, patternKeys: [KEY_A] } },
      delivery: { mode: "cd", prUrl: url(102) },
      agentTasks: {
        "BUILD-1": { ticketId: "BUILD-1", agentId: "dev", prUrl: url(101), completedAt: "2026-10-09T09:00:00.000Z" },
        "SHIP-1": { ticketId: "SHIP-1", agentId: "release-manager", completedAt: "2026-10-09T08:00:00.000Z" },
      },
    };
    const cd = { pipeline: "p", executionId: "e9", mergeCommit: "abc123", prUrl: url(103) };
    const s3 = fakeS3(cd, {
      objects: {
        "completions/BUILD-1.json": { ticket_id: "BUILD-1", outcome: "done", pr_url: url(105) },
        "completions/SHIP-1.json": { ticket_id: "SHIP-1", outcome: "shipped", pipeline_execution_id: "e9", merge_commit: "abc123", pr_url: url(104), completed_at: "2026-10-09T08:30:00.000Z" },
      },
    });
    const ddb = fakeDdb([inRunRow(KEY_A, { workflowId: wf.workflowId })]);
    const ledger = new SiLedger({ ddb, table: "test-si-ledger" });
    const { value } = await quiet(() => stampSiAttempt(wf, "complete", { ledger, s3, bucket: "test-bucket" }));
    assert.deepEqual(s3.gets.slice(1), ["completions/BUILD-1.json", "completions/SHIP-1.json"], "the Build record is newer, so it is probed first");
    assert.equal(value.outcome, "deployed");
    assert.match(value.attempt.note, /completions\/BUILD-1\.json \(no merge_commit\), s3:\/\/test-bucket\/completions\/SHIP-1\.json \(200\)/);
    assert.deepEqual(ddb.items.get(KEY_A).attempts.at(-1).prNumbers, [101, 102, 103, 104]);
  });

  it("ship-ticket candidates: tagged tickets first, human gates never probed, capped", () => {
    const fx = fixture("nmc86c");
    const ids = shipTicketCandidates(fx.workflow);
    assert.equal(ids[0], "TEAM-5433");
    assert.ok(!ids.some((id) => fx.workflow.agentTasks[id]?.agentId?.startsWith("human:")));
    const many = { agentTasks: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`T-${i}`, { agentId: "dev" }])) };
    assert.equal(shipTicketCandidates(many).length, 20);
  });
});

// ── the cancelled/errored-run sweep (AC4) ────────────────────────────────────

describe("terminalPhaseOf", () => {
  it("reads a row as cancelled on cancelledAt alone, since the phase can lag it", () => {
    assert.equal(terminalPhaseOf({ phase: "development", cancelledAt: "2026-09-17T12:30:00.000Z" }), "cancelled");
    assert.equal(terminalPhaseOf({ phase: "cancelled" }), "cancelled");
  });

  it("passes the other terminal phases through, and is null while the run is live", () => {
    assert.equal(terminalPhaseOf({ phase: "complete" }), "complete");
    assert.equal(terminalPhaseOf({ phase: "deploy-blocked" }), "deploy-blocked");
    assert.equal(terminalPhaseOf({ phase: "development" }), null);
    assert.equal(terminalPhaseOf(null), null);
  });
});

describe("siReapScan", () => {
  const over = (ledgerRows, workflowRows) => {
    const ddb = fakeDdb(ledgerRows);
    return { ddb, ledger: new SiLedger({ ddb, table: "test-si-ledger" }), client: fakeWorkflows(workflowRows) };
  };
  const cancelledRun = (overrides = {}) => siRun({
    phase: "cancelled",
    cancelledAt: "2026-09-17T12:30:00.000Z",
    completedAt: undefined,
    delivery: undefined,
    input: { si: { prdKey: PRD, patternKeys: [KEY_A, KEY_B] } },
    ...overrides,
  });

  it("cancelling a fixture SI run flips its keys back to open with the attempt recorded", async () => {
    // AC4 end-to-end: nobody re-analyses a cancelled run (the cancel route emits
    // no EventBridge outcome and the watch loop skips terminal rows), so the sweep
    // is the ONLY thing that closes this attempt out.
    const { ddb, ledger, client } = over([inRunRow(KEY_A), inRunRow(KEY_B)], [cancelledRun()]);

    const { value } = await quiet(() => siReapScan({ ledger, client, s3: fakeS3(null), bucket: "test-bucket" }));

    assert.equal(value.candidates, 2);
    assert.equal(value.live, 0);
    // One stamp, not two: closing the first key closes every key its run carried.
    assert.equal(value.reaped.length, 1);
    assert.deepEqual(value.reaped[0].stamped, [KEY_A, KEY_B]);
    assert.equal(value.reaped[0].outcome, "cancelled");

    for (const key of [KEY_A, KEY_B]) {
      const row = ddb.items.get(key);
      assert.equal(row.status, "open", `${key} must be filable again`);
      const attempt = row.attempts.find((a) => a.workflowId === WF);
      assert.ok(attempt, `${key} must keep the attempt that was tried`);
      assert.equal(attempt.outcome, "cancelled");
      assert.match(attempt.note, /cancelled/);
    }
  });

  it("a second sweep is a no-op — the cleared in-run status is the marker", async () => {
    const { ddb, ledger, client } = over([inRunRow(KEY_A), inRunRow(KEY_B)], [cancelledRun()]);
    await quiet(() => siReapScan({ ledger, client, s3: fakeS3(null), bucket: "test-bucket" }));
    const after = JSON.stringify([...ddb.items.values()]);

    const s3 = fakeS3(null);
    const gets = client.gets.length;
    const { value } = await quiet(() => siReapScan({ ledger, client, s3, bucket: "test-bucket" }));

    assert.equal(value.candidates, 0, "no row is in-run any more");
    assert.deepEqual(value.reaped, []);
    assert.equal(client.gets.length, gets, "the workflows table is not read again");
    assert.equal(s3.gets.length, 0, "the cd-ledger is not read again");
    assert.equal(JSON.stringify([...ddb.items.values()]), after, "no row is rewritten");
  });

  it("closes an errored run the same way, back to open", async () => {
    const { ddb, ledger, client } = over(
      [inRunRow(KEY_A)],
      [siRun({ phase: "error", input: { si: { prdKey: PRD, patternKeys: [KEY_A] } } })],
    );
    const { value } = await quiet(() => siReapScan({ ledger, client, s3: fakeS3(null), bucket: "test-bucket" }));
    assert.equal(value.reaped[0].outcome, "error");
    const row = ddb.items.get(KEY_A);
    assert.equal(row.status, "open");
    assert.equal(row.attempts.at(-1).outcome, "error");
  });

  it("leaves a run that is still in flight alone", async () => {
    const { ddb, ledger, client } = over([inRunRow(KEY_A)], [siRun({ phase: "development", completedAt: undefined })]);
    const { value } = await quiet(() => siReapScan({ ledger, client, s3: fakeS3(null), bucket: "test-bucket" }));
    assert.equal(value.live, 1);
    assert.deepEqual(value.reaped, []);
    assert.equal(ddb.items.get(KEY_A).status, "in-run");
  });

  it("never reads the workflows table for a row that is not in-run", async () => {
    const landed = applyAttempt(inRunRow(KEY_A), { prdKey: PRD, workflowId: WF, outcome: "landed", mergedAt: "2026-09-10T00:00:00.000Z" });
    const { ledger, client } = over([landed], [siRun()]);
    const { value } = await quiet(() => siReapScan({ ledger, client, s3: fakeS3(null), bucket: "test-bucket" }));
    assert.equal(value.candidates, 0);
    assert.deepEqual(client.gets, []);
  });

  it("leaves a row in-run — never inventing an outcome — when its run has vanished", async () => {
    const { ddb, ledger, client } = over([inRunRow(KEY_A)], []);
    const { value, lines } = await quiet(() => siReapScan({ ledger, client, s3: fakeS3(null), bucket: "test-bucket" }));
    assert.deepEqual(value.reaped, []);
    assert.equal(ddb.items.get(KEY_A).status, "in-run");
    assert.ok(lines.some((l) => l.includes("no longer exists")));
  });

  it("survives a ledger scan failure without failing the watch scan around it", async () => {
    const ledger = { async list() { throw new Error("ProvisionedThroughputExceededException"); } };
    const { value, lines } = await quiet(() => siReapScan({ ledger, client: fakeWorkflows([]) }));
    assert.deepEqual(value, { candidates: 0, live: 0, reaped: [] });
    assert.ok(lines.some((l) => l.includes("ledger scan failed")));
  });
});

describe("watchScan", () => {
  it("closes out the cancelled SI run before it watches anything, and invokes no harness", async () => {
    const ddb = fakeDdb([inRunRow(KEY_A)]);
    const ledger = new SiLedger({ ddb, table: "test-si-ledger" });
    const cancelled = siRun({
      phase: "cancelled",
      cancelledAt: "2026-09-17T12:30:00.000Z",
      completedAt: undefined,
      delivery: undefined,
      input: { si: { prdKey: PRD, patternKeys: [KEY_A] } },
    });
    const client = fakeWorkflows([cancelled]);
    const invoke = () => { throw new Error("the sweep must not invoke the harness"); };

    const { value } = await quiet(() => watchScan({ client, ledger, s3: fakeS3(null), bucket: "test-bucket", invoke }));

    assert.equal(value.active, 0, "a cancelled row is not a live run");
    assert.deepEqual(value.watched, []);
    assert.equal(value.si.reaped.length, 1);
    assert.equal(ddb.items.get(KEY_A).status, "open");
  });
});

// ── the D5 persistence check ─────────────────────────────────────────────────

describe("analysisIdsFor", () => {
  it("collects every analysis id for the run, across pages, projecting only the id", async () => {
    const client = fakeAnalyses([
      { Items: [{ analysisId: "1758100000000-aaaa" }], LastEvaluatedKey: { workflowId: WF, analysisId: "1758100000000-aaaa" } },
      { Items: [{ analysisId: "1758200000000-bbbb" }] },
    ]);
    const ids = await analysisIdsFor(WF, { client, table: "test-analyses" });
    assert.deepEqual([...ids].sort(), ["1758100000000-aaaa", "1758200000000-bbbb"]);
    assert.equal(client.calls[0].ProjectionExpression, "analysisId");
    assert.equal(client.calls.length, 2);
  });

  it("reads strongly consistent on every page, so a just-saved row is seen (TEAM-5229 N3)", async () => {
    const client = fakeAnalyses([
      { Items: [{ analysisId: "1758100000000-aaaa" }], LastEvaluatedKey: { workflowId: WF, analysisId: "1758100000000-aaaa" } },
      { Items: [{ analysisId: "1758200000000-bbbb" }] },
    ]);
    await analysisIdsFor(WF, { client, table: "test-analyses" });
    assert.equal(client.calls.length, 2);
    for (const call of client.calls) {
      assert.equal(call.ConsistentRead, true);
      assert.equal(call.IndexName, undefined, "base table: a GSI cannot be read consistently");
    }
  });

  it("is an empty set for a run that has never been analyzed", async () => {
    const ids = await analysisIdsFor(WF, { client: fakeAnalyses([{ Items: [] }]) });
    assert.equal(ids.size, 0);
  });

  it("is null — not empty — when the read fails", async () => {
    const { value } = await quiet(() => analysisIdsFor(WF, { client: fakeAnalyses([], { error: new Error("throttled") }) }));
    assert.equal(value, null);
  });
});

describe("analysisDelta", () => {
  it("reports the ids this session added", () => {
    assert.deepEqual(analysisDelta(new Set(["old"]), new Set(["old", "new"])), ["new"]);
  });

  it("is [] when the session persisted nothing — the D5 failure", () => {
    assert.deepEqual(analysisDelta(new Set(["old"]), new Set(["old"])), []);
    assert.deepEqual(analysisDelta(new Set(), new Set()), []);
  });

  it("is null when either read failed, so a throttle cannot be read as a failed ANALYZE", () => {
    // null must not release the auto-claim: re-running a perfectly good analysis
    // costs a full harness session and overwrites nothing.
    assert.equal(analysisDelta(null, new Set(["a"])), null);
    assert.equal(analysisDelta(new Set(["a"]), null), null);
  });
});

// ── SI-VERIFY ────────────────────────────────────────────────────────────────

describe("siVerify", () => {
  it("tells the harness to run si_verify.py --apply and report it verbatim", () => {
    assert.match(SI_VERIFY_PROMPT, /^SI-VERIFY/);
    assert.match(SI_VERIFY_PROMPT, /python3 \/mnt\/workspace\/toolkit\/si_verify\.py --apply/);
    assert.match(SI_VERIFY_PROMPT, /VERBATIM/);
    // The ruling is arithmetic: no model may re-judge or re-word it, and this
    // session must not file or synthesise anything of its own.
    assert.match(SI_VERIFY_PROMPT, /do not rule on any expectation yourself/);
    assert.match(SI_VERIFY_PROMPT, /do not\s+file, batch or synthesise anything/);
  });

  it("invokes the harness with a ≥33-char session id and returns the stop reason", async () => {
    const calls = [];
    const invoke = async (prompt, session) => {
      calls.push({ prompt, session });
      return { text: "| pattern | verdict |\n| a | verified |", stopReason: "end_turn" };
    };
    const { value } = await quiet(() => siVerify({ invoke, now: 1758100000000 }));
    assert.equal(value.action, "si-verify");
    assert.equal(value.stopReason, "end_turn");
    assert.match(value.summary, /verified/);
    assert.equal(calls[0].prompt, SI_VERIFY_PROMPT);
    assert.ok(calls[0].session.length >= 33, "AgentCore requires a session id of at least 33 chars");
  });
});

// ── TEAM-5770: no ARTIFACT_BUCKET → ERROR + `unknown`, never `error` ─────────
//
// The live analyzer ran without ARTIFACT_BUCKET, so every probe was
// `s3://<ARTIFACT_BUCKET unset>/…` and siOutcome's pessimistic default stamped
// runs that had deployed (#835, #838) as `error` — "nothing shipped, the ask is
// still owed". "We could not look" is not evidence of anything.

const BUCKET_UNSET = "si-reconcile: ARTIFACT_BUCKET unset — cannot probe evidence";

describe("TEAM-5770 — ARTIFACT_BUCKET unset", () => {
  it("logs the ERROR at module load inside a process that has no ARTIFACT_BUCKET", () => {
    const env = { ...process.env };
    delete env.ARTIFACT_BUCKET;
    const indexUrl = new URL("./index.mjs", import.meta.url).href;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(indexUrl)});`], {
      env,
      encoding: "utf8",
      cwd: fileURLToPath(new URL(".", import.meta.url)),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes(BUCKET_UNSET), `module load did not console.error the message:\n${r.stderr}`);
  });

  it("one process with no ARTIFACT_BUCKET: module load AND the stamp each console.error the message", () => {
    const env = { ...process.env };
    delete env.ARTIFACT_BUCKET;
    const indexUrl = new URL("./index.mjs", import.meta.url).href;
    // log/warn go to stdout so stderr carries console.error alone — the level is what is pinned.
    const script = `
      console.log = console.warn = (...a) => process.stdout.write(a.join(" ") + "\\n");
      const { stampSiAttempt } = await import(${JSON.stringify(indexUrl)});
      const ledger = { async stampAttempt() { return { status: "in-run" }; } };
      const wf = { workflowId: "wf-child", phase: "complete", input: { si: { prdKey: "p-1", patternKeys: ["a.b"] } }, delivery: { mode: "cd" } };
      const r = await stampSiAttempt(wf, "complete", { ledger });
      process.stdout.write("OUTCOME " + r.outcome + "\\n");`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env,
      encoding: "utf8",
      cwd: fileURLToPath(new URL(".", import.meta.url)),
    });
    assert.equal(r.status, 0, r.stderr);
    const errs = r.stderr.split("\n").filter((l) => l.includes(BUCKET_UNSET));
    assert.ok(errs.some((l) => l === BUCKET_UNSET), `no module-load line on stderr:\n${r.stderr}`);
    assert.ok(errs.some((l) => l === `${BUCKET_UNSET} (run wf-child)`), `no per-stamp line on stderr:\n${r.stderr}`);
    assert.equal(errs.length, 2, r.stderr);
    assert.match(r.stdout, /OUTCOME unknown/);
  });

  it("db9sx9 with no bucket → `unknown` with the reason, ONE error line per stamp, row kept in-run", async () => {
    assert.equal(SI_BUCKET_UNSET_MSG, BUCKET_UNSET);
    const fx = fixture("db9sx9");
    const ddb = fakeDdb([]);
    const ledger = new SiLedger({ ddb, table: "test-si-ledger" });
    const wf = fixtureRun(fx);
    for (const key of wf.input.si.patternKeys) {
      await ledger.put(applyAttempt(inRunRow(key), { prdKey: wf.input.si.prdKey, workflowId: wf.workflowId, outcome: "in-run" }));
    }
    const s3 = fixtureS3(fx);
    const { value, lines, errors } = await quiet(() => stampSiAttempt(wf, "complete", { ledger, s3, bucket: "" }));

    assert.equal(value.outcome, "unknown");
    assert.deepEqual(s3.gets, [], "no S3 call without a bucket");
    assert.ok(value.attempt.note.startsWith("evidence not probed"), value.attempt.note);
    assert.match(value.attempt.note, /bucket-unset/);
    // Every candidate is probed (cd-ledger + each ship ticket), yet one line per stamp.
    assert.ok(shipTicketCandidates(wf).length > 1, "fixture must exercise several probes");
    assert.equal(lines.filter((l) => l.includes(BUCKET_UNSET)).length, 1, lines.join("\n"));
    assert.equal(errors.filter((l) => l.includes(BUCKET_UNSET)).length, 1, "the per-stamp line is console.error, not log/warn");
    for (const key of wf.input.si.patternKeys) {
      const row = ddb.items.get(key);
      assert.equal(row.status, "in-run", "the reap sweep must see it again once the bucket is set");
      assert.equal(row.attempts.at(-1).outcome, "unknown");
      assert.ok(!(row.attempts.at(-1).outcome === "error" && row.attempts.at(-1).note.includes("<ARTIFACT_BUCKET unset>")));
    }
  });

  it("db9sx9 with the bucket present: cd-ledger terminal+succeeded → deployed, no ERROR", async () => {
    const fx = fixture("db9sx9");
    const body = JSON.parse(fx.cdLedger.body);
    assert.equal(body.terminal, true);
    assert.equal(body.succeeded, true);
    const { value } = await stampFixture(fx);
    assert.equal(value.outcome, "deployed");
  });

  it("an S3 AccessDenied with no other evidence is `unknown`, not `error`", () => {
    const probes = [{ uri: "s3://b/workflows/wf/shared/cd-ledger.json", result: "AccessDenied" }];
    const r = siOutcome({ phase: "complete", workflow: { delivery: { mode: "cd" } }, cd: null, ship: null, probes });
    assert.equal(r.outcome, "unknown");
    assert.match(r.note, /AccessDenied/);
  });

  it("a body stream that dies mid-read is a failed look (its error name), not parse-error → `unknown`", async () => {
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const s3 = { async send() { return { LastModified: LAST_MODIFIED, Body: { transformToString: async () => { throw reset; } } }; } };
    const r = await quiet(() => readCdLedger(WF, { s3, bucket: "test-bucket" }));
    assert.equal(r.value.cd, null);
    assert.equal(r.value.probe.result, "ECONNRESET");
    assert.ok(r.lines.some((l) => /read failed/.test(l)), r.lines.join("\n"));

    const { value } = await quiet(() => stampSiAttempt(siRun(), "complete", { ledger: null, s3, bucket: "test-bucket" }));
    assert.equal(value.outcome, "unknown", "a transport failure is not evidence that nothing shipped");
  });

  it("a clean 404 everywhere is still `error` — the ask is genuinely owed", () => {
    const probes = [{ uri: "s3://b/workflows/wf/shared/cd-ledger.json", result: "404" }];
    const r = siOutcome({ phase: "complete", workflow: { delivery: { mode: "cd" } }, cd: null, ship: null, probes });
    assert.equal(r.outcome, "error");
  });
});
