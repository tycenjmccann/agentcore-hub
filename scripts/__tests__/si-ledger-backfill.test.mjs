// TEAM-4760 U9 — the SI ledger backfill, pinned against a committed fixture.
//
// Sections 1-6 run OFFLINE and with NO dependencies: they import
// scripts/si-ledger-backfill.mjs, which keeps `@aws-sdk/*` AND
// `lambda/workflow-analyzer/si-ledger.mjs` behind lazy imports inside main()
// for exactly this reason. If someone hoists either import to the top of that
// file, every test below fails with ERR_MODULE_NOT_FOUND — which is the guard,
// not an accident, so nothing at module scope here may pull in either.
//
// Section 7 is the counterweight, and it is not optional: the pure sections can
// only check the SHAPE the plan emits, never that the ledger ACCEPTS it. So
// section 7 imports the real si-ledger.mjs (dynamically, inside each test) and
// replays the plan through the real SiLedger over a fake DynamoDB client, via
// the same `applyPlan` that `main()` calls. Those tests need
// @aws-sdk/lib-dynamodb resolvable; the rest do not.
//
// The fixture (fixtures/si-backfill-history.json) stands in for the real
// history: rows of `agentcore-hub-workflow-analyses` plus the `[SI]` PRD objects
// under `workflow-manager/synthesized-prds/`. Its `_fixture.cases` explains what
// every record is there to pin.
//
// Run: `node --test scripts/__tests__/si-ledger-backfill.test.mjs`

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  KEY_GRAMMAR,
  PATTERN_KEYS,
  STATUS_AFTER_OUTCOME,
  applyPlan,
  buildPlan,
  classify,
  deriveAttemptOutcome,
  isValidPatternKey,
  renderPlan,
} from "../si-ledger-backfill.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/si-backfill-history.json", import.meta.url));
const history = JSON.parse(readFileSync(FIXTURE, "utf8"));
const EXPECT = history._fixture.expected;

const SILENT_DEATH = /^harness\.silent-death/;
const plan = buildPlan(history);
const keyOf = (patternKey) => plan.keys.find((k) => k.patternKey === patternKey);

// ── 1. keys and the grammar ─────────────────────────────────────────────────

test("buildPlan yields at least 10 distinct patternKeys, all on-grammar", () => {
  assert.ok(plan.keys.length >= 10, `only ${plan.keys.length} keys`);
  assert.equal(plan.keys.length, EXPECT.distinctKeys);
  for (const k of plan.keys) {
    // The grammar mirrored from si-ledger.mjs isValidKey(): lowercase alnum
    // segments joined by . or -, at least two dot-segments.
    assert.match(k.patternKey, KEY_GRAMMAR, `${k.patternKey} is off-grammar`);
    assert.ok(k.patternKey.split(".").length >= 2, `${k.patternKey} has no area prefix`);
    assert.ok(isValidPatternKey(k.patternKey));
    assert.ok(k.title && k.title.length > 0, `${k.patternKey} has no title`);
  }
});

test("every emitted write names a key from the closed PATTERN_KEYS set", () => {
  for (const p of PATTERN_KEYS) assert.ok(isValidPatternKey(p), `${p} is off-grammar`);
  for (const o of plan.occurrences) assert.ok(PATTERN_KEYS.includes(o.patternKey));
  for (const a of plan.attempts) assert.ok(PATTERN_KEYS.includes(a.patternKey));
});

test("every write this script authors is stamped source=backfill", () => {
  for (const w of [...plan.occurrences, ...plan.attempts]) assert.equal(w.source, "backfill");
});

// ── 2. the silent-death pattern: the ask made 31 times, fixed 6 ─────────────

test("harness.silent-death accumulates >=30 occurrences and 6 attempts", () => {
  const key = plan.keys.find((k) => SILENT_DEATH.test(k.patternKey));
  assert.ok(key, "no harness.silent-death key in the plan");
  assert.ok(key.occurrences >= 30, `only ${key.occurrences} occurrences`);
  assert.equal(key.occurrences, EXPECT.silentDeath.occurrences);
  assert.equal(key.attempts, EXPECT.silentDeath.attempts);
  assert.equal(key.attempts, 6);

  // One occurrence per run, and each carries the run's provenance.
  const occ = plan.occurrences.filter((o) => SILENT_DEATH.test(o.patternKey));
  assert.equal(occ.length, key.occurrences);
  assert.equal(new Set(occ.map((o) => o.occurrence.workflowId)).size, occ.length);
  for (const o of occ) {
    assert.ok(o.occurrence.analysisId, "occurrence has no analysisId");
    assert.ok(o.occurrence.workflowDefId, "occurrence has no workflowDefId");
    assert.ok(o.occurrence.at, "occurrence has no timestamp");
    assert.ok(["critical", "high", "medium", "low"].includes(o.occurrence.severity));
  }
  // Occurrences are replayed oldest-first so firstSeen/lastSeen land right.
  const ats = occ.map((o) => o.occurrence.at);
  assert.deepEqual(ats, [...ats].sort());
});

test("the silent-death attempts carry real, mixed outcomes — not all one value", () => {
  const att = plan.attempts.filter((a) => SILENT_DEATH.test(a.patternKey));
  const outcomes = att.map((a) => a.attempt.outcome);
  assert.deepEqual(outcomes, EXPECT.silentDeath.outcomes);
  assert.ok(outcomes.filter((o) => o === "deployed").length >= 1, "no deployed attempt");
  assert.ok(outcomes.filter((o) => o === "landed").length >= 1, "no landed attempt");
  assert.ok(new Set(outcomes).size > 1, "every attempt has the same outcome");
  for (const a of att) {
    assert.ok(a.attempt.prdKey.endsWith(".json"), `attempt has no PRD key: ${a.attempt.prdKey}`);
    assert.ok(a.attempt.note.includes(a.attempt.prdKey));
  }
  // The pattern ends where its NEWEST attempt left it — three of these fixes
  // deployed, but TEAM-4734 is still running, so the row is `in-run`. That is
  // what applyAttempt does (statusAfterOutcome on every stamp) and it is load
  // bearing: `in-run` is what stops dedupeBlocked filing a seventh PRD while the
  // sixth is still going. Section 7 replays this through the real reducers.
  assert.equal(keyOf("harness.silent-death").status, EXPECT.silentDeath.status);
  assert.equal(EXPECT.silentDeath.status, "in-run");
});

// ── 3. a run that was still going when the ledger arrived ───────────────────

test("the TEAM-4734 attempt ends in-run, not landed", () => {
  const a = plan.attempts.find((x) => x.attempt.epicId === "TEAM-4734");
  assert.ok(a, "TEAM-4734 attempt missing from the plan");
  assert.match(a.patternKey, SILENT_DEATH);
  assert.equal(a.status, "in-run");
  assert.equal(a.attempt.outcome, "in-run");
  assert.equal(a.attempt.mergedAt, undefined, "an in-run attempt cannot have merged");
  assert.equal(a.attempt.deployedAt, undefined);
  assert.ok(a.attempt.workflowId, "in-run is only claimable with a workflowId");
});

test("a PRD that was written but never run writes NOTHING, and says so", () => {
  const prdKey = "workflow-manager/synthesized-prds/system-20260828T171000.json";
  // There is no attempt to record: attempts[] is keyed on the run that carried
  // one, `batched` is not an ATTEMPT_OUTCOMES member (applyAttempt would throw),
  // and replaying it as a `batched` STATUS write would downgrade gate.human-wait
  // from `verified` — applyStatus does not rank. So: reported, never written.
  assert.equal(deriveAttemptOutcome({ key: prdKey }), null);
  assert.equal(deriveAttemptOutcome({ key: prdKey, run: {} }), null);
  assert.equal(plan.attempts.filter((a) => a.attempt.prdKey === prdKey).length, 0);
  const s = plan.skipped.find((x) => x.prdKey === prdKey);
  assert.ok(s, "the never-run PRD is not reported at all");
  assert.equal(s.reason, "prd-never-run");
  assert.equal(s.patternKey, "gate.human-wait");
  assert.match(renderPlan(plan), /\[prd-never-run\] prd .*system-20260828T171000\.json/);
});

test("an attempt whose key has no occurrence to hang it on is dropped, not replayed", () => {
  // stampAttempt() → requireRow() THROWS on a missing row rather than mint one,
  // so a plan that emitted this would kill `--apply` half way through a write.
  const orphan = buildPlan({
    analyses: [],
    prds: [
      {
        key: "workflow-manager/synthesized-prds/orphan.json",
        title: "[SI] the requirements agent went silent mid-turn",
        run: { workflowId: "wf_orphan", mergedAt: "2026-09-01T00:00:00.000Z" },
      },
    ],
    existingRows: [],
  });
  assert.equal(orphan.occurrences.length, 0);
  assert.equal(orphan.attempts.length, 0, "an unbackable attempt stayed in the plan");
  const s = orphan.skipped.find((x) => x.reason === "attempt-without-occurrence");
  assert.ok(s, "the dropped attempt is not reported");
  assert.match(s.patternKey, SILENT_DEATH);
  // ...and the key's own summary must not claim an attempt it will not write.
  assert.equal(orphan.keys.find((k) => k.patternKey === s.patternKey).attempts, 0);
  // The same PRD IS written once an occurrence backs the key.
  const backed = buildPlan({
    analyses: [
      {
        workflowId: "wf_sd_x",
        analysisId: "an_x",
        createdAt: "2026-08-01T00:00:00.000Z",
        findings: [{ title: "dev_agent_2 went silent mid-turn", severity: "high" }],
      },
    ],
    prds: [
      {
        key: "workflow-manager/synthesized-prds/orphan.json",
        title: "[SI] the requirements agent went silent mid-turn",
        run: { workflowId: "wf_orphan", mergedAt: "2026-09-01T00:00:00.000Z" },
      },
    ],
  });
  assert.equal(backed.attempts.length, 1);
});

// ── 4. existing rows are merged, never clobbered ────────────────────────────

test("an existing verified row is merged, not reset to open or renamed", () => {
  const before = history.existingRows.find((r) => r.patternKey === "gate.human-wait");
  const after = keyOf("gate.human-wait");
  assert.ok(before && after);

  assert.equal(after.existing, true);
  // Occurrences GREW: the backfill APPENDS three new ones to the two already on
  // the row, it does not replace them (upsertOccurrence appends; the plan only
  // ever emits the new ones).
  assert.equal(before.occurrences.length, 2);
  assert.equal(after.occurrences, 3);
  assert.equal(plan.occurrences.filter((o) => o.patternKey === "gate.human-wait").length, 3);
  for (const o of plan.occurrences.filter((x) => x.patternKey === "gate.human-wait")) {
    assert.ok(
      !before.occurrences.some((b) => b.workflowId === o.occurrence.workflowId),
      "the plan re-emits an occurrence the row already has",
    );
  }
  // Status survives: the never-run PRD that names this key writes nothing at all,
  // so there is no `batched` write that could downgrade it (see prd-never-run).
  assert.equal(after.status, "verified");
  assert.equal(after.status, EXPECT.merged["gate.human-wait"]);
  assert.equal(plan.attempts.filter((a) => a.patternKey === "gate.human-wait").length, 0);
  // Title survives, on the key summary AND on every write replayed for it.
  assert.equal(after.title, before.title);
  for (const o of plan.occurrences.filter((x) => x.patternKey === "gate.human-wait")) {
    assert.equal(o.title, before.title);
  }
  // And the canonical title is NOT what got emitted.
  assert.notEqual(after.title, classify("human approval gate held the run").title);
});

test("an existing mid-rank row keeps its status when nothing promotes it", () => {
  const after = keyOf("pipeline.build-failure");
  assert.equal(after.existing, true);
  assert.equal(after.status, EXPECT.merged["pipeline.build-failure"]);
  assert.equal(after.status, "landed");
  assert.equal(after.attempts, 0);
});

test("a key with no replayed attempt keeps the status the row already holds", () => {
  // Occurrences never touch status (applyOccurrence leaves it alone — an
  // occurrence on a `verified` row is evidence of a regression, which only
  // si_verify may rule on), so the only thing that can move a status here is an
  // attempt. pipeline.build-failure gets occurrences and no attempt.
  assert.equal(keyOf("pipeline.build-failure").status, "landed");
  assert.equal(keyOf("gate.human-wait").status, "verified");
  // ...and a brand-new key seen only in analyses starts, and stays, open.
  const fresh = buildPlan({
    analyses: [
      {
        workflowId: "wf_a",
        analysisId: "an_a",
        createdAt: "2026-08-01T00:00:00.000Z",
        findings: [{ title: "the turn went silent and emitted no spans", severity: "high" }],
      },
    ],
  });
  assert.equal(fresh.keys[0].status, "open");
});

// ── 5. nothing matched means nothing matched ────────────────────────────────

test("classify returns null for text that names no pattern", () => {
  assert.equal(classify("The team shipped ahead of schedule and the PR was small"), null);
  assert.equal(classify("Keep the summary section at the top of the report"), null);
  assert.equal(classify("system: rename the Past runs list header"), null);
  assert.equal(classify(""), null);
  assert.equal(classify(undefined), null);
});

test("unmatched items are reported under skipped, never as an invented key", () => {
  assert.equal(plan.skipped.length, EXPECT.skipped);
  // Every skip names WHY, from the closed set — an unexplained skip is a write
  // that silently vanished.
  for (const s of plan.skipped) {
    assert.ok(
      ["no-pattern-match", "prd-never-run", "attempt-without-occurrence"].includes(s.reason),
      `unknown skip reason ${s.reason}`,
    );
  }
  const unmatched = plan.skipped.filter((s) => s.reason === "no-pattern-match");
  assert.equal(unmatched.length, 3);

  const titles = plan.skipped.map((s) => s.title);
  assert.ok(titles.some((t) => t.includes("shipped ahead of schedule")));
  assert.ok(titles.some((t) => t.includes("summary section at the top")));
  assert.ok(titles.some((t) => t.includes("rename the Past runs list header")));

  // The negatives-only run contributed no writes at all.
  assert.equal(plan.occurrences.filter((o) => o.occurrence.workflowId === "wf_ok08").length, 0);
  // The cosmetic PRD is an attempt against nothing.
  const cosmetic = unmatched.find((s) => s.kind === "prd");
  assert.ok(cosmetic.prdKey.endsWith("system-20260912T083000.json"));
  assert.equal(plan.attempts.filter((a) => a.attempt.prdKey === cosmetic.prdKey).length, 0);
});

test("classify prefers the specific pattern over the generic one", () => {
  // The deploy gate IS a human gate; naming it specifically must win.
  assert.equal(
    classify("the deploy gate must never be skipped; only a pre-approval may skip the human gate")
      .patternKey,
    "pipeline.deploy-gate",
  );
  assert.equal(classify("Human approval gate held the run for 14 hours").patternKey, "gate.human-wait");
  // A silent death that also mentions a timeout is a silent death.
  assert.match(classify("the turn went silent and then timed out").patternKey, SILENT_DEATH);
  const attempts = Object.fromEntries(plan.keys.map((k) => [k.patternKey, k.attempts]));
  for (const [key, n] of Object.entries(EXPECT.perKeyAttempts)) {
    assert.equal(attempts[key], n, `${key} has ${attempts[key]} attempts, expected ${n}`);
  }
});

test("applying the backfill twice appends nothing the second time", () => {
  // upsertOccurrence APPENDS, so a re-run that re-emitted everything would turn
  // "made 31 times" into 62. Fold the plan back in as existing rows and the
  // second pass must be empty.
  const existingRows = plan.keys.map((k) => ({
    patternKey: k.patternKey,
    title: k.title,
    status: k.status,
    occurrences: plan.occurrences.filter((o) => o.patternKey === k.patternKey).map((o) => o.occurrence),
    attempts: plan.attempts.filter((a) => a.patternKey === k.patternKey).map((a) => a.attempt),
  }));
  const again = buildPlan({ ...history, existingRows });
  assert.equal(again.occurrences.length, 0, "re-run would double-append occurrences");
  assert.equal(again.attempts.length, 0, "re-run would double-append attempts");
  // The report still describes the same 20 keys at the same statuses.
  assert.equal(again.keys.length, plan.keys.length);
  assert.deepEqual(
    again.keys.map((k) => [k.patternKey, k.status]),
    plan.keys.map((k) => [k.patternKey, k.status]),
  );
  for (const k of again.keys) assert.equal(k.existing, true);
});

test("classify maps the same pattern said different ways onto one key", () => {
  for (const phrasing of [
    "Requirements agent went silent for 15 minutes",
    "dev_agent_2 dropped silently with a zero-length response",
    "Silent death of the QA verifier",
    "the turn produced no spans at all",
    "Code reviewer stopped emitting spans halfway through",
  ]) {
    assert.match(classify(phrasing).patternKey, SILENT_DEATH, `missed: ${phrasing}`);
  }
});

// ── 6. the operator-facing report ───────────────────────────────────────────

test("renderPlan names every key and ends on a totals line", () => {
  const out = renderPlan(plan);
  for (const k of plan.keys) {
    assert.ok(out.includes(k.patternKey), `report omits ${k.patternKey}`);
    assert.match(out, new RegExp(`${k.patternKey.replace(/[.]/g, "\\.")}\\s+occurrences=${k.occurrences}\\b`));
  }
  assert.match(
    out,
    new RegExp(
      `TOTALS\\s+keys=${plan.keys.length}\\s+occurrences=${plan.occurrences.length}` +
        `\\s+attempts=${plan.attempts.length}\\s+skipped=${plan.skipped.length}\\s+merged=2`,
    ),
  );
  assert.ok(out.includes("skipped (nothing written)"));
  // Each skip line carries its reason — they are no longer all the same.
  for (const s of plan.skipped) assert.ok(out.includes(`[${s.reason}]`), `report omits ${s.reason}`);
  assert.ok(out.includes("existing (merged)"), "report does not flag merged rows");
  assert.equal(plan.occurrences.length, EXPECT.occurrences);
  assert.equal(plan.attempts.length, EXPECT.attempts);
});

test("renderPlan survives an empty plan", () => {
  const out = renderPlan(buildPlan({}));
  assert.match(out, /TOTALS\s+keys=0\s+occurrences=0\s+attempts=0\s+skipped=0\s+merged=0/);
});

// ── 7. the plan replayed through the REAL ledger ────────────────────────────
//
// Everything above is pure: it checks the SHAPE the plan emits. It cannot catch
// the failure that actually matters — the plan being handed to a ledger API that
// does not accept it. `main()` cannot import si-ledger.mjs at module scope (the
// script must stay stdlib-pure at import time), so nothing outside these tests
// ever type-checks that boundary, and a renamed method or a reordered argument
// would sail through every test in sections 1-6 and die on an operator's
// `--apply` half way through writing the ledger.
//
// So these tests import the REAL lambda/workflow-analyzer/si-ledger.mjs — the
// real SiLedger class over the real reducers — with ONLY the DynamoDB document
// client faked, and replay the plan through `applyPlan`, the single function
// `main()` also uses. Every status asserted below is produced by production
// code. The import is dynamic per-test so sections 1-6 keep running with no
// node_modules; si-ledger.mjs imports @aws-sdk/lib-dynamodb for its command
// shapes, so these tests (and only these) need it resolvable.

/** An in-memory DynamoDBDocumentClient: one table, keyed on patternKey. */
function fakeDdb(seed = []) {
  const items = new Map(seed.map((r) => [r.patternKey, structuredClone(r)]));
  return {
    items,
    calls: [],
    async send(cmd) {
      const name = cmd.constructor.name;
      this.calls.push(name);
      if (name === "GetCommand") {
        const hit = items.get(cmd.input.Key.patternKey);
        return { Item: hit ? structuredClone(hit) : undefined };
      }
      if (name === "PutCommand") {
        items.set(cmd.input.Item.patternKey, structuredClone(cmd.input.Item));
        return {};
      }
      if (name === "ScanCommand") return { Items: [...items.values()].map((r) => structuredClone(r)) };
      throw new Error(`fakeDdb: unexpected ${name}`);
    },
  };
}

async function realLedger(seed) {
  const { SiLedger } = await import("../../lambda/workflow-analyzer/si-ledger.mjs");
  const ddb = fakeDdb(seed);
  return { ledger: new SiLedger({ ddb, table: "si-ledger-test" }), ddb };
}

test("STATUS_AFTER_OUTCOME is the real statusAfterOutcome, member for member", async () => {
  // The mirror that caused the bug this section exists to catch: the backfill
  // used to rank statuses and predict the furthest one, which the ledger never
  // does. Pin the replacement against the real function so it cannot drift again.
  const { ATTEMPT_OUTCOMES, statusAfterOutcome } = await import("../../lambda/workflow-analyzer/si-ledger.mjs");
  assert.deepEqual(Object.keys(STATUS_AFTER_OUTCOME).sort(), [...ATTEMPT_OUTCOMES].sort());
  for (const outcome of ATTEMPT_OUTCOMES) {
    assert.equal(STATUS_AFTER_OUTCOME[outcome], statusAfterOutcome(outcome), outcome);
  }
  // And every outcome the backfill can emit is one the ledger accepts.
  for (const a of plan.attempts) assert.ok(ATTEMPT_OUTCOMES.includes(a.attempt.outcome), a.attempt.outcome);
});

test("the plan replays through the real SiLedger without a single API mismatch", async () => {
  const { ledger, ddb } = await realLedger(history.existingRows);
  const wrote = await applyPlan(ledger, plan);
  assert.equal(wrote.occurrences, plan.occurrences.length);
  assert.equal(wrote.attempts, plan.attempts.length);
  // Every key the report named now exists on the table.
  assert.equal(ddb.items.size, plan.keys.length);
  for (const k of plan.keys) assert.ok(ddb.items.has(k.patternKey), `${k.patternKey} was never written`);
});

test("the report's predicted status is the status the real reducers produce", async () => {
  const { ledger, ddb } = await realLedger(history.existingRows);
  await applyPlan(ledger, plan);
  // This is the dry run's whole promise: what it printed is what --apply does.
  for (const k of plan.keys) {
    assert.equal(ddb.items.get(k.patternKey).status, k.status, `${k.patternKey} status drifted`);
  }
});

test("replayed for real, silent-death carries 31 sightings and 6 attempts", async () => {
  const { ledger, ddb } = await realLedger(history.existingRows);
  await applyPlan(ledger, plan);
  const row = [...ddb.items.values()].find((r) => SILENT_DEATH.test(r.patternKey));
  assert.equal(row.occurrences.length, EXPECT.silentDeath.occurrences);
  assert.equal(row.attempts.length, EXPECT.silentDeath.attempts);
  assert.deepEqual(row.attempts.map((a) => a.outcome), EXPECT.silentDeath.outcomes);
  // Three of the six fixes deployed, but the newest attempt is still running.
  assert.equal(row.status, "in-run");
  assert.equal(row.status, EXPECT.silentDeath.status);
  assert.equal(row.source, "backfill", "a row this backfill minted is not stamped");
  // firstSeen/lastSeen bracket the replay, oldest-first.
  assert.ok(row.firstSeen < row.lastSeen);
});

test("replayed for real, the existing verified row is merged — not reset, not renamed", async () => {
  const before = history.existingRows.find((r) => r.patternKey === "gate.human-wait");
  const { ledger, ddb } = await realLedger(history.existingRows);
  await applyPlan(ledger, plan);
  const after = ddb.items.get("gate.human-wait");
  assert.equal(after.status, "verified", "the backfill downgraded a verified row");
  assert.equal(after.title, before.title);
  assert.equal(after.occurrences.length, before.occurrences.length + 3);
  assert.equal(after.source, undefined, "an existing row was restamped as a backfill");
});

test("replayed twice, the real ledger is byte-identical — no double-append", async () => {
  const { ledger, ddb } = await realLedger(history.existingRows);
  await applyPlan(ledger, plan);
  const once = JSON.stringify([...ddb.items.entries()].sort());
  // Pass 2 the way an operator re-runs it: re-read the table, re-plan, re-apply.
  const again = buildPlan({ ...history, existingRows: await ledger.list() });
  assert.equal(again.occurrences.length, 0);
  assert.equal(again.attempts.length, 0);
  await applyPlan(ledger, again);
  assert.equal(JSON.stringify([...ddb.items.entries()].sort()), once);
});

// ── 8. PRD → run linking (the 2026-09-18 handoff wrote 209 occurrences and 0 attempts) ──
//
// A PRD object in S3 carries no `run`; the link is the workflows row. The first
// live backfill read the wrong prefix (0 PRDs) and, once pointed at the right
// one, reported every PRD as `prd-never-run` because nothing attached the run.
// These pin the join and the phase-derived outcomes it feeds.
import { attachRuns, RUN_BLOCKED_PHASES } from "../si-ledger-backfill.mjs";

test("attachRuns links by input.si.prdKey first, then by the '[SI] ' + title convention, newest run wins", () => {
  const prds = [
    { key: "fleet-imp-agent/prd/system-1.json", title: "system: honest close" },
    { key: "fleet-imp-agent/prd/system-2.json", title: "system: binding gates" },
    { key: "fleet-imp-agent/prd/system-3.json", title: "system: never submitted" },
  ];
  const runs = [
    { workflowId: "wf_old", phase: "cancelled", startedAt: "2026-09-01T00:00:00Z", title: "[SI] system: honest close", prdKey: null },
    { workflowId: "wf_new", phase: "complete", startedAt: "2026-09-05T00:00:00Z", title: "[SI]  system:  Honest Close ", prdKey: null },
    { workflowId: "wf_keyed", phase: "verification", startedAt: "2026-09-17T00:00:00Z", title: "[SI] a retitled run", prdKey: "fleet-imp-agent/prd/system-2.json" },
    { workflowId: "wf_undef", phase: "complete", startedAt: "2026-08-01T00:00:00Z", title: "[SI] undefined", prdKey: null },
  ];
  const out = attachRuns(prds, runs);
  assert.equal(out[0].run.workflowId, "wf_new", "newest run for the title wins");
  assert.equal(out[0].run.title, undefined, "run carries no title/prdKey fields");
  assert.equal(out[1].run.workflowId, "wf_keyed", "prdKey beats title");
  assert.equal(out[2].run, undefined, "no match → no run, and '[SI] undefined' never matches anything");
});

test("deriveAttemptOutcome reads the run's terminal phase when the cd-ledger left no stamp", () => {
  const k = "fleet-imp-agent/prd/system-x.json";
  const at = (run) => deriveAttemptOutcome({ key: k, run });
  assert.deepEqual(at({ workflowId: "w", phase: "cancelled", completedAt: "t" }), { outcome: "cancelled", status: "open" });
  assert.deepEqual(at({ workflowId: "w", phase: "error", completedAt: "t" }), { outcome: "error", status: "open" });
  assert.deepEqual(at({ workflowId: "w", phase: "complete", completedAt: "t" }), { outcome: "landed", status: "landed" });
  assert.deepEqual(at({ workflowId: "w", phase: "complete", completedAt: "t", deliveryMode: "handoff" }), { outcome: "handoff", status: "landed" });
  assert.deepEqual(at({ workflowId: "w", phase: "static-ci-only", completedAt: "t" }), { outcome: "error", status: "open" });
  assert.ok(RUN_BLOCKED_PHASES.has("deploy-blocked"));
  assert.deepEqual(at({ workflowId: "w", phase: "verification" }), { outcome: "in-run", status: "in-run" });
  assert.deepEqual(at({ workflowId: "w", phase: "complete", deployedAt: "d", mergedAt: "m" }), { outcome: "deployed", status: "deployed" }, "cd-ledger stamps still win");
  assert.equal(at({ phase: "complete" }), null, "no workflowId = never run, whatever the phase says");
});

test("a landed-by-phase attempt carries NO guessed mergedAt (the dedupe window must not start on a guess)", () => {
  const plan = buildPlan({
    analyses: [{ workflowId: "wf_a", analysisId: "a1", workflowDefId: "software-delivery", createdAt: "2026-09-01T00:00:00Z",
      findings: [{ title: "Persona turn died silently mid-stream with no report_completion", severity: "P1" }] }],
    prds: attachRuns(
      [{ key: "fleet-imp-agent/prd/system-9.json", title: "system: silent-death recovery", description: "harness silent death auto-resume" }],
      [{ workflowId: "wf_si", phase: "complete", startedAt: "2026-09-02T00:00:00Z", completedAt: "2026-09-03T00:00:00Z", title: "[SI] system: silent-death recovery", prdKey: null }],
    ),
  });
  const a = plan.attempts.find((x) => x.attempt.prdKey === "fleet-imp-agent/prd/system-9.json");
  assert.ok(a, "the PRD became an attempt");
  assert.equal(a.attempt.outcome, "landed");
  assert.equal(a.attempt.workflowId, "wf_si");
  assert.equal(a.attempt.mergedAt ?? null, null);
  assert.equal(a.attempt.deployedAt ?? null, null);
});
