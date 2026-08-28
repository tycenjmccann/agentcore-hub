#!/bin/bash
# Set up AgentCore Online Evaluations for all fleet agents
# Uses Opus 4.7 as judge model, tiered sampling, 5 evaluators per config
#
# TEAM-3366 §2.4 load reduction: the previous 10-evaluator / 100%-sampling
# setup drove ~10 Opus-judge calls per sampled session and throttled the
# judge quota. Now:
#   - 5 evaluators per config (down from 10; API limit is still 10):
#     * All agents: Builtin.ToolSelectionAccuracy (TOOL_CALL),
#       Builtin.InstructionFollowing, Builtin.Correctness (TRACE),
#       Builtin.GoalSuccessRate (SESSION), plus a 5th slot —
#     * requirements_analyst (TEAM-3368: the only role in scope for the
#       dependency-chain rubric): the custom
#       dependency_chain_compliance_online evaluator (SESSION)
#     * All other agents: Builtin.Helpfulness (TRACE)
#     * Dropped everywhere: ToolParameterAccuracy, Coherence, Faithfulness,
#       ResponseRelevance, Conciseness
#   - Tiered sampling (down from a flat 100%):
#     * Pipeline gate roles (requirements_analyst, qa_verifier, ci_agent): 100%
#     * All other agents: 25%
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

# --- Fleet span_missing health alarm (TEAM-3103, reworked TEAM-3386) --------
# deploy/evaluations/span-missing-alarm.json watches the EMF metrics that
# lambda/eval-packager/index.mjs now emits (EvalSessionsTotal /
# EvalSessionsSpanMissing in the AgentCoreHub/Evaluations namespace) and
# fires when >50% of eval sessions across the fleet have no invoke_agent
# span. The alarm reads the DIMENSIONLESS fleet-rollup series (TEAM-3386) via
# plain MetricStat entries — CloudWatch rejects alarms built on SEARCH()
# expressions, so the per-agent SUM(SEARCH(...)) shape is dashboard-only. The
# ratio is guarded with IF(total > 0, ...) so an all-duplicates delivery
# (EvalSessionsTotal=0) reads as ratio 0, non-breaching. Apply it with:
#
#   aws cloudwatch put-metric-alarm --cli-input-json file://span-missing-alarm.json
#
# Rollout constraint: create this alarm ONLY AFTER the runtime telemetry fix
# (R1/R2 — Strands/ADOT tracer wiring) AND the TEAM-3386 eval-packager
# (dimensionless-rollup emitter) are deployed AND at least one healthy eval
# batch with non-zero EvalSessionsTotal has been observed in CloudWatch.
# Creating it earlier means every session is span_missing by definition and
# the alarm fires immediately on stale data (or, pre-TEAM-3386 packager, the
# dimensionless series doesn't exist and the alarm sits in INSUFFICIENT_DATA).
# Add AlarmActions (the environment's SNS topic ARN) to the JSON at apply
# time — it's intentionally omitted here since it's environment-specific.
# -----------------------------------------------------------------------------

# --- Eval health dashboard + success-rate alarm (TEAM-3368 §4.2/§4.3) -------
# deploy/evaluations/eval-health-dashboard.json visualizes the extended EMF
# record emitted by lambda/eval-packager (EvalSessionsTotal / SpanMissing /
# Error, EvalThrottleCount, EvalDuplicateResultCount) and
# deploy/evaluations/eval-success-rate-alarm.json fires when the fleet's
# IF(total > 0, (total - span_missing - errors) / total, 1) success rate
# drops below 0.8. Like the span_missing alarm it reads the DIMENSIONLESS
# fleet-rollup series (TEAM-3386) via plain MetricStat entries — alarms can't
# use SEARCH() — and the IF() guard treats a zero-total period
# (all-duplicates delivery) as healthy (rate 1, non-breaching).
#
# Dashboard — safe to apply ANY time (widgets simply stay empty until the new
# metrics flow; region is hardcoded us-east-1 in the JSON — substitute the
# target region at apply time):
#
#   aws cloudwatch put-dashboard --dashboard-name agentcore-hub-eval-health \
#     --dashboard-body file://deploy/evaluations/eval-health-dashboard.json
#
# Success-rate alarm — same rollout constraint as the span_missing alarm
# above, plus the packager side: apply ONLY AFTER the P0-A runtime telemetry
# fix AND the P0-B eval-packager fix AND the TEAM-3386 packager
# (dimensionless-rollup emitter) are deployed, AND at least one healthy
# batch with non-zero EvalSessionsTotal carrying the three new metrics
# (EvalSessionsError, EvalThrottleCount, EvalDuplicateResultCount) has been
# observed in CloudWatch. Applying earlier evaluates the rate on stale/partial
# data and fires immediately. Add AlarmActions (the environment's SNS topic
# ARN) to the JSON at apply time — intentionally omitted, environment-specific:
#
#   aws cloudwatch put-metric-alarm \
#     --cli-input-json file://deploy/evaluations/eval-success-rate-alarm.json
#
# TEAM-3376 also adds session-level EvalThrottleRate /
# EvalValidationExceptionRate to the same EMF record — the dashboard's rate
# widgets read them, and they must be visible in CloudWatch before the alarm
# is applied (covered by the healthy-batch precondition above).
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
# If eval results show ThrottlingException storms (EvalThrottleRate /
# EvalThrottleCount climbing on the eval-health dashboard), the Opus judge
# model's RPM quota needs an increase via AWS Service Quotas. Full runbook:
# "Eval judge throttling (quota)" in docs/orchestration-tracing-guide.md.
# Never automate the quota request from CI — it needs a human to pick the
# value and own the AWS support conversation.
# -----------------------------------------------------------------------------

# Agents scoped to the custom dependency-chain evaluator (TEAM-3368,
# TEAM-3366 design §3.1): requirements_analyst only. It is the only role whose
# core deliverable is CREATING the ticket dependency graph; qa_verifier and
# ci_agent merely reassign tickets rather than construct chains, and scoring
# them against the chain-construction rubric produced rubric-mismatch zeros.
# The orchestrator (the other chain-toucher) is a Lambda with no online eval
# config, so there is nothing to scope there. Out-of-scope roles fall into the
# Builtin.Helpfulness fifth-slot fallback below. Sampling tiers (GATE_AGENTS)
# are unchanged — this only narrows who gets the custom evaluator.
TICKET_AGENTS="agentcore_hub_requirements_analyst"

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
# back to 5 built-in evaluators (adding Builtin.Helpfulness in the fifth slot,
# like every other agent) instead of emitting a config that the API rejects
# with "Evaluators not found".
CUSTOM_EVALUATOR_AVAILABLE=false
if AGENTCORE_SUPPRESS_RECOMMENDATION=1 agentcore eval evaluator list --max-results 100 2>/dev/null \
     | grep -q "$CUSTOM_EVALUATOR"; then
  CUSTOM_EVALUATOR_AVAILABLE=true
  echo "Custom evaluator present: $CUSTOM_EVALUATOR"
else
  echo ""
  echo "⚠️  WARNING: custom evaluator '$CUSTOM_EVALUATOR' not found in this account."
  echo "    requirements_analyst will use 5 built-in evaluators (Helpfulness substituted"
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

# TEAM-3366 §2.4: pipeline gate roles keep 100% sampling (their scores gate
# ticket flow); everyone else drops to 25% to cut judge load.
GATE_AGENTS="agentcore_hub_requirements_analyst agentcore_hub_qa_verifier agentcore_hub_ci_agent"

AGENT_COUNT=$(echo "$AGENTS" | wc -l | tr -d ' ')
echo "Creating online evaluation configs for ${AGENT_COUNT} agents..."
if [ "$CUSTOM_EVALUATOR_AVAILABLE" = true ]; then
  echo "Evaluators: 5 per agent (requirements_analyst gets custom dependency_chain evaluator)"
else
  echo "Evaluators: 5 built-in per agent (custom evaluator unavailable — see warning above)"
fi
echo "Sampling: 100% for gate roles (requirements_analyst, qa_verifier, ci_agent), 25% otherwise"
echo "Judge model: Opus 4.7"
echo ""

# Loop via process substitution (not a pipe) so FAILED_CONFIGS set inside the
# loop survives into the parent shell for the final summary / exit code.
FAILED_CONFIGS=""
while read name agent_id; do
  config_name="eval_${name}"

  echo "→ Creating config for ${name} (${agent_id})..."

  # Build the evaluator argument list (TEAM-3366 §2.4: trimmed to 5).
  # requirements_analyst spends its fifth slot on the custom dependency-chain
  # evaluator (4 built-in + 1 custom) when it's available; otherwise the fifth
  # slot is Builtin.Helpfulness, same as every other agent.
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

  # Tiered sampling: gate roles at 100%, everyone else at 25%.
  if echo "$GATE_AGENTS" | grep -qw "$name"; then
    sampling_rate="100.0"
  else
    sampling_rate="25.0"
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
    --description "Core evaluation suite for ${name} - ${sampling_rate}% sampling with Opus 4.7 judge" \
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
