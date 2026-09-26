// TEAM-5170 — the Lambda deploy guards, pinned.
//
// TEAM-5167 added lambda/workflow-output/s3-conditional.mjs as a local import of
// index.mjs and listed it on deploy.sh's zip line, but not in the workflow-output
// row of deploy/pipeline/surfaces.json. The pipeline's Deploy stage zips from
// THAT list (buildspec-deploy.yml Target 1b), so the next pipeline deploy would
// have shipped a zip that dies at cold start with ERR_MODULE_NOT_FOUND — and no
// gate ran check-lambda-zip-manifest.sh against workflow-output or against the
// surfaces.json file lists at all. The same sweep found every create-function
// site still pinned to the deprecated nodejs20.x runtime.
//
// Hermetic: bash subprocesses against tmpdir fixtures plus read-only scans of
// the repo. No AWS, no network.
//
// Run: `node --test scripts/__tests__/lambda-deploy-guards.test.mjs`

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO, "scripts", "check-lambda-zip-manifest.sh");
const RAILS = ["deploy/pipeline/buildspec-ci.yml", ".github/workflows/ci.yml"];

function runGuard(args) {
  const r = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// index.mjs -> ./a.mjs -> ./b.mjs: b is only reachable transitively.
function lambdaFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "zip-manifest-"));
  const dir = path.join(root, "fn");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "index.mjs"), 'import { a } from "./a.mjs";\nexport const handler = a;\n');
  writeFileSync(path.join(dir, "a.mjs"), 'import { b } from "./b.mjs";\nexport const a = b;\n');
  writeFileSync(path.join(dir, "b.mjs"), "export const b = () => 1;\n");
  return { root, dir };
}

test("both CI rails run the manifest guard on workflow-output and on surfaces.json", () => {
  for (const rail of RAILS) {
    // ci.yml wraps long invocations with `\` continuations; join them first.
    const src = readFileSync(path.join(REPO, rail), "utf8").replace(/\\\n\s*/g, "");
    // assert.ok, not assert.match: a failure should name the rail, not dump the file.
    assert.ok(/check-lambda-zip-manifest\.sh --dir lambda\/workflow-output\b/.test(src), `${rail}: no workflow-output manifest check`);
    assert.ok(/check-lambda-zip-manifest\.sh --surfaces\b/.test(src), `${rail}: no surfaces.json manifest check`);
  }
});

test("--surfaces passes against the repo's own deploy/pipeline/surfaces.json", () => {
  const r = runGuard(["--surfaces"]);
  assert.equal(r.code, 0, r.out);
});

test("deploy-script mode fails when a transitive local import is missing from the zip line", (t) => {
  const { root, dir } = lambdaFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const deploySh = path.join(root, "deploy.sh");

  writeFileSync(deploySh, "zip -qr function.zip index.mjs a.mjs node_modules\n");
  const bad = runGuard(["--dir", dir, "--entry", "index.mjs", "--manifest-file", deploySh]);
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /- b\.mjs/);

  writeFileSync(deploySh, "zip -qr function.zip index.mjs a.mjs b.mjs node_modules\n");
  const good = runGuard(["--dir", dir, "--entry", "index.mjs", "--manifest-file", deploySh]);
  assert.equal(good.code, 0, good.out);
});

test("--surfaces fails when a surfaces.json files list omits a closure module", (t) => {
  const { root, dir } = lambdaFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const surfaces = path.join(root, "surfaces.json");
  const write = (files) =>
    writeFileSync(surfaces, JSON.stringify({ lambdas: [{ function: "fixture-fn", dir, files }] }));

  write(["index.mjs", "a.mjs", "node_modules/"]);
  const bad = runGuard(["--surfaces", surfaces]);
  assert.notEqual(bad.code, 0, bad.out);
  assert.match(bad.out, /fixture-fn/);
  assert.match(bad.out, /- b\.mjs/);

  write(["index.mjs", "a.mjs", "b.mjs", "node_modules/"]);
  const good = runGuard(["--surfaces", surfaces]);
  assert.equal(good.code, 0, good.out);
});

test("no Lambda create site uses a deprecated Node.js runtime (< nodejs22.x)", () => {
  const files = [];
  const walk = (rel) => {
    for (const ent of readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
      const p = path.join(rel, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== "node_modules" && ent.name !== "fixtures") walk(p);
      } else if (!/\.test\./.test(ent.name)) {
        if (rel.startsWith("lambda") ? /^(deploy\.sh|template\.ya?ml)$/.test(ent.name) : /\.(sh|mjs)$/.test(ent.name)) {
          files.push(p);
        }
      }
    }
  };
  walk("lambda");
  walk("deploy");

  const re = /(?:--runtime\s+|Runtime:\s*["']?)nodejs(\d+)\.x/g;
  let matches = 0;
  const stale = [];
  for (const f of files) {
    readFileSync(path.join(REPO, f), "utf8").split("\n").forEach((line, i) => {
      for (const m of line.matchAll(re)) {
        matches++;
        if (Number(m[1]) < 22) stale.push(`${f}:${i + 1}: nodejs${m[1]}.x`);
      }
    });
  }
  assert.ok(matches > 0, "runtime regex matched nothing — the scan is broken, not clean");
  assert.deepEqual(stale, [], `deprecated runtime at:\n  ${stale.join("\n  ")}`);
});
