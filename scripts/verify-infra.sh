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

echo ""
echo "  ───────────────────────────────────"
echo "  Results: $PASS passed, $FAIL failed"
echo ""

if [ $FAIL -gt 0 ]; then
  exit 1
fi
