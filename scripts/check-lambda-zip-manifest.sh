#!/usr/bin/env bash
# ─── Lambda zip manifest guard (TEAM-3696, generalized TEAM-4739) ─────────────
#
# A Lambda's deploy script hand-lists the files packed into its zip.
# TEAM-3696: review-cap.mjs, ship-review.mjs, completion.mjs were added to the
# orchestrator as local imports but omitted from the `zip -rq function.zip ...`
# line, so the deployed Lambda died at cold start with ERR_MODULE_NOT_FOUND.
#
# This script walks the transitive local-import closure (relative `./x.mjs`
# imports only, followed recursively) starting from the Lambda entrypoints
# packed in the zip and fails if any module in that closure is missing from the
# zip manifest line in the deploy script.
#
# It defaults to the orchestrator (the surface TEAM-3696 broke) and takes flags
# for any other single-directory Lambda — TEAM-4739 added gate-contract.mjs to
# the two ticket Lambdas, which have the same hand-listed zip line and the same
# cold-start failure mode:
#
#   --dir <path>            Lambda source dir      (default lambda/orchestrator)
#   --entry <file.mjs>      entrypoint, repeatable (default: the orchestrator's 3)
#   --manifest-file <path>  the deploy script carrying the zip line
#                                                  (default lambda/orchestrator/deploy.sh)
#   --zip <archive>         validate an ACTUAL built archive instead: every module
#                           in the import closure must be physically present in
#                           the zip. The pipeline's Build stage builds its own
#                           orchestrator.zip from an independently maintained file
#                           list, so this mode catches a module the buildspec's
#                           list omits even when deploy.sh's line is correct
#                           (Codex PR #263 P2).
#   --surfaces [path]       validate every Lambda row of the Deploy stage's
#                           surface manifest (default deploy/pipeline/surfaces.json):
#                           the closure of <dir>/index.mjs must be covered by the
#                           row's `files` (a trailing-`/` entry covers its subtree).
#                           TEAM-5170: buildspec-deploy.yml Target 1b zips from
#                           THAT list, not from each deploy.sh — TEAM-5167 put
#                           s3-conditional.mjs on workflow-output's deploy.sh line
#                           but not in its surfaces.json row, so the pipeline would
#                           have shipped a zip that dies at cold start while every
#                           deploy.sh check stayed green.
set -euo pipefail
cd "$(dirname "$0")/.."

LAMBDA_DIR=""
MANIFEST_FILE=""
ZIP_PATH=""
SURFACES_FILE=""
declare -a ENTRYPOINTS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir) LAMBDA_DIR="${2:?--dir requires a path}"; shift 2 ;;
    --entry) ENTRYPOINTS+=("${2:?--entry requires a file name}"); shift 2 ;;
    --manifest-file) MANIFEST_FILE="${2:?--manifest-file requires a path}"; shift 2 ;;
    --zip) ZIP_PATH="${2:?--zip requires an archive path}"; shift 2 ;;
    --surfaces)
      if [ -n "${2:-}" ] && [ "${2#--}" = "$2" ]; then SURFACES_FILE="$2"; shift 2
      else SURFACES_FILE="deploy/pipeline/surfaces.json"; shift; fi ;;
    *) echo "FAIL: unknown argument: $1" >&2
       echo "usage: $0 [--dir DIR] [--entry FILE.mjs]... [--manifest-file PATH] [--zip ARCHIVE] | --surfaces [PATH]" >&2
       exit 2 ;;
  esac
done

if [ -n "$SURFACES_FILE" ]; then
  if [ -n "$LAMBDA_DIR$MANIFEST_FILE$ZIP_PATH" ] || [ "${#ENTRYPOINTS[@]}" -gt 0 ]; then
    echo "FAIL: --surfaces checks every manifest row and takes no --dir/--entry/--manifest-file/--zip" >&2
    exit 2
  fi
  [ -f "$SURFACES_FILE" ] || { echo "FAIL: $SURFACES_FILE does not exist"; exit 1; }
fi

# Defaults: the orchestrator invocation, unchanged.
[ -n "$LAMBDA_DIR" ] || LAMBDA_DIR="lambda/orchestrator"
[ -n "$MANIFEST_FILE" ] || MANIFEST_FILE="lambda/orchestrator/deploy.sh"
if [ "${#ENTRYPOINTS[@]}" -eq 0 ]; then
  if [ "$LAMBDA_DIR" = "lambda/orchestrator" ]; then
    ENTRYPOINTS=("index.mjs" "agent-invoker.mjs" "events-writer.mjs")
  else
    ENTRYPOINTS=("index.mjs")
  fi
fi

CHECK_SOURCE="$MANIFEST_FILE"
if [ -n "$ZIP_PATH" ]; then
  command -v unzip >/dev/null || { echo "FAIL: unzip not found (needed for --zip mode)"; exit 1; }
  # Materialize the zip's actual entry list; the node check reads it as the manifest.
  CHECK_SOURCE="$(mktemp)"
  unzip -Z1 "$ZIP_PATH" > "$CHECK_SOURCE"
fi

SURFACES_FILE="$SURFACES_FILE" node - "$CHECK_SOURCE" "$LAMBDA_DIR" "$ZIP_PATH" "${ENTRYPOINTS[@]}" <<'EOF'
const fs = require("fs");
const path = require("path");

const [checkSourcePath, lambdaDir, zipPath, ...entrypoints] = process.argv.slice(2);
const zipMode = zipPath !== "";
const surfacesFile = process.env.SURFACES_FILE || "";

function localImports(file) {
  const src = fs.readFileSync(file, "utf8");
  const re = /from\s+["']\.\/([\w.-]+\.mjs)["']/g;
  const out = [];
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

// Transitive closure over relative ./x.mjs imports, starting from the entrypoints.
function importClosure(dir, entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const full = path.join(dir, name);
    if (!fs.existsSync(full)) {
      console.error(`FAIL: ${full} does not exist (imported but missing)`);
      process.exit(1);
    }
    for (const dep of localImports(full)) queue.push(dep);
  }
  return seen;
}

if (surfacesFile) {
  // One pass over every Lambda row; rows without an index.mjs (e.g. the python
  // session reaper) have no .mjs closure to check.
  const rows = JSON.parse(fs.readFileSync(surfacesFile, "utf8")).lambdas || [];
  const failures = [];
  let checked = 0;
  for (const row of rows) {
    if (!fs.existsSync(path.join(row.dir, "index.mjs"))) continue;
    checked++;
    const files = row.files || [];
    const covered = (name) => files.some((f) => f === name || (f.endsWith("/") && name.startsWith(f)));
    const missing = [...importClosure(row.dir, ["index.mjs"])].filter((name) => !covered(name));
    if (missing.length) failures.push(`${row.function} (${row.dir}):\n` + missing.map((m) => `  - ${m}`).join("\n"));
  }
  if (failures.length) {
    console.error(`FAIL: local-import closure not covered by the \`files\` list in ${surfacesFile}:\n` + failures.join("\n"));
    process.exit(1);
  }
  console.log(`lambda zip manifest guard: OK (${checked} Lambda rows in ${surfacesFile}, every closure covered)`);
  process.exit(0);
}

const seen = importClosure(lambdaDir, entrypoints);

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
  // The zip line, in whatever form the deploy script writes it: `zip -rq
  // function.zip a.mjs ...` (orchestrator deploy.sh) or `zip -j "$zip" a.mjs ...`
  // inside an execSync template (deploy/setup-tickets-lambda.mjs). Matched by
  // "the word zip, a flag, and at least one .mjs on the same line" so a new
  // packaging idiom does not silently stop being checked; more than one such line
  // is ambiguous and fails rather than guessing which one is the manifest.
  const manifestSrc = fs.readFileSync(checkSourcePath, "utf8");
  const zipLines = manifestSrc.match(/(?:^|[^\w-])zip\s+-[^\n]*\.mjs[^\n]*/g) || [];
  if (zipLines.length === 0) {
    console.error(`FAIL: no "zip -<flags> ... *.mjs" line found in ${checkSourcePath}`);
    process.exit(1);
  }
  if (zipLines.length > 1) {
    console.error(
      `FAIL: ${zipLines.length} candidate zip manifest lines in ${checkSourcePath} — ` +
        `cannot tell which one packs ${entrypoints.join(", ")}:\n` +
        zipLines.map((l) => `  - ${l.trim()}`).join("\n"),
    );
    process.exit(1);
  }
  const zipLine = zipLines[0];
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
  `lambda zip manifest guard: OK (${seen.size} modules in closure of ${lambdaDir}, ` +
    `all present in ${describe})`,
);
EOF
# Clean up the temp listing in --zip mode.
if [ -n "$ZIP_PATH" ]; then rm -f "$CHECK_SOURCE"; fi
