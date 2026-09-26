#!/bin/bash
# Fake `aws` for the seed-if-absent tests (deploy/lib/__tests__/s3-seed-if-absent.test.ts
# and deploy/pipeline/test_buildspec_deploy_seed.py). Models exactly the S3 semantics
# the helper depends on, with an on-disk store so a test can read back WHAT is stored:
#
#   FAKE_S3_STORE           dir; s3://<bucket>/<key> lives at $FAKE_S3_STORE/<key>  (required)
#   FAKE_S3_LOG             append every invocation's args here
#   FAKE_S3_HEAD_ERR        stderr for head-object (exit 254) instead of a real answer;
#                           FAKE_S3_HEAD_ERR_KEY limits it to one key
#   FAKE_S3_APPEAR_AFTER_HEAD  key that "another writer" creates the moment anything
#                           tries to write it (after the HEAD said 404), with
#                           FAKE_S3_APPEAR_CONTENT as its body
#   FAKE_S3_PUT_409         answer the first N put-objects 409 ConditionalRequestConflict
#   FAKE_S3_PUT_ERR         stderr for every put-object (exit 254) — a 403, a throttle...
#   FAKE_S3_OLD_CLI=1       a CLI that predates conditional writes: rejects --if-none-match
#
# `aws s3 cp <local> s3://...` is the PRE-fix write path and is modelled as what it
# is — an unconditional overwrite — so the same fixtures show the base scripts losing
# the race.
set -u
[[ -n "${FAKE_S3_LOG:-}" ]] && printf '%s\n' "$*" >> "$FAKE_S3_LOG"
store="${FAKE_S3_STORE:?FAKE_S3_STORE is required}"

err404() { echo "An error occurred (404) when calling the HeadObject operation: Not Found" >&2; exit 254; }
err412() { echo "An error occurred (PreconditionFailed) when calling the PutObject operation: At least one of the pre-conditions you specified did not hold" >&2; exit 254; }
err409() { echo "An error occurred (ConditionalRequestConflict) when calling the PutObject operation: Conditional request cannot succeed due to a conflicting operation against this resource." >&2; exit 254; }

# The "other writer": lands its object on the first write attempt against that key.
appear() {
  local key="$1"
  if [[ "${FAKE_S3_APPEAR_AFTER_HEAD:-}" == "$key" && ! -f "$store/$key" ]]; then
    mkdir -p "$(dirname "$store/$key")"
    printf '%s' "${FAKE_S3_APPEAR_CONTENT:-{\"foreign\":true\}}" > "$store/$key"
  fi
}

case "$1" in
  --version) echo "aws-cli/2.99.0 Python/3.12.0 Linux/fake exe/x86_64"; exit 0 ;;
  s3api)
    op="$2"; shift 2
    key=""; body=""; cond=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --key) key="$2"; shift 2 ;;
        --body) body="$2"; shift 2 ;;
        --if-none-match) cond="$2"; shift 2 ;;
        --bucket|--region|--content-type) shift 2 ;;
        *) shift ;;
      esac
    done
    case "$op" in
      head-object)
        if [[ -n "${FAKE_S3_HEAD_ERR:-}" && ( -z "${FAKE_S3_HEAD_ERR_KEY:-}" || "$FAKE_S3_HEAD_ERR_KEY" == "$key" ) ]]; then
          echo "$FAKE_S3_HEAD_ERR" >&2; exit 254
        fi
        [[ -f "$store/$key" ]] && exit 0
        err404 ;;
      put-object)
        if [[ -n "$cond" && "${FAKE_S3_OLD_CLI:-}" == "1" ]]; then
          echo "Unknown options: --if-none-match, $cond" >&2; exit 252
        fi
        if [[ -n "${FAKE_S3_PUT_ERR:-}" ]]; then echo "$FAKE_S3_PUT_ERR" >&2; exit 254; fi
        if [[ -n "${FAKE_S3_PUT_409:-}" ]]; then
          n=0; [[ -f "$store/.409-count" ]] && n="$(cat "$store/.409-count")"
          if (( n < FAKE_S3_PUT_409 )); then echo $((n + 1)) > "$store/.409-count"; err409; fi
        fi
        appear "$key"
        if [[ -n "$cond" && -f "$store/$key" ]]; then err412; fi
        mkdir -p "$(dirname "$store/$key")"
        cp "$body" "$store/$key"
        echo '{"ETag":"\"fake\""}'; exit 0 ;;
      *) exit 0 ;;
    esac ;;
  s3)
    op="$2"; shift 2
    src=""; dst=""
    while [[ $# -gt 0 ]]; do
      case "$1" in --region) shift 2 ;; --*) shift ;; *) if [[ -z "$src" ]]; then src="$1"; else dst="$1"; fi; shift ;; esac
    done
    if [[ "$op" == cp && "$dst" == s3://* ]]; then
      key="${dst#s3://}"; key="${key#*/}"
      appear "$key"
      mkdir -p "$(dirname "$store/$key")"
      cp "$src" "$store/$key"            # unconditional: the pre-fix overwrite
    fi
    exit 0 ;;
  *) exit 0 ;;
esac
