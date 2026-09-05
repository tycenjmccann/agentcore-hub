#!/usr/bin/env bash
# ─── Deploy Orchestrator + Agent-Invoker + Events-Writer Lambdas ────────────
#
# Idempotent: creates the three Lambdas on first run, updates code + env vars
# on subsequent runs. Reads config from deploy/config.sh.
#
# Functions:
#   - agentcore-hub-orchestrator    (DynamoDB Streams trigger; routes tickets)
#   - agentcore-hub-agent-invoker   (async; invokes AgentCore runtimes)
#   - agentcore-hub-events-writer   (EventBridge → DynamoDB events table)
#
# Required env vars (from deploy/config.sh):
#   ACCOUNT_ID, AWS_REGION, LAMBDA_ROLE_ARN, ARTIFACT_BUCKET,
#   TICKETS_TABLE, WORKFLOWS_TABLE, EVENTS_TABLE
# Optional:
#   TICKET_PROVIDER ("jira" | "dynamodb", default "jira")
#   TICKET_TOOLS_LAMBDA (default derived from TICKET_PROVIDER)
#
# Usage:
#   ./lambda/orchestrator/deploy.sh
#
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$SCRIPT_DIR"

# shellcheck disable=SC1091
source "$REPO_ROOT/deploy/config.sh"

: "${LAMBDA_ROLE_ARN:?LAMBDA_ROLE_ARN must be set}"
: "${ARTIFACT_BUCKET:?ARTIFACT_BUCKET must be set}"

TICKET_PROVIDER="${TICKET_PROVIDER:-jira}"
if [ "$TICKET_PROVIDER" = "jira" ]; then
  TICKET_TOOLS_LAMBDA_DEFAULT="agentcore-hub-jira"
else
  TICKET_TOOLS_LAMBDA_DEFAULT="agentcore-hub-tickets"
fi
TICKET_TOOLS_LAMBDA="${TICKET_TOOLS_LAMBDA:-$TICKET_TOOLS_LAMBDA_DEFAULT}"

echo "=== Installing dependencies ==="
npm install --omit=dev --no-audit --no-fund --silent

echo "=== Creating deployment zip ==="
rm -f function.zip
# lease.mjs (TEAM-3618) reads its constants from src/config/lease-constants.json
# — the SINGLE source of truth shared with the app (src/lib/workflow/lease.ts).
# The zip only carries files from this directory, so copy the JSON in beside
# lease.mjs; the module prefers this local copy and falls back to the repo path
# for local/test runs. Do NOT fork the values — always copy from the repo.
cp "$REPO_ROOT/src/config/lease-constants.json" ./lease-constants.json
# Manifest must include the full transitive local-import closure of index.mjs,
# agent-invoker.mjs, events-writer.mjs (TEAM-3696) — a module missing here dies
# at cold start with ERR_MODULE_NOT_FOUND. Verify with
# ./scripts/check-lambda-zip-manifest.sh before changing this line.
zip -rq function.zip index.mjs agent-invoker.mjs events-writer.mjs workflow-store.mjs lease.mjs lease-constants.json watchdog.mjs dead-session-detector.mjs cascade.mjs review-cap.mjs ship-review.mjs completion.mjs pipeline-enabled.mjs reconcile-sweep.mjs sweep-scan.mjs repo-check.mjs gate-bypass.mjs evidence.mjs dag.mjs package.json node_modules/
rm -f lease-constants.json

SIZE=$(ls -lh function.zip | awk '{print $5}')
echo "  Zip size: $SIZE"

# Forward Jira creds when the install is in Jira mode. Only the orchestrator
# (lambda/orchestrator/index.mjs: jiraFetch, getTicketFromJira,
# transitionTicket, etc) calls Jira. Without these env vars every webhook
# crashes with `TypeError: fetch failed` on `https:///rest/api/3/...` and no
# workflow ever advances past phase=requirements. agent-invoker.mjs does NOT
# read them, so they are kept off that function (least privilege — see below).
JIRA_VARS=""
if [ "$TICKET_PROVIDER" = "jira" ]; then
  JIRA_VARS=",JIRA_SITE_URL=${JIRA_SITE_URL:-},JIRA_EMAIL=${JIRA_EMAIL:-},JIRA_API_TOKEN=${JIRA_API_TOKEN:-},JIRA_PROJECT_KEY=${JIRA_PROJECT_KEY:-}"
fi

# Forward GitHub creds when present so dev/QA agents can clone, push branches,
# and open PRs against the workspace repo (FLEET_REPO_URL / GITHUB_OWNER/REPO).
GITHUB_VARS=""
if [ -n "${GITHUB_PAT:-}" ]; then
  GITHUB_VARS=",GITHUB_PAT=${GITHUB_PAT},GITHUB_OWNER=${GITHUB_OWNER:-},GITHUB_REPO=${GITHUB_REPO:-}"
fi

# Only the orchestrator gets the Jira/GitHub secrets — it is the sole consumer.
# agent-invoker reads just the table/bucket/provider vars, so it deliberately
# omits ${JIRA_VARS}${GITHUB_VARS}: keeping a long-lived JIRA_API_TOKEN/GITHUB_PAT
# off a function that never uses them limits where those credentials are exposed.
# Same lease knob as the app (deploy/ecs-express/deploy.sh) — a mismatch lets a
# board Ready transition bypass a lease the API endpoints still consider live.
LEASE_VARS=""
if [ -n "${WORKFLOW_LEASE_TTL_MINUTES:-}" ]; then
  LEASE_VARS=",WORKFLOW_LEASE_TTL_MINUTES=${WORKFLOW_LEASE_TTL_MINUTES}"
fi

# Dead-session detector rollout (TEAM-3618 D1.2): off | shadow | enforce. The
# code defaults to shadow when unset — only forward an explicit override so the
# safe default is never accidentally flipped by a stale config.sh value.
DETECTOR_VARS=""
if [ -n "${DEAD_SESSION_DETECTOR_MODE:-}" ]; then
  DETECTOR_VARS=",DEAD_SESSION_DETECTOR_MODE=${DEAD_SESSION_DETECTOR_MODE}"
fi

# Cascade extended-states rollout (TEAM-3618 D3 commit 4b; tri-state off|shadow|
# enforce as of TEAM-3747 D1). The code defaults to OFF (commit-4a behavior — the
# pre-epic path, zero extra DDB reads) when unset; shadow/enforce are opt-in and
# NOT byte-identical to off (shadow's extended path issues extra reads). Only
# forward an explicit override so a stale config.sh value can never silently
# flip it off OFF. (TEAM-3763 F6: aligns code default with this doc.)
CASCADE_VARS=""
if [ -n "${CASCADE_EXTENDED_STATES:-}" ]; then
  CASCADE_VARS=",CASCADE_EXTENDED_STATES=${CASCADE_EXTENDED_STATES}"
fi

# Missed-unblock reconciliation sweep rollout (TEAM-3747 D1; scheduled by the
# reconcile_sweep EventBridge target wired below). Tri-state off|shadow|enforce.
# The code defaults to OFF (dark — runSweep short-circuits before its first
# DynamoDB scan) when unset, so a fresh deploy performs ZERO extra reads/writes;
# shadow (observe-only scan) and enforce (re-drive stalled dependents) are opt-in.
# Only forward an explicit override (TEAM-3763 F2).
RECONCILE_VARS=""
if [ -n "${RECONCILE_SWEEP_MODE:-}" ]; then
  RECONCILE_VARS=",RECONCILE_SWEEP_MODE=${RECONCILE_SWEEP_MODE}"
fi

# Gate-bypass detection rollout (TEAM-3991 D1.1). Tri-state off|shadow|enforce.
# Unlike the sweeps this defaults to ENFORCE in code (gate-bypass.mjs
# gateBypassMode()) and in template.yaml, so an unset value is already the safe
# posture; only forward an explicit override (e.g. GATE_BYPASS_MODE=shadow to
# observe first on a noisy repo).
GATE_BYPASS_VARS=""
if [ -n "${GATE_BYPASS_MODE:-}" ]; then
  GATE_BYPASS_VARS=",GATE_BYPASS_MODE=${GATE_BYPASS_MODE}"
fi

# CI/CD pipeline mode (PR #263): when set, buildAgentContext surfaces a
# "## Pipeline Mode" block so the CI/QA/release-manager blueprints read pipeline
# results instead of shelling builds/deploys. Only forwarded when explicitly set;
# absent → blueprints run their legacy self-run path.
PIPELINE_VARS=""
if [ -n "${PIPELINE_ENABLED:-}" ]; then
  PIPELINE_VARS=",PIPELINE_ENABLED=${PIPELINE_ENABLED}"
fi

ENV_VARS_ORCH="Variables={ARTIFACT_BUCKET=${ARTIFACT_BUCKET},TICKETS_TABLE=${TICKETS_TABLE},WORKFLOWS_TABLE=${WORKFLOWS_TABLE},EVENTS_TABLE=${EVENTS_TABLE},TICKET_PROVIDER=${TICKET_PROVIDER},TICKET_TOOLS_LAMBDA=${TICKET_TOOLS_LAMBDA}${JIRA_VARS}${GITHUB_VARS}${LEASE_VARS}${DETECTOR_VARS}${CASCADE_VARS}${RECONCILE_VARS}${GATE_BYPASS_VARS}${PIPELINE_VARS}}"
ENV_VARS_INVOKER="Variables={ARTIFACT_BUCKET=${ARTIFACT_BUCKET},TICKETS_TABLE=${TICKETS_TABLE},WORKFLOWS_TABLE=${WORKFLOWS_TABLE},EVENTS_TABLE=${EVENTS_TABLE},TICKET_PROVIDER=${TICKET_PROVIDER},TICKET_TOOLS_LAMBDA=${TICKET_TOOLS_LAMBDA}}"
ENV_VARS_EVENTS="Variables={EVENTS_TABLE=${EVENTS_TABLE}}"

deploy_function() {
  local NAME=$1 HANDLER=$2 TIMEOUT=$3 MEM=$4 ENV_VARS=$5
  if aws lambda get-function --function-name "$NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
    aws lambda update-function-code \
      --function-name "$NAME" \
      --zip-file "fileb://function.zip" \
      --region "$AWS_REGION" \
      --output text --query 'FunctionName' >/dev/null
    aws lambda wait function-updated --function-name "$NAME" --region "$AWS_REGION"
    aws lambda update-function-configuration \
      --function-name "$NAME" \
      --handler "$HANDLER" \
      --timeout "$TIMEOUT" \
      --memory-size "$MEM" \
      --environment "$ENV_VARS" \
      --region "$AWS_REGION" \
      --output text --query 'FunctionName' >/dev/null
    echo "  ✓ $NAME (updated)"
  else
    aws lambda create-function \
      --function-name "$NAME" \
      --runtime nodejs20.x \
      --handler "$HANDLER" \
      --role "$LAMBDA_ROLE_ARN" \
      --zip-file "fileb://function.zip" \
      --timeout "$TIMEOUT" \
      --memory-size "$MEM" \
      --environment "$ENV_VARS" \
      --region "$AWS_REGION" \
      --output text --query 'FunctionName' >/dev/null
    echo "  ✓ $NAME (created)"
  fi
}

echo "=== Deploying Lambdas ==="
deploy_function "agentcore-hub-orchestrator" "index.handler" 60 256 "$ENV_VARS_ORCH"
deploy_function "agentcore-hub-agent-invoker" "agent-invoker.handler" 900 512 "$ENV_VARS_INVOKER"
deploy_function "agentcore-hub-events-writer" "events-writer.handler" 10 128 "$ENV_VARS_EVENTS"

# ── DynamoDB Streams trigger: tickets table → orchestrator ────────────────────
# Mirrors the DynamoDBStream event in template.yaml. Idempotent: skips when an
# event source mapping already targets this stream.
echo "=== Wiring orchestrator trigger (DynamoDB Stream) ==="
TICKETS_STREAM_ARN=$(
  aws dynamodb describe-table \
    --table-name "$TICKETS_TABLE" \
    --region "$AWS_REGION" \
    --query 'Table.LatestStreamArn' \
    --output text 2>/dev/null || true
)
if [ -z "$TICKETS_STREAM_ARN" ] || [ "$TICKETS_STREAM_ARN" = "None" ]; then
  echo "  ! $TICKETS_TABLE has no DynamoDB stream — orchestrator will not be triggered."
  echo "    Recreate the table with streams enabled: ./scripts/create-dynamodb-tables.sh --with-tickets"
else
  EXISTING_UUID=$(
    aws lambda list-event-source-mappings \
      --function-name "agentcore-hub-orchestrator" \
      --region "$AWS_REGION" \
      --query "EventSourceMappings[?starts_with(EventSourceArn, \`${TICKETS_STREAM_ARN%/*}\`)].UUID | [0]" \
      --output text 2>/dev/null || true
  )
  if [ -z "$EXISTING_UUID" ] || [ "$EXISTING_UUID" = "None" ]; then
    aws lambda create-event-source-mapping \
      --function-name "agentcore-hub-orchestrator" \
      --event-source-arn "$TICKETS_STREAM_ARN" \
      --starting-position LATEST \
      --batch-size 10 \
      --maximum-batching-window-in-seconds 1 \
      --filter-criteria '{"Filters":[{"Pattern":"{\"eventName\":[\"INSERT\",\"MODIFY\"]}"}]}' \
      --region "$AWS_REGION" \
      --output text --query 'UUID' >/dev/null
    echo "  ✓ Stream → orchestrator mapping created"
  else
    echo "  ✓ Stream → orchestrator mapping already exists ($EXISTING_UUID)"
  fi
fi

# ── EventBridge: orchestrator/agent-invoker events → events-writer Lambda ─────
# Mirrors WorkflowEventsRule + EventsWriterPermission in template.yaml.
echo "=== Wiring events-writer trigger (EventBridge) ==="
RULE_NAME="agentcore-hub-workflow-events"
EVENT_BUS="${EVENT_BUS:-default}"
EVENTS_WRITER_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:agentcore-hub-events-writer"

aws events put-rule \
  --name "$RULE_NAME" \
  --event-bus-name "$EVENT_BUS" \
  --event-pattern '{"source":["agentcore-hub.orchestrator","agentcore-hub.agent-invoker"]}' \
  --state ENABLED \
  --region "$AWS_REGION" \
  --output text --query 'RuleArn' >/dev/null
echo "  ✓ Rule $RULE_NAME upserted on bus $EVENT_BUS"

aws events put-targets \
  --rule "$RULE_NAME" \
  --event-bus-name "$EVENT_BUS" \
  --targets "Id=EventsTableWriter,Arn=$EVENTS_WRITER_ARN" \
  --region "$AWS_REGION" \
  --output text --query 'FailedEntryCount' >/dev/null
echo "  ✓ Target events-writer attached to $RULE_NAME"

RULE_ARN="arn:aws:events:${AWS_REGION}:${ACCOUNT_ID}:rule/${EVENT_BUS}/${RULE_NAME}"
if [ "$EVENT_BUS" = "default" ]; then
  RULE_ARN="arn:aws:events:${AWS_REGION}:${ACCOUNT_ID}:rule/${RULE_NAME}"
fi
PERM_SID="agentcore-hub-events-writer-eventbridge"
if aws lambda get-policy \
     --function-name agentcore-hub-events-writer \
     --region "$AWS_REGION" \
     --output text --query 'Policy' 2>/dev/null | grep -q "\"Sid\":\"$PERM_SID\""; then
  echo "  ✓ events-writer EventBridge invoke permission already present"
else
  aws lambda add-permission \
    --function-name agentcore-hub-events-writer \
    --statement-id "$PERM_SID" \
    --action lambda:InvokeFunction \
    --principal events.amazonaws.com \
    --source-arn "$RULE_ARN" \
    --region "$AWS_REGION" \
    --output text --query 'Statement' >/dev/null
  echo "  ✓ events-writer EventBridge invoke permission added"
fi

# ── EventBridge: scheduled sweeps → orchestrator ──────────────────────────────
# Mirrors DeadSessionSweepRule + permission in template.yaml. A rate(5 minutes)
# rule invokes the orchestrator with a sentinel payload; index.mjs branches on it
# before any stream/webhook parsing. ONE rule fans out to TWO targets, each with
# its own Input action — a separate synthetic invocation per sweep:
#   - action "dead_session_sweep"  → getDetector().runSweep       (TEAM-3618 D1.2)
#   - action "reconcile_sweep"      → getReconcileSweep().runSweep (TEAM-3747 D1;
#     wired here by TEAM-3763 F2 — the handler existed but was never scheduled,
#     leaving the missed-unblock backstop FR-D1.3 dormant in production).
# Both sweeps are gated by their own rollout-mode env var and default DARK when
# unset (DEAD_SESSION_DETECTOR_MODE=shadow, RECONCILE_SWEEP_MODE=off), so firing
# them on a fresh deploy changes nothing until an operator opts in. Scheduled
# rules live on the default bus only; the single rule ARN below covers both
# targets, so one add-permission statement authorizes both.
echo "=== Wiring scheduled sweep triggers (EventBridge schedule) ==="
SWEEP_RULE="agentcore-hub-dead-session-sweep"
ORCH_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:agentcore-hub-orchestrator"

aws events put-rule \
  --name "$SWEEP_RULE" \
  --schedule-expression "rate(5 minutes)" \
  --state ENABLED \
  --region "$AWS_REGION" \
  --output text --query 'RuleArn' >/dev/null
echo "  ✓ Rule $SWEEP_RULE upserted (rate(5 minutes))"

# JSON list form (not the key=value shorthand): the Input JSON contains commas,
# which the shorthand parser would mis-split on. Input is a JSON *string*. Two
# targets on the one rule — the dead-session sweep and the reconcile sweep.
aws events put-targets \
  --rule "$SWEEP_RULE" \
  --targets '[{"Id":"orchestrator","Arn":"'"$ORCH_ARN"'","Input":"{\"source\":\"orchestrator.sweep\",\"action\":\"dead_session_sweep\"}"},{"Id":"reconcile","Arn":"'"$ORCH_ARN"'","Input":"{\"source\":\"orchestrator.sweep\",\"action\":\"reconcile_sweep\"}"}]' \
  --region "$AWS_REGION" \
  --output text --query 'FailedEntryCount' >/dev/null
echo "  ✓ Targets orchestrator (dead_session_sweep + reconcile_sweep) attached to $SWEEP_RULE"

SWEEP_RULE_ARN="arn:aws:events:${AWS_REGION}:${ACCOUNT_ID}:rule/${SWEEP_RULE}"
SWEEP_PERM_SID="agentcore-hub-orchestrator-dead-session-sweep"
if aws lambda get-policy \
     --function-name agentcore-hub-orchestrator \
     --region "$AWS_REGION" \
     --output text --query 'Policy' 2>/dev/null | grep -q "\"Sid\":\"$SWEEP_PERM_SID\""; then
  echo "  ✓ orchestrator sweep invoke permission already present"
else
  aws lambda add-permission \
    --function-name agentcore-hub-orchestrator \
    --statement-id "$SWEEP_PERM_SID" \
    --action lambda:InvokeFunction \
    --principal events.amazonaws.com \
    --source-arn "$SWEEP_RULE_ARN" \
    --region "$AWS_REGION" \
    --output text --query 'Statement' >/dev/null
  echo "  ✓ orchestrator sweep invoke permission added"
fi

rm -f function.zip
echo "=== Done ==="
