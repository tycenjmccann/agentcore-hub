#!/bin/bash
# Deploy the Workflow Manager pipeline (trigger Lambda + table + rules + toolkit).
#
# Prereq: the harness itself —
#   node deploy/workflow-manager/setup-workflow-manager.mjs
#
# Watchdog kill switch:
#   aws events disable-rule --name agentcore-hub-workflow-watch-schedule
set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "${REPO_ROOT}/deploy/config.sh"

BUCKET="$ARTIFACT_BUCKET"
ROLE_ARN="$LAMBDA_ROLE_ARN"
ANALYSES_TABLE="${ANALYSES_TABLE:-agentcore-hub-workflow-analyses}"

# Resolve the Workflow Manager harness ARN — explicit override, else discover.
WM_ARN="${WORKFLOW_MANAGER_ARN:-}"
if [ -z "$WM_ARN" ]; then
  WM_ARN=$(aws bedrock-agentcore-control list-harnesses --region "$AWS_REGION" \
    --query "harnesses[?harnessName=='agentcore_hub_workflow_manager'].arn | [0]" \
    --output text 2>/dev/null || true)
  [ "$WM_ARN" = "None" ] && WM_ARN=""
fi
if [ -z "$WM_ARN" ]; then
  echo "✗ Workflow Manager harness not found. Deploy it first:"
  echo "    node deploy/workflow-manager/setup-workflow-manager.mjs"
  exit 1
fi

echo "═══════════════════════════════════════════════════════════"
echo "  Workflow Manager"
echo "  Account: ${ACCOUNT_ID}"
echo "  Harness: ${WM_ARN}"
echo "═══════════════════════════════════════════════════════════"

# ─── DynamoDB: analyses table + workflowDefId GSI ─────────────────────────────
if ! aws dynamodb describe-table --table-name "$ANALYSES_TABLE" >/dev/null 2>&1; then
  aws dynamodb create-table \
    --table-name "$ANALYSES_TABLE" \
    --attribute-definitions \
      AttributeName=workflowId,AttributeType=S \
      AttributeName=analysisId,AttributeType=S \
      AttributeName=workflowDefId,AttributeType=S \
    --key-schema \
      AttributeName=workflowId,KeyType=HASH \
      AttributeName=analysisId,KeyType=RANGE \
    --global-secondary-indexes \
      "IndexName=workflowDefId-index,KeySchema=[{AttributeName=workflowDefId,KeyType=HASH},{AttributeName=analysisId,KeyType=RANGE}],Projection={ProjectionType=ALL}" \
    --billing-mode PAY_PER_REQUEST --output text >/dev/null
  aws dynamodb wait table-exists --table-name "$ANALYSES_TABLE"
  echo "✓ Table: ${ANALYSES_TABLE} (created)"
else
  echo "✓ Table: ${ANALYSES_TABLE} (exists)"
fi

# ─── Lambda role: analyses table access + InvokeHarness ──────────────────────
aws iam put-role-policy --role-name agentcore-hub-lambda-role \
  --policy-name WorkflowManagerAccess \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"AnalysesTable\",
        \"Effect\": \"Allow\",
        \"Action\": [\"dynamodb:GetItem\",\"dynamodb:Query\",\"dynamodb:PutItem\",\"dynamodb:Scan\",\"dynamodb:UpdateItem\"],
        \"Resource\": [
          \"arn:aws:dynamodb:${AWS_REGION}:${ACCOUNT_ID}:table/${ANALYSES_TABLE}\",
          \"arn:aws:dynamodb:${AWS_REGION}:${ACCOUNT_ID}:table/${ANALYSES_TABLE}/index/*\"
        ]
      },
      {
        \"Sid\": \"InvokeHarness\",
        \"Effect\": \"Allow\",
        \"Action\": [\"bedrock-agentcore:InvokeHarness\",\"bedrock-agentcore:InvokeAgentRuntime\"],
        \"Resource\": \"*\"
      }
    ]
  }" >/dev/null
echo "✓ IAM: WorkflowManagerAccess policy on agentcore-hub-lambda-role"

# ─── Toolkit sync (updates take effect on the next harness session) ──────────
aws s3 sync "${REPO_ROOT}/deploy/workflow-manager/toolkit/" \
  "s3://${BUCKET}/workflow-manager/toolkit/" \
  --exclude "test_*.py" --exclude "*.pyc" --delete --quiet
echo "✓ Toolkit: s3://${BUCKET}/workflow-manager/toolkit/"

# ─── Skills sync (harness skills[] resolves these S3 URIs on demand) ─────────
# Adding a NEW skill also requires registering its URI in the harness skills[]
# array: re-run setup-workflow-manager.mjs. Editing an existing skill = this
# sync alone.
aws s3 sync "${REPO_ROOT}/deploy/workflow-manager/skills/" \
  "s3://${BUCKET}/workflow-manager/skills/" \
  --exclude "*.pyc" --delete --quiet
echo "✓ Skills: s3://${BUCKET}/workflow-manager/skills/"

# ─── Trigger Lambda ───────────────────────────────────────────────────────────
LAMBDA_NAME="agentcore-hub-workflow-analyzer"
ENV_VARS="{WORKFLOW_MANAGER_ARN=${WM_ARN},ANALYSES_TABLE=${ANALYSES_TABLE},WORKFLOWS_TABLE=${WORKFLOWS_TABLE},EVENTS_TABLE=${EVENTS_TABLE},WM_STALE_MINUTES=${WM_STALE_MINUTES:-10},WM_WATCH_COOLDOWN_MINUTES=${WM_WATCH_COOLDOWN_MINUTES:-15},HUB_REPO_URL=${HUB_REPO_URL:-},SI_BATCH_SIZE=${SI_BATCH_SIZE:-5},SI_COOLDOWN_HOURS=${SI_COOLDOWN_HOURS:-12}}"

cd "${REPO_ROOT}/lambda/workflow-analyzer" && rm -f function.zip
npm install --omit=dev --no-audit --no-fund --silent
zip -rq function.zip index.mjs package.json node_modules/
if aws lambda get-function --function-name "$LAMBDA_NAME" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$LAMBDA_NAME" \
    --zip-file fileb://function.zip --output text >/dev/null
  aws lambda wait function-updated --function-name "$LAMBDA_NAME" 2>/dev/null || true
  # update-function-code does NOT touch env vars — push them so config changes land.
  aws lambda update-function-configuration --function-name "$LAMBDA_NAME" \
    --environment "Variables=${ENV_VARS}" --timeout 900 --output text >/dev/null
  echo "✓ Lambda: ${LAMBDA_NAME} (updated)"
else
  aws lambda create-function \
    --function-name "$LAMBDA_NAME" --runtime nodejs20.x --handler index.handler \
    --role "$ROLE_ARN" --zip-file fileb://function.zip \
    --timeout 900 --memory-size 512 \
    --environment "Variables=${ENV_VARS}" --output text >/dev/null
  echo "✓ Lambda: ${LAMBDA_NAME} (created)"
fi
rm -rf function.zip node_modules
ANALYZER_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${LAMBDA_NAME}"

# ─── EventBridge: every TERMINAL workflow outcome → ANALYZE ──────────────────
# TEAM-3755 F5: the rule listed only workflow.complete, so the TEAM-3747 D2
# honest-close outcomes (closeWorkflowBlocked publishes workflow.deploy_blocked /
# workflow.static_ci_only instead of a fake "complete") never triggered auto
# analysis — exactly the runs most worth analyzing were the only ones silently
# skipped. The analyzer already handles them: it keys off source +
# detail.workflowId, and its TERMINAL_PHASES set carries both phases.
aws events put-rule \
  --name "agentcore-hub-workflow-analyzer-trigger" \
  --event-pattern '{"source":["agentcore-hub.orchestrator"],"detail-type":["workflow.complete","workflow.deploy_blocked","workflow.static_ci_only"]}' \
  --state ENABLED --output text >/dev/null

aws events put-targets --rule "agentcore-hub-workflow-analyzer-trigger" \
  --targets "Id=workflow-analyzer,Arn=${ANALYZER_ARN}" --output text >/dev/null

aws lambda add-permission \
  --function-name "$LAMBDA_NAME" --statement-id wm-complete-trigger \
  --action lambda:InvokeFunction --principal events.amazonaws.com \
  --source-arn "arn:aws:events:${AWS_REGION}:${ACCOUNT_ID}:rule/agentcore-hub-workflow-analyzer-trigger" \
  --output text 2>/dev/null || true
echo "✓ Rule: workflow.complete / deploy_blocked / static_ci_only → ANALYZE"

# ─── EventBridge: rate(5 minutes) → WATCH scan ───────────────────────────────
aws events put-rule \
  --name "agentcore-hub-workflow-watch-schedule" \
  --schedule-expression "rate(5 minutes)" \
  --state ENABLED --output text >/dev/null

aws events put-targets --rule "agentcore-hub-workflow-watch-schedule" \
  --targets "Id=workflow-watch,Arn=${ANALYZER_ARN},Input='{\"action\":\"watch\"}'" \
  --output text >/dev/null

aws lambda add-permission \
  --function-name "$LAMBDA_NAME" --statement-id wm-watch-schedule \
  --action lambda:InvokeFunction --principal events.amazonaws.com \
  --source-arn "arn:aws:events:${AWS_REGION}:${ACCOUNT_ID}:rule/agentcore-hub-workflow-watch-schedule" \
  --output text 2>/dev/null || true
echo "✓ Rule: rate(5 minutes) → WATCH scan"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ✓ Done"
echo ""
echo "  complete → analyzer Lambda → harness ANALYZE → analyses table + S3"
echo "  every 5m → analyzer Lambda → stale runs → harness WATCH → intervene"
echo "  UI chat  → /api/workflow-manager/chat → harness CHAT"
echo "═══════════════════════════════════════════════════════════"
