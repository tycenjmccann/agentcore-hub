#!/usr/bin/env bash
# ─── telegram-bug-intake: deploy-approval env + IAM (TEAM-4338) ───────────────
#
# This function is account-local (see README.md "Provenance") — its execution
# role is managed out of band, not by a repo-tracked SAM/CDK stack. This script
# is the tracked, idempotent, re-runnable way to grant it what the multi-target
# deploy-approval bridge needs, superseding the untracked laptop script for
# that job (see README.md "Deploy"). It is a HANDOFF step: a human runs it by
# hand; the pipeline's Deploy stage never touches IAM or env vars
# (deploy/pipeline/surfaces.json).
#
# What it grants, and why this is the ONE place that legitimately holds
# PutApprovalResult: the deploy gate in every CD-registry pipeline is a human
# decision, bridged to Telegram. The Pipeline___* tools Lambda
# (lambda/agentcore-hub-pipeline-tools/) deliberately has no PutApprovalResult
# grant anywhere — do not add one there. This inline policy is the only place
# in the account where an identity may resolve that gate; widen it with care.
#
#   PipelineStateRead    codepipeline:GetPipelineState on the pipeline the
#                         function will ACTUALLY poll — its EFFECTIVE
#                         DEPLOY_PIPELINE_NAME, read back after the env merge
#                         (step 1b, TEAM-4377), NOT this shell's default — in its
#                         own region, plus hub-*-deploy in every region in
#                         PIPELINE_REGIONS (the CD-registry convention — see
#                         src/lib/cd-registry.ts / cd-registry.mjs).
#                         GetPipelineState is authorized at the PIPELINE level.
#   DeployApprovalWrite  codepipeline:PutApprovalResult on the SAME pipelines,
#                         but PutApprovalResult is authorized at the ACTION
#                         level (arn:...:<pipeline>/<stage>/<action>), so the
#                         resource is <pipeline-arn>/* for each — never a bare
#                         pipeline ARN, or every approval tap AccessDenies.
#   CdRegistryRead        s3:GetObject on exactly config/cd-registry.json in
#                         ARTIFACT_BUCKET — one key, not a prefix.
#
# Usage: ./update-config.sh   (reads AWS credentials + deploy/config.sh env)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck disable=SC1091
source ../config.sh

FUNCTION="${TELEGRAM_INTAKE_FUNCTION:-telegram-bug-intake}"
# Comma list — IAM fan-out ONLY. index.mjs never reads this; the multi-target
# poll list comes entirely from config/cd-registry.json at runtime.
PIPELINE_REGIONS="${PIPELINE_REGIONS:-$AWS_REGION}"
# The DEFAULT ONLY. The env merge below never overwrites the function's own
# DEPLOY_PIPELINE_NAME, so this is not necessarily the pipeline the function
# polls — the IAM policy is built from the EFFECTIVE value read back in step 1b.
DEPLOY_PIPELINE_DEFAULT="${DEPLOY_PIPELINE_NAME:-agentcore-hub-deploy}"
POLICY_NAME="telegram-bug-intake-deploy-approval"

echo "Function:         $FUNCTION"
echo "Region:           $AWS_REGION"
echo "Account:          $ACCOUNT_ID"
echo "Artifact bucket:  $ARTIFACT_BUCKET"
echo "Deploy pipeline:  $DEPLOY_PIPELINE_DEFAULT (default - the function's existing value wins)"
echo "IAM fan-out:      hub-*-deploy in $PIPELINE_REGIONS"
echo

# ─── 0. Wait for any in-flight update before touching this function ──────────
aws lambda wait function-updated --function-name "$FUNCTION" --region "$AWS_REGION"

# ─── 1. Env merge (never replace) ─────────────────────────────────────────────
ROLE_ARN=$(aws lambda get-function-configuration \
  --function-name "$FUNCTION" --region "$AWS_REGION" \
  --query 'Role' --output text)
ROLE_NAME="${ROLE_ARN##*/}"
echo "Role:             $ROLE_ARN"

ENV_FILE="$(mktemp)"
trap 'rm -f "$ENV_FILE"' EXIT

aws lambda get-function-configuration \
  --function-name "$FUNCTION" --region "$AWS_REGION" \
  --query 'Environment.Variables' --output json |
  ARTIFACT_BUCKET="$ARTIFACT_BUCKET" \
  DEPLOY_PIPELINE_DEFAULT="$DEPLOY_PIPELINE_DEFAULT" \
  python3 -c '
import json, os, sys

existing = json.load(sys.stdin) or {}
merged = dict(existing)
# ARTIFACT_BUCKET is always refreshed to the account'"'"'s current bucket — it
# is derived config, not an operator choice. DEPLOY_PIPELINE_NAME is only
# DEFAULTED, never overwritten, so an operator override survives a re-run. A
# present-but-BLANK value counts as unset: it would otherwise flow into step 1b
# and put a pipeline-less ARN in the policy.
merged["ARTIFACT_BUCKET"] = os.environ["ARTIFACT_BUCKET"]
merged["DEPLOY_PIPELINE_NAME"] = (
    (existing.get("DEPLOY_PIPELINE_NAME") or "").strip() or os.environ["DEPLOY_PIPELINE_DEFAULT"]
)
json.dump({"Variables": merged}, sys.stdout)
' > "$ENV_FILE"

aws lambda update-function-configuration \
  --function-name "$FUNCTION" --region "$AWS_REGION" \
  --environment "file://$ENV_FILE" > /dev/null

aws lambda wait function-updated --function-name "$FUNCTION" --region "$AWS_REGION"

# ─── 1b. The EFFECTIVE pipeline the policy must cover (TEAM-4377) ─────────────
# The policy below used to be built from the SHELL default. An operator who set
# DEPLOY_PIPELINE_NAME=custom-x on the function once (it survives the merge above)
# and later re-ran this script WITHOUT re-exporting it got a policy covering only
# agentcore-hub-deploy + hub-*-deploy: every GetPipelineState poll and every
# approval tap on custom-x then AccessDenied - fail-closed, but a silently dead
# deploy gate, from a script whose whole contract is "idempotent, re-runnable".
# $ENV_FILE is the document we just applied, so it IS the function's env.
DEPLOY_PIPELINE="$(ENV_FILE="$ENV_FILE" python3 -c '
import json, os
print(json.load(open(os.environ["ENV_FILE"]))["Variables"]["DEPLOY_PIPELINE_NAME"])
')"
[ -n "$DEPLOY_PIPELINE" ] || {
  echo "DEPLOY_PIPELINE_NAME is empty after the merge - refusing to write a pipeline-less policy" >&2
  exit 1
}

echo "Env updated: ARTIFACT_BUCKET set, DEPLOY_PIPELINE_NAME defaulted (existing keys preserved)."
echo "Effective deploy pipeline: $DEPLOY_PIPELINE (script default was $DEPLOY_PIPELINE_DEFAULT)"

# ─── 2. Inline role policy (idempotent put-role-policy) ───────────────────────
POLICY_DOC=$(
  ACCOUNT_ID="$ACCOUNT_ID" AWS_REGION="$AWS_REGION" \
  DEPLOY_PIPELINE="$DEPLOY_PIPELINE" PIPELINE_REGIONS="$PIPELINE_REGIONS" \
  ARTIFACT_BUCKET="$ARTIFACT_BUCKET" python3 -c '
import json, os

account = os.environ["ACCOUNT_ID"]
home_region = os.environ["AWS_REGION"]
pipeline = os.environ["DEPLOY_PIPELINE"]
regions = [r.strip() for r in os.environ["PIPELINE_REGIONS"].split(",") if r.strip()] or [home_region]
bucket = os.environ["ARTIFACT_BUCKET"]

pipeline_arn = f"arn:aws:codepipeline:{home_region}:{account}:{pipeline}"
hub_arns = [f"arn:aws:codepipeline:{r}:{account}:hub-*-deploy" for r in regions]
# GetPipelineState is authorized at the PIPELINE level.
pipeline_resources = [pipeline_arn] + hub_arns
# PutApprovalResult is authorized at the ACTION level
# (arn:...:<pipeline>/<stage>/<action>) - same pipelines, "/*" appended so the
# grant still cannot reach the actions of any OTHER pipeline. (No apostrophes
# in this python: the whole program is one single-quoted shell string.)
action_resources = [f"{pipeline_arn}/*"] + [f"{arn}/*" for arn in hub_arns]

policy = {
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "PipelineStateRead",
            "Effect": "Allow",
            "Action": ["codepipeline:GetPipelineState"],
            "Resource": pipeline_resources,
        },
        {
            "Sid": "DeployApprovalWrite",
            "Effect": "Allow",
            "Action": ["codepipeline:PutApprovalResult"],
            "Resource": action_resources,
        },
        {
            "Sid": "CdRegistryRead",
            "Effect": "Allow",
            "Action": ["s3:GetObject"],
            "Resource": [f"arn:aws:s3:::{bucket}/config/cd-registry.json"],
        },
    ],
}
print(json.dumps(policy))
'
)
# An apostrophe anywhere in the python above would split the single-quoted
# program and yield an empty document (put-role-policy then fails on length 0,
# or worse, a partial policy). Refuse to write anything that is not a policy.
[ -n "$POLICY_DOC" ] && printf '%s' "$POLICY_DOC" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["Statement"]' || {
  echo "policy builder produced no valid document - refusing put-role-policy" >&2
  exit 1
}

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "$POLICY_NAME" \
  --policy-document "$POLICY_DOC"

echo "IAM inline policy '$POLICY_NAME' applied to $ROLE_NAME:"
echo "  PipelineStateRead (pipeline-level) on $DEPLOY_PIPELINE (effective, $AWS_REGION) + hub-*-deploy ($PIPELINE_REGIONS)"
echo "  DeployApprovalWrite (action-level, <pipeline>/*) on the same pipelines"
echo "  CdRegistryRead on s3://$ARTIFACT_BUCKET/config/cd-registry.json"
