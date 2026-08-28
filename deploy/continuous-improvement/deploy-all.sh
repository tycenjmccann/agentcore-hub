#!/usr/bin/env bash
# deploy/continuous-improvement/deploy-all.sh
# Creates the eval-packager's two DynamoDB tables and seeds all fleet agents:
#   agentcore-hub-eval-config — PK agentId. Per-agent eval controls (enabled,
#                               sampleRate, batchSize) + the session buffer.
#   agentcore-hub-eval-seen   — PK dedupKey, TTL on expiresAt. The
#                               cross-delivery/concurrent-invocation dedup
#                               seen-set (see the Step 1 comment below).
# Idempotent: skips agents that already have a config row.
#
# Run this BEFORE ./deploy.sh — that script points the eval-packager Lambda's
# EVAL_SEEN_TABLE env var at the seen table created here.
#
# Agent IDs are sourced from src/config/agents.json (canonical source of truth).
#
# Usage: ./deploy-all.sh [--region us-east-1]

set -euo pipefail

###############################################################################
# Configuration
###############################################################################
TABLE_NAME="agentcore-hub-eval-config"
# Cross-delivery dedup seen-set. Overridable so a non-default deploy can point
# the whole chain (this script, setup-lambda-role.sh, deploy.sh) at one name;
# the default matches index.mjs's SEEN_TABLE fallback.
SEEN_TABLE_NAME="${EVAL_SEEN_TABLE:-agentcore-hub-eval-seen}"
SEEN_TTL_ATTRIBUTE="expiresAt"
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
echo "[deploy-all] Seen:   ${SEEN_TABLE_NAME}"
echo "[deploy-all] Fleet:  ${FLEET_IDS_FILE}"

###############################################################################
# Step 1: Create DynamoDB tables (idempotent)
###############################################################################
echo ""
echo "=== Step 1: Create DynamoDB tables ==="

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

# ─── Dedup seen-set table ────────────────────────────────────────────────────
# The eval-packager reads this table (BatchGetItem, checkSeenSet in
# lambda/eval-packager/index.mjs) before classifying a delivery: a hit means
# another CloudWatch Logs delivery — or a concurrent invocation — already claimed
# that dedupKey, so the row is dropped before it can double-count the rolling DDB
# aggregates. It then writes one conditional PutItem per surviving key
# (claimSeenSet) once the rows are durably buffered. Without this table every read
# and write throws and the seen-set fails OPEN, i.e. dedup is silently inert.
#
# Rows are pure dedup bookkeeping with a 24h TTL (SEEN_TTL_SECONDS in index.mjs);
# TTL is OPT-IN per table, so without the update-time-to-live call below the
# table grows forever.
echo ""
if aws dynamodb describe-table \
  --table-name "${SEEN_TABLE_NAME}" \
  --region "${REGION}" \
  --output text \
  --query 'Table.TableStatus' 2>/dev/null; then
  echo "[deploy-all] Table '${SEEN_TABLE_NAME}' already exists. Skipping creation."
else
  echo "[deploy-all] Creating table '${SEEN_TABLE_NAME}' with on-demand billing..."
  aws dynamodb create-table \
    --table-name "${SEEN_TABLE_NAME}" \
    --attribute-definitions AttributeName=dedupKey,AttributeType=S \
    --key-schema AttributeName=dedupKey,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region "${REGION}"

  echo "[deploy-all] Waiting for table to become ACTIVE..."
  aws dynamodb wait table-exists \
    --table-name "${SEEN_TABLE_NAME}" \
    --region "${REGION}"
  echo "[deploy-all] Table '${SEEN_TABLE_NAME}' is ACTIVE."
fi

# Enable TTL on expiresAt. update-time-to-live ERRORS when TTL is already
# ENABLED/ENABLING, which would abort the whole deploy under `set -e` on every
# re-run — so check first, and treat a failed enable as a warning (the dedup path
# still works; the table just needs manual pruning).
TTL_STATUS=$(aws dynamodb describe-time-to-live \
  --table-name "${SEEN_TABLE_NAME}" \
  --region "${REGION}" \
  --query 'TimeToLiveDescription.TimeToLiveStatus' \
  --output text 2>/dev/null || echo "UNKNOWN")
if [[ "${TTL_STATUS}" == "ENABLED" || "${TTL_STATUS}" == "ENABLING" ]]; then
  echo "[deploy-all] TTL already ${TTL_STATUS} on ${SEEN_TABLE_NAME}.${SEEN_TTL_ATTRIBUTE}. Skipping."
else
  echo "[deploy-all] Enabling TTL on ${SEEN_TABLE_NAME}.${SEEN_TTL_ATTRIBUTE}..."
  if aws dynamodb update-time-to-live \
    --table-name "${SEEN_TABLE_NAME}" \
    --region "${REGION}" \
    --time-to-live-specification "Enabled=true,AttributeName=${SEEN_TTL_ATTRIBUTE}" \
    --output text >/dev/null 2>&1; then
    echo "[deploy-all] TTL enabled on ${SEEN_TABLE_NAME}.${SEEN_TTL_ATTRIBUTE} (24h expiry)."
  else
    echo "[deploy-all] ⚠ Could not enable TTL on ${SEEN_TABLE_NAME} (status was '${TTL_STATUS}')."
    echo "[deploy-all]   Dedup still works; the table will NOT self-prune. Enable manually:"
    echo "[deploy-all]   aws dynamodb update-time-to-live --table-name ${SEEN_TABLE_NAME} \\"
    echo "[deploy-all]     --time-to-live-specification Enabled=true,AttributeName=${SEEN_TTL_ATTRIBUTE}"
  fi
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
