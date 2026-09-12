#!/usr/bin/env bash
#
# deploy.sh — wire the Cloud Code session reaper (stream path + scheduled sweep).
#
# A deleted session is soft-deleted (deletedAt + ttl) by the API. This sets up the
# infra that turns that tombstone into actual backend cleanup, with NO polling:
#
#   1. DynamoDB TTL on `ttl`            → expires the tombstoned row automatically
#   2. DynamoDB Streams (NEW_AND_OLD)   → emits the REMOVE event on expiry
#   3. Reaper Lambda (+ boto3 layer)    → releases the session's compute
#   4. Event-source mapping             → stream → Lambda (fires once per delete)
#   5. S3 lifecycle rule                → backstop: expire orphaned artifacts
#   6. EventBridge rate(15 minutes)     → {"sweep":true}: release compute behind
#                                         FINISHED runs (handler.py docstring)
#
# The Lambda releases compute per the row's runtimeArn: an Instances runtime
# (EC2 + per-session EBS) gets DeleteCapacityProviderSession — that volume bills
# until then; a microVM runtime gets stop + the `purge` action (EFS dir + S3).
# The capacity-provider API needs a boto3 newer than the Lambda runtime bundles,
# so step 3 builds and attaches a boto3 layer.
#
# Idempotent: re-running only applies what's missing. Env/STS-derived — no
# hardcoded account, region, or names.
#
# Usage:
#   source deploy/config.sh
#   export CODING_AGENT_RUNTIME_ARN=arn:aws:bedrock-agentcore:...:runtime/...   # the microVM runtime
#   ./deploy/session-reaper/deploy.sh
#
# CODING_AGENT_RUNTIME_ARN here is where rows WITHOUT a runtimeArn live (rows
# written before the column existed). Keep it on the microVM runtime after a
# cutover to Instances — new rows name their runtime explicitly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../config.sh"

CLOUD_CODE_TABLE="${CLOUD_CODE_TABLE:-agentcore-hub-cloud-code-sessions}"
WORKFLOWS_TABLE="${WORKFLOWS_TABLE:-agentcore-hub-workflows}"
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:?set ARTIFACT_BUCKET (the cloud-code artifact bucket)}"
FN_NAME="${REAPER_FN_NAME:-agentcore-hub-session-reaper}"
ROLE_NAME="${REAPER_ROLE_NAME:-agentcore-hub-session-reaper-role}"
LAYER_NAME="${REAPER_LAYER_NAME:-agentcore-hub-boto3}"
SWEEP_RULE="${REAPER_SWEEP_RULE:-agentcore-hub-session-reaper-sweep}"
SWEEP_RATE="${REAPER_SWEEP_RATE:-rate(15 minutes)}"
# Days an orphaned S3 artifact lingers before the lifecycle rule expires it (the
# backstop for anything the reaper still misses). Resume/checkpoint payloads are
# only needed while a session is live, so this is generous.
ARTIFACT_TTL_DAYS="${ARTIFACT_TTL_DAYS:-7}"

if [ -z "${CODING_AGENT_RUNTIME_ARN:-}" ]; then
  echo "ERROR: CODING_AGENT_RUNTIME_ARN must be set (the reaper invokes it to purge)." >&2
  exit 1
fi

echo "─── Session reaper ──────────────────────────────────────"
echo "  Table:   $CLOUD_CODE_TABLE   (workflows: $WORKFLOWS_TABLE)"
echo "  Bucket:  $ARTIFACT_BUCKET   (artifact TTL: ${ARTIFACT_TTL_DAYS}d)"
echo "  Lambda:  $FN_NAME   sweep: $SWEEP_RATE"
echo "  Region:  $AWS_REGION   Account: $ACCOUNT_ID"
echo "─────────────────────────────────────────────────────────"

# ─── 1. DynamoDB TTL on `ttl` ─────────────────────────────────────────────────
TTL_STATUS="$(aws dynamodb describe-time-to-live --table-name "$CLOUD_CODE_TABLE" \
  --region "$AWS_REGION" --query 'TimeToLiveDescription.TimeToLiveStatus' --output text 2>/dev/null || echo NONE)"
if [ "$TTL_STATUS" = "ENABLED" ] || [ "$TTL_STATUS" = "ENABLING" ]; then
  echo "  [skip] TTL already $TTL_STATUS"
else
  echo "  [enable] TTL on attribute 'ttl'"
  aws dynamodb update-time-to-live --table-name "$CLOUD_CODE_TABLE" --region "$AWS_REGION" \
    --time-to-live-specification "Enabled=true,AttributeName=ttl" --output text >/dev/null
fi

# ─── 2. DynamoDB Streams (NEW_AND_OLD_IMAGES — reaper needs OldImage) ──────────
STREAM_ARN="$(aws dynamodb describe-table --table-name "$CLOUD_CODE_TABLE" --region "$AWS_REGION" \
  --query 'Table.LatestStreamArn' --output text 2>/dev/null || echo None)"
STREAM_VIEW="$(aws dynamodb describe-table --table-name "$CLOUD_CODE_TABLE" --region "$AWS_REGION" \
  --query 'Table.StreamSpecification.StreamViewType' --output text 2>/dev/null || echo None)"
if [ "$STREAM_VIEW" = "NEW_AND_OLD_IMAGES" ] && [ "$STREAM_ARN" != "None" ]; then
  echo "  [skip] stream already on ($STREAM_VIEW)"
else
  echo "  [enable] DynamoDB stream NEW_AND_OLD_IMAGES"
  aws dynamodb update-table --table-name "$CLOUD_CODE_TABLE" --region "$AWS_REGION" \
    --stream-specification "StreamEnabled=true,StreamViewType=NEW_AND_OLD_IMAGES" --output text >/dev/null
  aws dynamodb wait table-exists --table-name "$CLOUD_CODE_TABLE" --region "$AWS_REGION"
  STREAM_ARN="$(aws dynamodb describe-table --table-name "$CLOUD_CODE_TABLE" --region "$AWS_REGION" \
    --query 'Table.LatestStreamArn' --output text)"
fi
echo "  stream: $STREAM_ARN"

# ─── 3. IAM role for the Lambda ───────────────────────────────────────────────
TABLE_ARN="arn:aws:dynamodb:${AWS_REGION}:${ACCOUNT_ID}:table/${CLOUD_CODE_TABLE}"
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "  [skip] role exists"
else
  echo "  [create] role $ROLE_NAME"
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document '{
      "Version":"2012-10-17",
      "Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]
    }' --output text >/dev/null
  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null
fi
# Inline policy: read the stream, classify + invoke + stop runtimes, delete
# capacity-provider sessions, scan/stamp session rows, read workflow phases, purge
# S3. Scoped to this table's stream, this account's runtimes / capacity providers,
# these two tables, and this bucket. (The runtime's own role does the EFS rmtree;
# the Lambda only triggers it via invoke.)
WORKFLOWS_TABLE_ARN="arn:aws:dynamodb:${AWS_REGION}:${ACCOUNT_ID}:table/${WORKFLOWS_TABLE}"
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name reaper --policy-document "{
  \"Version\":\"2012-10-17\",
  \"Statement\":[
    {\"Effect\":\"Allow\",
     \"Action\":[\"dynamodb:GetRecords\",\"dynamodb:GetShardIterator\",\"dynamodb:DescribeStream\",\"dynamodb:ListStreams\"],
     \"Resource\":\"${TABLE_ARN}/stream/*\"},
    {\"Effect\":\"Allow\",
     \"Action\":[\"dynamodb:Scan\",\"dynamodb:UpdateItem\"],
     \"Resource\":\"${TABLE_ARN}\"},
    {\"Effect\":\"Allow\",
     \"Action\":[\"dynamodb:BatchGetItem\",\"dynamodb:GetItem\"],
     \"Resource\":\"${WORKFLOWS_TABLE_ARN}\"},
    {\"Effect\":\"Allow\",
     \"Action\":[\"bedrock-agentcore:InvokeAgentRuntime\",\"bedrock-agentcore:StopRuntimeSession\",\"bedrock-agentcore:GetAgentRuntime\"],
     \"Resource\":\"arn:aws:bedrock-agentcore:${AWS_REGION}:${ACCOUNT_ID}:runtime/*\"},
    {\"Effect\":\"Allow\",
     \"Action\":[\"bedrock-agentcore:DeleteCapacityProviderSession\"],
     \"Resource\":\"arn:aws:bedrock-agentcore:${AWS_REGION}:${ACCOUNT_ID}:capacity-provider/*\"},
    {\"Effect\":\"Allow\",
     \"Action\":[\"s3:ListBucket\"],\"Resource\":\"arn:aws:s3:::${ARTIFACT_BUCKET}\"},
    {\"Effect\":\"Allow\",
     \"Action\":[\"s3:DeleteObject\"],\"Resource\":\"arn:aws:s3:::${ARTIFACT_BUCKET}/*\"}
  ]
}" >/dev/null
echo "  role policy applied"
ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)"

# ─── 3b. boto3 layer (capacity-provider API) ──────────────────────────────────
# The python3.12 runtime's bundled boto3 predates DeleteCapacityProviderSession
# and drops capacityProviderConfiguration from GetAgentRuntime, so the handler
# refuses to run without a newer one. Skip with REAPER_SKIP_LAYER=1 to keep the
# currently attached layer version.
LAYER_ARG=()
if [ -z "${REAPER_SKIP_LAYER:-}" ]; then
  LAYER_DIR="$(mktemp -d)"
  echo "  [build] boto3 layer → $LAYER_NAME"
  python3 -m pip install --quiet --disable-pip-version-check --upgrade \
    --target "$LAYER_DIR/python" "boto3>=1.43.90" >/dev/null
  BOTO_VER="$(python3 -c "import sys; sys.path.insert(0, '$LAYER_DIR/python'); import boto3; print(boto3.__version__)")"
  ( cd "$LAYER_DIR" && find python -name '__pycache__' -prune -exec rm -rf {} + && zip -qr layer.zip python )
  LAYER_VERSION_ARN="$(aws lambda publish-layer-version --layer-name "$LAYER_NAME" --region "$AWS_REGION" \
    --description "boto3 $BOTO_VER for the session reaper (capacity-provider API)" \
    --compatible-runtimes python3.12 --zip-file "fileb://$LAYER_DIR/layer.zip" \
    --query 'LayerVersionArn' --output text)"
  echo "         boto3 $BOTO_VER → $LAYER_VERSION_ARN"
  LAYER_ARG=(--layers "$LAYER_VERSION_ARN")
  rm -rf "$LAYER_DIR"
else
  echo "  [skip] boto3 layer (REAPER_SKIP_LAYER set)"
fi

# ─── 4. Lambda function ───────────────────────────────────────────────────────
# Env: the microVM runtime for legacy rows + both tables. Sweep knobs
# (SWEEP_GRACE_CP_S / SWEEP_GRACE_EFS_S / SWEEP_IDLE_CP_S / SWEEP_MAX_CP /
# SWEEP_MAX_PURGE / SWEEP_DEADLINE_MARGIN_MS) pass through only when set in the
# caller's env.
ENV_VARS="CODING_AGENT_RUNTIME_ARN=$CODING_AGENT_RUNTIME_ARN,CLOUD_CODE_TABLE=$CLOUD_CODE_TABLE,WORKFLOWS_TABLE=$WORKFLOWS_TABLE"
for knob in SWEEP_GRACE_CP_S SWEEP_GRACE_EFS_S SWEEP_IDLE_CP_S SWEEP_MISSING_WORKFLOW_S SWEEP_MAX_CP SWEEP_MAX_PURGE SWEEP_DEADLINE_MARGIN_MS; do
  if [ -n "${!knob:-}" ]; then ENV_VARS+=",${knob}=${!knob}"; fi
done
ZIP="$(mktemp -d)/reaper.zip"
( cd "$SCRIPT_DIR" && zip -q "$ZIP" handler.py )
if aws lambda get-function --function-name "$FN_NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "  [update] Lambda code"
  aws lambda update-function-code --function-name "$FN_NAME" --region "$AWS_REGION" \
    --zip-file "fileb://$ZIP" --output text >/dev/null
  aws lambda wait function-updated --function-name "$FN_NAME" --region "$AWS_REGION"
  aws lambda update-function-configuration --function-name "$FN_NAME" --region "$AWS_REGION" \
    --environment "Variables={$ENV_VARS}" \
    --timeout 900 ${LAYER_ARG[@]+"${LAYER_ARG[@]}"} --output text >/dev/null
  aws lambda wait function-updated --function-name "$FN_NAME" --region "$AWS_REGION"
else
  echo "  [create] Lambda $FN_NAME"
  # IAM role propagation can lag create-function; retry briefly.
  for attempt in 1 2 3 4 5; do
    if aws lambda create-function --function-name "$FN_NAME" --region "$AWS_REGION" \
        --runtime python3.12 --handler handler.handler --role "$ROLE_ARN" \
        --zip-file "fileb://$ZIP" --timeout 900 --memory-size 256 \
        --environment "Variables={$ENV_VARS}" \
        ${LAYER_ARG[@]+"${LAYER_ARG[@]}"} \
        --output text >/dev/null 2>&1; then
      break
    fi
    echo "         role not ready, retry ${attempt}..."; sleep 6
  done
  aws lambda wait function-active --function-name "$FN_NAME" --region "$AWS_REGION"
fi
FN_ARN="$(aws lambda get-function --function-name "$FN_NAME" --region "$AWS_REGION" \
  --query 'Configuration.FunctionArn' --output text)"

# ─── 4b. Event-source mapping: stream → Lambda ────────────────────────────────
# Filter to REMOVE so the Lambda is only invoked on a delete/expiry (not every
# session write). BisectBatchOnFunctionError + retries give per-record retry.
EXISTING_ESM="$(aws lambda list-event-source-mappings --function-name "$FN_NAME" --region "$AWS_REGION" \
  --query "EventSourceMappings[?starts_with(EventSourceArn, '${TABLE_ARN}/stream/')].UUID" --output text 2>/dev/null || echo "")"
if [ -n "$EXISTING_ESM" ] && [ "$EXISTING_ESM" != "None" ]; then
  echo "  [skip] event-source mapping exists ($EXISTING_ESM)"
else
  echo "  [create] event-source mapping (REMOVE only)"
  aws lambda create-event-source-mapping --function-name "$FN_NAME" --region "$AWS_REGION" \
    --event-source-arn "$STREAM_ARN" \
    --starting-position LATEST \
    --batch-size 10 --maximum-retry-attempts 5 --bisect-batch-on-function-error \
    --filter-criteria '{"Filters":[{"Pattern":"{\"eventName\":[\"REMOVE\"]}"}]}' \
    --output text >/dev/null
fi

# ─── 5. S3 lifecycle backstop ─────────────────────────────────────────────────
# NOTE: put-bucket-lifecycle-configuration REPLACES the whole config. Merge with
# any existing rules so we never clobber rules owned by other features.
echo "  [apply] S3 lifecycle: expire cloud-code resume/checkpoint after ${ARTIFACT_TTL_DAYS}d"
EXISTING_RULES="$(aws s3api get-bucket-lifecycle-configuration --bucket "$ARTIFACT_BUCKET" \
  --query 'Rules' --output json 2>/dev/null || echo '[]')"
MERGED="$(python3 - "$EXISTING_RULES" "$ARTIFACT_TTL_DAYS" <<'PY'
import json, sys
rules = json.loads(sys.argv[1])
days = int(sys.argv[2])
# Default-tenant prefixes only. A tenant-wide rule (cloud-code/t/) would also
# expire config bundles under cloud-code/t/<id>/configs/ — S3 prefix filters
# can't express t/*/resume/, so tenant-scoped keys rely on the reaper alone.
ours = {
    "cloud-code-resume-ttl": "cloud-code/resume/",
    "cloud-code-checkpoint-ttl": "cloud-code/checkpoint/",
}
rules = [r for r in rules if r.get("ID") not in ours]
for rid, prefix in ours.items():
    rules.append({"ID": rid, "Status": "Enabled",
                  "Filter": {"Prefix": prefix},
                  "Expiration": {"Days": days}})
print(json.dumps({"Rules": rules}))
PY
)"
aws s3api put-bucket-lifecycle-configuration --bucket "$ARTIFACT_BUCKET" \
  --lifecycle-configuration "$MERGED" >/dev/null

# ─── 6. Scheduled sweep: release compute behind finished runs ─────────────────
echo "  [apply] EventBridge rule $SWEEP_RULE ($SWEEP_RATE) → {\"sweep\":true}"
aws events put-rule --name "$SWEEP_RULE" --region "$AWS_REGION" \
  --schedule-expression "$SWEEP_RATE" --state ENABLED \
  --description "Session reaper sweep: release EBS volumes / EFS dirs behind finished coding sessions" \
  --output text >/dev/null
RULE_ARN="$(aws events describe-rule --name "$SWEEP_RULE" --region "$AWS_REGION" --query 'Arn' --output text)"
aws lambda add-permission --function-name "$FN_NAME" --region "$AWS_REGION" \
  --statement-id "${SWEEP_RULE}-invoke" --action lambda:InvokeFunction \
  --principal events.amazonaws.com --source-arn "$RULE_ARN" --output text >/dev/null 2>&1 \
  || echo "         (invoke permission already present)"
aws events put-targets --rule "$SWEEP_RULE" --region "$AWS_REGION" \
  --targets "[{\"Id\":\"reaper\",\"Arn\":\"$FN_ARN\",\"Input\":\"{\\\"sweep\\\":true}\"}]" \
  --output text >/dev/null

echo ""
echo "OK session reaper wired. Deletes soft-delete → TTL-expiry stream event fires"
echo "   $FN_NAME once per delete; the $SWEEP_RATE sweep releases compute behind"
echo "   finished runs. Dry run of the sweep:"
echo "     aws lambda invoke --function-name $FN_NAME --region $AWS_REGION \\"
echo "       --payload '{\"sweep\":true,\"dry_run\":true}' --cli-binary-format raw-in-base64-out /dev/stdout"
