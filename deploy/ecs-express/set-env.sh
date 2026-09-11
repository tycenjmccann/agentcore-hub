#!/usr/bin/env bash
#
# set-env.sh — set (or unset) environment variables on the live hub ECS Express
# service WITHOUT redeploying an image or rewriting the rest of its env.
#
# update-express-gateway-service takes the whole primary container, so a bare
# CLI call that forgets a var wipes it (the service env carries Jira/GitHub/
# Telegram creds). This reads the live container, merges your changes, and
# re-submits the same image + port. Values are never printed.
#
# Usage (prod profile):
#   source deploy/config.sh
#   ./deploy/ecs-express/set-env.sh CODING_AGENT_RUNTIME_ARN="$(cat deploy/coding-agent-runtime/coding-runtime-instances-arn.txt)"
#   ./deploy/ecs-express/set-env.sh KEY=VALUE [KEY=VALUE ...] [--unset KEY ...] [--dry-run]
#
# The roll takes a few minutes; the script waits for the service to be ACTIVE.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../config.sh"

SERVICE_NAME="${EXPRESS_SERVICE_NAME:-agentcore-hub}"
CLUSTER="${EXPRESS_CLUSTER:-default}"

SETS=()
UNSETS=()
DRY_RUN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --unset) UNSETS+=("$2"); shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *=*) SETS+=("$1"); shift ;;
    *) echo "ERROR: expected KEY=VALUE, --unset KEY or --dry-run, got '$1'" >&2; exit 2 ;;
  esac
done
if [ ${#SETS[@]} -eq 0 ] && [ ${#UNSETS[@]} -eq 0 ]; then
  echo "ERROR: nothing to do" >&2; exit 2
fi

export SERVICE_NAME
SERVICE_ARN="$(aws ecs list-services --cluster "$CLUSTER" --region "$AWS_REGION" --output json \
  | python3 -c "
import json, os, sys
want = os.environ['SERVICE_NAME']
for arn in json.load(sys.stdin).get('serviceArns', []):
    if arn.rsplit('/', 1)[-1] == want:
        print(arn); break
")"
if [ -z "$SERVICE_ARN" ]; then
  echo "ERROR: service $SERVICE_NAME not found in cluster $CLUSTER ($AWS_REGION)" >&2; exit 1
fi

DESCRIBE="$(aws ecs describe-express-gateway-service --service-arn "$SERVICE_ARN" --region "$AWS_REGION" --output json)"

# Merge in python: prints "<changed-keys>\t<removed-keys>" on stderr-safe line 1
# and the new primary-container JSON on line 2. Fails closed on a degraded
# describe (no container / empty env) like deploy/pipeline/ecs-primary-container.py.
MERGED="$(SETS_JSON="$(printf '%s\n' "${SETS[@]+"${SETS[@]}"}" | python3 -c 'import json,sys; print(json.dumps([l for l in sys.stdin.read().split("\n") if l]))')" \
  UNSETS_JSON="$(printf '%s\n' "${UNSETS[@]+"${UNSETS[@]}"}" | python3 -c 'import json,sys; print(json.dumps([l for l in sys.stdin.read().split("\n") if l]))')" \
  python3 - "$DESCRIBE" <<'PY'
import json, os, sys
d = json.loads(sys.argv[1]).get("service", {})
pcs = [c["primaryContainer"] for c in d.get("activeConfigurations", []) or [] if c.get("primaryContainer")]
if d.get("primaryContainer"):
    pcs.append(d["primaryContainer"])
if not pcs:
    sys.exit("no live primaryContainer in describe output — refusing")
pc = pcs[0]
env = pc.get("environment")
if not isinstance(env, list) or not env or not isinstance(pc.get("containerPort"), int):
    sys.exit("degraded describe (missing port/env) — refusing to emit an env-wiping spec")
current = {e["name"]: e["value"] for e in env}
changed, removed = [], []
for a in json.loads(os.environ["SETS_JSON"]):
    k, v = a.split("=", 1)
    if current.get(k) != v:
        changed.append(k)
    current[k] = v
for k in json.loads(os.environ["UNSETS_JSON"]):
    if k in current:
        current.pop(k); removed.append(k)
print(json.dumps({"changed": changed, "removed": removed, "total": len(current)}))
print(json.dumps({"image": pc["image"], "containerPort": pc["containerPort"],
                  "environment": [{"name": k, "value": v} for k, v in current.items()]}))
PY
)"
SUMMARY="$(printf '%s\n' "$MERGED" | sed -n 1p)"
PRIMARY_CONTAINER="$(printf '%s\n' "$MERGED" | sed -n 2p)"
echo "🔧 $SERVICE_NAME ($CLUSTER, $AWS_REGION): $SUMMARY"
if [ "$(printf '%s' "$SUMMARY" | python3 -c 'import json,sys; s=json.load(sys.stdin); print(int(bool(s["changed"] or s["removed"])))')" = "0" ]; then
  echo "   nothing changed"; exit 0
fi
if [ -n "$DRY_RUN" ]; then
  echo "   dry run — no update"; exit 0
fi

aws ecs update-express-gateway-service --service-arn "$SERVICE_ARN" --region "$AWS_REGION" \
  --primary-container "$PRIMARY_CONTAINER" --output text >/dev/null
echo "   update started; waiting for ACTIVE"
for _ in $(seq 1 60); do
  sleep 10
  STATUS="$(aws ecs describe-express-gateway-service --service-arn "$SERVICE_ARN" --region "$AWS_REGION" \
    --query 'service.status.statusCode' --output text 2>/dev/null || echo UNKNOWN)"
  if [ "$STATUS" = "ACTIVE" ]; then echo "   ✓ ACTIVE"; exit 0; fi
  printf '.'
done
echo ""
echo "   still not ACTIVE after 10 min — inspect: aws ecs describe-express-gateway-service --service-arn $SERVICE_ARN --region $AWS_REGION" >&2
exit 1
