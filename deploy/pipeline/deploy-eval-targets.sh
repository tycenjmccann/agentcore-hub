#!/usr/bin/env bash
# deploy-eval-targets.sh — DEPLOY.md steps 4-9 (evaluation infrastructure),
# invoked by buildspec-deploy.yml ONLY when the merged changeset touches eval
# files. Ordering per DEPLOY.md: packager (4) before rubric (6); alarms (8)
# last and gated on a healthy batch. See docs/cicd-pipeline-module-design.md.
#
# Step 4 (eval-packager Lambda, code-only) is pure AWS CLI and always runs here.
# Steps 5-9 need the `agentcore` CLI (and, for step 5, the fleet toolchain). If
# that CLI is not on PATH we FAIL LOUDLY (BLOCKED) rather than report success on
# stale eval code/config — the exact silent-skip Codex flagged (PR #263 round-2).
set -euo pipefail
: "${AWS_REGION_HUB:?}"

echo "── Eval step 4: eval-packager Lambda (code-only) ──"
( cd lambda/eval-packager && npm ci --omit=dev && \
  zip -qr /tmp/eval-packager.zip index.mjs package.json lib node_modules )
aws lambda update-function-code --function-name agentcore-hub-eval-packager \
  --zip-file fileb:///tmp/eval-packager.zip --region "$AWS_REGION_HUB"
aws lambda wait function-updated --function-name agentcore-hub-eval-packager --region "$AWS_REGION_HUB"
echo "eval-packager updated"

if ! command -v agentcore >/dev/null 2>&1; then
  echo "BLOCKED: eval steps 5-9 require the 'agentcore' CLI, which is not on PATH" >&2
  echo "         in this build image. The changeset touches eval infra, so a" >&2
  echo "         partial eval deploy (packager only) is NOT acceptable — failing" >&2
  echo "         so the release manager reports BLOCKED and a human runs DEPLOY.md" >&2
  echo "         steps 5-9, rather than the pipeline reporting success on stale" >&2
  echo "         evaluator config. Install the agentcore CLI in the deploy image" >&2
  echo "         to let the pipeline own these steps." >&2
  exit 1
fi

echo "── Eval step 5: runtime-agent fleet redeploy (telemetry) ──"
( cd deploy/runtime-agent && ./deploy-fleet.sh )

echo "── Eval step 6: evaluator rubric re-registration (after step 4) ──"
CUSTOM_EVALUATOR="$(grep -oE 'CUSTOM_EVALUATOR="[^"]+"' deploy/evaluations/setup-evaluations.sh | head -1 | sed -E 's/.*="([^"]+)"/\1/')"
if agentcore eval evaluator update --help >/dev/null 2>&1; then
  agentcore eval evaluator update --evaluator-id "$CUSTOM_EVALUATOR" \
    --config-file deploy/evaluations/dependency_chain_evaluator.json
else
  echo "agentcore CLI lacks 'evaluator update' — see DEPLOY.md step 6 fallback (manual)." >&2
  exit 1
fi

echo "── Eval step 7: reduced sampling/evaluator load profile ──"
./deploy/evaluations/setup-evaluations.sh

echo "── Eval step 8: health alarms (GATED on a non-zero batch) ──"
GATE_OK=1
for metric in EvalSessionsTotal EvalResultsTotal; do
  SUM="$(aws cloudwatch get-metric-statistics --namespace AgentCoreHub/Evaluations \
    --metric-name "$metric" --statistics Sum --period 86400 \
    --start-time "$(date -u -v-24H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)" \
    --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --query 'Datapoints[].Sum' --output text 2>/dev/null || true)"
  [ -z "$SUM" ] && GATE_OK=0
done
if [ "$GATE_OK" = "1" ]; then
  ALERT_TOPIC_ARN="$(aws sns create-topic --name agentcore-hub-alerts --query TopicArn --output text)"
  for alarm in throttle-rate-alarm span-missing-alarm span-missing-elevated-alarm; do
    [ -f "deploy/evaluations/${alarm}.json" ] && aws cloudwatch put-metric-alarm \
      --cli-input-json "file://deploy/evaluations/${alarm}.json" --alarm-actions "$ALERT_TOPIC_ARN"
  done
  echo "alarms applied"
else
  echo "── Alarm gate not met (no healthy batch yet) → STOP at step 8 (not failed, per DEPLOY.md) ──"
fi

echo "── Eval step 9: scorecard reset (after steps 4 and 6) ──"
for agent in agentcore_hub_requirements_analyst agentcore_hub_qa_verifier agentcore_hub_ci_agent; do
  aws dynamodb update-item --table-name agentcore-hub-eval-config \
    --key "{\"agentId\":{\"S\":\"$agent\"}}" \
    --update-expression 'REMOVE evalScores.#e' \
    --expression-attribute-names '{"#e":"dependency_chain_compliance_online"}' \
    --region "$AWS_REGION_HUB" || true
done
echo "eval targets complete"
