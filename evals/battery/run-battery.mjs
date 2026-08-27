#!/usr/bin/env node
// Battery CLI (FR-2/FR-3/FR-9/FR-10/FR-12).
//   --all (default) | --case <id> (repeatable) | --dry-run | --results <path>
//   --base-ref <ref> | --baseline-mode --repeat N --out <path>
// Gate mode NEVER writes evals/battery/baseline.json — only the merge-to-main
// baseline workflow regenerates it (via --baseline-mode with an explicit --out).
//
// Gate mode = --base-ref given. Then the rules the gate judges itself by
// (baseline.json, thresholds.json, and manifest.json's gating knobs) are read
// from the BASE REF, never from the PR checkout (B2), spend is capped live at
// maxRunUsd (B5), and a bootstrap baseline (B1) or a suite with no
// baseline-compared case (B3) can never produce a PASS.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { preflight, resolveGateConfig, SCORING_BACKEND as CASES_BACKEND } from "./lib/cases.mjs";
import { evaluateSuite } from "./lib/thresholds.mjs";
import { createRegistry, FORBIDDEN_TOOLS } from "./lib/registry.mjs";
import { runCase, MODEL_TIERS } from "./lib/agent-runner.mjs";
import { createSpendLedger } from "./lib/spend.mjs";
import { createConverseTransport, scoreCase, SCORING_BACKEND } from "./lib/scoring.mjs";
import { buildResults, renderCheckSummary } from "./lib/report.mjs";
import { writeRedacted } from "./lib/redact.mjs";
import "./lib/otel.mjs"; // import-time contract check vs schema/otel-eval-attributes.json

const BATTERY_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(BATTERY_DIR, "..", "..");
const CANONICAL_BASELINE = resolve(BATTERY_DIR, "baseline.json");
const POOL_SIZE = 4;

// ─── Flags ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = { cases: [], dryRun: false, baselineMode: false, repeat: 3, results: null, baseRef: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") continue;
    else if (a === "--case") flags.cases.push(argv[++i]);
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--results") flags.results = argv[++i];
    else if (a === "--base-ref") flags.baseRef = argv[++i];
    else if (a === "--baseline-mode") flags.baselineMode = true;
    else if (a === "--repeat") flags.repeat = parseInt(argv[++i], 10);
    else if (a === "--out") flags.out = argv[++i];
    else {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return flags;
}

const git = (...args) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();

// ─── Hermeticity self-test (HERM-1/HERM-2) — failure ⇒ gate FAIL ────────────

function hermeticitySelfTest(runId, activeCases) {
  const errors = [];

  // Closed registry: no forbidden tool present, every Tickets/WorkflowOutput
  // entry is a stub (never a passthrough to a real lambda).
  const probe = createRegistry({ caseDef: { id: "hermeticity-probe", input: {} }, repoRoot: REPO_ROOT, workspaceDir: "/tmp" });
  const registryNames = new Set(probe.toolSpecs.map((t) => t.toolSpec.name));
  for (const name of FORBIDDEN_TOOLS)
    if (registryNames.has(name)) errors.push(`forbidden tool '${name}' present in registry`);
  for (const [name, fn] of Object.entries(probe.executors))
    if ((name.startsWith("Tickets___") || name.startsWith("WorkflowOutput___")) && fn.isStub !== true)
      errors.push(`registry entry '${name}' is not a stub`);

  // Credential scrub before any agent construction.
  for (const key of ["GITHUB_TOKEN", "GITHUB_PAT", "MCP_SERVERS"]) delete process.env[key];

  // Session ids must never contain 'eval_' — the eval-packager resolves agents
  // by evalConfigName SUBSTRING match on log-group names (lambda/eval-packager/
  // index.mjs resolveAgentId), and a battery session must never be mistaken
  // for online-eval traffic.
  for (const def of activeCases) {
    const sessionId = `battery-${runId}-${def.id}`;
    if (sessionId.includes("eval_")) errors.push(`session id '${sessionId}' contains 'eval_'`);
  }

  // No on-disk git credentials (HERM-1): no CI-injected auth header that a
  // compromised prompt could exfiltrate or use to push.
  try {
    const extraheader = execFileSync(
      "git",
      ["config", "--get", "http.https://github.com/.extraheader"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    ).trim();
    if (extraheader) errors.push("git http.https://github.com/.extraheader is set — credentialed checkout");
  } catch {
    /* unset — good */
  }
  try {
    const localConfig = execFileSync("git", ["config", "--local", "--list"], { cwd: REPO_ROOT, encoding: "utf8" });
    if (/authorization/i.test(localConfig)) errors.push(".git config contains an AUTHORIZATION header");
  } catch {
    /* no local config readable — fine */
  }
  return errors;
}

// ─── New-case detection ──────────────────────────────────────────────────────

function detectNewCaseIds({ baseline, baseRef, activeCases }) {
  if (baseline?.bootstrap === true) return activeCases.map((c) => c.id);
  const ref = baseRef || process.env.GITHUB_BASE_REF || null;
  if (!ref) return [];
  try {
    const out = git("diff", "--name-status", "--diff-filter=A", `${ref}...HEAD`, "--", "evals/battery/cases/");
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(/\s+/).pop())
      .map((p) => p.replace(/^evals\/battery\/cases\//, "").replace(/\.json$/, ""))
      .filter((id) => activeCases.some((c) => c.id === id));
  } catch (err) {
    console.warn(`warn: could not diff against '${ref}' (${err.message.split("\n")[0]}); treating no cases as new (stricter)`);
    return [];
  }
}

// In gate mode the base ref tells us exactly which cases COULD be gated: a
// case is informational only when it is neither active at the base ref nor
// present in the (base-ref) baseline. That is stricter than the git-diff
// heuristic — a pre-existing case the PR merely renamed/re-added stays gated.
function gateNewCaseIds({ gate, baseline, selected }) {
  // Bootstrap: nothing is comparable, so everything reports informational —
  // and the suite verdict fails anyway (B1).
  if (baseline?.bootstrap === true) return selected.map((c) => c.id);
  const baseActive = new Set(gate.baseActiveIds || []);
  return selected
    .map((c) => c.id)
    .filter((id) => !baseActive.has(id) && !baseline?.cases?.[id]);
}

// ─── Concurrency pool ────────────────────────────────────────────────────────

async function runPool(items, size, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i], i);
      }
    })
  );
  return results;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  // Preflight: structured errors, fail loudly before any Bedrock spend.
  const pf = preflight(REPO_ROOT);
  const lintErrors = [];
  try {
    execFileSync(process.execPath, [join(BATTERY_DIR, "lint-fixtures.mjs")], { encoding: "utf8" });
  } catch (err) {
    lintErrors.push(`fixture lint failed:\n${err.stdout || ""}${err.stderr || ""}`);
  }
  // Gate mode (--base-ref): the rules the gate judges itself by come from the
  // base ref, not from the PR checkout (B2).
  const gateMode = !flags.baselineMode && Boolean(flags.baseRef);
  const gate = gateMode
    ? resolveGateConfig({
        repoRoot: REPO_ROOT,
        baseRef: flags.baseRef,
        head: { manifest: pf.manifest, thresholds: pf.thresholds, baseline: pf.baseline, cases: pf.allCases },
      })
    : null;
  if (gate) {
    console.log(`Gate config resolution (--base-ref ${gate.baseRef}):`);
    for (const [file, source] of Object.entries(gate.sources)) console.log(`  ${file}: ${source}`);
    for (const w of gate.warnings) console.warn(`  warn: ${w}`);
  }

  const allPreflightErrors = [
    ...pf.errors.map((e) => `[${e.check}] ${e.file ? `${e.file}: ` : ""}${e.message}`),
    ...(gate?.errors || []).map((e) => `[${e.check}] ${e.file ? `${e.file}: ` : ""}${e.message}`),
    ...lintErrors,
  ];
  if (allPreflightErrors.length > 0) {
    console.error(`PREFLIGHT FAILED (${allPreflightErrors.length} error(s)) — gate FAIL:\n`);
    for (const e of allPreflightErrors) console.error(`  ${e}`);
    process.exit(1);
  }

  const thresholds = gate?.thresholds || pf.thresholds;
  const baseline = gate?.baseline || pf.baseline;

  // Case selection. Cases active at the base ref but retired by this PR still
  // run and still gate — retirement only takes effect once it has landed. And
  // for every base-active case the gating knobs inside the case file
  // (evaluator_floors, evaluators, forbiddenTools) come from the base ref too.
  const effectiveDef = (def) => gate?.effectiveCaseDefs?.get(def.id) || def;
  const runnable = [...pf.activeCases, ...(gate?.resurrectedCases || []).map((c) => c.def)].map(effectiveDef);
  const resurrectedIds = new Set((gate?.resurrectedCases || []).map((c) => c.def.id));
  // A case the PR retires but that still gates is NOT reported as retired.
  const retiredCases = pf.retiredCases.filter((r) => !resurrectedIds.has(r.id));
  let selected = runnable;
  if (flags.cases.length > 0) {
    const unknown = flags.cases.filter((id) => !runnable.some((c) => c.id === id));
    if (unknown.length > 0) {
      console.error(`Unknown/inactive case id(s): ${unknown.join(", ")}`);
      process.exit(2);
    }
    selected = runnable.filter((c) => flags.cases.includes(c.id));
  }

  const hermErrors = hermeticitySelfTest(runId, selected);
  if (hermErrors.length > 0) {
    console.error(`HERMETICITY SELF-TEST FAILED — gate FAIL:\n`);
    for (const e of hermErrors) console.error(`  ${e}`);
    process.exit(1);
  }

  const configSha = git("rev-parse", "HEAD");
  const newCaseIds =
    gate && gate.baseActiveIds
      ? gateNewCaseIds({ gate, baseline, selected })
      : detectNewCaseIds({ baseline, baseRef: flags.baseRef, activeCases: selected });

  if (flags.dryRun) {
    console.log(`Preflight OK — ${selected.length} runnable case(s), ${retiredCases.length} retired.`);
    console.log(`Hermeticity self-test OK. Fixture lint OK. Zero Bedrock calls made.\n`);
    console.log(`Plan (runId ${runId}, HEAD ${configSha.slice(0, 12)}):`);
    for (const def of selected) {
      const marker = newCaseIds.includes(def.id) ? " [informational: new case]" : "";
      console.log(
        `  - ${def.id}  agent=${def.targetAgentId}  tier=${def.modelTier} (${MODEL_TIERS[def.modelTier]})  ` +
          `evaluators=${def.evaluators.length}  timeout=${def.timeoutSeconds}s${marker}`
      );
    }
    for (const r of retiredCases) console.log(`  - ${r.id}  RETIRED: ${r.retirement_reason}`);
    process.exit(0);
  }

  if (flags.baselineMode && !flags.out) {
    console.error("--baseline-mode requires --out <path> (the runner never writes a baseline implicitly)");
    process.exit(2);
  }
  if (!flags.baselineMode && flags.out) {
    console.error("--out is only valid with --baseline-mode; gate mode has no baseline-writing code path");
    process.exit(2);
  }

  const transport = await createConverseTransport();
  // B5: maxRunUsd is a live ceiling, not a post-hoc verdict check. The ledger
  // meters every Converse response and refuses the next call once the ceiling
  // is up, so spend is bounded by ~maxRunUsd + the turns already in flight.
  // Baseline mode runs every case `--repeat` times, so its ceiling scales.
  const spendCeilingUsd = flags.baselineMode ? thresholds.maxRunUsd * flags.repeat : thresholds.maxRunUsd;
  const ledger = createSpendLedger({ maxUsd: spendCeilingUsd });
  console.log(`Spend ceiling: $${spendCeilingUsd.toFixed(2)} (maxRunUsd from ${gate ? `${gate.baseRef} ` : "PR-head "}thresholds.json)`);

  async function executeAndScore(def) {
    // Never START new work past the ceiling — unstarted cases are skipped, and
    // a skipped case fails the gate.
    if (ledger.exceeded) {
      ledger.noteAborted(def.id);
      const error = ledger.message(`case '${def.id}' was not started`);
      console.log(`  ${def.id}: skipped (${error})`);
      return {
        id: def.id,
        status: "skipped",
        attempt: 0,
        sessionId: null,
        forbiddenHits: [],
        trajectory: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        scores: {},
        details: {},
        error,
        modelTier: def.modelTier,
        evaluator_floors: def.evaluator_floors,
      };
    }
    const run = await runCase({
      caseDef: def,
      repoRoot: REPO_ROOT,
      runId,
      converse: ledger.meter(transport, def.modelTier, def.id),
    });
    let scores = {};
    let details = {};
    let status = run.status;
    let error = run.error;
    if (run.status === "completed") {
      const scored = await scoreCase({
        caseDef: def,
        runResult: run,
        transport: ledger.meter(transport, "judge", def.id),
        repoRoot: REPO_ROOT,
      });
      status = scored.status; // 'scored' | 'unscored'
      scores = scored.scores;
      details = scored.details;
      error = scored.error || error;
    } else if (run.status === "failed_forbidden_tool") {
      error = `forbidden tool(s) called: ${run.forbiddenHits.join(", ")}`;
    }
    console.log(`  ${def.id}: ${status}${error ? ` (${error})` : ""} [attempt ${run.attempt}]`);
    return {
      ...run,
      status,
      scores,
      details,
      error,
      modelTier: def.modelTier,
      evaluator_floors: def.evaluator_floors,
    };
  }

  if (flags.baselineMode) {
    const outPath = resolve(flags.out);
    if (outPath === CANONICAL_BASELINE) {
      console.warn(
        "warn: --out points at the canonical evals/battery/baseline.json — allowed only because it was passed explicitly (merge-to-main baseline workflow)."
      );
    }
    console.log(`Baseline mode: ${selected.length} case(s) × ${flags.repeat} run(s) → ${outPath}`);
    const runs = selected.flatMap((def) => Array.from({ length: flags.repeat }, () => def));
    const results = await runPool(runs, POOL_SIZE, executeAndScore);
    const cases = {};
    let anyFailure = false;
    for (const def of selected) {
      const mine = results.filter((r) => r.id === def.id && r.status === "scored");
      if (mine.length < flags.repeat) {
        anyFailure = true;
        console.error(`  ✗ ${def.id}: only ${mine.length}/${flags.repeat} scored runs — baseline would be unsound`);
        continue;
      }
      const evaluators = {};
      for (const evaluator of def.evaluators) {
        const xs = mine.map((r) => r.scores[evaluator]).filter((x) => typeof x === "number");
        evaluators[evaluator] = {
          mean: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100,
          min: Math.min(...xs),
          max: Math.max(...xs),
          n: xs.length,
        };
      }
      cases[def.id] = { evaluators };
    }
    if (ledger.exceeded) {
      console.error(
        `Baseline generation FAILED — ${ledger.message("remaining runs were abandoned")}; not writing a partial baseline.`
      );
      process.exit(1);
    }
    if (anyFailure) {
      console.error("Baseline generation FAILED — not writing an unsound baseline.");
      process.exit(1);
    }
    // C2: redact at the write-time choke point — nothing forbidden may land
    // in the committed baseline regardless of raw error strings.
    writeRedacted(
      outPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          source_commit: configSha,
          generated_at: new Date().toISOString(),
          baseline_run_id: runId,
          runs_per_case: flags.repeat,
          scoringBackend: SCORING_BACKEND,
          scale: "0-100",
          bootstrap: false,
          cases,
        },
        null,
        2
      ) + "\n"
    );
    console.log(`Candidate baseline written to ${outPath} (cost ~$${ledger.spentUsd.toFixed(2)})`);
    process.exit(0);
  }

  // ── Gate mode ──────────────────────────────────────────────────────────────
  console.log(`Running ${selected.length} case(s) (pool of ${POOL_SIZE}), runId ${runId}…`);
  const caseResults = await runPool(selected, POOL_SIZE, executeAndScore);

  const runtimeSeconds = (Date.now() - startedAt) / 1000;
  const costEstimateUsd = ledger.spentUsd;
  const suite = evaluateSuite({
    thresholds,
    baseline,
    caseResults,
    newCaseIds,
    costEstimateUsd,
    scoringBackend: SCORING_BACKEND,
    costCeilingReasons: ledger.failureReasons(),
  });
  const results = buildResults({
    runId,
    configSha,
    baselineSha: baseline.source_commit,
    scoringBackend: SCORING_BACKEND,
    suite,
    caseResults,
    retiredCases,
    costEstimateUsd,
    runtimeSeconds,
    configSources: gate ? { baseRef: gate.baseRef, ...gate.sources } : { baseRef: null, all: "pr-head (local/manual run)" },
  });

  // C2: redact at the write-time choke point. check-summary.md is published
  // verbatim into a public check run, and battery-results.json is uploaded as
  // an artifact — raw agent/judge error strings must never leak through them.
  const resultsPath = resolve(flags.results || join(BATTERY_DIR, "battery-results.json"));
  writeRedacted(resultsPath, JSON.stringify(results, null, 2) + "\n");
  const summaryPath = join(dirname(resultsPath), "check-summary.md");
  writeRedacted(summaryPath, renderCheckSummary(results) + "\n");

  console.log(`\n${renderCheckSummary(results)}`);
  console.log(`Results: ${resultsPath}\nCheck summary: ${summaryPath}`);
  process.exit(results.verdict === "PASS" ? 0 : 1);
}

// Sanity: this module must never import anything that writes the canonical
// baseline in gate mode; the only file-write targets above are --out
// (baseline mode, explicit) and the results/summary files — all via the
// writeRedacted choke point (C2).
if (CASES_BACKEND !== SCORING_BACKEND) {
  console.error("internal: scoring backend constants diverged between cases.mjs and scoring.mjs");
  process.exit(1);
}

main().catch((err) => {
  console.error(`battery runner crashed: ${err.stack || err}`);
  process.exit(1);
});
