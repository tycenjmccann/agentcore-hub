#!/usr/bin/env bash
# Idempotent dispatcher for AgentCore Hub modules.
# Knows the script order and required env vars per module.
# Underlying scripts already exist in deploy/ and scripts/ — this only sequences them.
#
# Usage: run-module.sh <core|builder|workflow|evaluations>
#
# Reads from environment:
#   AWS_PROFILE, AWS_REGION (required)
#   TICKET_PROVIDER ("dynamodb" or "jira") — required for workflow

set -euo pipefail

MODULE="${1:-}"
if [[ -z "$MODULE" ]]; then
  echo "Usage: $0 <core|builder|workflow|evaluations>" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

# Load values written by apply-env.sh (TICKET_PROVIDER, BUILDER_AGENT_ID, etc.)
# so the deploy steps below see them without the parent shell having to export.
if [[ -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

: "${AWS_REGION:?AWS_REGION must be set}"
: "${AWS_PROFILE:=default}"
export AWS_PROFILE AWS_REGION

echo "── Running module: $MODULE ────────────────────────────────"

case "$MODULE" in
  core)
    if [[ ! -d node_modules ]]; then
      echo "→ npm install"
      npm install
    else
      echo "→ node_modules already present, skipping npm install"
    fi
    echo "→ Verifying AWS credentials"
    aws sts get-caller-identity --output text >/dev/null
    ;;

  builder)
    echo "→ node deploy/setup-builder-agent.mjs"
    # Capture stdout so we can extract BUILDER_AGENT_ID and append it to .env.local.
    # The Build API reads process.env.BUILDER_AGENT_ID; without persisting it the
    # /build page returns 503 even after a successful deploy.
    BUILDER_LOG=$(mktemp)
    trap 'rm -f "$BUILDER_LOG"' EXIT
    node deploy/setup-builder-agent.mjs | tee "$BUILDER_LOG"
    BUILDER_ID=$(grep -E '^[[:space:]]*BUILDER_AGENT_ID=' "$BUILDER_LOG" | head -1 | sed -E 's/^[[:space:]]*BUILDER_AGENT_ID=//' | tr -d '[:space:]')
    if [[ -n "$BUILDER_ID" ]]; then
      if grep -q '^BUILDER_AGENT_ID=' .env.local 2>/dev/null; then
        # macOS sed compat: write through a temp file
        sed "s|^BUILDER_AGENT_ID=.*|BUILDER_AGENT_ID=$BUILDER_ID|" .env.local > .env.local.tmp && mv .env.local.tmp .env.local
      else
        echo "BUILDER_AGENT_ID=$BUILDER_ID" >> .env.local
      fi
      chmod 600 .env.local
      echo "→ Persisted BUILDER_AGENT_ID=$BUILDER_ID to .env.local"
    else
      echo "✗ Could not parse BUILDER_AGENT_ID from setup-builder-agent.mjs output" >&2
      echo "  /build will return 503 until BUILDER_AGENT_ID is set in .env.local" >&2
      exit 1
    fi
    ;;

  workflow)
    : "${TICKET_PROVIDER:?TICKET_PROVIDER must be 'dynamodb' or 'jira'}"

    if [[ "$TICKET_PROVIDER" == "dynamodb" ]]; then
      echo "→ ./scripts/create-dynamodb-tables.sh --with-tickets"
      ./scripts/create-dynamodb-tables.sh --with-tickets
    else
      echo "→ ./scripts/create-dynamodb-tables.sh"
      ./scripts/create-dynamodb-tables.sh
    fi

    ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    export AWS_ACCOUNT_ID="$ACCOUNT_ID"

    echo "→ Ensuring artifact bucket exists"
    BUCKET="agentcore-hub-artifacts-${ACCOUNT_ID}-${AWS_REGION}"
    if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
      echo "  Bucket $BUCKET already exists, skipping"
    else
      aws s3 mb "s3://$BUCKET" --region "$AWS_REGION"
    fi

    if [[ -d blueprints ]]; then
      echo "→ Syncing blueprints/ → s3://$BUCKET/blueprints/"
      aws s3 cp blueprints/ "s3://$BUCKET/blueprints/" --recursive --exclude "*" --include "*.md" --region "$AWS_REGION"
    fi

    echo "→ source deploy/setup-runtime-role.sh"
    # Source (not bash) so AGENTCORE_ROLE_ARN survives into this shell and the
    # subshell calls below — and gets persisted to .env.local for re-runs.
    # shellcheck disable=SC1091
    source deploy/setup-runtime-role.sh
    : "${AGENTCORE_ROLE_ARN:?setup-runtime-role.sh did not export AGENTCORE_ROLE_ARN}"
    if grep -q '^AGENTCORE_ROLE_ARN=' .env.local 2>/dev/null; then
      sed "s|^AGENTCORE_ROLE_ARN=.*|AGENTCORE_ROLE_ARN=\"$AGENTCORE_ROLE_ARN\"|" .env.local > .env.local.tmp && mv .env.local.tmp .env.local
    else
      echo "AGENTCORE_ROLE_ARN=\"$AGENTCORE_ROLE_ARN\"" >> .env.local
    fi
    chmod 600 .env.local
    echo "→ Persisted AGENTCORE_ROLE_ARN to .env.local"
    export AGENTCORE_ROLE_ARN

    echo "→ source deploy/setup-lambda-role.sh"
    # Same source-not-bash pattern — orchestrator/deploy.sh and
    # workflow-output/deploy.sh both read $LAMBDA_ROLE_ARN via deploy/config.sh.
    # shellcheck disable=SC1091
    source deploy/setup-lambda-role.sh
    : "${LAMBDA_ROLE_ARN:?setup-lambda-role.sh did not export LAMBDA_ROLE_ARN}"
    if grep -q '^LAMBDA_ROLE_ARN=' .env.local 2>/dev/null; then
      sed "s|^LAMBDA_ROLE_ARN=.*|LAMBDA_ROLE_ARN=\"$LAMBDA_ROLE_ARN\"|" .env.local > .env.local.tmp && mv .env.local.tmp .env.local
    else
      echo "LAMBDA_ROLE_ARN=\"$LAMBDA_ROLE_ARN\"" >> .env.local
    fi
    chmod 600 .env.local
    echo "→ Persisted LAMBDA_ROLE_ARN to .env.local"
    export LAMBDA_ROLE_ARN

    echo "→ node deploy/setup-tickets-lambda.mjs"
    node deploy/setup-tickets-lambda.mjs

    echo "→ deploy/runtime-agent/build-and-push.sh"
    (cd deploy/runtime-agent && ./build-and-push.sh)

    : "${WORKFLOW_RUNTIME_COUNT:=1}"
    export WORKFLOW_RUNTIME_COUNT
    echo "→ deploy/runtime-agent/deploy-topology.sh (count=$WORKFLOW_RUNTIME_COUNT)"
    (cd deploy/runtime-agent && ./deploy-topology.sh)

    echo "→ lambda/orchestrator/deploy.sh"
    ./lambda/orchestrator/deploy.sh

    echo "→ lambda/workflow-output/deploy.sh"
    ./lambda/workflow-output/deploy.sh

    echo "→ deploy/runtime-agent/setup-healthcheck.sh (S3 fixtures for smoke test)"
    # Upload test fixtures so verify-fleet-invoke.py's S3 tool tests pass on
    # first run. Without this, 4 tests fail with 404s on missing fixtures.
    (cd deploy/runtime-agent && ./setup-healthcheck.sh --region "$AWS_REGION" --bucket "$BUCKET") || {
      echo "⚠ setup-healthcheck.sh failed (non-fatal) — smoke test fixture upload skipped"
      echo "  Run manually: (cd deploy/runtime-agent && ./setup-healthcheck.sh)"
    }
    ;;

  evaluations)
    # All eval Lambdas run as agentcore-hub-lambda-role. Workflow already
    # creates it, but evaluations may be re-run on a workflow-less account
    # (e.g. user re-runs /setup later) — make sure the role exists either way.
    echo "→ source deploy/setup-lambda-role.sh"
    # shellcheck disable=SC1091
    source deploy/setup-lambda-role.sh
    : "${LAMBDA_ROLE_ARN:?setup-lambda-role.sh did not export LAMBDA_ROLE_ARN}"
    if grep -q '^LAMBDA_ROLE_ARN=' .env.local 2>/dev/null; then
      sed "s|^LAMBDA_ROLE_ARN=.*|LAMBDA_ROLE_ARN=\"$LAMBDA_ROLE_ARN\"|" .env.local > .env.local.tmp && mv .env.local.tmp .env.local
    else
      echo "LAMBDA_ROLE_ARN=\"$LAMBDA_ROLE_ARN\"" >> .env.local
    fi
    chmod 600 .env.local
    echo "→ Persisted LAMBDA_ROLE_ARN to .env.local"
    export LAMBDA_ROLE_ARN

    # Seed agentcore-hub-eval-config DDB table (one row per agent)
    echo "→ deploy/continuous-improvement/deploy-all.sh"
    bash deploy/continuous-improvement/deploy-all.sh

    # Attach AgentCore online evaluations to each runtime
    echo "→ deploy/evaluations/setup-evaluations.sh"
    bash deploy/evaluations/setup-evaluations.sh

    # Deploy continuous-improvement Lambdas (eval-packager + prd-submitter).
    # prd-submitter needs DEPLOYMENT_URL — deploy.sh now tolerates a missing
    # value and the user can re-run after App Runner.
    echo "→ deploy/continuous-improvement/deploy.sh"
    bash deploy/continuous-improvement/deploy.sh

    # Deploy token-aggregator Lambda + CW Logs subscription filters + weekly
    # reset cron. Listed in docs/MODULES.md as part of Evaluations.
    echo "→ deploy/continuous-improvement/deploy-token-aggregator.sh"
    bash deploy/continuous-improvement/deploy-token-aggregator.sh
    ;;

  *)
    echo "Unknown module: $MODULE" >&2
    echo "Valid: core, builder, workflow, evaluations" >&2
    exit 2
    ;;
esac

echo "── Module $MODULE: deploy steps complete ───────────────────"
