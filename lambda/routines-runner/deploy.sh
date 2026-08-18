#!/bin/bash
# Deploy the Routines feature backend:
#   - DynamoDB routines table
#   - routines-runner Lambda (EventBridge Scheduler → POST /api/workflow/start)
#   - EventBridge Schedule group + a scheduler execution role that may invoke the runner
#   - grants the app (ECS/App Runner) + harness roles the routines DDB + scheduler perms
#
# Prereq: App Runner / ECS deployed (DEPLOYMENT_URL known) so the runner can reach
# the workflow API. Re-run after the URL is known if it wasn't set the first time.
set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "${REPO_ROOT}/deploy/config.sh"

ROLE_ARN="$LAMBDA_ROLE_ARN"
ROUTINES_TABLE="${ROUTINES_TABLE:-agentcore-hub-routines}"
SCHEDULE_GROUP="${ROUTINES_SCHEDULE_GROUP:-agentcore-hub-routines}"
SCHEDULER_ROLE_NAME="agentcore-hub-routines-scheduler-role"
LAMBDA_NAME="agentcore-hub-routines-runner"
WORKFLOW_API="${DEPLOYMENT_URL:-}"

if [ -z "$WORKFLOW_API" ]; then
  echo "⚠ DEPLOYMENT_URL not set — deploying routines-runner with a placeholder."
  echo "  Re-run after App Runner/ECS is up, or set the Lambda's WORKFLOW_API_URL manually."
  WORKFLOW_API="http://placeholder-update-after-apprunner"
fi

RUNNER_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${LAMBDA_NAME}"
SCHEDULER_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${SCHEDULER_ROLE_NAME}"
DLQ_NAME="${ROUTINES_DLQ_NAME:-agentcore-hub-routines-dlq}"
DLQ_ARN="arn:aws:sqs:${AWS_REGION}:${ACCOUNT_ID}:${DLQ_NAME}"

echo "═══════════════════════════════════════════════════════════"
echo "  Routines"
echo "  Account: ${ACCOUNT_ID}"
echo "  Table:   ${ROUTINES_TABLE}"
echo "═══════════════════════════════════════════════════════════"

# ─── DynamoDB: routines table (PK routineId, GSI on tenantId) ──────────────────
if ! aws dynamodb describe-table --table-name "$ROUTINES_TABLE" >/dev/null 2>&1; then
  aws dynamodb create-table \
    --table-name "$ROUTINES_TABLE" \
    --attribute-definitions \
      AttributeName=routineId,AttributeType=S \
      AttributeName=tenantId,AttributeType=S \
    --key-schema AttributeName=routineId,KeyType=HASH \
    --global-secondary-indexes \
      "IndexName=tenantId-index,KeySchema=[{AttributeName=tenantId,KeyType=HASH}],Projection={ProjectionType=ALL}" \
    --billing-mode PAY_PER_REQUEST --output text >/dev/null
  aws dynamodb wait table-exists --table-name "$ROUTINES_TABLE"
  echo "✓ Table: ${ROUTINES_TABLE} (created)"
else
  echo "✓ Table: ${ROUTINES_TABLE} (exists)"
fi

# ─── Runner Lambda ────────────────────────────────────────────────────────────
ENV_VARS="{ROUTINES_TABLE=${ROUTINES_TABLE},WORKFLOW_API_URL=${WORKFLOW_API}}"
cd "${REPO_ROOT}/lambda/routines-runner" && rm -f function.zip
npm install --omit=dev --no-audit --no-fund --silent
zip -rq function.zip index.mjs package.json node_modules/
if aws lambda get-function --function-name "$LAMBDA_NAME" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$LAMBDA_NAME" \
    --zip-file fileb://function.zip --output text >/dev/null
  aws lambda wait function-updated --function-name "$LAMBDA_NAME" 2>/dev/null || true
  aws lambda update-function-configuration --function-name "$LAMBDA_NAME" \
    --environment "Variables=${ENV_VARS}" --timeout 30 --output text >/dev/null
  echo "✓ Lambda: ${LAMBDA_NAME} (updated)"
else
  aws lambda create-function \
    --function-name "$LAMBDA_NAME" --runtime nodejs20.x --handler index.handler \
    --role "$ROLE_ARN" --zip-file fileb://function.zip \
    --timeout 30 --memory-size 256 \
    --environment "Variables=${ENV_VARS}" --output text >/dev/null
  echo "✓ Lambda: ${LAMBDA_NAME} (created)"
fi
rm -rf function.zip node_modules

# ─── Runner Lambda role: read routines table + write lastRun ──────────────────
aws iam put-role-policy --role-name "$(basename "$ROLE_ARN")" \
  --policy-name RoutinesRunnerAccess \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"RoutinesTable\",
      \"Effect\": \"Allow\",
      \"Action\": [\"dynamodb:GetItem\",\"dynamodb:UpdateItem\"],
      \"Resource\": \"arn:aws:dynamodb:${AWS_REGION}:${ACCOUNT_ID}:table/${ROUTINES_TABLE}\"
    }]
  }" >/dev/null
echo "✓ IAM: RoutinesRunnerAccess on $(basename "$ROLE_ARN")"

# ─── Dead-letter queue for failed schedule invokes ───────────────────────────
# Scheduler drops an invoke here after its bounded RetryPolicy is exhausted, so a
# persistently failing routine is visible (queue depth / alarm) instead of silent.
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

# ─── Scheduler execution role (scheduler.amazonaws.com assumes → invoke runner) ─
if ! aws iam get-role --role-name "$SCHEDULER_ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$SCHEDULER_ROLE_NAME" \
    --assume-role-policy-document "{
      \"Version\": \"2012-10-17\",
      \"Statement\": [{
        \"Effect\": \"Allow\",
        \"Principal\": {\"Service\": \"scheduler.amazonaws.com\"},
        \"Action\": \"sts:AssumeRole\",
        \"Condition\": {\"StringEquals\": {\"aws:SourceAccount\": \"${ACCOUNT_ID}\"}}
      }]
    }" --description "Lets EventBridge Scheduler invoke the routines-runner Lambda" \
    --output text >/dev/null
  echo "✓ IAM: ${SCHEDULER_ROLE_NAME} (created)"
else
  echo "✓ IAM: ${SCHEDULER_ROLE_NAME} (exists)"
fi
aws iam put-role-policy --role-name "$SCHEDULER_ROLE_NAME" \
  --policy-name InvokeRoutinesRunner \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Action\": \"lambda:InvokeFunction\",
      \"Resource\": [\"${RUNNER_ARN}\", \"${RUNNER_ARN}:*\"]
    }]
  }" >/dev/null
echo "✓ IAM: InvokeRoutinesRunner policy"

# ─── App/harness roles: manage routines (DDB) + schedules (Scheduler) ─────────
# The Next app (ECS/App Runner task role) and the Routine Builder harness both
# create/update/delete routine rows + their schedules. Grant both here. The
# schedule Target uses the scheduler role above, so these principals also need
# iam:PassRole on it.
for PRINCIPAL_ROLE in "${ECS_TASK_ROLE_NAME:-agentcore-hub-ecs-task}" "agentcore-hub-harness-role"; do
  aws iam get-role --role-name "$PRINCIPAL_ROLE" >/dev/null 2>&1 || { echo "  (skip ${PRINCIPAL_ROLE} — not found)"; continue; }
  aws iam put-role-policy --role-name "$PRINCIPAL_ROLE" \
    --policy-name RoutinesManage \
    --policy-document "{
      \"Version\": \"2012-10-17\",
      \"Statement\": [
        {
          \"Sid\": \"RoutinesTable\",
          \"Effect\": \"Allow\",
          \"Action\": [\"dynamodb:GetItem\",\"dynamodb:PutItem\",\"dynamodb:UpdateItem\",\"dynamodb:DeleteItem\",\"dynamodb:Scan\",\"dynamodb:Query\"],
          \"Resource\": [
            \"arn:aws:dynamodb:${AWS_REGION}:${ACCOUNT_ID}:table/${ROUTINES_TABLE}\",
            \"arn:aws:dynamodb:${AWS_REGION}:${ACCOUNT_ID}:table/${ROUTINES_TABLE}/index/*\"
          ]
        },
        {
          \"Sid\": \"ManageSchedules\",
          \"Effect\": \"Allow\",
          \"Action\": [\"scheduler:CreateSchedule\",\"scheduler:UpdateSchedule\",\"scheduler:DeleteSchedule\",\"scheduler:GetSchedule\"],
          \"Resource\": \"arn:aws:scheduler:${AWS_REGION}:${ACCOUNT_ID}:schedule/${SCHEDULE_GROUP}/*\"
        },
        {
          \"Sid\": \"PassSchedulerRole\",
          \"Effect\": \"Allow\",
          \"Action\": \"iam:PassRole\",
          \"Resource\": \"${SCHEDULER_ROLE_ARN}\",
          \"Condition\": {\"StringEquals\": {\"iam:PassedToService\": \"scheduler.amazonaws.com\"}}
        }
      ]
    }" >/dev/null
  echo "✓ IAM: RoutinesManage on ${PRINCIPAL_ROLE}"
done

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ✓ Done"
echo ""
echo "  Set these on the app (ECS/App Runner) env + Routine Builder harness:"
echo "    ROUTINES_TABLE=${ROUTINES_TABLE}"
echo "    ROUTINES_RUNNER_ARN=${RUNNER_ARN}"
echo "    ROUTINES_SCHEDULER_ROLE_ARN=${SCHEDULER_ROLE_ARN}"
echo "    ROUTINES_SCHEDULE_GROUP=${SCHEDULE_GROUP}"
echo "    ROUTINES_DLQ_ARN=${DLQ_ARN}"
echo ""
echo "  Scheduler → routines-runner → POST ${WORKFLOW_API}/api/workflow/start"
echo "═══════════════════════════════════════════════════════════"
