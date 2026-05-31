#!/usr/bin/env bash
# deploy/continuous-improvement/deploy-all.sh
# Creates the agentcore-hub-eval-config DynamoDB table and seeds all fleet agents.
# Idempotent: skips agents that already have a config row.
#
# Agent IDs are sourced from src/config/agents.json (canonical source of truth).
#
# Usage: ./deploy-all.sh [--region us-east-1]

set -euo pipefail

###############################################################################
# Configuration
###############################################################################
TABLE_NAME="agentcore-hub-eval-config"
REGION="${AWS_REGION:-us-east-1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/../.."
FLEET_IDS_FILE="${REPO_ROOT}/src/config/agents.json"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --region) REGION="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

echo "[deploy-all] Region: ${REGION}"
echo "[deploy-all] Table:  ${TABLE_NAME}"
echo "[deploy-all] Fleet:  ${FLEET_IDS_FILE}"

###############################################################################
# Step 1: Create DynamoDB table (idempotent)
###############################################################################
echo ""
echo "=== Step 1: Create DynamoDB table ==="

if aws dynamodb describe-table \
  --table-name "${TABLE_NAME}" \
  --region "${REGION}" \
  --output text \
  --query 'Table.TableStatus' 2>/dev/null; then
  echo "[deploy-all] Table '${TABLE_NAME}' already exists. Skipping creation."
else
  echo "[deploy-all] Creating table '${TABLE_NAME}' with on-demand billing..."
  aws dynamodb create-table \
    --table-name "${TABLE_NAME}" \
    --attribute-definitions AttributeName=agentId,AttributeType=S \
    --key-schema AttributeName=agentId,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region "${REGION}"

  echo "[deploy-all] Waiting for table to become ACTIVE..."
  aws dynamodb wait table-exists \
    --table-name "${TABLE_NAME}" \
    --region "${REGION}"
  echo "[deploy-all] Table '${TABLE_NAME}' is ACTIVE."
fi

###############################################################################
# Step 2: Seed agents with default eval config
###############################################################################
echo ""
echo "=== Step 2: Seed agent eval configs ==="

if [[ ! -f "${FLEET_IDS_FILE}" ]]; then
  echo "[deploy-all] ERROR: Agents config file not found at ${FLEET_IDS_FILE}"
  exit 1
fi

# Read canonical agent IDs from agents.json
AGENT_IDS=$(jq -r '.agents[].agentId' "${FLEET_IDS_FILE}")
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SEEDED=0
SKIPPED=0

for AGENT_ID in ${AGENT_IDS}; do
  echo -n "[deploy-all] Seeding ${AGENT_ID}... "

  # Attempt conditional put — only succeeds if agentId does not exist
  if aws dynamodb put-item \
    --table-name "${TABLE_NAME}" \
    --region "${REGION}" \
    --item "{
      \"agentId\": {\"S\": \"${AGENT_ID}\"},
      \"enabled\": {\"BOOL\": true},
      \"sampleRate\": {\"N\": \"100\"},
      \"batchSize\": {\"N\": \"10\"},
      \"sessionBuffer\": {\"L\": []},
      \"lastUpdatedAt\": {\"S\": \"${NOW}\"},
      \"lastUpdatedBy\": {\"S\": \"deploy\"}
    }" \
    --condition-expression "attribute_not_exists(agentId)" \
    2>/dev/null; then
    echo "SEEDED"
    SEEDED=$((SEEDED + 1))
  else
    echo "SKIPPED (already exists)"
    SKIPPED=$((SKIPPED + 1))
  fi
done

echo ""
echo "=== Deployment Complete ==="
echo "[deploy-all] Seeded: ${SEEDED} agents"
echo "[deploy-all] Skipped: ${SKIPPED} agents (already existed)"
echo "[deploy-all] Total:  $((SEEDED + SKIPPED)) agents processed"
