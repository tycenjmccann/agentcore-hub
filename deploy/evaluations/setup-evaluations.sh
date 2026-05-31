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
echo "Evaluators: 10 per agent (ticket agents get custom dependency_chain evaluator)"
echo "Sampling: 100%"
echo "Judge model: Opus 4.7"
echo ""

echo "$AGENTS" | while read name agent_id; do
  config_name="eval_${name}"

  echo "→ Creating config for ${name} (${agent_id})..."

  # Determine evaluator set based on whether agent creates tickets
  if echo "$TICKET_AGENTS" | grep -qw "$name"; then
    # 9 built-in + 1 custom (drop Conciseness to stay at 10)
    agentcore eval online create \
      --agent-id "${agent_id}" \
      --name "${config_name}" \
      --sampling-rate 100.0 \
      -e "Builtin.ToolSelectionAccuracy" \
      -e "Builtin.ToolParameterAccuracy" \
      -e "Builtin.InstructionFollowing" \
      -e "Builtin.GoalSuccessRate" \
      -e "Builtin.Correctness" \
      -e "Builtin.Coherence" \
      -e "Builtin.Faithfulness" \
      -e "Builtin.Helpfulness" \
      -e "Builtin.ResponseRelevance" \
      -e "${CUSTOM_EVALUATOR}" \
      --description "Full evaluation suite for ${name} - 100% sampling with Opus 4.7 judge" \
      2>&1 | grep -E "(✓|Config ID|Status|Error)" || true
  else
    # 10 built-in (no custom evaluator needed)
    agentcore eval online create \
      --agent-id "${agent_id}" \
      --name "${config_name}" \
      --sampling-rate 100.0 \
      -e "Builtin.ToolSelectionAccuracy" \
      -e "Builtin.ToolParameterAccuracy" \
      -e "Builtin.InstructionFollowing" \
      -e "Builtin.GoalSuccessRate" \
      -e "Builtin.Correctness" \
      -e "Builtin.Coherence" \
      -e "Builtin.Faithfulness" \
      -e "Builtin.Helpfulness" \
      -e "Builtin.Conciseness" \
      -e "Builtin.ResponseRelevance" \
      --description "Full evaluation suite for ${name} - 100% sampling with Opus 4.7 judge" \
      2>&1 | grep -E "(✓|Config ID|Status|Error)" || true
  fi

  echo ""
done

echo "Done! Listing all configs:"
agentcore eval online list
