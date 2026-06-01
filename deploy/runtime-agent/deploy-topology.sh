#!/usr/bin/env bash
# ─── Deploy AgentCore runtimes per topology choice (Q4 in /setup) ───────────
#
# Reads WORKFLOW_RUNTIME_COUNT from the environment (1, 3, or 14) and:
#   1  → deploy ONE shared runtime; map all 14 personas' runtimeArn to it
#   3  → deploy THREE phase-grouped runtimes; map personas by phase
#   14 → delegate to deploy-fleet.sh (existing one-runtime-per-persona path)
#
# In the 1- and 3-runtime modes, the personas are differentiated only by their
# routing in src/config/agents.json. Per-persona prompts and blueprints stay in
# S3 (agentcore-hub-artifacts-…/prompts/{agentId}.txt) — runtime selection is
# purely a deploy + mapping concern, no app code changes.
#
# Required env (from .env.local / config.sh):
#   AWS_REGION, AGENTCORE_ROLE_ARN, ARTIFACT_BUCKET
#   GITHUB_PAT *or* MCP_SERVERS (validated by deploy-one.sh)
#
# Usage: ./deploy-topology.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
AGENTS_JSON="$REPO_ROOT/src/config/agents.json"

COUNT="${WORKFLOW_RUNTIME_COUNT:-14}"
case "$COUNT" in
  1|3|14) ;;
  *) echo "ERROR: WORKFLOW_RUNTIME_COUNT must be 1, 3, or 14 (got: $COUNT)" >&2; exit 2 ;;
esac

echo "── Runtime topology: $COUNT runtime(s) ─────────────────────"

if [[ "$COUNT" == "14" ]]; then
  exec "$SCRIPT_DIR/deploy-fleet.sh"
fi

# ── 1- and 3-runtime modes ──────────────────────────────────────────────────
# Pick representative personas to actually deploy; the rest get their ARN
# rewritten in agents.json to point at one of the deployed runtimes.

if [[ "$COUNT" == "1" ]]; then
  ANCHORS=("agentcore_hub_requirements_analyst")
else
  # 3 runtimes — one per phase group:
  #   intake/requirements/review → requirements_analyst
  #   design                     → backend_designer
  #   development/verification   → backend_dev
  ANCHORS=(
    "agentcore_hub_requirements_analyst"
    "agentcore_hub_backend_designer"
    "agentcore_hub_backend_dev"
  )
fi

echo "→ Deploying ${#ANCHORS[@]} anchor runtime(s):"
for a in "${ANCHORS[@]}"; do echo "    - $a"; done
echo ""

DEPLOY_LOG=$(mktemp)
trap 'rm -f "$DEPLOY_LOG"' EXIT

for anchor in "${ANCHORS[@]}"; do
  echo "→ deploy-one.sh $anchor"
  "$SCRIPT_DIR/deploy-one.sh" "$anchor" | tee -a "$DEPLOY_LOG"
done

# Parse anchor ARNs from the OK lines printed by deploy-one.sh.
declare -A ANCHOR_ARN
while IFS= read -r line; do
  if [[ "$line" == OK* ]]; then
    name=$(awk '{print $2}' <<<"$line")
    arn=$(awk '{print $3}' <<<"$line")
    if [[ -n "$arn" && "$arn" == arn:aws:bedrock-agentcore:* ]]; then
      ANCHOR_ARN["$name"]="$arn"
    fi
  fi
done < "$DEPLOY_LOG"

for anchor in "${ANCHORS[@]}"; do
  if [[ -z "${ANCHOR_ARN[$anchor]:-}" ]]; then
    echo "ERROR: Anchor runtime $anchor did not return an ARN — aborting topology remap" >&2
    exit 1
  fi
done

# ── Remap agents.json so every persona points at the right anchor ───────────
echo ""
echo "→ Mapping ${#ANCHORS[@]} anchor ARN(s) onto 14 personas in agents.json"

ANCHOR_REQ="${ANCHOR_ARN[agentcore_hub_requirements_analyst]:-}"
ANCHOR_DESIGN="${ANCHOR_ARN[agentcore_hub_backend_designer]:-}"
ANCHOR_DEV="${ANCHOR_ARN[agentcore_hub_backend_dev]:-}"

COUNT="$COUNT" \
ANCHOR_REQ="$ANCHOR_REQ" \
ANCHOR_DESIGN="$ANCHOR_DESIGN" \
ANCHOR_DEV="$ANCHOR_DEV" \
AGENTS_JSON="$AGENTS_JSON" \
python3 <<'PYEOF'
import json
import os
import re

count = os.environ["COUNT"]
agents_path = os.environ["AGENTS_JSON"]
anchor_req = os.environ.get("ANCHOR_REQ", "")
anchor_design = os.environ.get("ANCHOR_DESIGN", "")
anchor_dev = os.environ.get("ANCHOR_DEV", "")

with open(agents_path) as f:
    text = f.read()

config = json.loads(text)

def arn_for(agent):
    phase = agent["phase"]
    if count == "1":
        return anchor_req
    # 3-runtime mode: phase → anchor
    if phase in ("requirements", "review"):
        return anchor_req
    if phase == "design":
        return anchor_design
    if phase in ("development", "verification"):
        return anchor_dev
    return anchor_req  # fallback for unknown phases

updated = 0
for agent in config["agents"]:
    arn = arn_for(agent)
    agent_id = agent["agentId"]
    id_marker = f'"agentId": "{agent_id}"'
    id_pos = text.find(id_marker)
    if id_pos < 0:
        continue
    end_pos = text.find("\n    }", id_pos)
    if end_pos < 0:
        continue
    block = text[id_pos:end_pos]
    new_block = re.sub(
        r'"runtimeArn":\s*("[^"]*"|null)',
        f'"runtimeArn": "{arn}"',
        block,
    )
    if new_block != block:
        text = text[:id_pos] + new_block + text[end_pos:]
        updated += 1

# Validate JSON
try:
    json.loads(text)
except json.JSONDecodeError as e:
    raise SystemExit(f"ERROR: regex edit produced invalid JSON: {e}")

with open(agents_path, "w") as f:
    f.write(text)

print(f"  Updated runtimeArn on {updated}/14 personas")
PYEOF

echo ""
echo "── Topology deploy complete ($COUNT runtime mode) ──────────"
