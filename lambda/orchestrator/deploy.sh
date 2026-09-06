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
zip -rq function.zip index.mjs agent-invoker.mjs events-writer.mjs workflow-store.mjs lease.mjs lease-constants.json watchdog.mjs dead-session-detector.mjs cascade.mjs review-cap.mjs ship-review.mjs completion.mjs pipeline-enabled.mjs cd-registry.mjs reconcile-sweep.mjs sweep-scan.mjs merge-on-green.mjs ship-head-stability.mjs ship-dispatch-gate.mjs rework-loop-cap.mjs live-reverify.mjs repo-check.mjs ci-check.mjs sync-main.mjs event-id.mjs gate-state.mjs dead-session-escalation.mjs fix-contract.mjs package.json node_modules/
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

# CI/CD pipeline mode (PR #263): when set, buildAgentContext surfaces a
# "## Pipeline Mode" block so the CI/QA/release-manager blueprints read pipeline
# results instead of shelling builds/deploys. Only forwarded when explicitly set;
# absent → blueprints run their legacy self-run path.
PIPELINE_VARS=""
if [ -n "${PIPELINE_ENABLED:-}" ]; then
  PIPELINE_VARS=",PIPELINE_ENABLED=${PIPELINE_ENABLED}"
fi
# Which repos the hub merges + deploys is the CD registry (config/cd-registry.json
# in the artifact bucket, scripts/cd-registry.sh) — not an env var.

# Level-triggered dispatch (TEAM-4060): off | shadow | enforce. When enforce, the
# done-cascade invokes a newly-unblocked dependent IN-PROCESS instead of waiting
# for the Ready-status webhook round-trip — closes the dispatch dead-zone (the
# Ready->Ready no-op / dropped-webhook stall that idled work until the sweep).
# Code defaults OFF (pure webhook path, byte-identical to pre-4060); only forward
# an explicit override so a stale config.sh value can never silently flip it.
LEVEL_DISPATCH_VARS=""
if [ -n "${LEVEL_TRIGGER_DISPATCH:-}" ]; then
  LEVEL_DISPATCH_VARS=",LEVEL_TRIGGER_DISPATCH=${LEVEL_TRIGGER_DISPATCH}"
fi

# Merge-on-green (TEAM-4110) — forwarded only when explicitly set so an unset
# install stays default off (byte-identical; instant rollback = set to off).
MERGE_ON_GREEN_VARS=""
if [ -n "${MERGE_ON_GREEN:-}" ]; then
  MERGE_ON_GREEN_VARS=",MERGE_ON_GREEN=${MERGE_ON_GREEN}"
fi

# Ship-head stability gate (TEAM-4111): only forwarded when explicitly set, so a
# plain install stays default off (byte-identical; instant rollback = set off).
SHIP_HEAD_STABILITY_VARS=""
if [ -n "${SHIP_HEAD_STABILITY:-}" ]; then
  SHIP_HEAD_STABILITY_VARS=",SHIP_HEAD_STABILITY=${SHIP_HEAD_STABILITY}"
fi

# Ship-dispatch prerequisite gate (TEAM-4112): only forwarded when explicitly
# set, so a plain install stays default off (byte-identical; instant rollback =
# set off). Strict allow-list in code — a garbage value coalesces to off.
SHIP_DISPATCH_GATE_VARS=""
if [ -n "${SHIP_DISPATCH_GATE:-}" ]; then
  SHIP_DISPATCH_GATE_VARS=",SHIP_DISPATCH_GATE=${SHIP_DISPATCH_GATE}"
fi

# Rework-loop cap (TEAM-4113): only forwarded when explicitly set, so a plain
# install stays default off (byte-identical). Unlike the ship gates, a PRESENT-
# but-garbage value coalesces to SHADOW in code (observe-only) — an unbounded
# rework loop is the dangerous failure, so an unknown mode still measures.
REWORK_LOOP_CAP_VARS=""
if [ -n "${REWORK_LOOP_CAP:-}" ]; then
  REWORK_LOOP_CAP_VARS=",REWORK_LOOP_CAP=${REWORK_LOOP_CAP}"
fi

# Events-table double-write collapse (TEAM-4120 FR-2): only forwarded when
# explicitly set, so a plain install stays default off (byte-identical; instant
# rollback = set off). Strict allow-list in code — garbage / "shadow" → off.
# Forwarded to ALL THREE writers: the overwrite only happens when the
# orchestrator, the agent-invoker and the events-writer agree on the mode (one
# writer left in off would keep writing its own second row).
EVENT_DEDUPE_VARS=""
if [ -n "${EVENT_DEDUPE_MODE:-}" ]; then
  EVENT_DEDUPE_VARS=",EVENT_DEDUPE_MODE=${EVENT_DEDUPE_MODE}"
  echo "  EVENT_DEDUPE_MODE=${EVENT_DEDUPE_MODE} forwarded to orchestrator+agent-invoker+events-writer"
fi

# Review-gate state machine (TEAM-4120 FR-1): only forwarded when explicitly
# set, so a plain install stays default off (byte-identical — the guard returns
# before its first read; instant rollback = set off). Orchestrator ONLY: it is
# the sole writer/reader of gateStates — the agent-invoker and events-writer have
# no gate logic. Strict allow-list in code: garbage/legacy truthy → off, because
# the dangerous failure is DROPPING a human's Request-changes.
GATE_STATE_GUARD_VARS=""
if [ -n "${GATE_STATE_GUARD:-}" ]; then
  GATE_STATE_GUARD_VARS=",GATE_STATE_GUARD=${GATE_STATE_GUARD}"
  echo "  GATE_STATE_GUARD=${GATE_STATE_GUARD} forwarded to orchestrator"
fi

# Dead-session escalation tree (TEAM-4120 FR-3) — page → synthesize → park on an
# exhausted dead-session retry. Forwarded ONLY when explicitly set, so a plain
# install stays default OFF and both exhausted-retry emitters keep appending the
# bare manager_escalation notification (byte-identical). NOTE the asymmetry with
# the gate/ship guards: unset → off, but a PRESENT garbage value coalesces to
# SHADOW in code (normalizeEscalationMode), like REWORK_LOOP_CAP — the dangerous
# failure here is a silent no-op on a dead run, not an unwanted action.
# Instant rollback = set off.
DEAD_SESSION_ESCALATION_VARS=""
if [ -n "${DEAD_SESSION_ESCALATION_MODE:-}" ]; then
  DEAD_SESSION_ESCALATION_VARS=",DEAD_SESSION_ESCALATION_MODE=${DEAD_SESSION_ESCALATION_MODE}"
  echo "  DEAD_SESSION_ESCALATION_MODE=${DEAD_SESSION_ESCALATION_MODE} forwarded to orchestrator"
fi

# Live-evidence re-verification (TEAM-4121 FR-9) — files a Re-verify (QA)
# ticket per live-evidence fix at its head sha and marks a live fix with no live
# artifact `unverified` for the release manager's ## Unverified Fixes block.
# Forwarded ONLY when explicitly set, so a plain install stays default off
# (byte-identical: the module is never constructed and the done twins take no
# extra read). STRICT allow-list in code — a garbage value coalesces to OFF, not
# shadow, because enforce CREATES REAL TICKETS that dispatch an agent and block
# the run's ship tickets. Instant rollback = set off.
LIVE_REVERIFY_VARS=""
if [ -n "${LIVE_REVERIFY:-}" ]; then
  LIVE_REVERIFY_VARS=",LIVE_REVERIFY=${LIVE_REVERIFY}"
  echo "  LIVE_REVERIFY=${LIVE_REVERIFY} forwarded to orchestrator"
fi

# Repo URL pre-flight (repo-check.mjs reads env.REPO_CHECK_MODE, default
# process.env) — "off" disables the submit-time + dispatch-time GitHub check.
# .env.example has documented this since before TEAM-4122, but this Lambda
# never actually forwarded it, so setting it locally had no effect on the
# deployed function. Forwarded ONLY when explicitly set, so a plain install's
# deployed env is unchanged (byte-identical to before this fix).
REPO_CHECK_MODE_VARS=""
if [ -n "${REPO_CHECK_MODE:-}" ]; then
  REPO_CHECK_MODE_VARS=",REPO_CHECK_MODE=${REPO_CHECK_MODE}"
  echo "  REPO_CHECK_MODE=${REPO_CHECK_MODE} forwarded to orchestrator"
fi

# CI reachability pre-flight (TEAM-4122 FR-5): off | shadow | enforce. shadow
# probes CodeBuild + the pipeline-tools Lambda once per workflow and states the
# verdict in every persona's `## CI Certification` context; enforce additionally
# labels the epic `ci:uncertifiable` and prefixes the human merge-gate package.
# Forwarded ONLY when explicitly set, so a plain install stays default off —
# byte-identical: no probe, no CodeBuild/IAM SDK load (dynamic import), no
# context block. STRICT allow-list in code (garbage → off, not shadow) because
# enforce WRITES to a real ticket. The companions are only meaningful with a
# mode set, so they ride the same forward-when-set rule:
#   CI_CHECK_TTL_MS          override the 6h settled-verdict cache (unknown is
#                            always re-probed after 30min)
#   CI_CHECK_USE_IAM_SIMULATE=1  read the pipeline-tools ROLE's real policy for
#                            codebuild:StartBuild instead of trusting its
#                            self-reported capability. Needs the optional
#                            CiCheckSimulate grant (deploy/setup-lambda-role.sh).
#   CI_PROJECT_NAME          the CodeBuild PR-check project when it is not
#                            `agentcore-hub-ci` and the CD registry entry carries
#                            no `ciProject`.
#   PIPELINE_TOOLS_ROLE_ARN  the simulate target — without it simulate is skipped.
#   PIPELINE_TOOLS_LAMBDA    the capabilities probe target (default
#                            agentcore-hub-pipeline-tools).
# Instant rollback = set off (or unset and redeploy).
CI_CHECK_VARS=""
if [ -n "${CI_CHECK_MODE:-}" ]; then
  CI_CHECK_VARS=",CI_CHECK_MODE=${CI_CHECK_MODE}"
  echo "  CI_CHECK_MODE=${CI_CHECK_MODE} forwarded to orchestrator"
fi
if [ -n "${CI_CHECK_TTL_MS:-}" ]; then
  CI_CHECK_VARS="${CI_CHECK_VARS},CI_CHECK_TTL_MS=${CI_CHECK_TTL_MS}"
fi
if [ -n "${CI_CHECK_USE_IAM_SIMULATE:-}" ]; then
  CI_CHECK_VARS="${CI_CHECK_VARS},CI_CHECK_USE_IAM_SIMULATE=${CI_CHECK_USE_IAM_SIMULATE}"
fi
if [ -n "${CI_PROJECT_NAME:-}" ]; then
  CI_CHECK_VARS="${CI_CHECK_VARS},CI_PROJECT_NAME=${CI_PROJECT_NAME}"
fi
if [ -n "${PIPELINE_TOOLS_ROLE_ARN:-}" ]; then
  CI_CHECK_VARS="${CI_CHECK_VARS},PIPELINE_TOOLS_ROLE_ARN=${PIPELINE_TOOLS_ROLE_ARN}"
fi
if [ -n "${PIPELINE_TOOLS_LAMBDA:-}" ]; then
  CI_CHECK_VARS="${CI_CHECK_VARS},PIPELINE_TOOLS_LAMBDA=${PIPELINE_TOOLS_LAMBDA}"
fi

# Pre-CI default-branch sync (TEAM-4122 FR-6): off | shadow | enforce. The CI
# agent certifies the integration branch's head SHA, but the default branch has
# moved since the devs branched — so a green build certifies code that is not
# what would land. shadow = one compare read + a `workflow.sync_dry_run` event
# (it CANNOT tell whether the merge would conflict — only a merge can); enforce
# = merge the default branch INTO the feature branch immediately before the CI
# agent is dispatched, and on a 409 file a `Fix (sync-main)` sync_fix ticket that
# blocks the CI ticket until a dev resolves it. Needs GITHUB_PAT (no PAT = no-op).
# Forwarded ONLY when explicitly set, so a plain install stays default off —
# byte-identical: no GitHub call, no event, no write. STRICT allow-list in code
# (garbage → off, not shadow) because enforce PUSHES A COMMIT to a shared branch.
# Instant rollback = set off (or unset and redeploy).
SYNC_MAIN_BEFORE_CI_VARS=""
if [ -n "${SYNC_MAIN_BEFORE_CI:-}" ]; then
  SYNC_MAIN_BEFORE_CI_VARS=",SYNC_MAIN_BEFORE_CI=${SYNC_MAIN_BEFORE_CI}"
  echo "  SYNC_MAIN_BEFORE_CI=${SYNC_MAIN_BEFORE_CI} forwarded to orchestrator"
fi

# Advisory-ticket routing (TEAM-4122 FR-7): off | enforce. An "advisory" ticket is
# out-of-scope-but-worth-doing work the reviewers file as backlog. enforce makes
# the label mean what the blueprints promise: the ticket is excluded from every
# completion/open-fix gate, its dev is told to branch from and PR against the repo
# DEFAULT branch (`feature/<id>-advisory`), and such a branch is never adopted as
# a run's shared integration branch — so declined scope cannot ride into the
# unified PR. There is NO shadow: the routing IS the prompt the agent acts on, so
# observe-only would either lie to the agent or do nothing. Needs the `labels`
# param deployed on both ticket Lambdas and the runtime image (a run whose tickets
# carry no labels reads as non-advisory, i.e. exactly today's behaviour).
# Forwarded ONLY when explicitly set, so a plain install stays default off —
# byte-identical. STRICT allow-list in code (garbage → off).
# Instant rollback = set off (or unset and redeploy).
ADVISORY_ROUTING_VARS=""
if [ -n "${ADVISORY_ROUTING:-}" ]; then
  ADVISORY_ROUTING_VARS=",ADVISORY_ROUTING=${ADVISORY_ROUTING}"
  echo "  ADVISORY_ROUTING=${ADVISORY_ROUTING} forwarded to orchestrator"
fi

ENV_VARS_ORCH="Variables={ARTIFACT_BUCKET=${ARTIFACT_BUCKET},TICKETS_TABLE=${TICKETS_TABLE},WORKFLOWS_TABLE=${WORKFLOWS_TABLE},EVENTS_TABLE=${EVENTS_TABLE},TICKET_PROVIDER=${TICKET_PROVIDER},TICKET_TOOLS_LAMBDA=${TICKET_TOOLS_LAMBDA}${JIRA_VARS}${GITHUB_VARS}${LEASE_VARS}${DETECTOR_VARS}${CASCADE_VARS}${RECONCILE_VARS}${PIPELINE_VARS}${LEVEL_DISPATCH_VARS}${MERGE_ON_GREEN_VARS}${SHIP_HEAD_STABILITY_VARS}${SHIP_DISPATCH_GATE_VARS}${REWORK_LOOP_CAP_VARS}${EVENT_DEDUPE_VARS}${GATE_STATE_GUARD_VARS}${DEAD_SESSION_ESCALATION_VARS}${LIVE_REVERIFY_VARS}${REPO_CHECK_MODE_VARS}${CI_CHECK_VARS}${SYNC_MAIN_BEFORE_CI_VARS}${ADVISORY_ROUTING_VARS}}"
ENV_VARS_INVOKER="Variables={ARTIFACT_BUCKET=${ARTIFACT_BUCKET},TICKETS_TABLE=${TICKETS_TABLE},WORKFLOWS_TABLE=${WORKFLOWS_TABLE},EVENTS_TABLE=${EVENTS_TABLE},TICKET_PROVIDER=${TICKET_PROVIDER},TICKET_TOOLS_LAMBDA=${TICKET_TOOLS_LAMBDA}${EVENT_DEDUPE_VARS}}"
ENV_VARS_EVENTS="Variables={EVENTS_TABLE=${EVENTS_TABLE}${EVENT_DEDUPE_VARS}}"

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
# Mirrors DeadSessionSweepRule + permission in template.yaml. A scheduled rule
# (SWEEP_RATE, default rate(1 minute) since TEAM-4060 — see below) invokes the
# orchestrator with a sentinel payload; index.mjs branches on it
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

# rate(1 minute): with level-triggered dispatch (TEAM-4060) doing the happy-path
# hand-off in-process, the sweep is now a fast backstop for genuinely dropped
# cascades/webhooks — a 1-min cadence caps recovery latency at ~1 min instead of
# ~5. It stays cheap: each fire scans only active workflows and almost always
# finds everything skippedLiveLease. Override with SWEEP_RATE if needed.
SWEEP_RATE="${SWEEP_RATE:-rate(1 minute)}"
aws events put-rule \
  --name "$SWEEP_RULE" \
  --schedule-expression "$SWEEP_RATE" \
  --state ENABLED \
  --region "$AWS_REGION" \
  --output text --query 'RuleArn' >/dev/null
echo "  ✓ Rule $SWEEP_RULE upserted ($SWEEP_RATE)"

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
