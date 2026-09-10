#!/usr/bin/env bash
# ─── Hermetic Python unit-test runner (TEAM-4354) ─────────────────────────────
#
# Single entrypoint for the hermetic (no-AWS) pytest gate. Reads the shared
# target list deploy/pipeline/pytest-targets.txt and runs `pytest -q` over it,
# so .github/workflows/ci.yml and deploy/pipeline/buildspec-ci.yml gate on the
# IDENTICAL set instead of two hand-copied lists that drift (the buildspec is the
# authoritative required check — a test wired into only one surface is not a
# gate). Same single-source-of-truth shape TEAM-4353 gave the Playwright suite.
#
# Fails loudly (non-zero) on: a missing list file, a listed target that does not
# exist on disk (a silently-vanished target is the same hole as a missing gate),
# or any pytest failure. Does NOT create/activate a venv — the buildspec runs it
# inside its existing /tmp/pyci venv; ci.yml runs it after setup-python + pip.
set -euo pipefail

cd "$(dirname "$0")/.."

LIST="deploy/pipeline/pytest-targets.txt"
[ -f "$LIST" ] || { echo "run-python-tests: missing target list $LIST" >&2; exit 1; }

# Read non-comment, non-blank lines IN FILE ORDER. The list header explains why
# ORDER IS LOAD-BEARING (deploy/coding-agent-runtime/test_setup_failure_response.py
# poisons sys.modules['strands'] if it imports before deploy/runtime-agent/tests);
# never sort here.
targets=()
while IFS= read -r line; do
  line="${line%%#*}"                       # strip trailing/whole-line comments
  line="$(printf '%s' "$line" | tr -d '[:space:]')"
  [ -n "$line" ] || continue
  if [ ! -e "$line" ]; then
    echo "run-python-tests: target does not exist on disk: $line" >&2
    exit 1
  fi
  targets+=("$line")
done < "$LIST"

[ "${#targets[@]}" -gt 0 ] || { echo "run-python-tests: no targets in $LIST" >&2; exit 1; }

echo "run-python-tests: ${#targets[@]} target(s) from $LIST"
exec pytest -q "${targets[@]}"
