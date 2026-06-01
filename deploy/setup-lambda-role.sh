#!/bin/bash
#
# setup-lambda-role.sh — Create the IAM execution role shared by AgentCore Hub Lambdas
#
# This role is assumed by every Lambda in the workflow + evaluations modules:
#   - agentcore-hub-orchestrator        (DDB Streams trigger; routes tickets)
#   - agentcore-hub-agent-invoker       (async; invokes AgentCore runtimes)
#   - agentcore-hub-events-writer       (EventBridge -> events table)
#   - agentcore-hub-workflow-output     (agent-side tool sink)
#   - agentcore-hub-eval-packager       (CW Logs -> S3 batches)
#   - agentcore-hub-token-aggregator    (CW Logs -> token counters)
#   - agentcore-hub-prd-submitter       (S3 PutObject -> workflow API)
#
# Trust: lambda.amazonaws.com
# Source of truth for permissions: lambda/orchestrator/template.yaml
#
# Usage:
#   source deploy/setup-lambda-role.sh
#   # Sets LAMBDA_ROLE_ARN for use by lambda/*/deploy.sh and continuous-improvement/*
#
# If the role already exists this script ensures the trust policy + every inline
# policy is up-to-date and exports the ARN. Idempotent.

set -e

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ROLE_NAME="agentcore-hub-lambda-role"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

# Trust policy — Lambda service can assume this role.
TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "lambda.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
EOF
)

if aws iam get-role --role-name "$ROLE_NAME" > /dev/null 2>&1; then
  echo "   ✓ Role \"$ROLE_NAME\" already exists — refreshing policies"
  # Update trust in case it drifted.
  aws iam update-assume-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-document "$TRUST_POLICY" >/dev/null
else
  echo "   Creating IAM role: $ROLE_NAME"
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY" \
    --description "Execution role for AgentCore Hub workflow + evaluations Lambdas" \
    --output text > /dev/null
  echo "   ✓ Role created"
fi

# ─── Managed policy: basic Lambda execution (CloudWatch Logs) ────────────────
aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" \
  >/dev/null
echo "   ✓ Attached AWSLambdaBasicExecutionRole"

# ─── DynamoDB CRUD on agentcore-hub-* tables ─────────────────────────────────
# Tables touched:
#   agentcore-hub-tickets       (orchestrator, agent-invoker, workflow-output)
#   agentcore-hub-workflows     (orchestrator, agent-invoker)
#   agentcore-hub-events        (orchestrator, events-writer, workflow-output)
#   agentcore-hub-eval-config   (eval-packager, token-aggregator)
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "DynamoDBAccess" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"TablesCRUD\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"dynamodb:GetItem\",
          \"dynamodb:PutItem\",
          \"dynamodb:UpdateItem\",
          \"dynamodb:DeleteItem\",
          \"dynamodb:Query\",
          \"dynamodb:Scan\",
          \"dynamodb:BatchGetItem\",
          \"dynamodb:BatchWriteItem\",
          \"dynamodb:DescribeTable\",
          \"dynamodb:ConditionCheckItem\"
        ],
        \"Resource\": [
          \"arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/agentcore-hub-tickets\",
          \"arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/agentcore-hub-tickets/index/*\",
          \"arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/agentcore-hub-workflows\",
          \"arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/agentcore-hub-workflows/index/*\",
          \"arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/agentcore-hub-events\",
          \"arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/agentcore-hub-events/index/*\",
          \"arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/agentcore-hub-eval-config\",
          \"arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/agentcore-hub-eval-config/index/*\"
        ]
      }
    ]
  }"
echo "   ✓ Attached DynamoDB CRUD (tickets, workflows, events, eval-config)"

# ─── DynamoDB Streams read (orchestrator trigger on tickets) ─────────────────
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "DynamoDBStreamsRead" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"TicketsStreamRead\",
      \"Effect\": \"Allow\",
      \"Action\": [
        \"dynamodb:DescribeStream\",
        \"dynamodb:GetRecords\",
        \"dynamodb:GetShardIterator\",
        \"dynamodb:ListStreams\"
      ],
      \"Resource\": \"arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/agentcore-hub-tickets/stream/*\"
    }]
  }"
echo "   ✓ Attached DynamoDB Streams read (tickets)"

# ─── S3 RW on the artifact bucket ────────────────────────────────────────────
# Bucket name follows the convention in deploy/config.sh:
#   agentcore-hub-artifacts-${ACCOUNT_ID}-${REGION}
ARTIFACT_BUCKET_NAME="agentcore-hub-artifacts-${ACCOUNT_ID}-${REGION}"
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "S3ArtifactAccess" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"BucketList\",
        \"Effect\": \"Allow\",
        \"Action\": [\"s3:ListBucket\", \"s3:GetBucketLocation\"],
        \"Resource\": \"arn:aws:s3:::${ARTIFACT_BUCKET_NAME}\"
      },
      {
        \"Sid\": \"ObjectRW\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"s3:GetObject\",
          \"s3:PutObject\",
          \"s3:DeleteObject\",
          \"s3:GetObjectVersion\"
        ],
        \"Resource\": \"arn:aws:s3:::${ARTIFACT_BUCKET_NAME}/*\"
      }
    ]
  }"
echo "   ✓ Attached S3 RW on ${ARTIFACT_BUCKET_NAME}"

# ─── Lambda Invoke on agentcore-hub-* functions ──────────────────────────────
# Orchestrator invokes agent-invoker + github-mcp. Workflow-output invokes
# the ticket-tools Lambda (agentcore-hub-jira or agentcore-hub-tickets).
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "LambdaInvoke" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"InvokeHubLambdas\",
      \"Effect\": \"Allow\",
      \"Action\": [\"lambda:InvokeFunction\", \"lambda:InvokeAsync\"],
      \"Resource\": \"arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:agentcore-hub-*\"
    }]
  }"
echo "   ✓ Attached Lambda invoke (agentcore-hub-* functions)"

# ─── EventBridge PutEvents on the default bus ────────────────────────────────
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "EventBridgePutEvents" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"PutEventsDefaultBus\",
      \"Effect\": \"Allow\",
      \"Action\": \"events:PutEvents\",
      \"Resource\": \"arn:aws:events:${REGION}:${ACCOUNT_ID}:event-bus/default\"
    }]
  }"
echo "   ✓ Attached EventBridge PutEvents (default bus)"

# ─── Bedrock model + AgentCore runtime invoke ────────────────────────────────
# Mirrors lambda/orchestrator/template.yaml AgentInvokerFunction Statement:
#   bedrock:InvokeModel*, bedrock-agent-runtime:*, bedrock-agentcore:*
# Resource: "*" on these matches the SAM template; the model ARNs and runtime
# IDs are not knowable up front. Scoping is enforced by the action set.
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "BedrockInvoke" \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Sid": "InvokeBedrock",
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock-agent-runtime:InvokeAgent",
        "bedrock-agent-runtime:Retrieve",
        "bedrock-agent-runtime:RetrieveAndGenerate",
        "bedrock-agentcore:InvokeAgentRuntime",
        "bedrock-agentcore:InvokeHarness",
        "bedrock-agentcore:GetHarness",
        "bedrock-agentcore:GetAgentRuntime"
      ],
      "Resource": "*"
    }]
  }'
echo "   ✓ Attached Bedrock invoke (model + agent-runtime + agentcore)"

# ─── CloudWatch Logs subscription filter setup ───────────────────────────────
# Token-aggregator + eval-packager are invoked BY CW Logs subscription filters.
# The Lambda itself does not need logs:PutSubscriptionFilter; that's done by
# deploy scripts running with admin creds. Basic execution role above already
# covers logs:CreateLogGroup / CreateLogStream / PutLogEvents.

echo ""
echo "   ⏳ Waiting 10s for IAM propagation..."
sleep 10

export LAMBDA_ROLE_ARN="$ROLE_ARN"
echo "   ✓ LAMBDA_ROLE_ARN=$ROLE_ARN"
