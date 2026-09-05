#!/usr/bin/env node
// Battery CLI (FR-2/FR-3/FR-9/FR-10/FR-12).
//   --all (default) | --case <id> (repeatable) | --dry-run | --mock
//   --results <path> | --base-ref <ref> | --baseline-mode --repeat N --out <path>
//   --flake-ledger <path> (or BATTERY_FLAKE_LEDGER; default <results-dir>/flake-ledger.jsonl)
//
// --mock (TEAM-3295): full pipeline with a deterministic local transport and a
// synthetic in-memory baseline — zero AWS calls. Demonstrates RED (degraded
// persona prompt → floor breach naming the evaluator) and GREEN (innocuous
// edit → PASS) locally; see lib/mock-transport.mjs and the README.
// Gate mode NEVER writes evals/battery/baseline.json — only the merge-to-main
// baseline workflow regenerates it (via --baseline-mode with an explicit --out).
//
// Gate mode = --base-ref given. Then the rules the gate judges itself by
// (baseline.json, thresholds.json, and manifest.json's gating knobs) are read
// from the BASE REF, never from the PR checkout (B2), spend is capped live at
// maxRunUsd (B5), and a bootstrap baseline (B1) or a suite with no
// baseline-compared case (B3) can never produce a PASS.
//
// Runtime reliability (TEAM-3352): per-case progress lines + an incremental
// battery-progress.jsonl, an end-to-end per-case deadline, a whole-run
// watchdog that still writes results on abort, and a global Bedrock
// concurrency gate. Env knobs: BATTERY_BEDROCK_CONCURRENCY,
// BATTERY_RUN_DEADLINE_SECONDS, BATTERY_CASE_DEADLINE_SECONDS,
// BATTERY_MAX_TRANSPORT_RETRIES.

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { preflight, resolveGateConfig, SCORING_BACKEND as CASES_BACKEND } from "./lib/cases.mjs";
import { evaluateSuite } from "./lib/thresholds.mjs";
import { createRegistry, FORBIDDEN_TOOLS } from "./lib/registry.mjs";
import { runCase, systemPromptPath, requiredToolFailureError, MODEL_TIERS, MAX_TRANSPORT_RETRIES, BATTERY_TENANT } from "./lib/agent-runner.mjs";
import { baselineQuorum, aggregateBaselineCase, topUpCase, MAX_TOPUP_RUNS, resolveRunDeadline, DEFAULT_RUN_DEADLINE_SECONDS } from "./lib/baseline.mjs";
import { configFingerprint, appendFlakeLedger, readFlakeLedger, flagFlakyCases } from "./lib/flake.mjs";
import { createSpendLedger } from "./lib/spend.mjs";
import { createConverseTransport, scoreCase, SCORING_BACKEND } from "./lib/scoring.mjs";
import { createMockTransport, buildMockBaseline, MOCK_SCORING_BACKEND } from "./lib/mock-transport.mjs";
import { createSemaphore, linkAbort } from "./lib/retry.mjs";
import { buildResults, renderCheckSummary } from "./lib/report.mjs";
import { writeRedacted, redactText } from "./lib/redact.mjs";
import "./lib/otel.mjs"; // import-time contract check vs schema/otel-eval-attributes.json

const BATTERY_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(BATTERY_DIR, "..", "..");
const CANONICAL_BASELINE = resolve(BATTERY_DIR, "baseline.json");
const POOL_SIZE = 4;

// Runtime-reliability knobs (TEAM-3352). Env overrides exist so CI can tune
// them without a code change; every default keeps the run bounded.
const envInt = (name, fallback) => {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(v) && v > 0 ? v : fallback;
};
// Global cap on in-flight Bedrock calls (agent turns + judge calls combined),
// so POOL_SIZE case workers cannot stampede the model quotas.
const BEDROCK_CONCURRENCY = envInt("BATTERY_BEDROCK_CONCURRENCY", 3);
// Whole-run watchdog: past this, outstanding work is aborted, unfinished cases
// report timed_out, and the results/summary files are STILL written (FAIL).
// Baseline mode runs every case --repeat times, so its DEFAULT deadline scales
// with repeat (TEAM-3405, lib/baseline.mjs); an explicit env value always wins
// verbatim.
const EXPLICIT_RUN_DEADLINE_SECONDS = envInt("BATTERY_RUN_DEADLINE_SECONDS", 0) || null;
// End-to-end per-case deadline (agent loop + judge scoring). Default derives
// from the case's own agent timeout plus a judge budget per evaluator.
const CASE_DEADLINE_SECONDS = envInt("BATTERY_CASE_DEADLINE_SECONDS", 0) || null;
const JUDGE_BUDGET_SECONDS_PER_EVALUATOR = 60;
const MAX_CASE_TRANSPORT_RETRIES = envInt("BATTERY_MAX_TRANSPORT_RETRIES", MAX_TRANSPORT_RETRIES);

const caseDeadlineSeconds = (def) =>
  CASE_DEADLINE_SECONDS ?? def.timeoutSeconds + JUDGE_BUDGET_SECONDS_PER_EVALUATOR * def.evaluators.length;
const clock = () => new Date().toISOString().slice(11, 19);

// TEAM-3405: every exit path that could have spent Bedrock money must report
// the ledger total — including the watchdog handler and the top-level crash
// handler, hence a module-level reference set the moment the ledger exists.
let activeLedger = null;
const printSpend = (log = console.error) => {
  if (activeLedger)
    log(`Total spend: $${activeLedger.spentUsd.toFixed(4)} (ceiling $${activeLedger.maxUsd.toFixed(2)})`);
};

// ─── Flags ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = { cases: [], dryRun: false, mock: false, baselineMode: false, repeat: 3, results: null, baseRef: null, out: null, flakeLedger: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") continue;
    else if (a === "--case") flags.cases.push(argv[++i]);
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--report-only") flags.reportOnly = true;
    else if (a === "--mock") flags.mock = true;
    else if (a === "--results") flags.results = argv[++i];
    else if (a === "--flake-ledger") flags.flakeLedger = argv[++i];
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

  // TEAM-3090: the synthetic test tenant recorded on every result must never
  // look like prod traffic (and must share the battery- marker the packager's
  // defense-in-depth filter keys on).
  if (!BATTERY_TENANT.startsWith("battery-") || /prod/i.test(BATTERY_TENANT) || BATTERY_TENANT.includes("eval_"))
    errors.push(`test tenant '${BATTERY_TENANT}' does not look like a synthetic battery tenant`);

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

// An unexpected worker exception must cost only that item (mapped through
// `onWorkerError`), never reject the whole Promise.all and abandon the run
// with no results file.
async function runPool(items, size, worker, onWorkerError) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          results[i] = await worker(items[i], i);
        } catch (err) {
          if (!onWorkerError) throw err;
          results[i] = onWorkerError(items[i], err);
        }
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

  // Mock mode is a local zero-AWS demo — never a baseline writer, never gate
  // evidence (gate mode's base-ref rules would be judged against mock scores).
  if (flags.mock && (flags.baselineMode || flags.baseRef)) {
    console.error("--mock is incompatible with --baseline-mode and --base-ref (local demo only)");
    process.exit(2);
  }

  const thresholds = gate?.thresholds || pf.thresholds;
  let baseline = gate?.baseline || pf.baseline;

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

  // Mock runs compare against a synthetic healthy baseline so PASS is
  // reachable locally; the committed bootstrap baseline.json and its strict
  // B1 guard are untouched for real runs.
  if (flags.mock) baseline = buildMockBaseline({ cases: selected });

  const hermErrors = hermeticitySelfTest(runId, selected);
  if (hermErrors.length > 0) {
    console.error(`HERMETICITY SELF-TEST FAILED — gate FAIL:\n`);
    for (const e of hermErrors) console.error(`  ${e}`);
    process.exit(1);
  }

  const configSha = git("rev-parse", "HEAD");
  // TRUST-1 (TEAM-3425): in CI the battery job's checkout is the trusted BASE
  // revision — the PR head only overlays candidate data — so configSha above
  // records the HARNESS revision, not the candidate. The workflow passes the
  // PR head sha in GATE_CANDIDATE_SHA; it is recorded in the results as
  // candidateSha so the artifact stays attributable to the config under test.
  // Unset (local/manual runs) it is simply omitted.
  const candidateSha = process.env.GATE_CANDIDATE_SHA || null;
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

  // Results/progress paths are fixed BEFORE any case runs: completed cases are
  // appended to battery-progress.jsonl one flushed line at a time, so a killed
  // or deadline-aborted run still leaves per-case evidence on disk.
  const resultsPath = resolve(flags.results || join(BATTERY_DIR, "battery-results.json"));
  const resultsDir = flags.baselineMode ? dirname(resolve(flags.out)) : dirname(resultsPath);
  const progressPath = join(resultsDir, "battery-progress.jsonl");
  writeRedacted(progressPath, "");
  // Appends go through the same C2 redaction as every other generated
  // artifact — progress lines carry runner error strings.
  const progress = (record) => appendFileSync(progressPath, redactText(JSON.stringify(record)).text + "\n");

  // Effective whole-run deadline (TEAM-3405): baseline mode's default scales
  // with --repeat (a repeat-3 baseline run is ~3× a gate run); an explicit
  // BATTERY_RUN_DEADLINE_SECONDS is honored verbatim in every mode.
  const { seconds: runDeadlineSeconds, autoScaled: runDeadlineScaled } = resolveRunDeadline({
    baselineMode: flags.baselineMode,
    repeat: flags.repeat,
    explicitSeconds: EXPLICIT_RUN_DEADLINE_SECONDS,
  });

  // Whole-run watchdog: when it fires, every case deadline linked to it aborts,
  // in-flight cases report timed_out/unscored, unstarted cases report timed_out
  // immediately — and the suite still completes and writes its results (FAIL).
  const runWatchdog = new AbortController();
  const runTimer = setTimeout(
    () => runWatchdog.abort(new Error(`run deadline of ${runDeadlineSeconds}s exceeded`)),
    runDeadlineSeconds * 1000
  );
  runWatchdog.signal.addEventListener(
    "abort",
    () => {
      console.error(`[${clock()}] RUN DEADLINE — aborting outstanding cases (${runDeadlineSeconds}s)`);
      printSpend();
    },
    { once: true }
  );

  // Global Bedrock gate: at most BEDROCK_CONCURRENCY Converse calls in flight
  // across ALL case workers (agent turns + judge calls), so the pool of
  // POOL_SIZE cannot stampede the model quotas into throttling.
  const bedrockGate = createSemaphore(BEDROCK_CONCURRENCY);
  // MOCK: the deterministic local transport slots in behind the exact seam
  // the Bedrock transport uses; createConverseTransport (the only AWS SDK
  // import in the battery) is never called in mock mode.
  if (flags.mock) console.log("MOCK MODE — deterministic local transport, synthetic baseline, ZERO AWS calls.");
  const rawTransport = flags.mock
    ? createMockTransport({ repoRoot: REPO_ROOT, cases: selected })
    : await createConverseTransport();
  const transport = (params, opts) => bedrockGate.run(() => rawTransport(params, opts));
  // B5: maxRunUsd is a live ceiling, not a post-hoc verdict check. The ledger
  // meters every Converse response and refuses the next call once the ceiling
  // is up, so spend is bounded by ~maxRunUsd + the turns already in flight.
  // Baseline mode runs every case `--repeat` times, so its ceiling scales.
  const spendCeilingUsd = flags.baselineMode ? thresholds.maxRunUsd * flags.repeat : thresholds.maxRunUsd;
  const ledger = createSpendLedger({ maxUsd: spendCeilingUsd });
  activeLedger = ledger;
  console.log(`Spend ceiling: $${spendCeilingUsd.toFixed(2)} (maxRunUsd from ${gate ? `${gate.baseRef} ` : "PR-head "}thresholds.json)`);
  console.log(
    `Limits: bedrock concurrency ${BEDROCK_CONCURRENCY}, run deadline ${runDeadlineSeconds}s` +
      `${runDeadlineScaled ? ` (auto-scaled: ${DEFAULT_RUN_DEADLINE_SECONDS}s × repeat ${flags.repeat}, baseline mode)` : ""}, ` +
      `case deadline ${CASE_DEADLINE_SECONDS ? `${CASE_DEADLINE_SECONDS}s` : `timeoutSeconds + ${JUDGE_BUDGET_SECONDS_PER_EVALUATOR}s/evaluator`}, ` +
      `transport retries/case ${MAX_CASE_TRANSPORT_RETRIES}. Progress: ${progressPath}`
  );

  const emptyResult = (def, status, error, attempt = 0) => ({
    id: def.id,
    status,
    attempt,
    sessionId: null,
    tenant: BATTERY_TENANT,
    forbiddenHits: [],
    trajectory: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    scores: {},
    details: {},
    error,
    modelTier: def.modelTier,
    evaluator_floors: def.evaluator_floors,
  });

  function finishCase(def, result, startedAtMs) {
    const runtimeSeconds = Math.round((Date.now() - startedAtMs) / 10) / 100;
    const final = { ...result, runtimeSeconds };
    console.log(
      `[${clock()}]   ${def.id}: ${final.status}${final.error ? ` (${final.error})` : ""} ` +
        `[attempt ${final.attempt}] (${runtimeSeconds}s)`
    );
    progress({
      ts: new Date().toISOString(),
      runId,
      id: def.id,
      status: final.status,
      attempt: final.attempt,
      modelTier: def.modelTier,
      runtimeSeconds,
      scores: final.scores,
      error: final.error ?? null,
      infraRetried: final.infraRetried === true,
    });
    return final;
  }

  async function executeAndScore(def) {
    const startedAtMs = Date.now();
    // Never START new work past the run deadline or the spend ceiling —
    // unstarted cases fail the gate either way.
    if (runWatchdog.signal.aborted) {
      const error = `${runWatchdog.signal.reason?.message || "run deadline exceeded"} — case '${def.id}' was not started`;
      return finishCase(def, emptyResult(def, "timed_out", error), startedAtMs);
    }
    if (ledger.exceeded) {
      ledger.noteAborted(def.id);
      const error = ledger.message(`case '${def.id}' was not started`);
      return finishCase(def, emptyResult(def, "skipped", error), startedAtMs);
    }

    // One deadline per case, covering the agent loop AND all judge scoring;
    // the whole-run watchdog aborts through it.
    const deadlineSeconds = caseDeadlineSeconds(def);
    const caseWatchdog = new AbortController();
    const caseTimer = setTimeout(
      () => caseWatchdog.abort(new Error(`case deadline of ${deadlineSeconds}s exceeded`)),
      deadlineSeconds * 1000
    );
    const unlink = linkAbort(runWatchdog.signal, caseWatchdog);
    try {
      console.log(`[${clock()}] ▶ ${def.id} (${def.modelTier}, attempt 1)`);
      const run = await runCase({
        caseDef: def,
        repoRoot: REPO_ROOT,
        runId,
        converse: ledger.meter(transport, def.modelTier, def.id),
        signal: caseWatchdog.signal,
        maxTransportRetries: MAX_CASE_TRANSPORT_RETRIES,
      });
      let scores = {};
      let details = {};
      let status = run.status;
      let error = run.error;
      if (run.status === "completed") {
        const agentSeconds = Math.round((Date.now() - startedAtMs) / 10) / 100;
        console.log(
          `[${clock()}] ⚖ ${def.id}: agent loop done in ${agentSeconds}s (${run.turns} turn(s)) — ` +
            `scoring ${def.evaluators.length} evaluator(s)`
        );
        const scored = await scoreCase({
          caseDef: def,
          runResult: run,
          transport: ledger.meter(transport, "judge", def.id),
          repoRoot: REPO_ROOT,
          signal: caseWatchdog.signal,
        });
        status = scored.status; // 'scored' | 'unscored'
        scores = scored.scores;
        details = scored.details;
        error = scored.error || error;
      } else if (run.status === "failed_forbidden_tool") {
        error = `forbidden tool(s) called: ${run.forbiddenHits.join(", ")}`;
      } else if (run.status === "failed_required_tool") {
        error = requiredToolFailureError(run);
      }
      return finishCase(
        def,
        { ...run, status, scores, details, error, modelTier: def.modelTier, evaluator_floors: def.evaluator_floors },
        startedAtMs
      );
    } catch (err) {
      // A worker bug must cost exactly one case, never the suite.
      return finishCase(def, emptyResult(def, "errored", `unexpected runner error: ${err.message}`), startedAtMs);
    } finally {
      clearTimeout(caseTimer);
      unlink();
    }
  }

  const onWorkerError = (def, err) =>
    finishCase(def, emptyResult(def, "errored", `runner worker crashed: ${err.message}`), Date.now());

  if (flags.baselineMode) {
    const outPath = resolve(flags.out);
    if (outPath === CANONICAL_BASELINE) {
      console.warn(
        "warn: --out points at the canonical evals/battery/baseline.json — allowed only because it was passed explicitly (merge-to-main baseline workflow)."
      );
    }
    // Baseline repeat robustness (TEAM-3405): a single flaky run out of N must
    // not sink the whole generation. A case is baseline-eligible when at least
    // ceil(2N/3) of its N runs scored (2-of-3 for repeat 3); the per-evaluator
    // means are computed over the SCORED runs only (lib/baseline.mjs).
    // Below-quorum still fails the whole run — an unsound baseline is never
    // written.
    const quorum = baselineQuorum(flags.repeat);
    console.log(
      `Baseline mode: ${selected.length} case(s) × ${flags.repeat} run(s) → ${outPath} (quorum: ${quorum}/${flags.repeat} scored runs per case)`
    );
    const runs = selected.flatMap((def) => Array.from({ length: flags.repeat }, () => def));
    const results = await runPool(runs, POOL_SIZE, executeAndScore, onWorkerError);

    // Per-case top-up pass (TEAM-3405): a case still below quorum after the
    // main pass gets up to MAX_TOPUP_RUNS extra runs, stopping at quorum.
    // The run watchdog stays armed and executeAndScore re-checks the deadline
    // and the spend ceiling before every top-up run, so top-ups spend from
    // the same budgets — never past them. Exhausted top-ups still fail the
    // whole baseline below.
    const topUpCounts = new Map();
    if (!runWatchdog.signal.aborted) {
      const needsTopUp = selected.filter(
        (def) => results.filter((r) => r.id === def.id && r.status === "scored").length < quorum
      );
      if (needsTopUp.length > 0) {
        console.log(
          `Top-up pass: ${needsTopUp.length} case(s) below quorum after the main pass (max ${MAX_TOPUP_RUNS} extra run(s) each)`
        );
        await runPool(
          needsTopUp,
          POOL_SIZE,
          async (def) => {
            const used = await topUpCase({
              def,
              results,
              quorum,
              repeat: flags.repeat,
              runOnce: executeAndScore,
              log: (msg) => console.log(`[${clock()}] ${msg}`),
            });
            topUpCounts.set(def.id, used);
          },
          () => null
        );
      }
    }
    clearTimeout(runTimer);
    if (runWatchdog.signal.aborted) {
      console.error(`Baseline generation FAILED — ${runWatchdog.signal.reason?.message}; not writing a partial baseline.`);
      printSpend();
      process.exit(1);
    }
    const cases = {};
    let anyFailure = false;
    for (const def of selected) {
      const topUpRuns = topUpCounts.get(def.id) || 0;
      const agg = aggregateBaselineCase({ def, results, quorum, topUpRuns });
      const topUpNote = topUpRuns > 0 ? `, ${topUpRuns} top-up(s)` : "";
      if (agg.belowQuorum) {
        anyFailure = true;
        console.error(
          `  ✗ ${def.id}: scored ${agg.runsScored}/${agg.runsAttempted} (quorum ${quorum}${topUpNote}) — baseline would be unsound`
        );
        continue;
      }
      console.log(`  ✓ ${def.id}: scored ${agg.runsScored}/${agg.runsAttempted} (quorum ${quorum}${topUpNote})`);
      cases[def.id] = agg.entry;
    }
    if (ledger.exceeded) {
      console.error(
        `Baseline generation FAILED — ${ledger.message("remaining runs were abandoned")}; not writing a partial baseline.`
      );
      printSpend();
      process.exit(1);
    }
    if (anyFailure) {
      console.error("Baseline generation FAILED — not writing an unsound baseline.");
      printSpend();
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
    console.log(`Candidate baseline written to ${outPath}`);
    printSpend(console.log);
    process.exit(0);
  }

  // ── Gate mode ──────────────────────────────────────────────────────────────
  console.log(`Running ${selected.length} case(s) (pool of ${POOL_SIZE}), runId ${runId}…`);
  const caseResults = await runPool(selected, POOL_SIZE, executeAndScore, onWorkerError);
  clearTimeout(runTimer);

  const runtimeSeconds = (Date.now() - startedAt) / 1000;
  const costEstimateUsd = ledger.spentUsd;
  // Results are stamped with the ACTIVE backend, so mock results can never be
  // confused with (or compared against) local-judge scores — a backend
  // mismatch is a gate failure by construction.
  const activeBackend = flags.mock ? MOCK_SCORING_BACKEND : SCORING_BACKEND;
  const suite = evaluateSuite({
    thresholds,
    baseline,
    caseResults,
    newCaseIds,
    costEstimateUsd,
    scoringBackend: activeBackend,
    costCeilingReasons: ledger.failureReasons(),
  });

  // Flake bookkeeping (TEAM-3090, FR-10): append this run's per-case verdicts
  // to the flake ledger and flag verdict flips on unchanged config. Flags are
  // INFORMATIONAL ONLY — they never touch the gate verdict (retirement stays
  // the status:retired PR process) — so bookkeeping failures must cost a
  // warning, never the run. Never reached for --dry-run (exits above), and
  // skipped for --mock: synthetic mock verdicts say nothing about real judge
  // flakiness and must not pollute a ledger a real run might later read.
  let flakyFlags = [];
  if (!flags.mock) try {
    const flakeLedgerPath = resolve(
      flags.flakeLedger || process.env.BATTERY_FLAKE_LEDGER || join(dirname(resultsPath), "flake-ledger.jsonl")
    );
    const priorEntries = readFlakeLedger(flakeLedgerPath);
    const nowIso = new Date().toISOString();
    const runEntries = caseResults.map((r) => {
      const def = selected.find((d) => d.id === r.id);
      let promptText = "";
      try {
        promptText = readFileSync(systemPromptPath(REPO_ROOT, def.targetAgentId), "utf8");
      } catch {
        /* a missing prompt already failed preflight; fingerprint the case alone */
      }
      const breached = suite.deltaRows.some((row) => row.case === r.id && row.verdict === "floor_breach");
      return {
        ts: nowIso,
        runId,
        caseId: r.id,
        fingerprint: configFingerprint(def, promptText),
        // errored/timed_out/skipped/unscored/forbidden all land as fail.
        verdict: r.status === "scored" && !breached ? "pass" : "fail",
      };
    });
    appendFlakeLedger(flakeLedgerPath, runEntries);
    flakyFlags = flagFlakyCases([...priorEntries, ...runEntries]);
    console.log(`Flake ledger: ${flakeLedgerPath} (${priorEntries.length + runEntries.length} entries)`);
    if (flakyFlags.length > 0)
      console.warn(
        `warn: ${flakyFlags.length} flaky candidate(s) flagged (informational only): ${flakyFlags.map((f) => f.caseId).join(", ")}`
      );
  } catch (err) {
    console.warn(`warn: flake-ledger bookkeeping failed (informational only, run continues): ${err.message}`);
  }

  const results = buildResults({
    runId,
    configSha,
    baselineSha: baseline.source_commit,
    scoringBackend: activeBackend,
    suite,
    caseResults,
    retiredCases,
    costEstimateUsd,
    runtimeSeconds,
    configSources: gate ? { baseRef: gate.baseRef, ...gate.sources } : { baseRef: null, all: "pr-head (local/manual run)" },
    flakyFlags,
  });
  if (candidateSha) results.candidateSha = candidateSha;

  // C2: redact at the write-time choke point. check-summary.md is published
  // verbatim into a public check run, and battery-results.json is uploaded as
  // an artifact — raw agent/judge error strings must never leak through them.
  // (resultsPath is computed before the pool runs — the incremental
  // battery-progress.jsonl lives next to it; TEAM-3352.)
  writeRedacted(resultsPath, JSON.stringify(results, null, 2) + "\n");
  const summaryPath = join(dirname(resultsPath), "check-summary.md");
  writeRedacted(summaryPath, renderCheckSummary(results) + "\n");

  console.log(`\n${renderCheckSummary(results)}`);
  console.log(`Results: ${resultsPath}\nCheck summary: ${summaryPath}`);
  printSpend(console.log);
  // --report-only: standalone scoring (no baseline yet, ad-hoc case runs) —
  // the summary above is the deliverable, so a FAIL verdict is not an error
  // exit. Never combine with gate evidence: CI's gate path does not pass it.
  if (flags.reportOnly && results.verdict !== "PASS") {
    console.log("(--report-only: verdict FAIL reported above, exiting 0)");
    process.exit(0);
  }
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
  printSpend();
  process.exit(1);
});
