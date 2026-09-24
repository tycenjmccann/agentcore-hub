#!/usr/bin/env bash
# ─── model-registry byte-copy parity guard (TEAM-4995) ───────────────────────
#
# One model registry (config/models.json) is read by code in five places that
# cannot import each other — two Python containers, a Lambda zip, a bridge zip,
# and the Next.js app. So the resolver is a zero-import module, byte-copied,
# exactly like cd-registry.mjs (check-cd-registry-parity.sh) and si-ledger.mjs:
#
#   Python pair (each container ships only its own dir):
#     deploy/runtime-agent/models_registry.py       (canonical)
#     deploy/coding-agent-runtime/models_registry.py
#
#   JS trio (each Lambda/bridge ships as a self-contained zip):
#     src/lib/models/models-registry.mjs            (canonical — TEAM-4997)
#     lambda/token-aggregator/models-registry.mjs
#     deploy/telegram-bug-intake/models-registry.mjs
#
# A copy that drifts is a silent split-brain: the fleet would resolve a tier to
# one model and the coding runtime to another, or the reconcile would retire a
# row the bridge still pings about. Any difference fails.
#
# The JS canonical (src/lib/models/models-registry.mjs) is authored by TEAM-4997
# and may not be on this branch yet. While it is absent the mjs PAIR is still
# pinned to each other strictly, and the src comparison WARNS instead of
# failing — so this guard is useful from the first commit and becomes strict the
# moment that file lands, with no edit here.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

# ─── 1. Python twins — always strict ────────────────────────────────────────
PY_CANON="deploy/runtime-agent/models_registry.py"
for copy in deploy/coding-agent-runtime/models_registry.py; do
  if [ ! -f "$copy" ]; then
    echo "FAIL: missing models_registry.py copy: $copy" >&2
    fail=1
  elif ! cmp -s "$PY_CANON" "$copy"; then
    echo "FAIL: $copy is not byte-identical to $PY_CANON" >&2
    echo "      models_registry.py is a zero-import module duplicated per container." >&2
    echo "      Edit ONE copy, then: cp $PY_CANON $copy" >&2
    diff "$PY_CANON" "$copy" | head -20 >&2 || true
    fail=1
  fi
done

# ─── 2. the mjs pair — always strict ────────────────────────────────────────
MJS_HUB="lambda/token-aggregator/models-registry.mjs"
MJS_BRIDGE="deploy/telegram-bug-intake/models-registry.mjs"
if [ -f "$MJS_HUB" ] || [ -f "$MJS_BRIDGE" ]; then
  if [ ! -f "$MJS_HUB" ] || [ ! -f "$MJS_BRIDGE" ]; then
    echo "FAIL: models-registry.mjs exists in only one of $MJS_HUB / $MJS_BRIDGE" >&2
    fail=1
  elif ! cmp -s "$MJS_HUB" "$MJS_BRIDGE"; then
    echo "FAIL: $MJS_BRIDGE is not byte-identical to $MJS_HUB" >&2
    echo "      Edit ONE copy, then: cp $MJS_HUB $MJS_BRIDGE" >&2
    diff "$MJS_HUB" "$MJS_BRIDGE" | head -20 >&2 || true
    fail=1
  fi
fi

# ─── 3. the canonical mjs — strict once it exists ───────────────────────────
MJS_CANON="src/lib/models/models-registry.mjs"
if [ ! -f "$MJS_CANON" ]; then
  echo "WARN: canonical src/lib/models/models-registry.mjs absent (TEAM-4997); mjs pair unchecked"
elif [ -f "$MJS_HUB" ] && ! cmp -s "$MJS_CANON" "$MJS_HUB"; then
  echo "FAIL: $MJS_HUB is not byte-identical to $MJS_CANON" >&2
  echo "      Edit ONE copy, then: cp $MJS_CANON $MJS_HUB && cp $MJS_CANON $MJS_BRIDGE" >&2
  diff "$MJS_CANON" "$MJS_HUB" | head -20 >&2 || true
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "models-registry parity guard FAILED — edit the canonical copy" >&2
  echo "($PY_CANON for Python, $MJS_CANON for JS), then re-cp into every location." >&2
  exit 1
fi

echo "models-registry parity guard: OK"
echo "  models_registry.py = 2 byte-identical copies"
if [ -f "$MJS_HUB" ]; then
  echo "  models-registry.mjs = $([ -f "$MJS_CANON" ] && echo 3 || echo 2) byte-identical copies"
fi
