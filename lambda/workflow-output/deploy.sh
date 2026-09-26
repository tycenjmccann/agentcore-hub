#!/usr/bin/env bash
# ─── Deploy Workflow-Output Lambda ───────────────────────────────────────────
#
# Idempotent: creates the Lambda on first run, updates code + env vars on
# subsequent runs. Reads config from deploy/config.sh.
#
# Function:
#   - agentcore-hub-workflow-output  (invoked by runtime agents to submit
#                                     ticket plans, save design docs, mark
#                                     tickets complete)
#
# Required env vars (from deploy/config.sh):
#   ACCOUNT_ID, AWS_REGION, LAMBDA_ROLE_ARN, ARTIFACT_BUCKET, EVENTS_TABLE,
#   WORKFLOWS_TABLE
# Optional:
#   TICKET_PROVIDER ("jira" | "dynamodb", default "jira")
#   TICKET_TOOLS_LAMBDA (default derived from TICKET_PROVIDER)
#   GITHUB_TOKEN (falls back to GITHUB_PAT) — read-only; verifies that a fix whose
#     ticket says `base_branch: main` really opened its PR against main
#     (TEAM-4752 D3). Absent ⇒ the key is omitted and the check accepts the report
#     while stamping it `unverified`; it never blocks a completion.
#
# Usage:
#   ./lambda/workflow-output/deploy.sh
#
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$SCRIPT_DIR"

# shellcheck disable=SC1091
source "$REPO_ROOT/deploy/config.sh"

: "${LAMBDA_ROLE_ARN:?LAMBDA_ROLE_ARN must be set}"
: "${ARTIFACT_BUCKET:?ARTIFACT_BUCKET must be set}"

TICKET_PROVIDER="${TICKET_PROVIDER:-jira}"
if [ "$TICKET_PROVIDER" = "jira" ]; then
  TICKET_TOOLS_LAMBDA_DEFAULT="agentcore-hub-jira"
else
  TICKET_TOOLS_LAMBDA_DEFAULT="agentcore-hub-tickets"
fi
TICKET_TOOLS_LAMBDA="${TICKET_TOOLS_LAMBDA:-$TICKET_TOOLS_LAMBDA_DEFAULT}"

NAME="agentcore-hub-workflow-output"

echo "=== Creating deployment zip ==="
rm -f function.zip
# @aws-sdk/s3-request-presigner is NOT guaranteed in the nodejs22.x runtime
# bundle, and a missing ESM import crashes the whole function — so vendor it
# (npm install writes node_modules here) and ship it in the zip.
#
# TEAM-5167 R2-06: @aws-sdk/client-s3 is vendored and pinned too (package.json,
# exact version, same release line as the presigner). report_completion's
# create-once claims are PutObject IfNoneMatch/IfMatch and DeleteObject IfMatch;
# the runtime-provided client-s3 is "a specific minor version that depends on the
# runtime version and your AWS Region" (Lambda docs) and one older than 3.700.0
# silently DROPS those headers — every claim then "wins". s3-conditional.mjs
# probes the bundled SDK at cold start and fails the claims closed if a header is
# missing. client-lambda / client-dynamodb / lib-dynamodb stay runtime-provided:
# nothing here depends on a header they might not know.
#
# If install fails (e.g. registry outage) we must ABORT, not ship a bundle
# without node_modules — that would replace the live Lambda with one whose
# top-level presigner import cannot resolve, breaking every operation at init.
if [ -f package.json ]; then
  npm install --omit=dev --silent >/dev/null 2>&1 || npm install --production --silent >/dev/null 2>&1
  for pkg in @aws-sdk/s3-request-presigner @aws-sdk/client-s3; do
    if [ ! -d "node_modules/$pkg" ]; then
      echo "  ✗ npm install did not produce $pkg — aborting" >&2
      echo "    (shipping index.mjs without it would crash the function at init, or leave the claims unconditional)" >&2
      exit 1
    fi
  done
  # The pin is the guarantee: the installed client-s3 must be exactly package.json's.
  WANT_S3="$(node -p "require('./package.json').dependencies['@aws-sdk/client-s3']")"
  HAVE_S3="$(node -p "require('./node_modules/@aws-sdk/client-s3/package.json').version")"
  if [ "$WANT_S3" != "$HAVE_S3" ]; then
    echo "  ✗ @aws-sdk/client-s3 installed $HAVE_S3 but package.json pins $WANT_S3 — aborting" >&2
    exit 1
  fi
  echo "  @aws-sdk/client-s3 $HAVE_S3 (bundled, pinned)"
fi
zip -qr function.zip index.mjs deliverables-lint.mjs s3-conditional.mjs node_modules

SIZE=$(ls -lh function.zip | awk '{print $5}')
echo "  Zip size: $SIZE"

# TEAM-4740 FR-11: WORKFLOWS_TABLE is read (GetItem only) to resolve the run's
# `featureBranch` so submit_ticket_plan can template the integration branch into
# every ticket description instead of trusting an analyst-coined one. NO IAM change
# — deploy/setup-lambda-role.sh already grants GetItem/Query on
# agentcore-hub-workflows to this shared role. Unset ⇒ templating is skipped.
ENV_VARS="Variables={ARTIFACT_BUCKET=${ARTIFACT_BUCKET},EVENTS_TABLE=${EVENTS_TABLE},WORKFLOWS_TABLE=${WORKFLOWS_TABLE},TICKET_PROVIDER=${TICKET_PROVIDER},TICKET_TOOLS_LAMBDA=${TICKET_TOOLS_LAMBDA}"

# TEAM-4752 D3: OPTIONAL, and appended only when actually set — an empty
# GITHUB_TOKEN= would be indistinguishable from a configured one that stopped
# working. Same fallback order as deploy/setup-pipeline-tools-lambda.mjs
# (GITHUB_TOKEN || GITHUB_PAT); config.sh already sourced .env.local above, so an
# operator's GITHUB_PAT is in scope here with no config.sh change. No IAM change —
# the call is to GitHub, not to AWS. Never echoed: the value appears only inside
# the --environment argument, and this script sets no `set -x`.
GITHUB_TOKEN="${GITHUB_TOKEN:-${GITHUB_PAT:-}}"
if [ -n "$GITHUB_TOKEN" ]; then
  ENV_VARS="${ENV_VARS},GITHUB_TOKEN=${GITHUB_TOKEN}"
  echo "  GITHUB_TOKEN: set (FR-5 base-branch verification enabled)"
else
  echo "  GITHUB_TOKEN: unset (FR-5 base-branch checks will report 'unverified')"
fi
ENV_VARS="${ENV_VARS}}"

echo "=== Deploying $NAME ==="
if aws lambda get-function --function-name "$NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
  aws lambda update-function-code \
    --function-name "$NAME" \
    --zip-file "fileb://function.zip" \
    --region "$AWS_REGION" \
    --output text --query 'FunctionName' >/dev/null
  aws lambda wait function-updated --function-name "$NAME" --region "$AWS_REGION"
  aws lambda update-function-configuration \
    --function-name "$NAME" \
    --handler "index.handler" \
    --timeout 60 \
    --memory-size 512 \
    --environment "$ENV_VARS" \
    --region "$AWS_REGION" \
    --output text --query 'FunctionName' >/dev/null
  echo "  ✓ $NAME (updated)"
else
  aws lambda create-function \
    --function-name "$NAME" \
    --runtime nodejs22.x \
    --handler "index.handler" \
    --role "$LAMBDA_ROLE_ARN" \
    --zip-file "fileb://function.zip" \
    --timeout 60 \
    --memory-size 512 \
    --environment "$ENV_VARS" \
    --region "$AWS_REGION" \
    --output text --query 'FunctionName' >/dev/null
  echo "  ✓ $NAME (created)"
fi

rm -f function.zip
echo "=== Done ==="
