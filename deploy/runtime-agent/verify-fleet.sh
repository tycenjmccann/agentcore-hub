#!/bin/bash
#
# verify-fleet.sh — Health check all deployed runtime agents
#
# Reads fleet-runtime-ids.json and invokes each agent with a simple prompt.
# Requires agentcore CLI installed.
#
# Usage:
#   ./verify-fleet.sh [--timeout 30]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FLEET_FILE="$SCRIPT_DIR/fleet-runtime-ids.json"
TIMEOUT="${1:-30}"

if [ ! -f "$FLEET_FILE" ]; then
  echo "  No fleet-runtime-ids.json found. Run deploy-fleet.sh first."
  exit 1
fi

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
    echo "  ✓ $agent_name"
    PASS=$((PASS + 1))
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
