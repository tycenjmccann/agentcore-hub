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
# TEAM-5033: the hub's own deploy pipeline and the SECOND CodeBuild project its
# Deploy stage runs in parallel (deploy/pipeline/lib/pipeline-stack.ts). Same
# defaults the setup script uses; override for a differently-named deployment.
PIPELINE_NAME="${PIPELINE_NAME:-agentcore-hub-deploy}"
RUNTIME_IMAGE_PROJECT="${RUNTIME_IMAGE_PROJECT:-agentcore-hub-runtime-image-deploy}"
# Model-registry principals (TEAM-4995): the app's ECS task role (same override
# idiom as deploy/connectors/deploy.sh:17) and the token aggregator's own role
# (deploy/setup-token-aggregator-role.sh).
ECS_TASK_ROLE="${ECS_TASK_ROLE_NAME:-agentcore-hub-ecs-task}"
TOKEN_AGGREGATOR_ROLE="${TOKEN_AGGREGATOR_ROLE_NAME:-agentcore-hub-token-aggregator-role}"
# The two LLM-driven principals that must NOT be able to write the registry
# (deploy/setup-runtime-role.sh:22, deploy/setup-lambda-role.sh:33 — same override idiom).
RUNTIME_ROLE="${AGENTCORE_ROLE_NAME:-agentcore-hub-agentcore-role}"
LAMBDA_ROLE="${LAMBDA_ROLE_NAME:-agentcore-hub-lambda-role}"
# simulate-principal-policy needs the account in --policy-source-arn. Derived,
# never hardcoded — AWS_ACCOUNT_ID short-circuits STS (deploy/config.sh:23 idiom).
ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo '')}"
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

# Assert that IAM's own evaluator ALLOWS <action> on <resource> for a role. This
# is the first simulate-principal-policy use in this file, and it answers a
# different question than role_policy_grants above: that helper string-matches one
# inline document's Resource list, so it cannot see a managed policy, a permissions
# boundary or an explicit Deny. Read-only — simulate never calls the action.
#
# Usage: action_allowed <role> <action> [<resource-arn, default *>]
action_allowed() {
  local role=$1
  local action=$2
  local resource=${3:-*}
  [ -n "$ACCOUNT_ID" ] || return 1
  aws iam simulate-principal-policy \
    --policy-source-arn "arn:aws:iam::${ACCOUNT_ID}:role/${role}" \
    --action-names "$action" \
    --resource-arns "$resource" \
    --query 'EvaluationResults[0].EvalDecision' \
    --output text 2>/dev/null | grep -qx "allowed"
}

# The peer of action_allowed: assert IAM's evaluator does NOT allow <action> on
# <resource>. Either denial counts — explicitDeny (a Deny statement, which is what
# DenyRegistryWrite is) or implicitDeny (no Allow reaches it) — because the property
# being verified is "this principal cannot write that key", not which statement says
# so. Read-only; simulate never performs the action.
#
# Usage: action_denied <role> <action> <resource-arn>
action_denied() {
  local role=$1
  local action=$2
  local resource=$3
  [ -n "$ACCOUNT_ID" ] || return 1
  aws iam simulate-principal-policy \
    --policy-source-arn "arn:aws:iam::${ACCOUNT_ID}:role/${role}" \
    --action-names "$action" \
    --resource-arns "$resource" \
    --query 'EvaluationResults[0].EvalDecision' \
    --output text 2>/dev/null | grep -qxE "explicitDeny|implicitDeny"
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

  # TEAM-5033 — the two grants that make the Deploy stage's PARALLEL runtime-image
  # build readable. Both are hand-applied (the setup script is a pipeline handoff),
  # so they drift exactly like the two above. Without the first, get_build_log on
  # any project outside a target's ci/build/deploy trio answers
  # project_discovery_failed; without the second, build_read_not_granted. Either
  # way the release manager loses its ONLY channel to that log (the coding-runtime
  # role is denied codebuild/logs directly) and a failed image roll is
  # undiagnosable. Both read IAM Resource strings only.
  check "IAM: $PIPELINE_TOOLS_ROLE grants codepipeline:GetPipeline on $PIPELINE_NAME" \
    "role_policy_grants $PIPELINE_TOOLS_ROLE codepipeline:GetPipeline '^arn:aws:codepipeline:[^:]*:[^:]*:($PIPELINE_NAME|\*)$'"
  check "IAM: $PIPELINE_TOOLS_ROLE grants codebuild:BatchGetBuilds on $RUNTIME_IMAGE_PROJECT" \
    "role_policy_grants $PIPELINE_TOOLS_ROLE codebuild:BatchGetBuilds '^arn:aws:codebuild:[^:]*:[^:]*:project/($RUNTIME_IMAGE_PROJECT|\*)$'"
else
  echo "  - Pipeline tools: $PIPELINE_TOOLS_FUNCTION not deployed (pipeline module optional, skipped)"
fi

# ─── Model registry prerequisites (TEAM-4995 / DL-033) ────────────────────────
# One document, config/models.json, owns every model id. Three grants make it
# maintainable, and all three are HAND-APPLIED (their scripts are pipeline
# handoffs), so they are exactly the kind of thing that drifts silently: the app
# and the aggregator cannot refresh the catalog without model discovery, and the
# app cannot re-pin a harness onto a new model without UpdateHarness. Each check
# is skipped (not failed) when its role does not exist — the app may be deployed
# without the aggregator and vice versa — and prints the script to run.
if aws iam get-role --role-name "$ECS_TASK_ROLE" >/dev/null 2>&1; then
  check "IAM: $ECS_TASK_ROLE allowed pricing:GetProducts (catalog price refresh)" \
    "action_allowed $ECS_TASK_ROLE pricing:GetProducts"
  check "IAM: $ECS_TASK_ROLE allowed bedrock:ListInferenceProfiles (model discovery)" \
    "action_allowed $ECS_TASK_ROLE bedrock:ListInferenceProfiles"

  # UpdateHarness is granted per harness ARN, never on "*" — so simulate needs a
  # real ARN. Resolve the same harness deploy/ecs-express/deploy.sh scopes first.
  # Paginated lookup (TEAM-5173 r5-F1): `--query ... | [0] --output text` was
  # applied per page and printed "None\n<arn>" on a multi-page account.
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/../deploy/lib/agentcore-lookup.sh"
  WM_HARNESS_ARN=$(AWS_REGION="$REGION" agentcore_harness_field agentcore_hub_workflow_manager arn 2>/dev/null || true)
  if [ -n "$WM_HARNESS_ARN" ]; then
    check "IAM: $ECS_TASK_ROLE allowed bedrock-agentcore:UpdateHarness on agentcore_hub_workflow_manager" \
      "action_allowed $ECS_TASK_ROLE bedrock-agentcore:UpdateHarness $WM_HARNESS_ARN"
  else
    echo "  - WARN IAM: UpdateHarness re-pin (no agentcore_hub_workflow_manager harness listed, skipped)"
  fi
else
  echo "  - IAM: $ECS_TASK_ROLE not found (skipped — hand-apply with ./deploy/ecs-express/deploy.sh)"
fi

if aws iam get-role --role-name "$TOKEN_AGGREGATOR_ROLE" >/dev/null 2>&1; then
  check "IAM: $TOKEN_AGGREGATOR_ROLE allowed bedrock:ListInferenceProfiles (nightly reconcile)" \
    "action_allowed $TOKEN_AGGREGATOR_ROLE bedrock:ListInferenceProfiles"
else
  echo "  - IAM: $TOKEN_AGGREGATOR_ROLE not found (skipped — hand-apply with ./deploy/setup-token-aggregator-role.sh)"
fi

# ─── Who may WRITE config/models.json (TEAM-5009) ─────────────────────────────
# One document decides which model every agent, judge and coding CLI runs on, and
# the two prompt-driven principals hold a bucket-wide s3:PutObject on the artifact
# bucket — workflow-output's S3Storage___write_object even takes the key from the
# agent. So each of their setup scripts carries an explicit DenyRegistryWrite, and
# these checks are what notice if a hand-applied policy loses it: the registry key
# must be DENIED for the fleet runtime and the shared Lambda role, and still
# ALLOWED for the aggregator, which is the machine that legitimately rewrites it.
# A deny that also broke the writer would pass a one-sided check, which is why the
# positive case is asserted next to the two negative ones. Skipped, not failed,
# when the role or ARTIFACT_BUCKET is absent; nothing here calls S3.
if [ -n "$ARTIFACT_BUCKET" ]; then
  REGISTRY_KEY_ARN="arn:aws:s3:::${ARTIFACT_BUCKET}/config/models.json"
  for r in "$RUNTIME_ROLE" "$LAMBDA_ROLE"; do
    if aws iam get-role --role-name "$r" >/dev/null 2>&1; then
      check "IAM: $r DENIED s3:PutObject on config/models.json (DenyRegistryWrite)" \
        "action_denied $r s3:PutObject $REGISTRY_KEY_ARN"
    else
      echo "  - IAM: $r not found (skipped — hand-apply with ./deploy/setup-runtime-role.sh / ./deploy/setup-lambda-role.sh)"
    fi
  done
  if aws iam get-role --role-name "$TOKEN_AGGREGATOR_ROLE" >/dev/null 2>&1; then
    check "IAM: $TOKEN_AGGREGATOR_ROLE allowed s3:PutObject on config/models.json (the one machine writer)" \
      "action_allowed $TOKEN_AGGREGATOR_ROLE s3:PutObject $REGISTRY_KEY_ARN"
  fi
else
  echo "  - IAM: registry-write denials (ARTIFACT_BUCKET not set, skipped)"
fi

echo ""
echo "  ───────────────────────────────────"
echo "  Results: $PASS passed, $FAIL failed"
echo ""

if [ $FAIL -gt 0 ]; then
  exit 1
fi
