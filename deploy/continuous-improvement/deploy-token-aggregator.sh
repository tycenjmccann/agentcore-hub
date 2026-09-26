#!/usr/bin/env bash
# deploy/continuous-improvement/deploy-token-aggregator.sh
#
# Deploys the token-aggregator Lambda and creates subscription filters on every
# evaluations-enabled agent's log group (runtimes AND managed harnesses) to pipe
# LLM token usage into per-UTC-day buckets in DDB. The filter pattern depends on
# what each log group emits (see lambda/token-aggregator/index.mjs):
#   Strands runtimes  -> `chat` spans (the only cache-inclusive input count)
#   managed harnesses -> EMF gen_ai.client.token.usage metric records
#   coding runtime    -> Claude Code claude_code.api_request events + codex
#                        coding_usage records (both runtimes: microVM and _ec2)
# Also REMOVES the legacy weekly EventBridge reset — the dashboard reads a
# rolling window over the day buckets, which are now KEPT FOREVER (no TTL) so the
# historical cost/quality trend survives. TTL is disabled on the table by
# deploy/continuous-improvement/deploy-all.sh.
#
# This Lambda ALSO hosts the model registry's maintenance modes (TEAM-4995,
# DL-033): the daily `{"mode":"reconcile"}` rule created by deploy.sh and the
# on-demand `{"mode":"probe"}` invoke. That is why it has npm dependencies, its
# own IAM role and a 15-minute timeout — the reconcile walks inference profiles,
# Mantle's model list and the Pricing API, and a CLI probe drives a whole coding
# turn on the coding runtime.
#
# Idempotent: re-runs update the Lambda code/config and skip resources that
# already exist.
#
# Usage: bash deploy-token-aggregator.sh [--region us-east-1]
#
# Required env (loaded from .env.local if present):
#   AWS_REGION
#   ARTIFACT_BUCKET           (defaults to agentcore-hub-artifacts-<ACCOUNT>-<REGION>)
# Optional:
#   TOKEN_AGGREGATOR_ROLE_ARN (defaults to the role setup-token-aggregator-role.sh creates)
#   CODING_AGENT_RUNTIME_ARN  (else resolved by deploy/config.sh; the `cli` probe needs it)
#   BEDROCK_MANTLE_REGIONS    (defaults to us-east-2,us-east-1)

set -euo pipefail

SCRIPT_DIR_BOOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_BOOT="$(cd "${SCRIPT_DIR_BOOT}/../.." && pwd)"
if [[ -f "${REPO_ROOT_BOOT}/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${REPO_ROOT_BOOT}/.env.local"
  set +a
fi

REGION="${AWS_REGION:-us-east-1}"

# Parse args before deriving REGION-dependent values (e.g. BUCKET) so that
# `--region` is honoured rather than baking in the default/AWS_REGION region.
while [[ $# -gt 0 ]]; do
  case $1 in
    --region) REGION="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
LAMBDA_NAME="agentcore-hub-token-aggregator"
# Its OWN role, not the shared agentcore-hub-lambda-role: the model modes need
# bedrock:ListInferenceProfiles, pricing:GetProducts, a write on
# config/models.json and the coding-runtime invoke, none of which belong on the
# role every other Lambda shares. Created by deploy/setup-token-aggregator-role.sh.
LAMBDA_ROLE="${TOKEN_AGGREGATOR_ROLE_ARN:-arn:aws:iam::${ACCOUNT_ID}:role/agentcore-hub-token-aggregator-role}"
# Per-day bucket table (PK agentId / SK day, no TTL — buckets are permanent).
# Created by deploy-all.sh; ensured here too so this script is a complete entry point.
DAILY_TABLE_NAME="${EVAL_DAILY_TABLE:-agentcore-hub-eval-daily}"
# Artifact bucket convention (matches deploy/config.sh): agentcore-hub-artifacts-<ACCOUNT>-<REGION>.
# The previous version dropped the region suffix and pointed the Lambda at a
# bucket that does not exist on first install.
BUCKET="${ARTIFACT_BUCKET:-agentcore-hub-artifacts-${ACCOUNT_ID}-${REGION}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAMBDA_DIR="${SCRIPT_DIR}/../../lambda/token-aggregator"
# Which coding runtime the `cli` probe drives. deploy/config.sh owns that
# resolution (env, else whichever deploy wrote its ARN file), so read it from
# there — in a SUBSHELL, because config.sh derives its own region-dependent
# exports and must not override the --region handling above.
CODING_RUNTIME_ARN="${CODING_AGENT_RUNTIME_ARN:-}"
if [[ -z "${CODING_RUNTIME_ARN}" ]]; then
  CODING_RUNTIME_ARN="$(
    (
      # shellcheck disable=SC1091
      source "${REPO_ROOT_BOOT}/deploy/config.sh" >/dev/null 2>&1
      printf '%s' "${CODING_AGENT_RUNTIME_ARN:-}"
    ) || true
  )"
fi
# Mantle regions the reconcile's discovery asks for models (see mantleRegions()).
MANTLE_REGIONS="${BEDROCK_MANTLE_REGIONS:-us-east-2,us-east-1}"

echo "=== Deploy Token Aggregator ==="
echo "Region:  ${REGION}"
echo "Account: ${ACCOUNT_ID}"
echo "Lambda:  ${LAMBDA_NAME}"
echo "Role:    ${LAMBDA_ROLE}"
echo "Coding runtime (cli probe): ${CODING_RUNTIME_ARN:-(unset - cli probes will report CODING_AGENT_RUNTIME_ARN unset)}"

if ! aws iam get-role --role-name "${LAMBDA_ROLE##*/}" >/dev/null 2>&1; then
  echo "ERROR: IAM role ${LAMBDA_ROLE} does not exist." >&2
  echo "       Run deploy/setup-token-aggregator-role.sh first - it grants the model-registry" >&2
  echo "       permissions (bedrock:ListInferenceProfiles, pricing:GetProducts, the coding-runtime" >&2
  echo "       invoke and read+write on config/models.json) that the shared Lambda role does not." >&2
  exit 1
fi

###############################################################################
# Step 0: Daily bucket table (idempotent; full setup lives in deploy-all.sh)
###############################################################################
echo ""
echo "--- Step 0: Daily bucket table ---"
if aws dynamodb describe-table --table-name "${DAILY_TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "✓ ${DAILY_TABLE_NAME} exists"
else
  aws dynamodb create-table \
    --table-name "${DAILY_TABLE_NAME}" \
    --attribute-definitions AttributeName=agentId,AttributeType=S AttributeName=day,AttributeType=S \
    --key-schema AttributeName=agentId,KeyType=HASH AttributeName=day,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    --region "${REGION}" --output text --query 'TableDescription.TableStatus'
  aws dynamodb wait table-exists --table-name "${DAILY_TABLE_NAME}" --region "${REGION}"
  # No TTL: day buckets are permanent, so the historical trend survives.
  echo "✓ ${DAILY_TABLE_NAME} created (no TTL - buckets are permanent)"
fi

###############################################################################
# Step 1: Package and deploy Lambda
###############################################################################
echo ""
echo "--- Step 1: Deploy Lambda ---"

cd "${LAMBDA_DIR}"
# The model modes need the Bedrock, Pricing, AgentCore and SigV4 packages, which
# the nodejs22 runtime does not bundle — so this Lambda ships node_modules from
# its committed lockfile. ONE zip line, which is what
# scripts/check-lambda-zip-manifest.sh matches against the import closure.
npm ci --omit=dev --no-audit --no-fund
rm -f /tmp/token-aggregator.zip
zip -rq /tmp/token-aggregator.zip index.mjs models-registry.mjs models-reconcile.mjs models-probe.mjs models-deps.mjs bedrock-token.mjs package.json node_modules/

# 900s: a reconcile walks every region's inference profiles, Mantle's model list
# and the Pricing API, and a `cli` probe drives a full coding turn. The log
# subscription path still returns in milliseconds.
# JSON, not the CLI shorthand: BEDROCK_MANTLE_REGIONS is a comma list, and a
# comma inside a shorthand value ends the pair (2026-09-24 hand step failed here).
LAMBDA_ENV=$(python3 -c 'import json,sys; print(json.dumps({"Variables": dict(a.split("=", 1) for a in sys.argv[1:])}))' \
  "EVAL_DAILY_TABLE=${DAILY_TABLE_NAME}" \
  "ARTIFACTS_BUCKET=${BUCKET}" \
  "CODING_AGENT_RUNTIME_ARN=${CODING_RUNTIME_ARN}" \
  "BEDROCK_MANTLE_REGIONS=${MANTLE_REGIONS}")

if aws lambda get-function --function-name "${LAMBDA_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "Updating existing Lambda..."
  aws lambda update-function-code \
    --function-name "${LAMBDA_NAME}" \
    --zip-file fileb:///tmp/token-aggregator.zip \
    --region "${REGION}" --output text --query 'FunctionArn'
  aws lambda wait function-updated --function-name "${LAMBDA_NAME}" --region "${REGION}"
  aws lambda update-function-configuration \
    --function-name "${LAMBDA_NAME}" \
    --role "${LAMBDA_ROLE}" \
    --timeout 900 --memory-size 256 \
    --environment "${LAMBDA_ENV}" \
    --region "${REGION}" --output text --query 'FunctionArn'
else
  echo "Creating new Lambda..."
  aws lambda create-function \
    --function-name "${LAMBDA_NAME}" \
    --runtime nodejs22.x \
    --handler index.handler \
    --role "${LAMBDA_ROLE}" \
    --zip-file fileb:///tmp/token-aggregator.zip \
    --timeout 900 --memory-size 256 \
    --environment "${LAMBDA_ENV}" \
    --region "${REGION}" --output text --query 'FunctionArn'
  aws lambda wait function-active --function-name "${LAMBDA_NAME}" --region "${REGION}"
fi

LAMBDA_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${LAMBDA_NAME}"
echo "✓ Lambda deployed: ${LAMBDA_ARN}"

###############################################################################
# Step 2: Grant CW Logs permission to invoke Lambda
###############################################################################
echo ""
echo "--- Step 2: Lambda permissions ---"

aws lambda add-permission \
  --function-name "${LAMBDA_NAME}" \
  --statement-id "cw-runtime-logs-invoke" \
  --action "lambda:InvokeFunction" \
  --principal "logs.${REGION}.amazonaws.com" \
  --source-account "${ACCOUNT_ID}" \
  --region "${REGION}" 2>/dev/null || echo "(permission already exists)"

echo "✓ CW Logs invoke permission set"

###############################################################################
# Step 3: Subscription filters on every evaluations-enabled agent log group
###############################################################################
echo ""
echo "--- Step 3: Subscription filters ---"

AGENTS_FILE="${SCRIPT_DIR}/../../src/config/agents.json"
ALL_GROUPS=$(aws logs describe-log-groups \
  --log-group-name-prefix "/aws/bedrock-agentcore/runtimes/" \
  --query 'logGroups[].logGroupName' \
  --output json --region "${REGION}")

echo "${ALL_GROUPS}" | python3 -c "
import json, sys, subprocess
groups = json.load(sys.stdin)
agents = [a['agentId'] for a in json.load(open('${AGENTS_FILE}'))['agents'] if a.get('evaluationsEnabled')]
agents.sort(key=len, reverse=True)  # longest first: agentcore_hub_agent must not shadow agentcore_hub_agent_x

def resolve(leaf):
    for aid in agents:
        # <id>_ec2-...: the coding runtime's AgentCore Instances twin (same image).
        if leaf == aid or leaf.startswith((aid + '-', 'harness_' + aid + '-', aid + '_ec2-')):
            return aid
    return None

# One pattern per emitter shape; the Lambda parses whichever arrives.
SPANS   = '\"strands.telemetry.tracer\" \"gen_ai.usage.input_tokens\"'
METRIC  = 'gen_ai.client.token.usage'
CLAUDE  = '?\"claude_code.api_request\" ?\"coding_usage\"'  # OR: claude events, codex records

for lg in groups:
    leaf = lg.split('/')[-1]
    if 'container' in leaf:
        continue
    aid = resolve(leaf)
    if not aid:
        continue
    if leaf.startswith('harness_'):
        pattern = METRIC
    elif 'coding_runtime' in aid:
        pattern = CLAUDE
    else:
        pattern = SPANS
    result = subprocess.run([
        'aws', 'logs', 'put-subscription-filter',
        '--log-group-name', lg,
        '--filter-name', 'token-to-aggregator',
        '--filter-pattern', pattern,
        '--destination-arn', '${LAMBDA_ARN}',
        '--region', '${REGION}'
    ], capture_output=True, text=True)
    status = 'OK ' if result.returncode == 0 else 'ERR'
    print(f'  {status} {leaf[:60]:60s} {pattern}' + ('' if result.returncode == 0 else '  ' + result.stderr.strip()[:120]))
"

echo "✓ Subscription filters in place"

###############################################################################
# Step 4: Remove the legacy weekly reset cron (rolling window replaces it)
###############################################################################
echo ""
echo "--- Step 4: Legacy weekly reset ---"

RULE_NAME="agentcore-hub-token-reset-weekly"
if aws events describe-rule --name "${RULE_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  aws events remove-targets --rule "${RULE_NAME}" --ids token-reset --region "${REGION}" >/dev/null 2>&1 || true
  aws events delete-rule --name "${RULE_NAME}" --region "${REGION}"
  echo "✓ Deleted ${RULE_NAME} (counters are no longer zeroed weekly)"
else
  echo "(no legacy reset rule present)"
fi
aws lambda remove-permission \
  --function-name "${LAMBDA_NAME}" \
  --statement-id "eventbridge-weekly-reset" \
  --region "${REGION}" >/dev/null 2>&1 || true

###############################################################################
# Done
###############################################################################
echo ""
echo "=== Token Aggregator Deployment Complete ==="
echo "Agent log groups → subscription filter → ${LAMBDA_NAME} → DDB ${DAILY_TABLE_NAME} (agentId, day)"
echo ""
echo "Next: node deploy/continuous-improvement/backfill-results.mjs --from YYYY-MM-DD --to YYYY-MM-DD"
echo "      (drives the eval-packager's reconcile mode; backfill-daily.mjs is retired)"
