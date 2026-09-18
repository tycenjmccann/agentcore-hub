// TEAM-4760 U9 — the SI ledger backfill, pinned against a committed fixture.
//
// This test runs OFFLINE and with NO dependencies: it imports
// scripts/si-ledger-backfill.mjs, which keeps `@aws-sdk/*` AND
// `lambda/workflow-analyzer/si-ledger.mjs` behind lazy imports inside main()
// for exactly this reason. If someone hoists either import to the top of that
// file, every test below fails with ERR_MODULE_NOT_FOUND — which is the guard,
// not an accident. Nothing here may import the ledger module, directly or
// transitively.
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
  buildPlan,
  classify,
  isValidPatternKey,
  maxStatus,
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
  // The pattern ends where its furthest attempt got it, never downgraded by a
  // later, less-complete one (attempt 5 landed but never deployed).
  assert.equal(keyOf("harness.silent-death").status, EXPECT.silentDeath.status);
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

test("a PRD that was written but never run is an attempt at status batched", () => {
  const a = plan.attempts.find((x) => x.attempt.prdKey.endsWith("system-20260828T171000.json"));
  assert.ok(a);
  assert.equal(a.status, "batched");
  assert.equal(a.attempt.outcome, "batched");
  assert.equal(a.attempt.workflowId, undefined);
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
  // Status survives: a backfilled `batched` attempt must not downgrade it.
  assert.equal(after.status, "verified");
  assert.equal(after.status, EXPECT.merged["gate.human-wait"]);
  assert.ok(plan.attempts.some((a) => a.patternKey === "gate.human-wait" && a.status === "batched"));
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

test("maxStatus never downgrades", () => {
  assert.equal(maxStatus("verified", "batched"), "verified");
  assert.equal(maxStatus("deployed", "landed"), "deployed");
  assert.equal(maxStatus("open", "in-run"), "in-run");
  assert.equal(maxStatus("landed", "deployed"), "deployed");
  assert.equal(maxStatus("no-effect", "deployed"), "no-effect");
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
  for (const s of plan.skipped) assert.equal(s.reason, "no-pattern-match");

  const titles = plan.skipped.map((s) => s.title);
  assert.ok(titles.some((t) => t.includes("shipped ahead of schedule")));
  assert.ok(titles.some((t) => t.includes("summary section at the top")));
  assert.ok(titles.some((t) => t.includes("rename the Past runs list header")));

  // The negatives-only run contributed no writes at all.
  assert.equal(plan.occurrences.filter((o) => o.occurrence.workflowId === "wf_ok08").length, 0);
  // The cosmetic PRD is an attempt against nothing.
  const cosmetic = plan.skipped.find((s) => s.kind === "prd");
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
  assert.ok(out.includes("skipped (no pattern matched)"));
  assert.ok(out.includes("existing (merged)"), "report does not flag merged rows");
  assert.equal(plan.occurrences.length, EXPECT.occurrences);
  assert.equal(plan.attempts.length, EXPECT.attempts);
});

test("renderPlan survives an empty plan", () => {
  const out = renderPlan(buildPlan({}));
  assert.match(out, /TOTALS\s+keys=0\s+occurrences=0\s+attempts=0\s+skipped=0\s+merged=0/);
});
