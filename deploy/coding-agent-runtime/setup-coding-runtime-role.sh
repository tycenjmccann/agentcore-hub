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
#   # TEAM-4770 operator modes (RUN, don't source):
#   PRINT_POLICY=HubLiveVerifyRead bash .../setup-coding-runtime-role.sh   # JSON to stdout, no writes
#   ONLY_POLICY=HubLiveVerifyRead  bash .../setup-coding-runtime-role.sh   # put that one policy, exit
#
# Idempotent: refreshes trust + inline policies if the role already exists.

set -e

REGION="${AWS_REGION:-us-east-1}"
# AWS_ACCOUNT_ID short-circuits the STS call — same idiom as deploy/config.sh:23.
# It is what lets PRINT_POLICY run fully offline (the regression test parses the
# document with no credentials). Unset → behaviour is unchanged.
ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
ROLE_NAME="agentcore-hub-coding-runtime-role"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
# Derived up here (was inline at ConfigBundleRead) so the policy documents below
# can be built before any IAM call, which PRINT_POLICY depends on.
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-agentcore-hub-artifacts-${ACCOUNT_ID}-${REGION}}"

# ─── HubLiveVerifyRead: read-only live-verify access ─────────────────────────
# patternKey: tooling.coding-role.no-live-verify-access
# analysis:   1789768711403-6rhc
# ticket:     TEAM-4770
#
# This role is the identity that performs operator live-verify (B3b LIVE VERIFY,
# blueprints/qa-checklist.md) for hub-backend changes, so it must be able to READ
# the hub's own tables and run artifacts it is asked to verify — before this it
# had no dynamodb grant at all and no artifact-bucket read outside cloud-code/*,
# which made every hub-backend verification step structurally impossible.
#
# READ-ONLY, deliberately: no PutItem/UpdateItem/DeleteItem/BatchWrite, no
# s3:PutObject, and no secretsmanager (see the GitHub App note at the bottom of
# this file — this role is assumed by the UNTRUSTED coding runtime, and that
# prohibition is unchanged). Verifying a change must never be able to alter the
# evidence it is verifying.
#
# The table/agentcore-hub-* wildcard follows the existing precedent in
# deploy/setup-runtime-role.sh and deploy/ecs-express/deploy.sh.
HUB_LIVE_VERIFY_READ_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "HubTablesReadOnly",
      "Effect": "Allow",
      "Action": ["dynamodb:DescribeTable", "dynamodb:Scan", "dynamodb:Query", "dynamodb:GetItem"],
      "Resource": [
        "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/agentcore-hub-*",
        "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/agentcore-hub-*/index/*"
      ]
    },
    {
      "Sid": "ArtifactBucketReadOnly",
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::${ARTIFACT_BUCKET}/*"]
    },
    {
      "Sid": "ArtifactBucketList",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": ["arn:aws:s3:::${ARTIFACT_BUCKET}"]
    }
  ]
}
EOF
)

# ─── PRINT_POLICY: emit one document as JSON, touch nothing ──────────────────
# Env-var gated, not positional: this script is normally `source`d, where $1
# belongs to the CALLER. The flag form is honoured only when run directly.
# `return || exit` makes the exit correct either way.
PRINT_POLICY="${PRINT_POLICY:-}"
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ] && [ "${1:-}" = "--print-policy" ]; then
  PRINT_POLICY="${2:-HubLiveVerifyRead}"
fi
if [ -n "$PRINT_POLICY" ]; then
  case "$PRINT_POLICY" in
    HubLiveVerifyRead|1) printf '%s\n' "$HUB_LIVE_VERIFY_READ_POLICY" ;;
    *) echo "✗ unknown PRINT_POLICY: $PRINT_POLICY (known: HubLiveVerifyRead)" >&2
       return 2 2>/dev/null || exit 2 ;;
  esac
  return 0 2>/dev/null || exit 0
fi

# ─── ONLY_POLICY: put one inline policy on the EXISTING role, then exit ──────
# TEAM-4770: scripts/si-ledger-handoff.sh applies HubLiveVerifyRead this way so
# a handoff run never re-creates the role, refreshes its trust policy, or
# re-puts the four unrelated documents.
if [ -n "${ONLY_POLICY:-}" ]; then
  case "$ONLY_POLICY" in
    HubLiveVerifyRead)
      aws iam put-role-policy --role-name "$ROLE_NAME" \
        --policy-name "HubLiveVerifyRead" \
        --policy-document "$HUB_LIVE_VERIFY_READ_POLICY"
      echo "   ✓ HubLiveVerifyRead (policy-only; role untouched)"
      ;;
    *) echo "✗ unknown ONLY_POLICY: $ONLY_POLICY (known: HubLiveVerifyRead)" >&2
       return 2 2>/dev/null || exit 2 ;;
  esac
  export CODING_RUNTIME_ROLE_ARN="$ROLE_ARN"
  return 0 2>/dev/null || exit 0
fi

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
# (ARTIFACT_BUCKET is derived at the top of this file — see HubLiveVerifyRead.)
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
          \"arn:aws:s3:::${ARTIFACT_BUCKET}/cloud-code/resume/*\",
          \"arn:aws:s3:::${ARTIFACT_BUCKET}/cloud-code/t/*\"
        ]
      },
      {
        \"Sid\": \"CloudCodeCheckpointWrite\",
        \"Effect\": \"Allow\",
        \"Action\": [\"s3:PutObject\"],
        \"Resource\": [
          \"arn:aws:s3:::${ARTIFACT_BUCKET}/cloud-code/checkpoint/*\",
          \"arn:aws:s3:::${ARTIFACT_BUCKET}/cloud-code/resume/*\",
          \"arn:aws:s3:::${ARTIFACT_BUCKET}/cloud-code/t/*\"
        ]
      },
      {
        \"Sid\": \"CloudCodePurgeDelete\",
        \"Effect\": \"Allow\",
        \"Action\": [\"s3:DeleteObject\"],
        \"Resource\": [
          \"arn:aws:s3:::${ARTIFACT_BUCKET}/cloud-code/resume/*\",
          \"arn:aws:s3:::${ARTIFACT_BUCKET}/cloud-code/checkpoint/*\",
          \"arn:aws:s3:::${ARTIFACT_BUCKET}/cloud-code/t/*\"
        ]
      },
      {
        \"Sid\": \"CloudCodeList\",
        \"Effect\": \"Allow\",
        \"Action\": [\"s3:ListBucket\"],
        \"Resource\": [\"arn:aws:s3:::${ARTIFACT_BUCKET}\"],
        \"Condition\": { \"StringLike\": { \"s3:prefix\": [\"cloud-code/configs/*\", \"cloud-code/resume/*\", \"cloud-code/checkpoint/*\", \"cloud-code/t/*\"] } }
      }
    ]
  }"
echo "   ✓ Config bundle + resume transcript read (s3://${ARTIFACT_BUCKET}/cloud-code/{configs,resume}/*)"

# ─── HubLiveVerifyRead (document + rationale are at the top of this file) ─────
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "HubLiveVerifyRead" \
  --policy-document "$HUB_LIVE_VERIFY_READ_POLICY"
echo "   ✓ HubLiveVerifyRead — read-only hub tables + artifact bucket (live verify)"

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
# Secrets Manager grant here. See docs/pipeline/github-app-auth.md.

echo ""
echo "   ⏳ Waiting 10s for IAM propagation..."
sleep 10

export CODING_RUNTIME_ROLE_ARN="$ROLE_ARN"
echo "   ✓ CODING_RUNTIME_ROLE_ARN=$ROLE_ARN"
