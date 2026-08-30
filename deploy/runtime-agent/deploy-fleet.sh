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
#                     [--force --force-reason '<incident>: <why>']
#

set -e

# Source project env vars (GITHUB_PAT, etc.) so agents get MCP access
ENV_FILE="$(cd "$(dirname "$0")/../.." && pwd)/.env.local"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090 # user-local env file, resolved at runtime
  source "$ENV_FILE"
  set +a
  echo "Loaded env from $ENV_FILE"
fi

REGION="${AWS_REGION:-us-east-1}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_DIR="$SCRIPT_DIR"
DEPLOY_MODE="${DEPLOY_MODE:-lightweight}"

# CLI break-glass (TEAM-3426): extract --force/--force-reason BEFORE the gate
# runs so the exports are visible to require_eval_gate below (and to every
# child deploy-one.sh). Sugar for the audited EVAL_GATE_OVERRIDE env vars —
# same banner/S3+local audit path — not a second override mechanism. Other
# args pass through to the main parse loop further down.
FORCE_REQUESTED=0
FLEET_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --force)
      FORCE_REQUESTED=1
      shift
      ;;
    --force-reason)
      if [ $# -lt 2 ]; then
        echo "ERROR: --force-reason requires a value" >&2
        exit 1
      fi
      export EVAL_GATE_OVERRIDE_REASON="$2"
      shift 2
      ;;
    --force-reason=*)
      export EVAL_GATE_OVERRIDE_REASON="${1#--force-reason=}"
      shift
      ;;
    *)
      FLEET_ARGS+=("$1")
      shift
      ;;
  esac
done
if [ "$FORCE_REQUESTED" = "1" ]; then
  if [ -z "${EVAL_GATE_OVERRIDE_REASON:-}" ]; then
    echo "ERROR: --force requires a non-empty reason — pass --force-reason '<incident>: <why>' (or set EVAL_GATE_OVERRIDE_REASON). An unexplained override is refused (BG-2)." >&2
    exit 1
  fi
  export EVAL_GATE_OVERRIDE=1
  echo "⚠️  EVAL-GATE BREAK-GLASS REQUESTED VIA --force (reason: ${EVAL_GATE_OVERRIDE_REASON}) — if the gate refuses, the override will be audited (banner + S3 + local log) before proceeding." >&2
fi
set -- ${FLEET_ARGS[@]+"${FLEET_ARGS[@]}"}

# Eval gate (FR-7): refuse to ship ungated prompt/agents.json changes.
# shellcheck disable=SC1091 # resolved relative to this script at runtime
source "$SCRIPT_DIR/../lib/check-eval-gate.sh"
require_eval_gate "deploy/runtime-agent/prompts/**" "src/config/agents.json"

# Create runtime role if not already set
if [ -z "${AGENTCORE_ROLE_ARN:-}" ]; then
  echo "AGENTCORE_ROLE_ARN not set — creating runtime role..."
  echo ""
  # shellcheck disable=SC1091 # resolved relative to this script at runtime
  source "$SCRIPT_DIR/../setup-runtime-role.sh"
  echo ""
fi

ROLE_ARN="${AGENTCORE_ROLE_ARN}"
GATEWAY_ARN="${GATEWAY_ARN:-}"  # Optional: AgentCore MCP gateway ARN
MODEL_ID="us.anthropic.claude-opus-4-6-v1"

# Robust mode: build & push the image ONCE before the parallel agent loop.
# All 14 agents share the same image; deploy-one-robust.py just points
# CreateAgentRuntime/UpdateAgentRuntime at IMAGE_URI.
if [ "$DEPLOY_MODE" = "robust" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: DEPLOY_MODE=robust requires Docker, but 'docker' is not on PATH." >&2
    echo "  Install Docker Desktop (or another OCI runtime) and retry," >&2
    echo "  or re-run /setup and choose the lightweight deploy mode." >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "ERROR: DEPLOY_MODE=robust requires a running Docker daemon." >&2
    echo "  Start Docker Desktop and retry," >&2
    echo "  or re-run /setup and choose the lightweight deploy mode." >&2
    exit 1
  fi
  : "${AWS_ACCOUNT_ID:=$(aws sts get-caller-identity --query Account --output text)}"
  IMAGE_TAG="${IMAGE_TAG:-$(date -u +%Y%m%d-%H%M%S)}"
  IMAGE_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/runtime-agent:${IMAGE_TAG}"
  export IMAGE_URI

  echo "Robust mode — building & pushing custom image..."
  echo "  IMAGE_URI=$IMAGE_URI"
  AWS_ACCOUNT_ID="$AWS_ACCOUNT_ID" AWS_REGION="$REGION" \
    "$SCRIPT_DIR/build-and-push.sh" "$IMAGE_TAG"
  echo ""
fi

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
echo "  Deploy Mode: $DEPLOY_MODE"
if [ "$DEPLOY_MODE" = "robust" ]; then
  echo "  Image URI:   $IMAGE_URI"
fi
echo "═══════════════════════════════════════════════════════════════"
echo ""

# All 15 agents — same code, different runtime name + system prompt
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
  "agentcore_hub_code_reviewer"
  "agentcore_hub_qa_verifier"
  "agentcore_hub_ci_agent"
)

RESULTS_FILE="$SCRIPT_DIR/fleet-runtime-ids.json"

# Deploy in parallel using deploy-one.sh helper.
# Every runtime env var — including the OTel/observability set
# (AGENT_OBSERVABILITY_ENABLED, OTEL_PYTHON_DISTRO, OTEL_SERVICE_NAME, …) —
# comes from deploy-one.sh (lightweight) or deploy-one-robust.py (robust).
# This script never configures a runtime itself, so there is nothing to mirror here.
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
python3 -c "
import json, sys
data = json.load(sys.stdin)
for name, arn in data.items():
    env_key = 'RUNTIME_ARN_' + name.upper()
    print(f'{env_key}={arn}')
" < "$RESULTS_FILE"

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
