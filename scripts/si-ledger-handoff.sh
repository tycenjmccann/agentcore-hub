#!/usr/bin/env bash
# ─── SI ledger handoff — apply the non-code surfaces of PR #637 ───────────────
#
# Tickets: TEAM-4770 (SI tracker deployed but inert) / TEAM-4772.
#
# WHY THIS EXISTS
#   The CD pipeline is code-only by design (deploy/pipeline/surfaces.json:
#   "CODE ONLY: the pipeline updates Lambda code, harness prompt/model/skills and
#   S3 toolkits — never IAM, env vars or infra"). PR #637 shipped the SI ledger as
#   code — si-ledger.mjs, the toolkit twins si_ledger.py / si_verify.py, the
#   Evaluations panel, the si-verify-daily rule — and every non-code surface it
#   needs sat behind hand-run scripts that nobody ran. CD runs
#   setup-workflow-manager.mjs only with PIPELINE_MODE=1, which skips its entire
#   IAM block, so the live agentcore-hub-harness-role still carried the pre-#637
#   WorkflowManagerData document and si_ledger.py's Scan failed with
#   AccessDeniedException. The ledger was deployed and inert.
#
#   This script is the one idempotent command that applies those surfaces. It
#   defines no policy of its own: every document and grant comes from the script
#   that already owns it (see the step list), so there is never a second copy to
#   drift.
#
# USAGE
#   ./scripts/si-ledger-handoff.sh                  # dry run (THE DEFAULT)
#   ./scripts/si-ledger-handoff.sh --dry-run        # explicit dry run
#   ./scripts/si-ledger-handoff.sh --apply          # execute
#   ./scripts/si-ledger-handoff.sh --print-policies # the two IAM documents as JSON
#
#   Dry run prints every AWS mutation it WOULD make and executes none. Read-only
#   calls (describe-table, get-function-configuration, simulate-principal-policy)
#   run in both modes so the plan and the verification are real.
#
# ACCEPTANCE CHECKS (run these after --apply; they are the definition of done)
#   1. From the Workflow Manager harness, `python3 toolkit/si_verify.py` exits 0
#      and its report contains a `## Prior attempts` section — not
#      AccessDeniedException.
#   2. From the same harness, `python3 toolkit/si_ledger.py keys` lists rows.
#   3. GET /api/evaluations/si-ledger returns ledger rows, not `unavailable`.
#   4. The next SYNTHESIZE either files PRDs for, or explicitly declines, the 3
#      pending analyses — i.e. the loop is closed, not silently skipped.
#
# NOT DONE HERE, deliberately: no write grant is ever added to the coding-runtime
# role, and the Secrets Manager prohibition in setup-coding-runtime-role.sh is
# untouched. See patternKey tooling.coding-role.no-live-verify-access.

set -euo pipefail

MODE="dry-run"
for arg in "$@"; do
  case "$arg" in
    --apply)          MODE="apply" ;;
    --dry-run)        MODE="dry-run" ;;
    --print-policies) MODE="print-policies" ;;
    -h|--help)
      sed -n '2,45p' "$0"
      exit 0 ;;
    *)
      echo "ERROR: unknown argument '$arg' (expected --dry-run, --apply or --print-policies)" >&2
      exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
# shellcheck disable=SC1091
source "${REPO_ROOT}/deploy/config.sh"

# config.sh exports AWS_REGION / ACCOUNT_ID / ARTIFACT_BUCKET / LAMBDA_ROLE_ARN but
# NOT the ledger table — every sibling script defaults it locally the same way.
SI_LEDGER_TABLE="${SI_LEDGER_TABLE:-agentcore-hub-si-ledger}"
LEDGER_ARN="arn:aws:dynamodb:${AWS_REGION}:${ACCOUNT_ID}:table/${SI_LEDGER_TABLE}"
# TEAM-4785: the table the untrusted coding runtime must NEVER reach. Session rows
# carry userId, repo, branch and resumeTranscriptKey, so a cross-tenant Scan here
# is the failure HubLiveVerifyRead's allow-list exists to prevent.
SESSIONS_ARN="arn:aws:dynamodb:${AWS_REGION}:${ACCOUNT_ID}:table/agentcore-hub-cloud-code-sessions"
HARNESS_ROLE="agentcore-hub-harness-role"
CODING_ROLE="agentcore-hub-coding-runtime-role"
ANALYZER_FN="agentcore-hub-workflow-analyzer"
SUBMITTER_FN="agentcore-hub-prd-submitter"
WM_SETUP="${REPO_ROOT}/deploy/workflow-manager/setup-workflow-manager.mjs"
CODING_ROLE_SETUP="${REPO_ROOT}/deploy/coding-agent-runtime/setup-coding-runtime-role.sh"

# ─── --print-policies ────────────────────────────────────────────────────────
# One JSON object, two keys, so a test can JSON.parse the whole of stdout. Each
# document is printed BY THE SCRIPT THAT OWNS IT — this wrapper never rebuilds one.
if [ "$MODE" = "print-policies" ]; then
  HARNESS_DOC="$(AWS_ACCOUNT_ID="$ACCOUNT_ID" node "$WM_SETUP" --print-policy)"
  CODING_DOC="$(AWS_ACCOUNT_ID="$ACCOUNT_ID" ARTIFACT_BUCKET="$ARTIFACT_BUCKET" \
    PRINT_POLICY=HubLiveVerifyRead bash "$CODING_ROLE_SETUP")"
  HARNESS_DOC="$HARNESS_DOC" CODING_DOC="$CODING_DOC" LEDGER_ARN="$LEDGER_ARN" \
  REGION="$AWS_REGION" ACCT="$ACCOUNT_ID" TABLE="$SI_LEDGER_TABLE" BUCKET="$ARTIFACT_BUCKET" \
  python3 -c '
import json, os, sys
json.dump({
    "meta": {
        "region": os.environ["REGION"],
        "accountId": os.environ["ACCT"],
        "table": os.environ["TABLE"],
        "artifactBucket": os.environ["BUCKET"],
        "ledgerArn": os.environ["LEDGER_ARN"],
    },
    "harnessRole": {
        "roleName": "agentcore-hub-harness-role",
        "policyName": "WorkflowManagerData",
        "document": json.loads(os.environ["HARNESS_DOC"]),
    },
    "codingRuntimeRole": {
        "roleName": "agentcore-hub-coding-runtime-role",
        "policyName": "HubLiveVerifyRead",
        "document": json.loads(os.environ["CODING_DOC"]),
    },
}, sys.stdout, indent=2)
print()
'
  exit 0
fi

# ─── plumbing ────────────────────────────────────────────────────────────────
FAILURES=0
step() { printf '\n── %s\n' "$*"; }

# Execute in --apply, print in --dry-run. Every mutation goes through this.
run() {
  if [ "$MODE" = "apply" ]; then
    "$@"
  else
    echo "   + $*"
  fi
}

echo "═══════════════════════════════════════════════════════════"
echo "  SI ledger handoff — TEAM-4770        mode: ${MODE}"
echo "  account ${ACCOUNT_ID}  region ${AWS_REGION}  table ${SI_LEDGER_TABLE}"
echo "═══════════════════════════════════════════════════════════"
[ "$MODE" = "dry-run" ] && echo "(dry run: nothing below is executed — re-run with --apply)"

# ─── 1/7  the table ──────────────────────────────────────────────────────────
# Same schema as scripts/create-dynamodb-tables.sh: PK patternKey (S),
# PAY_PER_REQUEST, no GSI, and NO TTL — the ledger is permanent history.
step "1/7  DynamoDB table ${SI_LEDGER_TABLE}"
if aws dynamodb describe-table --table-name "$SI_LEDGER_TABLE" --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "   ✓ already exists"
else
  run aws dynamodb create-table \
    --table-name "$SI_LEDGER_TABLE" \
    --attribute-definitions AttributeName=patternKey,AttributeType=S \
    --key-schema AttributeName=patternKey,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region "$AWS_REGION"
  run aws dynamodb wait table-exists --table-name "$SI_LEDGER_TABLE" --region "$AWS_REGION"
fi

# ─── 2/7  harness role ───────────────────────────────────────────────────────
# The grant TEAM-4770 is actually about. --iam-only exits before the AgentCore
# SDK is even imported, so the live harness config CD owns is never touched.
step "2/7  ${HARNESS_ROLE} / WorkflowManagerData (incl. SiLedgerReadWrite)"
run node "$WM_SETUP" --iam-only

# ─── 3/7  lambda role ────────────────────────────────────────────────────────
# Two DIFFERENT inline policy names on the same role, so running both is a union,
# not a clobber: WorkflowManagerAccess (workflow-analyzer) and EvalResultsAccess
# (prd-submitter). Each is applied by the script that owns its definition.
step "3/7  agentcore-hub-lambda-role ledger grants"
run env IAM_ONLY=1 bash "${REPO_ROOT}/deploy/workflow-manager/deploy.sh"
run env IAM_ONLY=1 bash "${REPO_ROOT}/deploy/continuous-improvement/deploy.sh"

# ─── 4/7  env, MERGED onto four surfaces ─────────────────────────────────────
# update-function-configuration --environment REPLACES the whole variable set, so
# every one of these reads the live config first and merges. A bare push here
# would wipe WORKFLOW_MANAGER_ARN / ANALYSES_TABLE / creds.
step "4/7  SI_LEDGER_TABLE=${SI_LEDGER_TABLE} onto analyzer + submitter + harness + ECS"

merge_lambda_env() {
  local FN="$1"
  local CURRENT MERGED ENV_FILE
  CURRENT="$(aws lambda get-function-configuration --function-name "$FN" --region "$AWS_REGION" \
    --query 'Environment.Variables' --output json 2>/dev/null || true)"
  if [ -z "$CURRENT" ] || [ "$CURRENT" = "null" ]; then
    echo "   ⚠ ${FN}: cannot read live env — refusing to push (would wipe it). Deploy the Lambda first."
    FAILURES=$((FAILURES + 1))
    return 0
  fi
  ENV_FILE="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '$ENV_FILE'" RETURN
  MERGED="$(CURRENT="$CURRENT" KEY=SI_LEDGER_TABLE VAL="$SI_LEDGER_TABLE" ENV_FILE="$ENV_FILE" python3 -c '
import json, os, sys
cur = json.loads(os.environ["CURRENT"]) or {}
key, val = os.environ["KEY"], os.environ["VAL"]
merged = dict(cur)
changed = merged.get(key) != val
merged[key] = val
with open(os.environ["ENV_FILE"], "w", encoding="utf-8") as fh:
    json.dump({"Variables": merged}, fh)
# Key NAMES only — Lambda env carries credentials, so no values are printed
# except the one this script sets.
print(json.dumps({"changed": changed, "keys": sorted(merged)}))
')"
  local CHANGED KEYS
  CHANGED="$(printf '%s' "$MERGED" | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["changed"]))')"
  KEYS="$(printf '%s' "$MERGED" | python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)["keys"]))')"
  echo "   ${FN}: merged payload keys: ${KEYS}"
  echo "   ${FN}: SI_LEDGER_TABLE=${SI_LEDGER_TABLE}"
  if [ "$CHANGED" = "0" ]; then
    echo "   ✓ ${FN}: already set — no update"
    return 0
  fi
  if [ "$MODE" = "apply" ]; then
    aws lambda wait function-updated --function-name "$FN" --region "$AWS_REGION" 2>/dev/null || true
    aws lambda update-function-configuration --function-name "$FN" --region "$AWS_REGION" \
      --environment "file://${ENV_FILE}" --output text >/dev/null
    aws lambda wait function-updated --function-name "$FN" --region "$AWS_REGION" 2>/dev/null || true
    echo "   ✓ ${FN}: env updated (merge)"
  else
    echo "   + aws lambda update-function-configuration --function-name ${FN} --environment file://<merged>"
  fi
}

merge_lambda_env "$ANALYZER_FN"
merge_lambda_env "$SUBMITTER_FN"

# The WM harness: UpdateHarness's environmentVariables is replace-all, and no
# tool pushed harness env before TEAM-4770 — set-harness-env.mjs is that tool.
run node "${REPO_ROOT}/deploy/workflow-manager/set-harness-env.mjs" "SI_LEDGER_TABLE=${SI_LEDGER_TABLE}"

# The hub ECS service: set-env.sh already reads the live container and merges.
run bash "${REPO_ROOT}/deploy/ecs-express/set-env.sh" "SI_LEDGER_TABLE=${SI_LEDGER_TABLE}"

# ─── 5/7  coding-runtime read access ─────────────────────────────────────────
# ONLY_POLICY puts HubLiveVerifyRead alone: no role re-create, no trust refresh,
# no re-put of the four unrelated documents. READ-ONLY by construction.
step "5/7  ${CODING_ROLE} / HubLiveVerifyRead (read-only)"
run env ONLY_POLICY=HubLiveVerifyRead bash "$CODING_ROLE_SETUP"

# ─── 6/7  backfill ───────────────────────────────────────────────────────────
# Dry run is the default in the backfill too; --apply is only ever passed through
# when THIS script was given --apply.
step "6/7  ledger backfill from workflow history"
run node "${REPO_ROOT}/scripts/si-ledger-backfill.mjs"
if [ "$MODE" = "apply" ]; then
  run node "${REPO_ROOT}/scripts/si-ledger-backfill.mjs" --apply
else
  echo "   + node scripts/si-ledger-backfill.mjs --apply   (only runs with --apply)"
fi

# ─── 7/7  verify ─────────────────────────────────────────────────────────────
# Reads only, so this runs in both modes. In dry run a denial is expected (the
# grants have not been applied yet) and is reported, not fatal.
step "7/7  verify"

TABLE_STATUS="$(aws dynamodb describe-table --table-name "$SI_LEDGER_TABLE" --region "$AWS_REGION" \
  --query 'Table.TableStatus' --output text 2>/dev/null || echo MISSING)"
if [ "$TABLE_STATUS" = "ACTIVE" ]; then
  echo "   ✓ table ${SI_LEDGER_TABLE}: ACTIVE"
else
  echo "   ✗ table ${SI_LEDGER_TABLE}: ${TABLE_STATUS}"
  FAILURES=$((FAILURES + 1))
fi

simulate() {
  local ROLE="$1" EXPECT="$2" RESOURCE="$3"; shift 3
  local OUT
  OUT="$(aws iam simulate-principal-policy \
    --policy-source-arn "arn:aws:iam::${ACCOUNT_ID}:role/${ROLE}" \
    --action-names "$@" \
    --resource-arns "$RESOURCE" \
    --region "$AWS_REGION" \
    --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output text 2>/dev/null || true)"
  if [ -z "$OUT" ]; then
    echo "   ⚠ ${ROLE}: simulate-principal-policy unavailable (needs iam:SimulatePrincipalPolicy)"
    return 0
  fi
  while read -r ACTION DECISION; do
    [ -z "${ACTION:-}" ] && continue
    if [ "$DECISION" = "$EXPECT" ]; then
      echo "   ✓ ${ROLE}: ${ACTION} → ${DECISION}"
    else
      echo "   ✗ ${ROLE}: ${ACTION} → ${DECISION} (expected ${EXPECT})"
      FAILURES=$((FAILURES + 1))
    fi
  done <<< "$OUT"
}

simulate "$HARNESS_ROLE" allowed "$LEDGER_ARN" \
  dynamodb:DescribeTable dynamodb:GetItem dynamodb:Query dynamodb:Scan \
  dynamodb:PutItem dynamodb:UpdateItem
simulate "$CODING_ROLE" allowed "$LEDGER_ARN" \
  dynamodb:DescribeTable dynamodb:Scan dynamodb:Query dynamodb:GetItem
# The negatives matter as much as the positives: live verify must never be able
# to write the evidence it is verifying, nor read another tenant's sessions.
simulate "$CODING_ROLE" implicitDeny "$LEDGER_ARN" dynamodb:PutItem
simulate "$CODING_ROLE" implicitDeny "$SESSIONS_ARN" dynamodb:Scan

for FN in "$ANALYZER_FN" "$SUBMITTER_FN"; do
  VAL="$(aws lambda get-function-configuration --function-name "$FN" --region "$AWS_REGION" \
    --query 'Environment.Variables.SI_LEDGER_TABLE' --output text 2>/dev/null || echo None)"
  if [ "$VAL" = "$SI_LEDGER_TABLE" ]; then
    echo "   ✓ ${FN}: SI_LEDGER_TABLE=${VAL}"
  else
    echo "   ✗ ${FN}: SI_LEDGER_TABLE=${VAL} (expected ${SI_LEDGER_TABLE})"
    FAILURES=$((FAILURES + 1))
  fi
done

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "✓ all checks passed"
elif [ "$MODE" = "apply" ]; then
  echo "✗ ${FAILURES} check(s) failed after --apply — see above" >&2
  exit 1
else
  echo "ℹ ${FAILURES} check(s) not satisfied yet — expected before --apply"
fi

if [ "$MODE" != "apply" ]; then
  echo ""
  echo "Dry run complete. Re-run with --apply to execute, then work the acceptance"
  echo "checks in this script's header (si_verify.py, si_ledger.py keys,"
  echo "/api/evaluations/si-ledger, next SYNTHESIZE)."
fi
