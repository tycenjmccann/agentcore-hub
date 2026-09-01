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

DEPLOY_SH="lambda/orchestrator/deploy.sh"
ORCH_DIR="lambda/orchestrator"
ENTRYPOINTS=("index.mjs" "agent-invoker.mjs" "events-writer.mjs")

node - "$DEPLOY_SH" "$ORCH_DIR" "${ENTRYPOINTS[@]}" <<'EOF'
const fs = require("fs");
const path = require("path");

const [deployShPath, orchDir, ...entrypoints] = process.argv.slice(2);

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

const deployShSrc = fs.readFileSync(deployShPath, "utf8");
const zipLineMatch = deployShSrc.match(/zip -rq function\.zip[^\n]*/);
if (!zipLineMatch) {
  console.error(`FAIL: no "zip -rq function.zip ..." line found in ${deployShPath}`);
  process.exit(1);
}
const zipLine = zipLineMatch[0];

const missing = [...seen].filter((name) => !zipLine.includes(name));
if (missing.length) {
  console.error(
    `FAIL: ${missing.length} module(s) in the local-import closure of ` +
      `${entrypoints.join(", ")} are missing from the zip manifest line in ${deployShPath}:\n` +
      missing.map((m) => `  - ${m}`).join("\n"),
  );
  process.exit(1);
}

console.log(
  `lambda zip manifest guard: OK (${seen.size} modules in closure, all present in zip manifest)`,
);
EOF
