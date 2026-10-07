// TEAM-5358 — scripts/check-sibling-copies.sh, pinned.
//
// The guard md5s every group in scripts/sibling-copies.json and names the path
// that diverges. These tests run it against tmpdir manifests (so they stay green
// while a group is legitimately red on a lane branch), and pin the manifest
// itself against the repo: every listed copy exists, and no copy of a listed
// module exists that the manifest does not name.
//
// Run: `node --test scripts/__tests__/sibling-copies.test.mjs`

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO, "scripts", "check-sibling-copies.sh");
const MANIFEST = JSON.parse(readFileSync(path.join(REPO, "scripts", "sibling-copies.json"), "utf8"));
const RAILS = ["deploy/pipeline/buildspec-ci.yml", ".github/workflows/ci.yml"];

function runGuard(manifest) {
  const r = spawnSync("bash", [SCRIPT, "--manifest", manifest], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function fixture(files, groups) {
  const root = mkdtempSync(path.join(tmpdir(), "sibling-copies-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(root, name), body);
  const abs = Object.fromEntries(Object.entries(groups).map(([g, ps]) => [g, ps.map((p) => path.join(root, p))]));
  const manifest = path.join(root, "manifest.json");
  writeFileSync(manifest, JSON.stringify({ groups: abs }));
  return { root, manifest };
}

test("both CI rails run the guard", () => {
  for (const rail of RAILS) {
    const src = readFileSync(path.join(REPO, rail), "utf8");
    assert.ok(src.includes("./scripts/check-sibling-copies.sh"), `${rail}: no sibling-copy guard`);
  }
});

test("the guard is executable like its sibling guards", () => {
  assert.ok(statSync(SCRIPT).mode & 0o100, "scripts/check-sibling-copies.sh must be mode 100755");
});

test("identical copies pass and print the group digest", () => {
  const { manifest } = fixture({ "a.mjs": "x\n", "b.mjs": "x\n" }, { "m.mjs": ["a.mjs", "b.mjs"] });
  const r = runGuard(manifest);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ok {3}m\.mjs {2}[0-9a-f]{32} {2}x2/);
});

test("a diverging copy exits 1 and names that path, not the canonical one", () => {
  const { root, manifest } = fixture(
    { "a.mjs": "x\n", "b.mjs": "x\n", "c.mjs": "y\n" },
    { "m.mjs": ["a.mjs", "b.mjs", "c.mjs"] },
  );
  const r = runGuard(manifest);
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes(`${path.join(root, "c.mjs")} (`), r.out);
  assert.ok(!r.out.includes(`${path.join(root, "b.mjs")} (`), r.out);
});

test("a missing copy exits 1 and names it", () => {
  const { root, manifest } = fixture({ "a.mjs": "x\n" }, { "m.mjs": ["a.mjs", "gone.mjs"] });
  const r = runGuard(manifest);
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes(`copy missing: ${path.join(root, "gone.mjs")}`), r.out);
});

test("every copy the manifest lists exists in the repo", () => {
  for (const [group, paths] of Object.entries(MANIFEST.groups)) {
    assert.ok(paths.length >= 2, `${group}: fewer than two copies`);
    for (const p of paths) assert.ok(existsSync(path.join(REPO, p)), `${group}: ${p} does not exist`);
  }
});

test("no copy of a listed module exists outside the manifest", () => {
  for (const top of ["lambda", "deploy"]) {
    for (const dir of readdirSync(path.join(REPO, top), { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const group of Object.keys(MANIFEST.groups)) {
        const rel = `${top}/${dir.name}/${group}`;
        if (!existsSync(path.join(REPO, rel))) continue;
        assert.ok(MANIFEST.groups[group].includes(rel), `${rel} exists but scripts/sibling-copies.json does not list it`);
      }
    }
  }
});
