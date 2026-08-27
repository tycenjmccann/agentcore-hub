#!/bin/bash
# Set up AgentCore Online Evaluations for all fleet agents
# Uses Opus 4.7 as judge model, tiered sampling, 5 evaluators per config
#
# TEAM-3376 (design §3.1): the evaluator matrix is trimmed from 10 to 5 per
# config — every extra evaluator is another Opus judge call per sampled
# session, and the 10-wide matrix at 100% sampling is what throttled the judge
# (ThrottlingException storms in the eval results log groups).
#   - Standard agents: ToolSelectionAccuracy, InstructionFollowing,
#     Correctness, Helpfulness, GoalSuccessRate
#   - requirements_analyst (the sole ticket-dependency-graph-creating role):
#     the same minus Helpfulness, plus the custom
#     dependency_chain_compliance_online evaluator = 5
#   - Dropped everywhere: ToolParameterAccuracy, Coherence, Faithfulness,
#     ResponseRelevance, Conciseness
# Sampling is tiered: 100% for the gate roles (requirements_analyst,
# qa_verifier, ci_agent — low volume, high blast radius), 25% for all others.
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

# --- Re-registering a corrected evaluator rubric (e.g. TEAM-3103) ----------
# This script only PROBES for CUSTOM_EVALUATOR above — it never creates or
# updates the evaluator itself (it's account-provisioned, out of band). When
# deploy/evaluations/dependency_chain_evaluator.json changes (rubric fix),
# get it live with:
#
#   Preferred — in-place update, ID stays the same, nothing below to edit:
#     agentcore eval evaluator update --evaluator-id "$CUSTOM_EVALUATOR" \
#       --config-file deploy/evaluations/dependency_chain_evaluator.json
#     (Verify the exact update verb/flags against the installed `agentcore`
#     CLI at deploy time — this repo's scripts only demonstrate list/create
#     for eval evaluators; `update` may differ or not exist in your CLI
#     version. Run `agentcore eval evaluator update --help` first.)
#
#   Fallback — if an in-place update isn't available, the fix needs a NEW
#   evaluator (a fresh account-generated "-XXXX" id):
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
# -----------------------------------------------------------------------------

# --- Fleet span_missing health alarm (TEAM-3103) ---------------------------
# deploy/evaluations/span-missing-alarm.json watches the EMF metrics that
# lambda/eval-packager/index.mjs now emits (EvalSessionsTotal /
# EvalSessionsSpanMissing in the AgentCoreHub/Evaluations namespace) and
# fires when >50% of eval sessions across the fleet have no invoke_agent
# span. Apply it with:
#
#   aws cloudwatch put-metric-alarm --cli-input-json file://span-missing-alarm.json
#
# Rollout constraint: create this alarm ONLY AFTER the runtime telemetry fix
# (R1/R2 — Strands/ADOT tracer wiring) is deployed AND at least one healthy
# eval batch with non-zero EvalSessionsTotal has been observed in CloudWatch.
# Creating it earlier means every session is span_missing by definition and
# the alarm fires immediately on stale data. Add AlarmActions (the
# environment's SNS topic ARN) to the JSON at apply time — it's intentionally
# omitted here since it's environment-specific.
# -----------------------------------------------------------------------------

# --- Fleet eval success-rate alarm + health dashboard (TEAM-3376) ----------
# deploy/evaluations/eval-success-rate-alarm.json alarms when the fleet eval
# success rate (total - span_missing - error, over EvalSessionsTotal) drops
# below 0.8 — it covers BOTH failure modes: span_missing (telemetry broken)
# AND error, including judge throttling. Apply it with:
#
#   aws cloudwatch put-metric-alarm --cli-input-json file://eval-success-rate-alarm.json
#
# DEPLOYMENT ORDER: apply the eval-success-rate alarm ONLY AFTER
#   (a) the runtime telemetry anchor-span fix (TEAM-3366 P0-A,
#       deploy/runtime-agent/main.py _emit_session_anchor_span) is deployed to
#       the fleet, AND
#   (b) at least one healthy batch with non-zero EvalSessionsTotal — and the
#       new EvalSessionsError / EvalThrottleRate / EvalValidationExceptionRate
#       / EvalDuplicateResultCount metrics — has been observed in CloudWatch.
# Applied earlier, the success rate computes over pre-fix data (or nothing)
# and the alarm fires immediately on stale state. As with the span-missing
# alarm, add AlarmActions to the JSON at apply time.
#
# deploy/evaluations/eval-health-dashboard.json is SAFE TO APPLY ANY TIME
# (empty widgets until metrics flow):
#
#   aws cloudwatch put-dashboard --dashboard-name agentcore-hub-eval-health \
#     --dashboard-body file://eval-health-dashboard.json
#
# Both JSON files hard-code "us-east-1" (pure JSON can't carry comments) —
# substitute the target region at apply time if deploying elsewhere, e.g.:
#   sed 's/us-east-1/eu-west-1/g' eval-health-dashboard.json
# -----------------------------------------------------------------------------

# --- Reconciling live configs after a matrix/sampling change (TEAM-3376) ---
# `agentcore eval online create` does not update in place: re-running this
# script against an account that already has configs leaves the OLD configs
# live (create fails or duplicates, per CLI version). To reconcile after a
# change to the evaluator matrix, sampling tiers, or fleet redeployment:
#
#   1. List what's live and diff against expectation — exactly one config per
#      fleet agent (eval_<agentId>), 5 evaluators each, the custom
#      dependency-chain evaluator ONLY on eval_agentcore_hub_requirements_analyst:
#        agentcore eval online list
#   2. Delete every config that mismatches (wrong evaluator set, wrong
#      sampling rate, stale agent id from a previous fleet deployment):
#        agentcore eval online delete --config-id <id>
#   3. If the fleet was redeployed, regenerate runtime ids FIRST so this
#      script reads fresh agent ids:
#        deploy/runtime-agent/refresh-agents-json.sh
#   4. Re-run this script to recreate the deleted configs, then re-run
#      refresh-agents-json.sh so agents.json picks up the new evalConfigNames.
#   5. Record the resulting config ids in
#      deploy/evaluations/eval-config-ids.json (snapshot only, but keep it
#      truthful for the next reader).
#
# The whole procedure is idempotent: a config that already matches the
# expected shape is left alone, and re-running create for a deleted name just
# mints a fresh account-suffixed id.
# -----------------------------------------------------------------------------

# --- Eval judge throttling (quota) — OPERATOR action, NOT CI ---------------
# If eval results show ThrottlingException storms (EvalThrottleRate climbing
# on the eval-health dashboard), the Opus judge model's RPM quota needs an
# increase via AWS Service Quotas. Full runbook: "Eval judge throttling
# (quota)" in docs/orchestration-tracing-guide.md. Never automate the quota
# request from CI — it needs a human to pick the value and own the AWS
# support conversation.
# -----------------------------------------------------------------------------

# TEAM-3376 design §3.1: the custom dependency-chain evaluator is scoped to
# requirements_analyst ONLY — it is the sole role that CREATES the ticket
# dependency graph. qa_verifier and ci_agent merely transition tickets along
# it; scoring them on "did you build a compliant chain" produced guaranteed
# failures that polluted their scorecards (the role guard in
# lambda/eval-packager/index.mjs is the belt-and-suspenders for this drift).
TICKET_AGENTS="agentcore_hub_requirements_analyst"

# Gate roles keep 100% sampling (low traffic, and a single bad run blocks the
# whole pipeline); everyone else samples at 25% to keep the Opus judge under
# its RPM quota. See "Eval judge throttling (quota)" in
# docs/orchestration-tracing-guide.md for the operator quota-increase runbook.
GATE_AGENTS="agentcore_hub_requirements_analyst agentcore_hub_qa_verifier agentcore_hub_ci_agent"
GATE_SAMPLING="100.0"
DEFAULT_SAMPLING="25.0"

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
# Probe for it once. If it's missing, requirements_analyst gracefully falls
# back to the standard 5 built-in evaluators (Helpfulness substituted for the
# dependency-chain check) instead of emitting a config that the API rejects
# with "Evaluators not found".
CUSTOM_EVALUATOR_AVAILABLE=false
if AGENTCORE_SUPPRESS_RECOMMENDATION=1 agentcore eval evaluator list --max-results 100 2>/dev/null \
     | grep -q "$CUSTOM_EVALUATOR"; then
  CUSTOM_EVALUATOR_AVAILABLE=true
  echo "Custom evaluator present: $CUSTOM_EVALUATOR"
else
  echo ""
  echo "⚠️  WARNING: custom evaluator '$CUSTOM_EVALUATOR' not found in this account."
  echo "    requirements_analyst will use the standard 5 built-in evaluators"
  echo "    (Helpfulness substituted for the dependency-chain check). To enable the"
  echo "    custom evaluator, create it with 'agentcore eval evaluator create' and"
  echo "    re-run this script."
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
  echo "Evaluators: 5 per agent (requirements_analyst gets custom dependency_chain evaluator)"
else
  echo "Evaluators: 5 built-in per agent (custom evaluator unavailable — see warning above)"
fi
echo "Sampling: ${GATE_SAMPLING}% gate roles (${GATE_AGENTS}), ${DEFAULT_SAMPLING}% others"
echo "Judge model: Opus 4.7"
echo ""

# Loop via process substitution (not a pipe) so FAILED_CONFIGS set inside the
# loop survives into the parent shell for the final summary / exit code.
FAILED_CONFIGS=""
while read name agent_id; do
  config_name="eval_${name}"

  echo "→ Creating config for ${name} (${agent_id})..."

  # Build the evaluator argument list (TEAM-3376 trimmed matrix, 5 per config):
  # a shared core of 4, plus Helpfulness for standard agents OR the custom
  # dependency-chain evaluator for requirements_analyst (falling back to
  # Helpfulness when the custom evaluator isn't provisioned in this account).
  eval_args=(
    -e "Builtin.ToolSelectionAccuracy"
    -e "Builtin.InstructionFollowing"
    -e "Builtin.Correctness"
    -e "Builtin.GoalSuccessRate"
  )
  if echo "$TICKET_AGENTS" | grep -qw "$name" && [ "$CUSTOM_EVALUATOR_AVAILABLE" = true ]; then
    eval_args+=(-e "${CUSTOM_EVALUATOR}")
  else
    eval_args+=(-e "Builtin.Helpfulness")
  fi

  # Tiered sampling: gate roles at 100%, the rest at 25% (judge quota).
  if echo "$GATE_AGENTS" | grep -qw "$name"; then
    sampling_rate="$GATE_SAMPLING"
  else
    sampling_rate="$DEFAULT_SAMPLING"
  fi

  # Capture output and exit status. Show the success/error lines, and on a
  # non-zero exit surface the full output and record the failure (do NOT
  # swallow it with `|| true` — a silent failure here is exactly the bug
  # this script previously had).
  create_out=$(agentcore eval online create \
    --agent-id "${agent_id}" \
    --name "${config_name}" \
    --sampling-rate "${sampling_rate}" \
    "${eval_args[@]}" \
    --description "Trimmed evaluation suite for ${name} - ${sampling_rate}% sampling with Opus 4.7 judge" \
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
