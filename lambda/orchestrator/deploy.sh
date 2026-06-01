#!/usr/bin/env bash
# ─── Deploy Orchestrator + Agent-Invoker + Events-Writer Lambdas ────────────
#
# Idempotent: creates the three Lambdas on first run, updates code + env vars
# on subsequent runs. Reads config from deploy/config.sh.
#
# Functions:
#   - agentcore-hub-orchestrator    (DynamoDB Streams trigger; routes tickets)
#   - agentcore-hub-agent-invoker   (async; invokes AgentCore runtimes)
#   - agentcore-hub-events-writer   (EventBridge → DynamoDB events table)
#
# Required env vars (from deploy/config.sh):
#   ACCOUNT_ID, AWS_REGION, LAMBDA_ROLE_ARN, ARTIFACT_BUCKET,
#   TICKETS_TABLE, WORKFLOWS_TABLE, EVENTS_TABLE
# Optional:
#   TICKET_PROVIDER ("jira" | "dynamodb", default "jira")
#   TICKET_TOOLS_LAMBDA (default derived from TICKET_PROVIDER)
#
# Usage:
#   ./lambda/orchestrator/deploy.sh
#
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$SCRIPT_DIR"

# shellcheck disable=SC1091
source "$REPO_ROOT/deploy/config.sh"

: "${LAMBDA_ROLE_ARN:?LAMBDA_ROLE_ARN must be set}"
: "${ARTIFACT_BUCKET:?ARTIFACT_BUCKET must be set}"

TICKET_PROVIDER="${TICKET_PROVIDER:-jira}"
if [ "$TICKET_PROVIDER" = "jira" ]; then
  TICKET_TOOLS_LAMBDA_DEFAULT="agentcore-hub-jira"
else
  TICKET_TOOLS_LAMBDA_DEFAULT="agentcore-hub-tickets"
fi
TICKET_TOOLS_LAMBDA="${TICKET_TOOLS_LAMBDA:-$TICKET_TOOLS_LAMBDA_DEFAULT}"

echo "=== Installing dependencies ==="
npm install --omit=dev --no-audit --no-fund --silent

echo "=== Creating deployment zip ==="
rm -f function.zip
zip -rq function.zip index.mjs agent-invoker.mjs events-writer.mjs package.json node_modules/

SIZE=$(ls -lh function.zip | awk '{print $5}')
echo "  Zip size: $SIZE"

ENV_VARS_ORCH="Variables={ARTIFACT_BUCKET=${ARTIFACT_BUCKET},TICKETS_TABLE=${TICKETS_TABLE},WORKFLOWS_TABLE=${WORKFLOWS_TABLE},EVENTS_TABLE=${EVENTS_TABLE},TICKET_PROVIDER=${TICKET_PROVIDER},TICKET_TOOLS_LAMBDA=${TICKET_TOOLS_LAMBDA}}"
ENV_VARS_INVOKER="Variables={ARTIFACT_BUCKET=${ARTIFACT_BUCKET},TICKETS_TABLE=${TICKETS_TABLE},WORKFLOWS_TABLE=${WORKFLOWS_TABLE},EVENTS_TABLE=${EVENTS_TABLE},TICKET_PROVIDER=${TICKET_PROVIDER},TICKET_TOOLS_LAMBDA=${TICKET_TOOLS_LAMBDA}}"
ENV_VARS_EVENTS="Variables={EVENTS_TABLE=${EVENTS_TABLE}}"

deploy_function() {
  local NAME=$1 HANDLER=$2 TIMEOUT=$3 MEM=$4 ENV_VARS=$5
  if aws lambda get-function --function-name "$NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
    aws lambda update-function-code \
      --function-name "$NAME" \
      --zip-file "fileb://function.zip" \
      --region "$AWS_REGION" \
      --output text --query 'FunctionName' >/dev/null
    aws lambda wait function-updated --function-name "$NAME" --region "$AWS_REGION"
    aws lambda update-function-configuration \
      --function-name "$NAME" \
      --handler "$HANDLER" \
      --timeout "$TIMEOUT" \
      --memory-size "$MEM" \
      --environment "$ENV_VARS" \
      --region "$AWS_REGION" \
      --output text --query 'FunctionName' >/dev/null
    echo "  ✓ $NAME (updated)"
  else
    aws lambda create-function \
      --function-name "$NAME" \
      --runtime nodejs20.x \
      --handler "$HANDLER" \
      --role "$LAMBDA_ROLE_ARN" \
      --zip-file "fileb://function.zip" \
      --timeout "$TIMEOUT" \
      --memory-size "$MEM" \
      --environment "$ENV_VARS" \
      --region "$AWS_REGION" \
      --output text --query 'FunctionName' >/dev/null
    echo "  ✓ $NAME (created)"
  fi
}

echo "=== Deploying Lambdas ==="
deploy_function "agentcore-hub-orchestrator" "index.handler" 60 256 "$ENV_VARS_ORCH"
deploy_function "agentcore-hub-agent-invoker" "agent-invoker.handler" 900 512 "$ENV_VARS_INVOKER"
deploy_function "agentcore-hub-events-writer" "events-writer.handler" 10 128 "$ENV_VARS_EVENTS"

rm -f function.zip
echo "=== Done ==="
