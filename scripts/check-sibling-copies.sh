#!/usr/bin/env bash
# ─── sibling-copy guard (TEAM-5358) ───────────────────────────────────────────
#
# Each Lambda (and the Telegram bridge) ships as a self-contained zip built from
# its own directory, so a shared contract module is byte-COPIED into every zip
# that needs it, never imported across directories. scripts/sibling-copies.json
# lists every such group; the first path of a group is canonical.
#
# A copy that drifts is a silent split-brain — one twin admits a decision token
# the other refuses, or one surface writes a record version the others cannot
# verify. This guard md5s every copy, prints each group's digest, and on ANY
# difference names the diverging path and exits 1. There is no soft mode: a
# group that is red because another lane has not landed its copy yet stays red
# until it does.
#
# Usage: scripts/check-sibling-copies.sh [--manifest <path>]   (default: scripts/sibling-copies.json)
set -euo pipefail
cd "$(dirname "$0")/.."

MANIFEST="scripts/sibling-copies.json"
if [ "${1:-}" = "--manifest" ]; then
  MANIFEST="${2:?--manifest needs a path}"
fi

# node, not md5sum/md5: GNU and BSD spell the digest tool differently, and a gate
# nobody can run locally gets ignored locally.
node --input-type=module -e '
  import { readFileSync, existsSync } from "node:fs";
  import { createHash } from "node:crypto";
  const manifest = process.argv[1];
  let groups;
  try {
    groups = JSON.parse(readFileSync(manifest, "utf8")).groups;
  } catch (err) {
    console.error(`FAIL: cannot read ${manifest}: ${err.message}`);
    process.exit(1);
  }
  if (!groups || typeof groups !== "object" || !Object.keys(groups).length) {
    console.error(`FAIL: ${manifest} has no groups`);
    process.exit(1);
  }
  let fail = false;
  for (const [name, paths] of Object.entries(groups)) {
    if (!Array.isArray(paths) || paths.length < 2) {
      console.error(`FAIL: group ${name} lists fewer than two copies`);
      fail = true;
      continue;
    }
    const md5 = (p) => existsSync(p) ? createHash("md5").update(readFileSync(p)).digest("hex") : null;
    const [canon, ...rest] = paths;
    const want = md5(canon);
    if (!want) {
      console.error(`FAIL: ${name}: canonical copy missing: ${canon}`);
      fail = true;
      continue;
    }
    let groupOk = true;
    for (const p of rest) {
      const got = md5(p);
      if (got === want) continue;
      groupOk = false;
      console.error(got
        ? `FAIL: ${name}: ${p} (${got}) diverges from ${canon} (${want})`
        : `FAIL: ${name}: copy missing: ${p}`);
    }
    if (groupOk) console.log(`ok   ${name}  ${want}  x${paths.length}`);
    else {
      console.error(`      Edit ${canon}, then cp it over the other copies listed in ${manifest}.`);
      fail = true;
    }
  }
  process.exit(fail ? 1 : 0);
' "$MANIFEST"
