#!/usr/bin/env bash
# shell-init.sh — sourced by every interactive Terminal-tab shell (via ~/.bashrc).
#
# Makes bare `claude` / `codex` "just work" with no login screen: Claude uses
# Bedrock (env var); Codex uses our Bedrock Mantle provider + a freshly minted
# bearer token. Mirrors what run-claude/run-codex set up for headless turns, so
# the interactive terminal matches the chat experience.

export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$AWS_REGION}"
export WORKSPACE_ROOT="${WORKSPACE_ROOT:-/mnt/workspace}"

# Claude Code installs to ~/.local/bin; a non-login Terminal shell doesn't have
# it on PATH, so `claude` reads as "command not found". Add it (and npm globals).
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"

# ── Claude Code → Bedrock (no key) ──
export CLAUDE_CODE_USE_BEDROCK=1
export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$WORKSPACE_ROOT/.claude-data}"
export ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-${CLAUDE_MODEL:-us.anthropic.claude-opus-4-6-v1}}"
mkdir -p "$CLAUDE_CONFIG_DIR" 2>/dev/null || true

# ── Codex → Bedrock Mantle (no OpenAI key) ──
export BEDROCK_MANTLE_REGION="${BEDROCK_MANTLE_REGION:-us-east-2}"
export CODEX_HOME="${CODEX_HOME:-$WORKSPACE_ROOT/.codex}"
export CODEX_MODEL="${CODEX_MODEL:-openai.gpt-5.5}"
mkdir -p "$CODEX_HOME" 2>/dev/null || true

# Ensure the Bedrock provider block is present (merges, never clobbers a
# user-uploaded config.toml). Quiet — don't spam the terminal on every shell.
python3 /app/merge-codex-config.py "$CODEX_HOME/config.toml" \
  "$CODEX_MODEL" \
  "https://bedrock-mantle.${BEDROCK_MANTLE_REGION}.api.aws/openai/v1" \
  "${BEDROCK_MANTLE_PROJECT:-default}" 2>/dev/null || true

# Mint a short-term Bedrock bearer token so `codex` doesn't prompt for an API
# key. Lazy helper too: `codextoken` refreshes it if the session runs long.
codextoken() {
  local t
  t="$(BEDROCK_REGION="$BEDROCK_MANTLE_REGION" python3 - <<'PY' 2>/dev/null
import os
try:
    from aws_bedrock_token_generator import provide_token
    print(provide_token(region=os.environ["BEDROCK_REGION"]), end="")
except Exception:
    print("", end="")
PY
)"
  [ -n "$t" ] && export OPENAI_API_KEY="$t"
}
codextoken

if [ -t 1 ]; then
  echo "Coding agents ready: 'claude' (Bedrock) · 'codex' (GPT-5.5 via Mantle). No login needed."
  echo "Workspace: $WORKSPACE_ROOT   (run 'codextoken' if codex auth expires)"
fi
