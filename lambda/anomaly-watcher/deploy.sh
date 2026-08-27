#!/bin/bash
# Deploy the anomaly-watcher backend (design §9):
#   - DynamoDB watcher-state table (pk/sk, TTL on expiresAt)
#   - intakeChannel-index GSI on the workflows table (fleet-wide open-run cap)
#   - a DEDICATED least-privilege Lambda role (§9.3) — NOT the shared LAMBDA_ROLE_ARN
#   - anomaly-watcher Lambda (nodejs20.x, reserved concurrency 1)
#   - EventBridge Schedule group + scheduler execution role + rate(10 minutes) schedule
#   - SQS DLQ for exhausted schedule retries
#
# INGRESS: none. No function URL, no API Gateway, no resource policy. The only
# lambda:InvokeFunction grant anywhere in this script is on the scheduler role.
#
# Prereq: App Runner / ECS deployed (DEPLOYMENT_URL known) so the watcher can reach
# the workflow API. Without it Tier 3 still detects and pages — it just cannot file.
set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "${REPO_ROOT}/deploy/config.sh"

LAMBDA_NAME="agentcore-hub-anomaly-watcher"
ROLE_NAME="agentcore-hub-anomaly-watcher-role"
STATE_TABLE="${WATCHER_STATE_TABLE:-agentcore-hub-anomaly-watcher-state}"
EVAL_CONFIG_TABLE="${EVAL_CONFIG_TABLE:-agentcore-hub-eval-config}"
ANALYZER_FUNCTION="${WORKFLOW_ANALYZER_FUNCTION:-agentcore-hub-workflow-analyzer}"
EVENT_BUS="${EVENT_BUS:-default}"
INTAKE_INDEX="intakeChannel-index"

SCHEDULE_NAME="agentcore-hub-anomaly-watcher"
SCHEDULE_GROUP="${ANOMALY_SCHEDULE_GROUP:-agentcore-hub-anomaly-watcher}"
SCHEDULER_ROLE_NAME="agentcore-hub-anomaly-watcher-scheduler-role"
DLQ_NAME="${ANOMALY_DLQ_NAME:-agentcore-hub-anomaly-watcher-dlq}"

ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
WATCHER_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${LAMBDA_NAME}"
SCHEDULER_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${SCHEDULER_ROLE_NAME}"
# TEAM-3334 F4a: the exact schedule allowed to assume the scheduler role.
SCHEDULE_ARN="arn:aws:scheduler:${AWS_REGION}:${ACCOUNT_ID}:schedule/${SCHEDULE_GROUP}/${SCHEDULE_NAME}"
DLQ_ARN="arn:aws:sqs:${AWS_REGION}:${ACCOUNT_ID}:${DLQ_NAME}"
ANALYZER_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${ANALYZER_FUNCTION}"
BUS_ARN="arn:aws:events:${AWS_REGION}:${ACCOUNT_ID}:event-bus/${EVENT_BUS}"
DDB="arn:aws:dynamodb:${AWS_REGION}:${ACCOUNT_ID}:table"

WORKFLOW_API="${DEPLOYMENT_URL:-}"
if [ -z "$WORKFLOW_API" ]; then
  echo "⚠ DEPLOYMENT_URL not set — WORKFLOW_API_URL will be EMPTY."
  echo "  The watcher still detects and pages; Tier 3 records 'WORKFLOW_API_URL is not"
  echo "  configured' and files nothing. Re-run once App Runner/ECS is up."
fi

# The repo a Tier-3 bug workflow is filed against. Empty is valid — the filing
# just carries no repoConfig.repos entry.
ANOMALY_REPO_URL="${ANOMALY_REPO_URL:-}"
if [ -z "$ANOMALY_REPO_URL" ] && [ -n "${GITHUB_OWNER:-}" ]; then
  ANOMALY_REPO_URL="https://github.com/${GITHUB_OWNER}/agentcore-hub.git"
fi

echo "═══════════════════════════════════════════════════════════"
echo "  Anomaly watcher"
echo "  Account: ${ACCOUNT_ID}"
echo "  State:   ${STATE_TABLE}"
echo "  Cadence: rate(10 minutes) — defined here, never in code"
echo "═══════════════════════════════════════════════════════════"

# ─── DynamoDB: watcher-state table (pk/sk, TTL expiresAt) ─────────────────────
if ! aws dynamodb describe-table --table-name "$STATE_TABLE" >/dev/null 2>&1; then
  aws dynamodb create-table \
    --table-name "$STATE_TABLE" \
    --attribute-definitions \
      AttributeName=pk,AttributeType=S \
      AttributeName=sk,AttributeType=S \
    --key-schema \
      AttributeName=pk,KeyType=HASH \
      AttributeName=sk,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST --output text >/dev/null
  aws dynamodb wait table-exists --table-name "$STATE_TABLE"
  echo "✓ Table: ${STATE_TABLE} (created)"
else
  echo "✓ Table: ${STATE_TABLE} (exists)"
fi

# Every cursor, claim, aggregate and point row carries expiresAt (§5). Enabling
# TTL twice is an error, so check first — the handler ALSO checks expiresAt on
# read, so a late sweep never resurrects a stale claim.
TTL_STATUS="$(aws dynamodb describe-time-to-live --table-name "$STATE_TABLE" \
  --query 'TimeToLiveDescription.TimeToLiveStatus' --output text 2>/dev/null || echo UNKNOWN)"
if [ "$TTL_STATUS" = "ENABLED" ] || [ "$TTL_STATUS" = "ENABLING" ]; then
  echo "✓ TTL: expiresAt on ${STATE_TABLE} (${TTL_STATUS})"
else
  aws dynamodb update-time-to-live --table-name "$STATE_TABLE" \
    --time-to-live-specification "Enabled=true,AttributeName=expiresAt" --output text >/dev/null
  echo "✓ TTL: expiresAt on ${STATE_TABLE} (enabled)"
fi

# ─── DynamoDB: intakeChannel-index on the workflows table (§6) ─────────────────
# One Query on this index is how the watcher counts its own open filings, so the
# fleet-wide cap of 3 is enforceable at all. Added online (no downtime); the
# index backfills asynchronously and the watcher fails CLOSED until it is ACTIVE.
if aws dynamodb describe-table --table-name "$WORKFLOWS_TABLE" \
  --query "Table.GlobalSecondaryIndexes[?IndexName=='${INTAKE_INDEX}'].IndexName" \
  --output text 2>/dev/null | grep -q "$INTAKE_INDEX"; then
  echo "✓ GSI: ${INTAKE_INDEX} on ${WORKFLOWS_TABLE} (exists)"
else
  aws dynamodb update-table \
    --table-name "$WORKFLOWS_TABLE" \
    --attribute-definitions \
      AttributeName=intakeChannel,AttributeType=S \
      AttributeName=startedAt,AttributeType=S \
    --global-secondary-index-updates "[{
      \"Create\": {
        \"IndexName\": \"${INTAKE_INDEX}\",
        \"KeySchema\": [
          {\"AttributeName\": \"intakeChannel\", \"KeyType\": \"HASH\"},
          {\"AttributeName\": \"startedAt\", \"KeyType\": \"RANGE\"}
        ],
        \"Projection\": {\"ProjectionType\": \"INCLUDE\", \"NonKeyAttributes\": [\"phase\", \"archived\"]}
      }
    }]" --output text >/dev/null
  echo "✓ GSI: ${INTAKE_INDEX} on ${WORKFLOWS_TABLE} (creating — backfills in the background)"
fi

# ─── Dedicated least-privilege Lambda role (§9.3) ──────────────────────────────
# Deliberately NOT the shared LAMBDA_ROLE_ARN: this function may write anomaly
# records and append notifications, and nothing else. No PutItem on workflows,
# no S3, no Bedrock, no scheduler mutation.
ROLE_CREATED=""
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{
        "Effect": "Allow",
        "Principal": {"Service": "lambda.amazonaws.com"},
        "Action": "sts:AssumeRole"
      }]
    }' --description "Least-privilege role for the agentcore-hub anomaly watcher" \
    --output text >/dev/null
  ROLE_CREATED="yes"
  echo "✓ IAM: ${ROLE_NAME} (created)"
else
  echo "✓ IAM: ${ROLE_NAME} (exists)"
fi

aws iam attach-role-policy --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null
echo "✓ IAM: AWSLambdaBasicExecutionRole attached"

# TEAM-3334 F4b: WorkflowsNotify is scoped to the single UpdateItem the watcher
# makes (index.mjs tier2 notification): list_append on humanNotifications with an
# attribute_exists(workflowId) condition and no ReturnValues. Key + condition
# attributes count as accessed, hence workflowId in dynamodb:Attributes;
# StringEqualsIfExists permits the default (unset) ReturnValues but nothing else.
aws iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name AnomalyWatcherAccess \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"EventsRead\",
        \"Effect\": \"Allow\",
        \"Action\": [\"dynamodb:Query\"],
        \"Resource\": \"${DDB}/${EVENTS_TABLE}\"
      },
      {
        \"Sid\": \"AnomalyRecord\",
        \"Effect\": \"Allow\",
        \"Action\": [\"dynamodb:PutItem\"],
        \"Resource\": \"${DDB}/${EVENTS_TABLE}\"
      },
      {
        \"Sid\": \"WorkflowsRead\",
        \"Effect\": \"Allow\",
        \"Action\": [\"dynamodb:Scan\",\"dynamodb:Query\"],
        \"Resource\": [
          \"${DDB}/${WORKFLOWS_TABLE}\",
          \"${DDB}/${WORKFLOWS_TABLE}/index/${INTAKE_INDEX}\"
        ]
      },
      {
        \"Sid\": \"WorkflowsNotify\",
        \"Effect\": \"Allow\",
        \"Action\": [\"dynamodb:UpdateItem\"],
        \"Resource\": \"${DDB}/${WORKFLOWS_TABLE}\",
        \"Condition\": {
          \"ForAllValues:StringEquals\": {
            \"dynamodb:Attributes\": [\"workflowId\", \"humanNotifications\"]
          },
          \"StringEqualsIfExists\": {\"dynamodb:ReturnValues\": \"NONE\"}
        }
      },
      {
        \"Sid\": \"EvalConfigRead\",
        \"Effect\": \"Allow\",
        \"Action\": [\"dynamodb:Scan\"],
        \"Resource\": \"${DDB}/${EVAL_CONFIG_TABLE}\"
      },
      {
        \"Sid\": \"WatcherState\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"dynamodb:GetItem\",
          \"dynamodb:Query\",
          \"dynamodb:PutItem\",
          \"dynamodb:UpdateItem\",
          \"dynamodb:DeleteItem\"
        ],
        \"Resource\": \"${DDB}/${STATE_TABLE}\"
      },
      {
        \"Sid\": \"InvokeAnalyzerOnly\",
        \"Effect\": \"Allow\",
        \"Action\": \"lambda:InvokeFunction\",
        \"Resource\": [\"${ANALYZER_ARN}\", \"${ANALYZER_ARN}:*\"]
      },
      {
        \"Sid\": \"PublishAnomalyEvents\",
        \"Effect\": \"Allow\",
        \"Action\": \"events:PutEvents\",
        \"Resource\": \"${BUS_ARN}\"
      }
    ]
  }" >/dev/null
echo "✓ IAM: AnomalyWatcherAccess on ${ROLE_NAME}"

if [ -n "$ROLE_CREATED" ]; then
  echo "  (waiting 10s for the new role to propagate before create-function)"
  sleep 10
fi

# ─── Watcher Lambda ───────────────────────────────────────────────────────────
# bands.yaml ships INSIDE the artifact: the config the cycle ran on is pinned to
# the deployed code, and its sha256 goes into every piece of evidence (§8.1).
# --environment is JSON, not the K=V shorthand, so an EMPTY WORKFLOW_API_URL
# survives (it is a meaningful value — see the degrade path in §6).
ENVIRONMENT="{\"Variables\":{
  \"EVENTS_TABLE\":\"${EVENTS_TABLE}\",
  \"WORKFLOWS_TABLE\":\"${WORKFLOWS_TABLE}\",
  \"EVAL_CONFIG_TABLE\":\"${EVAL_CONFIG_TABLE}\",
  \"WATCHER_STATE_TABLE\":\"${STATE_TABLE}\",
  \"WORKFLOW_API_URL\":\"${WORKFLOW_API}\",
  \"WORKFLOW_ANALYZER_FUNCTION\":\"${ANALYZER_FUNCTION}\",
  \"EVENT_BUS\":\"${EVENT_BUS}\",
  \"ANOMALY_REPO_URL\":\"${ANOMALY_REPO_URL}\"
}}"

cd "${REPO_ROOT}/lambda/anomaly-watcher" && rm -f function.zip
npm install --omit=dev --no-audit --no-fund --silent
zip -rq function.zip index.mjs detect.mjs bands-schema.mjs bands.yaml package.json node_modules/
if aws lambda get-function --function-name "$LAMBDA_NAME" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$LAMBDA_NAME" \
    --zip-file fileb://function.zip --output text >/dev/null
  aws lambda wait function-updated --function-name "$LAMBDA_NAME" 2>/dev/null || true
  aws lambda update-function-configuration --function-name "$LAMBDA_NAME" \
    --role "$ROLE_ARN" --handler index.handler \
    --environment "$ENVIRONMENT" --timeout 120 --memory-size 256 --output text >/dev/null
  aws lambda wait function-updated --function-name "$LAMBDA_NAME" 2>/dev/null || true
  echo "✓ Lambda: ${LAMBDA_NAME} (updated)"
else
  aws lambda create-function \
    --function-name "$LAMBDA_NAME" --runtime nodejs20.x --handler index.handler \
    --role "$ROLE_ARN" --zip-file fileb://function.zip \
    --timeout 120 --memory-size 256 \
    --environment "$ENVIRONMENT" --output text >/dev/null
  aws lambda wait function-active-v2 --function-name "$LAMBDA_NAME" 2>/dev/null || true
  echo "✓ Lambda: ${LAMBDA_NAME} (created)"
fi
rm -rf function.zip node_modules

# One concurrent execution, fleet-wide. Two overlapping cycles are already safe
# (claim-before-act), but there is no work for a second one to do.
aws lambda put-function-concurrency --function-name "$LAMBDA_NAME" \
  --reserved-concurrent-executions 1 --output text >/dev/null
echo "✓ Lambda: reserved concurrency 1"

# ─── Dead-letter queue for failed schedule invokes ───────────────────────────
# Scheduler drops an invoke here after its bounded RetryPolicy is exhausted, so a
# persistently failing watcher is visible (queue depth / alarm) instead of silent.
if ! aws sqs get-queue-url --queue-name "$DLQ_NAME" >/dev/null 2>&1; then
  aws sqs create-queue --queue-name "$DLQ_NAME" \
    --attributes MessageRetentionPeriod=1209600 --output text >/dev/null
  echo "✓ DLQ: ${DLQ_NAME} (created)"
else
  echo "✓ DLQ: ${DLQ_NAME} (exists)"
fi
# Allow EventBridge Scheduler to send failed invokes to the DLQ.
aws sqs set-queue-attributes --queue-url "https://sqs.${AWS_REGION}.amazonaws.com/${ACCOUNT_ID}/${DLQ_NAME}" \
  --attributes "{\"Policy\":\"{\\\"Version\\\":\\\"2012-10-17\\\",\\\"Statement\\\":[{\\\"Effect\\\":\\\"Allow\\\",\\\"Principal\\\":{\\\"Service\\\":\\\"scheduler.amazonaws.com\\\"},\\\"Action\\\":\\\"sqs:SendMessage\\\",\\\"Resource\\\":\\\"${DLQ_ARN}\\\",\\\"Condition\\\":{\\\"StringEquals\\\":{\\\"aws:SourceAccount\\\":\\\"${ACCOUNT_ID}\\\"}}}]}\"}" \
  >/dev/null 2>&1 || echo "  (warn: could not set DLQ policy — set manually)"
echo "✓ IAM: DLQ send policy for scheduler.amazonaws.com"

# ─── EventBridge Schedule group ───────────────────────────────────────────────
aws scheduler create-schedule-group --name "$SCHEDULE_GROUP" --output text >/dev/null 2>&1 \
  && echo "✓ Schedule group: ${SCHEDULE_GROUP} (created)" \
  || echo "✓ Schedule group: ${SCHEDULE_GROUP} (exists)"

# ─── Scheduler execution role (scheduler.amazonaws.com assumes → invoke watcher) ─
# This role holds the ONLY lambda:InvokeFunction grant on the watcher. There is no
# function URL, no API Gateway stage, and no resource policy — the function has no
# ingress an outside caller could reach.
# TEAM-3334 F4a: pin the trust to THIS schedule's ARN, not just the account —
# without aws:SourceArn any schedule in the account could assume the invoke
# role. Applied on the exists path too, so already-deployed roles get hardened.
SCHEDULER_TRUST_POLICY="{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Effect\": \"Allow\",
    \"Principal\": {\"Service\": \"scheduler.amazonaws.com\"},
    \"Action\": \"sts:AssumeRole\",
    \"Condition\": {
      \"StringEquals\": {\"aws:SourceAccount\": \"${ACCOUNT_ID}\"},
      \"ArnLike\": {\"aws:SourceArn\": \"${SCHEDULE_ARN}\"}
    }
  }]
}"
if ! aws iam get-role --role-name "$SCHEDULER_ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$SCHEDULER_ROLE_NAME" \
    --assume-role-policy-document "$SCHEDULER_TRUST_POLICY" \
    --description "Lets EventBridge Scheduler invoke the anomaly-watcher Lambda" \
    --output text >/dev/null
  echo "✓ IAM: ${SCHEDULER_ROLE_NAME} (created — trust pinned to ${SCHEDULE_ARN})"
else
  aws iam update-assume-role-policy --role-name "$SCHEDULER_ROLE_NAME" \
    --policy-document "$SCHEDULER_TRUST_POLICY" >/dev/null
  echo "✓ IAM: ${SCHEDULER_ROLE_NAME} (exists — trust pinned to ${SCHEDULE_ARN})"
fi
aws iam put-role-policy --role-name "$SCHEDULER_ROLE_NAME" \
  --policy-name InvokeAnomalyWatcher \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Effect\": \"Allow\",
        \"Action\": \"lambda:InvokeFunction\",
        \"Resource\": [\"${WATCHER_ARN}\", \"${WATCHER_ARN}:*\"]
      },
      {
        \"Effect\": \"Allow\",
        \"Action\": \"sqs:SendMessage\",
        \"Resource\": \"${DLQ_ARN}\"
      }
    ]
  }" >/dev/null
echo "✓ IAM: InvokeAnomalyWatcher policy"

# ─── The schedule: rate(10 minutes) ───────────────────────────────────────────
# The cadence lives HERE and nowhere else (§9.1). Input passes the scheduled
# instant through as scheduled-time, so every metric in a cycle shares one window
# and two overlapping invocations compute the same claim keys — the handler's
# Date.now() fallback is only for a manual invoke.
TARGET="{
  \"Arn\": \"${WATCHER_ARN}\",
  \"RoleArn\": \"${SCHEDULER_ROLE_ARN}\",
  \"RetryPolicy\": {\"MaximumRetryAttempts\": 2},
  \"DeadLetterConfig\": {\"Arn\": \"${DLQ_ARN}\"},
  \"Input\": \"{\\\"scheduled-time\\\":\\\"<aws.scheduler.scheduled-time>\\\"}\"
}"
if aws scheduler get-schedule --name "$SCHEDULE_NAME" --group-name "$SCHEDULE_GROUP" >/dev/null 2>&1; then
  aws scheduler update-schedule --name "$SCHEDULE_NAME" --group-name "$SCHEDULE_GROUP" \
    --schedule-expression "rate(10 minutes)" \
    --flexible-time-window '{"Mode":"OFF"}' \
    --state ENABLED --target "$TARGET" --output text >/dev/null
  echo "✓ Schedule: ${SCHEDULE_NAME} (updated) — rate(10 minutes)"
else
  aws scheduler create-schedule --name "$SCHEDULE_NAME" --group-name "$SCHEDULE_GROUP" \
    --schedule-expression "rate(10 minutes)" \
    --flexible-time-window '{"Mode":"OFF"}' \
    --state ENABLED --target "$TARGET" --output text >/dev/null
  echo "✓ Schedule: ${SCHEDULE_NAME} (created) — rate(10 minutes)"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ✓ Done"
echo ""
echo "    WATCHER_ARN=${WATCHER_ARN}"
echo "    WATCHER_STATE_TABLE=${STATE_TABLE}"
echo "    ANOMALY_DLQ_ARN=${DLQ_ARN}"
echo "    ANOMALY_SCHEDULE=${SCHEDULE_GROUP}/${SCHEDULE_NAME}"
echo ""
echo "  Scheduler → anomaly-watcher every 10 min. No public ingress."
echo "  Tier 1 logs · Tier 2 diagnoses + pages · Tier 3 files a bug (max 3 open)."
if [ -z "$WORKFLOW_API" ]; then
  echo ""
  echo "  ⚠ WORKFLOW_API_URL is empty — Tier 3 will page instead of filing."
fi
echo "═══════════════════════════════════════════════════════════"
