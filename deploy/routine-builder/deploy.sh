#!/bin/bash
# Sync the Routine Builder toolkit to S3 (harness picks it up on the next session).
#
# Prereqs:
#   1. lambda/routines-runner/deploy.sh   (runner Lambda + scheduler role + table)
#   2. node deploy/routine-builder/setup-routine-builder.mjs   (the harness itself)
set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "${REPO_ROOT}/deploy/config.sh"

BUCKET="$ARTIFACT_BUCKET"

# Resolve the harness ARN — explicit override, else discover by name.
RB_ARN="${ROUTINE_BUILDER_ARN:-}"
if [ -z "$RB_ARN" ]; then
  # Paginated lookup (TEAM-5173 r5-F1): `--query ... | [0] --output text` was
  # applied per page and printed "None\n<arn>" on a multi-page account.
  # shellcheck disable=SC1091
  source "${REPO_ROOT}/deploy/lib/agentcore-lookup.sh"
  RB_ARN=$(agentcore_harness_field agentcore_hub_routine_builder arn 2>/dev/null || true)
fi
if [ -z "$RB_ARN" ]; then
  echo "✗ Routine Builder harness not found. Deploy it first:"
  echo "    node deploy/routine-builder/setup-routine-builder.mjs"
  exit 1
fi

echo "═══════════════════════════════════════════════════════════"
echo "  Routine Builder"
echo "  Account: ${ACCOUNT_ID}"
echo "  Harness: ${RB_ARN}"
echo "═══════════════════════════════════════════════════════════"

aws s3 sync "${REPO_ROOT}/deploy/routine-builder/toolkit/" \
  "s3://${BUCKET}/routine-builder/toolkit/" \
  --exclude "test_*.py" --exclude "*.pyc" --delete --quiet
echo "✓ Toolkit: s3://${BUCKET}/routine-builder/toolkit/"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ✓ Done"
echo ""
echo "  UI chat → /api/routines/chat → harness builds routine:"
echo "    compose agents / write persona → workflow def → schedule → routine row"
echo "  Schedule fires → routines-runner → POST /api/workflow/start"
echo "═══════════════════════════════════════════════════════════"
