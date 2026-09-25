#!/bin/bash
# ─── deploy/lib/s3-seed-if-absent.sh — create a live S3 config object ONLY if absent ──
#
# The hub keeps a few LIVE documents in the artifact bucket that a deploy must
# never overwrite: config/models.json (the one model registry, written by the
# Models tab and the nightly reconcile) and config/pricing.json (its rate
# projection). A deploy seeds them from the repo copy on a first install and
# leaves them alone forever after.
#
# "Leave alone" used to be a HEAD then an unconditional `aws s3 cp` (TEAM-5073
# made the HEAD 404-only). That is a check-then-act race: any writer that
# creates the key between the HEAD and the copy — the hub's first-write path
# (saveModelsRegistry with IfNoneMatch "*"), the reconcile, a parallel deploy —
# is clobbered by the bundled seed (TEAM-5081). The write itself is now the
# guard: `put-object --if-none-match '*'` can only create, never replace.
#
#   source "$REPO_ROOT/deploy/lib/s3-seed-if-absent.sh"
#   s3_seed_if_absent "$ARTIFACT_BUCKET" config/pricing.json "$REPO_ROOT/src/config/pricing.json" "$AWS_REGION"
#
# Per key, in order:
#   1. head-object. exit 0 → present, kept, return 0 (the cheap fast path; the
#      log says so). Only a real 404 / NoSuchKey / NotFound is absence — a 403, an
#      expired token or a throttle is an ERROR and returns 1, exactly as
#      TEAM-5073 left it. The HEAD is kept as the fast path; the conditional
#      PUT below is the actual guard and closes the window the HEAD leaves open.
#   2. put-object --if-none-match '*'.
#        200                          → seeded, return 0
#        412 PreconditionFailed       → another writer created it between the
#                                       HEAD and the PUT. Believed only once a
#                                       second head-object shows the object:
#                                       then theirs is kept, return 0; otherwise
#                                       ERROR, return 1 (TEAM-5113)
#        409 ConditionalRequestConflict → a concurrent conditional write is in
#                                       flight; retried (S3_SEED_MAX_ATTEMPTS,
#                                       default 3, backoff S3_SEED_RETRY_SLEEP
#                                       "0.2 0.6" seconds — the same 3-attempt
#                                       rule as saveModelsRegistry in
#                                       src/lib/models-registry.ts). The retry
#                                       resolves to 200 or 412; still 409 after
#                                       the last attempt is an ERROR, return 1
#        anything else                → ERROR, return 1 (a CLI too old to know
#                                       --if-none-match fails here too: "Unknown
#                                       options" is not a silent copy)
#
# Every code above is matched ONLY in the CLI's own error prefix, line-anchored:
#   An error occurred (<Code>) when calling the <Operation> operation: ...
# and only on a non-zero exit (a successful call returns before any match).
# Grepping for the bare code matched it anywhere in stderr — an AccessDenied
# whose role ARN contained "PreconditionFailed" read as "kept", exit 0, and the
# deploy carried on with nothing seeded (TEAM-5113).
#
# Callers run under `set -e`, so a non-zero return stops the deploy before it
# writes anything else. `aws --version` is echoed once per process so the CLI a
# deploy ran with is on record (--if-none-match on put-object needs AWS CLI v2
# >= 2.17.34, 2024-08-20). Portable to bash 3.2 (an operator's laptop) as well
# as the CodeBuild image — no negative array indices, no ${!var}.
#
# Tested hermetically by deploy/lib/__tests__/s3-seed-if-absent.test.ts (the
# helper), lambda/cost-report/deploy.test.mjs (that caller) and
# deploy/pipeline/test_buildspec_deploy_seed.py (the Target 2 block).

_S3_SEED_VERSION_SHOWN=""

s3_seed_if_absent() {
  local bucket="$1" key="$2" file="$3" region="$4"
  local head_err put_err attempt max_attempts sleeps sleep_for
  if [[ -z "$bucket" || -z "$key" || -z "$file" || -z "$region" ]]; then
    echo "ERROR: s3_seed_if_absent needs <bucket> <key> <local-file> <region>" >&2
    return 2
  fi
  if [[ ! -f "$file" ]]; then
    echo "ERROR: seed source for $key does not exist: $file" >&2
    return 1
  fi
  if [[ -z "$_S3_SEED_VERSION_SHOWN" ]]; then
    echo "==> seeding with $(aws --version 2>&1 | head -n 1)"
    _S3_SEED_VERSION_SHOWN=1
  fi

  # 1. Fast path. Only a real 404 is absence (TEAM-5073), and only in the CLI's
  # own error prefix (TEAM-5113).
  if head_err=$(aws s3api head-object --bucket "$bucket" --key "$key" --region "$region" 2>&1 >/dev/null); then
    echo "==> $key present - live document kept (not overwritten)"
    return 0
  elif ! grep -qE '^An error occurred \((404|NoSuchKey|NotFound)\) when calling the HeadObject operation' <<<"$head_err"; then
    echo "ERROR: head-object $key failed: $head_err" >&2
    return 1
  fi

  # 2. The guard: create-only. A 412 means someone else created it first — once a
  # head-object confirms the object is really there.
  max_attempts="${S3_SEED_MAX_ATTEMPTS:-3}"
  read -r -a sleeps <<<"${S3_SEED_RETRY_SLEEP:-0.2 0.6}"
  attempt=1
  while (( attempt <= max_attempts )); do
    if put_err=$(aws s3api put-object --bucket "$bucket" --key "$key" --body "$file" \
        --content-type application/json --if-none-match '*' --region "$region" 2>&1 >/dev/null); then
      echo "==> seeded $key from $file (was absent)"
      return 0
    fi
    if grep -qE '^An error occurred \((PreconditionFailed|412)\) when calling the PutObject operation' <<<"$put_err"; then
      if head_err=$(aws s3api head-object --bucket "$bucket" --key "$key" --region "$region" 2>&1 >/dev/null); then
        echo "==> $key appeared after the head check - another writer created it, kept (not overwritten)"
        return 0
      fi
      echo "ERROR: put-object $key answered 412 but head-object does not show the object: $head_err" >&2
      return 1
    fi
    if grep -qE '^An error occurred \((ConditionalRequestConflict|409)\) when calling the PutObject operation' <<<"$put_err"; then
      if (( attempt < max_attempts )); then
        sleep_for="${sleeps[$((attempt - 1))]:-}"
        [[ -n "$sleep_for" ]] || sleep_for="${sleeps[$(( ${#sleeps[@]} - 1 ))]}"
        echo "    $key: a concurrent conditional write is in flight (409) - retry $attempt/$((max_attempts - 1)) in ${sleep_for}s"
        sleep "$sleep_for"
        attempt=$((attempt + 1))
        continue
      fi
      echo "ERROR: put-object $key still 409 ConditionalRequestConflict after $max_attempts attempts: $put_err" >&2
      return 1
    fi
    echo "ERROR: put-object $key failed: $put_err" >&2
    return 1
  done
  echo "ERROR: put-object $key: exhausted $max_attempts attempts" >&2
  return 1
}
