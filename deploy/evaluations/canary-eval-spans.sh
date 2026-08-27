#!/bin/bash
#
# canary-eval-spans.sh — Post-deploy end-to-end telemetry canary
#
# Sends ONE synthetic invocation to a single fleet runtime under a fresh
# runtimeSessionId (SigV4-signed, same interface as
# ../runtime-agent/verify-fleet-invoke.py), then walks the telemetry pipeline
# end to end:
#
#   1. BLOCKING (≤5 min, 30s polls): the runtime's `spans` log stream must
#      contain an invoke_agent span carrying that session.id — the exact
#      attribute the eval-packager keys runs on. Missing span ⇒ exit 1.
#   2. ADVISORY (≤30 min, 60s polls): the online-eval results log group
#      /aws/bedrock-agentcore/evaluations/results/eval_<agent>-* should show a
#      non-null gen_ai.evaluation.score.value for the session. Eval scoring is
#      asynchronous and sampled, so this check WARNS but never fails.
#
# Usage:
#   ./canary-eval-spans.sh [agent_id]
#     agent_id defaults to agentcore_hub_backend_dev (or the first agent in
#     fleet-runtime-ids.json if that one isn't deployed).
#
# Also invocable from ../runtime-agent/verify-fleet.sh via RUN_EVAL_CANARY=true.
# Requires: aws CLI, python3 + boto3, jq.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_AGENT_DIR="$SCRIPT_DIR/../runtime-agent"
FLEET_FILE="$RUNTIME_AGENT_DIR/fleet-runtime-ids.json"
REGION="${AWS_REGION:-us-east-1}"

if [ ! -f "$FLEET_FILE" ]; then
  echo "  ✗ No fleet-runtime-ids.json found at $FLEET_FILE. Run deploy-fleet.sh first."
  exit 1
fi

AGENT_ID="${1:-}"
if [ -z "$AGENT_ID" ]; then
  AGENT_ID=$(python3 -c "
import json
fleet = json.load(open('$FLEET_FILE'))
print('agentcore_hub_backend_dev' if 'agentcore_hub_backend_dev' in fleet else next(iter(fleet)))
")
fi

ARN=$(python3 -c "import json; print(json.load(open('$FLEET_FILE')).get('$AGENT_ID', ''))")
if [ -z "$ARN" ]; then
  echo "  ✗ Agent '$AGENT_ID' not found in $FLEET_FILE"
  exit 1
fi

RUNTIME_ID="${ARN##*/}"
# Runtime session ids must be >= 33 chars; epoch + agent id clears that.
SESSION_ID="canary-eval-$(date +%s)-${AGENT_ID}"
START_MS=$(python3 -c "import time; print(int(time.time() * 1000))")

echo ""
echo "  Telemetry Eval Canary"
echo "  ═══════════════════════════════"
echo "  agent:      $AGENT_ID"
echo "  runtime:    $RUNTIME_ID"
echo "  session.id: $SESSION_ID"
echo ""

# ── Synthetic invocation ──────────────────────────────────────────────────────
# SigV4-signed POST, reusing verify-fleet-invoke.py's credential helper and
# mirroring its request shape — but with a fixed prompt and OUR session id, so
# the probes below can correlate spans and eval results to this exact run.
python3 - "$ARN" "$AGENT_ID" "$SESSION_ID" "$REGION" "$RUNTIME_AGENT_DIR" <<'PY'
import importlib.util
import json
import os
import sys
import urllib.error
import urllib.request

arn, agent_id, session_id, region, runtime_agent_dir = sys.argv[1:6]

spec = importlib.util.spec_from_file_location(
    "verify_fleet_invoke", os.path.join(runtime_agent_dir, "verify-fleet-invoke.py")
)
vfi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vfi)

from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

credentials = vfi.get_credentials()
runtime_id = arn.split("/")[-1]
account_id = arn.split(":")[4]
host = f"bedrock-agentcore.{region}.amazonaws.com"
url = f"https://{host}/runtimes/{runtime_id}/invocations?accountId={account_id}"

payload = json.dumps({
    "prompt": "Telemetry canary: respond with exactly CANARY_OK and use no tools.",
    "workflow_id": "canary-eval",
    "agent_id": agent_id,
})

request = AWSRequest(
    method="POST",
    url=url,
    data=payload,
    headers={
        "Content-Type": "application/json",
        "Host": host,
        "x-amzn-bedrock-agentcore-runtime-session-id": session_id,
    },
)
SigV4Auth(credentials, "bedrock-agentcore", region).add_auth(request)
req = urllib.request.Request(
    url, data=payload.encode("utf-8"), headers=dict(request.headers), method="POST"
)
try:
    with urllib.request.urlopen(req, timeout=180) as resp:
        body = resp.read().decode("utf-8", "replace")
        print(f"  invocation returned {len(body)} bytes")
except urllib.error.HTTPError as e:
    detail = e.read().decode("utf-8", "replace")[:200] if e.fp else ""
    print(f"  ✗ invocation failed: HTTP {e.code}: {detail}")
    sys.exit(1)
PY

# ── 1. BLOCKING: invoke_agent span keyed by our session.id ───────────────────
SPAN_LOG_GROUP="/aws/bedrock-agentcore/runtimes/${RUNTIME_ID}-DEFAULT"
echo ""
echo "  [1/2] BLOCKING: invoke_agent span with session.id in $SPAN_LOG_GROUP"

FOUND=""
for attempt in $(seq 1 10); do
  sleep 30
  FOUND=$(aws logs filter-log-events \
    --log-group-name "$SPAN_LOG_GROUP" \
    --log-stream-name-prefix "spans" \
    --filter-pattern "\"invoke_agent\" \"${SESSION_ID}\"" \
    --start-time "$START_MS" \
    --max-items 1 \
    --query 'events[0].eventId' \
    --output text 2>/dev/null) || FOUND=""
  if [ -n "$FOUND" ] && [ "$FOUND" != "None" ]; then
    break
  fi
  FOUND=""
  echo "    … attempt $attempt/10: span not visible yet"
done

if [ -z "$FOUND" ]; then
  echo ""
  echo "  ✗ CANARY FAILED: no invoke_agent span carrying session.id=$SESSION_ID"
  echo "    appeared in $SPAN_LOG_GROUP (stream prefix 'spans') within 5 minutes."
  echo "    The eval pipeline cannot attribute this run — eval batches would score"
  echo "    this persona 0/10. Debug with DEPLOY.md §'Post-deploy telemetry"
  echo "    verification' before shipping."
  exit 1
fi
echo "  ✓ invoke_agent span found for session.id=$SESSION_ID"

# ── 2. ADVISORY: online-eval score for the session ────────────────────────────
# Eval configs are named eval_<agent-short>-<suffix>; results are OTEL log
# records whose score lives at attributes["gen_ai.evaluation.score.value"].
AGENT_SHORT="${AGENT_ID#agentcore_hub_}"
EVAL_PREFIX="/aws/bedrock-agentcore/evaluations/results/eval_${AGENT_SHORT}"
echo ""
echo "  [2/2] ADVISORY: eval score for the session under ${EVAL_PREFIX}*"

EVAL_GROUPS=$(aws logs describe-log-groups \
  --log-group-name-prefix "$EVAL_PREFIX" \
  --query 'logGroups[].logGroupName' \
  --output text 2>/dev/null) || EVAL_GROUPS=""

if [ -z "$EVAL_GROUPS" ] || [ "$EVAL_GROUPS" = "None" ]; then
  echo "  ⚠️  ADVISORY: no eval results log group matches ${EVAL_PREFIX}* — online"
  echo "     evaluations may not be configured for $AGENT_ID (see"
  echo "     deploy/evaluations/setup-evaluations.sh). Not failing the canary."
  exit 0
fi

SCORED=0
for attempt in $(seq 1 30); do
  sleep 60
  for group in $EVAL_GROUPS; do
    SCORED=$(aws logs filter-log-events \
      --log-group-name "$group" \
      --filter-pattern "\"${SESSION_ID}\"" \
      --start-time "$START_MS" \
      --query 'events[].message' \
      --output json 2>/dev/null \
      | jq -r '[.[] | fromjson? | select(.attributes["gen_ai.evaluation.score.value"] != null)] | length') || SCORED=0
    if [ "${SCORED:-0}" -gt 0 ] 2>/dev/null; then
      break 2
    fi
  done
  SCORED=0
  echo "    … attempt $attempt/30: no scored eval result yet (advisory)"
done

if [ "${SCORED:-0}" -gt 0 ] 2>/dev/null; then
  echo "  ✓ eval result with non-null gen_ai.evaluation.score.value found"
else
  echo "  ⚠️  ADVISORY: no non-null gen_ai.evaluation.score.value for"
  echo "     session.id=$SESSION_ID within 30 minutes. Online eval scoring is"
  echo "     asynchronous/sampled, so this does NOT fail the canary — but if it"
  echo "     persists across deploys, check the eval configs and the eval-packager."
fi
exit 0
