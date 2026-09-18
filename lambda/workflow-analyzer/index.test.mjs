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
  stampSiAttempt,
  analysisIdsFor,
  analysisDelta,
  siVerify,
  SI_VERIFY_PROMPT,
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

/** S3 holding (or not holding) one cd-ledger object. */
function fakeS3(cd, { lastModified = LAST_MODIFIED, error } = {}) {
  return {
    gets: [],
    async send(cmd) {
      this.gets.push(cmd.input.Key);
      if (error) throw error;
      if (!cd) {
        const err = new Error("The specified key does not exist.");
        err.name = "NoSuchKey";
        throw err;
      }
      return {
        LastModified: lastModified,
        Body: { transformToString: async () => JSON.stringify(cd) },
      };
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

/** Swallow the logs the helpers write, but keep them for assertions. */
async function quiet(fn) {
  const lines = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => lines.push(a.join(" "));
  console.warn = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  try {
    return { value: await fn(), lines };
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

  it("dates both stamps from the object's LastModified, since the ledger has no timestamps", () => {
    assert.deepEqual(
      cdStamps({ mergeCommit: "abc123", executionId: "e-1" }, { lastModified: LAST_MODIFIED, fallbackAt: "2026-01-01T00:00:00.000Z" }),
      { mergedAt: LAST_MODIFIED.toISOString(), deployedAt: LAST_MODIFIED.toISOString() },
    );
  });

  it("leaves deployedAt null when no deploy was triggered", () => {
    const stamps = cdStamps({ mergeCommit: "abc123" }, { lastModified: LAST_MODIFIED });
    assert.equal(stamps.mergedAt, LAST_MODIFIED.toISOString());
    assert.equal(stamps.deployedAt, null);
  });

  it("leaves mergedAt null when nothing merged, even if an execution exists", () => {
    assert.deepEqual(cdStamps({ executionId: "e-1" }, { lastModified: LAST_MODIFIED }), {
      mergedAt: null,
      deployedAt: LAST_MODIFIED.toISOString(),
    });
  });

  it("prefers an explicit field over LastModified, and falls back to the run's own time", () => {
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

  it("is deployed only when the cd-ledger holds an execution id", () => {
    const out = siOutcome({ phase: "complete", workflow: siRun(), cd: { executionId: "e-1", mergeCommit: "abc", pipeline: "hub-r-deploy" } });
    assert.equal(out.outcome, "deployed");
    assert.match(out.note, /deployed via hub-r-deploy/);
  });

  it("is landed — not deployed — when the fix merged but no deploy was triggered", () => {
    const out = siOutcome({ phase: "complete", workflow: siRun(), cd: { mergeCommit: "abc123def456" } });
    assert.equal(out.outcome, "landed");
    assert.match(out.note, /no deploy execution recorded/);
  });

  it("never calls a ship-blocked run deployed, even though start_deploy wrote an execution id", () => {
    // The execution id is written the moment start_deploy returns — i.e. BEFORE
    // the approval gate the human then rejected. deploy-blocked = merged, not out.
    const blocked = siOutcome({ phase: "deploy-blocked", workflow: siRun({ phase: "deploy-blocked" }), cd: { executionId: "e-1", mergeCommit: "abc" } });
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

  it("refuses to imply delivery when a completed run has no merge evidence", () => {
    const out = siOutcome({ phase: "complete", workflow: siRun({ delivery: { mode: "cd" }, agentTasks: {} }), cd: null });
    assert.equal(out.outcome, "error");
    assert.match(out.note, /nothing shipped, the ask is still owed/);
    assert.match(out.note, /cd-ledger=absent/);
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
  });

  it("returns no ledger on a 404 — the run simply never triggered a deploy", async () => {
    const { value } = await quiet(() => readCdLedger(WF, { s3: fakeS3(null), bucket: "test-bucket" }));
    assert.deepEqual(value, { cd: null, lastModified: null });
  });

  it("degrades to no-evidence (never a fabricated deploy) when the read itself fails", async () => {
    const denied = Object.assign(new Error("Access Denied"), { name: "AccessDenied" });
    const { value, lines } = await quiet(() => readCdLedger(WF, { s3: fakeS3(null, { error: denied }), bucket: "test-bucket" }));
    assert.equal(value.cd, null);
    assert.ok(lines.some((l) => /cd-ledger read failed/.test(l)), "a failed look must be logged, not silent");
  });

  it("does not call S3 at all with no bucket configured", async () => {
    const s3 = fakeS3({ executionId: "e-1" });
    const { value } = await quiet(() => readCdLedger(WF, { s3, bucket: "" }));
    assert.deepEqual(value, { cd: null, lastModified: null });
    assert.deepEqual(s3.gets, []);
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
    const s3 = fakeS3({ pipeline: "hub-r-deploy", executionId: "e-99", mergeCommit: "abc123def456" });

    const { value } = await quiet(() => stampSiAttempt(siRun(), "complete", { ledger, s3, bucket: "test-bucket" }));
    assert.equal(value.outcome, "deployed");

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
    const s3 = () => fakeS3({ executionId: "e-99", mergeCommit: "abc" });
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
    const { value, lines } = await quiet(() =>
      stampSiAttempt(workflow, "complete", { ledger, s3: fakeS3({ mergeCommit: "abc" }), bucket: "test-bucket" }));
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
