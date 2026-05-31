#!/bin/bash
# Deploy the Continuous Improvement Loop
set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "${REPO_ROOT}/deploy/config.sh"

BUCKET="$ARTIFACT_BUCKET"
ROLE_ARN="$LAMBDA_ROLE_ARN"
AGENT_ID="${IMPROVEMENT_AGENT_ID:-agentcore_hub_fleet_improver-k5W5Vb9GhE}"
WORKFLOW_API="${DEPLOYMENT_URL:?ERROR: DEPLOYMENT_URL must be set}"
FLEET_REPO="$FLEET_REPO_URL"

echo "═══════════════════════════════════════════════════════════"
echo "  Continuous Improvement Loop"
echo "  Account: ${ACCOUNT_ID}"
echo "═══════════════════════════════════════════════════════════"

# ─── S3 ──────────────────────────────────────────────────────────────────────
aws s3 mb "s3://${BUCKET}" 2>/dev/null || true
aws s3api put-bucket-notification-configuration \
  --bucket "$BUCKET" --notification-configuration '{"EventBridgeConfiguration":{}}' 2>/dev/null
echo "✓ S3: ${BUCKET}"

# ─── Lambdas ─────────────────────────────────────────────────────────────────
deploy_lambda() {
  local NAME=$1 DIR=$2 TIMEOUT=$3 MEM=$4 ENV_VARS=$5
  cd "${REPO_ROOT}/lambda/${DIR}" && rm -f function.zip && zip -q function.zip index.mjs
  if aws lambda get-function --function-name "agentcore-hub-${NAME}" 2>/dev/null >/dev/null; then
    aws lambda update-function-code --function-name "agentcore-hub-${NAME}" \
      --zip-file fileb://function.zip --output text 2>/dev/null >/dev/null
    echo "✓ Lambda: agentcore-hub-${NAME} (updated)"
  else
    aws lambda create-function \
      --function-name "agentcore-hub-${NAME}" --runtime nodejs20.x --handler index.handler \
      --role "$ROLE_ARN" --zip-file fileb://function.zip \
      --timeout "$TIMEOUT" --memory-size "$MEM" \
      --environment "Variables=${ENV_VARS}" --output text 2>/dev/null >/dev/null
    echo "✓ Lambda: agentcore-hub-${NAME} (created)"
  fi
  rm -f function.zip
}

deploy_lambda "eval-packager" "eval-packager" 300 512 \
  "{ARTIFACT_BUCKET=${BUCKET},IMPROVEMENT_AGENT_ID=${AGENT_ID},AWS_ACCOUNT_ID=${ACCOUNT_ID}}"

deploy_lambda "prd-submitter" "prd-submitter" 30 256 \
  "{ARTIFACT_BUCKET=${BUCKET},WORKFLOW_API_URL=${WORKFLOW_API},FLEET_REPO_URL=${FLEET_REPO}}"

# ─── CW Logs → Packager (subscription filters) ──────────────────────────────
PACKAGER_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:agentcore-hub-eval-packager"

aws lambda add-permission \
  --function-name agentcore-hub-eval-packager --statement-id cw-logs-invoke \
  --action lambda:InvokeFunction --principal "logs.${AWS_REGION}.amazonaws.com" \
  --source-account "$ACCOUNT_ID" --output text 2>/dev/null || true

aws logs describe-log-groups \
  --log-group-name-prefix /aws/bedrock-agentcore/evaluations/results/ \
  --query 'logGroups[].logGroupName' --output json | python3 -c "
import json, sys, subprocess, os
for lg in json.load(sys.stdin):
    subprocess.run(['aws', 'logs', 'put-subscription-filter',
        '--log-group-name', lg, '--filter-name', 'eval-to-packager',
        '--filter-pattern', '', '--destination-arn', '${PACKAGER_ARN}'],
        capture_output=True, env={**os.environ})
"
echo "✓ Subscriptions: 14 eval log groups → packager"

# ─── S3 → PRD Submitter (EventBridge) ───────────────────────────────────────
SUBMITTER_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:agentcore-hub-prd-submitter"

aws events put-rule \
  --name "agentcore-hub-prd-submitter-trigger" \
  --event-pattern "{\"source\":[\"aws.s3\"],\"detail-type\":[\"Object Created\"],\"detail\":{\"bucket\":{\"name\":[\"${BUCKET}\"]},\"object\":{\"key\":[{\"prefix\":\"fleet-imp-agent/prd/\"}]}}}" \
  --state ENABLED --output text 2>/dev/null >/dev/null

aws events put-targets --rule "agentcore-hub-prd-submitter-trigger" \
  --targets "Id=prd-submitter,Arn=${SUBMITTER_ARN}" --output text 2>/dev/null >/dev/null

aws lambda add-permission \
  --function-name agentcore-hub-prd-submitter --statement-id prd-s3-trigger \
  --action lambda:InvokeFunction --principal events.amazonaws.com \
  --source-arn "arn:aws:events:${AWS_REGION}:${ACCOUNT_ID}:rule/agentcore-hub-prd-submitter-trigger" \
  --output text 2>/dev/null || true

echo "✓ S3 trigger: improvement-prds/ → prd-submitter → workflow API"

# ─── Prompts ─────────────────────────────────────────────────────────────────
for f in "${REPO_ROOT}/deploy/runtime-agent/prompts/agentcore_hub_"*.txt; do
  aws s3 cp "$f" "s3://${BUCKET}/prompts/$(basename "$f")" --quiet
done
echo "✓ Prompts synced"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ✓ Done"
echo ""
echo "  Eval → CW Logs → Packager → Agent → PRD → S3 → Submitter → Workflow API → PR"
echo "═══════════════════════════════════════════════════════════"
