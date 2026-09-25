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

# Puppeteer/MCP browser servers use the system chromium baked into the image
# instead of downloading one per session. Playwright (used by the repo's own
# `npm test`) reads its own build from the baked, version-pinned browser cache
# so a checked-out `playwright test` never downloads mid-run.
export PUPPETEER_EXECUTABLE_PATH="${PUPPETEER_EXECUTABLE_PATH:-/usr/bin/chromium}"
export PUPPETEER_SKIP_DOWNLOAD="${PUPPETEER_SKIP_DOWNLOAD:-1}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"

# ── One model registry (config/models.json — DL-033) ──
# Resolve both CLIs in one call: the exporter prints CLAUDE_RESOLVED_MODEL /
# CODEX_RESOLVED_MODEL / CODEX_ENDPOINT / CODEX_REGION / CODEX_BASE_URL /
# CODEX_CONTEXT_WINDOW (shell-quoted) and carries its own literal fallbacks, so
# this file holds no model id of its own. Never fatal — a Terminal must still
# open if the registry (or boto3) is unavailable.
eval "$(python3 /app/models_registry.py --export claude codex 2>/dev/null)" || true

# ── Read the Terminal auto-resume hint (launched at the bottom) ──
# The server writes .resume-launch.sh (CC_RESUME_DIR + CC_RESUME_SID +
# CC_RESUME_CLI [+ CC_RESUME_MODEL / CC_RESUME_KIRO_HOME]) whenever a session has
# a conversation to continue. Plain assignments; read HERE, before the Codex
# config is written, because a codex thread must resume under its own model.
# Container-local (/tmp), NOT on EFS — EFS is shared across sessions, so a hint
# there would resume the wrong conversation. One microVM per session means /tmp
# is private to this session. Must match RESUME_HINT_PATH in main.py.
_resume_hint="/tmp/.resume-launch.sh"
if [ -t 1 ] && [ -t 0 ] && [ -f "$_resume_hint" ]; then
  # shellcheck disable=SC1090
  . "$_resume_hint"
fi
# A codex thread's reasoning is encrypted for the model that wrote it, so
# resuming it under another one fails on Bedrock ("encrypted reasoning was
# created for a different account or model" — TEAM-5066/TEAM-5083). Resolve the
# thread's model (CC_RESUME_MODEL, from main.py's _codex_bound_model) through the
# same exporter run-codex.sh uses, so the model, endpoint, base URL, region and
# token below all follow the THREAD, not today's default. The exporter falls back
# to the default when the model no longer resolves (retired, quarantined,
# ambiguous) — then the thread can't be resumed and we start a new one. No
# CC_RESUME_MODEL (a hint from before the key existed, or an unbound/unknown
# thread) keeps the unpinned resume, the headless guard's "unknown keeps
# resuming" rule.
_cc_resume_fresh=""
if [ "${CC_RESUME_CLI:-}" = "codex" ] && [ -n "${CC_RESUME_SID:-}" ] && [ -n "${CC_RESUME_MODEL:-}" ]; then
  eval "$(python3 /app/models_registry.py --export codex "$CC_RESUME_MODEL" 2>/dev/null)" || true
  if [ "${CODEX_RESOLVED_MODEL:-}" = "$CC_RESUME_MODEL" ]; then
    # The thread's model beats the default AND any deploy-env CODEX_MODEL.
    export CODEX_MODEL="$CC_RESUME_MODEL"
  else
    _cc_resume_fresh=1
  fi
fi

# ── Claude Code → Bedrock (no key) ──
export CLAUDE_CODE_USE_BEDROCK=1
export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$WORKSPACE_ROOT/.claude-data}"
export ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-${CLAUDE_MODEL:-${CLAUDE_RESOLVED_MODEL:-}}}"
# Nothing resolved (no python/module) → leave it unset so claude picks its own
# default rather than being handed an empty --model.
[ -n "$ANTHROPIC_MODEL" ] || unset ANTHROPIC_MODEL
mkdir -p "$CLAUDE_CONFIG_DIR" 2>/dev/null || true

# ── Codex → Bedrock (no OpenAI key) ──
# Mantle mint/host region only; a bedrock-runtime model travels on CODEX_REGION.
export BEDROCK_MANTLE_REGION="${BEDROCK_MANTLE_REGION:-us-east-2}"
export CODEX_HOME="${CODEX_HOME:-$WORKSPACE_ROOT/.codex}"
export CODEX_MODEL="${CODEX_MODEL:-${CODEX_RESOLVED_MODEL:-}}"
mkdir -p "$CODEX_HOME" 2>/dev/null || true
# SQLite state DBs off the shared EFS (WAL over NFS corrupts them; see run-codex.sh).
export CODEX_SQLITE_HOME="${CODEX_SQLITE_HOME:-/tmp/codex-sqlite}"
mkdir -p "$CODEX_SQLITE_HOME" 2>/dev/null || true

# Ensure the Bedrock provider block is present (merges, never clobbers a
# user-uploaded config.toml). The endpoint, base URL and context window all come
# from the registry export above, so the Terminal and the headless launcher write
# the SAME provider. Quiet — don't spam the terminal on every shell.
python3 /app/merge-codex-config.py "$CODEX_HOME/config.toml" \
  "$CODEX_MODEL" \
  "${CODEX_BASE_URL:-}" \
  "${CODEX_ENDPOINT:-}" \
  "${BEDROCK_MANTLE_PROJECT:-default}" \
  "${CODEX_CONTEXT_WINDOW:-}" 2>/dev/null || true

# Mint a short-term Bedrock bearer token so `codex` doesn't prompt for an API
# key. Lazy helper too: `codextoken` refreshes it if the session runs long.
codextoken() {
  local t
  t="$(BEDROCK_REGION="${CODEX_REGION:-$BEDROCK_MANTLE_REGION}" python3 - <<'PY' 2>/dev/null
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
  echo "Coding agents ready: 'claude' (Bedrock) · 'codex' (Bedrock)${_KIRO_STATUS:-} · 'gh' (authed). No login needed."
  echo "Workspace: $WORKSPACE_ROOT   (run 'codextoken' if codex auth expires)"
fi

# ── Auto-resume the session's conversation in the Terminal ──
# The hint was read above. Launch it HERE — once per fresh interactive shell;
# the run-once guard at the top means a PTY reattach to an already-running CLI
# never reaches this line. So the browser never types the resume command into a
# live TUI input box. `exec` replaces the shell with the CLI, so exiting the
# agent ends the PTY cleanly like a normal session.
if [ -t 1 ] && [ -t 0 ] && [ -n "${CC_RESUME_SID:-}" ]; then
  cd "${CC_RESUME_DIR:-$WORKSPACE_ROOT}" 2>/dev/null || cd "$WORKSPACE_ROOT"
  case "${CC_RESUME_CLI:-claude}" in
    codex)
      if [ -n "$_cc_resume_fresh" ]; then
        echo "codex: thread $CC_RESUME_SID ran on $CC_RESUME_MODEL, which can't be used any more; starting a new thread on ${CODEX_MODEL:-the default model}." >&2
        exec codex
      elif [ -n "${CC_RESUME_MODEL:-}" ]; then
        exec codex resume -m "$CODEX_MODEL" "$CC_RESUME_SID"
      else
        exec codex resume "$CC_RESUME_SID"
      fi ;;
    kiro)
      # Kiro's SQLite store follows $XDG_DATA_HOME; the chat path pins it at the
      # session's KIRO_HOME. Match it so the Terminal resumes the same convo.
      [ -n "${CC_RESUME_KIRO_HOME:-}" ] && export KIRO_HOME="$CC_RESUME_KIRO_HOME" && export XDG_DATA_HOME="$CC_RESUME_KIRO_HOME"
      exec kiro-cli chat --resume-id "$CC_RESUME_SID" ;;
    *) exec claude --resume "$CC_RESUME_SID" ;;
  esac
fi
