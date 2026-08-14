#!/bin/bash
# Deploy a single agent to AgentCore Runtime
# Usage: ./deploy-one.sh <agent_name>

AGENT_NAME=$1
ROLE_ARN="${AGENTCORE_ROLE_ARN:?Set AGENTCORE_ROLE_ARN to your AgentCore execution role ARN}"
REGION="${AWS_REGION:-us-east-1}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# DEPLOY_MODE selects between two deploy paths:
#   lightweight (default) — CodeZip via the bedrock-agentcore-starter-toolkit.
#                           Stock python:3.10 container; main.py downloads Node
#                           + claude-code into /tmp on cold start. No Playwright
#                           browser, no curated skills.
#   robust                 — Custom container built from Dockerfile (baked Node,
#                           claude-code, Playwright Chromium, ~262 SKILL.md).
#                           Uses bedrock-agentcore-control API directly because
#                           neither the legacy toolkit nor @aws/agentcore CLI
#                           accepts a pre-built ECR image URI.
DEPLOY_MODE="${DEPLOY_MODE:-lightweight}"

if [ "$DEPLOY_MODE" = "robust" ]; then
  exec python3 "$SCRIPT_DIR/deploy-one-robust.py" "$AGENT_NAME"
fi

if [ "$DEPLOY_MODE" != "lightweight" ]; then
  echo "FAIL $AGENT_NAME (unknown DEPLOY_MODE=$DEPLOY_MODE — expected 'lightweight' or 'robust')"
  exit 1
fi


# Source GITHUB_PAT from .env.local if not already set (needed for MCP access).
# IMPORTANT: Do NOT source the full .env.local — it contains dev-account values
# that would override prod deployment vars (e.g., ARTIFACT_BUCKET).
# Search multiple known locations so single-agent deploys don't silently strip
# MCP auth when the env file lives outside the default repo-root location.
if [ -z "${GITHUB_PAT:-}" ]; then
  for candidate in \
    "$SCRIPT_DIR/../../.env.local" \
    "$SCRIPT_DIR/../.env.local" \
    "$SCRIPT_DIR/.env.local" \
    "$PWD/.env.local"; do
    if [ -f "$candidate" ]; then
      GITHUB_PAT=$(grep "^GITHUB_PAT=" "$candidate" | cut -d= -f2-)
      # apply-env.sh writes values double-quoted (GITHUB_PAT="ghp_..."). cut keeps
      # the quotes, which would bake a literal Bearer "ghp_..." header → GitHub MCP
      # 400. Strip one layer of surrounding single/double quotes to match what a
      # shell `source` would yield.
      GITHUB_PAT="${GITHUB_PAT%\"}"; GITHUB_PAT="${GITHUB_PAT#\"}"
      GITHUB_PAT="${GITHUB_PAT%\'}"; GITHUB_PAT="${GITHUB_PAT#\'}"
      if [ -n "$GITHUB_PAT" ]; then
        export GITHUB_PAT
        echo "Loaded GITHUB_PAT from $candidate" >&2
        break
      fi
    fi
  done
fi

# Hard-fail if neither GITHUB_PAT nor MCP_SERVERS is set — silent regression
# here strips GitHub MCP auth from the runtime and every deploy reports OK.
if [ -z "${GITHUB_PAT:-}" ] && [ -z "${MCP_SERVERS:-}" ]; then
  echo "FAIL $AGENT_NAME (neither GITHUB_PAT nor MCP_SERVERS is set — refusing to deploy without MCP auth)" >&2
  echo "  Set one of:" >&2
  echo "    export GITHUB_PAT=<your-pat>" >&2
  echo "    export MCP_SERVERS='<json-config>'" >&2
  echo "  Or place GITHUB_PAT=... in one of: ../../.env.local, ../.env.local, ./.env.local" >&2
  exit 1
fi

DEPLOY_DIR=$(mktemp -d)
cp "$SCRIPT_DIR/main.py" "$DEPLOY_DIR/"
cp "$SCRIPT_DIR/requirements.txt" "$DEPLOY_DIR/"
cd "$DEPLOY_DIR"

agentcore configure \
  -e "main.py" \
  -n "$AGENT_NAME" \
  -er "$ROLE_ARN" \
  -rf requirements.txt \
  -r "$REGION" \
  -dt direct_code_deploy \
  --runtime PYTHON_3_10 \
  --idle-timeout 3600 \
  --max-lifetime 3600 \
  --disable-memory \
  --non-interactive > /dev/null 2>&1

# Load agent-specific system prompt — upload to S3 if too large for env var (4000 byte limit)
PROMPT_FILE="$SCRIPT_DIR/prompts/${AGENT_NAME}.txt"
if [ ! -f "$PROMPT_FILE" ]; then
  echo "FAIL $AGENT_NAME (no prompt file: $PROMPT_FILE)"
  exit 1
fi

PROMPT_SIZE=$(wc -c < "$PROMPT_FILE")
PROMPT_S3_KEY=""

# Always upload to S3 — inline env vars break on special chars in prompts
PROMPT_S3_KEY="prompts/${AGENT_NAME}.txt"
aws s3 cp "$PROMPT_FILE" "s3://${ARTIFACT_BUCKET}/${PROMPT_S3_KEY}" --region "$REGION" > /dev/null 2>&1

# Build env args — MCP_SERVERS takes priority, GITHUB_PAT is legacy shorthand
MCP_ENV=""
if [ -n "${MCP_SERVERS:-}" ]; then
  MCP_ENV="--env MCP_SERVERS=${MCP_SERVERS}"
elif [ -n "${GITHUB_PAT:-}" ]; then
  MCP_ENV="--env GITHUB_PAT=${GITHUB_PAT}"
fi

# Build prompt env args — always S3
PROMPT_ENV="--env SYSTEM_PROMPT_S3_KEY=${PROMPT_S3_KEY}"

# Run `agentcore deploy`, retrying once if S3 races with another concurrent
# fleet deploy (the toolkit creates a shared codebuild bucket internally).
run_deploy() {
  agentcore deploy \
    --auto-update-on-conflict \
    --env "BYPASS_TOOL_CONSENT=true" \
    ${GATEWAY_ARN:+--env "GATEWAY_ARN=${GATEWAY_ARN}"} \
    --env "MODEL_ID=us.anthropic.claude-opus-4-6-v1" \
    --env "READ_TIMEOUT=1200" \
    --env "AWS_REGION=us-east-1" \
    --env "EVENTS_TABLE=agentcore-hub-events" \
    --env "TICKET_TOOLS_LAMBDA=${TICKET_TOOLS_LAMBDA:-agentcore-hub-jira}" \
    --env "AGENTCORE_HUB_ARTIFACT_BUCKET=${ARTIFACT_BUCKET}" \
    --env "CLAUDE_CODE_USE_BEDROCK=1" \
    --env "CLAUDE_MODEL=us.anthropic.claude-opus-4-6-v1" \
    --env "ANTHROPIC_MODEL=us.anthropic.claude-opus-4-6-v1" \
    --env "BEDROCK_MANTLE_REGION=${BEDROCK_MANTLE_REGION:-us-east-2}" \
    --env "CODEX_MODEL=${CODEX_MODEL:-openai.gpt-5.5}" \
    --env "PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers" \
    --env "HOME=/tmp" \
    --env "TMPDIR=/tmp" \
    ${FLEET_MEMORY_ID:+--env "MEMORY_ID=${FLEET_MEMORY_ID}"} \
    ${PROMPT_ENV} \
    ${MCP_ENV} 2>&1
}

OUTPUT=$(run_deploy)
DEPLOY_EXIT=$?

if [ $DEPLOY_EXIT -ne 0 ] && echo "$OUTPUT" | grep -qE "OperationAborted|conflicting conditional operation"; then
  # Concurrent toolkit bucket-create race; back off and retry once.
  sleep $((RANDOM % 5 + 3))
  echo "  Retrying $AGENT_NAME after S3 bucket-create race..." >&2
  OUTPUT=$(run_deploy)
  DEPLOY_EXIT=$?
fi

# Check deploy exit code first, then verify via agentcore status
if [ $DEPLOY_EXIT -ne 0 ]; then
  # Check if it's a real error or just a non-zero exit with successful update
  if echo "$OUTPUT" | grep -qi "error\|failed\|exception"; then
    echo "FAIL $AGENT_NAME (deploy error, exit=$DEPLOY_EXIT)"
    echo "$OUTPUT" | grep -i "error\|fail\|Exception" | tail -5 >&2
    rm -rf "$DEPLOY_DIR"
    exit 1
  fi
fi

# Verify deployment via status (reliable regardless of deploy output format)
STATUS_OUTPUT=$(agentcore status 2>&1)
if echo "$STATUS_OUTPUT" | grep -q "READY\|CREATE_COMPLETE\|UPDATE_COMPLETE"; then
  # Try to extract ARN from status or deploy output
  ARN=$(echo "$OUTPUT" | grep -o 'arn:aws:bedrock-agentcore:[^"]*runtime/[^"[:space:]]*' | head -1)
  if [ -z "$ARN" ]; then
    ARN=$(echo "$STATUS_OUTPUT" | grep -o 'arn:aws:bedrock-agentcore:[^"]*runtime/[^"[:space:]]*' | head -1)
  fi

  # Merge ARN into fleet-runtime-ids.json so re-runs are first-class.
  # During a parallel fleet deploy, deploy-fleet.sh overwrites this at the
  # end anyway — these writes are redundant but harmless. Use mkdir as a
  # POSIX-portable lock to serialize concurrent jq merges.
  if [ -n "${ARN:-}" ] && command -v jq >/dev/null 2>&1; then
    FLEET_FILE="$SCRIPT_DIR/fleet-runtime-ids.json"
    LOCK_DIR="$SCRIPT_DIR/.fleet-file.lock"
    for _ in $(seq 1 50); do
      if mkdir "$LOCK_DIR" 2>/dev/null; then
        if [ -f "$FLEET_FILE" ]; then
          jq --arg name "$AGENT_NAME" --arg arn "$ARN" '. + {($name): $arn}' "$FLEET_FILE" > "$FLEET_FILE.tmp" \
            && mv "$FLEET_FILE.tmp" "$FLEET_FILE"
        else
          jq -n --arg name "$AGENT_NAME" --arg arn "$ARN" '{($name): $arn}' > "$FLEET_FILE"
        fi
        rmdir "$LOCK_DIR"
        break
      fi
      sleep 0.1
    done
  fi

  echo "OK $AGENT_NAME ${ARN:-deployed}"
else
  echo "FAIL $AGENT_NAME (status check failed)"
  echo "$OUTPUT" | tail -5 >&2
fi

rm -rf "$DEPLOY_DIR"
