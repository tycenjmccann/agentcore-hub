// Case/manifest/baseline loading + preflight (FR-2). Pure over an injectable
// repo root so vitest can point it at a fixture tree. Any preflight failure is
// a structured error and a gate FAIL — malformed config must fail loudly
// BEFORE any Bedrock spend.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

export const CUSTOM_EVALUATOR_ID = "dependency_chain_compliance-VyBv7H2bCi";
export const SCORING_BACKEND = "local-judge";

export const batteryDir = (repoRoot) => join(repoRoot, "evals", "battery");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ─── Schema validation (ajv when installed, structural fallback) ────────────

function structuralValidator(schema) {
  const known = new Set(Object.keys(schema.properties));
  const validate = (c) => {
    const errs = [];
    for (const key of schema.required) if (!(key in c)) errs.push(`missing required '${key}'`);
    for (const key of Object.keys(c)) if (!known.has(key)) errs.push(`unknown key '${key}'`);
    if (typeof c.id !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(c.id)) errs.push(`bad id '${c.id}'`);
    if (typeof c.targetAgentId !== "string" || !/^agentcore_hub_[a-z0-9_]+$/.test(c.targetAgentId))
      errs.push(`bad targetAgentId '${c.targetAgentId}'`);
    if (typeof c.taskPrompt !== "string" || c.taskPrompt.length < 20) errs.push("taskPrompt too short");
    if (!Array.isArray(c.referenceInputs?.expectedOutcomes) || c.referenceInputs.expectedOutcomes.length < 1)
      errs.push("referenceInputs.expectedOutcomes must be a non-empty array");
    const evEnum = schema.properties.evaluators.items.enum;
    if (!Array.isArray(c.evaluators) || c.evaluators.length < 1 || c.evaluators.length > 10)
      errs.push("evaluators must have 1-10 entries");
    else for (const e of c.evaluators) if (!evEnum.includes(e)) errs.push(`unknown evaluator '${e}'`);
    if (!["haiku", "sonnet", "opus"].includes(c.modelTier)) errs.push(`bad modelTier '${c.modelTier}'`);
    if (!Number.isInteger(c.timeoutSeconds) || c.timeoutSeconds < 30 || c.timeoutSeconds > 300)
      errs.push(`bad timeoutSeconds '${c.timeoutSeconds}'`);
    if (!["active", "retired"].includes(c.status)) errs.push(`bad status '${c.status}'`);
    if (!["incident", "workflow-run", "synthetic"].includes(c.provenance?.source))
      errs.push(`bad provenance.source '${c.provenance?.source}'`);
    // allOf conditionals
    if (c.status === "retired" && !(typeof c.retirement_reason === "string" && c.retirement_reason.length >= 20))
      errs.push("retired case requires retirement_reason (>=20 chars)");
    if (c.modelTier === "opus" && !c.provenance?.tierJustification)
      errs.push("modelTier=opus requires provenance.tierJustification");
    if (c.provenance?.source === "incident" && !c.provenance?.incident)
      errs.push("provenance.source=incident requires provenance.incident");
    validate.errors = errs.map((message) => ({ message }));
    return errs.length === 0;
  };
  return validate;
}

export function loadCaseValidator(repoRoot) {
  const schema = readJson(join(batteryDir(repoRoot), "schema", "case.schema.json"));
  try {
    const require = createRequire(join(repoRoot, "package.json"));
    const Ajv2020 = require("ajv/dist/2020").default;
    return new Ajv2020({ allErrors: true }).compile(schema);
  } catch {
    return structuralValidator(schema);
  }
}

// ─── Loading ─────────────────────────────────────────────────────────────────

export function loadBattery(repoRoot) {
  const dir = batteryDir(repoRoot);
  /** @type {{ manifest: any, thresholds: any, baseline: any, cases: any[], errors: Array<{check: string, file: string, message: string}> }} */
  const out = { manifest: null, thresholds: null, baseline: null, cases: [], errors: [] };
  for (const [key, file] of [
    ["manifest", "manifest.json"],
    ["thresholds", "thresholds.json"],
    ["baseline", "baseline.json"],
  ]) {
    try {
      out[key] = readJson(join(dir, file));
    } catch (err) {
      out.errors.push({ check: "parse", file: `evals/battery/${file}`, message: err.message });
    }
  }
  const casesDir = join(dir, "cases");
  for (const name of readdirSync(casesDir).filter((n) => n.endsWith(".json")).sort()) {
    const file = `evals/battery/cases/${name}`;
    try {
      out.cases.push({ file, def: readJson(join(casesDir, name)) });
    } catch (err) {
      out.errors.push({ check: "parse", file, message: `JSON parse error: ${err.message}` });
    }
  }
  return out;
}

/**
 * Case files sharing an id, as Map<id, string[] files>. Only ids claimed by
 * more than one file are returned. Exported so lint-fixtures.mjs applies the
 * exact same rule as preflight (B4).
 * @param {Array<{ file: string, def: any }>} cases
 */
export function duplicateCaseIds(cases) {
  /** @type {Map<string, string[]>} */
  const byId = new Map();
  for (const { file, def } of cases) {
    if (typeof def?.id !== "string") continue;
    if (!byId.has(def.id)) byId.set(def.id, []);
    byId.get(def.id).push(file);
  }
  return new Map([...byId].filter(([, files]) => files.length > 1));
}

// ─── Preflight ───────────────────────────────────────────────────────────────

export function preflight(repoRoot) {
  const dir = batteryDir(repoRoot);
  const { manifest, thresholds, baseline, cases, errors } = loadBattery(repoRoot);
  const fail = (check, file, message) => errors.push({ check, file, message });

  // Config roster must parse — a broken roster IS a config regression.
  let agentIds = new Set();
  try {
    const agents = readJson(join(repoRoot, "src", "config", "agents.json"));
    agentIds = new Set(agents.agents.map((a) => a.agentId));
  } catch (err) {
    fail("config", "src/config/agents.json", `failed to parse: ${err.message}`);
  }
  try {
    readJson(join(repoRoot, "src", "config", "workflows.json"));
  } catch (err) {
    fail("config", "src/config/workflows.json", `failed to parse: ${err.message}`);
  }

  // Duplicate case ids (B4). Every roster downstream (manifest cross-check,
  // baseline lookup, selection) is Set- or id-keyed, so two files claiming the
  // same id silently collapse: one shadows the other's baseline entry and one
  // case never runs. Reject before any spend.
  for (const [id, files] of duplicateCaseIds(cases))
    fail("duplicate-id", files[0], `duplicate case id '${id}' declared by ${files.length} case files: ${files.join(", ")}`);

  // Schema validation of every case file.
  let validate = null;
  try {
    validate = loadCaseValidator(repoRoot);
  } catch (err) {
    fail("schema", "evals/battery/schema/case.schema.json", `failed to load schema: ${err.message}`);
  }
  for (const { file, def } of cases) {
    if (validate && !validate(def)) {
      for (const e of validate.errors || [])
        fail("schema", file, `${e.instancePath || ""} ${e.message}`.trim());
      continue;
    }
    if (def.targetAgentId && agentIds.size > 0 && !agentIds.has(def.targetAgentId))
      fail("roster", file, `targetAgentId '${def.targetAgentId}' not found in src/config/agents.json`);
    const promptFile =
      def.targetAgentId === "agentcore_hub_workflow_manager"
        ? join(repoRoot, "deploy", "workflow-manager", "system-prompt.md")
        : join(repoRoot, "deploy", "runtime-agent", "prompts", `${def.targetAgentId}.txt`);
    if (!existsSync(promptFile))
      fail("prompt", file, `system prompt file missing for '${def.targetAgentId}'`);
    const refs = [];
    if (def.input?.transcript) refs.push(def.input.transcript);
    if (def.input?.repoFixture) refs.push(def.input.repoFixture);
    refs.push(...(def.input?.files || []), ...(def.input?.blueprints || []));
    for (const ref of refs)
      if (!existsSync(join(dir, ref))) fail("fixture", file, `referenced fixture path does not exist: ${ref}`);
    if (
      (def.evaluators || []).includes(CUSTOM_EVALUATOR_ID) &&
      !def.referenceInputs?.expectedToolTrajectory?.length
    )
      fail("reference-inputs", file, `${CUSTOM_EVALUATOR_ID} requires referenceInputs.expectedToolTrajectory`);
  }

  // Manifest drift (exact set equality with status:active case files).
  const activeCases = cases.filter((c) => c.def.status === "active");
  const retiredCases = cases
    .filter((c) => c.def.status === "retired")
    .map((c) => ({ id: c.def.id, file: c.file, retirement_reason: c.def.retirement_reason }));
  if (manifest) {
    const activeIds = new Set(activeCases.map((c) => c.def.id));
    const manifestIds = new Set(manifest.activeCases || []);
    for (const id of new Set((manifest.activeCases || []).filter((id, i, arr) => arr.indexOf(id) !== i)))
      fail("manifest", "evals/battery/manifest.json", `activeCases lists '${id}' more than once — duplicate entries hide roster drift`);
    for (const id of activeIds)
      if (!manifestIds.has(id)) fail("manifest", "evals/battery/manifest.json", `active case '${id}' missing from activeCases`);
    for (const id of manifestIds)
      if (!activeIds.has(id)) fail("manifest", "evals/battery/manifest.json", `activeCases lists '${id}' but no active case file has that id`);
    if ((manifest.activeCases || []).length < manifest.minActiveCases)
      fail("manifest", "evals/battery/manifest.json",
        `activeCases count ${(manifest.activeCases || []).length} < minActiveCases ${manifest.minActiveCases}`);
  }

  // Thresholds: the gate math and the runner's spend ceiling both read these,
  // and a missing knob would silently disable the rule it encodes.
  if (thresholds) {
    for (const key of ["overallDropMaxPoints", "maxRunUsd"])
      if (typeof thresholds[key] !== "number")
        fail("thresholds", "evals/battery/thresholds.json", `'${key}' must be a number — fail closed`);
    for (const key of ["floorDelta", "minAbsoluteFloor"])
      if (typeof thresholds.floorRule?.[key] !== "number")
        fail("thresholds", "evals/battery/thresholds.json", `'floorRule.${key}' must be a number — fail closed`);
  }

  // Baseline: fail closed on anything missing or unparseable.
  if (baseline) {
    for (const key of ["schemaVersion", "scoringBackend", "cases"])
      if (!(key in baseline))
        fail("baseline", "evals/battery/baseline.json", `missing required key '${key}' — fail closed`);
    if (baseline.scoringBackend && baseline.scoringBackend !== SCORING_BACKEND)
      fail("baseline", "evals/battery/baseline.json",
        `scoringBackend '${baseline.scoringBackend}' != current backend '${SCORING_BACKEND}' — baselines are not comparable across backends; regenerate via the baseline workflow`);
  }

  return {
    ok: errors.length === 0,
    errors,
    manifest,
    thresholds,
    baseline,
    activeCases: activeCases.map((c) => c.def),
    retiredCases,
    // Every case file as loaded ({ file, def }) — gate-mode config resolution
    // needs the retired defs too (a case retired in this PR but active at the
    // base ref keeps gating; see resolveGateConfig).
    allCases: cases,
  };
}

// ─── Gate-mode config resolution (B2) ────────────────────────────────────────

const firstLine = (err) => String(err?.message || err).split("\n")[0];

/** `git show <ref>:<path>` against the repo, or throw if the path is absent. */
export function defaultGitShow(repoRoot) {
  return (ref, relPath) =>
    execFileSync("git", ["show", `${ref}:${relPath}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
}

const REQUIRED_THRESHOLD_KEYS = ["overallDropMaxPoints", "floorRule", "maxRunUsd"];
const GATE_CONFIG_FILES = ["baseline.json", "thresholds.json", "manifest.json"];

/**
 * The gate must not referee itself with rules the PR controls (B2). In gate
 * mode the baseline, the thresholds, and the GATING knobs of the manifest
 * (minActiveCases + which cases count as active) are read from the base ref;
 * PR-head copies only ever apply to cases the PR adds (those cannot exist at
 * base) or when the file is absent at base — and that fallback is only safe in
 * combination with the bootstrap (B1) and zero-gating-case (B3) guards.
 *
 * @param {{ repoRoot: string, baseRef: string,
 *           head: { manifest: any, thresholds: any, baseline: any, cases: Array<{file: string, def: any}> },
 *           gitShow?: (ref: string, relPath: string) => string }} args
 */
export function resolveGateConfig({ repoRoot, baseRef, head, gitShow }) {
  const show = gitShow || defaultGitShow(repoRoot);
  const errors = [];
  const warnings = [];
  /** @type {Record<string, string>} */
  const sources = {};
  /** @type {Record<string, any>} */
  const base = {};

  for (const file of GATE_CONFIG_FILES) {
    const relPath = `evals/battery/${file}`;
    let text;
    try {
      text = show(baseRef, relPath);
    } catch (err) {
      // Absent at base (the battery did not exist yet, or the PR adds the
      // file) — fall back to the PR-head copy, loudly.
      sources[file] = "pr-head (absent at base ref)";
      warnings.push(`${relPath} is not readable at ${baseRef} (${firstLine(err)}) — falling back to the PR-head copy`);
      continue;
    }
    try {
      base[file] = JSON.parse(text);
      sources[file] = `base-ref ${baseRef}`;
    } catch (err) {
      // Present but broken at base: never silently prefer PR-controlled values.
      sources[file] = "unreadable at base ref";
      errors.push({ check: "gate-config", file: `${baseRef}:${relPath}`, message: `JSON parse error: ${err.message}` });
    }
  }

  const baseline = base["baseline.json"] || head.baseline;
  const thresholds = base["thresholds.json"] || head.thresholds;
  const baseManifest = base["manifest.json"] || null;

  // The base-ref baseline/thresholds get the same fail-closed checks preflight
  // applies to the PR-head copies — a broken base config is not a free pass.
  if (base["baseline.json"]) {
    for (const key of ["schemaVersion", "scoringBackend", "cases"])
      if (!(key in base["baseline.json"]))
        errors.push({
          check: "gate-config",
          file: `${baseRef}:evals/battery/baseline.json`,
          message: `missing required key '${key}' — fail closed`,
        });
    if (base["baseline.json"].scoringBackend && base["baseline.json"].scoringBackend !== SCORING_BACKEND)
      errors.push({
        check: "gate-config",
        file: `${baseRef}:evals/battery/baseline.json`,
        message: `scoringBackend '${base["baseline.json"].scoringBackend}' != current backend '${SCORING_BACKEND}' — not comparable across backends`,
      });
  }
  if (base["thresholds.json"]) {
    for (const key of REQUIRED_THRESHOLD_KEYS)
      if (!(key in base["thresholds.json"]))
        errors.push({
          check: "gate-config",
          file: `${baseRef}:evals/battery/thresholds.json`,
          message: `missing required key '${key}' — fail closed`,
        });
  }

  // Manifest gating knobs. `minActiveCases` and the set of cases that count as
  // active both come from base when available.
  const baseActiveIds = baseManifest ? [...new Set(baseManifest.activeCases || [])] : null;
  const minActiveCases =
    typeof baseManifest?.minActiveCases === "number" ? baseManifest.minActiveCases : head.manifest?.minActiveCases;

  const headById = new Map(head.cases.filter((c) => typeof c.def?.id === "string").map((c) => [c.def.id, c]));
  /** Cases active at base that the PR retired — they keep gating. */
  const resurrectedCases = [];
  for (const id of baseActiveIds || []) {
    const headCase = headById.get(id);
    if (!headCase) {
      // Deleting a gating case in the same PR must fail, never silently drop it.
      errors.push({
        check: "gate-config",
        file: `evals/battery/cases/${id}.json`,
        message: `case '${id}' is active at ${baseRef} but has no case file at HEAD — a PR cannot remove a gating case`,
      });
      continue;
    }
    if (headCase.def.status !== "active") {
      resurrectedCases.push(headCase);
      warnings.push(
        `case '${id}' is '${headCase.def.status}' at HEAD but active at ${baseRef} — still gating this run ` +
          `(retirement takes effect only once it has landed on the base branch)`
      );
    }
  }

  const effectiveActiveIds = new Set([
    ...head.cases.filter((c) => c.def?.status === "active").map((c) => c.def.id),
    ...resurrectedCases.map((c) => c.def.id),
  ]);
  if (typeof minActiveCases === "number" && effectiveActiveIds.size < minActiveCases)
    errors.push({
      check: "gate-config",
      file: `${baseRef}:evals/battery/manifest.json`,
      message: `effective active case count ${effectiveActiveIds.size} < minActiveCases ${minActiveCases} (base-ref value)`,
    });

  return { baseRef, sources, baseline, thresholds, minActiveCases, baseActiveIds, resurrectedCases, errors, warnings };
}
