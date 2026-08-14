#!/bin/bash
#
# deploy.sh — Deploy one, some, or all agents to AgentCore Runtime
#
# Usage:
#   ./deploy.sh                     # Deploy all 14 agents
#   ./deploy.sh backend_dev         # Deploy one agent (prefix optional)
#   ./deploy.sh 10                  # Deploy agent #10 (agentcore_hub_backend_dev)
#   ./deploy.sh 10 11 12            # Deploy agents #10, #11, #12
#   ./deploy.sh backend_dev api_dev # Deploy by name
#
# Environment:
#   AWS_PROFILE    — Which AWS profile to use (required)
#   GATEWAY_ARN    — Override gateway ARN (optional, auto-detected if not set)
#
# The script sources deploy/config.sh which derives ACCOUNT_ID, ROLE_ARN,
# and ARTIFACT_BUCKET from your active AWS credentials.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Agent list — numbered 1-15
AGENTS=(
  "agentcore_hub_requirements_analyst"   # 1
  "agentcore_hub_frontend_designer"      # 2
  "agentcore_hub_ios_designer"           # 3
  "agentcore_hub_backend_designer"       # 4
  "agentcore_hub_android_designer"       # 5
  "agentcore_hub_security_reviewer"      # 6
  "agentcore_hub_legal_compliance"       # 7
  "agentcore_hub_localization"           # 8
  "agentcore_hub_analytics_designer"     # 9
  "agentcore_hub_backend_dev"            # 10
  "agentcore_hub_api_dev"                # 11
  "agentcore_hub_frontend_dev"           # 12
  "agentcore_hub_code_reviewer"          # 13
  "agentcore_hub_qa_verifier"            # 14
  "agentcore_hub_ci_agent"               # 15
)

# --- Handle --list and --help early (no AWS creds needed) ---
for arg in "$@"; do
  if [ "$arg" = "--list" ] || [ "$arg" = "-l" ]; then
    echo "Agent fleet:"
    for i in "${!AGENTS[@]}"; do
      printf "  %2d  %s\n" $((i+1)) "${AGENTS[$i]}"
    done
    exit 0
  elif [ "$arg" = "--help" ] || [ "$arg" = "-h" ]; then
    echo "Usage: ./deploy.sh [agents...]"
    echo ""
    echo "  No args        Deploy all 14 agents"
    echo "  <number>       Deploy by index (1-14)"
    echo "  <name>         Deploy by name (agentcore_hub_ prefix optional)"
    echo "  --list, -l     Show numbered agent list"
    echo ""
    echo "Examples:"
    echo "  ./deploy.sh 10              # backend_dev"
    echo "  ./deploy.sh 10 11 12        # backend_dev, api_dev, frontend_dev"
    echo "  ./deploy.sh backend_dev     # by name"
    echo "  ./deploy.sh ios_designer    # agentcore_hub_ prefix is optional"
    exit 0
  fi
done

# --- Source config (derives ACCOUNT_ID, ROLE_ARN, BUCKET from credentials) ---
source "$REPO_ROOT/deploy/config.sh"

# --- Auto-detect gateway if not set ---
if [ -z "${GATEWAY_ARN:-}" ]; then
  set +e
  GW_ID=$(python3 << 'PYEOF'
import boto3, sys, os
try:
    profile = os.environ.get('AWS_PROFILE', None)
    region = os.environ.get('AWS_REGION', 'us-east-1')
    session = boto3.Session(profile_name=profile, region_name=region)
    client = session.client('bedrock-agentcore-control')
    resp = client.list_gateways()
    gws = resp.get('items', resp.get('gateways', []))
    for gw in gws:
        if 'agentcore-hub' in gw.get('name','') and gw['status'] == 'READY':
            print(gw['gatewayId']); sys.exit(0)
    for gw in gws:
        if gw['status'] == 'READY':
            print(gw['gatewayId']); sys.exit(0)
except Exception as e:
    print(f'ERROR: {e}', file=sys.stderr)
PYEOF
  )
  set -e
  if [ -z "$GW_ID" ]; then
    echo "ERROR: Could not auto-detect GATEWAY_ARN. Set it manually." >&2
    exit 1
  fi
  export GATEWAY_ARN="arn:aws:bedrock-agentcore:${AWS_REGION}:${ACCOUNT_ID}:gateway/${GW_ID}"
fi

# --- Parse arguments into a list of agent names ---
TARGETS=()

if [ $# -eq 0 ]; then
  # No args = deploy all
  TARGETS=("${AGENTS[@]}")
else
  for arg in "$@"; do
    if [[ "$arg" =~ ^[0-9]+$ ]]; then
      # Numeric — index into agent list (1-based)
      idx=$((arg - 1))
      if [ $idx -lt 0 ] || [ $idx -ge ${#AGENTS[@]} ]; then
        echo "ERROR: Agent number $arg out of range (1-${#AGENTS[@]})" >&2
        echo "Run with --list to see agent numbers." >&2
        exit 1
      fi
      TARGETS+=("${AGENTS[$idx]}")
    else
      # Name — add agentcore_hub_ prefix if missing
      name="$arg"
      [[ "$name" != agentcore_hub_* ]] && name="agentcore_hub_${name}"
      # Validate
      found=false
      for agent in "${AGENTS[@]}"; do
        if [ "$agent" = "$name" ]; then
          found=true; break
        fi
      done
      if [ "$found" = false ]; then
        echo "ERROR: Unknown agent '$arg'. Run with --list to see options." >&2
        exit 1
      fi
      TARGETS+=("$name")
    fi
  done
fi

# --- Deploy ---
echo "Deploying ${#TARGETS[@]} agent(s)..."
echo "  Account:  $ACCOUNT_ID"
echo "  Region:   $AWS_REGION"
echo "  Gateway:  $GATEWAY_ARN"
echo ""

# Parallel if >1 agent, sequential if 1
if [ ${#TARGETS[@]} -eq 1 ]; then
  bash "$SCRIPT_DIR/deploy-one.sh" "${TARGETS[0]}"
else
  printf '%s\n' "${TARGETS[@]}" | xargs -P 14 -I {} bash "$SCRIPT_DIR/deploy-one.sh" {}
fi
