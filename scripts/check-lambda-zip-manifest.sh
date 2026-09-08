#!/usr/bin/env bash
# ─── Lambda zip manifest / import-closure guard (TEAM-3696, TEAM-4295) ────────
#
# A Lambda's zip manifest is hand-maintained in two independent places, and a
# local import left out of either ships a function that dies at cold start with
# ERR_MODULE_NOT_FOUND:
#
#   1. lambda/orchestrator/deploy.sh's `zip -rq function.zip ...` line (Target 1).
#      TEAM-3696: review-cap.mjs, ship-review.mjs, completion.mjs were added as
#      local imports but omitted from that line.
#   2. Each entry's `files` list in deploy/pipeline/surfaces.json (Target 1b).
#      TEAM-4295: deploy/pipeline/buildspec-deploy.yml runs a bare
#      `zip -rq /tmp/surface.zip $FILES` where $FILES is that list verbatim (via
#      plan-surfaces.py). The workflow-analyzer entry listed index.mjs alone while
#      index.mjs statically imports liveness.mjs -> liveness-constants.mjs ->
#      liveness-constants.json, so the first pipeline deploy of that directory
#      would have taken the whole WATCH/ANALYZE watchdog dark. check-deploy-
#      surfaces.sh could not catch it: that guard checks PATH coverage by dir
#      prefix, not import closure.
#
# Both are validated here against the same transitive local closure: static and
# dynamic `./x.mjs` specifiers plus local `./x.json` runtime reads, followed
# recursively from each entrypoint. model-router.mjs is test-only (no entrypoint
# imports it) and is correctly excluded from both the closure and the zip.
set -euo pipefail
cd "$(dirname "$0")/.."

ORCH_DIR="lambda/orchestrator"
ENTRYPOINTS=("index.mjs" "agent-invoker.mjs" "events-writer.mjs")
SURFACES="deploy/pipeline/surfaces.json"

# Three modes:
#   (default)            validate deploy.sh's hand-listed zip manifest line AND
#                        every surfaces.json lambda entry's `files` list.
#   --zip <archive>      validate an ACTUAL built orchestrator archive: every
#                        module in the import closure must be physically present.
#                        The pipeline's Build stage builds its own orchestrator.zip
#                        from an independently maintained file list, so this mode
#                        catches a module the buildspec's list omits even when
#                        deploy.sh's line is correct (Codex PR #263 P2).
#   --surfaces <path>    run the surfaces pass against a different manifest (used
#                        to demonstrate the guard failing on a pre-fix manifest).
ZIP_PATH=""
CHECK_SOURCE="lambda/orchestrator/deploy.sh"
SURFACES_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --zip)
      ZIP_PATH="${2:?--zip requires an archive path}"
      command -v unzip >/dev/null || { echo "FAIL: unzip not found (needed for --zip mode)"; exit 1; }
      # Materialize the zip's actual entry list; the node check reads it as the manifest.
      CHECK_SOURCE="$(mktemp)"
      unzip -Z1 "$ZIP_PATH" > "$CHECK_SOURCE"
      shift 2
      ;;
    --surfaces)
      SURFACES="${2:?--surfaces requires a manifest path}"
      SURFACES_ONLY=1
      shift 2
      ;;
    *)
      echo "usage: $0 [--zip <archive>] [--surfaces <surfaces.json>]" >&2
      exit 2
      ;;
  esac
done

node - "$CHECK_SOURCE" "$ORCH_DIR" "$ZIP_PATH" "$SURFACES" "$SURFACES_ONLY" "${ENTRYPOINTS[@]}" <<'EOF'
const fs = require("fs");
const path = require("path");

const [checkSourcePath, orchDir, zipPath, surfacesPath, surfacesOnlyRaw, ...entrypoints] =
  process.argv.slice(2);
const zipMode = zipPath !== "";
const surfacesOnly = surfacesOnlyRaw === "1";

// ── Closure ─────────────────────────────────────────────────────────────────
// Drop comment-only lines before scanning. A docblock that merely NAMES a module
// or a JSON file (liveness-constants.mjs's header quotes "./liveness-constants.json")
// must not manufacture a closure member, which would force the manifest to list a
// file nothing actually reads.
function scannableBody(src) {
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*"));
    })
    .join("\n");
}

// Static `from "./x.mjs"` / bare `import "./x.mjs"` AND dynamic `import("./x.mjs")`.
const MJS_RE = /(?:from|import)\s*\(?\s*["'](\.\.?\/[\w.\/-]+\.mjs)["']/g;
// Local JSON read at runtime — a string literal, since these are readFileSync'd
// (lease.mjs's "./lease-constants.json", liveness-constants.mjs's mirror), not imported.
const JSON_RE = /["'](\.\.?\/[\w.\/-]+\.json)["']/g;

/**
 * Transitive local closure from `entrypoints`, as paths relative to `dir`.
 * Specifiers resolve against the IMPORTING file's directory, so a subdirectory
 * module (eval-packager's ./lib/classify.mjs) resolves its own siblings correctly.
 *
 * `.mjs` members must exist on disk (an import of a missing file is always a bug).
 * `.json` members are NOT existence-checked: lambda/orchestrator/lease-constants.json
 * is legitimately uncommitted (deploy.sh and buildspec-ci.yml copy it in around the
 * zip), so only manifest COVERAGE is enforced for JSON.
 *
 * A specifier that resolves OUTSIDE the Lambda dir is skipped: a zip rooted at that
 * dir cannot carry it, so there is no manifest entry to demand. Both current cases
 * are the deliberate repo-only "../../src/config/*-constants.json" fallback candidates
 * (lease.mjs, liveness-constants.mjs) which resolve only in a checkout, never in a
 * deployed zip. No `.mjs` specifier escapes its dir today.
 */
function closureOf(dir, entrypoints) {
  const mjs = new Set();
  const json = new Set();
  const queue = [...entrypoints];
  // Not in the zip's namespace: node_modules is npm's, and "../" escapes the root.
  const outsideZip = (p) => p.startsWith("node_modules/") || p === ".." || p.startsWith("../");
  while (queue.length) {
    const name = queue.shift();
    if (mjs.has(name)) continue;
    mjs.add(name);
    const full = path.join(dir, name);
    if (!fs.existsSync(full)) {
      console.error(`FAIL: ${full} does not exist (imported but missing)`);
      process.exit(1);
    }
    const body = scannableBody(fs.readFileSync(full, "utf8"));
    const here = path.dirname(name);
    let m;
    MJS_RE.lastIndex = 0;
    while ((m = MJS_RE.exec(body))) {
      const rel = path.normalize(path.join(here, m[1]));
      if (outsideZip(rel)) continue;
      queue.push(rel);
    }
    JSON_RE.lastIndex = 0;
    while ((m = JSON_RE.exec(body))) {
      const rel = path.normalize(path.join(here, m[1]));
      // package.json is runtime metadata every npm surface already ships, and no
      // module reads it relatively.
      if (outsideZip(rel) || path.basename(rel) === "package.json") continue;
      json.add(rel);
    }
  }
  return [...mjs, ...json];
}

let failed = false;

// ── Pass 1: the orchestrator's hand-listed zip line (or a built archive) ─────
if (!surfacesOnly) {
  const closure = closureOf(orchDir, entrypoints);

  let manifest, describe;
  if (zipMode) {
    // The manifest is the archive's actual entry listing (unzip -Z1). A module is
    // present iff a zip entry basename equals it (entries look like "index.mjs" or
    // "node_modules/...").
    const entries = fs.readFileSync(checkSourcePath, "utf8").split("\n").filter(Boolean);
    const basenames = new Set(entries.map((e) => e.split("/").pop()));
    manifest = (name) => basenames.has(path.basename(name));
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

  const missing = closure.filter((name) => !manifest(name));
  if (missing.length) {
    console.error(
      `FAIL: ${missing.length} file(s) in the local-import closure of ` +
        `${entrypoints.join(", ")} are missing from the ${describe}:\n` +
        missing.map((m) => `  - ${m}`).join("\n"),
    );
    failed = true;
  } else {
    console.log(
      `lambda zip manifest guard: OK (${closure.length} files in closure, all present in ${describe})`,
    );
  }
}

// ── Pass 2: every surfaces.json lambda entry's `files` list ──────────────────
// Skipped in --zip mode, which is specifically about one built orchestrator archive.
if (!zipMode) {
  const manifestDoc = JSON.parse(fs.readFileSync(surfacesPath, "utf8"));
  const lambdas = manifestDoc.lambdas || [];
  let checked = 0;
  let skipped = 0;
  let totalClosure = 0;
  const failures = [];

  for (const entry of lambdas) {
    const dir = entry.dir;
    const files = entry.files || [];
    // An entrypoint is a listed .mjs that exists. Python-only surfaces
    // (session-reaper's handler.py) have none — nothing for this guard to say.
    const eps = files.filter((f) => f.endsWith(".mjs") && fs.existsSync(path.join(dir, f)));
    if (!eps.length) {
      skipped++;
      continue;
    }
    checked++;
    const closure = closureOf(dir, eps);
    totalClosure += closure.length;
    // Covered = listed exactly, or inside a listed directory entry ("lib/").
    const covered = (p) =>
      files.includes(p) || files.some((f) => f.endsWith("/") && p.startsWith(f));
    const missing = closure.filter((p) => !covered(p));
    if (missing.length) failures.push({ entry, missing });
  }

  if (failures.length) {
    for (const { entry, missing } of failures) {
      console.error(
        `FAIL: ${surfacesPath} omits ${missing.length} file(s) from the import closure of ` +
          `${entry.function} (${entry.dir}):\n` +
          missing.map((m) => `  - ${m}`).join("\n") +
          `\n      Add them to that entry's "files" list — the pipeline's Target 1b zips ` +
          `exactly this list (deploy/pipeline/buildspec-deploy.yml).`,
      );
    }
    failed = true;
  } else {
    console.log(
      `surfaces closure guard: OK (${checked} lambdas checked, ${skipped} skipped ` +
        `(no .mjs entrypoint), ${totalClosure} closure files all covered in ${surfacesPath})`,
    );
  }
}

if (failed) process.exit(1);
EOF
# Clean up the temp listing in --zip mode.
if [ -n "$ZIP_PATH" ]; then rm -f "$CHECK_SOURCE"; fi
