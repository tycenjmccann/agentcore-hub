#!/bin/bash
# ─── Central Deploy Configuration ─────────────────────────────────────────────
# Source this file from any deploy script: source "$(dirname "$0")/../config.sh"
# All values come from environment or are derived at runtime.
# NEVER hardcode account IDs, URLs, or usernames in deploy scripts.
# ───────────────────────────────────────────────────────────────────────────────

set -e

# AWS account (derived from current credentials)
export AWS_REGION="${AWS_REGION:-us-east-1}"
export ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"

# App Runner deployment URL (set after first deploy, used by CI and tests)
export DEPLOYMENT_URL="${DEPLOYMENT_URL:-}"

# GitHub
export GITHUB_OWNER="${GITHUB_OWNER:-}"
export FLEET_REPO_URL="${FLEET_REPO_URL:-https://github.com/${GITHUB_OWNER}/agentcore-hub-fleet.git}"

# IAM roles (convention-based defaults)
export AGENTCORE_ROLE_ARN="${AGENTCORE_ROLE_ARN:-arn:aws:iam::${ACCOUNT_ID}:role/agentcore-hub-agentcore-role}"
export LAMBDA_ROLE_ARN="${LAMBDA_ROLE_ARN:-arn:aws:iam::${ACCOUNT_ID}:role/agentcore-hub-lambda-role}"

# S3 — single bucket shared by App Runner, Lambdas, and runtime agents
export ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-agentcore-hub-artifacts-${ACCOUNT_ID}-${AWS_REGION}}"

# DynamoDB tables
export EVENTS_TABLE="${EVENTS_TABLE:-agentcore-hub-events}"
export TICKETS_TABLE="${TICKETS_TABLE:-agentcore-hub-tickets}"
export WORKFLOWS_TABLE="${WORKFLOWS_TABLE:-agentcore-hub-workflows}"
export CLOUD_CODE_TABLE="${CLOUD_CODE_TABLE:-agentcore-hub-cloud-code-sessions}"

# Cloud Code — the standalone coding-agent runtime (set after deploy.py prints the ARN)
export CODING_AGENT_RUNTIME_ARN="${CODING_AGENT_RUNTIME_ARN:-}"
# Default MCP gateway wired into Cloud Code CLIs (shared Jira/S3/Skill tools).
export MCP_GATEWAY_URL="${MCP_GATEWAY_URL:-}"
export MCP_GATEWAY_NAME="${MCP_GATEWAY_NAME:-agentis_gateway}"

# Validation
if [ -z "$ACCOUNT_ID" ] || [ "$ACCOUNT_ID" = "None" ]; then
  echo "ERROR: Could not determine AWS account ID. Check your credentials." >&2
  exit 1
fi

if [ -z "$GITHUB_OWNER" ]; then
  echo "WARNING: GITHUB_OWNER not set. Some deploy scripts need this." >&2
fi
