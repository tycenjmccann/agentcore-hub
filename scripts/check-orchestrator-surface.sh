#!/usr/bin/env bash
# ─── Orchestrator surface guard (DL-009: thin event router) ───────────────────
#
# lambda/orchestrator/ is an event router and nothing more: dispatch a Ready
# ticket, cascade a Done ticket's dependents, claim/release invocation leases,
# reap dead sessions, evaluate completion. Behaviour that decides WHAT WORK
# HAPPENS NEXT (parking a ticket behind fixes, re-verifying a fix, syncing a
# branch, probing CI/GitHub, capping loops, routing by label) belongs in the
# agent blueprint (blueprints/*.md) using the ticket tools, or in the
# ticket-tools Lambdas — never here, and never behind a new *_MODE env flag.
#
# Between 2026-09-01 and 2026-09-08 the directory grew from 8 to 31 modules and
# 22 env flags (13 of them never enabled in prod), almost all from [SI] runs.
# This guard makes that growth a CI failure instead of a review comment:
#
#   1. every non-test module must be listed in scripts/orchestrator-modules.allow
#   2. every env var read (process.env.X / env.X) must be listed in
#      scripts/orchestrator-env.allow
#   3. every file named on deploy.sh's `zip -rq function.zip …` line must exist
#      (the reverse of check-lambda-zip-manifest.sh, which checks closure ⊆ zip)
#   4. total non-test lines and index.mjs lines must stay under the budgets below
#
# Lower the budgets freely. Raise them, or add to an allow-list, only in the same
# PR as a DL entry in docs/workflow-pipeline-architecture.md explaining why the
# behaviour is a dispatch/cascade/claim/reaper/completion concern.
set -euo pipefail
cd "$(dirname "$0")/.."

ORCH="lambda/orchestrator"
MODULES_ALLOW="scripts/orchestrator-modules.allow"
ENV_ALLOW="scripts/orchestrator-env.allow"
# Budgets: PR 2 of the cleanup lowers these to (actual + 2.5%).
ORCH_LOC_BUDGET=17000
ORCH_INDEX_BUDGET=6150

RULE="DL-009: the orchestrator is cascade/dispatch/claim/reaper/completion only.
        Put this behaviour in a blueprint (Tickets___create_ticket /
        Tickets___transition_ticket blocked_by=…) or in the ticket-tools Lambda.
        If it truly belongs here, add the name to the allow-list in the SAME PR
        as a DL entry in docs/workflow-pipeline-architecture.md."

fail=0

allow_list() {  # strip comments + blanks
  sed -e 's/#.*$//' -e 's/[[:space:]]*$//' "$1" | grep -v '^$' | sort -u
}

MODULES="$(cd "$ORCH" && ls *.mjs | grep -v '\.test\.mjs$' | sort)"

# ─── 1. module allow-list ─────────────────────────────────────────────────────
ALLOWED_MODULES="$(allow_list "$MODULES_ALLOW")"
for m in $MODULES; do
  if ! grep -qx "$m" <<<"$ALLOWED_MODULES"; then
    echo "FAIL: new orchestrator module $ORCH/$m is not in $MODULES_ALLOW" >&2
    echo "      $RULE" >&2
    fail=1
  fi
done
for m in $ALLOWED_MODULES; do
  if [ ! -f "$ORCH/$m" ]; then
    echo "FAIL: $MODULES_ALLOW lists $m but $ORCH/$m does not exist — remove the stale entry" >&2
    fail=1
  fi
done

# ─── 2. env-var allow-list ────────────────────────────────────────────────────
# Comment lines are dropped first so a header that mentions a retired flag does
# not count as a read. Three static access forms are scanned: `process.env.X` /
# `env.X` (DI modules take `env = process.env`), `process.env["X"]`, and a
# same-line destructuring `const { X, Y: alias = dflt } = process.env`. Only a
# COMPUTED lookup (process.env[someVar]) is not scanned; the one in the tree is
# the RUNTIME_ARN_<AGENT> convention in invokeAgent.
ALLOWED_ENV="$(allow_list "$ENV_ALLOW")"
CODE="$(cd "$ORCH" && cat $MODULES | grep -vE '^[[:space:]]*(//|\*|/\*)')"
READ_DOT="$(grep -ohE '(process\.env|[^A-Za-z0-9_.]env)\.[A-Z][A-Z0-9_]*' <<<"$CODE" | sed -E 's/.*env\.//' || true)"
READ_BRACKET="$(grep -ohE "process\.env\[['\"][A-Z][A-Z0-9_]*['\"]\]" <<<"$CODE" | sed -E "s/.*\[['\"]([A-Z][A-Z0-9_]*)['\"]\]/\1/" || true)"
READ_DESTRUCT="$(grep -ohE '\{[^}]*\}[[:space:]]*=[[:space:]]*process\.env\b' <<<"$CODE" \
  | sed -E 's/\}.*//; s/^\{//' | tr ',' '\n' | sed -E 's/^[[:space:]]*([A-Z][A-Z0-9_]*).*/\1/' | grep -E '^[A-Z][A-Z0-9_]*$' || true)"
READ_ENV="$(printf '%s\n%s\n%s\n' "$READ_DOT" "$READ_BRACKET" "$READ_DESTRUCT" | grep -v '^$' | sort -u)"
for v in $READ_ENV; do
  if ! grep -qx "$v" <<<"$ALLOWED_ENV"; then
    echo "FAIL: orchestrator reads env var $v which is not in $ENV_ALLOW" >&2
    grep -nE "env\.$v\b" $ORCH/*.mjs | grep -v '\.test\.mjs' | head -3 >&2 || true
    echo "      $RULE" >&2
    fail=1
  fi
done
for v in $ALLOWED_ENV; do
  if ! grep -qx "$v" <<<"$READ_ENV"; then
    echo "FAIL: $ENV_ALLOW lists $v but nothing in $ORCH reads it — remove the stale entry" >&2
    fail=1
  fi
done

# ─── 3. zip line names must exist ─────────────────────────────────────────────
ZIP_LINE="$(grep -oE 'zip -rq function\.zip .*' "$ORCH/deploy.sh" | head -1 || true)"
if [ -z "$ZIP_LINE" ]; then
  echo "FAIL: could not find the 'zip -rq function.zip …' line in $ORCH/deploy.sh" >&2
  fail=1
else
  for f in ${ZIP_LINE#zip -rq function.zip }; do
    case "$f" in
      *.mjs|package.json)
        if [ ! -f "$ORCH/$f" ]; then
          echo "FAIL: $ORCH/deploy.sh zips $f but $ORCH/$f does not exist (stale zip line)" >&2
          fail=1
        fi ;;
      lease-constants.json|node_modules/) ;;  # copied in / installed at build time
      *) echo "FAIL: unexpected entry '$f' on the zip line" >&2; fail=1 ;;
    esac
  done
fi

# ─── 4. line budgets ──────────────────────────────────────────────────────────
TOTAL_LOC=$(cd "$ORCH" && cat $MODULES | wc -l | tr -d ' ')
INDEX_LOC=$(wc -l < "$ORCH/index.mjs" | tr -d ' ')
if [ "$TOTAL_LOC" -gt "$ORCH_LOC_BUDGET" ]; then
  echo "FAIL: $ORCH non-test code is $TOTAL_LOC lines; budget is $ORCH_LOC_BUDGET" >&2
  echo "      $RULE" >&2
  fail=1
fi
if [ "$INDEX_LOC" -gt "$ORCH_INDEX_BUDGET" ]; then
  echo "FAIL: $ORCH/index.mjs is $INDEX_LOC lines; budget is $ORCH_INDEX_BUDGET" >&2
  echo "      $RULE" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "orchestrator surface guard FAILED (scripts/check-orchestrator-surface.sh)" >&2
  exit 1
fi

echo "orchestrator surface guard: OK"
echo "  modules   = $(wc -w <<<"$MODULES" | tr -d ' ') (all allow-listed)"
echo "  env reads = $(wc -w <<<"$READ_ENV" | tr -d ' ') (all allow-listed)"
echo "  lines     = $TOTAL_LOC / $ORCH_LOC_BUDGET   index.mjs $INDEX_LOC / $ORCH_INDEX_BUDGET"
