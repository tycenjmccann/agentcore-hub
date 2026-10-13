/**
 * lambda/prd-submitter/deploy-surface.test.mjs
 *
 * The prd-submitter is shipped by two packagers — deploy/continuous-improvement/
 * deploy.sh (env + zip, human-run) and deploy/pipeline/surfaces.json (CD, code
 * only) — and deploy.sh's --environment REPLACES the whole variable set. Nothing
 * else ties either list to the code, so a var or sibling module left out passes
 * every other check and fails only in AWS. This reads the code and both lists.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// Set by the Lambda runtime itself, never by --environment.
const RUNTIME_RESERVED = new Set(["AWS_REGION"]);

/** index.mjs plus every local module it reaches, transitively. */
function localModules(entry = "index.mjs", seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const m of readFileSync(join(HERE, entry), "utf8").matchAll(/from\s+"\.\/([^"]+)"/g)) localModules(m[1], seen);
  return seen;
}

function envReads() {
  const names = new Set();
  for (const file of localModules()) {
    for (const m of readFileSync(join(HERE, file), "utf8").matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]);
  }
  return [...names].filter((n) => !RUNTIME_RESERVED.has(n)).sort();
}

const deploySh = read("deploy/continuous-improvement/deploy.sh");

describe("prd-submitter deploy surface", () => {
  it("the code reads the env vars this test expects (guards the scan itself)", () => {
    assert.ok(envReads().includes("SI_APPROVER_HOURS"));
    assert.ok(envReads().includes("SI_APPROVER_DAYS"));
    assert.ok(localModules().has("approver-window.mjs"));
  });

  it("deploy.sh's replacement env list carries every var the Lambda reads", () => {
    const m = /deploy_lambda "prd-submitter" "prd-submitter" \d+ \d+ \\\s*\n\s*"\{(.*)\}"\s*$/m.exec(deploySh);
    assert.ok(m, "prd-submitter deploy_lambda call not found");
    const listed = m[1].split(",").map((kv) => kv.split("=")[0]);
    assert.deepEqual(envReads().filter((n) => !listed.includes(n)), [], "missing from --environment");
    for (const name of listed) {
      const ref = new RegExp(`${name}=\\$\\{([A-Z_]+)\\}`).exec(m[1])?.[1];
      assert.ok(ref && new RegExp(`^\\s*${ref}=`, "m").test(deploySh), `${name} is assigned from an undefined shell var`);
    }
  });

  it("every local module is in both zip lists", () => {
    const zipped = new Set(["index.mjs", ...[...deploySh.matchAll(/EXTRA_PATHS\+=\(([^)]+)\)/g)].map((x) => x[1])]);
    const entry = JSON.parse(read("deploy/pipeline/surfaces.json"))
      .lambdas.find((l) => l.function === "agentcore-hub-prd-submitter");
    assert.ok(entry, "prd-submitter missing from surfaces.json");
    for (const file of localModules()) {
      assert.ok(zipped.has(file), `${file} missing from deploy.sh EXTRA_PATHS`);
      assert.ok(entry.files.includes(file), `${file} missing from surfaces.json files[]`);
    }
  });
});
