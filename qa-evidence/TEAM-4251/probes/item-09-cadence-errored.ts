/**
 * Item 9 probe + reviewer finding F10 — does the cadence check count an
 * ERRORED / CANCELLED prior sweep as a "recent sweep"?
 *
 * Imports the REAL src/lib/workflow/sweep-cadence.ts (pure: no AWS, no fetch, no
 * clock of its own — the caller supplies rows/pulls/now, so nothing is stubbed).
 * Run with `npx vite-node` because the module is TypeScript.
 */
import {
  evaluateSweepCadence,
  evaluateSweepGate,
  normalizeSweepCadenceMode,
  buildSkipTombstone,
  skipTombstoneId,
  SWEEP_CADENCE_DAYS,
  SWEEP_DEF_ID,
  type SweepWorkflowRow,
} from "../../../src/lib/workflow/sweep-cadence";

const REPO = "tycenjmccann/ember";
const NOW = Date.parse("2026-09-08T00:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const row = (phase: string | undefined, over: Partial<SweepWorkflowRow> = {}): SweepWorkflowRow => ({
  workflowId: `wf_${phase ?? "none"}`,
  workflowDefId: SWEEP_DEF_ID,
  phase,
  startedAt: daysAgo(3),
  completedAt: daysAgo(3),
  input: { repoConfig: { repos: [{ url: `https://github.com/${REPO}` }] } } as never,
  ...over,
});

console.log(`SWEEP_CADENCE_DAYS = ${SWEEP_CADENCE_DAYS}   SWEEP_DEF_ID = ${SWEEP_DEF_ID}`);
console.log(`now = ${new Date(NOW).toISOString()}   every prior row below is 3 days old\n`);

console.log("=== 9.1  F10 — which prior-run PHASES count as a recent sweep? ===");
const PHASES = [
  "complete",
  "nothing-to-remove",
  "error",
  "cancelled",
  "deploy-blocked",
  "static-ci-only",
  "development",
  undefined,
];
for (const p of PHASES) {
  const r = evaluateSweepCadence({ repo: REPO, rows: [row(p)], now: NOW });
  console.log(
    `  phase=${String(p).padEnd(18)} skip=${String(r?.skip ?? null).padEnd(13)} runsConsidered=${r?.evidence.runsConsidered ?? "-"}  ageDays=${r?.evidence.ageDays ?? "-"}`,
  );
}
console.log("  --> EVERY phase counts. sweepHistoryEvidence's filter (sweep-cadence.ts:163-170)");
console.log("      tests deleted!==true, type!=='skipped', workflowDefId and repo — NEVER phase.");

console.log("\n=== 9.2  the failure F10 describes, end to end ===");
const errored = row("error", { workflowId: "wf_crashed", completedAt: daysAgo(1) });
const g = evaluateSweepGate({ repo: REPO, rows: [errored], now: NOW, prProbe: { probed: true }, pulls: [] });
console.log(`  a sweep that CRASHED 1 day ago -> skip=${g.skip}  lastRunId=${(g.evidence as any).lastRunId}`);
console.log(`  so the next ${SWEEP_CADENCE_DAYS} days of scheduled ticks are skipped on the evidence of a run`);
console.log("  that produced nothing. Recovery is manual: 'Run now' (trigger!=='scheduled' is ungated).");

console.log("\n=== 9.3  control — what IS excluded ===");
for (const [label, r] of [
  ["this gate's own tombstone (type:'skipped')", row("cancelled", { type: "skipped" })],
  ["a DELETE-route tombstone (deleted:true)", row("complete", { deleted: true })],
  ["another def", row("complete", { workflowDefId: "feature-delivery" })],
  ["another repo", row("complete", { input: { repoConfig: { repos: [{ url: "https://github.com/o/other" }] } } as never })],
  ["no usable timestamp", row("complete", { startedAt: undefined, completedAt: undefined })],
  ["a FUTURE timestamp", row("complete", { completedAt: new Date(NOW + 86_400_000).toISOString() })],
] as const) {
  const res = evaluateSweepCadence({ repo: REPO, rows: [r as SweepWorkflowRow], now: NOW });
  console.log(`  ${String(label).padEnd(44)} skip=${String(res?.skip ?? null)}`);
}

console.log("\n=== 9.4  is the tombstone itself excluded from a later cadence read? ===");
const tomb = buildSkipTombstone({
  repo: REPO,
  reason: "recent-sweep",
  evidence: { repo: REPO, lastRunId: "x", lastRunAt: daysAgo(3), ageDays: 3, minIntervalDays: 14, runsConsidered: 1 },
  at: NOW,
});
console.log(`  tombstone: ${JSON.stringify(tomb, null, 2).split("\n").join("\n  ")}`);
const asRow: SweepWorkflowRow = { ...(tomb as never), input: (row("complete") as any).input };
console.log(`  fed back as a row -> skip=${String(evaluateSweepCadence({ repo: REPO, rows: [asRow], now: NOW })?.skip ?? null)}`);
console.log("  EXCLUDED TWICE: deleted:true AND type:'skipped'. deleted:true is also what");
console.log("  dynamo-read.ts:36 filters on, so it never appears in the workflow list.");
console.log(`  id determinism: ${skipTombstoneId(REPO, NOW)} vs next day ${skipTombstoneId(REPO, NOW + 86_400_000)}`);

console.log("\n=== 9.5  mode normaliser ===");
for (const raw of [undefined, null, "", "   ", "off", "OFF", " Enforce ", "shadow", "banana", "1", "true"]) {
  // NB JSON.stringify(undefined) is undefined, not a string — String() it first.
  console.log(`  ${String(JSON.stringify(raw)).padEnd(12)} -> ${normalizeSweepCadenceMode(raw)}`);
}

console.log("\n=== ITEM 9 / F10 VERDICT ===");
console.log("  F10 REPRODUCED: an errored or cancelled prior sweep counts as a recent sweep.");
console.log("  No test in sweep-cadence.test.ts exercises phase 'error' or 'cancelled' as a");
console.log("  real prior run — only 'complete', 'development' (running) and 'nothing-to-remove'.");
