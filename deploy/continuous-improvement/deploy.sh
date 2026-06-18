#!/bin/bash
# Deploy the Continuous Improvement Loop
set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "${REPO_ROOT}/deploy/config.sh"

BUCKET="$ARTIFACT_BUCKET"
ROLE_ARN="$LAMBDA_ROLE_ARN"
WORKFLOW_API="${DEPLOYMENT_URL:-}"
FLEET_REPO="$FLEET_REPO_URL"

# Resolve the Fleet Improver runtime ARN dynamically (no hardcoded suffix —
# the runtime id is account-specific). eval-packager invokes this on flush to
# synthesize the improvement PRD. Prefer an explicit override, else discover by
# name prefix. If none is found, the packager archives batches but skips
# synthesis (and logs a warning) rather than failing the flush.
IMPROVER_ARN="${IMPROVEMENT_AGENT_ARN:-}"
if [ -z "$IMPROVER_ARN" ]; then
  # Discovery is best-effort: an old AWS CLI without this AgentCore command, or
  # credentials that can't list runtimes, must NOT abort the deploy under `set -e`.
  # `|| true` swallows the nonzero exit so the empty-ARN fallback below runs.
  IMPROVER_ARN=$(aws bedrock-agentcore-control list-agent-runtimes --region "$AWS_REGION" \
    --query "agentRuntimes[?contains(agentRuntimeName,'fleet_improver')].agentRuntimeArn | [0]" \
    --output text 2>/dev/null || true)
  [ "$IMPROVER_ARN" = "None" ] && IMPROVER_ARN=""
fi
if [ -z "$IMPROVER_ARN" ]; then
  echo "⚠ Fleet Improver runtime not found. Deploy it first:"
  echo "    cd deploy/runtime-agent && ./deploy-one.sh agentcore_hub_fleet_improver"
  echo "  eval-packager will archive batches but skip PRD synthesis until IMPROVEMENT_AGENT_ARN is set."
fi

# DEPLOYMENT_URL is consumed only by prd-submitter. If it isn't set yet (e.g.
# when /setup runs evaluations before App Runner), deploy with a placeholder
# and remind the user to re-run after the URL is known.
if [ -z "$WORKFLOW_API" ]; then
  echo "⚠ DEPLOYMENT_URL not set — deploying prd-submitter with a placeholder."
  echo "  Re-run this script after App Runner is deployed, or update the prd-submitter"
  echo "  Lambda's WORKFLOW_API_URL env var manually."
  WORKFLOW_API="http://placeholder-update-after-apprunner"
fi

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
  cd "${REPO_ROOT}/lambda/${DIR}" && rm -f function.zip
  # Bundle node_modules when the function declares runtime deps (e.g. the
  # eval-packager's SigV4 stack used to invoke the improver runtime). The
  # nodejs20.x runtime only ships the v3 SDK clients, not @smithy/* signing.
  if [ -f package.json ] && grep -q '"dependencies"' package.json; then
    npm install --omit=dev --no-audit --no-fund --silent
    zip -rq function.zip index.mjs package.json node_modules/
  else
    zip -q function.zip index.mjs
  fi
  if aws lambda get-function --function-name "agentcore-hub-${NAME}" 2>/dev/null >/dev/null; then
    aws lambda update-function-code --function-name "agentcore-hub-${NAME}" \
      --zip-file fileb://function.zip --output text 2>/dev/null >/dev/null
    # update-function-code does NOT touch env vars — push them too so config
    # changes (e.g. a re-resolved IMPROVEMENT_AGENT_ARN) actually take effect.
    aws lambda wait function-updated --function-name "agentcore-hub-${NAME}" 2>/dev/null || true
    aws lambda update-function-configuration --function-name "agentcore-hub-${NAME}" \
      --environment "Variables=${ENV_VARS}" --output text 2>/dev/null >/dev/null
    echo "✓ Lambda: agentcore-hub-${NAME} (updated)"
  else
    aws lambda create-function \
      --function-name "agentcore-hub-${NAME}" --runtime nodejs20.x --handler index.handler \
      --role "$ROLE_ARN" --zip-file fileb://function.zip \
      --timeout "$TIMEOUT" --memory-size "$MEM" \
      --environment "Variables=${ENV_VARS}" --output text 2>/dev/null >/dev/null
    echo "✓ Lambda: agentcore-hub-${NAME} (created)"
  fi
  rm -rf function.zip node_modules
}

# 600s timeout: invokeImprover allows up to 240s, and the handleOverflow path can
# chain a second flush (its own synthesis) before retrying the append. 300s left
# no margin for that worst case; 600s clears it plus DDB/S3/CW Logs overhead.
deploy_lambda "eval-packager" "eval-packager" 600 512 \
  "{ARTIFACT_BUCKET=${BUCKET},IMPROVEMENT_AGENT_ARN=${IMPROVER_ARN},AWS_ACCOUNT_ID=${ACCOUNT_ID}}"

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
