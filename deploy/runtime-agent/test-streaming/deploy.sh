#!/bin/bash
# Deploy the minimal test-streaming agent to AgentCore Runtime
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "${REPO_ROOT}/deploy/config.sh"

ROLE_ARN="$AGENTCORE_ROLE_ARN"
AGENT_NAME="agentcore_hub_test_streaming"

cd "$SCRIPT_DIR"

echo "Configuring $AGENT_NAME..."
agentcore configure \
  -e "main.py" \
  -n "$AGENT_NAME" \
  -er "$ROLE_ARN" \
  -rf requirements.txt \
  -r "$AWS_REGION" \
  -dt direct_code_deploy \
  --runtime PYTHON_3_10 \
  --idle-timeout 3600 \
  --max-lifetime 3600 \
  -ni \
  -s3 "bedrock-agentcore-codebuild-sources-${ACCOUNT_ID}-${AWS_REGION}"

echo "Deploying $AGENT_NAME..."
agentcore deploy \
  --auto-update-on-conflict \
  --env "BYPASS_TOOL_CONSENT=true" \
  --env "MODEL_ID=us.anthropic.claude-sonnet-4-20250514" \
  --env "AWS_REGION=${AWS_REGION}" \
  --env "EVENTS_TABLE=${EVENTS_TABLE}" \
  --env "HOME=/tmp" \
  --env "TMPDIR=/tmp"

echo ""
echo "Checking status..."
agentcore status
