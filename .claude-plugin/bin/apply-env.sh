#!/usr/bin/env bash
# Writes .env.local from a JSON answer blob produced by the /setup skill.
# Backs up an existing .env.local to .env.local.bak before overwriting.
#
# Usage: apply-env.sh <answers.json>
#
# Expected answers.json shape:
# {
#   "brand_name": "Bob's AI Hub",
#   "modules": ["core", "builder", "workflow", "evaluations"],
#   "ticket_provider": "dynamodb" | "jira",
#   "workflow_runtimes": 1 | 4 | 14,
#   "deploy_mode": "lightweight" | "robust",
#   "aws_account": "123456789012",
#   "aws_region": "us-east-1",
#   "aws_profile": "default",
#   "deploy_target": "local" | "apprunner" | "byo" | "skip",
#   "github": { "mode": "pat" | "mcp" | "skip", "pat": "...", "mcp_servers": "...", "owner": "octocat", "repo": "my-project" },
#   "jira": { "site_url": "...", "email": "...", "api_token": "...", "project_key": "...",
#             "webhook_secret": "..." (optional),
#             "disable_webhook_signing": true (optional, strict JSON boolean) } | null
# }
#
# JIRA_WEBHOOK_SECRET (TEAM-6336, TEAM-6347): the /setup skill never asks for
# it — DEPLOY.md ("Jira webhook signing") has the operator add it to .env.local
# by hand — so a re-run regenerating this file used to drop the line, and the
# next full redeploy (deploy/*/deploy.sh forward it from .env.local) silently
# returned the hub to unsigned passthrough. Resolution: answers.jira.webhook_secret
# wins when non-empty; otherwise the value already in .env.local is carried
# over; otherwise the key stays absent (signing off, as before).
#
# The resolved value is ALWAYS emitted, independent of the module set and the
# ticket provider (TEAM-6347 R2-F1: the emit used to sit inside the
# workflow/jira branch, so re-running with modules ["core","cloud-code"] — or
# switching the provider to dynamodb — dropped it). /api/jira/webhook is the
# only consumer and keeping a signing key is never the weaker posture. The ONE
# way to drop it is answers.jira.disable_webhook_signing === true (strict JSON
# boolean): carry-over and emit are skipped and a notice is printed. Giving
# both a non-empty webhook_secret and the disable flag is refused as
# contradictory. A non-empty value is checked against the shared charset rule
# BEFORE the backup/overwrite, so a refused run leaves .env.local untouched;
# the disable path skips the guard, since a malformed leftover line must not
# block its own removal.
#
# DEPLOYMENT_URL is carried over the same way (last known value; the skill's
# deploy-target step overwrites it). Without it a re-run could not run
# deploy/apprunner/setup-jira-webhook.sh BEFORE the hub redeploy, which is the
# Jira-first order DEPLOY.md requires (TEAM-6347 R2-F2). When the answers bring
# a secret that differs from the on-disk one and a real (non-placeholder)
# DEPLOYMENT_URL exists, one `JIRA_WEBHOOK_SECRET_NEW=1 …` marker line is
# printed so the skill runs the Jira webhook step first. Never printed on a
# first install, on plain carry-over, or when the secret is unchanged.
#
# TEAM-6352 (R3-F2): that marker is for FIRST enablement only (no secret on
# disk). Replacing an already-set secret on an existing deployment is a
# rotation, and with one key no ordering avoids a 401 window — so the old value
# is written to JIRA_WEBHOOK_SECRET_PREVIOUS (the hub accepts either while the
# current one is set) and a `JIRA_WEBHOOK_SECRET_ROTATING=1 …` marker is printed
# instead: redeploy the hub first, then Jira, then drop PREVIOUS. An existing
# PREVIOUS is carried over on a re-run mid-rotation (unless it equals the
# current secret) and dropped with disable_webhook_signing. Values are never
# printed.
#
# brand_name is a *display* string only — sets NEXT_PUBLIC_BRAND_NAME so the
# header, sidebar, and page titles read "Bob's AI Hub" instead of "AgentCore
# Hub". It does NOT affect any AWS resource names. Those are part of the
# application contract and are always created with the canonical
# "agentcore-hub-*" prefix.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <answers.json>" >&2
  exit 2
fi

ANSWERS="$1"
if [[ ! -f "$ANSWERS" ]]; then
  echo "Answer file not found: $ANSWERS" >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required. Install via 'brew install jq' or your package manager." >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.local"

# Read ONE key from the existing .env.local through the same loader every
# consumer uses, in a subshell with the caller's own shell value cleared first
# so only the file counts. Empty when the file or the key is absent.
read_env_local_value() {
  (
    unset "$1"
    # shellcheck disable=SC1091
    source "$REPO_ROOT/deploy/lib/load-env-local.sh"
    load_env_local "$ENV_FILE"
    printf '%s' "${!1:-}"
  )
}

# Resolve JIRA_WEBHOOK_SECRET and DEPLOYMENT_URL before anything is written
# (see the header).
# shellcheck disable=SC1091
source "$REPO_ROOT/deploy/lib/jira-webhook-secret.sh"
disable_webhook_signing=$(jq -r '.jira.disable_webhook_signing == true' "$ANSWERS")
jira_webhook_secret=$(jq -r '.jira.webhook_secret // ""' "$ANSWERS")
if [[ "$disable_webhook_signing" == "true" && -n "$jira_webhook_secret" ]]; then
  echo "ERROR: ✗ answers give both jira.webhook_secret and jira.disable_webhook_signing=true — pick one (DEPLOY.md 'Jira webhook signing')" >&2
  exit 1
fi
existing_secret=$(read_env_local_value JIRA_WEBHOOK_SECRET)
existing_deployment_url=$(read_env_local_value DEPLOYMENT_URL)
existing_previous=$(read_env_local_value JIRA_WEBHOOK_SECRET_PREVIOUS)

secret_is_new=false
secret_rotating=false
jira_webhook_secret_previous=""
if [[ "$disable_webhook_signing" == "true" ]]; then
  jira_webhook_secret=""
  echo "JIRA_WEBHOOK_SECRET: disabled by answers.jira.disable_webhook_signing — not carried over into .env.local. Also unset it on the live service (./deploy/ecs-express/set-env.sh --unset JIRA_WEBHOOK_SECRET, or redeploy) and remove the secret from the Jira webhook (DEPLOY.md 'Jira webhook signing')."
else
  if [[ -z "$jira_webhook_secret" ]]; then
    jira_webhook_secret="$existing_secret"
  elif [[ "$jira_webhook_secret" != "$existing_secret" && -n "$existing_deployment_url" && "$existing_deployment_url" != *placeholder* ]]; then
    if [[ -n "$existing_secret" ]]; then
      secret_rotating=true
      jira_webhook_secret_previous="$existing_secret"
    else
      secret_is_new=true
    fi
  fi
  if [[ "$secret_rotating" != "true" && -n "$existing_previous" && "$existing_previous" != "$jira_webhook_secret" ]]; then
    jira_webhook_secret_previous="$existing_previous"
  fi
  if [[ -n "$jira_webhook_secret" ]]; then
    require_jira_webhook_secret_format "$jira_webhook_secret" || exit 1
  fi
  if [[ -n "$jira_webhook_secret_previous" ]]; then
    require_jira_webhook_secret_format "$jira_webhook_secret_previous" JIRA_WEBHOOK_SECRET_PREVIOUS || exit 1
  fi
fi

if [[ -f "$ENV_FILE" ]]; then
  cp "$ENV_FILE" "$ENV_FILE.bak"
  echo "Backed up existing .env.local → .env.local.bak"
fi

brand_name=$(jq -r '.brand_name // "AgentCore Hub"' "$ANSWERS")
modules=$(jq -r '.modules | join(",")' "$ANSWERS")
ticket_provider=$(jq -r '.ticket_provider // "dynamodb"' "$ANSWERS")
workflow_runtimes=$(jq -r '.workflow_runtimes // 1' "$ANSWERS")
case "$workflow_runtimes" in
  1|4|14) ;;
  *) echo "Invalid workflow_runtimes: $workflow_runtimes (must be 1, 4, or 14)" >&2; exit 2 ;;
esac
deploy_mode=$(jq -r '.deploy_mode // "lightweight"' "$ANSWERS")
case "$deploy_mode" in
  lightweight|robust) ;;
  *) echo "Invalid deploy_mode: $deploy_mode (must be lightweight or robust)" >&2; exit 2 ;;
esac
aws_account=$(jq -r '.aws_account' "$ANSWERS")
aws_region=$(jq -r '.aws_region' "$ANSWERS")
github_mode=$(jq -r '.github.mode // "skip"' "$ANSWERS")
github_pat=$(jq -r '.github.pat // ""' "$ANSWERS")
github_owner=$(jq -r '.github.owner // ""' "$ANSWERS")
github_repo=$(jq -r '.github.repo // ""' "$ANSWERS")
mcp_servers=$(jq -r '.github.mcp_servers // ""' "$ANSWERS")

has_workflow=false
has_evals=false
case ",$modules," in
  *,workflow,*) has_workflow=true ;;
esac
case ",$modules," in
  *,evaluations,*) has_evals=true ;;
esac

# Emit KEY="VALUE" with internal double-quotes/backslashes escaped so values
# containing spaces, '=', '+', or JSON survive `set -a; source .env.local`.
emit() {
  local key="$1" val="$2"
  local escaped="${val//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  echo "${key}=\"${escaped}\""
}

{
  echo "# Generated by .claude-plugin/bin/apply-env.sh — safe to edit by hand"
  echo "# Modules: $modules"
  echo ""
  emit NEXT_PUBLIC_BRAND_NAME "$brand_name"
  emit AWS_REGION "$aws_region"
  echo ""

  # Kept regardless of module set and ticket provider (TEAM-6347, see header).
  if [[ -n "$jira_webhook_secret" || -n "$jira_webhook_secret_previous" || -n "$existing_deployment_url" ]]; then
    echo "# --- Carried over across re-runs (DEPLOY.md 'Jira webhook signing') ---"
    if [[ -n "$jira_webhook_secret" ]]; then
      emit JIRA_WEBHOOK_SECRET "$jira_webhook_secret"
    fi
    if [[ -n "$jira_webhook_secret_previous" ]]; then
      emit JIRA_WEBHOOK_SECRET_PREVIOUS "$jira_webhook_secret_previous"
    fi
    if [[ -n "$existing_deployment_url" ]]; then
      emit DEPLOYMENT_URL "$existing_deployment_url"
    fi
    echo ""
  fi

  if [[ "$has_workflow" == "true" ]]; then
    echo "# --- Workflow module ---"
    emit TICKET_PROVIDER "$ticket_provider"
    emit WORKFLOW_RUNTIME_COUNT "$workflow_runtimes"
    emit DEPLOY_MODE "$deploy_mode"
    emit WORKFLOWS_TABLE "agentcore-hub-workflows"
    emit EVENTS_TABLE "agentcore-hub-events"
    emit ARTIFACT_BUCKET "agentcore-hub-artifacts-$aws_account-$aws_region"
    if [[ "$ticket_provider" == "dynamodb" ]]; then
      emit TICKETS_TABLE "agentcore-hub-tickets"
      emit TICKET_TOOLS_LAMBDA "agentcore-hub-tickets"
    else
      jira_site=$(jq -r '.jira.site_url // ""' "$ANSWERS")
      jira_email=$(jq -r '.jira.email // ""' "$ANSWERS")
      jira_token=$(jq -r '.jira.api_token // ""' "$ANSWERS")
      jira_project=$(jq -r '.jira.project_key // ""' "$ANSWERS")
      emit JIRA_SITE_URL "$jira_site"
      emit JIRA_EMAIL "$jira_email"
      emit JIRA_API_TOKEN "$jira_token"
      emit JIRA_PROJECT_KEY "$jira_project"
      emit TICKET_TOOLS_LAMBDA "agentcore-hub-jira"
    fi

    if [[ "$github_mode" == "pat" && -n "$github_pat" ]]; then
      emit GITHUB_PAT "$github_pat"
    elif [[ "$github_mode" == "mcp" && -n "$mcp_servers" ]]; then
      emit MCP_SERVERS "$mcp_servers"
    fi
    # GITHUB_OWNER/REPO identify the target repo for agent PRs and the fleet
    # health check. Emit whenever provided, independent of auth mode.
    if [[ -n "$github_owner" ]]; then
      emit GITHUB_OWNER "$github_owner"
    fi
    if [[ -n "$github_repo" ]]; then
      emit GITHUB_REPO "$github_repo"
    fi
    echo ""
  fi

  if [[ "$has_evals" == "true" ]]; then
    echo "# --- Evaluations module ---"
    emit EVAL_CONFIG_TABLE "agentcore-hub-eval-config"
    echo ""
  fi
} > "$ENV_FILE"

chmod 600 "$ENV_FILE"
echo "Wrote $ENV_FILE (mode 600)"
if [[ "$secret_is_new" == "true" ]]; then
  echo "JIRA_WEBHOOK_SECRET_NEW=1 — the secret differs from the one the deployed hub was set up with: run ./deploy/apprunner/setup-jira-webhook.sh BEFORE redeploying the hub (Jira first, DEPLOY.md 'Jira webhook signing')"
fi
if [[ "$secret_rotating" == "true" ]]; then
  echo "JIRA_WEBHOOK_SECRET_ROTATING=1 — the secret replaces the one the deployed hub was set up with; the old one is kept as JIRA_WEBHOOK_SECRET_PREVIOUS so the hub accepts both: redeploy the hub FIRST, THEN run ./deploy/apprunner/setup-jira-webhook.sh, THEN remove JIRA_WEBHOOK_SECRET_PREVIOUS from .env.local and redeploy (or ./deploy/ecs-express/set-env.sh --unset JIRA_WEBHOOK_SECRET_PREVIOUS) (DEPLOY.md 'Rotating an enabled secret')"
fi
