#!/bin/bash
#
# setup-runtime-role.sh — Create the IAM execution role for AgentCore Runtime agents
#
# This role is assumed by the 14 fleet agents at runtime. It includes permissions
# for all built-in Strands agent tools (code interpreter, browser, memory, gateway,
# knowledge bases) plus observability (CloudWatch Logs, X-Ray, metrics).
#
# Trust: bedrock-agentcore.amazonaws.com
#
# Usage:
#   source deploy/setup-runtime-role.sh
#   # Sets AGENTCORE_ROLE_ARN for use by deploy-fleet.sh
#
# If the role already exists this script ensures the trust policy + every inline
# policy is up-to-date and exports the ARN. Idempotent.

set -e

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ROLE_NAME="agentcore-hub-agentcore-role"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

# Trust policy — AgentCore can assume this role
TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "bedrock-agentcore.amazonaws.com" },
    "Action": "sts:AssumeRole",
    "Condition": {
      "StringEquals": { "aws:SourceAccount": "${ACCOUNT_ID}" },
      "ArnLike": { "aws:SourceArn": "arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:*" }
    }
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
    --description "Execution role for AgentCore Hub fleet runtime agents (all built-in tools)" \
    --output text > /dev/null
  echo "   ✓ Role created"
fi

# ─── Managed Policy ───────────────────────────────────────────────────────────
aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn "arn:aws:iam::aws:policy/BedrockAgentCoreFullAccess"
echo "   ✓ Attached BedrockAgentCoreFullAccess"

# ─── Observability (CloudWatch Logs + X-Ray + Metrics) ────────────────────────
# Required per: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-permissions.html
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "Observability" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"LogsCreateGroup\",
        \"Effect\": \"Allow\",
        \"Action\": [\"logs:DescribeLogStreams\", \"logs:CreateLogGroup\"],
        \"Resource\": [\"arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/runtimes/*\"]
      },
      {
        \"Sid\": \"LogsDescribeGroups\",
        \"Effect\": \"Allow\",
        \"Action\": [\"logs:DescribeLogGroups\"],
        \"Resource\": [\"arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:*\"]
      },
      {
        \"Sid\": \"LogsWrite\",
        \"Effect\": \"Allow\",
        \"Action\": [\"logs:CreateLogStream\", \"logs:PutLogEvents\"],
        \"Resource\": [\"arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*\"]
      },
      {
        \"Sid\": \"XRay\",
        \"Effect\": \"Allow\",
        \"Action\": [\"xray:PutTraceSegments\", \"xray:PutTelemetryRecords\", \"xray:GetSamplingRules\", \"xray:GetSamplingTargets\"],
        \"Resource\": [\"*\"]
      },
      {
        \"Sid\": \"Metrics\",
        \"Effect\": \"Allow\",
        \"Action\": \"cloudwatch:PutMetricData\",
        \"Resource\": \"*\",
        \"Condition\": { \"StringEquals\": { \"cloudwatch:namespace\": \"bedrock-agentcore\" } }
      }
    ]
  }"
echo "   ✓ Attached Observability (Logs + X-Ray + Metrics)"

# ─── Bedrock Model Invocation ─────────────────────────────────────────────────
# Claude Code uses bedrock:InvokeModel. The codex tool routes GPT-5.5 through
# Bedrock Mantle (OpenAI-compatible) with a short-term bearer token, which needs
# bedrock-mantle:* and bedrock:CallWithBearerToken (Resource:* — the bearer-token
# actions don't support resource-level scoping).
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "BedrockModelInvoke" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"InvokeModels\",
        \"Effect\": \"Allow\",
        \"Action\": [\"bedrock:InvokeModel\", \"bedrock:InvokeModelWithResponseStream\"],
        \"Resource\": [
          \"arn:aws:bedrock:*::foundation-model/*\",
          \"arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:*\"
        ]
      },
      {
        \"Sid\": \"BedrockMantleForCodex\",
        \"Effect\": \"Allow\",
        \"Action\": [\"bedrock-mantle:*\", \"bedrock:CallWithBearerToken\"],
        \"Resource\": \"*\"
      }
    ]
  }"
echo "   ✓ Attached Bedrock model invoke (+ Mantle for Codex)"

# ─── ECR Pull (container deploy) ─────────────────────────────────────────────
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "ECRPullAccess" \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Sid": "ECRPull",
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchCheckLayerAvailability"
      ],
      "Resource": "*"
    }]
  }'
echo "   ✓ Attached ECR pull access"

# ─── Code Interpreter + Browser (built-in Strands tools) ─────────────────────
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "CodeInterpreterAndBrowser" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"BuiltInSandboxTools\",
      \"Effect\": \"Allow\",
      \"Action\": [
        \"bedrock-agentcore:CreateCodeInterpreter\",
        \"bedrock-agentcore:StartCodeInterpreterSession\",
        \"bedrock-agentcore:InvokeCodeInterpreter\",
        \"bedrock-agentcore:StopCodeInterpreterSession\",
        \"bedrock-agentcore:GetCodeInterpreterSession\",
        \"bedrock-agentcore:ListCodeInterpreterSessions\",
        \"bedrock-agentcore:ListCodeInterpreters\",
        \"bedrock-agentcore:GetCodeInterpreter\",
        \"bedrock-agentcore:DeleteCodeInterpreter\",
        \"bedrock-agentcore:ExecuteCode\",
        \"bedrock-agentcore:ExecuteCommand\",
        \"bedrock-agentcore:InstallPackages\",
        \"bedrock-agentcore:UploadFile\",
        \"bedrock-agentcore:DownloadFile\",
        \"bedrock-agentcore:CreateBrowser\",
        \"bedrock-agentcore:StartBrowserSession\",
        \"bedrock-agentcore:StopBrowserSession\",
        \"bedrock-agentcore:GetBrowserSession\",
        \"bedrock-agentcore:ListBrowserSessions\",
        \"bedrock-agentcore:ListBrowsers\",
        \"bedrock-agentcore:GetBrowser\",
        \"bedrock-agentcore:DeleteBrowser\",
        \"bedrock-agentcore:UpdateBrowserStream\",
        \"bedrock-agentcore:ConnectBrowserAutomationStream\",
        \"bedrock-agentcore:ConnectBrowserLiveViewStream\"
      ],
      \"Resource\": \"*\"
    }]
  }"
echo "   ✓ Attached Code Interpreter + Browser"

# ─── Remote coding runtime (Cloud Code) ──────────────────────────────────────
# Lets fleet personas run claude_code/codex turns on the standalone coding
# runtime (persistent EFS sessions, resumable from the Cloud Code tab).
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "InvokeCodingRuntime" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"InvokeCodingRuntime\",
      \"Effect\": \"Allow\",
      \"Action\": [\"bedrock-agentcore:InvokeAgentRuntime\"],
      \"Resource\": \"arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:runtime/*\"
    }]
  }"
echo "   ✓ Attached coding-runtime invoke access"

# ─── Memory (built-in Strands tool) ──────────────────────────────────────────
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "AgentCoreMemory" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"MemoryDataPlane\",
      \"Effect\": \"Allow\",
      \"Action\": [
        \"bedrock-agentcore:CreateEvent\",
        \"bedrock-agentcore:GetEvent\",
        \"bedrock-agentcore:DeleteEvent\",
        \"bedrock-agentcore:ListEvents\",
        \"bedrock-agentcore:ListActors\",
        \"bedrock-agentcore:ListSessions\",
        \"bedrock-agentcore:GetMemoryRecord\",
        \"bedrock-agentcore:DeleteMemoryRecord\",
        \"bedrock-agentcore:ListMemoryRecords\",
        \"bedrock-agentcore:RetrieveMemoryRecords\",
        \"bedrock-agentcore:BatchCreateMemoryRecords\",
        \"bedrock-agentcore:BatchDeleteMemoryRecords\",
        \"bedrock-agentcore:BatchUpdateMemoryRecords\",
        \"bedrock-agentcore:ListMemoryExtractionJobs\",
        \"bedrock-agentcore:StartMemoryExtractionJob\"
      ],
      \"Resource\": \"arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:memory/*\"
    }]
  }"
echo "   ✓ Attached Memory access"

# ─── Gateway Invoke (built-in Strands tool) ───────────────────────────────────
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "GatewayInvoke" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"InvokeGateway\",
      \"Effect\": \"Allow\",
      \"Action\": \"bedrock-agentcore:InvokeGateway\",
      \"Resource\": \"arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:gateway/*\"
    }]
  }"
echo "   ✓ Attached Gateway invoke"

# ─── Workload Identity + API Key Access (for gateway OAuth/API key tools) ─────
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "WorkloadIdentityAccess" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"WorkloadTokens\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"bedrock-agentcore:GetWorkloadAccessToken\",
          \"bedrock-agentcore:GetWorkloadAccessTokenForJWT\",
          \"bedrock-agentcore:GetWorkloadAccessTokenForUserId\",
          \"bedrock-agentcore:GetResourceApiKey\",
          \"bedrock-agentcore:GetResourceOauth2Token\"
        ],
        \"Resource\": [
          \"arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:token-vault/default\",
          \"arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:token-vault/default/apikeycredentialprovider/*\",
          \"arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:token-vault/default/oauth2credentialprovider/*\",
          \"arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:workload-identity-directory/default\",
          \"arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:workload-identity-directory/default/workload-identity/*\"
        ]
      },
      {
        \"Sid\": \"SecretsForApiKeys\",
        \"Effect\": \"Allow\",
        \"Action\": \"secretsmanager:GetSecretValue\",
        \"Resource\": \"arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:bedrock-agentcore-identity!default/*\"
      }
    ]
  }"
echo "   ✓ Attached Workload Identity + API Key access"

# ─── Knowledge Base Retrieve (Strands `retrieve` tool) ────────────────────────
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "BedrockKnowledgeBaseAccess" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"KBRetrieve\",
      \"Effect\": \"Allow\",
      \"Action\": [\"bedrock:Retrieve\", \"bedrock:RetrieveAndGenerate\"],
      \"Resource\": \"arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:knowledge-base/*\"
    }]
  }"
echo "   ✓ Attached Knowledge Base retrieve"

# ─── Lambda Invoke (for ticket tools) ────────────────────────────────────────
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "LambdaInvoke" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"InvokeLambda\",
      \"Effect\": \"Allow\",
      \"Action\": \"lambda:InvokeFunction\",
      \"Resource\": \"arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:agentcore-hub-*\"
    }]
  }"
echo "   ✓ Attached Lambda invoke"

# ─── S3 Artifacts (for prompts and outputs) ──────────────────────────────────
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "S3ArtifactAccess" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"S3Access\",
      \"Effect\": \"Allow\",
      \"Action\": [\"s3:GetObject\", \"s3:PutObject\", \"s3:ListBucket\"],
      \"Resource\": [
        \"arn:aws:s3:::agentcore-hub-artifacts-${ACCOUNT_ID}-${REGION}\",
        \"arn:aws:s3:::agentcore-hub-artifacts-${ACCOUNT_ID}-${REGION}/*\"
      ]
    }]
  }"
echo "   ✓ Attached S3 artifact access"

# ─── DynamoDB (for events table) ─────────────────────────────────────────────
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "DynamoDBEventsWrite" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"EventsTableWrite\",
      \"Effect\": \"Allow\",
      \"Action\": [\"dynamodb:PutItem\", \"dynamodb:UpdateItem\", \"dynamodb:GetItem\", \"dynamodb:Query\"],
      \"Resource\": \"arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/agentcore-hub-*\"
    }]
  }"
echo "   ✓ Attached DynamoDB events write"

echo ""
echo "   ⏳ Waiting 10s for IAM propagation..."
sleep 10

export AGENTCORE_ROLE_ARN="$ROLE_ARN"
echo "   ✓ AGENTCORE_ROLE_ARN=$ROLE_ARN"
