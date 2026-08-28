#!/bin/bash
# ─── deploy/lib/check-eval-gate.sh — eval-gate deploy guard (FR-7) ────────────
#
# Source this right after deploy/config.sh, then declare which repo paths the
# target ships:
#
#   source "$REPO_ROOT/deploy/lib/check-eval-gate.sh"
#   require_eval_gate "deploy/runtime-agent/prompts/**" "src/config/agents.json"
#
# require_eval_gate operates on HEAD of the checkout and REFUSES the deploy
# (exit 1) unless HEAD carries a green `config-evals-gate` check run whenever
# the gated globs are implicated. The check is published by
# .github/workflows/config-evals-gate.yml on pull_request ONLY, so check runs
# attach to PR head SHAs — a merge/squash commit on main carries none. When
# HEAD has no check, the guard resolves HEAD to the merged PR that produced it
# (repos/<owner/repo>/commits/<sha>/pulls, requiring merged_at != null AND
# merge_commit_sha == <sha>, which proves the sha IS that PR's merge result for
# both merge commits and squash merges) and reads the verdict off that PR's
# head sha. Fail closed: a dirty tree touching gated paths, missing gh/jq, API
# errors, a still-running or failed check, an ambiguous or failed PR
# resolution, and a bypassed gate (gated-path commits with no check) all
# refuse. The guard is READ-ONLY — it never mutates git state, S3, or the
# agents.json runtimeArn merge contract.
#
# Latch (TEAM-3337 A2/A4, hardened TEAM-3388): the latch is a per-invocation
# UNFORGEABLE TOKEN, not a bare env var. When the gate verifies green (or an
# audited break-glass override proceeds), _eval_gate_set_latch writes
# "<head_sha> <nonce>" — nonce from /dev/urandom — to a chmod-600 temp file
# created by the verifying process, and exports EVAL_GATE_CHECKED (the
# verified head sha) plus EVAL_GATE_LATCH_FILE and EVAL_GATE_LATCH_NONCE. A
# repeat call in the same process tree (deploy-fleet.sh → 14 × deploy-one.sh)
# short-circuits ONLY when ALL of these hold: EVAL_GATE_CHECKED equals the
# current HEAD, the latch file is set and exists, and its content round-trips
# as "<HEAD> <nonce>" — and it always prints a loud "latched" line, never a
# silent return. Anything else — a stale sha, the legacy "1", a foreign
# checkout, or a hand-exported EVAL_GATE_CHECKED=$(git rev-parse HEAD) with no
# valid token — is loudly called out as invalid/forged, IGNORED, and the full
# check runs: a bare env var is NO LONGER honored. The latch is set only on
# (a) verified-green verdicts for HEAD — direct or via merged-PR resolution;
# green covers the whole tree at that sha, so a sha-keyed latch is safe across
# targets with different globs — and (b) audited break-glass override
# proceeds, so the override is audited once and each subsequent short-circuit
# is loud. The informational "nothing gated changed" proceed is NOT latched:
# that verdict is specific to one target's globs.
#
# Belt (TEAM-3337 A3, enforced TEAM-3388): when HEAD carries no check,
# first-parent ancestors are scanned back to a green anchor — the newest
# gated-path-touching commit, which must carry green evidence (direct check or
# merged-PR resolution) — with a hard safety cap of 100 commits. The cap is
# now ENFORCED, not a documented residual: when first-parent history extends
# beyond the cap and the scan finds neither a green anchor nor a gated touch,
# the guard REFUSES (fail closed) — deploy a commit with a green check, or use
# the audited break-glass. A scan that covers the FULL first-parent history
# (history no deeper than the cap) still proceeds informationally.
#
# Break-glass (TEAM-3066 BG-2/BG-3 — audited, never silent):
#   EVAL_GATE_OVERRIDE=1 EVAL_GATE_OVERRIDE_REASON="INC-123: hotfix, gate is
#   red on an unrelated case" ./deploy/...
# Both variables are required; an empty reason still refuses. The override is
# recorded to s3://$ARTIFACT_BUCKET/eval-gate/overrides/<ts>-<sha>.txt AND to
# .eval-gate-overrides.log (gitignored). If the S3 write fails you must type
# OVERRIDE-UNAUDITED at a real tty — and the LOCAL log append must have
# succeeded (some audit record must exist somewhere). Non-interactive + no S3
# audit refuses; S3 AND local both failing refuses even at a tty (TEAM-3295).

EVAL_GATE_CHECK_NAME="config-evals-gate"
EVAL_GATE_BELT_MAX=100

# Pure helper (unit-driven by evals tests): does path $1 match any gated glob
# in $2..$n? "dir/**" matches dir itself and anything beneath it; other
# patterns use standard shell case matching.
eval_gate_path_matches() {
  local _egpm_path="$1" _egpm_glob _egpm_prefix
  shift
  for _egpm_glob in "$@"; do
    case "$_egpm_glob" in
      *"/**")
        _egpm_prefix="${_egpm_glob%/\*\*}"
        if [ "$_egpm_path" = "$_egpm_prefix" ]; then return 0; fi
        case "$_egpm_path" in
          "$_egpm_prefix"/*) return 0 ;;
        esac
        ;;
      *)
        # shellcheck disable=SC2254 # deliberate unquoted glob match
        case "$_egpm_path" in
          $_egpm_glob) return 0 ;;
        esac
        ;;
    esac
  done
  return 1
}

# Pure helper: derive "owner/repo" from an origin remote URL (https / ssh /
# scp-like), including credentialed forms carrying a user[:password]@ userinfo
# component (common in CI via insteadOf rewrites). Prints it on stdout;
# returns 1 if the URL is not recognizable.
eval_gate_owner_repo() {
  local _egor="$1" _egor_auth
  _egor="${_egor%.git}"
  _egor="${_egor%/}"
  case "$_egor" in
    git@github.com:*)
      # scp-like — handled FIRST so the generic userinfo strip below can't
      # mangle the "git@github.com:" prefix.
      _egor="${_egor#git@github.com:}"
      ;;
    ssh://* | https://* | http://*)
      _egor="${_egor#*://}"
      # Drop a user[:password]@ userinfo component ahead of the host, if any
      # (split the authority on its LAST '@' so a literal '@' in the password
      # can't leave credentials behind).
      case "$_egor" in
        */*)
          _egor_auth="${_egor%%/*}"
          case "$_egor_auth" in
            *@*) _egor="${_egor_auth##*@}/${_egor#*/}" ;;
          esac
          ;;
      esac
      case "$_egor" in
        github.com/*) _egor="${_egor#github.com/}" ;;
        *) return 1 ;;
      esac
      ;;
  esac
  case "$_egor" in
    */*/* | "" | */ | /*) return 1 ;;
    */*) printf '%s\n' "$_egor"; return 0 ;;
    *) return 1 ;;
  esac
}

# Pure helper: redact any user[:password]@ userinfo in a remote URL so it can
# be printed in diagnostics without leaking an embedded credential. The whole
# userinfo — username AND password/token — becomes '***'; URLs without
# userinfo pass through unchanged.
eval_gate_redact_url() {
  local _egru="$1" _egru_scheme="" _egru_head _egru_tail=""
  case "$_egru" in
    *://*)
      _egru_scheme="${_egru%%://*}://"
      _egru="${_egru#*://}"
      ;;
  esac
  # Userinfo lives in the authority — everything before the first '/'. This
  # also covers scp-like host:path forms, whose '@' precedes any slash.
  case "$_egru" in
    */*)
      _egru_head="${_egru%%/*}"
      _egru_tail="/${_egru#*/}"
      ;;
    *) _egru_head="$_egru" ;;
  esac
  case "$_egru_head" in
    *@*) _egru_head="***@${_egru_head##*@}" ;;
  esac
  printf '%s\n' "${_egru_scheme}${_egru_head}${_egru_tail}"
}

# stdin: newline-separated repo-relative paths; args: gated globs.
# Prints the first matching path; returns 0 if any matched.
_eval_gate_any_match() {
  local _egam_p
  while IFS= read -r _egam_p; do
    [ -z "$_egam_p" ] && continue
    if eval_gate_path_matches "$_egam_p" "$@"; then
      printf '%s\n' "$_egam_p"
      return 0
    fi
  done
  return 1
}

# Files touched by commit $2's first-parent diff (repo root $1). Falls back to
# the commit's full file list at history boundaries (root commit / shallow
# clone graft) — deliberately over-matching there, which fails closed. Returns
# non-zero when BOTH fail: callers must refuse (an unreadable commit must not
# masquerade as "touched nothing" — that would fail open).
_eval_gate_commit_files() {
  git -C "$1" diff --name-only "$2^" "$2" 2>/dev/null \
    || git -C "$1" show --pretty=format: --name-only "$2" 2>/dev/null
}

# Latch setter (A2/A4 — see the header): record verified head sha $1 as this
# process tree's latch. Writes "<sha> <nonce>" to a chmod-600 mktemp file (the
# audit/latch temp file is one of the guard's only writes) and exports
# EVAL_GATE_CHECKED + EVAL_GATE_LATCH_FILE + EVAL_GATE_LATCH_NONCE. If the
# token cannot be created, nothing is exported — the gate simply re-runs on
# the next target instead of latching (safe, just slower). Never returns
# non-zero: callers run under `set -e` deploy scripts.
_eval_gate_set_latch() {
  local _egsl_sha="$1" _egsl_nonce="" _egsl_file=""
  if [ -r /dev/urandom ] && command -v od >/dev/null 2>&1; then
    _egsl_nonce="$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n' || true)"
  fi
  if [ -z "$_egsl_nonce" ]; then
    # Weak fallback for hosts without /dev/urandom or od — still per-process
    # and unguessable enough to beat a copy-pasted env var.
    _egsl_nonce="fallback-$$-${RANDOM}${RANDOM}${RANDOM}-$(date -u +%s%N 2>/dev/null || echo 0)"
  fi
  if ! _egsl_file="$(mktemp "${TMPDIR:-/tmp}/eval-gate-latch.XXXXXX" 2>/dev/null)"; then
    echo "eval-gate: WARNING — cannot create the latch token file; the gate will re-run per target instead of latching." >&2
    return 0
  fi
  chmod 600 "$_egsl_file" 2>/dev/null || true
  if ! printf '%s %s\n' "$_egsl_sha" "$_egsl_nonce" >"$_egsl_file" 2>/dev/null; then
    echo "eval-gate: WARNING — cannot write the latch token file; the gate will re-run per target instead of latching." >&2
    rm -f "$_egsl_file" 2>/dev/null || true
    return 0
  fi
  export EVAL_GATE_CHECKED="$_egsl_sha"
  export EVAL_GATE_LATCH_FILE="$_egsl_file"
  export EVAL_GATE_LATCH_NONCE="$_egsl_nonce"
}

_eval_gate_fetch_check() {
  gh api "repos/$1/commits/$2/check-runs?check_name=${EVAL_GATE_CHECK_NAME}&filter=latest" 2>&1
}

# Resolve sha $2 (repo $1) to the merged PR it is the merge result of. Prints
# "<pr_number> <pr_head_sha>" and returns 0 only when EXACTLY ONE associated
# PR has merged_at != null AND merge_commit_sha == $2 — that equality proves
# the sha IS that PR's merge result (true for both merge commits and squash
# merges). API error, unparseable response, no match, or ambiguity ⇒ return 1
# (fail closed: the caller falls back to its refusal path).
_eval_gate_resolve_merged_pr_head() {
  local _egrp_json _egrp_out
  _egrp_json="$(gh api "repos/$1/commits/$2/pulls" 2>/dev/null)" || return 1
  _egrp_out="$(printf '%s' "$_egrp_json" | jq -r --arg sha "$2" '
    [ .[] | select(.merged_at != null and .merge_commit_sha == $sha) ]
    | if length == 1 then "\(.[0].number) \(.[0].head.sha)" else empty end
  ' 2>/dev/null)" || return 1
  [ -n "$_egrp_out" ] || return 1
  printf '%s\n' "$_egrp_out"
}

# Audited break-glass path (BG-2/BG-3). Returns 0 to let the caller proceed,
# 1 when the override itself must be refused (unaudited + non-interactive, or
# the operator declined the unaudited confirmation).
_eval_gate_break_glass() {
  local refusal="$1"
  local ts sha ident record repo_root log_file s3_ok local_ok
  repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  sha="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || echo unknown)"
  # BG-3: cloud identity, not just a local username. Fall back to whoami only
  # when STS is unreachable — and say so in the record.
  if ! ident="$(aws sts get-caller-identity --output text --query Arn 2>/dev/null)" || [ -z "$ident" ]; then
    ident="whoami:$(whoami 2>/dev/null || echo unknown) (aws sts get-caller-identity FAILED — identity unverified)"
  fi

  {
    echo ""
    echo "╔════════════════════════════════════════════════════════════════════╗"
    echo "║          EVAL GATE BREAK-GLASS OVERRIDE — DEPLOYING UNGATED         ║"
    echo "╚════════════════════════════════════════════════════════════════════╝"
    echo "  refused for : $refusal"
    echo "  sha         : $sha"
    echo "  script      : $0"
    echo "  identity    : $ident"
    echo "  reason      : ${EVAL_GATE_OVERRIDE_REASON:-}"
    echo ""
  } >&2

  if command -v jq >/dev/null 2>&1; then
    record="$(jq -cn --arg timestamp "$ts" --arg sha "$sha" --arg identity "$ident" \
      --arg script "$0" --arg reason "${EVAL_GATE_OVERRIDE_REASON:-}" \
      '{timestamp:$timestamp,sha:$sha,identity:$identity,script:$script,reason:$reason}')"
  else
    record="timestamp=$ts sha=$sha identity=$ident script=$0 reason=${EVAL_GATE_OVERRIDE_REASON:-}"
  fi

  log_file="$repo_root/.eval-gate-overrides.log"
  local_ok=0
  if printf '%s\n' "$record" >>"$log_file" 2>/dev/null; then
    local_ok=1
  else
    echo "eval-gate: WARNING — could not append to $log_file" >&2
  fi

  s3_ok=0
  if [ -n "${ARTIFACT_BUCKET:-}" ] \
    && printf '%s\n' "$record" | aws s3 cp - "s3://${ARTIFACT_BUCKET}/eval-gate/overrides/${ts}-${sha}.txt" >/dev/null 2>&1; then
    s3_ok=1
    if [ "$local_ok" = "1" ]; then
      echo "eval-gate: override audited to s3://${ARTIFACT_BUCKET}/eval-gate/overrides/${ts}-${sha}.txt and $log_file" >&2
    else
      echo "eval-gate: override audited to s3://${ARTIFACT_BUCKET}/eval-gate/overrides/${ts}-${sha}.txt (local append to $log_file FAILED)" >&2
    fi
  fi

  if [ "$s3_ok" != "1" ]; then
    echo "eval-gate: S3 audit write FAILED (ARTIFACT_BUCKET='${ARTIFACT_BUCKET:-unset}')." >&2
    # BG-3/FR-3.3 (TEAM-3295 + TEAM-3388): proceeding without the S3 record
    # requires that the LOCAL audit record exists. Both writes failed ⇒ no
    # durable audit record can be written ⇒ no audit record exists anywhere ⇒
    # refuse unconditionally, interactive or not.
    if [ "$local_ok" != "1" ]; then
      echo "eval-gate: the local audit append to $log_file ALSO failed — no durable audit record of this override can be written; no audit record exists anywhere; refusing (BG-3/FR-3.3: an override with zero audit trail is never allowed)." >&2
      return 1
    fi
    if { true </dev/tty; } 2>/dev/null; then
      local answer=""
      printf 'eval-gate: type OVERRIDE-UNAUDITED to proceed with only the local audit record: ' >&2
      IFS= read -r answer </dev/tty || answer=""
      if [ "$answer" != "OVERRIDE-UNAUDITED" ]; then
        echo "eval-gate: unaudited override not confirmed — refusing." >&2
        return 1
      fi
      echo "eval-gate: proceeding UNAUDITED on interactive confirmation ($log_file only)." >&2
    else
      echo "eval-gate: non-interactive and the S3 audit failed — refusing (BG-3: never silently proceed unaudited)." >&2
      return 1
    fi
  fi

  echo "eval-gate: proceeding under break-glass override." >&2
  return 0
}

# Refuse the deploy: print the reason (+ optional detail block) and exit 1 —
# unless a fully-audited break-glass override is in effect, in which case it
# RETURNS 0 and the caller latches + proceeds.
_eval_gate_refuse() {
  local reason="$1" detail="${2:-}"
  if [ "${EVAL_GATE_OVERRIDE:-}" = "1" ]; then
    if [ -z "${EVAL_GATE_OVERRIDE_REASON:-}" ]; then
      echo "eval-gate: EVAL_GATE_OVERRIDE=1 but EVAL_GATE_OVERRIDE_REASON is empty — an unexplained override is refused (BG-2)." >&2
    elif _eval_gate_break_glass "$reason"; then
      return 0
    fi
  fi
  {
    echo ""
    echo "✗ EVAL GATE REFUSED: $reason"
    if [ -n "$detail" ]; then
      printf '%s\n' "$detail"
    fi
    echo "  Break-glass (audited): EVAL_GATE_OVERRIDE=1 EVAL_GATE_OVERRIDE_REASON='<incident/why>' <deploy cmd>"
  } >&2
  exit 1
}

# Fetch the ${EVAL_GATE_CHECK_NAME} check run for sha $2 (repo $1) and apply
# the shared green/running/red verdict logic. $3 describes where the evidence
# lives, for logs and refusal messages (e.g. "HEAD (abc)" or "PR #7 head def
# (merged as HEAD abc)"). Return codes:
#   0 — green: the caller proceeds (and latches when the sha covers HEAD)
#   2 — absent (total_count=0): the caller decides what absence means there
#   3 — a refusal fired but the audited break-glass override let it return:
#       the caller latches HEAD and proceeds
# Every other outcome (API error, unparseable response, still-running check,
# red check) refuses inside _eval_gate_refuse — fail closed.
_eval_gate_verdict() {
  local _egv_repo="$1" _egv_sha="$2" _egv_where="$3"
  local _egv_json _egv_total _egv_status _egv_conclusion _egv_url _egv_failing
  if ! _egv_json="$(_eval_gate_fetch_check "$_egv_repo" "$_egv_sha")"; then
    _eval_gate_refuse "GitHub API error while querying check runs for $_egv_where" \
      "  $_egv_json"
    return 3
  fi
  _egv_total="$(printf '%s' "$_egv_json" | jq -r '.total_count // 0' 2>/dev/null || echo "")"
  if [ -z "$_egv_total" ]; then
    _eval_gate_refuse "unparseable check-runs API response for $_egv_where" "  $_egv_json"
    return 3
  fi
  if ! [ "$_egv_total" -ge 1 ] 2>/dev/null; then
    return 2
  fi

  _egv_status="$(printf '%s' "$_egv_json" | jq -r '.check_runs[0].status // ""')"
  _egv_conclusion="$(printf '%s' "$_egv_json" | jq -r '.check_runs[0].conclusion // ""')"
  _egv_url="$(printf '%s' "$_egv_json" | jq -r '.check_runs[0].html_url // ""')"

  # Green ⇒ let the caller proceed.
  if [ "$_egv_conclusion" = "success" ]; then
    return 0
  fi

  # Still running ⇒ wait, don't race it.
  case "$_egv_status" in
    queued | in_progress)
      _eval_gate_refuse "the ${EVAL_GATE_CHECK_NAME} check on $_egv_where is still running ($_egv_status)" \
        "  Wait for it to finish: ${_egv_url:-<no url>}"
      return 3
      ;;
  esac

  # Failed / cancelled / timed_out / action_required ⇒ refuse with detail.
  _egv_failing="$(printf '%s' "$_egv_json" | jq -r '.check_runs[0].output.summary // ""' \
    | grep -E '^- |❌' | head -20 || true)"
  _eval_gate_refuse "the ${EVAL_GATE_CHECK_NAME} check on $_egv_where concluded '$_egv_conclusion'" \
    "  Check run: ${_egv_url:-<no url>}
${_egv_failing:+  Failing lines from the gate summary:
$_egv_failing}"
  return 3
}

require_eval_gate() {
  # Latch (A2, hardened TEAM-3388): honor the latch ONLY when the full token
  # round-trips — EVAL_GATE_CHECKED == HEAD, the latch file exists, and its
  # content is exactly "<HEAD> <EVAL_GATE_LATCH_NONCE>". A bare env var (e.g.
  # a hand-exported `EVAL_GATE_CHECKED=$(git rev-parse HEAD)`) is a forgeable
  # bypass and is loudly ignored; never silently short-circuit.
  local _egr_latch_head _egr_latch_content
  _egr_latch_head="$(git rev-parse HEAD 2>/dev/null || true)"
  if [ -n "${EVAL_GATE_CHECKED:-}" ]; then
    if [ -n "$_egr_latch_head" ] && [ "$EVAL_GATE_CHECKED" = "$_egr_latch_head" ] \
      && [ -n "${EVAL_GATE_LATCH_FILE:-}" ] && [ -f "${EVAL_GATE_LATCH_FILE}" ] \
      && [ -n "${EVAL_GATE_LATCH_NONCE:-}" ]; then
      _egr_latch_content="$(cat "$EVAL_GATE_LATCH_FILE" 2>/dev/null || true)"
      if [ "$_egr_latch_content" = "$_egr_latch_head ${EVAL_GATE_LATCH_NONCE}" ]; then
        echo "eval-gate: ✓ latched — $_egr_latch_head already verified in this process tree (EVAL_GATE_CHECKED + latch token)."
        return 0
      fi
    fi
    echo "eval-gate: WARNING — EVAL_GATE_CHECKED='${EVAL_GATE_CHECKED}' has no valid latch token for HEAD (${_egr_latch_head:-<unresolvable>}): the latch is stale, foreign, or FORGED (a bare EVAL_GATE_CHECKED env var is not honored — the gate requires the nonce file written by the verifying process). IGNORING it and running the full check." >&2
  fi
  if [ "$#" -eq 0 ]; then
    echo "require_eval_gate: called with no gated globs — refusing (fail closed)." >&2
    exit 1
  fi

  local repo_root
  if ! repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    _eval_gate_refuse "not inside a git checkout — cannot verify the eval gate for HEAD" \
      "  Run deploys from a clone of the repository."
    # Override-proceed with no HEAD sha to latch: each invocation re-audits.
    return 0
  fi

  local head_sha
  if ! head_sha="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null)" || [ -z "$head_sha" ]; then
    _eval_gate_refuse "cannot resolve HEAD in $repo_root — cannot verify the eval gate" \
      "  Deploys ship a concrete commit; make sure the checkout has one."
    return 0
  fi

  # 0. A dirty tree touching gated paths would ship state no gate ever saw.
  local dirty_hit
  if dirty_hit="$(git -C "$repo_root" status --porcelain 2>/dev/null \
      | sed -e 's/^...//' -e 's/^.* -> //' | _eval_gate_any_match "$@")"; then
    _eval_gate_refuse "working tree has uncommitted changes to gated path '$dirty_hit'" \
      "  Deploys ship only committed, gated state. Commit the change, let the
  config-evals-gate PR check run green, merge, then deploy — or stash it."
    _eval_gate_set_latch "$head_sha"
    return 0
  fi

  # 1. Tooling — refuse (fail closed) rather than guessing.
  if ! command -v gh >/dev/null 2>&1; then
    _eval_gate_refuse "GitHub CLI 'gh' is not installed — cannot query the gate check" \
      "  Install it (https://cli.github.com/), run 'gh auth login', and retry."
    _eval_gate_set_latch "$head_sha"
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    _eval_gate_refuse "'jq' is not installed — cannot parse the check-runs API response" \
      "  Install jq (https://jqlang.github.io/jq/) and retry."
    _eval_gate_set_latch "$head_sha"
    return 0
  fi
  if ! gh auth status >/dev/null 2>&1; then
    _eval_gate_refuse "'gh' is not authenticated — cannot query the gate check" \
      "  Run 'gh auth login' (or export GH_TOKEN=<token with repo read>) and retry."
    _eval_gate_set_latch "$head_sha"
    return 0
  fi

  local origin_url owner_repo
  origin_url="$(git -C "$repo_root" remote get-url origin 2>/dev/null || true)"
  if [ -z "$origin_url" ] || ! owner_repo="$(eval_gate_owner_repo "$origin_url")"; then
    _eval_gate_refuse "cannot derive owner/repo from the 'origin' remote (url: '$(eval_gate_redact_url "${origin_url:-<none>}")')" \
      "  The guard needs a github.com origin remote to look up check runs."
    _eval_gate_set_latch "$head_sha"
    return 0
  fi

  # 2–5. Latest config-evals-gate check run on HEAD: green ⇒ proceed + latch;
  # running/red/API error ⇒ refuse inside _eval_gate_verdict.
  local verdict
  verdict=0
  _eval_gate_verdict "$owner_repo" "$head_sha" "HEAD ($head_sha)" || verdict=$?
  case "$verdict" in
    0)
      echo "eval-gate: ✓ ${EVAL_GATE_CHECK_NAME} is green on HEAD ($head_sha)."
      _eval_gate_set_latch "$head_sha"
      return 0
      ;;
    3)
      _eval_gate_set_latch "$head_sha"
      return 0
      ;;
  esac

  # 6. ABSENT — no check on HEAD. The gate workflow runs on pull_request only,
  # so check runs attach to PR head SHAs and a merge/squash commit on main
  # carries none (A1). Before treating absence as a bypass, resolve HEAD to
  # the merged PR that produced it and read the verdict off that PR's head
  # sha. Resolution failure/ambiguity falls through to the refusal path below.
  local pr_resolved pr_number pr_head_sha
  if pr_resolved="$(_eval_gate_resolve_merged_pr_head "$owner_repo" "$head_sha")"; then
    pr_number="${pr_resolved%% *}"
    pr_head_sha="${pr_resolved##* }"
    verdict=0
    _eval_gate_verdict "$owner_repo" "$pr_head_sha" \
      "PR #$pr_number head $pr_head_sha (merged as HEAD $head_sha)" || verdict=$?
    case "$verdict" in
      0)
        echo "eval-gate: ✓ ${EVAL_GATE_CHECK_NAME} green on PR #$pr_number head $pr_head_sha, merged as HEAD $head_sha."
        _eval_gate_set_latch "$head_sha"
        return 0
        ;;
      3)
        _eval_gate_set_latch "$head_sha"
        return 0
        ;;
    esac
    echo "eval-gate: HEAD ($head_sha) resolved to merged PR #$pr_number (head $pr_head_sha) but that head carries no ${EVAL_GATE_CHECK_NAME} check — treating the check as absent." >&2
  fi

  # No check on HEAD directly or via its merged PR — only acceptable when
  # nothing gated changed. Capture the file list FIRST: a pipe would discard
  # _eval_gate_commit_files' exit status, and an unreadable commit must refuse
  # (fail closed), not pass as "touched nothing".
  local hit _egr_files
  if ! _egr_files="$(_eval_gate_commit_files "$repo_root" "$head_sha")"; then
    _eval_gate_refuse "cannot read the file list for HEAD ($head_sha) — git diff and git show both failed" \
      "  Unreadable history cannot prove the gate holds. Check the clone
  (shallow/corrupt?) and retry."
    _eval_gate_set_latch "$head_sha"
    return 0
  fi
  if hit="$(printf '%s\n' "$_egr_files" | _eval_gate_any_match "$@")"; then
    _eval_gate_refuse "no ${EVAL_GATE_CHECK_NAME} check exists on HEAD ($head_sha) or via a merged PR resolving to it, but HEAD's diff touches gated path '$hit'" \
      "  The gate was bypassed (direct push?). Land gated-path changes through a
  PR so ${EVAL_GATE_CHECK_NAME} runs, and deploy only a green commit."
    _eval_gate_set_latch "$head_sha"
    return 0
  fi

  # Belt (A3, enforced): scan first-parent ancestors (skip HEAD) back to a
  # green anchor — the NEWEST gated-path touch, which must carry green
  # evidence (direct check, or merged-PR resolution) or we refuse. A green
  # verdict covered the whole tree at that sha, so the scan can stop there;
  # commits above it changed nothing gated (or we'd have refused already).
  # Hard cap of EVAL_GATE_BELT_MAX commits — total is computed up front so the
  # verdict below can tell "scanned everything (history fits the cap)" apart
  # from "capped with history left unexamined", which now REFUSES.
  local c anchor="" anchor_via="" scanned=0 total=0
  total="$(git -C "$repo_root" rev-list --first-parent --count HEAD 2>/dev/null || echo 0)"
  for c in $(git -C "$repo_root" rev-list --first-parent \
      --max-count="$EVAL_GATE_BELT_MAX" --skip=1 HEAD 2>/dev/null || true); do
    scanned=$((scanned + 1))
    if ! _egr_files="$(_eval_gate_commit_files "$repo_root" "$c")"; then
      _eval_gate_refuse "cannot read the file list for ancestor commit $c — git diff and git show both failed" \
        "  Unreadable history cannot prove the gate holds. Check the clone
  (shallow/corrupt?) and retry."
      _eval_gate_set_latch "$head_sha"
      return 0
    fi
    if hit="$(printf '%s\n' "$_egr_files" | _eval_gate_any_match "$@")"; then
      verdict=0
      _eval_gate_verdict "$owner_repo" "$c" "ancestor $c (gated path '$hit')" || verdict=$?
      case "$verdict" in
        0)
          anchor="$c"
          anchor_via="a direct check on $c"
          break
          ;;
        3)
          _eval_gate_set_latch "$head_sha"
          return 0
          ;;
      esac
      # No direct check — the ancestor may itself be a merge/squash commit
      # whose evidence lives on its PR's head sha (A1).
      if pr_resolved="$(_eval_gate_resolve_merged_pr_head "$owner_repo" "$c")"; then
        pr_number="${pr_resolved%% *}"
        pr_head_sha="${pr_resolved##* }"
        verdict=0
        _eval_gate_verdict "$owner_repo" "$pr_head_sha" \
          "PR #$pr_number head $pr_head_sha (merged as ancestor $c)" || verdict=$?
        case "$verdict" in
          0)
            anchor="$c"
            anchor_via="PR #$pr_number head $pr_head_sha"
            break
            ;;
          3)
            _eval_gate_set_latch "$head_sha"
            return 0
            ;;
        esac
      fi
      _eval_gate_refuse "ancestor commit $c touched gated path '$hit' without a green ${EVAL_GATE_CHECK_NAME} check (direct or via a merged PR)" \
        "  The gate was bypassed between that commit and HEAD ($head_sha). Land
  gated-path changes through a PR and deploy only green commits."
      _eval_gate_set_latch "$head_sha"
      return 0
    fi
  done

  # A4: the informational proceeds below do NOT latch — those verdicts are
  # specific to THIS target's gated globs, and a different target in the same
  # fan-out must run its own scan. Hitting the cap with history left beyond it
  # REFUSES (A3 enforced, TEAM-3388): the unexamined tail could hide a gated
  # direct push, and proceeding there was a fail-open hole.
  if [ -n "$anchor" ]; then
    echo "eval-gate: ✓ green anchor at ancestor $anchor (via $anchor_via); no ${EVAL_GATE_CHECK_NAME} check on HEAD ($head_sha) but nothing gated changed since the anchor — proceeding (informational, not latched)."
  elif [ "$scanned" -ge "$EVAL_GATE_BELT_MAX" ] \
    && { [ "$total" -le 0 ] || [ "$((total - 1))" -gt "$EVAL_GATE_BELT_MAX" ]; }; then
    # total<=0 means the depth could not be measured — treat as beyond-cap
    # (fail closed) rather than assuming the scan covered everything.
    local total_desc="unknown"
    if [ "$total" -gt 0 ]; then total_desc="$((total - 1))"; fi
    _eval_gate_refuse "no ${EVAL_GATE_CHECK_NAME} check on HEAD ($head_sha) and the first-parent scan hit the $EVAL_GATE_BELT_MAX-commit cap without finding a green anchor or a gated-path touch" \
      "  History beyond the cap ($total_desc first-parent ancestors in total) is
  unexamined, so the gate cannot prove it holds. Deploy a commit that carries a
  green ${EVAL_GATE_CHECK_NAME} check, or use the audited break-glass override."
    _eval_gate_set_latch "$head_sha"
    return 0
  else
    echo "eval-gate: no ${EVAL_GATE_CHECK_NAME} check on HEAD ($head_sha), and no first-parent ancestor (full history scanned: $scanned commits) touched this target's gated paths — proceeding (informational, not latched)."
  fi
  return 0
}
