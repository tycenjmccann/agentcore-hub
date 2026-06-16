#!/usr/bin/env bash
# ============================================================
# Claude Code launcher for AgentCore Runtime (headless)
# ============================================================
# Baked into the coding-agent image; execed via the AgentCore commands API by
# the Strands fleet agent. Claude Code uses Bedrock (CLAUDE_CODE_USE_BEDROCK=1);
# the microVM IAM role already has bedrock:InvokeModel, so no API key is needed.
#
# Emits stream-json on stdout so the caller can publish per-tool live events.
#
# Usage: run-claude.sh "<task prompt>"
#   WORKSPACE_DIR  persistent per-repo working dir under /mnt/workspace
#   CLAUDE_MODEL / ANTHROPIC_MODEL  model id (default opus)
# ============================================================
set -euo pipefail

export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$AWS_REGION}"
export CLAUDE_CODE_USE_BEDROCK=1

# Persist Claude Code's per-conversation state on session storage so it survives
# microVM stop/restart for the same session id.
export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/mnt/workspace/.claude-data}"
mkdir -p "$CLAUDE_CONFIG_DIR"

WORKSPACE_DIR="${WORKSPACE_DIR:-/mnt/workspace}"
mkdir -p "$WORKSPACE_DIR"
cd "$WORKSPACE_DIR"

# GitHub auth for private clone/push (mirrors the fleet container's git setup).
if [ -n "${GITHUB_PAT:-}" ]; then
  git config --global "url.https://x-access-token:${GITHUB_PAT}@github.com/.insteadOf" "https://github.com/"
  git config --global user.email "${GIT_AUTHOR_EMAIL:-agent@agentcore-hub.example.com}"
  git config --global user.name "${GIT_AUTHOR_NAME:-AgentCore Hub Agent}"
fi

MODEL="${ANTHROPIC_MODEL:-${CLAUDE_MODEL:-us.anthropic.claude-opus-4-6-v1}}"
PROMPT="${1:?run-claude.sh requires a task prompt}"

exec claude \
  --print \
  --dangerously-skip-permissions \
  --output-format stream-json \
  --verbose \
  --model "$MODEL" \
  --max-turns "${MAX_TURNS:-100}" \
  "$PROMPT" < /dev/null
