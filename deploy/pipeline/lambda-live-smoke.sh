#!/usr/bin/env bash
# lambda-live-smoke.sh — post-update live check of one Lambda (TEAM-5321 FR-15).
#
#   lambda-live-smoke.sh [--optional] <function> <region> <payload-json>
#
# Invokes the LIVE function with a read-only payload and fails (exit 1) when the
# invoke reports a FunctionError (an init/import crash is Unhandled with
# Runtime.ImportModuleError) or the response body carries a module/reference
# error a tool handler caught and returned as text. The Deploy stage calls it
# beside the orchestrator smoke, under the rollback trap, so a failure here rolls
# the code back. Payloads must not write: get_transitions for CANARY-SMOKE (one
# read) on the ticket twins, `{}` (Unknown tool, no I/O) on workflow-output.
#
# --optional: a function that does not exist in this account is skipped, exit 0
# (agentcore-hub-tickets is absent on TICKET_PROVIDER=jira installs).
set -euo pipefail

OPTIONAL=0
if [ "${1:-}" = "--optional" ]; then OPTIONAL=1; shift; fi
FN="${1:?function name required}"
REGION="${2:?region required}"
PAYLOAD="${3:?payload json required}"
MODULE_ERROR='Cannot find module|ERR_MODULE_NOT_FOUND|ImportModuleError|is not defined|is not a function'

if ! aws lambda get-function-configuration --function-name "$FN" --region "$REGION" >/dev/null 2>&1; then
  if [ "$OPTIONAL" = "1" ]; then echo "  $FN not present in this account — live smoke skipped"; exit 0; fi
  echo "LIVE SMOKE FAILED: $FN does not exist" >&2; exit 1
fi

OUT="$(mktemp)"; META="$(mktemp)"
trap 'rm -f "$OUT" "$META"' EXIT
aws lambda invoke --function-name "$FN" --payload "$(printf '%s' "$PAYLOAD" | base64 | tr -d '\n')" \
  --region "$REGION" "$OUT" >"$META" 2>&1
if grep -q '"FunctionError"' "$META"; then
  echo "LIVE SMOKE FAILED: $FN returned a FunctionError" >&2; cat "$META" "$OUT" >&2; exit 1
fi
if grep -Eq "$MODULE_ERROR" "$OUT"; then
  echo "LIVE SMOKE FAILED: $FN response carries a module error" >&2; head -c 2000 "$OUT" >&2; echo >&2; exit 1
fi
echo "  $FN live smoke OK (no FunctionError, no module error)"
