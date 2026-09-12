#!/bin/bash
# Deploy the performance-card Lambda (function name agentcore-hub-cost-report).
#
#   ./lambda/cost-report/deploy.sh                              # code + env + IAM
#   ./lambda/cost-report/deploy.sh --rebuild-index               # ...then rebuild performance/index.json
#   ./lambda/cost-report/deploy.sh --backfill [--since-days N]   # ...then (re)generate a card for every
#                                                                #   terminal workflow completed in the
#                                                                #   last N days (default 90; 0 = all time),
#                                                                #   then rebuild index
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
# kpi.json is a git symlink to src/config/kpi.json; -j (no -y) stores its
# CONTENTS at the zip root, so the deployed function sees a real file, not a link.
( cd "$REPO_ROOT/lambda/cost-report" && zip -q -j "$ZIP" index.mjs kpi.json )

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

# Floor of 5: --backfill below fires sync invokes through `xargs -P 5`, and an
# unbounded concurrency limit here would let a large backfill starve the rest
# of the account's Lambda concurrency pool.
aws lambda put-function-concurrency --function-name "$FN" --region "$AWS_REGION" \
  --reserved-concurrent-executions "${COST_REPORT_RESERVED_CONCURRENCY:-5}"

echo "==> Sync pricing.json → s3://$ARTIFACT_BUCKET/config/pricing.json"
aws s3 cp "$REPO_ROOT/src/config/pricing.json" "s3://$ARTIFACT_BUCKET/config/pricing.json" --region "$AWS_REGION" --only-show-errors

# The Lambda never reads this — it loads the bundled kpi.json (see loadKpiConfig
# in index.mjs). This copy is for humans and the Workflow Manager toolkit, which
# reads config/kpi.json to know the current kpiVersion without invoking the
# function.
echo "==> Sync kpi.json → s3://$ARTIFACT_BUCKET/config/kpi.json"
aws s3 cp "$REPO_ROOT/src/config/kpi.json" "s3://$ARTIFACT_BUCKET/config/kpi.json" --region "$AWS_REGION" --only-show-errors

invoke() {
  local payload="$1" out
  out="$(mktemp -t perf-card-out)"
  aws lambda invoke --function-name "$FN" --region "$AWS_REGION" --cli-read-timeout 620 \
    --payload "$payload" --cli-binary-format raw-in-base64-out "$out" >/dev/null
  cat "$out"; echo
}

if [[ "${1:-}" == "--backfill" ]]; then
  export SINCE_DAYS="90"
  if [[ "${2:-}" == "--since-days" ]]; then
    SINCE_DAYS="${3:?--since-days requires N}"
    export SINCE_DAYS
  fi
  if [[ "$SINCE_DAYS" == "0" ]]; then
    WINDOW_LABEL="all time"
  else
    WINDOW_LABEL="the last ${SINCE_DAYS}d"
  fi
  echo "==> Backfill: one card per terminal workflow completed in $WINDOW_LABEL (5 in flight)"

  CANDIDATES="$(mktemp -t perf-card-candidates)"
  aws dynamodb scan --table-name "$WORKFLOWS_TABLE" --region "$AWS_REGION" --output json \
    --projection-expression "workflowId, phase, deleted, completedAt, startedAt" \
  | python3 -c '
import json, sys, os, datetime
T = {"complete","cancelled","error","deploy-blocked","static-ci-only"}
days = int(os.environ.get("SINCE_DAYS", "90"))
cut = None if days == 0 else (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)).isoformat()
for i in json.load(sys.stdin)["Items"]:
    if i.get("deleted", {}).get("BOOL"): continue
    if i.get("phase", {}).get("S") not in T: continue
    ts = i.get("completedAt", {}).get("S") or i.get("startedAt", {}).get("S") or ""
    if cut and ts < cut: continue
    print(i["workflowId"]["S"])' > "$CANDIDATES"

  CANDIDATE_COUNT="$(wc -l < "$CANDIDATES" | tr -d ' ')"
  INVOKED="$(xargs -P 5 -I{} bash -c "aws lambda invoke --function-name $FN --region $AWS_REGION --cli-read-timeout 620 --payload '{\"workflowId\":\"{}\"}' --cli-binary-format raw-in-base64-out /dev/null >/dev/null && echo '  {}'" < "$CANDIDATES")"
  rm -f "$CANDIDATES"
  [[ -n "$INVOKED" ]] && echo "$INVOKED"
  OK_COUNT="$(grep -c . <<<"$INVOKED" || true)"

  echo "backfill: ${OK_COUNT}/${CANDIDATE_COUNT} cards regenerated in $WINDOW_LABEL"
  if [[ "$CANDIDATE_COUNT" -gt 0 ]]; then
    PCT="$(python3 -c "print(round(100*${OK_COUNT}/${CANDIDATE_COUNT}))")"
    if [[ "$PCT" -lt 95 ]]; then
      echo "WARNING: only ${PCT}% of candidates were regenerated — check the invoke failures above"
    fi
  fi
  set -- --rebuild-index
fi

if [[ "${1:-}" == "--rebuild-index" ]]; then
  echo "==> Rebuild index + bands + infra"
  invoke '{"rebuildIndex":true,"refreshInfra":true}'
fi

echo "✓ $FN deployed"
