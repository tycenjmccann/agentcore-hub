#!/usr/bin/env bash
# deploy/continuous-improvement/deploy-token-aggregator.sh
#
# Deploys the token-aggregator Lambda and creates subscription filters on every
# evaluations-enabled agent's log group (runtimes AND managed harnesses) to pipe
# LLM token usage into per-UTC-day buckets in DDB. The filter pattern depends on
# what each log group emits (see lambda/token-aggregator/index.mjs):
#   Strands runtimes  -> `chat` spans (the only cache-inclusive input count)
#   managed harnesses -> EMF gen_ai.client.token.usage metric records
#   coding runtime    -> Claude Code claude_code.api_request events
# Also REMOVES the legacy weekly EventBridge reset — the dashboard reads a
# rolling window from the day buckets, which prune themselves.
#
# Idempotent: re-runs update the Lambda code/config and skip resources that
# already exist.
#
# Usage: bash deploy-token-aggregator.sh [--region us-east-1]
#
# Required env (loaded from .env.local if present):
#   AWS_REGION
#   LAMBDA_ROLE_ARN  (set by deploy/setup-lambda-role.sh)
#   ARTIFACT_BUCKET  (defaults to agentcore-hub-artifacts-<ACCOUNT>-<REGION>)

set -euo pipefail

SCRIPT_DIR_BOOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_BOOT="$(cd "${SCRIPT_DIR_BOOT}/../.." && pwd)"
if [[ -f "${REPO_ROOT_BOOT}/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${REPO_ROOT_BOOT}/.env.local"
  set +a
fi

REGION="${AWS_REGION:-us-east-1}"

# Parse args before deriving REGION-dependent values (e.g. BUCKET) so that
# `--region` is honoured rather than baking in the default/AWS_REGION region.
while [[ $# -gt 0 ]]; do
  case $1 in
    --region) REGION="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
LAMBDA_NAME="agentcore-hub-token-aggregator"
LAMBDA_ROLE="${LAMBDA_ROLE_ARN:-arn:aws:iam::${ACCOUNT_ID}:role/agentcore-hub-lambda-role}"
TABLE_NAME="agentcore-hub-eval-config"
# Artifact bucket convention (matches deploy/config.sh): agentcore-hub-artifacts-<ACCOUNT>-<REGION>.
# The previous version dropped the region suffix and pointed the Lambda at a
# bucket that does not exist on first install.
BUCKET="${ARTIFACT_BUCKET:-agentcore-hub-artifacts-${ACCOUNT_ID}-${REGION}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAMBDA_DIR="${SCRIPT_DIR}/../../lambda/token-aggregator"

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
    --environment "Variables={EVAL_CONFIG_TABLE=${TABLE_NAME},ARTIFACTS_BUCKET=${BUCKET},DAILY_RETAIN_DAYS=14}" \
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
    --environment "Variables={EVAL_CONFIG_TABLE=${TABLE_NAME},ARTIFACTS_BUCKET=${BUCKET},DAILY_RETAIN_DAYS=14}" \
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
# Step 3: Subscription filters on every evaluations-enabled agent log group
###############################################################################
echo ""
echo "--- Step 3: Subscription filters ---"

AGENTS_FILE="${SCRIPT_DIR}/../../src/config/agents.json"
ALL_GROUPS=$(aws logs describe-log-groups \
  --log-group-name-prefix "/aws/bedrock-agentcore/runtimes/" \
  --query 'logGroups[].logGroupName' \
  --output json --region "${REGION}")

echo "${ALL_GROUPS}" | python3 -c "
import json, sys, subprocess
groups = json.load(sys.stdin)
agents = [a['agentId'] for a in json.load(open('${AGENTS_FILE}'))['agents'] if a.get('evaluationsEnabled')]
agents.sort(key=len, reverse=True)  # longest first: agentcore_hub_agent must not shadow agentcore_hub_agent_x

def resolve(leaf):
    for aid in agents:
        if leaf == aid or leaf.startswith(aid + '-') or leaf.startswith('harness_' + aid + '-'):
            return aid
    return None

# One pattern per emitter shape; the Lambda parses whichever arrives.
SPANS   = '\"strands.telemetry.tracer\" \"gen_ai.usage.input_tokens\"'
METRIC  = 'gen_ai.client.token.usage'
CLAUDE  = '\"claude_code.api_request\"'

for lg in groups:
    leaf = lg.split('/')[-1]
    if 'container' in leaf:
        continue
    aid = resolve(leaf)
    if not aid:
        continue
    if leaf.startswith('harness_'):
        pattern = METRIC
    elif 'coding_runtime' in aid:
        pattern = CLAUDE
    else:
        pattern = SPANS
    result = subprocess.run([
        'aws', 'logs', 'put-subscription-filter',
        '--log-group-name', lg,
        '--filter-name', 'token-to-aggregator',
        '--filter-pattern', pattern,
        '--destination-arn', '${LAMBDA_ARN}',
        '--region', '${REGION}'
    ], capture_output=True, text=True)
    status = 'OK ' if result.returncode == 0 else 'ERR'
    print(f'  {status} {leaf[:60]:60s} {pattern}' + ('' if result.returncode == 0 else '  ' + result.stderr.strip()[:120]))
"

echo "✓ Subscription filters in place"

###############################################################################
# Step 4: Remove the legacy weekly reset cron (rolling window replaces it)
###############################################################################
echo ""
echo "--- Step 4: Legacy weekly reset ---"

RULE_NAME="agentcore-hub-token-reset-weekly"
if aws events describe-rule --name "${RULE_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  aws events remove-targets --rule "${RULE_NAME}" --ids token-reset --region "${REGION}" >/dev/null 2>&1 || true
  aws events delete-rule --name "${RULE_NAME}" --region "${REGION}"
  echo "✓ Deleted ${RULE_NAME} (counters are no longer zeroed weekly)"
else
  echo "(no legacy reset rule present)"
fi
aws lambda remove-permission \
  --function-name "${LAMBDA_NAME}" \
  --statement-id "eventbridge-weekly-reset" \
  --region "${REGION}" >/dev/null 2>&1 || true

###############################################################################
# Done
###############################################################################
echo ""
echo "=== Token Aggregator Deployment Complete ==="
echo "Agent log groups → subscription filter → ${LAMBDA_NAME} → DDB (${TABLE_NAME}) daily[YYYY-MM-DD]"
echo ""
echo "Next: node deploy/continuous-improvement/backfill-daily.mjs --days 7   # fill the window from CW Logs Insights"
