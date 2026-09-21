#!/bin/bash
#
# verify-infra.sh — Check that all required AWS resources exist
#
# Usage:
#   ./scripts/verify-infra.sh [--with-tickets]
#
# Sources .env.local for table names and bucket. Exits 0 if all pass, 1 if any fail.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env.local"

if [ -f "$ENV_FILE" ]; then
  set -a; source "$ENV_FILE"; set +a
fi

REGION="${AWS_REGION:-us-east-1}"
WORKFLOWS_TABLE="${WORKFLOWS_TABLE:-agentcore-hub-workflows}"
EVENTS_TABLE="${EVENTS_TABLE:-agentcore-hub-events}"
TICKETS_TABLE="${TICKETS_TABLE:-agentcore-hub-tickets}"
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-}"
CHECK_TICKETS=false

# Names by CONVENTION, never hardcoded ARNs/account ids — same derivations the
# deploy scripts use (deploy/setup-pipeline-tools-lambda.mjs FUNCTION_NAME/ROLE_NAME,
# deploy/setup-tickets-lambda.mjs ROLE_NAME per TICKET_PROVIDER).
PIPELINE_TOOLS_FUNCTION="${PIPELINE_TOOLS_FUNCTION:-agentcore-hub-pipeline-tools}"
PIPELINE_TOOLS_ROLE="${PIPELINE_TOOLS_ROLE:-${PIPELINE_TOOLS_FUNCTION}-role}"
# Same default as resolveEnv() in deploy/setup-pipeline-tools-lambda.mjs.
RUNTIME_IMAGE_PROJECT="${RUNTIME_IMAGE_PROJECT:-agentcore-hub-runtime-image-deploy}"
if [ "${TICKET_PROVIDER:-dynamodb}" = "jira" ]; then
  TICKETS_ROLE="${TICKETS_ROLE:-AgentCoreHubJiraLambdaRole}"
else
  TICKETS_ROLE="${TICKETS_ROLE:-AgentCoreHubTicketsLambdaRole}"
fi

# Parse args
for arg in "$@"; do
  case $arg in
    --with-tickets) CHECK_TICKETS=true ;;
  esac
done

# If TICKET_PROVIDER=dynamodb, always check tickets table
if [ "${TICKET_PROVIDER}" = "dynamodb" ]; then
  CHECK_TICKETS=true
fi

PASS=0
FAIL=0

check() {
  local name=$1
  local cmd=$2
  if eval "$cmd" > /dev/null 2>&1; then
    echo "  ✓ $name"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $name"
    FAIL=$((FAIL + 1))
  fi
}

# Assert that a DynamoDB table has the expected key schema. Catches tables
# created by hand or by a forked script with the wrong PK/SK — the symptom is
# usually "Query condition missed key schema element" at runtime.
#
# Usage: check_schema <label> <table> <expected-PK> [<expected-SK>]
check_schema() {
  local name=$1
  local table=$2
  local expected_pk=$3
  local expected_sk=${4:-}

  local schema
  schema=$(aws dynamodb describe-table --table-name "$table" --region "$REGION" --query 'Table.KeySchema' --output json 2>/dev/null) || {
    echo "  ✗ $name (table not found)"
    FAIL=$((FAIL + 1))
    return
  }

  local actual_pk
  local actual_sk
  actual_pk=$(echo "$schema" | python3 -c "import sys, json; ks=json.load(sys.stdin); print(next((k['AttributeName'] for k in ks if k['KeyType']=='HASH'), ''))")
  actual_sk=$(echo "$schema" | python3 -c "import sys, json; ks=json.load(sys.stdin); print(next((k['AttributeName'] for k in ks if k['KeyType']=='RANGE'), ''))")

  if [ "$actual_pk" != "$expected_pk" ]; then
    echo "  ✗ $name (PK is '$actual_pk', expected '$expected_pk' — table was created with wrong schema; recreate via scripts/create-dynamodb-tables.sh)"
    FAIL=$((FAIL + 1))
    return
  fi
  if [ "$actual_sk" != "$expected_sk" ]; then
    echo "  ✗ $name (SK is '$actual_sk', expected '$expected_sk' — table was created with wrong schema; recreate via scripts/create-dynamodb-tables.sh)"
    FAIL=$((FAIL + 1))
    return
  fi

  if [ -n "$expected_sk" ]; then
    echo "  ✓ $name (PK=$actual_pk, SK=$actual_sk)"
  else
    echo "  ✓ $name (PK=$actual_pk)"
  fi
  PASS=$((PASS + 1))
}

# Assert that ONE of a role's inline policies grants <action> on a Resource
# matching <resource-ere>, in the SAME statement (a grant split across two
# statements is not a grant). Enumerate with list-role-policies, fetch with
# get-role-policy, and read ONLY the matching statements' Resource strings — no
# secret, env var value or approval token is ever fetched or printed.
#
# Usage: role_policy_grants <role> <action> <resource-ere>
role_policy_grants() {
  local role=$1
  local action=$2
  local resource=$3
  local names
  names=$(aws iam list-role-policies --role-name "$role" --query 'PolicyNames[]' --output text 2>/dev/null) || return 1
  [ -n "$names" ] || return 1
  local policy
  for policy in $names; do
    if aws iam get-role-policy --role-name "$role" --policy-name "$policy" \
      --query "PolicyDocument.Statement[?contains(Action, '$action')].Resource[]" \
      --output text 2>/dev/null | tr '\t' '\n' | grep -qE "$resource"; then
      return 0
    fi
  done
  return 1
}

echo ""
echo "  Verifying AgentCore Hub Infrastructure"
echo "  ═══════════════════════════════════"
echo "  Region: $REGION"
echo ""

# DynamoDB tables — verify schema matches scripts/create-dynamodb-tables.sh
# (a wrong PK/SK silently breaks streaming and other queries at runtime)
check_schema "DynamoDB: $WORKFLOWS_TABLE schema" "$WORKFLOWS_TABLE" "workflowId"
check_schema "DynamoDB: $EVENTS_TABLE schema"    "$EVENTS_TABLE"    "workflowId" "eventId"

if [ "$CHECK_TICKETS" = true ]; then
  check_schema "DynamoDB: $TICKETS_TABLE schema" "$TICKETS_TABLE" "ticketId"
  check "DynamoDB: $TICKETS_TABLE streams enabled" \
    "aws dynamodb describe-table --table-name $TICKETS_TABLE --region $REGION --query 'Table.StreamSpecification.StreamEnabled' --output text | grep -qi true"
fi

# S3 bucket
if [ -n "$ARTIFACT_BUCKET" ]; then
  check "S3: $ARTIFACT_BUCKET" \
    "aws s3api head-bucket --bucket $ARTIFACT_BUCKET --region $REGION"
else
  echo "  - S3: ARTIFACT_BUCKET not set (skipped)"
fi

# Lambda
check "Lambda: agentcore-hub-tickets" \
  "aws lambda get-function --function-name agentcore-hub-tickets --region $REGION"

# The ticket tools read run artifacts (completions/*) out of the artifact bucket.
# The bucket-wide s3:GetObject from deploy/setup-tickets-lambda.mjs already covers
# it — this check exists to catch a HAND-NARROWED policy, which would fail at
# runtime and nowhere else. No new IAM statement is implied; this only asserts.
if [ -n "$ARTIFACT_BUCKET" ]; then
  check "IAM: $TICKETS_ROLE grants s3:GetObject covering completions/*" \
    "role_policy_grants $TICKETS_ROLE s3:GetObject '^arn:aws:s3:::$ARTIFACT_BUCKET/(\*|completions/\*)$'"
else
  echo "  - IAM: ticket tools completions/* read (ARTIFACT_BUCKET not set, skipped)"
fi

# ─── The two approve-once prerequisites (DL-028 / TEAM-4706) ──────────────────
# Both drifted silently in prod and both turn the CONDITIONAL deploy gate back
# into an unconditional one, so every deploy pages a human: no GITHUB_TOKEN on the
# tools Lambda → preapproval reason "merge_binding_unverified"; no s3:PutObject on
# the ship-approvals prefix → reason "record_write_failed". Nothing in either
# check reads a secret: the first queries env var KEYS only, the second reads IAM
# Resource strings only.
if aws lambda get-function-configuration --function-name "$PIPELINE_TOOLS_FUNCTION" --region "$REGION" > /dev/null 2>&1; then
  check "Lambda: $PIPELINE_TOOLS_FUNCTION has a GITHUB_TOKEN env var (name only, value never read)" \
    "aws lambda get-function-configuration --function-name $PIPELINE_TOOLS_FUNCTION --region $REGION --query 'keys(Environment.Variables)' --output text | tr '\t' '\n' | grep -qx GITHUB_TOKEN"

  if [ -n "$ARTIFACT_BUCKET" ]; then
    check "IAM: $PIPELINE_TOOLS_ROLE grants s3:PutObject on pipeline-artifacts/ship-approvals/*" \
      "role_policy_grants $PIPELINE_TOOLS_ROLE s3:PutObject '^arn:aws:s3:::$ARTIFACT_BUCKET/(\*|pipeline-artifacts/(\*|ship-approvals/\*))$'"
  else
    echo "  - IAM: ship-approval record write (ARTIFACT_BUCKET not set, skipped)"
  fi

  # ─── The two TEAM-4866 read grants ──────────────────────────────────────────
  # Both failed SILENTLY before they existed, which is why they are asserted here:
  # a missing runtime-image read answers the release manager
  # project_not_registered when a Deploy_runtime_images build fails, and a missing
  # ListPipelineExecutions makes start_deploy's duplicate check (and get_state's
  # supersededBy) fail open forever with nothing but a CloudWatch warning. Both
  # read IAM Resource strings only — no secret, no token.
  check "IAM: $PIPELINE_TOOLS_ROLE grants codebuild:BatchGetBuilds on the runtime-image deploy project" \
    "role_policy_grants $PIPELINE_TOOLS_ROLE codebuild:BatchGetBuilds 'project/(\*|${RUNTIME_IMAGE_PROJECT}|hub-\*)$'"
  check "IAM: $PIPELINE_TOOLS_ROLE grants codepipeline:ListPipelineExecutions" \
    "role_policy_grants $PIPELINE_TOOLS_ROLE codepipeline:ListPipelineExecutions '^arn:aws:codepipeline:'"
else
  echo "  - Pipeline tools: $PIPELINE_TOOLS_FUNCTION not deployed (pipeline module optional, skipped)"
fi

echo ""
echo "  ───────────────────────────────────"
echo "  Results: $PASS passed, $FAIL failed"
echo ""

if [ $FAIL -gt 0 ]; then
  exit 1
fi
