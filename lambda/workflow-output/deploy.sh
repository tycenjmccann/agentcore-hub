#!/usr/bin/env bash
# ─── Deploy Workflow-Output Lambda ───────────────────────────────────────────
#
# Idempotent: creates the Lambda on first run, updates code + env vars on
# subsequent runs. Reads config from deploy/config.sh.
#
# Function:
#   - agentcore-hub-workflow-output  (invoked by runtime agents to submit
#                                     ticket plans, save design docs, mark
#                                     tickets complete)
#
# Required env vars (from deploy/config.sh):
#   ACCOUNT_ID, AWS_REGION, LAMBDA_ROLE_ARN, ARTIFACT_BUCKET, EVENTS_TABLE
# Optional:
#   TICKET_PROVIDER ("jira" | "dynamodb", default "jira")
#   TICKET_TOOLS_LAMBDA (default derived from TICKET_PROVIDER)
#
# Usage:
#   ./lambda/workflow-output/deploy.sh
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

NAME="agentcore-hub-workflow-output"

echo "=== Creating deployment zip ==="
rm -f function.zip
# @aws-sdk/s3-request-presigner is NOT guaranteed in the nodejs20.x runtime
# bundle, and a missing ESM import crashes the whole function — so vendor it
# (npm install writes node_modules here) and ship it in the zip. The other
# @aws-sdk/client-* imports are runtime-provided.
if [ -f package.json ]; then
  npm install --omit=dev --silent >/dev/null 2>&1 || npm install --production --silent >/dev/null 2>&1
fi
zip -qr function.zip index.mjs node_modules 2>/dev/null || zip -q function.zip index.mjs

SIZE=$(ls -lh function.zip | awk '{print $5}')
echo "  Zip size: $SIZE"

ENV_VARS="Variables={ARTIFACT_BUCKET=${ARTIFACT_BUCKET},EVENTS_TABLE=${EVENTS_TABLE},TICKET_PROVIDER=${TICKET_PROVIDER},TICKET_TOOLS_LAMBDA=${TICKET_TOOLS_LAMBDA}}"

echo "=== Deploying $NAME ==="
if aws lambda get-function --function-name "$NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
  aws lambda update-function-code \
    --function-name "$NAME" \
    --zip-file "fileb://function.zip" \
    --region "$AWS_REGION" \
    --output text --query 'FunctionName' >/dev/null
  aws lambda wait function-updated --function-name "$NAME" --region "$AWS_REGION"
  aws lambda update-function-configuration \
    --function-name "$NAME" \
    --handler "index.handler" \
    --timeout 60 \
    --memory-size 512 \
    --environment "$ENV_VARS" \
    --region "$AWS_REGION" \
    --output text --query 'FunctionName' >/dev/null
  echo "  ✓ $NAME (updated)"
else
  aws lambda create-function \
    --function-name "$NAME" \
    --runtime nodejs20.x \
    --handler "index.handler" \
    --role "$LAMBDA_ROLE_ARN" \
    --zip-file "fileb://function.zip" \
    --timeout 60 \
    --memory-size 512 \
    --environment "$ENV_VARS" \
    --region "$AWS_REGION" \
    --output text --query 'FunctionName' >/dev/null
  echo "  ✓ $NAME (created)"
fi

rm -f function.zip
echo "=== Done ==="
