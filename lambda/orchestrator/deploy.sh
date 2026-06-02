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

# Forward Jira creds when the install is in Jira mode. Both orchestrator and
# agent-invoker call into Jira via lambda/orchestrator/index.mjs (jiraFetch,
# getTicketFromJira, transitionTicket, etc). Without these env vars every
# webhook crashes with `TypeError: fetch failed` on `https:///rest/api/3/...`
# and no workflow ever advances past phase=requirements.
JIRA_VARS=""
if [ "$TICKET_PROVIDER" = "jira" ]; then
  JIRA_VARS=",JIRA_SITE_URL=${JIRA_SITE_URL:-},JIRA_EMAIL=${JIRA_EMAIL:-},JIRA_API_TOKEN=${JIRA_API_TOKEN:-},JIRA_PROJECT_KEY=${JIRA_PROJECT_KEY:-}"
fi

# Forward GitHub creds when present so dev/QA agents can clone, push branches,
# and open PRs against the workspace repo (FLEET_REPO_URL / GITHUB_OWNER/REPO).
GITHUB_VARS=""
if [ -n "${GITHUB_PAT:-}" ]; then
  GITHUB_VARS=",GITHUB_PAT=${GITHUB_PAT},GITHUB_OWNER=${GITHUB_OWNER:-},GITHUB_REPO=${GITHUB_REPO:-}"
fi

ENV_VARS_ORCH="Variables={ARTIFACT_BUCKET=${ARTIFACT_BUCKET},TICKETS_TABLE=${TICKETS_TABLE},WORKFLOWS_TABLE=${WORKFLOWS_TABLE},EVENTS_TABLE=${EVENTS_TABLE},TICKET_PROVIDER=${TICKET_PROVIDER},TICKET_TOOLS_LAMBDA=${TICKET_TOOLS_LAMBDA}${JIRA_VARS}${GITHUB_VARS}}"
ENV_VARS_INVOKER="Variables={ARTIFACT_BUCKET=${ARTIFACT_BUCKET},TICKETS_TABLE=${TICKETS_TABLE},WORKFLOWS_TABLE=${WORKFLOWS_TABLE},EVENTS_TABLE=${EVENTS_TABLE},TICKET_PROVIDER=${TICKET_PROVIDER},TICKET_TOOLS_LAMBDA=${TICKET_TOOLS_LAMBDA}${JIRA_VARS}${GITHUB_VARS}}"
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

# ── DynamoDB Streams trigger: tickets table → orchestrator ────────────────────
# Mirrors the DynamoDBStream event in template.yaml. Idempotent: skips when an
# event source mapping already targets this stream.
echo "=== Wiring orchestrator trigger (DynamoDB Stream) ==="
TICKETS_STREAM_ARN=$(
  aws dynamodb describe-table \
    --table-name "$TICKETS_TABLE" \
    --region "$AWS_REGION" \
    --query 'Table.LatestStreamArn' \
    --output text 2>/dev/null || true
)
if [ -z "$TICKETS_STREAM_ARN" ] || [ "$TICKETS_STREAM_ARN" = "None" ]; then
  echo "  ! $TICKETS_TABLE has no DynamoDB stream — orchestrator will not be triggered."
  echo "    Recreate the table with streams enabled: ./scripts/create-dynamodb-tables.sh --with-tickets"
else
  EXISTING_UUID=$(
    aws lambda list-event-source-mappings \
      --function-name "agentcore-hub-orchestrator" \
      --region "$AWS_REGION" \
      --query "EventSourceMappings[?starts_with(EventSourceArn, \`${TICKETS_STREAM_ARN%/*}\`)].UUID | [0]" \
      --output text 2>/dev/null || true
  )
  if [ -z "$EXISTING_UUID" ] || [ "$EXISTING_UUID" = "None" ]; then
    aws lambda create-event-source-mapping \
      --function-name "agentcore-hub-orchestrator" \
      --event-source-arn "$TICKETS_STREAM_ARN" \
      --starting-position LATEST \
      --batch-size 10 \
      --maximum-batching-window-in-seconds 1 \
      --filter-criteria '{"Filters":[{"Pattern":"{\"eventName\":[\"INSERT\",\"MODIFY\"]}"}]}' \
      --region "$AWS_REGION" \
      --output text --query 'UUID' >/dev/null
    echo "  ✓ Stream → orchestrator mapping created"
  else
    echo "  ✓ Stream → orchestrator mapping already exists ($EXISTING_UUID)"
  fi
fi

# ── EventBridge: orchestrator/agent-invoker events → events-writer Lambda ─────
# Mirrors WorkflowEventsRule + EventsWriterPermission in template.yaml.
echo "=== Wiring events-writer trigger (EventBridge) ==="
RULE_NAME="agentcore-hub-workflow-events"
EVENT_BUS="${EVENT_BUS:-default}"
EVENTS_WRITER_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:agentcore-hub-events-writer"

aws events put-rule \
  --name "$RULE_NAME" \
  --event-bus-name "$EVENT_BUS" \
  --event-pattern '{"source":["agentcore-hub.orchestrator","agentcore-hub.agent-invoker"]}' \
  --state ENABLED \
  --region "$AWS_REGION" \
  --output text --query 'RuleArn' >/dev/null
echo "  ✓ Rule $RULE_NAME upserted on bus $EVENT_BUS"

aws events put-targets \
  --rule "$RULE_NAME" \
  --event-bus-name "$EVENT_BUS" \
  --targets "Id=EventsTableWriter,Arn=$EVENTS_WRITER_ARN" \
  --region "$AWS_REGION" \
  --output text --query 'FailedEntryCount' >/dev/null
echo "  ✓ Target events-writer attached to $RULE_NAME"

RULE_ARN="arn:aws:events:${AWS_REGION}:${ACCOUNT_ID}:rule/${EVENT_BUS}/${RULE_NAME}"
if [ "$EVENT_BUS" = "default" ]; then
  RULE_ARN="arn:aws:events:${AWS_REGION}:${ACCOUNT_ID}:rule/${RULE_NAME}"
fi
PERM_SID="agentcore-hub-events-writer-eventbridge"
if aws lambda get-policy \
     --function-name agentcore-hub-events-writer \
     --region "$AWS_REGION" \
     --output text --query 'Policy' 2>/dev/null | grep -q "\"Sid\":\"$PERM_SID\""; then
  echo "  ✓ events-writer EventBridge invoke permission already present"
else
  aws lambda add-permission \
    --function-name agentcore-hub-events-writer \
    --statement-id "$PERM_SID" \
    --action lambda:InvokeFunction \
    --principal events.amazonaws.com \
    --source-arn "$RULE_ARN" \
    --region "$AWS_REGION" \
    --output text --query 'Statement' >/dev/null
  echo "  ✓ events-writer EventBridge invoke permission added"
fi

rm -f function.zip
echo "=== Done ==="
