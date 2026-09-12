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
# Flags may appear in any order; --since-days only applies to --backfill, and an
# unrecognised argument is a usage error (exit 2) raised before anything deploys.
#
# --backfill tolerates per-invoke failure: it records every failed workflowId with
# a reason (CLI error vs the Lambda's own FunctionError), retries throttles with
# backoff, and always goes on to rebuild the index. The coverage line it prints
# afterwards is measured from the *rebuilt index* — the cards that actually exist —
# never from invoke exit codes.
#
# Idempotent. Sources deploy/config.sh for account/region/table names — nothing
# is hardcoded. The EventBridge rule (workflow.complete → this Lambda) is created
# by the original setup and left untouched here.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# `mktemp -t <prefix>` is the BSD form; GNU coreutils reads the argument as a
# template and rejects it for having no X's, so that spelling fails outright on
# Linux (CI, CodeBuild). Spell the template out — portable to both.
mktmp()  { mktemp    "${TMPDIR:-/tmp}/perf-card.$1.XXXXXX"; }
mktmpd() { mktemp -d "${TMPDIR:-/tmp}/perf-card.$1.XXXXXX"; }

usage() {
  cat <<'USAGE'
usage: lambda/cost-report/deploy.sh [--backfill [--since-days N]] [--rebuild-index]

  (no flags)                    deploy code + env + IAM only
  --rebuild-index               ...then rebuild performance/index.json + bands + infra
  --backfill [--since-days N]   ...then (re)generate a card for every terminal
                                workflow completed in the last N days
                                (default 90; 0 = all time), then rebuild the index
USAGE
}

# Parsed before deploy/config.sh is sourced, so a typo costs no AWS call and
# deploys nothing.
DO_BACKFILL=0
DO_REBUILD=0
SINCE_DAYS=90
SINCE_DAYS_SET=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --backfill)      DO_BACKFILL=1; shift ;;
    --rebuild-index) DO_REBUILD=1; shift ;;
    --since-days)
      if [[ $# -lt 2 ]]; then
        echo "--since-days requires N" >&2; usage >&2; exit 2
      fi
      SINCE_DAYS="$2"; SINCE_DAYS_SET=1; shift 2 ;;
    -h|--help)       usage; exit 0 ;;
    *)               echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
if [[ ! "$SINCE_DAYS" =~ ^[0-9]+$ ]]; then
  echo "--since-days needs a non-negative integer, got '$SINCE_DAYS'" >&2; usage >&2; exit 2
fi
if (( SINCE_DAYS_SET )) && (( DO_BACKFILL == 0 )); then
  echo "--since-days only applies to --backfill" >&2; usage >&2; exit 2
fi
# A backfill is only meaningful once the index is rebuilt from the new cards.
if (( DO_BACKFILL )); then DO_REBUILD=1; fi

if (( SINCE_DAYS == 0 )); then
  WINDOW_LABEL="all time"
else
  WINDOW_LABEL="the last ${SINCE_DAYS}d"
fi
# One cutoff, computed once: the candidate scan and the coverage count use the
# same string, so a backfill that takes minutes cannot move the goalposts between
# its numerator and its denominator. Emitted with a Z suffix to match the
# `new Date().toISOString()` timestamps stored in completedAt — python's
# isoformat() would emit +00:00, which loses a lexical compare at the boundary
# second.
CUTOFF_ISO=""
if (( SINCE_DAYS > 0 )); then
  CUTOFF_ISO="$(python3 -c 'import sys,datetime as d; print((d.datetime.now(d.timezone.utc)-d.timedelta(days=int(sys.argv[1]))).strftime("%Y-%m-%dT%H:%M:%SZ"))' "$SINCE_DAYS")"
fi

# shellcheck disable=SC1091
source "$REPO_ROOT/deploy/config.sh"

FN="${COST_REPORT_FUNCTION:-agentcore-hub-cost-report}"
ROLE_NAME="$(basename "$LAMBDA_ROLE_ARN")"
# One name for the index key: it configures the Lambda AND is the object this
# script reads back for the coverage line, so the two can never diverge.
INDEX_KEY="performance/index.json"
CODING_LOG_GROUP="${CODING_RUNTIME_LOG_GROUP:-$(aws lambda get-function-configuration --function-name "$FN" --region "$AWS_REGION" \
  --query 'Environment.Variables.CODING_RUNTIME_LOG_GROUP' --output text 2>/dev/null || true)}"
[[ "$CODING_LOG_GROUP" == "None" ]] && CODING_LOG_GROUP=""

echo "==> Packaging lambda/cost-report"
ZIP="$(mktmp pkg).zip"
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
ENV_JSON=$(python3 - "$ARTIFACT_BUCKET" "$WORKFLOWS_TABLE" "$EVENTS_TABLE" "$CLOUD_CODE_TABLE" "$CODING_LOG_GROUP" "$AWS_REGION" "$INDEX_KEY" <<'PY'
import json, sys
b, wf, ev, cc, lg, region, index_key = sys.argv[1:8]
env = {
  "ARTIFACT_BUCKET": b, "WORKFLOWS_TABLE": wf, "EVENTS_TABLE": ev, "CLOUD_CODE_TABLE": cc,
  "PRICING_S3_KEY": "config/pricing.json", "PERFORMANCE_INDEX_KEY": index_key,
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
  out="$(mktmp out)"
  aws lambda invoke --function-name "$FN" --region "$AWS_REGION" --cli-read-timeout 620 \
    --payload "$payload" --cli-binary-format raw-in-base64-out "$out" >/dev/null
  cat "$out"; echo
}

# One backfill invoke. Writes its verdict to a file under $RESULT_DIR (one file per
# workflowId, so counting is exact under `xargs -P`) and ALWAYS returns 0 — a
# non-zero exit here would make xargs treat the id as fatal, abandon the rest of
# the queue and fail the script before the index rebuild.
#
# Success is the absence of a FunctionError, not the CLI's exit code: `aws lambda
# invoke` exits 0 on an HTTP 200 whose body carries FunctionError "Unhandled".
# `--query FunctionError --output text` prints `None` when the field is absent.
backfill_one() {
  local id="$1" slug attempt=1 rc fnerr out err
  slug="$(printf '%s' "$id" | tr -c '[:alnum:]._-' '_')"
  out="$RESULT_DIR/payload.$slug"
  err="$RESULT_DIR/stderr.$slug"
  while :; do
    rc=0
    fnerr="$(aws lambda invoke --function-name "$FN" --region "$AWS_REGION" --cli-read-timeout 620 \
      --payload "{\"workflowId\":\"$id\"}" --cli-binary-format raw-in-base64-out \
      --query FunctionError --output text "$out" 2>"$err")" || rc=$?
    if (( rc == 0 )); then break; fi
    # Bounded retry with backoff, throttles only — everything else is recorded.
    if (( attempt < MAX_ATTEMPTS )) && grep -qE 'TooManyRequestsException|ThrottlingException|Rate exceeded' "$err"; then
      sleep $(( 2 ** attempt ))
      attempt=$(( attempt + 1 ))
      continue
    fi
    printf '%s\tcli-exit-%s\t%s\n' "$id" "$rc" "$(head -c 200 "$err" 2>/dev/null | tr '\n\t' '  ')" \
      > "$RESULT_DIR/failed/$slug"
    rm -f "$out" "$err"
    return 0
  done
  if [[ -n "$fnerr" && "$fnerr" != "None" ]]; then
    printf '%s\tFunctionError:%s\t%s\n' "$id" "$fnerr" "$(head -c 200 "$out" 2>/dev/null | tr '\n\t' '  ')" \
      > "$RESULT_DIR/failed/$slug"
  else
    printf '%s\n' "$id" > "$RESULT_DIR/ok/$slug"
  fi
  rm -f "$out" "$err"
  return 0
}

CANDIDATE_COUNT=0
FAIL_COUNT=0
RESULT_DIR=""
cleanup_results() { [[ -n "$RESULT_DIR" && "$FAIL_COUNT" -eq 0 ]] && rm -rf "$RESULT_DIR"; return 0; }
trap cleanup_results EXIT

if (( DO_BACKFILL )); then
  echo "==> Backfill: one card per terminal workflow completed in $WINDOW_LABEL (5 in flight)"

  CANDIDATES="$(mktmp candidates)"
  aws dynamodb scan --table-name "$WORKFLOWS_TABLE" --region "$AWS_REGION" --output json \
    --projection-expression "workflowId, phase, deleted, completedAt, startedAt" \
  | CUTOFF_ISO="$CUTOFF_ISO" python3 -c '
import json, sys, os
T = {"complete","cancelled","error","deploy-blocked","static-ci-only"}
cut = os.environ.get("CUTOFF_ISO") or None
for i in json.load(sys.stdin)["Items"]:
    if i.get("deleted", {}).get("BOOL"): continue
    if i.get("phase", {}).get("S") not in T: continue
    ts = i.get("completedAt", {}).get("S") or i.get("startedAt", {}).get("S") or ""
    if cut and ts < cut: continue
    print(i["workflowId"]["S"])' > "$CANDIDATES"

  CANDIDATE_COUNT="$(grep -c . < "$CANDIDATES" || true)"
  RESULT_DIR="$(mktmpd results)"
  mkdir -p "$RESULT_DIR/ok" "$RESULT_DIR/failed"
  MAX_ATTEMPTS="${COST_REPORT_BACKFILL_ATTEMPTS:-3}"
  export FN AWS_REGION RESULT_DIR MAX_ATTEMPTS
  export -f backfill_one

  # `|| true`: xargs exits non-zero when a worker does. The worker never does, but
  # set -e must not be able to skip the index rebuild even if that changes.
  xargs -P "${COST_REPORT_BACKFILL_PARALLEL:-5}" -I{} \
    bash -c 'backfill_one "$1"' _ {} < "$CANDIDATES" || true
  rm -f "$CANDIDATES"

  OK_COUNT="$(find "$RESULT_DIR/ok" -type f | wc -l | tr -d ' ')"
  FAIL_COUNT="$(find "$RESULT_DIR/failed" -type f | wc -l | tr -d ' ')"
  echo "backfill: invoked ${OK_COUNT}/${CANDIDATE_COUNT} ok, ${FAIL_COUNT} failed"
  if (( FAIL_COUNT > 0 )); then
    # Collect first, print second: piping find|head under `pipefail` would let a
    # SIGPIPE on the truncated side abort the script before the index rebuild.
    find "$RESULT_DIR/failed" -type f -exec cat {} + > "$RESULT_DIR/failures.tsv" 2>/dev/null || true
    while IFS=$'\t' read -r id reason detail; do
      echo "  FAILED $id  $reason  $detail"
    done < <(head -20 "$RESULT_DIR/failures.tsv")
    if (( FAIL_COUNT > 20 )); then echo "  ... and $(( FAIL_COUNT - 20 )) more"; fi
    echo "  full failure list: $RESULT_DIR/failed"
  fi
fi

if (( DO_REBUILD )); then
  echo "==> Rebuild index + bands + infra"
  invoke '{"rebuildIndex":true,"refreshInfra":true}'
fi

if (( DO_BACKFILL )); then
  # Coverage is measured from the rebuilt index, i.e. from cards that provably
  # exist — not from invoke exit codes. rebuildIndex only admits cards whose
  # reportVersion === REPORT_VERSION (index.mjs), so every row in the index is a
  # current-version card and the only filter left to apply here is the window.
  REPORT_VERSION="$(grep -oE 'REPORT_VERSION = [0-9]+' "$REPO_ROOT/lambda/cost-report/index.mjs" | grep -oE '[0-9]+$' | head -1)"
  INDEX_CAP="$(grep -oE 'INDEX_CAP = [0-9]+' "$REPO_ROOT/lambda/cost-report/index.mjs" | grep -oE '[0-9]+$' | head -1)"
  INDEX_JSON="$(mktmp index)"
  COVERED=""
  if aws s3 cp "s3://$ARTIFACT_BUCKET/$INDEX_KEY" "$INDEX_JSON" --region "$AWS_REGION" --only-show-errors; then
    COVERED="$(CUTOFF_ISO="$CUTOFF_ISO" python3 -c '
import json, sys, os
cut = os.environ.get("CUTOFF_ISO") or ""
cards = json.load(open(sys.argv[1])).get("cards") or []
print(sum(1 for c in cards if (c.get("completedAt") or "") >= cut))' "$INDEX_JSON" || true)"
  fi
  rm -f "$INDEX_JSON"

  if [[ -z "$COVERED" ]]; then
    echo "WARNING: could not read s3://$ARTIFACT_BUCKET/$INDEX_KEY — coverage unknown (the deploy itself succeeded)"
  elif (( CANDIDATE_COUNT == 0 )); then
    echo "coverage: no terminal runs in $WINDOW_LABEL — nothing to backfill (index holds ${COVERED} v${REPORT_VERSION} cards in window)"
  else
    PCT="$(python3 -c "print(round(100*${COVERED}/${CANDIDATE_COUNT}))")"
    echo "coverage: ${COVERED}/${CANDIDATE_COUNT} v${REPORT_VERSION} cards in the index within ${WINDOW_LABEL} (${PCT}%)"
    if (( PCT < 95 )); then
      echo "WARNING: coverage below 95% — ${FAIL_COUNT} invoke(s) failed; see the FAILED lines above"
    fi
    echo "note: the fleet index keeps only the newest ${INDEX_CAP} cards (INDEX_CAP, lambda/cost-report/index.mjs); on a fleet with more terminal runs than that, a shortfall is index truncation, not a failed backfill."
  fi
fi

echo "✓ $FN deployed"
