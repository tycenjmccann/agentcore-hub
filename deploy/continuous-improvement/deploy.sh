#!/bin/bash
# Deploy the Continuous Improvement Loop
#
# DEPLOY ORDER (see .claude-plugin/bin/run-module.sh, module `evaluations`):
#   1. deploy/setup-lambda-role.sh          — the shared Lambda role, incl. the
#                                             DynamoDB grants on eval-config and
#                                             the eval-seen dedup table
#   2. deploy/continuous-improvement/deploy-all.sh
#                                           — creates BOTH DynamoDB tables
#                                             (agentcore-hub-eval-config and
#                                             agentcore-hub-eval-seen, the latter
#                                             with TTL on expiresAt) and seeds
#                                             one config row per fleet agent
#   3. deploy/evaluations/setup-evaluations.sh
#   4. THIS SCRIPT                          — the Lambdas, CW Logs subscriptions,
#                                             alarms and S3/EventBridge wiring
# Running this before step 2 leaves eval-packager pointed at a table that does
# not exist: every seen-set PutItem throws, dedup fails OPEN (see
# dedupeAgainstSeenSet in lambda/eval-packager/index.mjs) and cross-delivery
# duplicates double-count the rolling eval aggregates.
set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "${REPO_ROOT}/deploy/config.sh"

BUCKET="$ARTIFACT_BUCKET"
ROLE_ARN="$LAMBDA_ROLE_ARN"
WORKFLOW_API="${DEPLOYMENT_URL:-}"
FLEET_REPO="$FLEET_REPO_URL"
# Cross-delivery dedup seen-set (config.sh defaults it to agentcore-hub-eval-seen,
# matching index.mjs and the table deploy-all.sh creates).
SEEN_TABLE="$EVAL_SEEN_TABLE"

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
  # Include lib/ when the function has one — eval-packager's classifiers live in
  # lib/classify.mjs, and index.mjs imports it at module load. Omitting it makes
  # every invocation fail with ERR_MODULE_NOT_FOUND at init.
  local EXTRA_PATHS=()
  [ -d lib ] && EXTRA_PATHS+=(lib/)
  # Bundle node_modules when the function declares runtime deps (e.g. the
  # eval-packager's SigV4 stack used to invoke the improver runtime). The
  # nodejs20.x runtime only ships the v3 SDK clients, not @smithy/* signing.
  if [ -f package.json ] && grep -q '"dependencies"' package.json; then
    npm install --omit=dev --no-audit --no-fund --silent
    zip -rq function.zip index.mjs package.json node_modules/ "${EXTRA_PATHS[@]}"
  else
    zip -rq function.zip index.mjs "${EXTRA_PATHS[@]}"
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
#
# EVAL_SEEN_TABLE names the cross-delivery dedup seen-set (PK dedupKey, TTL on
# expiresAt). index.mjs defaults to the same name, but it must be set EXPLICITLY:
# the table's existence is a deploy-order dependency on ./deploy-all.sh (which
# creates it) and on deploy/setup-lambda-role.sh (which grants Put/Get on it) —
# naming it here makes the wiring visible in the function config instead of
# hiding a silently fail-open dedup layer behind a code default.
deploy_lambda "eval-packager" "eval-packager" 600 512 \
  "{ARTIFACT_BUCKET=${BUCKET},IMPROVEMENT_AGENT_ARN=${IMPROVER_ARN},AWS_ACCOUNT_ID=${ACCOUNT_ID},EVAL_SEEN_TABLE=${SEEN_TABLE}}"

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

# ─── Alerting (SNS + CloudWatch alarms on eval health) ──────────────────────
# The packager publishes two EMF metrics from plain console.log lines (see
# lambda/eval-packager/lib/classify.mjs → emfRecord), so there's no
# PutMetricData permission to grant:
#   eval.preflight.missing_span   — a session whose invoke_agent span never
#                                   arrived, i.e. a RUNTIME TELEMETRY failure.
#                                   This is the signal that used to show up as
#                                   a silent 0/10 batch.
#   eval.batch.null_or_error_rate — % of a flushed batch that never scored.
# Both are emitted with Dimensions [["agentId"], []], i.e. a per-agent series AND
# a dimensionless fleet rollup.
#
# The rate is alarmed PER AGENT, because the rollup alone cannot see a single
# broken agent: one agent at 100% among three healthy ones averages to 25, which
# is under the 50 threshold, and the page never fires. Statistic Maximum (not
# Average) on every alarm for the same reason — a single flushed batch at 100 is
# the signal, and averaging it against that hour's healthy batches erases it.
# The dimensionless alarm stays as a fleet backstop for agents that aren't in
# fleet-runtime-ids.json yet.
# create-topic and put-metric-alarm are both idempotent by name.
ALERT_TOPIC_ARN=$(aws sns create-topic --name agentcore-hub-alerts \
  --region "$AWS_REGION" --query 'TopicArn' --output text)
echo "✓ SNS topic: ${ALERT_TOPIC_ARN}"

aws cloudwatch put-metric-alarm \
  --region "$AWS_REGION" \
  --alarm-name "agentcore-hub-eval-null-or-error-rate-high" \
  --alarm-description "FLEET BACKSTOP: some agent flushed an eval batch where more than 50% never scored (errors or missing scores) — suspect runtime telemetry, not agent quality. Per-agent alarms name the agent." \
  --namespace "AgentCoreHub/Evaluations" \
  --metric-name "eval.batch.null_or_error_rate" \
  --statistic Maximum \
  --period 3600 \
  --threshold 50 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 1 \
  --datapoints-to-alarm 1 \
  --treat-missing-data notBreaching \
  --alarm-actions "$ALERT_TOPIC_ARN" \
  --output text >/dev/null
echo "✓ Alarm: agentcore-hub-eval-null-or-error-rate-high (fleet backstop, max >50% over 1h)"

# ─── Per-agent rate alarms ──────────────────────────────────────────────────
# Agent ids come from fleet-runtime-ids.json (the same source setup-evaluations.sh
# reads) and equal the agentId dimension the packager publishes. If the file is
# absent the deploy must still succeed — the fleet backstop above still covers
# the whole fleet, just without naming the agent.
FLEET_FILE="${REPO_ROOT}/deploy/runtime-agent/fleet-runtime-ids.json"
if [ -f "$FLEET_FILE" ]; then
  AGENT_IDS=$(python3 -c "
import json
with open('$FLEET_FILE') as f:
    for name in json.load(f):
        print(name)
")
  PER_AGENT_ALARMS=0
  while read -r AGENT_ID; do
    [ -z "$AGENT_ID" ] && continue
    aws cloudwatch put-metric-alarm \
      --region "$AWS_REGION" \
      --alarm-name "agentcore-hub-eval-null-or-error-rate-${AGENT_ID}" \
      --alarm-description "More than 50% of a flushed eval batch for ${AGENT_ID} never scored (errors or missing scores) — suspect runtime telemetry for this agent, not its output quality." \
      --namespace "AgentCoreHub/Evaluations" \
      --metric-name "eval.batch.null_or_error_rate" \
      --dimensions "Name=agentId,Value=${AGENT_ID}" \
      --statistic Maximum \
      --period 3600 \
      --threshold 50 \
      --comparison-operator GreaterThanThreshold \
      --evaluation-periods 1 \
      --datapoints-to-alarm 1 \
      --treat-missing-data notBreaching \
      --alarm-actions "$ALERT_TOPIC_ARN" \
      --output text >/dev/null
    PER_AGENT_ALARMS=$((PER_AGENT_ALARMS + 1))
  done <<< "$AGENT_IDS"
  echo "✓ Alarms: ${PER_AGENT_ALARMS} per-agent eval-null-or-error-rate (max >50% over 1h)"
else
  echo "⚠ No ${FLEET_FILE} — skipping per-agent rate alarms (fleet backstop alarm still active)."
  echo "  Run deploy/runtime-agent/refresh-agents-json.sh, then re-run this script."
fi

aws cloudwatch put-metric-alarm \
  --region "$AWS_REGION" \
  --alarm-name "agentcore-hub-eval-missing-span" \
  --alarm-description "An eval session was rejected because the invoke_agent span was missing — the runtime is not exporting Strands telemetry." \
  --namespace "AgentCoreHub/Evaluations" \
  --metric-name "eval.preflight.missing_span" \
  --statistic Sum \
  --period 900 \
  --threshold 0 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 1 \
  --treat-missing-data notBreaching \
  --alarm-actions "$ALERT_TOPIC_ARN" \
  --output text >/dev/null
echo "✓ Alarm: agentcore-hub-eval-missing-span (any occurrence in 15m)"
echo "  Subscribe to alerts: aws sns subscribe --topic-arn ${ALERT_TOPIC_ARN} --protocol email --notification-endpoint you@example.com"

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
