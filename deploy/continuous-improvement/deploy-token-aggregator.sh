#!/usr/bin/env bash
# deploy/continuous-improvement/deploy-token-aggregator.sh
#
# Deploys the token-aggregator Lambda and creates subscription filters
# on all runtime log groups to pipe token usage metrics into DDB.
# Also sets up a weekly EventBridge cron to reset counters.
#
# Usage: bash deploy-token-aggregator.sh [--region us-east-1]

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
LAMBDA_NAME="agentcore-hub-token-aggregator"
LAMBDA_ROLE="arn:aws:iam::${ACCOUNT_ID}:role/agentcore-hub-lambda-role"
TABLE_NAME="agentcore-hub-eval-config"
BUCKET="agentcore-hub-artifacts-${ACCOUNT_ID}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAMBDA_DIR="${SCRIPT_DIR}/../../lambda/token-aggregator"

while [[ $# -gt 0 ]]; do
  case $1 in
    --region) REGION="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

echo "=== Deploy Token Aggregator ==="
echo "Region:  ${REGION}"
echo "Account: ${ACCOUNT_ID}"
echo "Lambda:  ${LAMBDA_NAME}"

###############################################################################
# Step 1: Package and deploy Lambda
###############################################################################
echo ""
echo "--- Step 1: Deploy Lambda ---"

cd "${LAMBDA_DIR}"
zip -j /tmp/token-aggregator.zip index.mjs

if aws lambda get-function --function-name "${LAMBDA_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "Updating existing Lambda..."
  aws lambda update-function-code \
    --function-name "${LAMBDA_NAME}" \
    --zip-file fileb:///tmp/token-aggregator.zip \
    --region "${REGION}" --output text --query 'FunctionArn'
  aws lambda wait function-updated --function-name "${LAMBDA_NAME}" --region "${REGION}"
  aws lambda update-function-configuration \
    --function-name "${LAMBDA_NAME}" \
    --timeout 60 --memory-size 256 \
    --environment "Variables={EVAL_CONFIG_TABLE=${TABLE_NAME},ARTIFACTS_BUCKET=${BUCKET}}" \
    --region "${REGION}" --output text --query 'FunctionArn'
else
  echo "Creating new Lambda..."
  aws lambda create-function \
    --function-name "${LAMBDA_NAME}" \
    --runtime nodejs20.x \
    --handler index.handler \
    --role "${LAMBDA_ROLE}" \
    --zip-file fileb:///tmp/token-aggregator.zip \
    --timeout 60 --memory-size 256 \
    --environment "Variables={EVAL_CONFIG_TABLE=${TABLE_NAME},ARTIFACTS_BUCKET=${BUCKET}}" \
    --region "${REGION}" --output text --query 'FunctionArn'
  aws lambda wait function-active --function-name "${LAMBDA_NAME}" --region "${REGION}"
fi

LAMBDA_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${LAMBDA_NAME}"
echo "✓ Lambda deployed: ${LAMBDA_ARN}"

###############################################################################
# Step 2: Grant CW Logs permission to invoke Lambda
###############################################################################
echo ""
echo "--- Step 2: Lambda permissions ---"

aws lambda add-permission \
  --function-name "${LAMBDA_NAME}" \
  --statement-id "cw-runtime-logs-invoke" \
  --action "lambda:InvokeFunction" \
  --principal "logs.${REGION}.amazonaws.com" \
  --source-account "${ACCOUNT_ID}" \
  --region "${REGION}" 2>/dev/null || echo "(permission already exists)"

echo "✓ CW Logs invoke permission set"

###############################################################################
# Step 3: Create subscription filters on all runtime log groups
###############################################################################
echo ""
echo "--- Step 3: Subscription filters ---"

RUNTIME_GROUPS=$(aws logs describe-log-groups \
  --log-group-name-prefix "/aws/bedrock-agentcore/runtimes/agentcore_hub_" \
  --query 'logGroups[].logGroupName' \
  --output json --region "${REGION}")

FILTER_COUNT=0
echo "${RUNTIME_GROUPS}" | python3 -c "
import json, sys, subprocess
groups = json.load(sys.stdin)
# Exclude fleet_improver and container runtimes
groups = [g for g in groups if 'fleet_improver' not in g and 'container' not in g]
for lg in groups:
    result = subprocess.run([
        'aws', 'logs', 'put-subscription-filter',
        '--log-group-name', lg,
        '--filter-name', 'token-to-aggregator',
        '--filter-pattern', 'gen_ai.client.token.usage',
        '--destination-arn', '${LAMBDA_ARN}',
        '--region', '${REGION}'
    ], capture_output=True, text=True)
    status = '✓' if result.returncode == 0 else '✗'
    print(f'  {status} {lg.split(\"/\")[-1][:50]}')
"

echo "✓ Subscription filters created"

###############################################################################
# Step 4: EventBridge weekly reset cron
###############################################################################
echo ""
echo "--- Step 4: Weekly reset cron ---"

RULE_NAME="agentcore-hub-token-reset-weekly"
aws events put-rule \
  --name "${RULE_NAME}" \
  --schedule-expression "cron(0 0 ? * MON *)" \
  --state ENABLED \
  --region "${REGION}" --output text --query 'RuleArn' 2>/dev/null || true

# Allow EventBridge to invoke Lambda
aws lambda add-permission \
  --function-name "${LAMBDA_NAME}" \
  --statement-id "eventbridge-weekly-reset" \
  --action "lambda:InvokeFunction" \
  --principal "events.amazonaws.com" \
  --source-arn "arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/${RULE_NAME}" \
  --region "${REGION}" 2>/dev/null || echo "(permission already exists)"

aws events put-targets \
  --rule "${RULE_NAME}" \
  --targets "Id=token-reset,Arn=${LAMBDA_ARN},Input={\"action\":\"reset\"}" \
  --region "${REGION}" --output text 2>/dev/null

echo "✓ Weekly reset cron configured (Mondays 00:00 UTC)"

###############################################################################
# Done
###############################################################################
echo ""
echo "=== Token Aggregator Deployment Complete ==="
echo "Runtime log groups → subscription filter → ${LAMBDA_NAME} → DDB (${TABLE_NAME})"
echo ""
echo "Next: Run backfill-tokens.sh to populate historical data"
