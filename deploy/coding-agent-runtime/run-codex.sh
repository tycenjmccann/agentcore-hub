#!/usr/bin/env bash
# ============================================================
# Codex launcher for AgentCore Runtime (headless)
# ============================================================
# Routes inference through Amazon Bedrock on ONE of its two OpenAI-compatible
# homes, whichever the model registry says this model lives on (DL-033):
#
#   endpoint=bedrock-runtime  https://bedrock-runtime.<region>.amazonaws.com/openai/v1
#     Serves the inference-profile ids (us.openai.gpt-…). No OpenAI-Project
#     header. This is the documented Codex-on-Bedrock path:
#     https://developers.openai.com/codex/amazon-bedrock
#
#   endpoint=bedrock-mantle   https://bedrock-mantle.<region>.api.aws/openai/v1
#     Serves the bare ids (openai.gpt-…) and REQUIRES an `OpenAI-Project`
#     header — without it every call answers "Engine not found", which is why we
#     declare our own provider instead of using codex's built-in
#     `amazon-bedrock` one (it never sends that header).
#
# Both: wire_api = responses (GPT-5 class only supports /responses), and
# OPENAI_API_KEY is a short-term Bedrock bearer token minted from the microVM IAM
# role (aws_bedrock_token_generator) — never an OpenAI key. Provider/model keys
# are written by merge-codex-config.py; config reference:
# https://developers.openai.com/codex/config-file/config-reference
#
# Emits JSONL on stdout (`codex exec --json`) so the caller can publish per-tool
# live events.
#
# Usage: run-codex.sh "<task prompt>" [resume-thread-id]
# ============================================================
set -euo pipefail

export AWS_REGION="${AWS_REGION:-us-east-1}"
# MANTLE-ONLY (TEAM-4995): this is the Mantle mint/host region, never a
# bedrock-runtime one. The resolved model's own region arrives as CODEX_REGION.
BEDROCK_MANTLE_REGION="${BEDROCK_MANTLE_REGION:-us-east-2}"

WORKSPACE_DIR="${WORKSPACE_DIR:-/mnt/workspace}"
mkdir -p "$WORKSPACE_DIR"
cd "$WORKSPACE_DIR"

# GitHub auth for private clone/push (mirrors the fleet container's git setup).
if [ -n "${GITHUB_PAT:-}" ]; then
  git config --global "url.https://x-access-token:${GITHUB_PAT}@github.com/.insteadOf" "https://github.com/"
  git config --global user.email "${GIT_AUTHOR_EMAIL:-agent@agentcore-hub.example.com}"
  git config --global user.name "${GIT_AUTHOR_NAME:-AgentCore Hub Agent}"
fi

PROMPT="${1:?run-codex.sh requires a task prompt}"
# Optional: a prior codex session id (thread_id) to resume the conversation.
RESUME_ID="${2:-}"

# ── Resolve model + endpoint from the one model registry (config/models.json) ──
# The exporter prints CODEX_RESOLVED_MODEL / CODEX_ENDPOINT / CODEX_REGION /
# CODEX_API / CODEX_BASE_URL / CODEX_CONTEXT_WINDOW, already shell-quoted, and
# always exits 0 — an unreadable registry degrades to its literals rather than
# killing the turn. main.py pre-stamps CODEX_MODEL with this turn's resolved id
# (a tier name never reaches here from the fleet); a Terminal or commands-API run
# has only the env, so resolution happens here.
eval "$(python3 /app/models_registry.py --export codex "${CODEX_MODEL:-}")"

# Belt-and-braces. REGION_RE is enforced in Python, but this value goes into a
# URL and into a SigV4 signature — refuse an unusable one rather than signing for
# nowhere and failing with an opaque 403.
if ! printf '%s' "${CODEX_REGION:-}" | grep -Eq '^[a-z]{2}(-gov)?-[a-z]+-[0-9]$'; then
  echo "[codex] ERROR: bad CODEX_REGION '${CODEX_REGION:-}'" >&2
  exit 2
fi
# Every AWS call from this turn belongs to the model's region. On the mantle
# branch that IS BEDROCK_MANTLE_REGION (the exporter's fallback) unless a catalog
# row pins another one — in which case the row wins, so base URL and signature
# keep agreeing.
export AWS_DEFAULT_REGION="$CODEX_REGION"

case "$CODEX_ENDPOINT" in
  bedrock-runtime)
    PROJECT=""            # no OpenAI-Project header on this endpoint
    ;;
  bedrock-mantle)
    PROJECT="${BEDROCK_MANTLE_PROJECT:-default}"
    ;;
  *)
    echo "[codex] ERROR: unknown CODEX_ENDPOINT '$CODEX_ENDPOINT'" >&2
    exit 2
    ;;
esac

# ── Mint a short-term Bedrock bearer token from the IAM role ──
if [ -z "${OPENAI_API_KEY:-}" ]; then
  TOKEN=$(BEDROCK_REGION="$CODEX_REGION" python3 - <<'PYEOF'
import os
try:
    from aws_bedrock_token_generator import provide_token
    print(provide_token(region=os.environ["BEDROCK_REGION"]), end="")
except Exception:
    print("", end="")
PYEOF
  )
  if [ -z "$TOKEN" ]; then
    echo "[codex] ERROR: could not mint Bedrock token" >&2
    exit 4
  fi
  export OPENAI_API_KEY="$TOKEN"
fi

# ── Codex config: ensure our Bedrock provider, keep the user's rest ──────────
# Persist CODEX_HOME on session storage so recorded sessions (under
# $CODEX_HOME/sessions) survive microVM stop/restart and can be resumed, and so
# a user-uploaded config.toml (MCP servers, profiles) persists here too.
# merge-codex-config.py guarantees our provider/model wins without clobbering
# the user's mcp_servers / profiles / prefs.
export CODEX_HOME="${CODEX_HOME:-$WORKSPACE_DIR/.codex}"
mkdir -p "$CODEX_HOME"
# Codex's SQLite DBs (WAL mode) must NOT sit on the shared EFS CODEX_HOME: WAL
# across NFS clients corrupts them. Container-local /tmp is private per microVM;
# transcripts (sessions/) stay on EFS and resume falls back to them.
export CODEX_SQLITE_HOME="${CODEX_SQLITE_HOME:-/tmp/codex-sqlite}"
mkdir -p "$CODEX_SQLITE_HOME"
python3 /app/merge-codex-config.py "$CODEX_HOME/config.toml" \
  "$CODEX_RESOLVED_MODEL" "$CODEX_BASE_URL" "$CODEX_ENDPOINT" \
  "$PROJECT" "$CODEX_CONTEXT_WINDOW"

echo "[codex] endpoint=${CODEX_ENDPOINT} base_url=${CODEX_BASE_URL} model=${CODEX_RESOLVED_MODEL} resume=${RESUME_ID:-no}" >&2

# Build the codex invocation. With a RESUME_ID we continue that recorded session
# (`codex exec resume <id> <prompt>`); otherwise start a fresh one. --skip-git-repo-check
# lets it run outside a git repo (and resume doesn't accept --yolo, so pass the
# sandbox/approval bypass explicitly for parity with the fresh-run --yolo).
if [ -n "$RESUME_ID" ]; then
  set -- exec resume "$RESUME_ID" --json --model "$CODEX_RESOLVED_MODEL" \
    --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "$PROMPT"
else
  set -- exec --json --model "$CODEX_RESOLVED_MODEL" --yolo --skip-git-repo-check "$PROMPT"
fi

# GPT-5.5 on Mantle (preview) intermittently returns "Engine not found" (the
# on-demand engine is cold). Codex surfaces it as a turn error and exits without
# retrying, so retry the whole run here until the engine answers. Each attempt
# streams its JSONL straight through so the caller still gets live events; we
# only loop when the WHOLE attempt failed on the cold-engine signal.
ATTEMPTS="${CODEX_ENGINE_RETRIES:-6}"
TMP_OUT="$(mktemp)"
for i in $(seq 1 "$ATTEMPTS"); do
  set +e
  codex "$@" < /dev/null | tee "$TMP_OUT"
  rc=${PIPESTATUS[0]}
  set -e
  if [ "$rc" -eq 0 ] && ! grep -q "Engine not found" "$TMP_OUT"; then
    rm -f "$TMP_OUT"; exit 0
  fi
  if grep -q "Engine not found" "$TMP_OUT"; then
    echo "[codex] cold engine (attempt $i/$ATTEMPTS) — retrying..." >&2
    sleep 3
    continue
  fi
  # A non-cold-engine failure — don't mask it.
  rm -f "$TMP_OUT"; exit "$rc"
done
rm -f "$TMP_OUT"
echo "[codex] gave up after $ATTEMPTS attempts (Mantle engine stayed cold)" >&2
exit 5
