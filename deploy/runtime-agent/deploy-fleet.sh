#!/bin/bash
#
# deploy-fleet.sh — Deploy 14 Strands agents to AgentCore Runtime (direct_code_deploy)
#
# Each agent uses the same main.py but gets its own Runtime resource with a unique
# SYSTEM_PROMPT env var baked in from deploy/runtime-agent/prompts/{agent_name}.txt.
# The orchestrator is dumb — it only passes task context (ticket description).
#
# Prerequisites:
#   pip install "bedrock-agentcore-starter-toolkit>=0.1.21" strands-agents boto3
#   AWS credentials configured
#
# Usage:
#   ./deploy-fleet.sh [--region us-east-1] [--role-arn arn:aws:iam::ACCOUNT:role/X]
#

set -e

# Source project env vars (GITHUB_PAT, etc.) so agents get MCP access
ENV_FILE="$(cd "$(dirname "$0")/../.." && pwd)/.env.local"
if [ -f "$ENV_FILE" ]; then
  set -a; source "$ENV_FILE"; set +a
  echo "Loaded env from $ENV_FILE"
fi

REGION="${AWS_REGION:-us-east-1}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_DIR="$SCRIPT_DIR"

# Create runtime role if not already set
if [ -z "${AGENTCORE_ROLE_ARN:-}" ]; then
  echo "AGENTCORE_ROLE_ARN not set — creating runtime role..."
  echo ""
  source "$SCRIPT_DIR/../setup-runtime-role.sh"
  echo ""
fi

ROLE_ARN="${AGENTCORE_ROLE_ARN}"
GATEWAY_ARN="${GATEWAY_ARN:-}"  # Optional: AgentCore MCP gateway ARN
MODEL_ID="us.anthropic.claude-opus-4-6-v1"

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --region) REGION="$2"; shift 2 ;;
    --role-arn) ROLE_ARN="$2"; shift 2 ;;
    --gateway-arn) GATEWAY_ARN="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

echo "═══════════════════════════════════════════════════════════════"
echo "  Deploying AgentCore Hub Fleet — 14 Strands Agents on Runtime"
echo "═══════════════════════════════════════════════════════════════"
echo "  Region:      $REGION"
echo "  Role ARN:    $ROLE_ARN"
echo "  Gateway ARN: $GATEWAY_ARN"
echo "  Model:       $MODEL_ID"
echo "  Source:      $BASE_DIR/main.py"
echo "  Deploy Type: direct_code_deploy (CodeZip, no Docker)"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# All 14 agents — same code, different runtime name + system prompt
AGENTS=(
  "agentcore_hub_requirements_analyst"
  "agentcore_hub_frontend_designer"
  "agentcore_hub_ios_designer"
  "agentcore_hub_backend_designer"
  "agentcore_hub_android_designer"
  "agentcore_hub_security_reviewer"
  "agentcore_hub_legal_compliance"
  "agentcore_hub_localization"
  "agentcore_hub_analytics_designer"
  "agentcore_hub_backend_dev"
  "agentcore_hub_api_dev"
  "agentcore_hub_frontend_dev"
  "agentcore_hub_qa_verifier"
  "agentcore_hub_ci_agent"
)

RESULTS_FILE="$SCRIPT_DIR/fleet-runtime-ids.json"

# Deploy in parallel using deploy-one.sh helper
echo "Deploying ${#AGENTS[@]} agents (3 concurrent)..."
echo ""

printf '%s\n' "${AGENTS[@]}" | xargs -P 3 -I {} "$SCRIPT_DIR/deploy-one.sh" {} | tee /tmp/fleet-deploy-output.txt

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Fleet Deployment Results"
echo "═══════════════════════════════════════════════════════════════"

# Parse results into JSON
echo "{" > "$RESULTS_FILE"
FIRST=true
SUCCESS=0
FAIL=0

while IFS= read -r line; do
  if [[ "$line" == OK* ]]; then
    AGENT_NAME=$(echo "$line" | awk '{print $2}')
    ARN=$(echo "$line" | awk '{print $3}')
    if [ "$FIRST" = true ]; then
      FIRST=false
    else
      echo "," >> "$RESULTS_FILE"
    fi
    printf '  "%s": "%s"' "$AGENT_NAME" "$ARN" >> "$RESULTS_FILE"
    echo "  ✓ $AGENT_NAME → $ARN"
    SUCCESS=$((SUCCESS + 1))
  elif [[ "$line" == FAIL* ]]; then
    AGENT_NAME=$(echo "$line" | awk '{print $2}')
    echo "  ✗ $AGENT_NAME FAILED"
    FAIL=$((FAIL + 1))
  fi
done < /tmp/fleet-deploy-output.txt

echo "" >> "$RESULTS_FILE"
echo "}" >> "$RESULTS_FILE"

echo ""
echo "  ✓ Success: $SUCCESS / ${#AGENTS[@]}"
echo "  ✗ Failed:  $FAIL"
echo "  Results:   $RESULTS_FILE"
echo "═══════════════════════════════════════════════════════════════"

# Print env var format for orchestrator
echo ""
echo "Environment variables for orchestrator Lambda:"
echo "───────────────────────────────────────────────"
cat "$RESULTS_FILE" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for name, arn in data.items():
    env_key = 'RUNTIME_ARN_' + name.upper()
    print(f'{env_key}={arn}')
"

# Sync agents.json + fleet-runtime-ids.json from AWS. Delegating to the
# standalone refresh script keeps a single source of truth for this logic
# and preserves the existing compact array formatting in agents.json.
echo ""
"$SCRIPT_DIR/refresh-agents-json.sh" --region "$REGION"

echo ""
if [ "$FAIL" -gt 0 ]; then
  echo "✗ $FAIL/${#AGENTS[@]} agents failed to deploy."
  echo "  Re-run individually with: ./deploy-one.sh <agent-name>"
  exit 1
fi

echo "Running post-deploy health check..."
"$SCRIPT_DIR/verify-fleet.sh"
