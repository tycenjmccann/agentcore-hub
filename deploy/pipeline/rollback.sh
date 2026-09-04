#!/usr/bin/env bash
# rollback.sh — restore prod to the pre-deploy snapshot captured by
# buildspec-deploy.yml's pre_build. Invoked automatically when the Deploy stage
# fails after partially applying (Codex PR #263 round-2 P1). Implements
# DEPLOY.md's manual rollback: re-point Lambda at the prior zip + ECS at the
# prior image digest. Idempotent + best-effort — a missing snapshot means that
# target was never touched, so there is nothing to undo.
set -uo pipefail
: "${AWS_REGION_HUB:?}"

echo "── ROLLBACK ──"

# 1. Orchestrator Lambdas → prior zip (same zip feeds orchestrator, agent-invoker
#    and events-writer — mirror Target 1 in buildspec-deploy.yml).
# --output text --query suppresses the full-config dump: update-function-code
# otherwise echoes plaintext env vars (JIRA_API_TOKEN, GITHUB_PAT) into the log.
if [ -f /tmp/rollback/orchestrator-prev.zip ]; then
  for FN in agentcore-hub-orchestrator agentcore-hub-agent-invoker agentcore-hub-events-writer; do
    echo "restoring $FN to prior zip"
    aws lambda update-function-code --function-name "$FN" \
      --zip-file fileb:///tmp/rollback/orchestrator-prev.zip --region "$AWS_REGION_HUB" \
      --output text --query 'LastUpdateStatus' >/dev/null \
      && aws lambda wait function-updated --function-name "$FN" --region "$AWS_REGION_HUB" \
      && echo "$FN rolled back" || echo "$FN rollback FAILED — inspect"
  done
else
  echo "no prior orchestrator zip — orchestrator Lambdas not rolled back (were they deployed this run?)"
fi

# 2. ECS Express → prior image digest
PREV_IMG="$(cat /tmp/rollback/ecs-prev-image.txt 2>/dev/null || true)"
if [ -n "${ECS_SERVICE_ARN:-}" ] && [ -n "$PREV_IMG" ]; then
  echo "restoring ECS to prior image: $PREV_IMG"
  DESC="$(aws ecs describe-express-gateway-service --service-arn "$ECS_SERVICE_ARN" --region "$AWS_REGION_HUB" --output json 2>/dev/null || echo '{}')"
  PRIMARY="$(python3 deploy/pipeline/ecs-primary-container.py "$DESC" "$PREV_IMG" 2>/dev/null)"
  if [ -n "$PRIMARY" ]; then
    aws ecs update-express-gateway-service --service-arn "$ECS_SERVICE_ARN" \
      --region "$AWS_REGION_HUB" --primary-container "$PRIMARY" --output text >/dev/null \
      && echo "ECS rolled back" || echo "ECS rollback FAILED — inspect"
  else
    echo "could not describe live service — ECS rollback skipped, manual intervention required"
  fi
else
  echo "no prior ECS image snapshot — ECS not rolled back"
fi

# Config (agents.json) is S3-versioned; DEPLOY.md restores it from an object
# version manually. Not auto-reverted here (a merged config is rarely the cause
# of a deploy failure, and blind revert could undo a legitimate roster change) —
# surfaced for the operator instead.
echo "NOTE: S3 config/*.json is versioned; restore manually from a prior object version if the config merge was at fault (DEPLOY.md rollback)."
echo "── ROLLBACK COMPLETE ──"
