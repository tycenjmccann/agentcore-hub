#!/usr/bin/env bash
# ─── Deploy the ticket-provider probe + replay queue (TEAM-5592) ─────────────
#
# When Jira returns 5xx on report_completion's ticket-side writes, the
# workflow-output Lambda puts those writes on a FIFO replay queue. This script
# wires the other half:
#
#   1. SQS FIFO DLQ   agentcore-hub-ticket-replay-dlq.fifo
#   2. SQS FIFO queue agentcore-hub-ticket-replay.fifo (redrive to the DLQ after
#                     12 receives = 1 hour of healthy probes)
#   3. IAM role       AgentCoreHubTicketProbeRole (its own, narrow role - NOT the
#                     shared agentcore-hub-lambda-role)
#   4. Lambda         agentcore-hub-ticket-provider-probe - same zip as
#                     agentcore-hub-workflow-output, handler ticket-probe.handler
#   5. EventBridge    rate(5 minutes) -> {"source":"ticket-provider-probe"}
#   6. Alarm          alarm.json (3 of 3 failed probes, missing data = breaching)
#
# The probe's authenticated GET /rest/api/3/myself every 5 minutes is also the
# Jira site's keep-alive (it keeps the site out of SUSPENDED_INACTIVITY).
#
# Idempotent: re-running updates what exists and creates what is missing.
# Env/STS-derived via deploy/config.sh - no hardcoded account, region or ARNs.
#
# Prerequisites:
#   - agentcore-hub-jira (TICKET_TOOLS_LAMBDA) is deployed with its JIRA_* env;
#     the probe copies that credential (the token is never echoed).
#   - deploy/setup-lambda-role.sh has been re-run so workflow-output can
#     sqs:SendMessage onto the queue, and lambda/workflow-output/deploy.sh has
#     been re-run so it gets TICKET_REPLAY_QUEUE_URL.
#
# Optional:
#   ALARM_TOPIC_ARN  SNS topic for the alarm's ALARM + OK actions.
#
# Usage:
#   ./deploy/ticket-provider-probe/deploy.sh
#
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck disable=SC1091
source "$REPO_ROOT/deploy/config.sh"

: "${ARTIFACT_BUCKET:?ARTIFACT_BUCKET must be set}"
: "${EVENTS_TABLE:?EVENTS_TABLE must be set}"
: "${TICKET_REPLAY_QUEUE_NAME:?TICKET_REPLAY_QUEUE_NAME must be set (deploy/config.sh)}"
: "${TICKET_REPLAY_QUEUE_URL:?TICKET_REPLAY_QUEUE_URL must be set (deploy/config.sh)}"
: "${TICKET_REPLAY_QUEUE_ARN:?TICKET_REPLAY_QUEUE_ARN must be set (deploy/config.sh)}"

TICKET_TOOLS_LAMBDA="${TICKET_TOOLS_LAMBDA:-agentcore-hub-jira}"
FN_NAME="${TICKET_PROBE_FN_NAME:-agentcore-hub-ticket-provider-probe}"
ROLE_NAME="${TICKET_PROBE_ROLE_NAME:-AgentCoreHubTicketProbeRole}"
RULE_NAME="${TICKET_PROBE_RULE_NAME:-agentcore-hub-ticket-provider-probe}"
RULE_RATE="${TICKET_PROBE_RATE:-rate(5 minutes)}"
DLQ_NAME="${TICKET_REPLAY_DLQ_NAME:-agentcore-hub-ticket-replay-dlq.fifo}"
DLQ_ARN="arn:aws:sqs:${AWS_REGION}:${ACCOUNT_ID}:${DLQ_NAME}"
SRC_DIR="$REPO_ROOT/lambda/workflow-output"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
FN_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${FN_NAME}"
TICKET_TOOLS_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${TICKET_TOOLS_LAMBDA}"
EVENTS_TABLE_ARN="arn:aws:dynamodb:${AWS_REGION}:${ACCOUNT_ID}:table/${EVENTS_TABLE}"

TMP_DIR="$(mktemp -d)"
chmod 700 "$TMP_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "─── Ticket-provider probe ───────────────────────────────"
echo "  Queue:   $TICKET_REPLAY_QUEUE_NAME   (DLQ: $DLQ_NAME)"
echo "  Lambda:  $FN_NAME   rule: $RULE_RATE"
echo "  Role:    $ROLE_NAME   ticket tools: $TICKET_TOOLS_LAMBDA"
echo "  Region:  $AWS_REGION   Account: $ACCOUNT_ID"
echo "─────────────────────────────────────────────────────────"

# ─── 1+2. SQS FIFO DLQ + replay queue ────────────────────────────────────────
# create-queue errors when the queue exists with different attributes, so an
# existing queue gets set-queue-attributes instead (FifoQueue is create-only).
ensure_queue() {
  local name="$1" attrs_file="$2" url
  if url="$(aws sqs get-queue-url --queue-name "$name" --region "$AWS_REGION" \
      --query 'QueueUrl' --output text 2>/dev/null)"; then
    aws sqs set-queue-attributes --queue-url "$url" --region "$AWS_REGION" \
      --attributes "file://$attrs_file"
    echo "  [update] queue $name"
  else
    python3 - "$attrs_file" "$TMP_DIR/create-$name.json" <<'PY'
import json, sys
attrs = json.load(open(sys.argv[1]))
attrs["FifoQueue"] = "true"
json.dump(attrs, open(sys.argv[2], "w"))
PY
    aws sqs create-queue --queue-name "$name" --region "$AWS_REGION" \
      --attributes "file://$TMP_DIR/create-$name.json" --output text >/dev/null
    echo "  [create] queue $name"
  fi
}

cat > "$TMP_DIR/dlq-attrs.json" <<'EOF'
{
  "MessageRetentionPeriod": "1209600",
  "ContentBasedDeduplication": "false"
}
EOF
ensure_queue "$DLQ_NAME" "$TMP_DIR/dlq-attrs.json"

# RedrivePolicy is a JSON string inside the attribute map.
python3 - "$DLQ_ARN" "$TMP_DIR/queue-attrs.json" <<'PY'
import json, sys
json.dump({
    "VisibilityTimeout": "60",
    "MessageRetentionPeriod": "1209600",
    "ContentBasedDeduplication": "false",
    "RedrivePolicy": json.dumps({"deadLetterTargetArn": sys.argv[1], "maxReceiveCount": "12"}),
}, open(sys.argv[2], "w"))
PY
ensure_queue "$TICKET_REPLAY_QUEUE_NAME" "$TMP_DIR/queue-attrs.json"

# ─── 3. IAM role ─────────────────────────────────────────────────────────────
TRUST_POLICY='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "lambda.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}'
ROLE_CREATED=0
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" \
    --policy-document "$TRUST_POLICY" >/dev/null
  echo "  [update] role $ROLE_NAME"
else
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY" \
    --description "AgentCore Hub ticket-provider probe - replays queued ticket writes" \
    --output text >/dev/null
  ROLE_CREATED=1
  echo "  [create] role $ROLE_NAME"
fi
aws iam attach-role-policy --role-name "$ROLE_NAME" \
  --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" >/dev/null

# Drain the queue, publish the availability metric, replay through the ticket
# tools Lambda, restamp completion records / follow-ups / notices, and write the
# journey event. Nothing else: no bucket-wide S3, no other tables.
B="arn:aws:s3:::${ARTIFACT_BUCKET}"
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "TicketProbe" --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    {\"Sid\": \"ReplayQueueDrain\", \"Effect\": \"Allow\",
     \"Action\": [\"sqs:ReceiveMessage\", \"sqs:DeleteMessage\", \"sqs:ChangeMessageVisibility\", \"sqs:GetQueueAttributes\"],
     \"Resource\": \"${TICKET_REPLAY_QUEUE_ARN}\"},
    {\"Sid\": \"ProviderMetric\", \"Effect\": \"Allow\",
     \"Action\": \"cloudwatch:PutMetricData\", \"Resource\": \"*\",
     \"Condition\": {\"StringEquals\": {\"cloudwatch:namespace\": \"AgentCoreHub/TicketProvider\"}}},
    {\"Sid\": \"TicketTools\", \"Effect\": \"Allow\",
     \"Action\": \"lambda:InvokeFunction\", \"Resource\": \"${TICKET_TOOLS_ARN}\"},
    {\"Sid\": \"CompletionObjectsRW\", \"Effect\": \"Allow\",
     \"Action\": [\"s3:GetObject\", \"s3:PutObject\"],
     \"Resource\": [\"${B}/completions/*\", \"${B}/completion-followups/*\", \"${B}/completion-notices/*\", \"${B}/workflows/*/shared/merge-brief.md\"]},
    {\"Sid\": \"CompletionMarkersDelete\", \"Effect\": \"Allow\",
     \"Action\": \"s3:DeleteObject\",
     \"Resource\": [\"${B}/completion-followups/*\", \"${B}/completion-notices/*\"]},
    {\"Sid\": \"BucketList\", \"Effect\": \"Allow\",
     \"Action\": \"s3:ListBucket\", \"Resource\": \"${B}\"},
    {\"Sid\": \"JourneyEvent\", \"Effect\": \"Allow\",
     \"Action\": \"dynamodb:PutItem\", \"Resource\": \"${EVENTS_TABLE_ARN}\"}
  ]
}"
echo "  [put] inline policy TicketProbe"
if [ "$ROLE_CREATED" = "1" ]; then
  echo "  waiting 10s for IAM propagation..."
  sleep 10
fi

# ─── 4a. Jira credential, copied from the ticket tools Lambda ────────────────
# Read straight into variables and written only to a 0600 file in a 0700 temp
# dir that the EXIT trap removes. Never echoed, never on a command line.
jira_var() {
  aws lambda get-function-configuration --function-name "$TICKET_TOOLS_LAMBDA" \
    --region "$AWS_REGION" --query "Environment.Variables.$1" --output text
}
JIRA_SITE_URL="$(jira_var JIRA_SITE_URL)"
JIRA_EMAIL="$(jira_var JIRA_EMAIL)"
JIRA_API_TOKEN="$(jira_var JIRA_API_TOKEN)"
JIRA_PROJECT_KEY="$(jira_var JIRA_PROJECT_KEY)"
for v in JIRA_SITE_URL JIRA_EMAIL JIRA_API_TOKEN JIRA_PROJECT_KEY; do
  if [ -z "${!v}" ] || [ "${!v}" = "None" ]; then
    echo "ERROR: $v is not set on $TICKET_TOOLS_LAMBDA - deploy it first (node deploy/setup-tickets-lambda.mjs)." >&2
    exit 1
  fi
done
echo "  Jira credential: copied from $TICKET_TOOLS_LAMBDA ($JIRA_SITE_URL, project $JIRA_PROJECT_KEY)"

ENV_FILE="$TMP_DIR/env.json"
( umask 077
  ARTIFACT_BUCKET="$ARTIFACT_BUCKET" EVENTS_TABLE="$EVENTS_TABLE" \
  TICKET_TOOLS_LAMBDA="$TICKET_TOOLS_LAMBDA" TICKET_REPLAY_QUEUE_URL="$TICKET_REPLAY_QUEUE_URL" \
  JIRA_SITE_URL="$JIRA_SITE_URL" JIRA_EMAIL="$JIRA_EMAIL" \
  JIRA_API_TOKEN="$JIRA_API_TOKEN" JIRA_PROJECT_KEY="$JIRA_PROJECT_KEY" \
  python3 - "$ENV_FILE" <<'PY'
import json, os, sys
keys = ["ARTIFACT_BUCKET", "EVENTS_TABLE", "TICKET_TOOLS_LAMBDA", "TICKET_REPLAY_QUEUE_URL",
        "JIRA_SITE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_PROJECT_KEY"]
env = {k: os.environ[k] for k in keys}
env["TICKET_PROVIDER"] = "jira"
json.dump({"Variables": env}, open(sys.argv[1], "w"))
PY
)
unset JIRA_API_TOKEN

# ─── 4b. Zip (same contents as lambda/workflow-output/deploy.sh) ─────────────
# Same vendored + pinned node_modules as workflow-output: ticket-probe.mjs
# imports index.mjs, whose top-level imports need them. Abort rather than ship a
# bundle without them (the function would die at init).
echo "=== Creating deployment zip ==="
ZIP="$TMP_DIR/function.zip"
(
  cd "$SRC_DIR"
  npm install --omit=dev --silent >/dev/null 2>&1 || npm install --production --silent >/dev/null 2>&1
  for pkg in @aws-sdk/s3-request-presigner @aws-sdk/client-s3; do
    if [ ! -d "node_modules/$pkg" ]; then
      echo "  ✗ npm install did not produce $pkg - aborting" >&2
      exit 1
    fi
  done
  WANT_S3="$(node -p "require('./package.json').dependencies['@aws-sdk/client-s3']")"
  HAVE_S3="$(node -p "require('./node_modules/@aws-sdk/client-s3/package.json').version")"
  if [ "$WANT_S3" != "$HAVE_S3" ]; then
    echo "  ✗ @aws-sdk/client-s3 installed $HAVE_S3 but package.json pins $WANT_S3 - aborting" >&2
    exit 1
  fi
  if [ ! -f ticket-probe.mjs ]; then
    echo "  ✗ lambda/workflow-output/ticket-probe.mjs is missing - aborting" >&2
    exit 1
  fi
  zip -qr "$ZIP" index.mjs deliverables-lint.mjs s3-conditional.mjs ticket-probe.mjs node_modules
)
echo "  Zip size: $(du -k "$ZIP" | cut -f1) KB"

# ─── 4c. Lambda ──────────────────────────────────────────────────────────────
echo "=== Deploying $FN_NAME ==="
if aws lambda get-function --function-name "$FN_NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FN_NAME" \
    --zip-file "fileb://$ZIP" --region "$AWS_REGION" \
    --output text --query 'FunctionName' >/dev/null
  aws lambda wait function-updated --function-name "$FN_NAME" --region "$AWS_REGION"
  aws lambda update-function-configuration --function-name "$FN_NAME" \
    --handler "ticket-probe.handler" \
    --role "$ROLE_ARN" \
    --timeout 120 \
    --memory-size 256 \
    --environment "file://$ENV_FILE" \
    --region "$AWS_REGION" \
    --output text --query 'FunctionName' >/dev/null
  aws lambda wait function-updated --function-name "$FN_NAME" --region "$AWS_REGION"
  echo "  ✓ $FN_NAME (updated)"
else
  # A freshly created role can take a few seconds before Lambda may assume it.
  for attempt in 1 2 3 4 5 6; do
    if aws lambda create-function --function-name "$FN_NAME" \
        --runtime nodejs22.x \
        --handler "ticket-probe.handler" \
        --role "$ROLE_ARN" \
        --zip-file "fileb://$ZIP" \
        --timeout 120 \
        --memory-size 256 \
        --environment "file://$ENV_FILE" \
        --region "$AWS_REGION" \
        --output text --query 'FunctionName' >/dev/null; then
      break
    fi
    if [ "$attempt" = "6" ]; then
      echo "ERROR: create-function failed" >&2
      exit 1
    fi
    echo "  create-function failed (attempt $attempt) - retrying in 10s"
    sleep 10
  done
  aws lambda wait function-active --function-name "$FN_NAME" --region "$AWS_REGION"
  echo "  ✓ $FN_NAME (created)"
fi

# ─── 5. EventBridge rate(5 minutes) ──────────────────────────────────────────
aws events put-rule --name "$RULE_NAME" --region "$AWS_REGION" \
  --schedule-expression "$RULE_RATE" --state ENABLED \
  --description "Ticket-provider probe: Jira availability metric and replay of queued ticket writes" \
  --output text >/dev/null
RULE_ARN="$(aws events describe-rule --name "$RULE_NAME" --region "$AWS_REGION" --query 'Arn' --output text)"
aws lambda add-permission --function-name "$FN_NAME" --region "$AWS_REGION" \
  --statement-id "${RULE_NAME}-invoke" --action lambda:InvokeFunction \
  --principal events.amazonaws.com --source-arn "$RULE_ARN" --output text >/dev/null 2>&1 \
  || echo "  (invoke permission already present)"
aws events put-targets --rule "$RULE_NAME" --region "$AWS_REGION" \
  --targets "[{\"Id\":\"probe\",\"Arn\":\"$FN_ARN\",\"Input\":\"{\\\"source\\\":\\\"ticket-provider-probe\\\"}\"}]" \
  --output text >/dev/null
echo "  ✓ rule $RULE_NAME ($RULE_RATE)"

# ─── 6. Alarm ────────────────────────────────────────────────────────────────
ALARM_ARGS=(--cli-input-json "file://$SCRIPT_DIR/alarm.json" --region "$AWS_REGION")
if [ -n "${ALARM_TOPIC_ARN:-}" ]; then
  ALARM_ARGS+=(--alarm-actions "$ALARM_TOPIC_ARN" --ok-actions "$ALARM_TOPIC_ARN")
  echo "  alarm actions: $ALARM_TOPIC_ARN"
else
  echo "  alarm actions: none (set ALARM_TOPIC_ARN to notify)"
fi
aws cloudwatch put-metric-alarm "${ALARM_ARGS[@]}"
echo "  ✓ alarm agentcore-hub-ticket-provider-unavailable"

echo ""
echo "OK ticket-provider probe wired. Dry run:"
echo "  aws lambda invoke --function-name $FN_NAME --region $AWS_REGION \\"
echo "    --payload '{\"source\":\"ticket-provider-probe\"}' --cli-binary-format raw-in-base64-out /dev/stdout"
