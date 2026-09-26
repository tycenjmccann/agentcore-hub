// TEAM-4121 FR-10 — the fix-ticket predicate, pinned against the SAME fixture
// the Workflow Manager toolkit uses.
//
// The performance card's "Fix tickets" row (this Lambda) and the WM's
// `fixTickets.count` (deploy/workflow-manager/toolkit/compute_metrics.py) are
// shown for the same run, so they must agree on what a fix ticket IS. Before
// this change both counted `title.startsWith("Fix:")`, which by mid-2026 was
// wrong in both directions at once — the agents had standardized on
// "Fix (review):" / "Fix (QA):" / "Fix (ship-review r2):" / "Fix (CI):", none of
// which starts with "Fix:", while a bug-fix run's own intake-planned
// "Fix: <the feature>" ticket was counted as a rework loop.
//
// The two implementations are in different languages and cannot share code, so
// they share a FIXTURE: deploy/workflow-manager/toolkit/fixtures/fix-lineage.json
// (its `_fixture.cases` explains every ticket). test_metrics.py's FixLineage
// asserts the same 16 ids from Python; the list below is copied from there
// deliberately, so a change on either side fails on the other.
//
// The JS side stops at the predicate: the card reports a NUMBER, so nothing here
// needs the kind/origin/round/tag lineage the WM computes. That asymmetry is the
// point — one shared definition of "is a fix", one place that reasons about it.
//
// Importing index.mjs evaluates its top-level `@aws-sdk/*` imports; see
// pricing.test.mjs's header for why that is safe offline and never ships.
//
// A second section at the bottom of this file covers REPORT_VERSION 7 (TEAM-4995):
// unpriced models as a visible gap, long-context rates, and the pricing-document
// shape gate. Same reason it lives here — those are the card's other cross-surface
// contracts, pinned where a reader of the card's numbers will look for them.
//
// Run: `node --test lambda/cost-report` from the repo root.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PRICING,
  LONG_CONTEXT_SPLIT,
  LONG_CONTEXT_THRESHOLD_TOKENS,
  REPORT_VERSION,
  addUsage,
  aggregateCodingUsage,
  codingLogGroupsFor,
  codingSessionGaps,
  collectInsightsRows,
  dedupeEvents,
  engineForCli,
  fixTicketIds,
  foldUnpriced,
  intakeCompletedAt,
  isFixTicket,
  isUsablePricing,
  parseCodingUsageLine,
  pricingFrom,
  queryCodingUsageRecords,
  rollupCost,
} from "./index.mjs";

const FIXTURE = fileURLToPath(
  new URL("../../deploy/workflow-manager/toolkit/fixtures/fix-lineage.json", import.meta.url),
);
const dossier = JSON.parse(readFileSync(FIXTURE, "utf8"));

// Exactly what test_metrics.py FixLineage.test_count_and_ids_in_creation_order
// asserts, in the same creation order.
const EXPECTED_IDS = [
  "LIN-10", "LIN-11", "LIN-12", "LIN-13", "LIN-14",
  "LIN-15", "LIN-16", "LIN-17", "LIN-18", "LIN-19", "LIN-21",
  "LIN-22", "LIN-23", "LIN-24", "LIN-25", "LIN-26",
];

/**
 * The dossier through cost-report's eyes. The WM reads a `tickets[]` array from
 * the ticket provider; this Lambda only ever sees the workflow row's agentTasks
 * map plus the events, so the fixture's tickets become agentTasks entries (which
 * is where `spawnedBy` and `createdAt` live on the real row).
 */
function asWorkflow(tickets = dossier.tickets) {
  const agentTasks = {};
  for (const t of tickets) {
    if (t.type === "epic") continue; // epics are not tracked as tasks
    agentTasks[t.ticketId] = {
      agentId: t.assignee, title: t.title, status: "complete",
      createdAt: t.createdAt, spawnedBy: t.spawnedBy,
    };
  }
  return { epicId: dossier.epicId, agentTasks };
}

const events = () => dedupeEvents(dossier.events);

test("the shared fixture yields the same fix tickets as the Python toolkit", () => {
  const ids = fixTicketIds(events(), [], asWorkflow());
  assert.deepEqual(ids, EXPECTED_IDS);
  assert.equal(ids.length, dossier._fixture.expected.count);
});

test("the intake-planned 'Fix:' ticket is excluded, the later one is not", () => {
  const intakeAt = intakeCompletedAt(events(), asWorkflow());
  // The boundary is the analyst's own completion, stated by the fixture.
  assert.equal(new Date(intakeAt).toISOString(), "2026-07-02T10:15:00.000Z");

  const ids = fixTicketIds(events(), [], asWorkflow());
  assert.ok(!ids.includes("LIN-3"), "LIN-3 is the work the run exists to do");
  // LIN-21 is the same legacy title shape, created after planning finished.
  assert.ok(ids.includes("LIN-21"));
});

test("no intake signal at all → nothing is excluded (overcount by one beats dropping a fix)", () => {
  const noTerminals = dossier.events.filter(
    (e) => e.type !== "agent.complete" && e.type !== "workflow.report_completion");
  assert.equal(intakeCompletedAt(noTerminals, asWorkflow()), null);
  const ids = fixTicketIds(noTerminals, [], asWorkflow());
  assert.deepEqual(ids, ["LIN-3", ...EXPECTED_IDS]);
});

test("intake completion falls back to the first task completing when agentId is gone", () => {
  // Older/pruned events carry no detail.agentId; the boundary is then the first
  // task (LIN-2, created 10:00) reporting completion — the same instant, found
  // by ticket instead of by agent.
  const pruned = dossier.events.map((e) => {
    if (e.detail?.agentId !== "agentcore_hub_requirements_analyst") return e;
    const detail = { ...e.detail };
    delete detail.agentId;
    return { ...e, detail };
  });
  const intakeAt = intakeCompletedAt(pruned, asWorkflow());
  assert.equal(new Date(intakeAt).toISOString(), "2026-07-02T10:15:00.000Z");
  assert.ok(!fixTicketIds(pruned, [], asWorkflow()).includes("LIN-3"));
});

test("ticket.created events alone are enough (a run whose workflow row was trimmed)", () => {
  // The fixture publishes ticket.created for LIN-3 (excluded), LIN-10 and LIN-13.
  const ids = fixTicketIds(events(), [], { agentTasks: {} });
  assert.deepEqual(ids, ["LIN-10", "LIN-13"]);
});

test("computed task rows are a title source too", () => {
  const rows = [{ ticketId: "LIN-99", title: "Fix (QA): a row computeAgentTasks resolved" }];
  assert.deepEqual(fixTicketIds([], rows, {}), ["LIN-99"]);
});

test("spawnedBy.kind outranks the title — provenance beats prose", () => {
  // A dev who renames the ticket does not un-file the fix.
  assert.equal(isFixTicket({ title: "Rework the flaky pricing test", spawnedBy: { kind: "qa_fix" } }), true);
  assert.equal(isFixTicket({ title: "Rework the flaky pricing test" }), false);
});

test("every title shape the fleet actually mints is recognized", () => {
  for (const title of [
    "Fix (review): intake.ts source validator — 2 findings",
    "Fix (QA): the error detail still leaks the placeholder name",
    "Fix (QA re-verify): checkS3Source — still leaks via the rawName path",
    "Fix (ship-review r1): Array.isArray guard on input.sources",
    "Fix (ship-review r12): a twelfth round is still a fix",
    "Fix (CI): npm run test:unit is red on the feature head",
    "Fix (sync-main): merge origin/main into the feature branch",
    "Fix (codex): the CLI's own finding",
    "Re-verify (QA): TEAM-4089 — re-run the live probe @ 0949f9d",
  ]) {
    assert.equal(isFixTicket({ title }), true, title);
  }
  for (const title of [
    "QA: Verify submit_workflow accepts s3:// sources",
    "Review: source validation fix",
    "Ship: source validation fix",
    "CI: Validate build and tests",
    "Fixtures: add a dossier for the lineage tests", // must not match on a prefix
    "[advisory] intake.ts — pin the vetted DNS answer",
  ]) {
    assert.equal(isFixTicket({ title }), false, title);
  }
});

test("the regression this replaced: the real titles never started with 'Fix:'", () => {
  // Documented as an assertion so the reason the predicate grew is not folklore.
  const real = [
    "Fix (review): WorkflowBoard sources list + start-route input shape — 2 findings",
    "Fix (QA): intake.ts — real SDK bodiless-403 message leaks into the S3 error detail",
    "Fix (ship-review r2): intake.ts urlGate — trailing-dot host canonicalization",
    "Fix (CI): merge origin/main into feature/TEAM-4054-…",
  ];
  for (const title of real) {
    assert.equal(title.startsWith("Fix:"), false, title); // the old predicate: missed
    assert.equal(isFixTicket({ title }), true, title);    // the new one: counted
  }
});

test("ids are deduped across the three sources and ordered by creation", () => {
  const rows = dossier.tickets.map((t) => ({ ticketId: t.ticketId, title: t.title }));
  const ids = fixTicketIds(events(), rows, asWorkflow());
  assert.deepEqual(ids, EXPECTED_IDS);
  assert.equal(new Set(ids).size, ids.length);
});

// ─── REPORT_VERSION 7 (TEAM-4995) ─────────────────────────────────────────────
//
// A model with no row in config/pricing.json used to be billed silently at
// pricing.default — a plausible number the reader had no way to distrust. v7 keeps
// billing it (dropping the spend would be worse) and says so: one gap per model,
// one `cost.unpricedModels` array, one log line. The same version adds long-context
// rates, whose threshold split happens in the Logs Insights query.

const M = 1_000_000;
const round2 = (n) => Math.round(n * 100) / 100;

/** Capture console.log for one call; returns [result, lines]. */
function capturingLog(fn) {
  const lines = [];
  const real = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    return [fn(), lines];
  } finally {
    console.log = real;
  }
}

test("REPORT_VERSION is 10 and the WM floor + web reader floor match it", () => {
  assert.equal(REPORT_VERSION, 10);
  // The WM's CARD_MIN_REPORT_VERSION (deploy/workflow-manager/toolkit/
  // compute_metrics.py) and the web reader's CURRENT_REPORT_VERSION
  // (src/lib/workflow/performance.ts) must be the SAME number: every card below
  // the WM floor is rejected (which is why a bump requires `deploy.sh --backfill`),
  // and a floor left behind accepts cards this Lambda no longer writes. TEAM-5159
  // bumped this const and performance.ts but not the WM, so the WM cited v9
  // cards written before claude_code cache tokens were billed (TEAM-5186 r6-F1).
  // Neither file can be imported here (Python; TS), so both are read as text, the
  // way the Python twin test_report_version_parity.py reads this file. Exactly
  // one match each — a moved declaration must fail, not pass vacuously.
  const declared = (rel, re) => {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    const found = [...src.matchAll(re)].map((m) => Number(m[1]));
    assert.equal(found.length, 1, `expected exactly one ${re} declaration in ${rel}, found ${found.length}`);
    return found[0];
  };
  const wm = declared("../../deploy/workflow-manager/toolkit/compute_metrics.py", /^CARD_MIN_REPORT_VERSION = (\d+)$/gm);
  const web = declared("../../src/lib/workflow/performance.ts", /^export const CURRENT_REPORT_VERSION = (\d+);/gm);
  assert.equal(wm, REPORT_VERSION,
    `deploy/workflow-manager/toolkit/compute_metrics.py CARD_MIN_REPORT_VERSION = ${wm} but REPORT_VERSION = ${REPORT_VERSION}: bump both, then deploy.sh --backfill`);
  assert.equal(web, REPORT_VERSION,
    `src/lib/workflow/performance.ts CURRENT_REPORT_VERSION = ${web} but REPORT_VERSION = ${REPORT_VERSION}`);
});

test("unpriced model lands in gaps and cost.unpricedModels (sorted, distinct)", () => {
  const pricing = { models: { priced: { input: 1, output: 1 } }, default: { input: 10, output: 50 } };
  const byAgent = {};
  const unpriced = new Set();
  // zzz twice (distinct), aaa once, and one priced model that must NOT appear.
  for (const model of ["zzz", "priced", "aaa", "zzz"]) {
    addUsage(byAgent, "dev", "persona", { model, inp: M, outp: 0 }, pricing, unpriced);
  }
  const gaps = [];
  const [models, lines] = capturingLog(() => foldUnpriced(unpriced, gaps, "wf_1"));

  assert.deepEqual(models, ["aaa", "zzz"]);
  assert.deepEqual(gaps, [
    "model aaa has no price row; billed at pricing.default",
    "model zzz has no price row; billed at pricing.default",
  ]);
  // Exactly one log line per report, whatever the number of models.
  assert.deepEqual(lines, ["[models] cost.unpriced workflowId=wf_1 models=aaa,zzz"]);
  // Billed, not dropped: 4 rows × 1M input — 3 at the default rate, 1 priced.
  assert.equal(round2(byAgent.dev.engines.persona.usd), round2(3 * 10 + 1));
});

test("a fully priced run yields cost.unpricedModels [] and logs nothing", () => {
  const pricing = { models: { m: { input: 10, output: 50 } }, default: { input: 10, output: 50 } };
  const byAgent = {};
  const unpriced = new Set();
  addUsage(byAgent, "dev", "persona", { model: "m", inp: M, outp: M }, pricing, unpriced);
  const gaps = [];
  const [models, lines] = capturingLog(() => foldUnpriced(unpriced, gaps, "wf_2"));

  assert.deepEqual(models, []);
  assert.deepEqual(gaps, []);
  assert.deepEqual(lines, []);
});

test("the unpriced set is per-report — two reports never share one", () => {
  // Regression guard for the warm-Lambda hazard: a module-global set would make
  // run 2's card inherit run 1's missing model.
  const pricing = { models: {}, default: { input: 10, output: 50 } };
  const first = new Set(), second = new Set();
  addUsage({}, "dev", "persona", { model: "only-in-run-1", inp: M, outp: 0 }, pricing, first);
  addUsage({}, "dev", "persona", { model: "only-in-run-2", inp: M, outp: 0 }, pricing, second);
  assert.deepEqual([...first], ["only-in-run-1"]);
  assert.deepEqual([...second], ["only-in-run-2"]);
});

test("addUsage bills longContext rates only above the threshold", () => {
  const pricing = {
    models: {
      g: {
        input: 5.5, output: 33, cacheReadInput: 0.55,
        longContext: { input: 11, output: 66, cacheReadInput: 1.1, thresholdInputTokens: 272_000 },
      },
    },
    default: { input: 10, output: 50 },
  };
  // The threshold is applied by the Insights query, which tags each returned row;
  // `lc` on the row is that tag, and the row's own `inp` is the SUM over the
  // group. Mirror the query's comparison here so the boundary is pinned once.
  const lcTag = (spanInput) => ({ lc: spanInput > LONG_CONTEXT_THRESHOLD_TOKENS });
  assert.equal(lcTag(272_000).lc, false, "272,000 input tokens is still standard rate");
  assert.equal(lcTag(272_001).lc, true, "the boundary is strictly greater");
  // ...and the query halves encode exactly that boundary.
  assert.deepEqual(LONG_CONTEXT_SPLIT.map(([lc, filter]) => [lc, filter]), [
    [true, "| filter i > 272000"],
    [false, "| filter i <= 272000"],
  ]);

  const bill = (spanInput) => {
    const byAgent = {};
    // claude_code: input_tokens is the uncached remainder, so 1M in / 1M out bills
    // at face value and the rate swap is the only variable.
    addUsage(byAgent, "dev", "claude_code",
      { model: "g", inp: M, outp: M, ...lcTag(spanInput) }, pricing);
    return round2(byAgent.dev.engines.claude_code.usd);
  };
  assert.equal(bill(272_000), round2(5.5 + 33));
  assert.equal(bill(272_001), round2(11 + 66));

  // A missing longContext field falls back to the row's standard rate.
  const partial = { models: { g: { input: 5.5, output: 33, longContext: { input: 11 } } }, default: { input: 10, output: 50 } };
  const byAgent = {};
  addUsage(byAgent, "dev", "claude_code", { model: "g", inp: M, outp: M, lc: true }, partial);
  assert.equal(round2(byAgent.dev.engines.claude_code.usd), round2(11 + 33));

  // A model with no longContext block is never long-context billed.
  const flat = { models: { g: { input: 5.5, output: 33 } }, default: { input: 10, output: 50 } };
  const plain = {};
  addUsage(plain, "dev", "claude_code", { model: "g", inp: M, outp: M, lc: true }, flat);
  assert.equal(round2(plain.dev.engines.claude_code.usd), round2(5.5 + 33));
});

test("per-model cacheReadInput 0.22 beats cachedInputDiscount", () => {
  const pricing = {
    models: { s: { input: 2.2, output: 11, cacheReadInput: 0.22 } },
    default: { input: 10, output: 50 },
    cachedInputDiscount: 0.5, // would price 1M reads at $1.10 if it won
  };
  const byAgent = {};
  addUsage(byAgent, "dev", "persona", { model: "s", inp: M, outp: 0, cacheRead: M }, pricing);
  assert.equal(round2(byAgent.dev.engines.persona.usd), 0.22);
});

test("loadPricing accepts a usable document and falls back on shape", () => {
  const good = {
    models: { "us.anthropic.claude-opus-5": { input: 5.5, output: 27.5 } },
    default: { input: 5.5, output: 27.5 },
  };
  assert.equal(isUsablePricing(good), true);
  const [merged, quiet] = capturingLog(() => pricingFrom(good));
  assert.equal(merged.models["us.anthropic.claude-opus-5"].input, 5.5);
  assert.equal(merged.agentcore.runtimeGbHourUsd, DEFAULT_PRICING.agentcore.runtimeGbHourUsd); // merged, not replaced
  assert.deepEqual(quiet, []);

  // Shape, not parse success — each of these is valid JSON that used to win.
  for (const bad of [
    { models: {}, default: { input: 5.5, output: 27.5 } },      // no model rows
    { models: good.models },                                    // no default pair
    { models: good.models, default: { input: 5.5 } },            // half a default
    { models: good.models, default: { input: 0, output: 27.5 } }, // not positive
    { models: good.models, default: { input: "5.5", output: "27.5" } }, // strings
    { models: [], default: { input: 5.5, output: 27.5 } },       // array, not a map
    { _comment: "half-written" },
    [], null, "nope",
  ]) {
    assert.equal(isUsablePricing(bad), false, JSON.stringify(bad));
    const [p, lines] = capturingLog(() => pricingFrom(bad));
    assert.equal(p, DEFAULT_PRICING);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[models\] pricing\.fallback reason=shape/);
  }
});

// ─── REPORT_VERSION 8 (TEAM-5152) ─────────────────────────────────────────────
//
// wf_bug_TEAM-5038's codex session cost a silent $0: its coding_usage records sat
// in the Instances runtime's log group (not the one configured), wrapped as
// {"log":"<json>"} (invisible to Insights field discovery), and the run-level gap
// check never fired because the claude sessions DID report. The fixture is those
// three records exactly as Insights returned them.

const PRICING = JSON.parse(readFileSync(new URL("../../src/config/pricing.json", import.meta.url), "utf8"));
const CODEX_5038 = JSON.parse(readFileSync(new URL("./fixtures/codex-5038-usage.json", import.meta.url), "utf8"));
const round4 = (n) => Math.round(n * 10000) / 10000;

/** Parsed + aggregated coding_usage rows, billed the way buildCard bills them. */
function billCodingUsage(messages, sessionIds, sessionAgent, pricing = PRICING) {
  const byAgent = {};
  const unpriced = new Set();
  const rows = aggregateCodingUsage(messages.map(parseCodingUsageLine), sessionIds);
  for (const row of rows) addUsage(byAgent, sessionAgent[row.sid] || "unknown", engineForCli(row.cli), row, pricing, unpriced);
  return { byAgent, unpriced, rows };
}

test("parseCodingUsageLine unwraps the Instances runtime's {\"log\": \"…\"} envelope (exact captured line)", () => {
  const terra = CODEX_5038.messages[2];
  assert.ok(terra.startsWith('{"log":"{\\"timestamp\\"'), "fixture keeps the raw wrapped shape");
  assert.deepEqual(parseCodingUsageLine(terra), {
    sid: "cc-afc80deb8c2d4487a7b182265cd4c71f", cli: "codex", model: "us.openai.gpt-5.6-terra",
    inp: 99552, outp: 2526, cacheRead: 78809, credits: 0,
  });
});

test("parseCodingUsageLine reads the unwrapped (microVM) line identically", () => {
  const inner = JSON.parse(CODEX_5038.messages[2]).log;
  assert.deepEqual(parseCodingUsageLine(inner), parseCodingUsageLine(CODEX_5038.messages[2]));
});

test("parseCodingUsageLine rejects what is not a coding_usage record", () => {
  for (const raw of [
    "not json", "", null, undefined, "[]",
    '{"log":"not json"}',
    JSON.stringify({ message: "turn_done", cli: "codex", coding_session_id: "cc-x" }),
    JSON.stringify({ log: JSON.stringify({ message: "coding_usage", cli: "codex", coding_session_id: "" }) }),
  ]) {
    assert.equal(parseCodingUsageLine(raw), null, String(raw));
  }
});

test("real data: wf_bug_TEAM-5038's codex session bills astra $10.1875 + terra $0.0963 = $10.2838", () => {
  const sid = CODEX_5038.sessionId;
  const { byAgent, unpriced, rows } = billCodingUsage(CODEX_5038.messages, [sid], { [sid]: "agentcore_hub_release_manager" });
  assert.equal(rows.length, 2, "two astra records fold into one (sid, cli, model) row");

  const codex = byAgent.agentcore_hub_release_manager.engines.codex;
  assert.ok(codex, "a codex engine exists");
  const astra = codex.byModel["us.openai.gpt-6-astra"];
  assert.deepEqual(
    [astra.inputTokens, astra.outputTokens, astra.cacheReadInputTokens],
    [3990991 + 1537659, 19346 + 10316, 3815515 + 1463178]);
  // (5,528,650 − 5,278,693)·11 + 29,662·55 + 5,278,693·1.1, per 1M
  assert.equal(round4(astra.usd), 10.1875);
  // (99,552 − 78,809)·2.2 + 2,526·13.2 + 78,809·0.22, per 1M
  assert.equal(round4(codex.byModel["us.openai.gpt-5.6-terra"].usd), 0.0963);
  assert.equal(round4(codex.usd), 10.2838);
  // cached_input_tokens is a SUBSET of input_tokens: billing it on top of the full
  // input rate would read $68.2531.
  assert.notEqual(round4(codex.usd), 68.2531);
  assert.deepEqual([...unpriced], [], "both models are priced in src/config/pricing.json");
});

test("an unpriced codex model lands in cost.unpricedModels and still bills at pricing.default", () => {
  const sid = "cc-00000000000000000000000000000001";
  const raw = JSON.stringify({ log: JSON.stringify({
    message: "coding_usage", cli: "codex", coding_session_id: sid, model: "us.openai.gpt-9-nope",
    input_tokens: M, output_tokens: 0, cached_input_tokens: 0, credits: 0,
  }) });
  const { byAgent, unpriced } = billCodingUsage([raw], [sid], { [sid]: "dev" });
  const gaps = [];
  const [models] = capturingLog(() => foldUnpriced(unpriced, gaps, "wf_x"));
  assert.deepEqual(models, ["us.openai.gpt-9-nope"]);
  assert.deepEqual(gaps, ["model us.openai.gpt-9-nope has no price row; billed at pricing.default"]);
  assert.equal(round2(byAgent.dev.engines.codex.usd), round2(PRICING.default.input));
});

test("aggregateCodingUsage drops records for sessions outside this run", () => {
  const mine = CODEX_5038.sessionId;
  const other = JSON.stringify({ message: "coding_usage", cli: "codex", coding_session_id: "cc-other",
    model: "us.openai.gpt-6-astra", input_tokens: 5, output_tokens: 5, cached_input_tokens: 0 });
  const rows = aggregateCodingUsage([other, ...CODEX_5038.messages].map(parseCodingUsageLine), [mine]);
  assert.ok(rows.every((r) => r.sid === mine));
});

test("a codex session with no usage is a named gap and marks the cost partial", () => {
  const sessions = [
    { sessionId: "cc-claude1", cli: "claude", agentId: "agentcore_hub_bug_fixer" },
    { sessionId: CODEX_5038.sessionId, cli: "codex", agentId: "agentcore_hub_release_manager" },
  ];
  const ccUsage = [{ sid: "cc-claude1", model: "claude-opus-5-5", inp: "10", outp: "20" }];
  const { gaps, unattributed } = codingSessionGaps(sessions, ccUsage, []);
  assert.deepEqual(unattributed, [
    { sessionId: CODEX_5038.sessionId, cli: "codex", agentId: "agentcore_hub_release_manager" },
  ]);
  assert.deepEqual(gaps, [
    `coding session ${CODEX_5038.sessionId} (codex, agentcore_hub_release_manager): no usage telemetry — cost not counted`,
  ]);

  // ...and once its records are read, nothing is unattributed.
  const codingUsage = aggregateCodingUsage(CODEX_5038.messages.map(parseCodingUsageLine), [CODEX_5038.sessionId]);
  const after = codingSessionGaps(sessions, ccUsage, codingUsage);
  assert.deepEqual(after, { gaps: [], unattributed: [] });
});

test("a usage row with all-zero volume does not attribute its session", () => {
  const sessions = [{ sessionId: "cc-a", cli: "codex", agentId: "dev" }];
  const { unattributed } = codingSessionGaps(sessions, [], [{ sid: "cc-a", inp: 0, outp: 0, cacheRead: 0, credits: 0 }]);
  assert.equal(unattributed.length, 1);
});

test("codingLogGroupsFor: each session's own runtime group plus the configured list, deduped", () => {
  const ec2 = "/aws/bedrock-agentcore/runtimes/agentcore_hub_coding_runtime_ec2-C56zwJ3QQ5-DEFAULT";
  const vm = "/aws/bedrock-agentcore/runtimes/agentcore_hub_coding_runtime-infasNCWad-DEFAULT";
  const arn = (id) => `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/${id}`;
  assert.deepEqual(codingLogGroupsFor([{ runtimeArn: arn("agentcore_hub_coding_runtime_ec2-C56zwJ3QQ5") }]), [ec2]);
  assert.deepEqual(codingLogGroupsFor([
    { runtimeArn: arn("agentcore_hub_coding_runtime_ec2-C56zwJ3QQ5") },
    { runtimeArn: arn("agentcore_hub_coding_runtime_ec2-C56zwJ3QQ5") },
    { runtimeArn: arn("agentcore_hub_coding_runtime-infasNCWad") },
    {},                                        // legacy row: no runtimeArn
  ], [vm, ec2]), [ec2, vm]);
  assert.deepEqual(codingLogGroupsFor([{}], []), []);
  assert.deepEqual(codingLogGroupsFor([{ runtimeArn: "garbage" }, { runtimeArn: arn('bad"id') }]), []);
});

test("engineForCli: the one cli → byEngine key map", () => {
  assert.equal(engineForCli("claude"), "claude_code");
  assert.equal(engineForCli("codex"), "codex");
  assert.equal(engineForCli("kiro"), "kiro");
  assert.equal(engineForCli("gemini"), "gemini");
  assert.equal(engineForCli(""), "unknown");
  assert.equal(engineForCli(undefined), "unknown");
});

test("kiro regression: a wrapped credits-only record bills credits × usdPerCredit under the kiro engine", () => {
  const sid = "cc-00000000000000000000000000000002";
  const raw = JSON.stringify({ log: JSON.stringify({
    message: "coding_usage", cli: "kiro", coding_session_id: sid, model: "auto",
    input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, credits: 3,
  }) });
  const { byAgent, unpriced } = billCodingUsage([raw], [sid], { [sid]: "dev" });
  const kiro = byAgent.dev.engines.kiro;
  assert.ok(kiro && !byAgent.dev.engines.codex);
  assert.equal(kiro.kiroCredits, 3);
  assert.equal(round4(kiro.usd), round4(3 * PRICING.kiro.usdPerCredit));
  assert.deepEqual([...unpriced], [], "credit-billed rows never consult model prices");
  assert.deepEqual(codingSessionGaps([{ sessionId: sid, cli: "kiro", agentId: "dev" }], [],
    aggregateCodingUsage([parseCodingUsageLine(raw)], [sid])).unattributed, []);
});

// ─── REPORT_VERSION 9 (TEAM-5158) ─────────────────────────────────────────────
//
// persona/codex/kiro report input_tokens that already include cache read + write
// (INPUT_INCLUDES_CACHE); only claude_code reports the uncached remainder. v<=8
// summed RAW input + cacheRead + cacheWrite into cost.tokens.total and divided by
// the same inflated denominator for every cache hit rate, so cache traffic was
// counted twice. v9 adds uncachedInputTokens (via uncachedInput(), the one home of
// the per-engine rule) and builds the total and the rates on it. Pricing already
// used uncachedInput() and must not move.

const K = 1000;
const ROLLUP_PRICING = {
  models: { m: { input: 3, output: 15 } },
  default: { input: 3, output: 15 },
  cachedInputDiscount: 0.1,
  cacheWriteMultiplier: { default: 1.25 },
  kiro: { usdPerCredit: 0.04 },
};
// 1000 in (600 read + 100 write already inside), 50 out — the inclusive shape.
const INCLUSIVE_ROW = { model: "m", inp: 1000 * K, outp: 50 * K, cacheRead: 600 * K, cacheWrite: 100 * K };

test("rollupCost: persona input already includes cache — total and hit rate count it once", () => {
  const byAgent = {};
  addUsage(byAgent, "dev", "persona", INCLUSIVE_ROW, ROLLUP_PRICING);
  const r = rollupCost(byAgent);
  assert.equal(r.tokens.input, 1000 * K, "tokens.input keeps the raw reported value");
  assert.equal(r.tokens.uncachedInput, 300 * K);
  assert.equal(r.tokens.total, 1050 * K); // v8: 1750k
  assert.equal(r.byEngine.persona.uncachedInputTokens, 300 * K);
  assert.equal(r.byEngine.persona.byModel.m.uncachedInputTokens, 300 * K);
  assert.equal(r.byEngine.persona.cacheHitRate, 0.6); // v8: 600/1700
  assert.equal(r.personaCacheHitRate, 0.6);
  assert.equal(r.cacheHitRate, 0.6);
});

test("rollupCost: claude_code input is already uncached — nothing subtracted", () => {
  const byAgent = {};
  addUsage(byAgent, "dev", "claude_code",
    { model: "m", inp: 300 * K, outp: 50 * K, cacheRead: 600 * K, cacheWrite: 100 * K }, ROLLUP_PRICING);
  const r = rollupCost(byAgent);
  assert.equal(r.tokens.input, 300 * K);
  assert.equal(r.tokens.uncachedInput, 300 * K);
  assert.equal(r.tokens.total, 1050 * K);
  assert.equal(r.byEngine.claude_code.cacheHitRate, 0.6);
  assert.equal(r.personaCacheHitRate, null, "no persona engine → no persona rate");
});

test("rollupCost: codex is inclusive like persona; a credits-only kiro row has no tokens and no rate", () => {
  const byAgent = {};
  addUsage(byAgent, "dev", "codex", INCLUSIVE_ROW, ROLLUP_PRICING);
  addUsage(byAgent, "qa", "kiro", { model: "auto", credits: 3 }, ROLLUP_PRICING);
  const r = rollupCost(byAgent);
  assert.equal(r.byEngine.codex.uncachedInputTokens, 300 * K);
  assert.equal(r.byEngine.codex.cacheHitRate, 0.6);
  assert.equal(r.byEngine.kiro.uncachedInputTokens, 0);
  assert.equal(r.byEngine.kiro.cacheHitRate, null);
  assert.equal(r.tokens.total, 1050 * K);
  assert.equal(r.kiroCredits, 3);
});

test("rollupCost: mixed engines roll up uncached input per engine and overall", () => {
  const byAgent = {};
  addUsage(byAgent, "a", "persona", INCLUSIVE_ROW, ROLLUP_PRICING);
  addUsage(byAgent, "b", "claude_code",
    { model: "m", inp: 200 * K, outp: 50 * K, cacheRead: 600 * K, cacheWrite: 100 * K }, ROLLUP_PRICING);
  addUsage(byAgent, "b", "codex", INCLUSIVE_ROW, ROLLUP_PRICING);
  const r = rollupCost(byAgent);
  assert.equal(r.tokens.uncachedInput, (300 + 200 + 300) * K);
  assert.equal(r.tokens.total, (1050 + 950 + 1050) * K);
  assert.equal(r.cacheHitRate, round4(1800 / 2900));
  assert.equal(r.personaCacheHitRate, 0.6);
  assert.equal(r.byEngine.claude_code.cacheHitRate, round4(600 / 900));
  // USD rollup unchanged: totals are the sum of the engines, persona split out.
  const engineUsd = Object.values(r.byEngine).reduce((s, e) => s + e.usd, 0);
  assert.equal(round4(r.totalUsd), round4(engineUsd));
  assert.equal(round4(r.personaUsd), r.byEngine.persona.usd);
  assert.equal(byAgent.a.totalUsd, r.byEngine.persona.usd, "rec.totalUsd still stamped per agent");
});

test("addUsage: pricing still bills only the uncached remainder at the full input rate", () => {
  const byAgent = {};
  addUsage(byAgent, "dev", "persona", INCLUSIVE_ROW, ROLLUP_PRICING);
  // 300k × $3 + 50k × $15 + 600k × $0.30 + 100k × $3 × 1.25, per 1M.
  assert.equal(round4(byAgent.dev.engines.persona.usd), round4(0.9 + 0.75 + 0.18 + 0.375));
});

// ─── TEAM-5173 r5-F3: coding_usage rows past Insights' 10,000-row limit ───────
//
// With 10,001 records the old query billed 10,000 and dataQuality.costPartial
// stayed false. collectInsightsRows walks the group with a @timestamp cursor and
// @ptr de-duplication; whatever it cannot prove complete is reported as such.

/** A wrapped (Instances-envelope) coding_usage line for `sid`, 10 input tokens. */
function usageLine(sid, i) {
  const inner = { timestamp: new Date(i).toISOString(), message: "coding_usage", cli: "codex",
    coding_session_id: sid, model: "us.openai.gpt-5.5", input_tokens: 10, output_tokens: 1, cached_input_tokens: 0, credits: 0.0 };
  return JSON.stringify({ log: JSON.stringify(inner) });
}

/** Insights' @timestamp rendering: "YYYY-MM-DD HH:mm:ss.SSS" in UTC. */
const insightsTs = (ms) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");

/**
 * A Logs Insights double over an in-memory store: honours the [startSec, endSec)
 * window in whole seconds, sorts ascending and truncates at `limit`, exactly like
 * `sort @timestamp asc | limit N`. Counts its calls.
 */
function fakeInsights(store, limit) {
  const calls = [];
  const run = async (groups, query, startSec, endSec) => {
    calls.push({ groups, startSec, endSec });
    assert.match(query, /sort @timestamp asc\n\| limit \d+$/);
    return store
      .filter((r) => r.ms >= startSec * 1000 && r.ms < endSec * 1000)
      .sort((a, b) => a.ms - b.ms)
      .slice(0, limit)
      .map((r) => ({ "@timestamp": insightsTs(r.ms), "@message": r.msg, "@ptr": r.ptr }));
  };
  return { run, calls };
}

const T0 = Date.UTC(2026, 8, 25, 20, 0, 0); // whole second
const SID = "cc-r5f3-0123456789abcdef";

/** n records spread evenly over `seconds` seconds starting at T0. */
function records(n, seconds) {
  return Array.from({ length: n }, (_, i) => {
    const ms = T0 + Math.floor((i * seconds * 1000) / n);
    return { ms, msg: usageLine(SID, ms), ptr: `ptr-${i}` };
  });
}

test("r5-F3: 10,001 records over several seconds are all collected and billed in full", async () => {
  const LIMIT = 10000;
  const store = records(10001, 3);
  const { run, calls } = fakeInsights(store, LIMIT);
  const res = await collectInsightsRows(run, "/aws/bedrock-agentcore/runtimes/rt1-DEFAULT", "fields @timestamp, @message\n| sort @timestamp asc\n| limit 10000", T0 / 1000 - 60, T0 / 1000 + 60, { limit: LIMIT });
  assert.equal(res.complete, true);
  assert.equal(res.pages, 2, "one full page, then the tail from the boundary second");
  assert.equal(res.rows.length, 10001, "the boundary second's re-read rows are de-duplicated by @ptr");
  assert.equal(calls[1].startSec, Math.floor(store[9999].ms / 1000), "second page starts at the last row's second");
  const billed = aggregateCodingUsage(res.rows.map((r) => parseCodingUsageLine(r["@message"])), [SID]);
  assert.equal(billed.length, 1);
  assert.equal(billed[0].inp, 10 * 10001, "full count billed — not 10,000");
});

test("r5-F3: a page that cannot advance the cursor reports complete:false", async () => {
  const LIMIT = 10000;
  // 10,001 records inside ONE second: after the first page the cursor cannot move.
  const store = records(10001, 1);
  const { run } = fakeInsights(store, LIMIT);
  const res = await collectInsightsRows(run, "g", "…\n| sort @timestamp asc\n| limit 10000", T0 / 1000 - 60, T0 / 1000 + 60, { limit: LIMIT });
  assert.equal(res.complete, false);
  assert.equal(res.reason, "no-progress");
  assert.equal(res.pages, 2, "the boundary second is re-read once before the stall is provable");
  assert.equal(res.rows.length, 10000);
});

test("r5-F3: the page cap ends the walk with complete:false", async () => {
  const LIMIT = 100;
  const store = records(1000, 100); // 10 per second → 10 pages needed
  const { run, calls } = fakeInsights(store, LIMIT);
  const res = await collectInsightsRows(run, "g", "…\n| sort @timestamp asc\n| limit 100", T0 / 1000 - 60, T0 / 1000 + 200, { limit: LIMIT, maxPages: 3 });
  assert.equal(res.complete, false);
  assert.equal(res.reason, "page-cap");
  assert.equal(res.pages, 3);
  assert.equal(calls.length, 3);
});

test("r5-F3: queryCodingUsageRecords surfaces an incomplete group as a gap and complete:false", async () => {
  const sessions = [{ sessionId: SID, cli: "codex", agentId: "a", runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/rt1" }];
  const group = "/aws/bedrock-agentcore/runtimes/rt1-DEFAULT";

  const partial = fakeInsights(records(10001, 1), 10000);
  const gaps = [];
  const res = await queryCodingUsageRecords(sessions, gaps, T0 / 1000 - 60, T0 / 1000 + 60, partial.run);
  assert.equal(res.complete, false);
  assert.equal(res.rows[0].inp, 10 * 10000, "what WAS read is still billed");
  assert.deepEqual(partial.calls[0].groups, [group]);
  assert.equal(gaps.length, 1);
  assert.match(gaps[0], new RegExp(`^coding_usage results incomplete on ${group.replace(/\//g, "\\/")} \\(no-progress after 2 page\\(s\\) of 10000\\) — codex/kiro cost understated$`));

  const full = fakeInsights(records(10001, 3), 10000);
  const gaps2 = [];
  const res2 = await queryCodingUsageRecords(sessions, gaps2, T0 / 1000 - 60, T0 / 1000 + 60, full.run);
  assert.equal(res2.complete, true);
  assert.equal(res2.rows[0].inp, 10 * 10001);
  assert.deepEqual(gaps2, []);

  // A failed group is a gap AND incomplete — the sum is a floor.
  const gaps3 = [];
  const res3 = await queryCodingUsageRecords(sessions, gaps3, 0, 1, async () => { throw new Error("ResourceNotFoundException"); });
  assert.equal(res3.complete, false);
  assert.deepEqual(res3.rows, []);
  assert.match(gaps3[0], /coding_usage query failed on .*rt1-DEFAULT: ResourceNotFoundException/);
});
