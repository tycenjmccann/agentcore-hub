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
#   ./deploy.sh --force --force-reason "INC-1: hotfix" backend_dev
#                                   # Audited eval-gate break-glass (CLI form of
#                                   # EVAL_GATE_OVERRIDE=1 + EVAL_GATE_OVERRIDE_REASON)
#
# Environment:
#   AWS_PROFILE    — Which AWS profile to use (required)
#   GATEWAY_ARN    — Override gateway ARN (optional, auto-detected if not set)
#   EVAL_GATE_OVERRIDE / EVAL_GATE_OVERRIDE_REASON
#                  — env-var form of --force / --force-reason; both routes end
#                    up in the same audited break-glass helper
#
# The script sources deploy/config.sh which derives ACCOUNT_ID, ROLE_ARN,
# and ARTIFACT_BUCKET from your active AWS credentials.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Break-glass flag parsing (TEAM-3426 FINDING 4) — one shared parser with
# deploy-one.sh so the two can't drift, and one place that documents the flags.
# Sourced early: it needs no AWS creds, so --help/--list and bad-flag errors all
# work without credentials.
# shellcheck disable=SC1091 # resolved relative to this script at runtime
source "$REPO_ROOT/deploy/lib/parse-force-args.sh" \
  || { echo "FATAL: cannot load arg parser ($REPO_ROOT/deploy/lib/parse-force-args.sh) — refusing to deploy ungated" >&2; exit 1; }

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
    echo "Usage: ./deploy.sh [--force --force-reason \"<why>\"] [agents...]"
    echo ""
    echo "  No args               Deploy all 14 agents"
    echo "  <number>              Deploy by index (1-14)"
    echo "  <name>                Deploy by name (agentcore_hub_ prefix optional)"
    echo "  --list, -l            Show numbered agent list"
    eval_gate_force_usage_lines
    echo ""
    echo "Examples:"
    echo "  ./deploy.sh 10              # backend_dev"
    echo "  ./deploy.sh 10 11 12        # backend_dev, api_dev, frontend_dev"
    echo "  ./deploy.sh backend_dev     # by name"
    echo "  ./deploy.sh ios_designer    # agentcore_hub_ prefix is optional"
    echo "  ./deploy.sh --force --force-reason 'INC-1: hotfix' backend_dev"
    exit 0
  fi
done
# --- Break-glass flags (TEAM-3426 FINDING 4) ---
# On --force this exports EVAL_GATE_OVERRIDE=1 + EVAL_GATE_OVERRIDE_REASON before
# the gate runs, so the override goes through the SAME audited
# _eval_gate_break_glass path as the env-var form. Any unknown --flag is rejected
# here rather than falling through to the agent-name loop below (which used to
# report it as an "Unknown agent"). Parsed before config.sh so a bad flag is
# caught without AWS creds.
parse_force_args "$@" || {
  echo "Run ./deploy.sh --help for usage." >&2
  exit 1
}
# Because the exports are inherited, the override also reaches the deploy-one.sh
# children spawned below — no flag forwarding needed.
if [ "${#FORCE_ARGS_POSITIONAL[@]}" -gt 0 ]; then
  set -- "${FORCE_ARGS_POSITIONAL[@]}"
else
  set --
fi

# --- Source config (derives ACCOUNT_ID, ROLE_ARN, BUCKET from credentials) ---
# shellcheck disable=SC1091 # resolved relative to this script at runtime
source "$REPO_ROOT/deploy/config.sh"

# Eval gate (FR-7): this script ships per-agent prompts via deploy-one.sh.
# This call is where an override is actually spent: it does the audited
# break-glass here and then latches, so the deploy-one.sh children short-circuit
# on the latch token (loudly, once) instead of re-auditing per agent. That is
# the designed behavior — see check-eval-gate.sh's latch notes.
# shellcheck disable=SC1091 # resolved relative to this script at runtime
source "$REPO_ROOT/deploy/lib/check-eval-gate.sh"
require_eval_gate "deploy/runtime-agent/prompts/**"

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
