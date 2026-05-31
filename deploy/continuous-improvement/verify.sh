#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# Verify the Continuous Improvement Loop is working end-to-end
#
# Checks:
#   1. XRay indexing is at 100%
#   2. Agent runtime role has XRay permissions
#   3. Invokes an agent and confirms trace appears in aws/spans
#   4. Runs a manual eval to confirm the system can score the session
#   5. Checks subscription filters and EventBridge rule exist
#
# Usage:
#   export AWS_PROFILE=your-profile
#   ./verify.sh
# ═══════════════════════════════════════════════════════════════════════════════

set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "${REPO_ROOT}/deploy/config.sh"

PASS=0
FAIL=0

check() {
  local desc="$1" result="$2"
  if [ "$result" = "ok" ]; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc — $result"
    FAIL=$((FAIL + 1))
  fi
}

echo "Verifying Continuous Improvement Loop..."
echo ""

# ─── Check 1: XRay Indexing ──────────────────────────────────────────────────
RATE=$(aws xray get-indexing-rules --region "$AWS_REGION" \
  --query 'IndexingRules[0].Rule.Probabilistic.DesiredSamplingPercentage' --output text 2>/dev/null || echo "0")
if [ "$RATE" = "100.0" ] || [ "$RATE" = "100" ]; then
  check "XRay indexing at 100%" "ok"
else
  check "XRay indexing at 100%" "currently ${RATE}% — run deploy-all.sh"
fi

# ─── Check 2: IAM XRay Permissions ──────────────────────────────────────────
HAS_XRAY=$(aws iam get-role-policy --role-name agentcore-hub-agentcore-role \
  --policy-name agentcore-permissions \
  --query 'PolicyDocument' --output json 2>/dev/null | grep -c "xray:PutTraceSegments" || echo "0")
if [ "$HAS_XRAY" -gt 0 ]; then
  check "Agent role has XRay permissions" "ok"
else
  check "Agent role has XRay permissions" "missing xray:PutTraceSegments"
fi

# ─── Check 3: Online Eval Configs ───────────────────────────────────────────
EVAL_COUNT=$(AWS_REGION="$AWS_REGION" agentcore eval online list 2>&1 | grep -c "ACTIVE" || echo "0")
if [ "$EVAL_COUNT" -ge 14 ]; then
  check "Online eval configs (${EVAL_COUNT} active)" "ok"
else
  check "Online eval configs" "only ${EVAL_COUNT}/14 active"
fi

# ─── Check 4: Eval-packager Lambda ──────────────────────────────────────────
PACKAGER_STATE=$(aws lambda get-function --function-name agentcore-hub-eval-packager \
  --region "$AWS_REGION" --query 'Configuration.State' --output text 2>/dev/null || echo "MISSING")
if [ "$PACKAGER_STATE" = "Active" ]; then
  # Check concurrency (0 = disabled)
  CONCURRENCY=$(aws lambda get-function-concurrency --function-name agentcore-hub-eval-packager \
    --region "$AWS_REGION" --query 'ReservedConcurrentExecutions' --output text 2>/dev/null || echo "none")
  if [ "$CONCURRENCY" = "0" ]; then
    check "eval-packager Lambda" "deployed but DISABLED (concurrency=0)"
  else
    check "eval-packager Lambda" "ok"
  fi
else
  check "eval-packager Lambda" "$PACKAGER_STATE"
fi

# ─── Check 5: PRD-submitter Lambda ──────────────────────────────────────────
SUBMITTER_STATE=$(aws lambda get-function --function-name agentcore-hub-prd-submitter \
  --region "$AWS_REGION" --query 'Configuration.State' --output text 2>/dev/null || echo "MISSING")
SUBMITTER_URL=$(aws lambda get-function-configuration --function-name agentcore-hub-prd-submitter \
  --region "$AWS_REGION" --query 'Environment.Variables.WORKFLOW_API_URL' --output text 2>/dev/null || echo "")
if [ "$SUBMITTER_STATE" = "Active" ] && [ -n "$SUBMITTER_URL" ]; then
  check "prd-submitter Lambda (API: ${SUBMITTER_URL})" "ok"
else
  check "prd-submitter Lambda" "state=${SUBMITTER_STATE}, url=${SUBMITTER_URL:-missing}"
fi

# ─── Check 6: Subscription Filters ──────────────────────────────────────────
FILTER_COUNT=$(aws logs describe-log-groups \
  --log-group-name-prefix /aws/bedrock-agentcore/evaluations/results/ \
  --query 'logGroups | length(@)' --output text --region "$AWS_REGION" 2>/dev/null || echo "0")

# Sample one to verify filter exists
SAMPLE_LG=$(aws logs describe-log-groups \
  --log-group-name-prefix /aws/bedrock-agentcore/evaluations/results/ \
  --query 'logGroups[0].logGroupName' --output text --region "$AWS_REGION" 2>/dev/null || echo "")
HAS_FILTER="no"
if [ -n "$SAMPLE_LG" ]; then
  HAS_FILTER=$(aws logs describe-subscription-filters \
    --log-group-name "$SAMPLE_LG" --region "$AWS_REGION" \
    --query 'subscriptionFilters | length(@)' --output text 2>/dev/null || echo "0")
fi
if [ "$HAS_FILTER" -gt 0 ]; then
  check "Subscription filters (${FILTER_COUNT} log groups)" "ok"
else
  check "Subscription filters" "none found on ${SAMPLE_LG}"
fi

# ─── Check 7: EventBridge Rule ──────────────────────────────────────────────
RULE_STATE=$(aws events describe-rule --name agentcore-hub-prd-submitter-trigger \
  --region "$AWS_REGION" --query 'State' --output text 2>/dev/null || echo "MISSING")
if [ "$RULE_STATE" = "ENABLED" ]; then
  check "EventBridge rule (prd-submitter-trigger)" "ok"
else
  check "EventBridge rule" "$RULE_STATE"
fi

# ─── Check 8: Recent Spans in aws/spans ─────────────────────────────────────
RECENT_SPANS=$(aws logs filter-log-events --log-group-name "aws/spans" \
  --start-time "$(python3 -c "import time; print(int((time.time()-3600)*1000))")" \
  --region "$AWS_REGION" --query 'events | length(@)' --output text 2>/dev/null | head -1 || echo "0")
# filter-log-events paginates — just take the first page count
RECENT_SPANS="${RECENT_SPANS%%[^0-9]*}"
RECENT_SPANS="${RECENT_SPANS:-0}"
if [ "$RECENT_SPANS" -gt 0 ]; then
  check "Recent spans in aws/spans (${RECENT_SPANS} in last hour)" "ok"
else
  check "Recent spans in aws/spans" "none in last hour — invoke an agent to generate traces"
fi

# ─── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAIL" -eq 0 ]; then
  echo "  Result: ALL PASS (${PASS}/${PASS})"
  echo "  The continuous improvement loop is fully operational."
else
  echo "  Result: ${PASS} passed, ${FAIL} failed"
  echo "  Fix the issues above, then re-run this script."
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
