#!/bin/bash
#
# setup-token-aggregator-role.sh — dedicated IAM role for the token aggregator
#
# The token-aggregator Lambda used to ride the shared agentcore-hub-lambda-role.
# It cannot any more: since TEAM-4995 (DL-033, one model registry) the same
# function also hosts the model registry's maintenance modes — the daily
# {"mode":"reconcile"} rule and the on-demand {"mode":"probe"} invoke — which need
# model discovery (bedrock:ListInferenceProfiles, pricing:GetProducts), a WRITE on
# config/models.json, raw model invoke and a coding-runtime invoke. Putting any of
# that on the shared role would hand the same powers to the seven other Lambdas
# that share it (orchestrator, agent-invoker, events-writer, workflow-output,
# eval-packager, prd-submitter, cost-report) for no reason, so this role exists
# instead. Precedent for a per-function role: lambda/anomaly-watcher/deploy.sh.
#
# All account/region/bucket/runtime values come from deploy/config.sh — nothing
# here is hardcoded.
#
# Usage:
#   ./deploy/setup-token-aggregator-role.sh
#   # then: bash deploy/continuous-improvement/deploy-token-aggregator.sh
#
# Idempotent: re-runs refresh the trust policy and re-put every inline policy.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/config.sh"

REGION="${AWS_REGION}"
ROLE_NAME="agentcore-hub-token-aggregator-role"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
LAMBDA_NAME="agentcore-hub-token-aggregator"
# Per-UTC-day bucket table the aggregation path writes. config.sh does not export
# this one, so keep the same default deploy-token-aggregator.sh uses.
DAILY_TABLE="${EVAL_DAILY_TABLE:-agentcore-hub-eval-daily}"

echo ""
echo "=== Token aggregator IAM role ==="
echo "Region:   ${REGION}"
echo "Account:  ${ACCOUNT_ID}"
echo "Role:     ${ROLE_NAME}"
echo "Bucket:   ${ARTIFACT_BUCKET}"
echo "Table:    ${DAILY_TABLE}"
echo "Coding runtime: ${CODING_AGENT_RUNTIME_ARN:-(unset)}"
echo ""

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

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "   ✓ Role \"$ROLE_NAME\" already exists — refreshing policies"
  aws iam update-assume-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-document "$TRUST_POLICY" >/dev/null
else
  echo "   Creating IAM role: $ROLE_NAME"
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY" \
    --description "Least-privilege role for the agentcore-hub token aggregator and its model-registry modes" \
    --output text >/dev/null
  echo "   ✓ Role created"
fi

# ─── Logs: this function's log group only ────────────────────────────────────
# Deliberately NOT the AWSLambdaBasicExecutionRole managed policy, which grants
# logs:* on every log group in the account.
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "Logs" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"OwnLogGroup\",
      \"Effect\": \"Allow\",
      \"Action\": [\"logs:CreateLogGroup\", \"logs:CreateLogStream\", \"logs:PutLogEvents\"],
      \"Resource\": [
        \"arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/lambda/${LAMBDA_NAME}\",
        \"arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/lambda/${LAMBDA_NAME}:*\"
      ]
    }]
  }" >/dev/null
echo "   ✓ Logs (own log group)"

# ─── DynamoDB: the per-day bucket table ──────────────────────────────────────
# UpdateItem only — every write is an ADD onto one (agentId, day) row. No read
# path: the dashboard reads the table through the app's role, not this one.
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "DailyBucketWrite" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"DailyBuckets\",
      \"Effect\": \"Allow\",
      \"Action\": \"dynamodb:UpdateItem\",
      \"Resource\": \"arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${DAILY_TABLE}\"
    }]
  }" >/dev/null
echo "   ✓ DynamoDB UpdateItem on ${DAILY_TABLE}"

# ─── S3: exactly the registry documents, by key ──────────────────────────────
# config/models.json      — the live registry; the reconcile read-modify-writes it
# config/models.prev.json — the rollback copy, written only when autoAdopt moved a tier
# config/pricing.json     — refreshed rates from the Pricing API
# config/agents.json      — READ only, so validate_registry can check `agents` keys
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "ModelRegistryDocuments" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"RegistryReadWrite\",
        \"Effect\": \"Allow\",
        \"Action\": [\"s3:GetObject\", \"s3:PutObject\"],
        \"Resource\": [
          \"arn:aws:s3:::${ARTIFACT_BUCKET}/config/models.json\",
          \"arn:aws:s3:::${ARTIFACT_BUCKET}/config/models.prev.json\",
          \"arn:aws:s3:::${ARTIFACT_BUCKET}/config/pricing.json\"
        ]
      },
      {
        \"Sid\": \"AgentRosterRead\",
        \"Effect\": \"Allow\",
        \"Action\": \"s3:GetObject\",
        \"Resource\": \"arn:aws:s3:::${ARTIFACT_BUCKET}/config/agents.json\"
      }
    ]
  }" >/dev/null
echo "   ✓ S3 registry documents (models.json, models.prev.json, pricing.json rw; agents.json ro)"

# ─── Model discovery + probe ─────────────────────────────────────────────────
# ModelDiscovery: bedrock:ListInferenceProfiles and pricing:GetProducts support
# no resource scoping at all (neither API takes a resource ARN), so Resource "*"
# is the only expressible form. Both are read-only listings.
#
# ModelProbe: the probe invokes a candidate model once to prove it answers.
# bedrock:InvokeModel covers the Converse call for the anthropic-shaped rows;
# bedrock:CallWithBearerToken is what the presigned bearer token the OpenAI-shaped
# endpoints (Bedrock Runtime /openai/v1, Bedrock Mantle) authenticate with is
# signed for. Resource "*" because a probe's whole point is to reach a model id
# that is not in the catalog yet, so there is no ARN set to enumerate.
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "ModelDiscoveryAndProbe" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"ModelDiscovery\",
        \"Effect\": \"Allow\",
        \"Action\": [\"bedrock:ListInferenceProfiles\", \"pricing:GetProducts\"],
        \"Resource\": \"*\"
      },
      {
        \"Sid\": \"ModelProbe\",
        \"Effect\": \"Allow\",
        \"Action\": [\"bedrock:InvokeModel\", \"bedrock:CallWithBearerToken\"],
        \"Resource\": \"*\"
      }
    ]
  }" >/dev/null
echo "   ✓ Model discovery (ListInferenceProfiles, GetProducts) + probe (InvokeModel, CallWithBearerToken)"

# ─── CLI probe on the coding runtime ─────────────────────────────────────────
# A `cli` probe drives one real coding turn on the coding-agent runtime and then
# reads the file it wrote back through the commands API. BOTH command spellings
# are granted because this repo uses both and the live action name is not settled:
# deploy/setup-runtime-role.sh:~225 grants InvokeAgentRuntimeCommand while
# deploy/ecs-express/deploy.sh:~244 grants InvokeAgentRuntimeCommandShell. The
# release manager confirms which one the account's API actually authorises before
# hand-applying this script; the unused one is inert.
#
# Scoped to the ONE runtime ARN from config.sh. Unset → the statement is skipped
# with a WARNING, never widened to "*": a wildcard here would let this Lambda
# invoke every runtime in the account, including the fleet.
if [ -n "${CODING_AGENT_RUNTIME_ARN:-}" ]; then
  aws iam put-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name "CliProbe" \
    --policy-document "{
      \"Version\": \"2012-10-17\",
      \"Statement\": [{
        \"Sid\": \"CliProbe\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"bedrock-agentcore:InvokeAgentRuntime\",
          \"bedrock-agentcore:InvokeAgentRuntimeCommand\",
          \"bedrock-agentcore:InvokeAgentRuntimeCommandShell\"
        ],
        \"Resource\": [
          \"${CODING_AGENT_RUNTIME_ARN}\",
          \"${CODING_AGENT_RUNTIME_ARN}/runtime-endpoint/*\"
        ]
      }]
    }" >/dev/null
  echo "   ✓ CLI probe on ${CODING_AGENT_RUNTIME_ARN}"
else
  echo "   WARNING: CODING_AGENT_RUNTIME_ARN is unset - CliProbe statement SKIPPED."
  echo "            {\"mode\":\"probe\"} rows with api=cli will fail with AccessDenied."
  echo "            Deploy the coding runtime (deploy/coding-agent-runtime/deploy.py or"
  echo "            deploy-instances.py), then re-run this script."
fi

echo ""
echo "   ⏳ Waiting 10s for IAM propagation..."
sleep 10

echo ""
echo "=== Done ==="
echo "Role: ${ROLE_ARN}"
echo "Next: bash deploy/continuous-improvement/deploy-token-aggregator.sh"
echo ""

export TOKEN_AGGREGATOR_ROLE_ARN="$ROLE_ARN"
