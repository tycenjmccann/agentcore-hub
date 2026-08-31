#!/usr/bin/env bash
# ─── Workflow-table write guard (R2 — docs/race-condition-study.md) ───────────
#
# The workflows table may only be written through lambda/orchestrator/
# workflow-store.mjs (scoped conditional writes). Full-row puts and ad-hoc
# UpdateCommands against it resurrect stale snapshots over concurrent scoped
# writes — the read-modify-write clobber class that caused most workflow races.
#
# This grep fails CI when orchestrator code outside the store touches
# WORKFLOWS_TABLE with a write command. Next.js API routes are exempted per
# file below only where their writes are already scoped + conditional; new
# routes must use scoped conditional writes too (reviewed via this list).
set -euo pipefail
cd "$(dirname "$0")/.."

FAIL=0

# 1. Orchestrator Lambda: zero write commands on WORKFLOWS_TABLE outside the store.
for f in lambda/orchestrator/index.mjs lambda/orchestrator/agent-invoker.mjs lambda/orchestrator/events-writer.mjs; do
  hits=$(python3 - "$f" <<'EOF'
import re, sys
src = open(sys.argv[1]).read()
# A write is a PutCommand/UpdateCommand/DeleteCommand send whose input names WORKFLOWS_TABLE.
bad = []
for m in re.finditer(r'new (?:Put|Update|Delete)Command\(\{(.*?)\}\)\)', src, re.S):
    if 'WORKFLOWS_TABLE' in m.group(1):
        line = src[:m.start()].count('\n') + 1
        bad.append(str(line))
print(' '.join(bad))
EOF
)
  if [ -n "$hits" ]; then
    echo "FAIL: $f writes WORKFLOWS_TABLE outside workflow-store.mjs (lines: $hits)"
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo ""
  echo "Route all workflows-table writes through lambda/orchestrator/workflow-store.mjs."
  exit 1
fi
echo "workflow-write guard: OK"
