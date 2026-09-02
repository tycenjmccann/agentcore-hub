#!/usr/bin/env bash
# ─── Orchestrator zip manifest guard (TEAM-3696) ──────────────────────────────
#
# lambda/orchestrator/deploy.sh hand-lists the files packed into function.zip.
# TEAM-3696: review-cap.mjs, ship-review.mjs, completion.mjs were added as
# local imports but omitted from the `zip -rq function.zip ...` line, so the
# deployed Lambda died at cold start with ERR_MODULE_NOT_FOUND.
#
# This script walks the transitive local-import closure (relative `./x.mjs`
# imports only, followed recursively) starting from the Lambda entrypoints
# packed in the zip — index.mjs, agent-invoker.mjs, events-writer.mjs — and
# fails if any module in that closure is missing from the zip manifest line
# in deploy.sh. model-router.mjs is test-only (no entrypoint imports it) and
# is correctly excluded from both the closure and the zip.
set -euo pipefail
cd "$(dirname "$0")/.."

ORCH_DIR="lambda/orchestrator"
ENTRYPOINTS=("index.mjs" "agent-invoker.mjs" "events-writer.mjs")

# Two modes:
#   (default)         validate deploy.sh's hand-listed zip manifest line.
#   --zip <archive>   validate an ACTUAL built archive: every module in the
#                     import closure must be physically present in the zip. The
#                     pipeline's Build stage builds its own orchestrator.zip
#                     from an independently maintained file list, so this mode
#                     catches a module the buildspec's list omits even when
#                     deploy.sh's line is correct (Codex PR #263 P2).
ZIP_PATH=""
CHECK_SOURCE="lambda/orchestrator/deploy.sh"
if [ "${1:-}" = "--zip" ]; then
  ZIP_PATH="${2:?--zip requires an archive path}"
  command -v unzip >/dev/null || { echo "FAIL: unzip not found (needed for --zip mode)"; exit 1; }
  # Materialize the zip's actual entry list; the node check reads it as the manifest.
  CHECK_SOURCE="$(mktemp)"
  unzip -Z1 "$ZIP_PATH" > "$CHECK_SOURCE"
fi

node - "$CHECK_SOURCE" "$ORCH_DIR" "$ZIP_PATH" "${ENTRYPOINTS[@]}" <<'EOF'
const fs = require("fs");
const path = require("path");

const [checkSourcePath, orchDir, zipPath, ...entrypoints] = process.argv.slice(2);
const zipMode = zipPath !== "";

function localImports(file) {
  const src = fs.readFileSync(file, "utf8");
  const re = /from\s+["']\.\/([\w.-]+\.mjs)["']/g;
  const out = [];
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

// Transitive closure over relative ./x.mjs imports, starting from the entrypoints.
const seen = new Set();
const queue = [...entrypoints];
while (queue.length) {
  const name = queue.shift();
  if (seen.has(name)) continue;
  seen.add(name);
  const full = path.join(orchDir, name);
  if (!fs.existsSync(full)) {
    console.error(`FAIL: ${full} does not exist (imported but missing)`);
    process.exit(1);
  }
  for (const dep of localImports(full)) queue.push(dep);
}

let manifest, describe;
if (zipMode) {
  // The manifest is the archive's actual entry listing (unzip -Z1). A module is
  // present iff a zip entry basename equals it (entries look like "index.mjs" or
  // "node_modules/...").
  const entries = fs.readFileSync(checkSourcePath, "utf8").split("\n").filter(Boolean);
  const basenames = new Set(entries.map((e) => e.split("/").pop()));
  manifest = (name) => basenames.has(name);
  describe = `built archive ${zipPath}`;
} else {
  const deployShSrc = fs.readFileSync(checkSourcePath, "utf8");
  const zipLineMatch = deployShSrc.match(/zip -rq function\.zip[^\n]*/);
  if (!zipLineMatch) {
    console.error(`FAIL: no "zip -rq function.zip ..." line found in ${checkSourcePath}`);
    process.exit(1);
  }
  const zipLine = zipLineMatch[0];
  manifest = (name) => zipLine.includes(name);
  describe = `zip manifest line in ${checkSourcePath}`;
}

const missing = [...seen].filter((name) => !manifest(name));
if (missing.length) {
  console.error(
    `FAIL: ${missing.length} module(s) in the local-import closure of ` +
      `${entrypoints.join(", ")} are missing from the ${describe}:\n` +
      missing.map((m) => `  - ${m}`).join("\n"),
  );
  process.exit(1);
}

console.log(
  `lambda zip manifest guard: OK (${seen.size} modules in closure, all present in ${describe})`,
);
EOF
# Clean up the temp listing in --zip mode.
if [ -n "$ZIP_PATH" ]; then rm -f "$CHECK_SOURCE"; fi
