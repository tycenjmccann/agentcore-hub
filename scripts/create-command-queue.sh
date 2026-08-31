#!/usr/bin/env bash
# ─── Workflow command queue (R1 — docs/race-condition-study.md) ──────────────
#
# Creates the SQS FIFO queue that serializes all workflow commands per
# workflow (MessageGroupId = workflow root issue key), its DLQ, and the
# event source mapping onto the orchestrator Lambda.
#
# Idempotent: create-queue on an existing FIFO queue with identical
# attributes is a no-op; the mapping is skipped when one already exists.
#
# After running, set on the Next.js app (.env.local → ECS deploy):
#   WORKFLOW_COMMAND_QUEUE_URL=<printed below>
#
# Usage: ./scripts/create-command-queue.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck disable=SC1091
source "$REPO_ROOT/deploy/config.sh"

QUEUE_NAME="agentcore-hub-workflow-commands.fifo"
DLQ_NAME="agentcore-hub-workflow-commands-dlq.fifo"
ORCHESTRATOR_FN="agentcore-hub-orchestrator"

echo "=== DLQ ==="
DLQ_URL=$(aws sqs create-queue \
  --queue-name "$DLQ_NAME" \
  --attributes '{"FifoQueue":"true","MessageRetentionPeriod":"1209600"}' \
  --region "$AWS_REGION" \
  --query 'QueueUrl' --output text)
DLQ_ARN=$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names QueueArn --region "$AWS_REGION" \
  --query 'Attributes.QueueArn' --output text)
echo "  ✓ $DLQ_ARN"

echo "=== Command queue ==="
# VisibilityTimeout must exceed the orchestrator's 60s timeout (6x is the
# Lambda-poller recommendation). maxReceiveCount 5 → poison commands land in
# the DLQ instead of wedging their workflow's group forever.
QUEUE_URL=$(aws sqs create-queue \
  --queue-name "$QUEUE_NAME" \
  --attributes "{
    \"FifoQueue\":\"true\",
    \"ContentBasedDeduplication\":\"false\",
    \"VisibilityTimeout\":\"360\",
    \"MessageRetentionPeriod\":\"345600\",
    \"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":5}\"
  }" \
  --region "$AWS_REGION" \
  --query 'QueueUrl' --output text)
QUEUE_ARN=$(aws sqs get-queue-attributes --queue-url "$QUEUE_URL" \
  --attribute-names QueueArn --region "$AWS_REGION" \
  --query 'Attributes.QueueArn' --output text)
echo "  ✓ $QUEUE_ARN"

echo "=== Orchestrator role: SQS receive permissions ==="
# The event source mapping below is rejected unless the orchestrator's
# execution role can already poll the queue (Receive/Delete/GetQueueAttributes).
LAMBDA_ROLE_NAME="${LAMBDA_ROLE_ARN##*/}"
aws iam put-role-policy \
  --role-name "$LAMBDA_ROLE_NAME" \
  --policy-name "WorkflowCommandQueueConsume" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Action\": [\"sqs:ReceiveMessage\", \"sqs:DeleteMessage\", \"sqs:GetQueueAttributes\"],
      \"Resource\": \"${QUEUE_ARN}\"
    }]
  }"
echo "  ✓ WorkflowCommandQueueConsume on $LAMBDA_ROLE_NAME"

echo "=== Event source mapping → $ORCHESTRATOR_FN ==="
EXISTING=$(aws lambda list-event-source-mappings \
  --function-name "$ORCHESTRATOR_FN" \
  --event-source-arn "$QUEUE_ARN" \
  --region "$AWS_REGION" \
  --query 'EventSourceMappings[0].UUID' --output text 2>/dev/null || true)
if [ -n "$EXISTING" ] && [ "$EXISTING" != "None" ]; then
  echo "  ✓ mapping already exists ($EXISTING)"
else
  # BatchSize 10 + ReportBatchItemFailures: the handler fails the remainder of
  # a batch after the first error, preserving per-group ordering on retry.
  # Retry loop: freshly attached IAM policies take a few seconds to propagate,
  # and create-event-source-mapping validates the role's SQS access up front.
  for attempt in 1 2 3 4 5; do
    if aws lambda create-event-source-mapping \
      --function-name "$ORCHESTRATOR_FN" \
      --event-source-arn "$QUEUE_ARN" \
      --batch-size 10 \
      --function-response-types ReportBatchItemFailures \
      --region "$AWS_REGION" \
      --query 'UUID' --output text; then
      echo "  ✓ mapping created"
      break
    elif [ "$attempt" = 5 ]; then
      echo "  ✗ mapping creation failed after 5 attempts" >&2
      exit 1
    else
      echo "  … role not ready yet (IAM propagation), retrying in 10s"
      sleep 10
    fi
  done
fi

echo ""
echo "Queue URL (set as WORKFLOW_COMMAND_QUEUE_URL on the app):"
echo "  $QUEUE_URL"
echo ""
echo "NOTE: the app task role needs sqs:SendMessage on ${QUEUE_ARN} —"
echo "deploy/ecs-express/deploy.sh grants it via AgentCoreHubRuntimePerms."
