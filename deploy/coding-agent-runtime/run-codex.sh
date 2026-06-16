#!/usr/bin/env bash
# ============================================================
# Codex launcher for AgentCore Runtime (headless)
# ============================================================
# Routes inference through Amazon Bedrock "Mantle" (OpenAI-compatible). Codex's
# built-in `amazon-bedrock` provider does NOT send the `OpenAI-Project` header
# that GPT-5.5 on Mantle requires (its absence yields "Engine not found"), so we
# define an explicit OpenAI-compatible provider instead:
#   base_url = https://bedrock-mantle.<region>.api.aws/openai/v1
#   wire_api = responses                       (GPT-5.5 only supports /responses)
#   http_headers = { OpenAI-Project = default }
#   OPENAI_API_KEY = short-term Bedrock bearer token (aws_bedrock_token_generator)
#
# Verified working combo: model openai.gpt-5.5, us-east-2, /openai/v1, responses
# API, OpenAI-Project=default. No OpenAI key — the bearer token is minted from
# the microVM IAM role.
#
# Emits JSONL on stdout (`codex exec --json`) so the caller can publish per-tool
# live events.
#
# Usage: run-codex.sh "<task prompt>"
# ============================================================
set -euo pipefail

export AWS_REGION="${AWS_REGION:-us-east-1}"
BEDROCK_MANTLE_REGION="${BEDROCK_MANTLE_REGION:-us-east-2}"
export AWS_DEFAULT_REGION="$BEDROCK_MANTLE_REGION"

WORKSPACE_DIR="${WORKSPACE_DIR:-/mnt/workspace}"
mkdir -p "$WORKSPACE_DIR"
cd "$WORKSPACE_DIR"

MODEL="${CODEX_MODEL:-openai.gpt-5.5}"
PROJECT="${BEDROCK_MANTLE_PROJECT:-default}"
BASE_URL="https://bedrock-mantle.${BEDROCK_MANTLE_REGION}.api.aws/openai/v1"
PROMPT="${1:?run-codex.sh requires a task prompt}"

# ── Mint a short-term Bedrock bearer token from the IAM role ──
if [ -z "${OPENAI_API_KEY:-}" ]; then
  TOKEN=$(BEDROCK_REGION="$BEDROCK_MANTLE_REGION" python3 - <<'PYEOF'
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

# ── Codex config: explicit OpenAI-compatible provider → Bedrock Mantle ───────
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
mkdir -p "$CODEX_HOME"
cat > "$CODEX_HOME/config.toml" <<EOF
model = "${MODEL}"
model_provider = "bedrock-mantle"

[model_providers.bedrock-mantle]
name = "Amazon Bedrock Mantle (OpenAI-compatible)"
base_url = "${BASE_URL}"
env_key = "OPENAI_API_KEY"
wire_api = "responses"

[model_providers.bedrock-mantle.http_headers]
OpenAI-Project = "${PROJECT}"
EOF

echo "[codex] base_url=${BASE_URL} model=${MODEL} project=${PROJECT}" >&2

# GPT-5.5 on Mantle (preview) intermittently returns "Engine not found" (the
# on-demand engine is cold). Codex surfaces it as a turn error and exits without
# retrying, so retry the whole run here until the engine answers. Each attempt
# streams its JSONL straight through so the caller still gets live events; we
# only loop when the WHOLE attempt failed on the cold-engine signal.
ATTEMPTS="${CODEX_ENGINE_RETRIES:-6}"
TMP_OUT="$(mktemp)"
for i in $(seq 1 "$ATTEMPTS"); do
  set +e
  codex exec --json --model "$MODEL" --yolo --skip-git-repo-check "$PROMPT" < /dev/null \
    | tee "$TMP_OUT"
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
