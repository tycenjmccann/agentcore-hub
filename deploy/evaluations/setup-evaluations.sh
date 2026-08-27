#!/bin/bash
# Set up AgentCore Online Evaluations for all fleet agents
# Uses Opus 4.7 as judge model, 30% sampling, 5 evaluators per config
#
# LOAD PROFILE (TEAM-3359): the previous 100% sampling × 10 evaluators
# saturated the Bedrock judge-model quota — ~78% of evaluator results in the
# live results log groups were ThrottlingException, i.e. effective capacity
# ≈ 0.22× that offered load. This profile offers 0.30 sampling × ~0.47 of the
# per-session evaluator load (5 of the previous mix) ≈ 0.14× the old load
# ≈ 64% of measured capacity — ~35% burst headroom, targeting a steady-state
# throttle rate < 5% (alarmed at 20%, see throttle-rate-alarm.json).
#
# HARD CONSTRAINT: evaluator calls are executed by the AWS Bedrock AgentCore
# Online Evaluations SERVICE — no backoff, retry, or staggering can be added
# to evaluator execution from this repo. The only load levers we hold are the
# sampling rate and evaluator count below. If throttling persists at this
# reduced profile, a Bedrock quota increase is a HUMAN/ops follow-up (AWS
# support ticket) — never something this script performs.
#
# Evaluator mix per config (API limit is 10; we deliberately run 5),
# structured one-per-evaluation-level plus the highest-signal TRACE trio:
#   - TOOL_CALL: Builtin.ToolSelectionAccuracy
#   - TRACE:     Builtin.InstructionFollowing, Builtin.Correctness,
#                Builtin.Helpfulness
#   - SESSION:   dependency_chain_compliance_online (ticket-creating agents)
#                or Builtin.GoalSuccessRate (all other agents, and the
#                graceful fallback when the custom evaluator is absent)
#
# IMPORTANT: The custom evaluator must be the "_online" variant.
#   The on-demand version (dependency_chain_compliance-VyBv7H2bCi) requires
#   reference inputs and CANNOT be used in online evaluation configs.
#
# Agent IDs are read dynamically from fleet-runtime-ids.json rather than
# hardcoded, so this script works after any redeployment.
#
# REDEPLOYING AFTER A RUBRIC CHANGE (dependency_chain_evaluator.json):
#   Editing the JSON in this repo changes NOTHING in the account by itself —
#   see the "Re-registering a corrected evaluator rubric" section below
#   CUSTOM_EVALUATOR for the rollout procedure.

set -e
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "${REPO_ROOT}/deploy/config.sh"

# Custom evaluator (online-compatible, no reference inputs needed)
CUSTOM_EVALUATOR="dependency_chain_compliance_online-mbLh2kEFhw"

# --- Re-registering a corrected evaluator rubric (TEAM-3103 / TEAM-3359) ---
# This script only PROBES for CUSTOM_EVALUATOR above — it never creates or
# updates the evaluator itself (it's account-provisioned, out of band). When
# deploy/evaluations/dependency_chain_evaluator.json changes (rubric fix,
# e.g. the TEAM-3359 NotApplicable 2.0 rating), get it live with:
#
#   0. Deploy lambda/eval-packager FIRST. The packager must already understand
#      N/A verdicts (isNotApplicable / naCount, shipped with TEAM-3359) before
#      the first NotApplicable (score 2.0) result arrives — otherwise 2.0 rows
#      would be averaged into the DDB scorecard as if they were real scores.
#
#   Preferred — in-place update, ID stays the same, nothing below to edit:
#     agentcore eval evaluator update --evaluator-id "$CUSTOM_EVALUATOR" \
#       --config-file deploy/evaluations/dependency_chain_evaluator.json
#     (UpdateEvaluator is CONFIRMED to exist in the bedrock-agentcore-control
#     API — evaluators pass through an UPDATING status and can land in
#     UPDATE_FAILED — but verify the installed `agentcore` CLI exposes it
#     before relying on it: run `agentcore eval evaluator update --help`
#     first. This repo's scripts only demonstrate list/create.)
#
#   Fallback — if the CLI has no update verb, the fix needs a NEW evaluator
#   (a fresh account-generated "-XXXX" id):
#     1. agentcore eval evaluator create \
#          --config-file deploy/evaluations/dependency_chain_evaluator.json
#        → capture the new evaluator ID from the output.
#     2. Update CUSTOM_EVALUATOR above to that new ID.
#     3. Re-run this script (setup-evaluations.sh), then
#        deploy/runtime-agent/refresh-agents-json.sh so agents.json picks up
#        the new evalConfigName.
#     4. Update the "custom_evaluators" map in
#        deploy/evaluations/eval-config-ids.json to the new ID — that file is
#        a non-load-bearing snapshot per its own "_configs_note", but keep it
#        truthful for the next reader.
#
#   Rollback: re-register the PREVIOUS rubric JSON from git history (git show
#   <old-sha>:deploy/evaluations/dependency_chain_evaluator.json > /tmp/rubric.json)
#   via the same update/create procedure above. The packager tolerates a
#   rubric without N/A indefinitely, so rolling the rubric back needs no
#   packager rollback.
# -----------------------------------------------------------------------------

# --- Fleet eval health alarms (TEAM-3103 / TEAM-3359 / TEAM-3382) ----------
# Three alarm definitions in this directory watch the DIMENSIONLESS fleet-level
# EMF metrics that lambda/eval-packager/index.mjs emits into the
# AgentCoreHub/Evaluations namespace (EvalSessionsTotal /
# EvalSessionsSpanMissing / EvalResultsTotal / EvalResultsThrottled). The
# packager's EMF record carries a second CloudWatchMetrics directive with an
# empty dimension set: CloudWatch alarms reject SEARCH expressions, so the
# alarms can't aggregate the per-agent (AgentName) series — they alarm on the
# dimensionless rollup instead, while dashboards keep the per-agent series.
#
#   span-missing-alarm.json          — pager: >50% of eval sessions have no
#                                      invoke_agent span (hourly, 3 of 4).
#   span-missing-elevated-alarm.json — ticket severity: >5% span-missing over
#                                      6-hour windows (3 of 4) — catches the
#                                      slow telemetry regression the 50%
#                                      pager would sleep through.
#   throttle-rate-alarm.json         — >20% of evaluator RESULTS throttled
#                                      (EvalResultsThrottled/EvalResultsTotal,
#                                      hourly, 2 of 3). Remediation levers are
#                                      the sampling rate and evaluator count
#                                      in THIS script — in-evaluator backoff
#                                      is impossible (the AWS Online
#                                      Evaluations service executes the
#                                      evaluators), and a Bedrock quota
#                                      increase is a human/ops follow-up.
#
# Apply each with:
#   aws cloudwatch put-metric-alarm \
#     --cli-input-json file://deploy/evaluations/<alarm-file>.json
#   e.g. file://deploy/evaluations/throttle-rate-alarm.json
#
# Rollout constraint: create these alarms ONLY AFTER (a) the runtime telemetry
# fix (R1/R2 — Strands/ADOT tracer wiring) is deployed, (b) the updated
# eval-packager Lambda (TEAM-3382, dimensionless fleet-level EMF directive) is
# deployed — the fleet-level series the alarms watch only exists once the new
# EMF record ships, so alarms created earlier sit in INSUFFICIENT_DATA — and
# (c) at least one healthy eval batch with non-zero EvalSessionsTotal AND
# EvalResultsTotal has been observed in CloudWatch. Creating them before the
# telemetry fix means every session is span_missing by definition and the
# alarms fire immediately on stale data.
# Add AlarmActions (the environment's SNS topic ARN) to each JSON at apply
# time — it's intentionally omitted since it's environment-specific.
# -----------------------------------------------------------------------------

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
# 5 built-in evaluators (Builtin.GoalSuccessRate filling the SESSION-level
# slot) instead of emitting a config the API rejects with "Evaluators not
# found".
CUSTOM_EVALUATOR_AVAILABLE=false
if AGENTCORE_SUPPRESS_RECOMMENDATION=1 agentcore eval evaluator list --max-results 100 2>/dev/null \
     | grep -q "$CUSTOM_EVALUATOR"; then
  CUSTOM_EVALUATOR_AVAILABLE=true
  echo "Custom evaluator present: $CUSTOM_EVALUATOR"
else
  echo ""
  echo "⚠️  WARNING: custom evaluator '$CUSTOM_EVALUATOR' not found in this account."
  echo "    Ticket agents will use 5 built-in evaluators (Builtin.GoalSuccessRate"
  echo "    substituted for the dependency-chain check in the SESSION-level slot)."
  echo "    To enable the custom evaluator, create it with 'agentcore eval"
  echo "    evaluator create' and re-run this script."
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
  echo "Evaluators: 5 per agent (ticket agents get custom dependency_chain evaluator)"
else
  echo "Evaluators: 5 built-in per agent (custom evaluator unavailable — see warning above)"
fi
echo "Sampling: 30%"
echo "Judge model: Opus 4.7"
echo ""

# Loop via process substitution (not a pipe) so FAILED_CONFIGS set inside the
# loop survives into the parent shell for the final summary / exit code.
FAILED_CONFIGS=""
while read name agent_id; do
  config_name="eval_${name}"

  echo "→ Creating config for ${name} (${agent_id})..."

  # Build the evaluator argument list — the reduced TEAM-3359 load profile
  # (see header): 1 TOOL_CALL + 3 TRACE, plus one SESSION-level slot below.
  eval_args=(
    -e "Builtin.ToolSelectionAccuracy"   # TOOL_CALL level
    -e "Builtin.InstructionFollowing"    # TRACE level
    -e "Builtin.Correctness"             # TRACE level
    -e "Builtin.Helpfulness"             # TRACE level
  )
  # SESSION-level slot: the custom dependency-chain evaluator for ticket
  # agents when it's available; Builtin.GoalSuccessRate for everyone else
  # (and as the graceful fallback when the custom evaluator is absent).
  if echo "$TICKET_AGENTS" | grep -qw "$name" && [ "$CUSTOM_EVALUATOR_AVAILABLE" = true ]; then
    eval_args+=(-e "${CUSTOM_EVALUATOR}")
  else
    eval_args+=(-e "Builtin.GoalSuccessRate")
  fi

  # Capture output and exit status. Show the success/error lines, and on a
  # non-zero exit surface the full output and record the failure (do NOT
  # swallow it with `|| true` — a silent failure here is exactly the bug
  # this script previously had).
  create_out=$(agentcore eval online create \
    --agent-id "${agent_id}" \
    --name "${config_name}" \
    --sampling-rate 30.0 \
    "${eval_args[@]}" \
    --description "Reduced evaluation suite for ${name} - 30% sampling with Opus 4.7 judge (TEAM-3359 load profile)" \
    2>&1) && create_rc=0 || create_rc=$?

  echo "$create_out" | grep -E "(✓|Config ID|Status|Error)" || true
  if [ "$create_rc" -ne 0 ]; then
    echo "  ✗ FAILED to create eval config for ${name} (exit ${create_rc}):"
    echo "$create_out" | sed 's/^/      /'
    FAILED_CONFIGS="${FAILED_CONFIGS} ${name}"
  fi

  # Stagger the CONTROL-PLANE CreateOnlineEvaluationConfig calls only. This
  # cannot and does not stagger runtime evaluator execution — the AWS Online
  # Evaluations service runs the evaluators on its own schedule; the only
  # runtime-load levers are the sampling rate and evaluator count above.
  sleep 5

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
