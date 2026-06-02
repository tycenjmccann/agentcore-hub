#!/bin/bash
# Set up AgentCore Online Evaluations for all fleet agents
# Uses Opus 4.7 as judge model, 100% sampling, 10 evaluators per config
#
# NOTE: API limit is 10 evaluators per config.
#   - Ticket-creating agents (requirements_analyst, qa_verifier, ci_agent) get:
#     9 built-in + 1 custom (dependency_chain_compliance_online) = 10
#   - All other agents get 10 built-in evaluators
#
# IMPORTANT: The custom evaluator must be the "_online" variant.
#   The on-demand version (dependency_chain_compliance-VyBv7H2bCi) requires
#   reference inputs and CANNOT be used in online evaluation configs.
#
# Agent IDs are read dynamically from fleet-runtime-ids.json rather than
# hardcoded, so this script works after any redeployment.

set -e
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "${REPO_ROOT}/deploy/config.sh"

# Custom evaluator (online-compatible, no reference inputs needed)
CUSTOM_EVALUATOR="dependency_chain_compliance_online-mbLh2kEFhw"

# Agents that create/reassign tickets (need the custom evaluator)
TICKET_AGENTS="agentcore_hub_requirements_analyst agentcore_hub_qa_verifier agentcore_hub_ci_agent"

# Read agent IDs dynamically from fleet-runtime-ids.json
FLEET_FILE="${REPO_ROOT}/deploy/runtime-agent/fleet-runtime-ids.json"

if [ ! -f "$FLEET_FILE" ]; then
  echo "ERROR: Fleet runtime IDs file not found: $FLEET_FILE"
  echo "Run deploy-fleet.sh first to deploy the agent fleet."
  exit 1
fi

echo "Reading agent IDs from: $FLEET_FILE"

# The custom dependency-chain evaluator is created per-account and is NOT
# provisioned by any deploy step in this repo (its ID is account-specific).
# Probe for it once. If it's missing, ticket agents gracefully fall back to
# 10 built-in evaluators (adding Conciseness) instead of emitting a config
# that the API rejects with "Evaluators not found".
CUSTOM_EVALUATOR_AVAILABLE=false
if AGENTCORE_SUPPRESS_RECOMMENDATION=1 agentcore eval evaluator list --max-results 100 2>/dev/null \
     | grep -q "$CUSTOM_EVALUATOR"; then
  CUSTOM_EVALUATOR_AVAILABLE=true
  echo "Custom evaluator present: $CUSTOM_EVALUATOR"
else
  echo ""
  echo "⚠️  WARNING: custom evaluator '$CUSTOM_EVALUATOR' not found in this account."
  echo "    Ticket agents will use 10 built-in evaluators (Conciseness substituted"
  echo "    for the dependency-chain check). To enable the custom evaluator, create"
  echo "    it with 'agentcore eval evaluator create' and re-run this script."
  echo ""
fi

AGENTS=$(python3 -c "
import json
with open('$FLEET_FILE') as f:
    data = json.load(f)
for name, arn in data.items():
    rid = arn.split('/')[-1]
    print(f'{name} {rid}')
")

AGENT_COUNT=$(echo "$AGENTS" | wc -l | tr -d ' ')
echo "Creating online evaluation configs for ${AGENT_COUNT} agents..."
if [ "$CUSTOM_EVALUATOR_AVAILABLE" = true ]; then
  echo "Evaluators: 10 per agent (ticket agents get custom dependency_chain evaluator)"
else
  echo "Evaluators: 10 built-in per agent (custom evaluator unavailable — see warning above)"
fi
echo "Sampling: 100%"
echo "Judge model: Opus 4.7"
echo ""

# Loop via process substitution (not a pipe) so FAILED_CONFIGS set inside the
# loop survives into the parent shell for the final summary / exit code.
FAILED_CONFIGS=""
while read name agent_id; do
  config_name="eval_${name}"

  echo "→ Creating config for ${name} (${agent_id})..."

  # Build the evaluator argument list. Ticket agents get the custom
  # dependency-chain evaluator (9 built-in + 1 custom) when it's available;
  # otherwise everyone gets the same 10 built-in evaluators.
  eval_args=(
    -e "Builtin.ToolSelectionAccuracy"
    -e "Builtin.ToolParameterAccuracy"
    -e "Builtin.InstructionFollowing"
    -e "Builtin.GoalSuccessRate"
    -e "Builtin.Correctness"
    -e "Builtin.Coherence"
    -e "Builtin.Faithfulness"
    -e "Builtin.Helpfulness"
    -e "Builtin.ResponseRelevance"
  )
  if echo "$TICKET_AGENTS" | grep -qw "$name" && [ "$CUSTOM_EVALUATOR_AVAILABLE" = true ]; then
    eval_args+=(-e "${CUSTOM_EVALUATOR}")
  else
    eval_args+=(-e "Builtin.Conciseness")
  fi

  # Capture output and exit status. Show the success/error lines, and on a
  # non-zero exit surface the full output and record the failure (do NOT
  # swallow it with `|| true` — a silent failure here is exactly the bug
  # this script previously had).
  create_out=$(agentcore eval online create \
    --agent-id "${agent_id}" \
    --name "${config_name}" \
    --sampling-rate 100.0 \
    "${eval_args[@]}" \
    --description "Full evaluation suite for ${name} - 100% sampling with Opus 4.7 judge" \
    2>&1) && create_rc=0 || create_rc=$?

  echo "$create_out" | grep -E "(✓|Config ID|Status|Error)" || true
  if [ "$create_rc" -ne 0 ]; then
    echo "  ✗ FAILED to create eval config for ${name} (exit ${create_rc}):"
    echo "$create_out" | sed 's/^/      /'
    FAILED_CONFIGS="${FAILED_CONFIGS} ${name}"
  fi

  echo ""
done < <(echo "$AGENTS")

echo "Done! Listing all configs:"
agentcore eval online list

if [ -n "$FAILED_CONFIGS" ]; then
  echo ""
  echo "✗ Online eval config creation FAILED for:${FAILED_CONFIGS}"
  echo "  (See per-agent errors above.) This step did not fully succeed."
  exit 1
fi
