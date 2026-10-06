#!/usr/bin/env bash
# lambda-live-smoke.sh — post-update live check of one Lambda (TEAM-5321 FR-15).
#
#   lambda-live-smoke.sh [--optional] <function> <region> <canary-kind>
#
# Invokes the LIVE function with the read-only payload for <canary-kind>
# (lambda-smoke-contract.mjs CANARIES) and fails (exit 1) when the invoke reports
# a FunctionError (an init/import crash is Unhandled with
# Runtime.ImportModuleError) or the response body is not one of the expected
# envelopes for that kind (judgeCanaryEnvelope — the same rule the pre-update
# import smoke applies; TEAM-5337). The Deploy stage calls it beside the
# orchestrator smoke, under the rollback trap, so a failure here rolls the code
# back. Kinds must not write: get_transitions for CANARY-SMOKE (one read) on the
# ticket twins, unknown_tool (`{}`, no I/O) on workflow-output.
#
# --optional: a function that does not exist in this account is skipped, exit 0
# (agentcore-hub-tickets is absent on TICKET_PROVIDER=jira installs).
set -euo pipefail

OPTIONAL=0
if [ "${1:-}" = "--optional" ]; then OPTIONAL=1; shift; fi
FN="${1:?function name required}"
REGION="${2:?region required}"
KIND="${3:?canary kind required}"
CONTRACT="$(dirname "$0")/lambda-smoke-contract.mjs"
PAYLOAD="$(node "$CONTRACT" payload "$KIND")"

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
if ! WHY="$(node "$CONTRACT" judge "$KIND" "$OUT" 2>&1)"; then
  echo "LIVE SMOKE FAILED: $FN: $WHY" >&2; head -c 2000 "$OUT" >&2; echo >&2; exit 1
fi
echo "  $FN live smoke OK (no FunctionError, $WHY)"
