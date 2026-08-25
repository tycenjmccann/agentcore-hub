#!/bin/bash
#
# setup-coding-runtime-role.sh — IAM execution role for the coding-agent runtime
#
# Assumed by the coding runtime (Claude Code via Bedrock, Codex via Bedrock
# Mantle). Includes observability, ECR pull, and Bedrock + Bedrock Mantle invoke.
#
# All account/region values are STS/env-derived — never hardcoded.
#
# Usage:
#   source deploy/coding-agent-runtime/setup-coding-runtime-role.sh
#   # Exports CODING_RUNTIME_ROLE_ARN for deploy.py
#
# Idempotent: refreshes trust + inline policies if the role already exists.

set -e

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ROLE_NAME="agentcore-hub-coding-runtime-role"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

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
  echo "   ✓ Role \"$ROLE_NAME\" exists — refreshing policies"
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "$TRUST_POLICY" >/dev/null
else
  echo "   Creating IAM role: $ROLE_NAME"
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY" \
    --description "Execution role for the AgentCore Hub multi-CLI coding runtime" \
    --output text > /dev/null
  echo "   ✓ Role created"
fi

# ─── Observability (Logs + X-Ray + Metrics) ──────────────────────────────────
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "Observability" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"LogsGroup\",
        \"Effect\": \"Allow\",
        \"Action\": [\"logs:CreateLogGroup\", \"logs:DescribeLogGroups\", \"logs:DescribeLogStreams\"],
        \"Resource\": [\"arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/*\"]
      },
      {
        \"Sid\": \"LogsStreamWrite\",
        \"Effect\": \"Allow\",
        \"Action\": [\"logs:CreateLogStream\", \"logs:PutLogEvents\"],
        \"Resource\": [\"arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/*:log-stream:*\"]
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
echo "   ✓ Observability"

# ─── Bedrock invoke (Claude via Bedrock, Codex via Bedrock Mantle) ───────────
# Claude Code uses bedrock:InvokeModel. Codex's amazon-bedrock provider routes
# to Bedrock Mantle and signs with SigV4 → it needs bedrock-mantle:* and
# bedrock-mantle:CallWithBearerToken. The bearer-token actions don't support
# resource-level scoping, so they are Resource:*.
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "BedrockInvoke" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"BedrockModels\",
        \"Effect\": \"Allow\",
        \"Action\": [\"bedrock:InvokeModel\", \"bedrock:InvokeModelWithResponseStream\", \"bedrock:ListInferenceProfiles\", \"bedrock:GetFoundationModel\", \"bedrock:ListFoundationModels\", \"bedrock:CallWithBearerToken\"],
        \"Resource\": [\"*\"]
      },
      {
        \"Sid\": \"BedrockMantle\",
        \"Effect\": \"Allow\",
        \"Action\": [\"bedrock-mantle:*\"],
        \"Resource\": [\"*\"]
      },
      {
        \"Sid\": \"CallerIdentity\",
        \"Effect\": \"Allow\",
        \"Action\": [\"sts:GetCallerIdentity\"],
        \"Resource\": [\"*\"]
      }
    ]
  }"
echo "   ✓ Bedrock invoke (Claude + Codex/Mantle)"

# ─── ECR Pull ────────────────────────────────────────────────────────────────
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "ECRPullAccess" \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Sid": "ECRPull",
      "Effect": "Allow",
      "Action": ["ecr:GetAuthorizationToken", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"],
      "Resource": "*"
    }]
  }'
echo "   ✓ ECR pull access"

# ─── S3 read: config bundles + ported resume transcripts ────────────────────
# The app uploads two things under s3://<artifact-bucket>/cloud-code/:
#   configs/<userId>/...  — a user's .claude/.codex config bundle
#   resume/<sessionId>/... — a ported laptop transcript for `claude --resume`
# The runtime fetches both on session start.
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-agentcore-hub-artifacts-${ACCOUNT_ID}-${REGION}}"
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "ConfigBundleRead" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"CloudCodeObjects\",
        \"Effect\": \"Allow\",
        \"Action\": [\"s3:GetObject\"],
        \"Resource\": [
          \"arn:aws:s3:::${ARTIFACT_BUCKET}/cloud-code/configs/*\",
          \"arn:aws:s3:::${ARTIFACT_BUCKET}/cloud-code/resume/*\"
        ]
      },
      {
        \"Sid\": \"CloudCodeCheckpointWrite\",
        \"Effect\": \"Allow\",
        \"Action\": [\"s3:PutObject\"],
        \"Resource\": [
          \"arn:aws:s3:::${ARTIFACT_BUCKET}/cloud-code/checkpoint/*\",
          \"arn:aws:s3:::${ARTIFACT_BUCKET}/cloud-code/resume/*\"
        ]
      },
      {
        \"Sid\": \"CloudCodeList\",
        \"Effect\": \"Allow\",
        \"Action\": [\"s3:ListBucket\"],
        \"Resource\": [\"arn:aws:s3:::${ARTIFACT_BUCKET}\"],
        \"Condition\": { \"StringLike\": { \"s3:prefix\": [\"cloud-code/configs/*\", \"cloud-code/resume/*\"] } }
      }
    ]
  }"
echo "   ✓ Config bundle + resume transcript read (s3://${ARTIFACT_BUCKET}/cloud-code/{configs,resume}/*)"

# ─── EFS mount (persistent code workspace at /mnt/efs) ───────────────────────
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "EFSMount" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"EFSClientAccess\",
        \"Effect\": \"Allow\",
        \"Action\": [\"elasticfilesystem:ClientMount\", \"elasticfilesystem:ClientWrite\", \"elasticfilesystem:ClientRootAccess\"],
        \"Resource\": \"arn:aws:elasticfilesystem:${REGION}:${ACCOUNT_ID}:file-system/*\",
        \"Condition\": { \"ArnLike\": { \"elasticfilesystem:AccessPointArn\": \"arn:aws:elasticfilesystem:${REGION}:${ACCOUNT_ID}:access-point/*\" } }
      },
      {
        \"Sid\": \"EFSDescribe\",
        \"Effect\": \"Allow\",
        \"Action\": [\"elasticfilesystem:DescribeAccessPoints\", \"elasticfilesystem:DescribeMountTargets\", \"elasticfilesystem:DescribeFileSystems\"],
        \"Resource\": [\"arn:aws:elasticfilesystem:${REGION}:${ACCOUNT_ID}:file-system/*\", \"arn:aws:elasticfilesystem:${REGION}:${ACCOUNT_ID}:access-point/*\"]
      }
    ]
  }"
echo "   ✓ EFS mount access"

# ─── GitHub App key: DELIBERATELY NOT GRANTED ────────────────────────────────
# The GitHub App private key (Secrets Manager: cloud-code/github-app) is the
# master credential the GitHub App design keeps AWAY from the microVM. This role
# is assumed by the untrusted coding runtime, so it is intentionally given NO
# secretsmanager:GetSecretValue on that secret. The hub (App Runner / hosting
# role) mints a short-lived, repo-scoped installation token per turn and passes
# THAT in the invoke payload; the agent never sees the key. Do not add a
# Secrets Manager grant here. See docs/github-app-auth.md.

echo ""
echo "   ⏳ Waiting 10s for IAM propagation..."
sleep 10

export CODING_RUNTIME_ROLE_ARN="$ROLE_ARN"
echo "   ✓ CODING_RUNTIME_ROLE_ARN=$ROLE_ARN"
