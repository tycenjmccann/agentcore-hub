#!/bin/bash
# ─── Central Deploy Configuration ─────────────────────────────────────────────
# Source this file from any deploy script: source "$(dirname "$0")/../config.sh"
# All values come from environment or are derived at runtime.
# NEVER hardcode account IDs, URLs, or usernames in deploy scripts.
# ───────────────────────────────────────────────────────────────────────────────

set -e

# Load local, gitignored overrides (DEPLOYMENT_URL, EXPECTED_ACCOUNT_ID, etc.)
# so every deploy script that sources config.sh gets the same env + account
# guard. Never commit .env.local — it holds account-specific values.
_CONFIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
if [ -f "$_CONFIG_DIR/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$_CONFIG_DIR/.env.local"
  set +a
fi

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
export ROUTINES_TABLE="${ROUTINES_TABLE:-agentcore-hub-routines}"

# Routines — scheduled workflows. Runner Lambda + scheduler role ARNs are set by
# lambda/routines-runner/deploy.sh; the schedule group holds all routine schedules.
export ROUTINES_SCHEDULE_GROUP="${ROUTINES_SCHEDULE_GROUP:-agentcore-hub-routines}"
export ROUTINES_RUNNER_ARN="${ROUTINES_RUNNER_ARN:-arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:agentcore-hub-routines-runner}"
export ROUTINES_SCHEDULER_ROLE_ARN="${ROUTINES_SCHEDULER_ROLE_ARN:-arn:aws:iam::${ACCOUNT_ID}:role/agentcore-hub-routines-scheduler-role}"
# DLQ for failed schedule invokes (created by lambda/routines-runner/deploy.sh).
# Must reach the app + harness so schedule.ts / save_routine.py attach it as the
# schedule's DeadLetterConfig — otherwise failed fires vanish.
export ROUTINES_DLQ_ARN="${ROUTINES_DLQ_ARN:-arn:aws:sqs:${AWS_REGION}:${ACCOUNT_ID}:agentcore-hub-routines-dlq}"

# iOS CodeBuild macOS test gateway (SigV4). Injected into the shared runtime as
# IOS_TEST_GATEWAY_URL so the QA / dev / bug-fixer personas can build+run iOS on a
# real macOS runner (ios_test / ios_build_status / list_schemes / get_test_logs).
# WITHOUT this the gateway MCP tools never mount and iOS tickets ship untested.
export IOS_TEST_GATEWAY_URL="${IOS_TEST_GATEWAY_URL:-}"

# Cloud Code — the standalone coding-agent runtime (set after deploy.py prints the ARN)
export CODING_AGENT_RUNTIME_ARN="${CODING_AGENT_RUNTIME_ARN:-}"
# Default MCP gateway wired into Cloud Code CLIs (shared Jira/S3/Skill tools).
export MCP_GATEWAY_URL="${MCP_GATEWAY_URL:-}"
export MCP_GATEWAY_NAME="${MCP_GATEWAY_NAME:-agentis_gateway}"

# Remote coding: which fleet personas delegate claude_code/codex to the coding
# runtime (comma-separated agent ids, or "all"). Empty = every persona runs the
# CLI locally in its own microVM (legacy behavior). Roll out by wave.
export REMOTE_CODING_PERSONAS="${REMOTE_CODING_PERSONAS:-}"
# DynamoDB table the fleet records workflow coding sessions into (Cloud Code tab reads it).
export CLOUD_CODE_TABLE="${CLOUD_CODE_TABLE:-agentcore-hub-cloud-code-sessions}"
# Tenant that owns workflow coding sessions. Multi-tenant deployments must set
# this to their tenant id or the Cloud Code tab (tenant-scoped reads) won't
# list workflow sessions.
export CLOUD_CODE_TENANT_ID="${CLOUD_CODE_TENANT_ID:-default}"

# Validation
if [ -z "$ACCOUNT_ID" ] || [ "$ACCOUNT_ID" = "None" ]; then
  echo "ERROR: Could not determine AWS account ID. Check your credentials." >&2
  exit 1
fi

# Account guard: if EXPECTED_ACCOUNT_ID is set (e.g. in .env / CI), refuse to run
# against any other account. Opt-in and env-driven on purpose — no account ID is
# baked into this repo (it's open source; deployers set their own).
if [ -n "${EXPECTED_ACCOUNT_ID:-}" ] && [ "$ACCOUNT_ID" != "$EXPECTED_ACCOUNT_ID" ]; then
  echo "ERROR: AWS account mismatch. Credentials resolve to $ACCOUNT_ID but" >&2
  echo "       EXPECTED_ACCOUNT_ID=$EXPECTED_ACCOUNT_ID. Wrong profile?" >&2
  echo "       (export AWS_PROFILE=<prod profile> or unset EXPECTED_ACCOUNT_ID to override.)" >&2
  exit 1
fi

if [ -z "$GITHUB_OWNER" ]; then
  echo "WARNING: GITHUB_OWNER not set. Some deploy scripts need this." >&2
fi
