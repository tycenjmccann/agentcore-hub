// TEAM-4760 U1 — the SI recommendation ledger, pinned against the SAME fixture
// the Workflow Manager toolkit uses.
//
// The ledger is written from two runtimes that cannot share a line of code: the
// workflow-analyzer / prd-submitter Lambdas (si-ledger.mjs, this file's subject)
// and the WM harness toolkit (deploy/workflow-manager/toolkit/si_ledger.py).
// Both write the SAME DynamoDB rows, so a disagreement about what `open` means,
// whether a cancelled attempt is kept, or which metrics a recommendation may
// promise is not a style difference — it is a ledger that lies.
//
// So the two implementations share a FIXTURE:
// deploy/workflow-manager/toolkit/fixtures/si-ledger-contract.json (its
// `_fixture.cases` explains why each case exists). test_si_ledger.py iterates
// the very same `transitions` array from Python and asserts the very same
// `expect` objects, so a change on either side fails on the other — the
// mechanism fix-lineage.json already uses for the fix-ticket predicate
// (lambda/cost-report/index.test.mjs).
//
// Two rules keep that honest and are enforced below:
//   1. an `op` the fixture names but this suite cannot dispatch FAILS (a renamed
//      export cannot quietly stop being tested), and
//   2. an `expect` key this suite does not implement FAILS (an assertion cannot
//      be added to one language only).
//
// Importing si-ledger.mjs evaluates its top-level @aws-sdk/lib-dynamodb import,
// which is resolution-only: no client is constructed here (SiLedger takes an
// injected one), so nothing reaches the network and no credentials are read.
//
// Run: `node --test lambda/workflow-analyzer/si-ledger.test.mjs` from the repo root.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ATTEMPT_OUTCOMES,
  DEFAULT_FRESH_DAYS,
  DEFAULT_OBSERVE_RUNS,
  METRIC_NAMES,
  SI_LEDGER_TABLE_DEFAULT,
  STATUSES,
  SiLedger,
  VERDICT_VALUES,
  applyAttempt,
  applyExpected,
  applyOccurrence,
  applyStatus,
  applyVerdict,
  dedupeBlocked,
  isValidKey,
  newRow,
  normalizeKey,
  statusAfterOutcome,
} from "./si-ledger.mjs";

const FIXTURE = fileURLToPath(
  new URL("../../deploy/workflow-manager/toolkit/fixtures/si-ledger-contract.json", import.meta.url),
);
const contract = JSON.parse(readFileSync(FIXTURE, "utf8"));

// The fixture's `op` names ARE the JS export names — the Python suite maps them
// to its snake_case twins, so this table is deliberately a 1:1 mirror.
const OPS = {
  newRow: (row, args) => newRow(...args),
  applyOccurrence: (row, args) => applyOccurrence(row, ...args),
  applyStatus: (row, args) => applyStatus(row, ...args),
  applyAttempt: (row, args) => applyAttempt(row, ...args),
  applyExpected: (row, args) => applyExpected(row, ...args),
  applyVerdict: (row, args) => applyVerdict(row, ...args),
  dedupeBlocked: (row, args) => dedupeBlocked(row, ...args),
};

const ROW_EXPECT_KEYS = new Set([
  "row", "status", "firstSeen", "lastSeen", "counts",
  "occurrences", "attempts", "expected", "verdicts",
]);

function assertRow(result, expect, name) {
  for (const key of Object.keys(expect)) {
    assert.ok(
      ROW_EXPECT_KEYS.has(key),
      `${name}: fixture expects "${key}", which this suite does not implement — ` +
      `add it here AND in test_si_ledger.py, never in one language only`,
    );
  }
  if (expect.row !== undefined) assert.deepStrictEqual(result, expect.row, `${name}: whole row`);
  if (expect.status !== undefined) assert.equal(result.status, expect.status, `${name}: status`);
  if (expect.firstSeen !== undefined) assert.equal(result.firstSeen, expect.firstSeen, `${name}: firstSeen`);
  if (expect.lastSeen !== undefined) assert.equal(result.lastSeen, expect.lastSeen, `${name}: lastSeen`);
  if (expect.counts !== undefined) {
    assert.deepStrictEqual({
      occurrences: result.occurrences.length,
      attempts: result.attempts.length,
      expected: result.expected.length,
      verdicts: result.verdicts.length,
    }, expect.counts, `${name}: history lengths`);
  }
  for (const field of ["occurrences", "attempts", "expected", "verdicts"]) {
    if (expect[field] !== undefined) {
      assert.deepStrictEqual(result[field], expect[field], `${name}: ${field}`);
    }
  }
}

// ── the shared contract ──────────────────────────────────────────────────────

test("METRIC_NAMES matches the fixture exactly, in order", () => {
  // scripts/check-si-ledger-parity.sh asserts the same thing textually, so the
  // list cannot drift even in a change that never runs this suite.
  assert.deepStrictEqual([...METRIC_NAMES], contract.metricNames);
});

test("the three enums match the fixture", () => {
  assert.deepStrictEqual([...STATUSES], contract.statuses);
  assert.deepStrictEqual([...ATTEMPT_OUTCOMES], contract.attemptOutcomes);
  assert.deepStrictEqual([...VERDICT_VALUES], contract.verdictValues);
});

test("statusAfterOutcome maps every outcome as the fixture says", () => {
  for (const [outcome, status] of Object.entries(contract.statusAfterOutcome)) {
    assert.equal(statusAfterOutcome(outcome), status, `outcome ${outcome}`);
  }
  // Every outcome in the enum is covered, so a new outcome cannot be added
  // without deciding (in the fixture) where it leaves the row.
  assert.deepStrictEqual(Object.keys(contract.statusAfterOutcome).sort(), [...ATTEMPT_OUTCOMES].sort());
  assert.throws(() => statusAfterOutcome("merged"), /invalid attempt outcome/);
});

test("isValidKey accepts the fixture's valid keys and rejects its invalid ones", () => {
  for (const key of contract.keys.valid) assert.equal(isValidKey(key), true, `valid: ${JSON.stringify(key)}`);
  for (const key of contract.keys.invalid) assert.equal(isValidKey(key), false, `invalid: ${JSON.stringify(key)}`);
});

test("normalizeKey lands agent prose on the fixture's canonical keys", () => {
  for (const [raw, expected] of contract.keys.normalize) {
    assert.equal(normalizeKey(raw), expected, `normalize ${JSON.stringify(raw)}`);
    // Normalisation is idempotent, or two writers could disagree about the key
    // for the same pattern depending on how many times it was normalised.
    assert.equal(normalizeKey(expected), expected, `idempotent ${JSON.stringify(expected)}`);
  }
});

test("normalizeKey throws on what cannot become a key", () => {
  for (const raw of contract.keys.normalizeThrows) {
    assert.throws(() => normalizeKey(raw), /invalid patternKey/, `should throw: ${JSON.stringify(raw)}`);
  }
});

// ── the transitions, driven entirely by the fixture ──────────────────────────

test("fixture transitions: every case names an op this suite can run", () => {
  for (const c of contract.transitions) {
    assert.ok(
      OPS[c.op],
      `${c.name}: fixture op "${c.op}" has no JS binding — a renamed export must not silently stop being tested`,
    );
  }
});

for (const c of contract.transitions) {
  test(`transition: ${c.name}`, () => {
    const run = OPS[c.op];
    const input = c.row === null ? null : structuredClone(c.row);
    const before = c.row === null ? null : structuredClone(c.row);

    if (c.expect.throws !== undefined) {
      assert.throws(() => run(input, c.args), (err) => {
        assert.match(err.message, new RegExp(c.expect.throws.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      });
      if (before) assert.deepStrictEqual(input, before, `${c.name}: a throwing reducer must not mutate its input`);
      return;
    }

    const result = run(input, c.args);

    // Purity is part of the contract: callers reduce twice before writing once.
    if (before) assert.deepStrictEqual(input, before, `${c.name}: reducer mutated its input row`);

    if (c.expect.blocked !== undefined || c.expect.reason !== undefined) {
      const known = new Set(["blocked", "reason"]);
      for (const key of Object.keys(c.expect)) {
        assert.ok(known.has(key), `${c.name}: unexpected expect key "${key}" on a dedupeBlocked case`);
      }
      assert.equal(result.blocked, c.expect.blocked, `${c.name}: blocked`);
      // The reason is surfaced VERBATIM by prd-submitter and the run-analysis
      // skill, so both languages must produce the identical sentence.
      assert.equal(result.reason, c.expect.reason, `${c.name}: reason`);
      return;
    }

    assertRow(result, c.expect, c.name);
  });
}

// ── behaviour the fixture cannot express ─────────────────────────────────────

test("defaults: observeRuns is 5 and the freshness window is 14 days", () => {
  assert.equal(DEFAULT_OBSERVE_RUNS, 5);
  assert.equal(DEFAULT_FRESH_DAYS, 14);
});

test("newRow defaults its timestamps to now", () => {
  const row = newRow({ patternKey: "harness.silent-death", title: "t" });
  assert.equal(row.firstSeen, row.lastSeen);
  assert.ok(Date.parse(row.firstSeen) > 0);
  assert.equal(row.status, "open");
  assert.equal("source" in row, false, "a normal row carries no source field");
});

test("a non-ISO timestamp is rejected rather than silently becoming NaN", () => {
  assert.throws(
    () => newRow({ patternKey: "harness.silent-death", title: "t", at: "last tuesday" }),
    /not an ISO-8601 timestamp/,
  );
});

// ── the DynamoDB wrapper, against a fake client ──────────────────────────────

/**
 * Minimal DynamoDBDocumentClient stand-in: one in-memory table keyed on
 * patternKey, recording the commands it was handed. Enough to prove the
 * read-modify-write path does a FULL put of the reduced row and that the Scan is
 * paged, without any AWS in the room.
 */
class FakeDdb {
  constructor(items = {}) {
    this.items = { ...items };
    this.sent = [];
    this.scanPageSize = 2;
  }

  async send(command) {
    const name = command.constructor.name;
    const input = command.input;
    this.sent.push({ name, input });
    if (name === "GetCommand") return { Item: this.items[input.Key.patternKey] };
    if (name === "PutCommand") {
      this.items[input.Item.patternKey] = structuredClone(input.Item);
      return {};
    }
    if (name === "ScanCommand") {
      const keys = Object.keys(this.items).sort();
      const start = input.ExclusiveStartKey ? keys.indexOf(input.ExclusiveStartKey.patternKey) + 1 : 0;
      const page = keys.slice(start, start + this.scanPageSize);
      const last = start + this.scanPageSize < keys.length ? { patternKey: page[page.length - 1] } : undefined;
      return { Items: page.map((k) => this.items[k]), ...(last ? { LastEvaluatedKey: last } : {}) };
    }
    throw new Error(`FakeDdb: unexpected command ${name}`);
  }
}

test("SiLedger refuses to construct without an injected client", () => {
  assert.throws(() => new SiLedger({}), /injected DynamoDBDocumentClient/);
});

test("SiLedger falls back to the conventional table name", () => {
  const ledger = new SiLedger({ ddb: new FakeDdb() });
  assert.equal(ledger.table, process.env.SI_LEDGER_TABLE || SI_LEDGER_TABLE_DEFAULT);
});

test("upsertOccurrence creates the row, then reduces onto it", async () => {
  const ddb = new FakeDdb();
  const ledger = new SiLedger({ ddb, table: "t" });

  const created = await ledger.upsertOccurrence("Harness.Silent-Death.Exit Without Report", "Harness exits early", {
    workflowId: "wf_1", analysisId: "an_1", workflowDefId: "software-delivery", severity: "high",
    at: "2026-09-01T10:00:00.000Z",
  });
  assert.equal(created.patternKey, "harness.silent-death.exit-without-report");
  assert.equal(created.status, "open");
  assert.equal(created.occurrences.length, 1);

  // Second analysis, same run+analysis id: still one occurrence, later lastSeen.
  const again = await ledger.upsertOccurrence("harness.silent-death.exit-without-report", "Harness exits early", {
    workflowId: "wf_1", analysisId: "an_1", at: "2026-09-02T10:00:00.000Z",
  });
  assert.equal(again.occurrences.length, 1);
  assert.equal(again.lastSeen, "2026-09-02T10:00:00.000Z");
  assert.equal(again.firstSeen, "2026-09-01T10:00:00.000Z");

  // Every write is a whole-row put — never a partial update.
  const puts = ddb.sent.filter((s) => s.name === "PutCommand");
  assert.equal(puts.length, 2);
  assert.deepStrictEqual(
    Object.keys(puts[0].input.Item).sort(),
    ["attempts", "expected", "firstSeen", "lastSeen", "occurrences", "patternKey", "status", "title", "verdicts"],
  );
});

test("the batched → in-run → deployed → verified path through the wrapper", async () => {
  const ddb = new FakeDdb();
  const ledger = new SiLedger({ ddb, table: "t" });
  const key = "harness.silent-death.exit-without-report";
  await ledger.upsertOccurrence(key, "Harness exits early", {
    workflowId: "wf_1", analysisId: "an_1", at: "2026-09-01T10:00:00.000Z",
  });

  assert.equal((await ledger.markBatched([key], "prd_9"))[0].status, "batched");

  const expectedRows = await ledger.putExpected(
    key,
    [{ metric: "dead_sessions_per_run", baseline: { value: 1.4, runs: 6, window: "30d" }, target: 0.2 }],
    { prdKey: "prd_9", at: "2026-09-05T10:00:00.000Z" },
  );
  assert.equal(expectedRows.expected[0].observeRuns, DEFAULT_OBSERVE_RUNS);
  assert.equal(expectedRows.expected[0].prdKey, "prd_9");

  const inRun = await ledger.markInRun([key], { prdKey: "prd_9", workflowId: "wf_si_9", epicId: "TEAM-9" });
  assert.equal(inRun[0].status, "in-run");
  assert.deepStrictEqual(dedupeBlocked(inRun[0], { now: "2026-09-06T10:00:00.000Z" }).blocked, true);

  const deployed = await ledger.stampAttempt(key, {
    prdKey: "prd_9", workflowId: "wf_si_9", prNumbers: [430],
    mergedAt: "2026-09-06T10:00:00.000Z", deployedAt: "2026-09-06T12:00:00.000Z", outcome: "deployed",
  });
  assert.equal(deployed.status, "deployed");
  assert.equal(deployed.attempts.length, 1, "the stamp updated the in-run attempt, it did not append a second");

  const verified = await ledger.recordVerdict(key, {
    at: "2026-09-25T10:00:00.000Z", prdKey: "prd_9", verdict: "verified",
    before: { dead_sessions_per_run: 1.4 }, after: { dead_sessions_per_run: 0.1 },
  });
  assert.equal(verified.status, "verified");
  assert.equal(dedupeBlocked(verified, { now: "2026-09-26T10:00:00.000Z" }).blocked, false);
});

test("a cancelled SI run returns its keys to open, attempt intact", async () => {
  const ddb = new FakeDdb();
  const ledger = new SiLedger({ ddb, table: "t" });
  const key = "ci.recert-loop";
  await ledger.upsertOccurrence(key, "CI re-certifies twice", {
    workflowId: "wf_1", analysisId: "an_1", at: "2026-09-01T10:00:00.000Z",
  });
  await ledger.markInRun([key], { prdKey: "prd_7", workflowId: "wf_si_7", epicId: "TEAM-7" });

  const row = await ledger.stampAttempt(key, { prdKey: "prd_7", workflowId: "wf_si_7", outcome: "cancelled" });
  assert.equal(row.status, "open");
  assert.equal(row.attempts.length, 1);
  assert.equal(row.attempts[0].outcome, "cancelled");
  assert.equal(dedupeBlocked(row, { now: "2026-09-02T10:00:00.000Z" }).blocked, false);
});

test("batch writers skip a key an operator deleted; single-key writers throw", async () => {
  const ddb = new FakeDdb();
  const ledger = new SiLedger({ ddb, table: "t" });
  await ledger.upsertOccurrence("ci.recert-loop", "CI re-certifies twice", {
    workflowId: "wf_1", analysisId: "an_1", at: "2026-09-01T10:00:00.000Z",
  });

  const updated = await ledger.markBatched(["ci.recert-loop", "gone.missing"], "prd_7");
  assert.equal(updated.length, 1, "a deleted row must not fail the whole PRD submission");

  await assert.rejects(
    () => ledger.recordVerdict("gone.missing", { at: "2026-09-02T10:00:00.000Z", prdKey: "p", verdict: "verified" }),
    /no row for patternKey gone.missing/,
  );
});

test("list() walks every Scan page", async () => {
  const ddb = new FakeDdb();
  const ledger = new SiLedger({ ddb, table: "t" });
  for (const key of ["a.one", "b.two", "c.three", "d.four", "e.five"]) {
    await ledger.upsertOccurrence(key, key, { workflowId: "wf", analysisId: key, at: "2026-09-01T10:00:00.000Z" });
  }
  const rows = await ledger.list();
  assert.equal(rows.length, 5);
  assert.equal(ddb.sent.filter((s) => s.name === "ScanCommand").length, 3);
});
