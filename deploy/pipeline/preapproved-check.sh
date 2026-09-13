#!/usr/bin/env bash
# preapproved-check.sh — TEAM-4525: is the HUMAN deploy gate still NECESSARY?
#
# A ship run used to ask the human to approve the same bytes twice: once at the
# Merge Approval gate (head SHA X) and again at this pipeline's `Approve_deploy`
# ManualApproval (the merge of that same X). wf_1789170903227_c3x6k1 spent ~5.1h
# between the two. The second ask carries real information in exactly one case:
# the thing about to deploy is NOT what the human approved.
#
# So the release manager records, BEFORE it starts the deploy, a ship-approval
# record binding the merge commit to the human-approved head SHA:
#
#   s3://$ARTIFACT_BUCKET/pipeline-artifacts/ship-approvals/<merge_commit>.json
#   { "version": 1, "merge_commit": "<40-hex>", "approved_head_sha": "<40-hex>",
#     "ci_build_id": ..., "pipeline": ..., "repo": ..., "recorded_at": ...,
#     "recorded_by": "Pipeline___start_deploy" }
#
# `Pipeline___start_deploy` writes that record ONLY when a SUCCEEDED CI build
# certifies `approved_head_sha`. This script is how the pipeline consumes it.
#
# THIS SCRIPT NEVER APPROVES ANYTHING. There is no PutApprovalResult here or
# anywhere an agent can reach: the gate is made unnecessary for one specific
# commit, never auto-approved. `decide` only ever answers a question; the Build
# stage exports the answer and CodePipeline's own stage-entry condition
# (Operator NE, Value "1") skips the Approval stage — so anything other than the
# literal "1", including an empty or unresolved variable, keeps the human gate.
#
# Usage
#   preapproved-check.sh decide <resolved-source-version>
#     Prints "1" iff a record exists for that exact commit, parses, its
#     merge_commit == that commit, and its approved_head_sha is 40-hex.
#     Prints "0" for EVERY other outcome (no bucket, non-hex sha, missing
#     record, unreadable record, malformed JSON, mismatch, aws CLI failure).
#     Exits 0 always — it must never fail the Build.
#
#   preapproved-check.sh gate <DEPLOY_PREAPPROVED> <resolved-source-version>
#     Exit 0 = safe to touch prod, exit 1 = refuse, and it runs BEFORE the
#     deploy does anything. "0" means the human gate ran and a human approved.
#     "1" means the gate was skipped, and this re-reads the record INDEPENDENTLY
#     and refuses unless it still agrees. EMPTY means the stack is not wired (see
#     below). Any other value refuses. This third check is what makes a misread
#     of the condition's semantics harmless: the worst case is a needless human
#     gate, never a silent deploy.
#
# THE EMPTY CASE — an UNWIRED stack (TEAM-4527, amends TEAM-4525)
#
# The repo-side gate above ships with the source; the stack-side wiring (the
# Build action's `variablesNamespace: "BuildVars"`, the Approval stage's
# beforeEntry SKIP rule, and the DEPLOY_PREAPPROVED env entry on both Deploy
# actions) only exists after a human runs `./deploy/pipeline/deploy.sh`. Between
# the two, DEPLOY_PREAPPROVED arrives here EMPTY. Treating that as garbage
# refused three consecutive executions AFTER a human had already approved the
# Approve_deploy gate, making main undeployable (TEAM-4527).
#
# So empty is its own case, and it is sound because the SKIP condition and the
# Deploy actions' env var read the SAME exported variable through the SAME
# namespace:
#
#   * Symmetric wiring (nothing applied): "#{BuildVars.DEPLOY_PREAPPROVED}" is
#     unresolvable EVERYWHERE, so the beforeEntry rule cannot have evaluated to
#     the literal "1". The Approval stage was ENTERED and a human approved.
#   * Asymmetric wiring (condition present, Deploy env entry missing) is the only
#     state where a SKIP could fire while we see empty. But a SKIP requires
#     `decide` to have printed "1", i.e. a record that exists, parses and whose
#     merge_commit equals this commit — exactly what we REFUSE on below.
#
# Hence: empty + no verifying record -> proceed (a human necessarily approved);
# empty + a verifying record -> REFUSE as ambiguous. The two halves are
# load-bearing as a PAIR; the first alone would be unsound.
#
# And "no record" must mean WE LOOKED AND FOUND NONE, never "we could not look":
# without that guard, blanking ARTIFACT_BUCKET would turn the refuse case into
# the proceed case. So the empty path refuses unless the lookup was possible.
#
# Deliberately NOT `set -e`: `decide` returns an ANSWER, and a missing record is
# a normal answer ("0"), not an error. pipefail is on so a failed producer in the
# one pipe below is not masked by python's success.
set -uo pipefail

SHA_RE='^[0-9a-f]{40}$'
RECORD_PREFIX="pipeline-artifacts/ship-approvals"

log() { printf 'preapproved-check: %s\n' "$*" >&2; }

# Print the record body on stdout; non-zero if it cannot be read.
fetch_record() {
  local sha="$1" region
  region="${AWS_REGION_HUB:-${AWS_DEFAULT_REGION:-${AWS_REGION:-}}}"
  if [ -n "$region" ]; then
    aws s3 cp "s3://${ARTIFACT_BUCKET}/${RECORD_PREFIX}/${sha}.json" - --region "$region" 2>/dev/null
  else
    aws s3 cp "s3://${ARTIFACT_BUCKET}/${RECORD_PREFIX}/${sha}.json" - 2>/dev/null
  fi
}

decide() {
  local sha="${1:-}" body

  if [ -z "${ARTIFACT_BUCKET:-}" ]; then
    log "ARTIFACT_BUCKET is unset - cannot read a ship-approval record, human gate stays"
    printf '0\n'
    return 0
  fi
  if ! [[ "$sha" =~ $SHA_RE ]]; then
    log "source version '$sha' is not a 40-hex commit - human gate stays"
    printf '0\n'
    return 0
  fi

  body="$(fetch_record "$sha")"
  if [ $? -ne 0 ] || [ -z "$body" ]; then
    log "no readable ship-approval record for $sha - human gate stays"
    printf '0\n'
    return 0
  fi

  if printf '%s' "$body" | SHIP_SHA="$sha" python3 -c '
import json, os, re, sys

sha = os.environ["SHIP_SHA"]
raw = sys.stdin.read()
try:
    rec = json.loads(raw)
except Exception as exc:  # noqa: BLE001 - any parse problem is a "no"
    print("preapproved-check: record for %s is not valid JSON (%s)" % (sha, exc), file=sys.stderr)
    sys.exit(1)
if not isinstance(rec, dict):
    print("preapproved-check: record for %s is not a JSON object" % sha, file=sys.stderr)
    sys.exit(1)

merge_commit = str(rec.get("merge_commit") or "").strip().lower()
approved = str(rec.get("approved_head_sha") or "").strip().lower()
hex40 = re.compile(r"^[0-9a-f]{40}$")

if merge_commit != sha:
    print("preapproved-check: record merge_commit %r != deployed commit %r"
          % (merge_commit, sha), file=sys.stderr)
    sys.exit(1)
if not hex40.match(approved):
    print("preapproved-check: record approved_head_sha %r is not a 40-hex sha"
          % (approved,), file=sys.stderr)
    sys.exit(1)

print("preapproved-check: %s is the recorded merge of human-approved head %s"
      % (sha, approved), file=sys.stderr)
sys.exit(0)
'; then
    printf '1\n'
  else
    log "ship-approval record for $sha does not verify - human gate stays"
    printf '0\n'
  fi
  return 0
}

gate() {
  local value="${1-}" sha="${2-}" again

  case "$value" in
    0)
      log "human deploy approval recorded (the ManualApproval ran) - proceeding"
      return 0
      ;;
    1) ;;
    "")
      # UNWIRED stack: the variable does not reach this action at all, so the
      # Approval stage's SKIP condition could not have read it either (same
      # variable, same namespace) - the human gate necessarily fired. Proceed
      # only if that story holds, i.e. no verifying record exists. See the
      # header's "THE EMPTY CASE".
      #
      # First: "no record" must mean we LOOKED and found none. If we cannot look
      # at all, refuse - otherwise blanking ARTIFACT_BUCKET would silently
      # convert the ambiguous case below into a deploy.
      if [ -z "${ARTIFACT_BUCKET:-}" ]; then
        log "FATAL refusing to deploy - DEPLOY_PREAPPROVED is empty AND ARTIFACT_BUCKET is unset, so 'no pre-approval record' cannot be established"
        return 1
      fi
      if ! command -v aws >/dev/null 2>&1; then
        log "FATAL refusing to deploy - DEPLOY_PREAPPROVED is empty AND the aws CLI is missing, so 'no pre-approval record' cannot be established"
        return 1
      fi
      again="$(decide "$sha")"
      if [ "$again" = "1" ]; then
        log "FATAL refusing to deploy - DEPLOY_PREAPPROVED is empty but a ship-approval record for '$sha' DOES verify: the Approval stage may have been skipped, so it is unprovable that a human approved"
        return 1
      fi
      log "DEPLOY_PREAPPROVED not wired (empty); no pre-approval record for $sha; human gate must have fired - proceeding"
      return 0
      ;;
    *)
      log "FATAL refusing to deploy - DEPLOY_PREAPPROVED is '$value', expected exactly 0 or 1"
      return 1
      ;;
  esac

  again="$(decide "$sha")"
  if [ "$again" = "1" ]; then
    log "gate was skipped and the ship-approval record for $sha still verifies - proceeding"
    return 0
  fi
  log "FATAL refusing to deploy - the gate was skipped but the ship-approval record for '$sha' does not verify"
  return 1
}

case "${1:-}" in
  decide) decide "${2:-}" ;;
  gate) gate "${2-}" "${3-}" ;;
  *)
    log "usage: preapproved-check.sh decide <sha> | gate <DEPLOY_PREAPPROVED> <sha>"
    exit 2
    ;;
esac
