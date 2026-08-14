#!/usr/bin/env bash
# ─── Deploy AgentCore runtimes per topology choice (Q4 in /setup) ───────────
#
# Reads WORKFLOW_RUNTIME_COUNT from the environment (1, 4, or 14):
#   1  → ONE shared runtime hosting all 14 personas (mono-agent).
#   4  → FOUR runtimes grouped by pipeline phase:
#          - requirements_analyst   (intake/requirements)
#          - backend_designer       (design — 8 personas)
#          - backend_dev            (development — 3 personas)
#          - qa_verifier            (verification + review — qa + ci)
#   14 → ONE runtime per persona (delegates to deploy-fleet.sh).
#
# In 1- and 4-runtime modes, the runtime resolves the right per-persona
# system prompt at invocation time from s3://${ARTIFACT_BUCKET}/prompts/{agentId}.txt
# (see _load_prompt_for_agent in deploy/runtime-agent/main.py). Persona
# differentiation is the runtime's responsibility; topology only controls how
# many runtimes exist and what runtimeArn each persona points at.
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
WORKFLOWS_JSON="$REPO_ROOT/src/config/workflows.json"
PROMPTS_DIR="$SCRIPT_DIR/prompts"

: "${AWS_REGION:?AWS_REGION must be set}"
: "${ARTIFACT_BUCKET:?ARTIFACT_BUCKET must be set}"

COUNT="${WORKFLOW_RUNTIME_COUNT:-14}"
case "$COUNT" in
  1|4|14) ;;
  *) echo "ERROR: WORKFLOW_RUNTIME_COUNT must be 1, 4, or 14 (got: $COUNT)" >&2; exit 2 ;;
esac

echo "── Runtime topology: $COUNT runtime(s) ─────────────────────"

# ── Always sync per-persona prompts to S3 ───────────────────────────────────
# In 1- and 4-mode the shared runtime fetches prompts/{agentId}.txt at invoke
# time. In 14-mode deploy-one.sh uploads each persona's prompt anyway, so this
# pre-sync is harmless and keeps S3 authoritative regardless of topology.
echo "→ Syncing 14 persona prompts to s3://${ARTIFACT_BUCKET}/prompts/"
aws s3 sync "$PROMPTS_DIR" "s3://${ARTIFACT_BUCKET}/prompts/" \
  --region "$AWS_REGION" \
  --exclude "*" --include "*.txt" \
  --only-show-errors

if [[ "$COUNT" == "14" ]]; then
  # deploy-fleet.sh refreshes the local agents.json (via refresh-agents-json.sh)
  # but does not upload it to S3. We do that ourselves so the orchestrator/Jira
  # Lambdas (DL-023) can resolve the new runtime ARNs at next cold start.
  "$SCRIPT_DIR/deploy-fleet.sh"
  echo ""
  echo "→ Uploading agents.json to s3://${ARTIFACT_BUCKET}/config/agents.json"
  aws s3 cp "$AGENTS_JSON" "s3://${ARTIFACT_BUCKET}/config/agents.json" \
    --region "$AWS_REGION" \
    --content-type application/json \
    --only-show-errors
  echo "→ Uploading workflows.json to s3://${ARTIFACT_BUCKET}/config/workflows.json"
  aws s3 cp "$WORKFLOWS_JSON" "s3://${ARTIFACT_BUCKET}/config/workflows.json" \
    --region "$AWS_REGION" \
    --content-type application/json \
    --only-show-errors
  echo ""
  echo "── Topology deploy complete (14 runtime mode) ──────────"
  exit 0
fi

# ── 1- and 4-runtime modes: deploy anchors, then remap agents.json ──────────
# Anchor names are NEUTRAL (not a persona name) because the runtime hosts many
# personas — its prompt is resolved per-invocation from S3. Naming the 1-mode
# runtime after one persona ("requirements_analyst") misrepresented what it is.
if [[ "$COUNT" == "1" ]]; then
  # One runtime hosting all 14 personas.
  ANCHORS=("agentcore_hub_agent")
else
  # 4-runtime mode — one anchor per pipeline phase:
  #   requirements (1)              → agentcore_hub_requirements
  #   design (8)                    → agentcore_hub_design
  #   development (3)               → agentcore_hub_development
  #   verification + review (1 + 1) → agentcore_hub_qaci
  ANCHORS=(
    "agentcore_hub_requirements"
    "agentcore_hub_design"
    "agentcore_hub_development"
    "agentcore_hub_qaci"
  )
fi

# In robust mode, deploy-one.sh → deploy-one-robust.py needs IMAGE_URI.
# run-module.sh invokes build-and-push.sh with no tag arg, which always pushes
# runtime-agent:latest, so pin :latest here to match the image that was built.
if [[ "${DEPLOY_MODE:-lightweight}" == "robust" && -z "${IMAGE_URI:-}" ]]; then
  : "${AWS_ACCOUNT_ID:=$(aws sts get-caller-identity --query Account --output text)}"
  IMAGE_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/runtime-agent:latest"
  export IMAGE_URI
  echo "→ IMAGE_URI=$IMAGE_URI"
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
echo "→ Mapping ${#ANCHORS[@]} anchor ARN(s) onto all personas in agents.json"

# In 1-mode only ANCHOR_REQ (agentcore_hub_agent) is populated and arn_for()
# returns it for every persona. In 4-mode each phase anchor is populated.
if [[ "$COUNT" == "1" ]]; then
  ANCHOR_REQ="${ANCHOR_ARN[agentcore_hub_agent]:-}"
  ANCHOR_DESIGN=""
  ANCHOR_DEV=""
  ANCHOR_QA=""
else
  ANCHOR_REQ="${ANCHOR_ARN[agentcore_hub_requirements]:-}"
  ANCHOR_DESIGN="${ANCHOR_ARN[agentcore_hub_design]:-}"
  ANCHOR_DEV="${ANCHOR_ARN[agentcore_hub_development]:-}"
  ANCHOR_QA="${ANCHOR_ARN[agentcore_hub_qaci]:-}"
fi

COUNT="$COUNT" \
ANCHOR_REQ="$ANCHOR_REQ" \
ANCHOR_DESIGN="$ANCHOR_DESIGN" \
ANCHOR_DEV="$ANCHOR_DEV" \
ANCHOR_QA="$ANCHOR_QA" \
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
anchor_qa = os.environ.get("ANCHOR_QA", "")

with open(agents_path) as f:
    text = f.read()

config = json.loads(text)

def arn_for(agent):
    phase = agent["phase"]
    if count == "1":
        return anchor_req
    # 4-runtime mode: phase → anchor
    if phase == "requirements":
        return anchor_req
    if phase == "design":
        return anchor_design
    if phase == "development":
        return anchor_dev
    if phase in ("verification", "review"):
        return anchor_qa
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

print(f"  Updated runtimeArn on {updated}/{len(config['agents'])} personas")
PYEOF

# ── Upload the rewritten agents.json so Lambdas pick it up at next cold start ─
# (DL-023: the orchestrator, agentcore-hub-tickets, and agentcore-hub-jira
# Lambdas all read s3://${ARTIFACT_BUCKET}/config/agents.json on cold start.
# The orchestrator also reads config/workflows.json for per-def intake agent,
# phase order, and completion phases — without it, only software-delivery works.)
echo "→ Uploading agents.json to s3://${ARTIFACT_BUCKET}/config/agents.json"
aws s3 cp "$AGENTS_JSON" "s3://${ARTIFACT_BUCKET}/config/agents.json" \
  --region "$AWS_REGION" \
  --content-type application/json \
  --only-show-errors
echo "→ Uploading workflows.json to s3://${ARTIFACT_BUCKET}/config/workflows.json"
aws s3 cp "$WORKFLOWS_JSON" "s3://${ARTIFACT_BUCKET}/config/workflows.json" \
  --region "$AWS_REGION" \
  --content-type application/json \
  --only-show-errors

echo ""
echo "── Topology deploy complete ($COUNT runtime mode) ──────────"
