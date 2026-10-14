#!/bin/bash
# ─── Runtime env defaults (TEAM-6069) ─────────────────────────────────────────
# The ONE home of the DynamoDB table names and tool-Lambda names the fleet
# runtime (deploy/runtime-agent/main.py) reads. Rename a table here, never in a
# deploy script.
#
# Sourced by deploy/config.sh (tables) AND by deploy/runtime-agent/deploy-one.sh
# (tables + resolve_runtime_lambda_names). deploy-one.sh cannot source config.sh
# itself: config.sh calls STS, exits on the EXPECTED_ACCOUNT_ID guard, and
# defaults AGENTCORE_ROLE_ARN (which makes deploy-fleet.sh skip role creation).
# Before this file, deploy-fleet.sh / deploy-topology.sh reached deploy-one.sh
# without config.sh, so a rename made there never reached fleet runtimes.
#
# Contract: ZERO side effects. No set -e/-u changes, no exit, no aws, no
# .env.local loading, safe to source twice. Explicit env always wins — every
# name is ${VAR:-default}.
# ───────────────────────────────────────────────────────────────────────────────

# DynamoDB tables (also exported by config.sh — it sources this file).
export EVENTS_TABLE="${EVENTS_TABLE:-agentcore-hub-events}"
export WORKFLOWS_TABLE="${WORKFLOWS_TABLE:-agentcore-hub-workflows}"
# DynamoDB table the fleet records workflow coding sessions into (Cloud Code tab reads it).
export CLOUD_CODE_TABLE="${CLOUD_CODE_TABLE:-agentcore-hub-cloud-code-sessions}"

# Tool-Lambda names — runtime-only, so config.sh deliberately does NOT call this:
# an exported PIPELINE_TOOLS_LAMBDA would leak into setup-tickets-lambda.mjs,
# where unset means "no gate probe". TICKET_TOOLS_LAMBDA follows the same rule as
# setup-tickets-lambda.mjs (the function actually deployed),
# lambda/orchestrator/deploy.sh and lambda/workflow-output/index.mjs; it is only
# derived when unset, and TICKET_PROVIDER itself is never exported from here.
resolve_runtime_lambda_names() {
  local provider="${TICKET_PROVIDER:-jira}"
  if [ -z "${TICKET_TOOLS_LAMBDA:-}" ]; then
    if [ "$provider" = "jira" ]; then
      TICKET_TOOLS_LAMBDA="agentcore-hub-jira"
    else
      TICKET_TOOLS_LAMBDA="agentcore-hub-tickets"
    fi
  fi
  export TICKET_TOOLS_LAMBDA
  export WORKFLOW_OUTPUT_LAMBDA="${WORKFLOW_OUTPUT_LAMBDA:-agentcore-hub-workflow-output}"
  export PIPELINE_TOOLS_LAMBDA="${PIPELINE_TOOLS_LAMBDA:-agentcore-hub-pipeline-tools}"
}
