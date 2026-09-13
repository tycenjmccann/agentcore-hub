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
# Hence: empty + a POSITIVE not-found -> proceed (a human necessarily approved);
# empty + anything else -> REFUSE. The two halves are load-bearing as a PAIR; the
# first alone would be unsound.
#
# "No record" must be a POSITIVE "we looked and S3 said 404", never the mere
# absence of a "found one" (TEAM-4527 review P0). `decide` collapses every read
# failure to "0" so it can never fail the Build, which means AccessDenied, a
# throttle, a timeout or a network blip all look identical to "no record exists"
# through it. Reusing it here would have let an asymmetrically-wired pipeline skip
# the human gate and then deploy on a transient S3 error. So the empty path uses
# `record_absent` instead, which returns three distinct outcomes and licenses a
# deploy on exactly one of them; it also refuses when ARTIFACT_BUCKET is unset,
# when the aws CLI is missing, and when the commit is not 40-hex (none of which
# can produce a not-found). An object that is merely PRESENT is grounds to refuse
# whether or not it parses, so the empty path never inspects the body.
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

# ── record_absent <sha> — a POSITIVE "looked and found none" (TEAM-4527 P0) ──
#
# `decide` deliberately collapses EVERY read failure to "0" because it must never
# fail the Build. That is the right contract there and the wrong one for the empty
# `gate` path: "0" there would mean AccessDenied, a throttle, a timeout or a DNS
# blip all read as "no record exists", which is how an asymmetrically-wired
# pipeline could skip the human gate and then deploy on a transient S3 error.
#
# So the empty path uses THIS instead, which never guesses. Exit codes:
#   0 = the object DEFINITELY does not exist (S3 said 404 / NoSuchKey)
#   1 = the object EXISTS and was read (whether or not it verifies -- an object
#       that is present is grounds to refuse either way, so we never parse it)
#   2 = INDETERMINATE: any other failure (403/AccessDenied, SlowDown/throttling,
#       timeout, endpoint/network error, an aws CLI that died). Caller must refuse.
#
# Only exit 0 is a licence to proceed. This function is NOT used by `decide` and
# does not change its contract.
record_absent() {
  local sha="$1" region errfile rc err
  region="${AWS_REGION_HUB:-${AWS_DEFAULT_REGION:-${AWS_REGION:-}}}"
  errfile="$(mktemp 2>/dev/null || echo /tmp/preapproved-probe.$$)"

  if [ -n "$region" ]; then
    aws s3 cp "s3://${ARTIFACT_BUCKET}/${RECORD_PREFIX}/${sha}.json" - --region "$region" \
      >/dev/null 2>"$errfile"
  else
    aws s3 cp "s3://${ARTIFACT_BUCKET}/${RECORD_PREFIX}/${sha}.json" - \
      >/dev/null 2>"$errfile"
  fi
  rc=$?
  err="$(cat "$errfile" 2>/dev/null)"
  rm -f "$errfile"

  if [ "$rc" -eq 0 ]; then
    log "a ship-approval record object EXISTS for $sha"
    return 1
  fi

  # Classify the failure. Only an explicit not-found is a positive absence; the
  # aws CLI reports both 404 and AccessDenied with exit 1, so the exit code alone
  # cannot be trusted here and the message is what distinguishes them.
  # TEAM-4527 review P3: `Key "` alone is too loose a signal on its own (an
  # error message could name a key for an unrelated reason) - it only means
  # not-found paired with "does not exist", the real `aws s3 cp` 404 shape.
  case "$err" in
    *"(404)"*|*NoSuchKey*|*"Not Found"*|*'Key "'*'does not exist'*)
      log "S3 reports NO ship-approval record object for $sha (definite not-found)"
      return 0
      ;;
  esac

  log "INDETERMINATE ship-approval record lookup for $sha (aws exit $rc): ${err:-no stderr}"
  return 2
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
      # variable, same namespace) - the human gate necessarily fired. See the
      # header's "THE EMPTY CASE".
      #
      # The licence to proceed is a POSITIVE "looked and found none", never the
      # ABSENCE of a positive "found one". Every step below refuses unless S3
      # itself said the object does not exist.
      if [ -z "${ARTIFACT_BUCKET:-}" ]; then
        log "FATAL refusing to deploy - DEPLOY_PREAPPROVED is empty AND ARTIFACT_BUCKET is unset, so 'no pre-approval record' cannot be established"
        return 1
      fi
      if ! command -v aws >/dev/null 2>&1; then
        log "FATAL refusing to deploy - DEPLOY_PREAPPROVED is empty AND the aws CLI is missing, so 'no pre-approval record' cannot be established"
        return 1
      fi
      # A commit we cannot even form a lookup for cannot yield a not-found.
      if ! [[ "$sha" =~ $SHA_RE ]]; then
        log "FATAL refusing to deploy - DEPLOY_PREAPPROVED is empty AND source version '$sha' is not a 40-hex commit, so no record lookup can be performed"
        return 1
      fi
      record_absent "$sha"
      case $? in
        0)
          log "DEPLOY_PREAPPROVED not wired (empty); no pre-approval record for $sha; human gate must have fired - proceeding"
          return 0
          ;;
        1)
          log "FATAL refusing to deploy - DEPLOY_PREAPPROVED is empty but a ship-approval record for '$sha' EXISTS: the Approval stage may have been skipped, so it is unprovable that a human approved"
          return 1
          ;;
        *)
          log "FATAL refusing to deploy - DEPLOY_PREAPPROVED is empty and the ship-approval record for '$sha' could not be determined either way (see the INDETERMINATE line above). A transient or permission failure must never read as 'no record'"
          return 1
          ;;
      esac
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
