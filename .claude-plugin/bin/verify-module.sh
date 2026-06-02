#!/usr/bin/env bash
# Smoke-checks that a module's resources actually exist after run-module.sh.
# Exits 0 on pass, non-zero on fail with a human-readable message.
#
# Usage: verify-module.sh <core|builder|workflow|evaluations>

set -euo pipefail

MODULE="${1:-}"
if [[ -z "$MODULE" ]]; then
  echo "Usage: $0 <core|builder|workflow|evaluations>" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

: "${AWS_REGION:?AWS_REGION must be set}"
: "${AWS_PROFILE:=default}"
export AWS_PROFILE AWS_REGION

# Source .env.local so verify can read values persisted by run-module.sh
# (e.g., BUILDER_AGENT_ID written after a successful builder deploy).
if [[ -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

fail() { echo "✗ $MODULE verification failed: $1" >&2; exit 1; }
pass() { echo "✓ $MODULE verified: $1"; }

case "$MODULE" in
  core)
    aws sts get-caller-identity --output text >/dev/null \
      || fail "aws sts get-caller-identity returned non-zero"
    pass "AWS credentials resolve"
    ;;

  builder)
    # run-module.sh persists BUILDER_AGENT_ID after the deploy script's own
    # post-deploy invocation succeeds — that *is* the proof the runtime works.
    # We re-confirm via AgentCore Control List API only when the local CLI
    # supports it; otherwise we trust the persisted ID and report the CLI gap.
    if [[ -z "${BUILDER_AGENT_ID:-}" ]]; then
      fail "BUILDER_AGENT_ID not in .env.local — run 'run-module.sh builder' first"
    fi

    # The builder is a HARNESS, not a runtime. AgentCore auto-provisions a
    # runtime sibling (harness_agentcore_hub_builder-…) under the hood — that's
    # not what /build invokes, so we don't probe for it here.
    list_output=$(aws bedrock-agentcore-control list-harnesses \
      --region "$AWS_REGION" 2>&1) || list_status=$?
    if [[ "${list_status:-0}" -ne 0 ]]; then
      if echo "$list_output" | grep -qE "Invalid choice|valid choices are"; then
        # CLI lacks bedrock-agentcore-control. Fall back to a positive check
        # via the SDK using the persisted BUILDER_AGENT_ID — this actually
        # verifies the harness exists and is READY, instead of trusting the
        # deploy script's earlier output.
        echo "  AWS CLI ($(aws --version 2>&1)) lacks bedrock-agentcore-control;" \
             "verifying via SDK GetHarness instead."
        sdk_output=$(BUILDER_AGENT_ID="$BUILDER_AGENT_ID" AWS_REGION="$AWS_REGION" \
          node --input-type=module -e '
            import("@aws-sdk/client-bedrock-agentcore-control").then(async ({ BedrockAgentCoreControlClient, GetHarnessCommand }) => {
              const c = new BedrockAgentCoreControlClient({ region: process.env.AWS_REGION });
              const r = await c.send(new GetHarnessCommand({ harnessId: process.env.BUILDER_AGENT_ID }));
              const status = r.harness?.status || "UNKNOWN";
              const name = r.harness?.harnessName || "";
              if (status !== "READY") { console.error(`status=${status} name=${name}`); process.exit(2); }
              console.log(`status=READY name=${name}`);
            }).catch(e => { console.error(e.name + ": " + e.message); process.exit(3); });
          ' 2>&1) || sdk_status=$?
        if [[ "${sdk_status:-0}" -ne 0 ]]; then
          echo "$sdk_output" >&2
          fail "GetHarness check failed for BUILDER_AGENT_ID=$BUILDER_AGENT_ID"
        fi
        pass "harness $BUILDER_AGENT_ID READY ($sdk_output)"
      else
        echo "$list_output" >&2
        fail "list-harnesses returned non-zero"
      fi
    elif echo "$list_output" | grep -q "agentcore_hub_builder"; then
      pass "agentcore_hub_builder harness is registered"
    else
      fail "agentcore_hub_builder harness not found via list-harnesses"
    fi
    ;;

  workflow)
    aws dynamodb describe-table --table-name agentcore-hub-workflows --region "$AWS_REGION" >/dev/null 2>&1 \
      || fail "agentcore-hub-workflows table not found"
    aws dynamodb describe-table --table-name agentcore-hub-events --region "$AWS_REGION" >/dev/null 2>&1 \
      || fail "agentcore-hub-events table not found"

    # deploy-fleet.sh writes a flat map: { "agentcore_hub_<agent>": "arn:aws:..." , ... }
    if [[ -f deploy/runtime-agent/fleet-runtime-ids.json ]]; then
      if command -v jq >/dev/null 2>&1; then
        runtime_count=$(jq '[to_entries[] | select(.value | startswith("arn:aws:bedrock-agentcore:"))] | length' \
          deploy/runtime-agent/fleet-runtime-ids.json 2>/dev/null || echo 0)
      else
        runtime_count=$(grep -cE '"arn:aws:bedrock-agentcore:' deploy/runtime-agent/fleet-runtime-ids.json || true)
      fi
      [[ "$runtime_count" -gt 0 ]] || fail "fleet-runtime-ids.json contains no runtime ARNs"
    else
      fail "deploy/runtime-agent/fleet-runtime-ids.json not produced by deploy-fleet.sh"
    fi

    # ── Trigger wiring (existence-only checks let the previous install ship broken) ──
    # The Lambdas are deployed but idle if the DynamoDB Stream event source
    # mapping is missing or DISABLED, or if the EventBridge rule has no target.
    aws lambda get-function --function-name agentcore-hub-orchestrator --region "$AWS_REGION" >/dev/null 2>&1 \
      || fail "agentcore-hub-orchestrator Lambda not found"
    aws lambda get-function --function-name agentcore-hub-events-writer --region "$AWS_REGION" >/dev/null 2>&1 \
      || fail "agentcore-hub-events-writer Lambda not found"

    # The DynamoDB Stream → orchestrator wiring only exists for the dynamodb
    # ticket provider. With TICKET_PROVIDER=jira, run-module.sh skips the
    # tickets table (--with-tickets) and the orchestrator is driven by the
    # Jira webhook instead (lambda/orchestrator/index.mjs handles
    # source === "jira-webhook"), so requiring the stream here would fail a
    # valid Jira install.
    if [[ "${TICKET_PROVIDER:-dynamodb}" == "dynamodb" ]]; then
      stream_arn=$(aws dynamodb describe-table --table-name agentcore-hub-tickets \
        --region "$AWS_REGION" --query 'Table.LatestStreamArn' --output text 2>/dev/null || true)
      if [[ -z "$stream_arn" || "$stream_arn" == "None" ]]; then
        fail "agentcore-hub-tickets has no DynamoDB Stream — orchestrator will never be triggered"
      fi

      esm_state=$(aws lambda list-event-source-mappings \
        --function-name agentcore-hub-orchestrator \
        --region "$AWS_REGION" \
        --query "EventSourceMappings[?starts_with(EventSourceArn, \`${stream_arn%/*}\`)].State | [0]" \
        --output text 2>/dev/null || true)
      if [[ -z "$esm_state" || "$esm_state" == "None" ]]; then
        fail "no DynamoDB Stream event source mapping on agentcore-hub-orchestrator (orchestrator is idle)"
      fi
      if [[ "$esm_state" != "Enabled" ]]; then
        fail "orchestrator stream mapping is in state '$esm_state' (expected Enabled)"
      fi
    else
      echo "  TICKET_PROVIDER=$TICKET_PROVIDER — skipping DynamoDB Stream checks (orchestrator is driven by the Jira webhook)"
    fi

    # EventBridge rule -> events-writer wiring
    rule_targets=$(aws events list-targets-by-rule \
      --rule agentcore-hub-workflow-events \
      --region "$AWS_REGION" \
      --query 'Targets[].Arn' --output text 2>/dev/null || true)
    if [[ -z "$rule_targets" ]]; then
      fail "EventBridge rule agentcore-hub-workflow-events has no targets (events-writer will never fire)"
    fi
    case "$rule_targets" in
      *agentcore-hub-events-writer*) : ;;
      *) fail "agentcore-hub-events-writer is not a target of agentcore-hub-workflow-events (got: $rule_targets)" ;;
    esac

    if [[ -f deploy/runtime-agent/verify-fleet.sh ]]; then
      echo "→ Running quick fleet smoke test (one invocation per agent)"
      (cd deploy/runtime-agent && ./verify-fleet.sh) \
        || fail "verify-fleet.sh reported failures"
    fi
    pass "tables + fleet ARNs + trigger wiring (TICKET_PROVIDER=${TICKET_PROVIDER:-dynamodb}) + EventBridge target + quick fleet invocation"
    ;;

  evaluations)
    aws dynamodb describe-table --table-name agentcore-hub-eval-config --region "$AWS_REGION" >/dev/null 2>&1 \
      || fail "agentcore-hub-eval-config table not found"
    aws lambda get-function --function-name agentcore-hub-eval-packager --region "$AWS_REGION" >/dev/null 2>&1 \
      || fail "agentcore-hub-eval-packager Lambda not found"

    # docs/MODULES.md lists three eval Lambdas. Existence-only verification on
    # eval-packager is what let the previous install ship without
    # token-aggregator and prd-submitter.
    aws lambda get-function --function-name agentcore-hub-token-aggregator --region "$AWS_REGION" >/dev/null 2>&1 \
      || fail "agentcore-hub-token-aggregator Lambda not found (deploy/continuous-improvement/deploy-token-aggregator.sh did not run?)"
    aws lambda get-function --function-name agentcore-hub-prd-submitter --region "$AWS_REGION" >/dev/null 2>&1 \
      || fail "agentcore-hub-prd-submitter Lambda not found"

    # Token-aggregator is invoked by an EventBridge weekly cron rule. The rule
    # must have a target attached or the cron fires into the void.
    token_targets=$(aws events list-targets-by-rule \
      --rule agentcore-hub-token-reset-weekly \
      --region "$AWS_REGION" \
      --query 'Targets[].Arn' --output text 2>/dev/null || true)
    if [[ -z "$token_targets" ]]; then
      fail "EventBridge rule agentcore-hub-token-reset-weekly has no targets (weekly counter reset will never fire)"
    fi
    case "$token_targets" in
      *agentcore-hub-token-aggregator*) : ;;
      *) fail "agentcore-hub-token-aggregator is not a target of agentcore-hub-token-reset-weekly (got: $token_targets)" ;;
    esac

    # prd-submitter is invoked by an EventBridge S3-PutObject rule.
    prd_targets=$(aws events list-targets-by-rule \
      --rule agentcore-hub-prd-submitter-trigger \
      --region "$AWS_REGION" \
      --query 'Targets[].Arn' --output text 2>/dev/null || true)
    if [[ -z "$prd_targets" ]]; then
      fail "EventBridge rule agentcore-hub-prd-submitter-trigger has no targets (PRDs uploaded to S3 will never start a workflow)"
    fi
    case "$prd_targets" in
      *agentcore-hub-prd-submitter*) : ;;
      *) fail "agentcore-hub-prd-submitter is not a target of agentcore-hub-prd-submitter-trigger (got: $prd_targets)" ;;
    esac

    pass "eval-config table + 3 Lambdas (eval-packager, token-aggregator, prd-submitter) + 2 EventBridge targets"
    ;;

  *)
    echo "Unknown module: $MODULE" >&2
    exit 2
    ;;
esac
