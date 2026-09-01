#!/usr/bin/env bash
# shell-init.sh — sourced by every interactive Terminal-tab shell.
#
# Makes bare `claude` / `codex` / `gh` "just work" with no login screen: Claude
# uses Bedrock (env var); Codex uses our Bedrock Mantle provider + a freshly
# minted bearer token; gh uses GITHUB_PAT. Mirrors what the headless launchers
# set up, so the interactive terminal matches the chat experience.

# Sourced from both /etc/bash.bashrc and ~/.bashrc — run once per shell.
[ -n "$_CODING_SHELL_INIT_DONE" ] && return 0
export _CODING_SHELL_INIT_DONE=1

# The PTY shell does NOT inherit the server process's env (where AgentCore
# injects GITHUB_PAT, model ids, ARTIFACT_BUCKET). The server writes them to the
# writable workspace mount on startup so the interactive terminal sees them.
for _envf in /mnt/efs/.runtime-env.sh /mnt/workspace/.runtime-env.sh; do
  [ -f "$_envf" ] && source "$_envf" && break
done

export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$AWS_REGION}"
# EFS-backed workspace (set by deploy.py via WORKSPACE_ROOT); /mnt/efs default.
export WORKSPACE_ROOT="${WORKSPACE_ROOT:-/mnt/efs}"

# Claude Code installs to ~/.local/bin; a non-login Terminal shell doesn't have
# it on PATH, so `claude` reads as "command not found". Add it (and npm globals
# + /usr/local/bin where uv/uvx live).
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"

# Browser-automation MCP servers (puppeteer/playwright) use the system chromium
# baked into the image instead of downloading one per session.
export PUPPETEER_EXECUTABLE_PATH="${PUPPETEER_EXECUTABLE_PATH:-/usr/bin/chromium}"
export PUPPETEER_SKIP_DOWNLOAD="${PUPPETEER_SKIP_DOWNLOAD:-1}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-0}"

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

# ── Kiro → the shared access key (no Bedrock; bring-your-own-key only) ──
# The runtime carries ONE KIRO_API_KEY on its env (exported to .runtime-env.sh),
# so bare `kiro-cli chat` runs without a login. KIRO_HOME points at the SQLite
# session store; XDG_DATA_HOME must match it (kiro's DB follows $XDG_DATA_HOME).
export KIRO_HOME="${KIRO_HOME:-$WORKSPACE_ROOT/.kiro-data}"
export XDG_DATA_HOME="$KIRO_HOME"
mkdir -p "$KIRO_HOME" 2>/dev/null || true
if [ -n "${KIRO_API_KEY:-}" ]; then
  _KIRO_STATUS=" · 'kiro' (your access key)"
fi

# ── GitHub CLI / git → authenticated via the PAT (no `gh auth login`) ──
if [ -n "${GITHUB_PAT:-}" ]; then
  export GH_TOKEN="$GITHUB_PAT"
  export GITHUB_TOKEN="$GITHUB_PAT"
  git config --global "url.https://x-access-token:${GITHUB_PAT}@github.com/.insteadOf" "https://github.com/" 2>/dev/null || true
  git config --global --add safe.directory '*' 2>/dev/null || true
fi

if [ -t 1 ]; then
  echo "Coding agents ready: 'claude' (Bedrock) · 'codex' (GPT-5.5 via Mantle)${_KIRO_STATUS:-} · 'gh' (authed). No login needed."
  echo "Workspace: $WORKSPACE_ROOT   (run 'codextoken' if codex auth expires)"
fi

# ── Auto-resume the session's conversation in the Terminal ──
# The server writes .resume-launch.sh (CC_RESUME_DIR + CC_RESUME_SID +
# CC_RESUME_CLI) whenever a session has a conversation to continue. Launch it
# HERE — once per fresh interactive shell; the run-once guard at the top means a
# PTY reattach to an already-running CLI never reaches this line. So the browser
# never types the resume command into a live TUI input box. `exec` replaces the
# shell with the CLI, so exiting the agent ends the PTY cleanly like a normal
# session. Container-local (/tmp), NOT on EFS — EFS is shared across sessions, so
# a hint there would resume the wrong conversation. One microVM per session means
# /tmp is private to this session. Must match RESUME_HINT_PATH in main.py.
_resume_hint="/tmp/.resume-launch.sh"
if [ -t 1 ] && [ -t 0 ] && [ -f "$_resume_hint" ]; then
  # shellcheck disable=SC1090
  . "$_resume_hint"
  if [ -n "${CC_RESUME_SID:-}" ]; then
    cd "${CC_RESUME_DIR:-$WORKSPACE_ROOT}" 2>/dev/null || cd "$WORKSPACE_ROOT"
    case "${CC_RESUME_CLI:-claude}" in
      codex) exec codex resume "$CC_RESUME_SID" ;;
      kiro)
        # Kiro's SQLite store follows $XDG_DATA_HOME; the chat path pins it at the
        # session's KIRO_HOME. Match it so the Terminal resumes the same convo.
        [ -n "${CC_RESUME_KIRO_HOME:-}" ] && export KIRO_HOME="$CC_RESUME_KIRO_HOME" && export XDG_DATA_HOME="$CC_RESUME_KIRO_HOME"
        exec kiro-cli chat --resume-id "$CC_RESUME_SID" ;;
      *) exec claude --resume "$CC_RESUME_SID" ;;
    esac
  fi
fi
