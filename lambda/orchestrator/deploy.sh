#!/usr/bin/env bash
# ─── Deploy Orchestrator + Agent-Invoker + Events-Writer Lambdas ────────────
#
# Bundles node_modules and deploys the shared zip to all three Lambda functions.
# Run from repo root or this directory.
#
# Usage:
#   ./lambda/orchestrator/deploy.sh
#   AWS_PROFILE=your-profile ./lambda/orchestrator/deploy.sh
#
# Prerequisites:
#   - AWS credentials configured
#   - Lambda functions already created (see template.yaml for SAM deploy)
#
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

REGION="${AWS_REGION:-us-east-1}"

echo "=== Installing dependencies ==="
npm install --omit=dev

echo "=== Creating deployment zip ==="
rm -f function.zip
zip -r function.zip index.mjs agent-invoker.mjs events-writer.mjs package.json node_modules/ > /dev/null

SIZE=$(ls -lh function.zip | awk '{print $5}')
echo "  Zip size: $SIZE"

echo "=== Deploying to Lambda functions ==="
for FUNC in agentcore-hub-orchestrator agentcore-hub-agent-invoker; do
  echo "  Deploying $FUNC..."
  aws lambda update-function-code \
    --function-name "$FUNC" \
    --zip-file "fileb://function.zip" \
    --region "$REGION" \
    --query 'FunctionName' --output text
done

echo ""
echo "=== Done. Both Lambdas updated. ==="
echo ""
echo "IMPORTANT: If env vars need updating (e.g. JIRA_API_TOKEN), do that separately:"
echo "  aws lambda update-function-configuration --function-name agentcore-hub-orchestrator \\"
echo "    --environment '{\"Variables\":{...}}' --region $REGION"
