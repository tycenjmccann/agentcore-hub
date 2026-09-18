#!/usr/bin/env bash
# ─── si-ledger.mjs byte-copy + METRIC_NAMES parity guard (TEAM-4760) ──────────
#
# lambda/workflow-analyzer/si-ledger.mjs is the canonical SI recommendation-ledger
# module (newRow / applyOccurrence / applyStatus / applyAttempt / applyExpected /
# applyVerdict / statusAfterOutcome / dedupeBlocked / SiLedger). It is byte-copied
# — never imported — into:
#
#   1. lambda/prd-submitter/si-ledger.mjs
#      (each Lambda ships as a self-contained zip built from its own dir —
#      `cd "$DIR" && zip -rq /tmp/surface.zip $FILES` in
#      deploy/pipeline/buildspec-deploy.yml — so a cross-directory import would
#      cold-start with ERR_MODULE_NOT_FOUND)
#
# A copy that drifts from the canonical file is a silent split-brain: the analyzer
# would dedupe, status and stamp the SAME rows by different rules than the PRD
# submitter, and the ledger would lie about what has already been asked for. Same
# shape and same reasoning as scripts/check-cd-registry-parity.sh (step 1).
#
# Step 2 pins the OTHER half of the contract. si_ledger.py (the Python twin on the
# Workflow Manager harness) and both unit suites agree on one closed list of
# metrics a recommendation may promise to move, and that list lives in
# deploy/workflow-manager/toolkit/fixtures/si-ledger-contract.json. The JS
# METRIC_NAMES literal is compared to it TEXTUALLY here — no import, no
# node_modules — so the enum cannot drift from the fixture even in a change that
# never runs `node --test`.
set -euo pipefail
cd "$(dirname "$0")/.."

CANON="lambda/workflow-analyzer/si-ledger.mjs"
FIXTURE="deploy/workflow-manager/toolkit/fixtures/si-ledger-contract.json"
fail=0

# ── 1. the byte copies ───────────────────────────────────────────────────────
for copy in lambda/prd-submitter/si-ledger.mjs; do
  if [ ! -f "$copy" ]; then
    echo "FAIL: missing si-ledger.mjs copy: $copy" >&2
    fail=1
  elif ! cmp -s "$CANON" "$copy"; then
    echo "FAIL: $copy is not byte-identical to $CANON" >&2
    echo "      si-ledger.mjs is duplicated per Lambda zip, not imported." >&2
    echo "      Edit ONE copy, then: cp $CANON $copy" >&2
    diff <(cat "$CANON") <(cat "$copy") | head -20 >&2 || true
    fail=1
  fi
done

# ── 2. METRIC_NAMES == the fixture's metricNames, in order ───────────────────
metrics_out=""
if [ ! -f "$FIXTURE" ]; then
  echo "FAIL: missing shared contract fixture: $FIXTURE" >&2
  fail=1
elif ! metrics_out=$(node -e '
  const fs = require("node:fs");
  const [canon, fixture] = process.argv.slice(1);
  // Read the literal as TEXT: this guard must run before `npm ci`, and importing
  // si-ledger.mjs would need @aws-sdk/lib-dynamodb resolved.
  const src = fs.readFileSync(canon, "utf8");
  const block = src.match(/export const METRIC_NAMES = Object\.freeze\(\[([^\]]*)\]\)/);
  if (!block) {
    console.error("FAIL: could not find the METRIC_NAMES literal in " + canon);
    console.error("      expected: export const METRIC_NAMES = Object.freeze([ ... ]);");
    process.exit(1);
  }
  const js = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const json = JSON.parse(fs.readFileSync(fixture, "utf8")).metricNames;
  if (!Array.isArray(json)) {
    console.error("FAIL: " + fixture + " has no metricNames array");
    process.exit(1);
  }
  if (JSON.stringify(js) !== JSON.stringify(json)) {
    console.error("FAIL: METRIC_NAMES in " + canon + " does not match metricNames in " + fixture);
    console.error("      .mjs  : " + JSON.stringify(js));
    console.error("      fixture: " + JSON.stringify(json));
    console.error("      Order is part of the contract — both unit suites compare element-wise.");
    process.exit(1);
  }
  console.log("  METRIC_NAMES = " + js.length + " names, identical to the fixture");
' "$CANON" "$FIXTURE" 2>&1); then
  echo "$metrics_out" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "si-ledger parity guard FAILED — edit lambda/workflow-analyzer/si-ledger.mjs" >&2
  echo "(the canonical copy), then re-cp into lambda/prd-submitter/, and keep" >&2
  echo "METRIC_NAMES in step with $FIXTURE (si_ledger.py is tested against it too)." >&2
  exit 1
fi

echo "si-ledger parity guard: OK"
echo "  si-ledger.mjs = 2 byte-identical copies"
echo "$metrics_out"
