#!/bin/bash
#
# verify-fleet.sh — Health check all deployed runtime agents
#
# Reads fleet-runtime-ids.json and invokes each agent with a simple prompt,
# then BLOCKS on telemetry: each healthy agent must also have exported a fresh
# invoke_agent span to its runtime log group. That span is what the eval batch
# keys on — an agent that answers but emits no spans scores 0/10 in every
# eval, so broken telemetry can no longer ship silently.
#
# Requires agentcore CLI installed, plus the aws CLI for the span probe.
#
# Usage:
#   ./verify-fleet.sh [--timeout 30]
#
# Env:
#   SKIP_SPAN_PROBE=true   EMERGENCY bypass for the blocking invoke_agent span
#                          probe. Prints a loud warning; the deploy is then NOT
#                          telemetry-verified and eval scores may silently be
#                          0/10. Default: off.
#   RUN_EVAL_CANARY=true   After the fleet passes, run the end-to-end eval
#                          canary (../evaluations/canary-eval-spans.sh) against
#                          one agent. Default: off.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FLEET_FILE="$SCRIPT_DIR/fleet-runtime-ids.json"
# Accepted for CLI compat but not consumed (the node SDK call uses its own
# default timeout).
# shellcheck disable=SC2034
TIMEOUT="${1:-30}"

if [ ! -f "$FLEET_FILE" ]; then
  echo "  No fleet-runtime-ids.json found. Run deploy-fleet.sh first."
  exit 1
fi

if [ "${SKIP_SPAN_PROBE:-}" = "true" ]; then
  echo ""
  echo "  ⚠️  ⚠️  ⚠️  SKIP_SPAN_PROBE=true — the blocking invoke_agent span probe is"
  echo "  DISABLED. This deploy will NOT be telemetry-verified: agents that emit no"
  echo "  spans will pass this script and score 0/10 in eval batches. Emergency use"
  echo "  only — re-run without SKIP_SPAN_PROBE as soon as possible."
  echo ""
fi

# Blocking telemetry gate: after the health-check invocation, a fresh
# invoke_agent span must appear in the runtime's `spans` log stream. Export via
# the platform pipeline takes ~1 min, so poll 3 times, 60s apart.
probe_invoke_agent_span() {
  local agent_name="$1"
  local runtime_id="$2"
  local start_ms="$3"
  local log_group="/aws/bedrock-agentcore/runtimes/${runtime_id}-DEFAULT"
  local attempt found

  for attempt in 1 2 3; do
    sleep 60
    found=$(aws logs filter-log-events \
      --log-group-name "$log_group" \
      --log-stream-name-prefix "spans" \
      --filter-pattern '"invoke_agent"' \
      --start-time "$start_ms" \
      --max-items 1 \
      --query 'events[0].eventId' \
      --output text 2>/dev/null) || found=""
    if [ -n "$found" ] && [ "$found" != "None" ]; then
      return 0
    fi
    echo "    … $agent_name: no invoke_agent span yet (attempt $attempt/3)"
  done

  echo "  ✗ $agent_name — TELEMETRY GATE FAILED"
  echo "    No invoke_agent span since epoch-ms $start_ms in log group:"
  echo "      $log_group (stream prefix 'spans')"
  echo "    The agent answered the health check but exported no span, so eval"
  echo "    batches would score this persona 0/10. Broken telemetry can no longer"
  echo "    ship silently — debug with DEPLOY.md §'Post-deploy telemetry"
  echo "    verification', or bypass in an emergency with SKIP_SPAN_PROBE=true."
  return 1
}

echo ""
echo "  Verifying Agent Fleet Health"
echo "  ═══════════════════════════════"
echo ""

PASS=0
FAIL=0
TOTAL=$(python3 -c "import json; print(len(json.load(open('$FLEET_FILE'))))")

while IFS= read -r agent_name; do
  # Invoke with agentcore CLI (quick health check)
  ARN=$(python3 -c "import json; data=json.load(open('$FLEET_FILE')); print(data.get('$agent_name', ''))")

  if [ -z "$ARN" ] || [ "$ARN" = "" ]; then
    echo "  ✗ $agent_name — no ARN found"
    FAIL=$((FAIL + 1))
    continue
  fi

  # Captured BEFORE the invocation so the span probe only matches spans this
  # health check produced, never leftovers from an earlier deploy.
  DEPLOY_EPOCH_MS=$(python3 -c "import time; print(int(time.time() * 1000))")

  # Use the SDK to invoke with a simple prompt (runtime agents use payload, not messages)
  RESULT=$(node -e "
    import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
    const client = new BedrockAgentCoreClient({ region: '${AWS_REGION:-us-east-1}' });
    try {
      const payload = JSON.stringify({ prompt: 'Respond with OK if you can hear me.' });
      const res = await client.send(new InvokeAgentRuntimeCommand({
        agentRuntimeArn: '$ARN',
        runtimeSessionId: 'health-check-' + Date.now() + '-' + Math.random().toString(36).slice(2,10),
        payload: new TextEncoder().encode(payload),
        contentType: 'application/json',
        accept: 'application/json',
      }));
      // Runtime agents return response as a streaming body
      const body = await res.response.transformToString();
      console.log(body.length > 0 ? 'OK' : 'EMPTY');
    } catch (e) {
      console.log('ERROR:' + e.name + ':' + (e.message || '').slice(0,80));
    }
  " 2>&1)

  if [[ "$RESULT" == "OK" ]]; then
    if [ "${SKIP_SPAN_PROBE:-}" = "true" ]; then
      echo "  ✓ $agent_name (⚠️ span probe SKIPPED — not telemetry-verified)"
      PASS=$((PASS + 1))
    elif probe_invoke_agent_span "$agent_name" "${ARN##*/}" "$DEPLOY_EPOCH_MS"; then
      echo "  ✓ $agent_name — invoke_agent span verified"
      PASS=$((PASS + 1))
    else
      FAIL=$((FAIL + 1))
    fi
  else
    echo "  ✗ $agent_name — $RESULT"
    FAIL=$((FAIL + 1))
  fi
done < <(python3 -c "import json; [print(k) for k in json.load(open('$FLEET_FILE')).keys()]")

echo ""
echo "  ───────────────────────────────────"
echo "  Results: $PASS/$TOTAL passed, $FAIL failed"
echo ""

if [ $FAIL -gt 0 ]; then
  exit 1
fi

if [ "${RUN_EVAL_CANARY:-}" = "true" ]; then
  echo "  Running end-to-end eval canary..."
  "$SCRIPT_DIR/../evaluations/canary-eval-spans.sh"
fi
