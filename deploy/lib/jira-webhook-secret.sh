#!/bin/bash
# ─── JIRA_WEBHOOK_SECRET format guard (TEAM-6334) ─────────────────────────────
# The ONE definition of what a Jira webhook secret may look like. Both writers
# source it: deploy/apprunner/setup-jira-webhook.sh (the Jira side) and
# deploy/ecs-express/set-env.sh (the hub side). Jira signs with the exact bytes
# it is given and the hub verifies with the exact bytes it is given
# (src/app/api/jira/webhook/route.ts, no trimming) — so the two writers must
# pass the value through unchanged. They cannot promise that for arbitrary
# bytes: set-env.sh joins its KEY=VALUE args on "\n" (a trailing newline
# vanishes, an embedded one splits the value), and .env.local is `source`d by
# bash (`$`, backtick, quotes, `\`, `#` all expand or comment). Constraining
# the charset is what makes "byte-for-byte on both sides" (DEPLOY.md "Jira
# webhook signing") true.
#
# Allowed: [A-Za-z0-9._~+/=-]+ — covers `openssl rand -hex 32` (recommended)
# and base64. Never prints the value.
# ───────────────────────────────────────────────────────────────────────────────

JIRA_WEBHOOK_SECRET_PATTERN='^[A-Za-z0-9._~+/=-]+$'

# require_jira_webhook_secret_format VALUE → 0 if VALUE is safe, else prints a
# one-line reason to stderr (never the value) and returns 1. The caller decides
# whether to exit.
require_jira_webhook_secret_format() {
  local value="$1"
  if [[ "$value" =~ $JIRA_WEBHOOK_SECRET_PATTERN ]]; then
    return 0
  fi
  local why="contains a character outside [A-Za-z0-9._~+/=-]"
  if [[ -z "$value" ]]; then
    why="is empty"
  elif [[ "$value" == *[[:space:]]* ]]; then
    why="contains whitespace or a newline (a trailing newline from echo / copy-paste is the usual cause)"
  fi
  echo "ERROR: ✗ JIRA_WEBHOOK_SECRET $why. Jira and the hub would sign with different bytes (DEPLOY.md 'Jira webhook signing')." >&2
  echo "       Generate one with: openssl rand -hex 32  — and use the same value in .env.local (Jira side) and ./deploy/ecs-express/set-env.sh (hub side)." >&2
  return 1
}
