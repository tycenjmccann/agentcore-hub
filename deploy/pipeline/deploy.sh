#!/usr/bin/env bash
#
# deploy/pipeline/deploy.sh — stand up the CI/CD pipeline module (bolt-on).
#
# Idempotent. Sources deploy/config.sh for the account guard + derived values,
# then `cdk deploy`s the pipeline stack. Wholly optional: NOT part of DEPLOY.md,
# not run by any other deploy path. A forker who never runs this gets the hub
# with no pipeline.
#
# Prereqs:
#   - Node 20 / npm 10, AWS CLI v2, credentials for the target (prod) account
#   - PIPELINE_GITHUB_OWNER set (repo owner). Optional: PIPELINE_GITHUB_REPO
#     (default agentcore-hub), PIPELINE_BRANCH (default main),
#     PIPELINE_CONNECTION_ARN (reuse an existing CodeConnections link),
#     PIPELINE_APPROVAL_EMAILS, PIPELINE_APPROVAL_SNS_ARN, ECS_SERVICE_ARN.
#   - PIPELINE_CI_WEBHOOK=1 (off by default) turns on the CodeBuild PR-check
#     webhook here; requires the GitHub App to have webhook permission.
#     PIPELINE_CI_START_BUILD=1 (off by default, the fallback when the webhook
#     can't be installed) is a separate flag read by
#     deploy/setup-pipeline-tools-lambda.mjs, not by this stack.
#     Runbook for getting either flag certifying PRs in prod:
#     deploy/pipeline/README.md → "Runbook: CodeBuild-certified CI for PRs
#     (TEAM-4258)".
#
# Usage:
#   PIPELINE_GITHUB_OWNER=tycenjmccann ./deploy/pipeline/deploy.sh
#   ./deploy/pipeline/deploy.sh diff      # cdk diff only
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

# Account guard + derived env (ARTIFACT_BUCKET, ACCOUNT_ID, GITHUB_OWNER, ...).
# shellcheck disable=SC1091
source "$REPO_ROOT/deploy/config.sh"

# Fall back to the repo's GitHub owner from config.sh when the pipeline-specific
# one is unset, so a single GITHUB_OWNER covers both.
export PIPELINE_GITHUB_OWNER="${PIPELINE_GITHUB_OWNER:-${GITHUB_OWNER:-}}"
export PIPELINE_GITHUB_REPO="${PIPELINE_GITHUB_REPO:-agentcore-hub}"
export PIPELINE_BRANCH="${PIPELINE_BRANCH:-main}"
export CDK_DEFAULT_ACCOUNT="$ACCOUNT_ID"
export CDK_DEFAULT_REGION="$AWS_REGION"

if [[ -z "${PIPELINE_GITHUB_OWNER}" ]]; then
  echo "ERROR: set PIPELINE_GITHUB_OWNER (or GITHUB_OWNER) — the GitHub repo owner to build." >&2
  exit 1
fi

# PR-check webhook state, echoed in the banner: the flag is read fresh on every
# run and the stack rewrites the project unconditionally, so an unset flag does
# not "keep" a previously installed webhook — CDK diffs it away.
CI_WEBHOOK_ON=0
case "${PIPELINE_CI_WEBHOOK:-}" in
  1 | true) CI_WEBHOOK_ON=1 ;;
esac

echo "═══════════════════════════════════════════════════════════════"
echo "  CI/CD Pipeline module — cdk deploy"
echo "  Account: $ACCOUNT_ID  Region: $AWS_REGION"
echo "  Repo:    $PIPELINE_GITHUB_OWNER/$PIPELINE_GITHUB_REPO @ $PIPELINE_BRANCH"
echo "  Bucket:  $ARTIFACT_BUCKET"
if [[ "$CI_WEBHOOK_ON" == "1" ]]; then
  echo "  PR check: webhook ON (PIPELINE_CI_WEBHOOK=$PIPELINE_CI_WEBHOOK)"
else
  echo "───────────────────────────────────────────────────────────────"
  echo "  NOTICE: PIPELINE_CI_WEBHOOK is not set — the CodeBuild PR-check"
  echo "  webhook will be OFF, and REMOVED if it was previously installed"
  echo "  (this stack rewrites the CI project; CDK diffs the webhook away)."
  echo "  Without it, CodeBuild certification depends on"
  echo "  PIPELINE_CI_START_BUILD=1 on the pipeline-tools Lambda"
  echo "  (node deploy/setup-pipeline-tools-lambda.mjs). With neither, the CI"
  echo "  agent can never report ci_status=\"certified\"."
  echo "  Runbook: deploy/pipeline/README.md → 'Runbook: CodeBuild-certified CI"
  echo "  for PRs (TEAM-4258)'."
fi
echo "═══════════════════════════════════════════════════════════════"

cd "$HERE"
[[ -d node_modules ]] || npm ci

# Ensure the CDK toolkit is bootstrapped in this account/region (idempotent).
npx cdk bootstrap "aws://$ACCOUNT_ID/$AWS_REGION" >/dev/null 2>&1 || \
  npx cdk bootstrap "aws://$ACCOUNT_ID/$AWS_REGION"

case "${1:-deploy}" in
  diff)  npx cdk diff ;;
  synth) npx cdk synth --strict ;;
  *)
    npx cdk deploy --require-approval any-change --outputs-file /tmp/pipeline-outputs.json
    echo ""
    echo "── Stack outputs ──"
    cat /tmp/pipeline-outputs.json 2>/dev/null || true
    echo ""
    echo "NEXT (one-time, if the connection was freshly created):"
    echo "  The CodeConnections link is PENDING until you complete the GitHub App"
    echo "  handshake: AWS console → Developer Tools → Connections → agentcore-hub-*"
    echo "  → 'Update pending connection' → install/authorize on the GitHub org."
    echo "  Until then, PR webhooks and the Source action cannot reach GitHub."
    echo ""
    echo "THEN: enable branch protection on '$PIPELINE_BRANCH' requiring the"
    echo "  'agentcore-hub-ci' status check + 1 approval (GitHub repo settings)."
    ;;
esac
