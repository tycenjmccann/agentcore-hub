#!/usr/bin/env bash
# ─── cd-registry.mjs byte-copy parity guard (TEAM-4337) ──────────────────────
#
# lambda/orchestrator/cd-registry.mjs is the canonical, zero-import CD-registry
# module (parseCdRegistry / findCdEntry / pipelineProjects / resolveDelivery /
# deliveryModeContext). It is byte-copied — never imported — into:
#
#   1. lambda/agentcore-hub-pipeline-tools/cd-registry.mjs
#      (each Lambda ships as a self-contained zip built from its own dir, so a
#      cross-directory import would not survive packaging)
#   2. deploy/telegram-bug-intake/cd-registry.mjs
#      (the bridge lives outside lambda/ entirely and has the same zip-per-dir
#      constraint)
#
# A copy that drifts from the canonical file is a silent split-brain: the tools
# Lambda or the bridge would resolve a different pipeline/project set than the
# orchestrator's agent context promised. This guard byte-compares the three
# copies and fails on ANY difference, same shape as
# scripts/check-fix-kinds-parity.sh's fix-contract.mjs check (step 1).
set -euo pipefail
cd "$(dirname "$0")/.."

CANON="lambda/orchestrator/cd-registry.mjs"
fail=0

for copy in lambda/agentcore-hub-pipeline-tools/cd-registry.mjs deploy/telegram-bug-intake/cd-registry.mjs; do
  if [ ! -f "$copy" ]; then
    echo "FAIL: missing cd-registry.mjs copy: $copy" >&2
    fail=1
  elif ! cmp -s "$CANON" "$copy"; then
    echo "FAIL: $copy is not byte-identical to $CANON" >&2
    echo "      cd-registry.mjs is a zero-import module duplicated per Lambda/bridge zip." >&2
    echo "      Edit ONE copy, then: cp $CANON $copy" >&2
    diff <(cat "$CANON") <(cat "$copy") | head -20 >&2 || true
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "cd-registry parity guard FAILED — edit lambda/orchestrator/cd-registry.mjs" >&2
  echo "(the canonical copy), then re-cp into both other locations." >&2
  exit 1
fi

echo "cd-registry parity guard: OK"
echo "  cd-registry.mjs = 3 byte-identical copies"
