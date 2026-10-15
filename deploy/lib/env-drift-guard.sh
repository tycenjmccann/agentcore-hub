#!/bin/bash
# ─── Live env-key drift guard (TEAM-6337) ─────────────────────────────────────
# deploy/ecs-express/deploy.sh and deploy/apprunner/deploy.sh REPLACE the whole
# container env with their forward allow-list (shell + .env.local). Keys applied
# live with deploy/ecs-express/set-env.sh (TELEGRAM_*, ANOMALY_INTAKE_SECRET,
# CODING_AGENT_RUNTIME_ARN, JIRA_WEBHOOK_SECRET …) that the new env lacks would
# silently vanish. Both scripts source this and, when the service already
# exists, refuse BEFORE any IAM/ECR/docker step unless ALLOW_ENV_KEY_DROP=1.
#
# Key names only — a value never leaves python and is never printed.
# ───────────────────────────────────────────────────────────────────────────────

# live_env_keys ecs|apprunner < describe-json → one live env key per line.
# Exits non-zero on a degraded describe (no container / no env), so the caller
# fails closed — same rule as set-env.sh.
live_env_keys() {
  python3 -c '
import json, sys
kind = sys.argv[1]
try:
    d = json.load(sys.stdin)
except ValueError:
    sys.exit(1)
if kind == "ecs":
    s = d.get("service", {}) or {}
    pcs = [c["primaryContainer"] for c in s.get("activeConfigurations", []) or [] if c.get("primaryContainer")]
    if s.get("primaryContainer"):
        pcs.append(s["primaryContainer"])
    env = pcs[0].get("environment") if pcs else None
    keys = [e["name"] for e in env] if isinstance(env, list) else []
else:
    img = (((d.get("Service", {}) or {}).get("SourceConfiguration", {}) or {})
           .get("ImageRepository", {}) or {}).get("ImageConfiguration", {}) or {}
    env = img.get("RuntimeEnvironmentVariables")
    keys = list(env) if isinstance(env, dict) else []
if not keys:
    sys.exit(1)
print("\n".join(keys))
' "$1"
}

# require_no_env_key_drop SERVICE LIVE_KEYS NEW_KEYS → 0 when every live key is
# in the new env (or ALLOW_ENV_KEY_DROP=1, with a warning); else prints the
# missing key names to stderr and returns 1. KEYS are newline-separated.
require_no_env_key_drop() {
  local service="$1" live="$2" new="$3" dropped
  dropped="$(comm -23 <(printf '%s\n' "$live" | sed '/^$/d' | LC_ALL=C sort -u) \
                      <(printf '%s\n' "$new" | sed '/^$/d' | LC_ALL=C sort -u) | paste -sd, - | sed 's/,/, /g')"
  [[ -z "$dropped" ]] && return 0
  if [[ "${ALLOW_ENV_KEY_DROP:-}" == "1" ]]; then
    echo "WARNING: dropping live env keys: $dropped (ALLOW_ENV_KEY_DROP=1)" >&2
    return 0
  fi
  echo "ERROR: ✗ live $service env has keys the new env lacks: $dropped" >&2
  echo "       A full redeploy replaces the whole env from .env.local, so these would be lost." >&2
  if [[ "$service" == "ECS" ]]; then
    echo "       Add them to .env.local before redeploying (if the script forwards them), or" >&2
    echo "       re-apply them with deploy/ecs-express/set-env.sh after this deploy, or re-run" >&2
    echo "       with ALLOW_ENV_KEY_DROP=1 to drop them on purpose." >&2
  else
    echo "       Add them to .env.local before redeploying (if the script forwards them), or" >&2
    echo "       re-run with ALLOW_ENV_KEY_DROP=1 to drop them on purpose." >&2
  fi
  return 1
}
