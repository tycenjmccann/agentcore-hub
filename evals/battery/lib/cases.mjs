// Case/manifest/baseline loading + preflight (FR-2). Pure over an injectable
// repo root so vitest can point it at a fixture tree. Any preflight failure is
// a structured error and a gate FAIL — malformed config must fail loudly
// BEFORE any Bedrock spend.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

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
    for (const id of activeIds)
      if (!manifestIds.has(id)) fail("manifest", "evals/battery/manifest.json", `active case '${id}' missing from activeCases`);
    for (const id of manifestIds)
      if (!activeIds.has(id)) fail("manifest", "evals/battery/manifest.json", `activeCases lists '${id}' but no active case file has that id`);
    if ((manifest.activeCases || []).length < manifest.minActiveCases)
      fail("manifest", "evals/battery/manifest.json",
        `activeCases count ${(manifest.activeCases || []).length} < minActiveCases ${manifest.minActiveCases}`);
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
  };
}
