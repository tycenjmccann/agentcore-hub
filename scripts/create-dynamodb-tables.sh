#!/usr/bin/env bash
# Creates the DynamoDB tables required by AgentCore Hub.
# Run once per account/region. Safe to re-run (will skip existing tables).
#
# Usage:
#   ./scripts/create-dynamodb-tables.sh                      # Creates workflows + events tables
#   ./scripts/create-dynamodb-tables.sh --with-tickets       # Also creates tickets table (for TICKET_PROVIDER=dynamodb)
#
# Tables:
#   agentcore-hub-workflows  — PK: workflowId (S), GSI: epicId-index
#   agentcore-hub-events     — PK: workflowId (S), SK: eventId (S), TTL: ttl
#   agentcore-hub-tickets    — PK: ticketId (S), GSIs: parentId-index, assignee-index (only with --with-tickets)

set -euo pipefail
REGION="${AWS_REGION:-us-east-1}"
WITH_TICKETS=false

for arg in "$@"; do
  case $arg in
    --with-tickets) WITH_TICKETS=true ;;
    *) echo "Unknown argument: $arg"; echo "Usage: $0 [--with-tickets]"; exit 1 ;;
  esac
done

echo "=== Creating DynamoDB tables in $REGION ==="

# ─── agentcore-hub-workflows ───────────────────────────────────────────────────────
echo "Creating agentcore-hub-workflows (PK=workflowId, GSI=epicId-index)..."
aws dynamodb create-table \
  --table-name agentcore-hub-workflows \
  --attribute-definitions \
    AttributeName=workflowId,AttributeType=S \
    AttributeName=epicId,AttributeType=S \
  --key-schema AttributeName=workflowId,KeyType=HASH \
  --global-secondary-indexes '[
    {
      "IndexName": "epicId-index",
      "KeySchema": [{"AttributeName":"epicId","KeyType":"HASH"}],
      "Projection": {"ProjectionType":"ALL"}
    }
  ]' \
  --billing-mode PAY_PER_REQUEST \
  --region "$REGION" 2>&1 || echo "  (table may already exist)"

# ─── agentcore-hub-events ──────────────────────────────────────────────────────────
echo "Creating agentcore-hub-events (PK=workflowId, SK=eventId, TTL=ttl)..."
aws dynamodb create-table \
  --table-name agentcore-hub-events \
  --attribute-definitions \
    AttributeName=workflowId,AttributeType=S \
    AttributeName=eventId,AttributeType=S \
  --key-schema \
    AttributeName=workflowId,KeyType=HASH \
    AttributeName=eventId,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --region "$REGION" 2>&1 || echo "  (table may already exist)"

# Enable TTL on events table
aws dynamodb update-time-to-live \
  --table-name agentcore-hub-events \
  --time-to-live-specification Enabled=true,AttributeName=ttl \
  --region "$REGION" 2>&1 || echo "  (TTL may already be enabled)"

# ─── agentcore-hub-tickets (optional) ─────────────────────────────────────────────
if [ "$WITH_TICKETS" = true ]; then
  echo "Creating agentcore-hub-tickets (PK=ticketId, Stream=NEW_AND_OLD_IMAGES)..."
  aws dynamodb create-table \
    --table-name agentcore-hub-tickets \
    --attribute-definitions \
      AttributeName=ticketId,AttributeType=S \
      AttributeName=parentId,AttributeType=S \
      AttributeName=assignee,AttributeType=S \
    --key-schema AttributeName=ticketId,KeyType=HASH \
    --global-secondary-indexes '[
      {
        "IndexName": "parentId-index",
        "KeySchema": [{"AttributeName":"parentId","KeyType":"HASH"}],
        "Projection": {"ProjectionType":"ALL"}
      },
      {
        "IndexName": "assignee-index",
        "KeySchema": [{"AttributeName":"assignee","KeyType":"HASH"}],
        "Projection": {"ProjectionType":"ALL"}
      }
    ]' \
    --billing-mode PAY_PER_REQUEST \
    --stream-specification StreamEnabled=true,StreamViewType=NEW_AND_OLD_IMAGES \
    --region "$REGION" 2>&1 || echo "  (table may already exist)"
else
  echo "Skipping agentcore-hub-tickets (pass --with-tickets to create it for TICKET_PROVIDER=dynamodb)"
fi

echo ""
echo "=== Done. Verify with: aws dynamodb list-tables --region $REGION ==="
