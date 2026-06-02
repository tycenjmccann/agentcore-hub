#!/usr/bin/env bash
#
# deploy/apprunner/setup-jira-webhook.sh — Idempotent Jira webhook setup
#
# Uses the legacy admin endpoint (/rest/webhooks/1.0/webhook) which accepts
# PAT-based basic auth, unlike /rest/api/3/webhook which requires OAuth/Connect.
#
# Creates a webhook pointing at DEPLOYMENT_URL/api/jira/webhook
# filtered to the configured JIRA_PROJECT_KEY. Deletes stale webhooks with
# the same name before creating a new one.
#
# Prerequisites (from .env.local):
#   JIRA_SITE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY, DEPLOYMENT_URL
#
# Usage:
#   ./deploy/apprunner/setup-jira-webhook.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

if [[ -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

: "${JIRA_SITE_URL:?JIRA_SITE_URL must be set}"
: "${JIRA_EMAIL:?JIRA_EMAIL must be set}"
: "${JIRA_API_TOKEN:?JIRA_API_TOKEN must be set}"
: "${JIRA_PROJECT_KEY:?JIRA_PROJECT_KEY must be set}"
: "${DEPLOYMENT_URL:?DEPLOYMENT_URL must be set}"

WEBHOOK_NAME="agentcore-hub-workflow"
WEBHOOK_URL="${DEPLOYMENT_URL}/api/jira/webhook"
JIRA_BASE="https://${JIRA_SITE_URL}"
AUTH="${JIRA_EMAIL}:${JIRA_API_TOKEN}"

echo "═══════════════════════════════════════════════════════════════"
echo "  Jira Webhook Setup"
echo "  Site: $JIRA_SITE_URL  Project: $JIRA_PROJECT_KEY"
echo "  Target: $WEBHOOK_URL"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ─── Step 1: List existing webhooks and delete stale ones ─────────────────────

echo "  [1/2] Checking for existing webhooks..."

EXISTING=$(curl -sf -u "$AUTH" \
  "${JIRA_BASE}/rest/webhooks/1.0/webhook" 2>/dev/null || echo "[]")

# Find webhooks with our name or pointing at obviously-stale URLs
STALE_IDS=$(echo "$EXISTING" | python3 -c "
import json, sys
try:
    hooks = json.load(sys.stdin)
    if not isinstance(hooks, list):
        hooks = []
    for h in hooks:
        name = h.get('name', '')
        url = h.get('url', '')
        if name == '${WEBHOOK_NAME}' or '${WEBHOOK_NAME}' in name:
            print(h.get('self', '').split('/')[-1] if '/' in h.get('self', '') else '')
except (json.JSONDecodeError, KeyError):
    pass
" 2>/dev/null || true)

DELETED=0
for wh_id in $STALE_IDS; do
  if [[ -n "$wh_id" ]]; then
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
      -u "$AUTH" \
      "${JIRA_BASE}/rest/webhooks/1.0/webhook/${wh_id}" 2>/dev/null || echo "000")
    if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "204" ]]; then
      DELETED=$((DELETED + 1))
    fi
  fi
done

if [[ $DELETED -gt 0 ]]; then
  echo "        Deleted $DELETED stale webhook(s)"
else
  echo "        No stale webhooks found"
fi
echo ""

# ─── Step 2: Create new webhook ──────────────────────────────────────────────

echo "  [2/2] Creating webhook..."

WEBHOOK_PAYLOAD=$(cat <<EOF
{
  "name": "${WEBHOOK_NAME}",
  "url": "${WEBHOOK_URL}",
  "events": [
    "jira:issue_created",
    "jira:issue_updated"
  ],
  "filters": {
    "issue-related-events-section": "project = ${JIRA_PROJECT_KEY}"
  },
  "excludeBody": false
}
EOF
)

RESPONSE=$(curl -sf -X POST \
  -u "$AUTH" \
  -H "Content-Type: application/json" \
  -d "$WEBHOOK_PAYLOAD" \
  "${JIRA_BASE}/rest/webhooks/1.0/webhook" 2>&1) || {
    echo "        ERROR: Failed to create webhook" >&2
    echo "        Response: $RESPONSE" >&2
    echo "" >&2
    echo "        If PAT-based webhook creation is blocked by your Jira admin," >&2
    echo "        create the webhook manually in Jira Settings > System > WebHooks:" >&2
    echo "          Name: ${WEBHOOK_NAME}" >&2
    echo "          URL:  ${WEBHOOK_URL}" >&2
    echo "          Events: Issue Created, Issue Updated" >&2
    echo "          Filter: project = ${JIRA_PROJECT_KEY}" >&2
    exit 1
  }

echo "        Webhook created successfully"
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Jira webhook configured"
echo "  ${WEBHOOK_NAME} → ${WEBHOOK_URL}"
echo "  Filter: project = ${JIRA_PROJECT_KEY}"
echo "═══════════════════════════════════════════════════════════════"
