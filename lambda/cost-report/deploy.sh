#!/bin/bash
# Deploy the performance-card Lambda (function name agentcore-hub-cost-report).
#
#   ./lambda/cost-report/deploy.sh                 # code + env + IAM
#   ./lambda/cost-report/deploy.sh --rebuild-index # ...then rebuild performance/index.json
#   ./lambda/cost-report/deploy.sh --backfill      # ...then (re)generate a card for every
#                                                  #   terminal workflow, then rebuild index
#
# Idempotent. Sources deploy/config.sh for account/region/table names — nothing
# is hardcoded. The EventBridge rule (workflow.complete → this Lambda) is created
# by the original setup and left untouched here.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
source "$REPO_ROOT/deploy/config.sh"

FN="${COST_REPORT_FUNCTION:-agentcore-hub-cost-report}"
ROLE_NAME="$(basename "$LAMBDA_ROLE_ARN")"
CODING_LOG_GROUP="${CODING_RUNTIME_LOG_GROUP:-$(aws lambda get-function-configuration --function-name "$FN" --region "$AWS_REGION" \
  --query 'Environment.Variables.CODING_RUNTIME_LOG_GROUP' --output text 2>/dev/null || true)}"
[[ "$CODING_LOG_GROUP" == "None" ]] && CODING_LOG_GROUP=""

echo "==> Packaging lambda/cost-report"
ZIP="$(mktemp -t perf-card).zip"
( cd "$REPO_ROOT/lambda/cost-report" && zip -q -j "$ZIP" index.mjs )

echo "==> IAM: $ROLE_NAME PerformanceCardMetrics (PutMetricData / GetMetricData / Cost Explorer read)"
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name PerformanceCardMetrics --policy-document "$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "cloudwatch:PutMetricData", "Resource": "*",
      "Condition": { "StringEquals": { "cloudwatch:namespace": "AgentCoreHub/Performance" } } },
    { "Effect": "Allow", "Action": ["cloudwatch:GetMetricData", "cloudwatch:ListMetrics"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["ce:GetCostAndUsage"], "Resource": "*" }
  ]
}
EOF
)"

echo "==> Code: $FN"
aws lambda update-function-code --function-name "$FN" --zip-file "fileb://$ZIP" --region "$AWS_REGION" --output text --query 'LastModified'
aws lambda wait function-updated --function-name "$FN" --region "$AWS_REGION"

echo "==> Env"
ENV_JSON=$(python3 - "$ARTIFACT_BUCKET" "$WORKFLOWS_TABLE" "$EVENTS_TABLE" "$CLOUD_CODE_TABLE" "$CODING_LOG_GROUP" "$AWS_REGION" <<'PY'
import json, sys
b, wf, ev, cc, lg, region = sys.argv[1:7]
env = {
  "ARTIFACT_BUCKET": b, "WORKFLOWS_TABLE": wf, "EVENTS_TABLE": ev, "CLOUD_CODE_TABLE": cc,
  "PRICING_S3_KEY": "config/pricing.json", "PERFORMANCE_INDEX_KEY": "performance/index.json",
  "METRIC_NAMESPACE": "AgentCoreHub/Performance", "PUBLISH_CW_METRICS": "1", "INFRA_REGION": region,
}
if lg: env["CODING_RUNTIME_LOG_GROUP"] = lg
print(json.dumps({"Variables": env}))
PY
)
aws lambda update-function-configuration --function-name "$FN" --region "$AWS_REGION" \
  --timeout 600 --memory-size 512 --environment "$ENV_JSON" --output text --query 'LastModified'
aws lambda wait function-updated --function-name "$FN" --region "$AWS_REGION"

echo "==> Sync pricing.json → s3://$ARTIFACT_BUCKET/config/pricing.json"
aws s3 cp "$REPO_ROOT/src/config/pricing.json" "s3://$ARTIFACT_BUCKET/config/pricing.json" --region "$AWS_REGION" --only-show-errors

invoke() {
  local payload="$1" out
  out="$(mktemp -t perf-card-out)"
  aws lambda invoke --function-name "$FN" --region "$AWS_REGION" --cli-read-timeout 620 \
    --payload "$payload" --cli-binary-format raw-in-base64-out "$out" >/dev/null
  cat "$out"; echo
}

if [[ "${1:-}" == "--backfill" ]]; then
  echo "==> Backfill: one card per terminal workflow (5 in flight)"
  aws dynamodb scan --table-name "$WORKFLOWS_TABLE" --region "$AWS_REGION" --output json \
    --projection-expression "workflowId, phase, deleted" \
  | python3 -c '
import json, sys
T = {"complete","cancelled","error","deploy-blocked","static-ci-only"}
for i in json.load(sys.stdin)["Items"]:
    if i.get("deleted",{}).get("BOOL") or i.get("phase",{}).get("S") not in T: continue
    print(i["workflowId"]["S"])' \
  | xargs -P 5 -I{} bash -c "aws lambda invoke --function-name $FN --region $AWS_REGION --cli-read-timeout 620 --payload '{\"workflowId\":\"{}\"}' --cli-binary-format raw-in-base64-out /dev/null >/dev/null && echo '  {}'"
  set -- --rebuild-index
fi

if [[ "${1:-}" == "--rebuild-index" ]]; then
  echo "==> Rebuild index + bands + infra"
  invoke '{"rebuildIndex":true,"refreshInfra":true}'
fi

echo "✓ $FN deployed"
