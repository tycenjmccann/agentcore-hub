#!/usr/bin/env node
// Battery fixture lint (FR-1.4 / FR-9): fails on unsanitized fixtures, schema
// violations, manifest drift, and dangling fixture references. Run via
// `npm run battery:lint`. No deps beyond node builtins; ajv is loaded from the
// repo's node_modules when present, with a structural fallback otherwise.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { duplicateCaseIds } from "./lib/cases.mjs";
import { scanText } from "./lib/redact.mjs";

const BATTERY_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(BATTERY_DIR, "..", "..");
const CASES_DIR = join(BATTERY_DIR, "cases");
const FIXTURES_DIR = join(BATTERY_DIR, "fixtures");

const errors = [];
const fail = (file, line, msg) =>
  errors.push(`${relative(REPO_ROOT, file)}${line ? `:${line}` : ""}  ${msg}`);

// ─── 1. Forbidden-pattern scan over cases/, fixtures/, and baseline.json ────
// Pattern table + scanner live in lib/redact.mjs (shared with the runner's
// write-time artifact redaction, C2). The committed baseline.json is repo
// content and must be clean too.

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

const baselinePath = join(BATTERY_DIR, "baseline.json");
const scanned = [...walk(CASES_DIR), ...walk(FIXTURES_DIR), ...(existsSync(baselinePath) ? [baselinePath] : [])];
for (const file of scanned) {
  for (const f of scanText(readFileSync(file, "utf8"), { file })) {
    fail(file, f.line, `forbidden pattern ${f.pattern} — ${f.why}`);
  }
}

// ─── 2. Case schema validation (ajv when available) ─────────────────────────

const schemaPath = join(BATTERY_DIR, "schema", "case.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

let validate = null;
try {
  const require = createRequire(join(REPO_ROOT, "package.json"));
  const Ajv2020 = require("ajv/dist/2020").default;
  validate = new Ajv2020({ allErrors: true }).compile(schema);
} catch {
  // Structural fallback: required keys, no unknown top-level keys, enums.
  const known = new Set(Object.keys(schema.properties));
  validate = (c) => {
    validate.errors = [];
    for (const key of schema.required)
      if (!(key in c)) validate.errors.push({ message: `missing required '${key}'` });
    for (const key of Object.keys(c))
      if (!known.has(key)) validate.errors.push({ message: `unknown key '${key}'` });
    if (!["active", "retired"].includes(c.status))
      validate.errors.push({ message: `bad status '${c.status}'` });
    if (typeof c.id !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(c.id))
      validate.errors.push({ message: `bad id '${c.id}'` });
    return validate.errors.length === 0;
  };
}

const cases = [];
for (const file of walk(CASES_DIR)) {
  if (!file.endsWith(".json")) continue;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(file, null, `JSON parse error: ${err.message}`);
    continue;
  }
  if (!validate(parsed)) {
    for (const e of validate.errors || [])
      fail(file, null, `schema violation: ${e.instancePath || ""} ${e.message}`);
  }
  cases.push({ file, case: parsed });
}

// ─── 3. Duplicate case ids (B4) ──────────────────────────────────────────────

// Same rule preflight applies: id-keyed rosters silently collapse duplicates,
// so one of the two files would never run and never be missed.
for (const [id, files] of duplicateCaseIds(cases.map(({ file, case: def }) => ({ file, def })))) {
  fail(files[0], null, `duplicate case id '${id}' declared by ${files.length} case files: ${files.map((f) => relative(REPO_ROOT, f)).join(", ")}`);
}

// ─── 4. Manifest cross-check ─────────────────────────────────────────────────

const manifest = JSON.parse(readFileSync(join(BATTERY_DIR, "manifest.json"), "utf8"));
const manifestIds = new Set(manifest.activeCases);
for (const id of new Set(manifest.activeCases.filter((id, i, arr) => arr.indexOf(id) !== i))) {
  fail(join(BATTERY_DIR, "manifest.json"), null, `activeCases lists '${id}' more than once`);
}
const activeCases = cases.filter((c) => c.case.status === "active");
const activeIds = new Set(activeCases.map((c) => c.case.id));

for (const { file, case: c } of activeCases) {
  if (!manifestIds.has(c.id))
    fail(file, null, `active case '${c.id}' missing from manifest.json activeCases`);
}
for (const id of manifestIds) {
  if (!activeIds.has(id))
    fail(join(BATTERY_DIR, "manifest.json"), null, `manifest lists '${id}' but no active case file has that id`);
}
if (manifest.activeCases.length < manifest.minActiveCases)
  fail(join(BATTERY_DIR, "manifest.json"), null,
    `activeCases count ${manifest.activeCases.length} < minActiveCases ${manifest.minActiveCases}`);

// ─── 5. Fixture references + reference-input evaluator dependency ───────────

for (const { file, case: c } of cases) {
  const refs = [];
  if (c.input?.transcript) refs.push(c.input.transcript);
  if (c.input?.repoFixture) refs.push(c.input.repoFixture);
  refs.push(...(c.input?.files || []), ...(c.input?.blueprints || []));
  for (const ref of refs) {
    if (!existsSync(join(BATTERY_DIR, ref)))
      fail(file, null, `referenced fixture path does not exist: ${ref}`);
  }
  if (
    (c.evaluators || []).includes("dependency_chain_compliance-VyBv7H2bCi") &&
    !c.referenceInputs?.expectedToolTrajectory?.length
  ) {
    fail(file, null,
      "dependency_chain_compliance-VyBv7H2bCi is a reference-input evaluator: referenceInputs.expectedToolTrajectory is required");
  }
  if (
    (c.evaluators || []).includes("persona_contract_compliance") &&
    !c.referenceInputs?.personaContract?.length
  ) {
    fail(file, null,
      "persona_contract_compliance is a reference-input evaluator: referenceInputs.personaContract is required");
  }
}

// ─── Report ──────────────────────────────────────────────────────────────────

if (errors.length > 0) {
  console.error(`battery:lint FAILED — ${errors.length} finding(s):\n`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(
  `battery:lint OK — ${cases.length} case file(s) checked (${activeCases.length} active), fixtures sanitized, manifest consistent`
);
