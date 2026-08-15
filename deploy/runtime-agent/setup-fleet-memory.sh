#!/bin/bash
# setup-fleet-memory.sh — Create (or find) the shared AgentCore Memory for the
# fleet runtimes and print the FLEET_MEMORY_ID to export before deploy-one.sh /
# deploy-fleet.sh. Personas are isolated by actorId (= agent_id), so one memory
# serves the whole fleet.
#
# Usage:
#   ./setup-fleet-memory.sh              # create if missing, print id
#   export FLEET_MEMORY_ID=<printed id>  # then redeploy agents
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
MEMORY_NAME="agentcore_hub_fleet_memory"

EXISTING=$(aws bedrock-agentcore-control list-memories --region "$REGION" \
  --query "memories[?starts_with(id, '${MEMORY_NAME}') && status=='ACTIVE'].id | [0]" --output text)

if [ -n "$EXISTING" ] && [ "$EXISTING" != "None" ]; then
  echo "Memory exists: $EXISTING" >&2
  echo "$EXISTING"
  exit 0
fi

# A non-ACTIVE leftover (FAILED/CREATING/DELETING) blocks name reuse — surface it.
STALE=$(aws bedrock-agentcore-control list-memories --region "$REGION" \
  --query "memories[?starts_with(id, '${MEMORY_NAME}')].{id:id,status:status} | [0]" --output text)
if [ -n "$STALE" ] && [ "$STALE" != "None" ]; then
  echo "Memory ${STALE} exists but is not ACTIVE — delete it or wait, then re-run." >&2
  exit 1
fi

echo "Creating memory ${MEMORY_NAME}..." >&2
MEMORY_ID=$(aws bedrock-agentcore-control create-memory --region "$REGION" \
  --name "$MEMORY_NAME" \
  --description "Shared fleet runtime memory - personas isolated by actorId" \
  --event-expiry-duration 90 \
  --query 'memory.id' --output text)

# Wait for ACTIVE
for i in $(seq 1 60); do
  STATUS=$(aws bedrock-agentcore-control get-memory --region "$REGION" \
    --memory-id "$MEMORY_ID" --query 'memory.status' --output text)
  [ "$STATUS" = "ACTIVE" ] && break
  [ "$STATUS" = "FAILED" ] && { echo "Memory creation FAILED" >&2; exit 1; }
  sleep 5
done

echo "Memory ACTIVE: $MEMORY_ID" >&2
echo "$MEMORY_ID"
