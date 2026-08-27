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
# (exit 1) unless HEAD carries a green `config-evals-gate` check run (published
# by .github/workflows/config-evals-gate.yml) whenever the gated globs are
# implicated. Fail closed: a dirty tree touching gated paths, missing gh/jq,
# API errors, a still-running or failed check, and a bypassed gate (gated-path
# commits with no check) all refuse. The guard is READ-ONLY — it never mutates
# git state, S3, or the agents.json runtimeArn merge contract.
#
# EVAL_GATE_CHECKED=1 latches a green verdict for the process tree so a fleet
# fan-out (deploy-fleet.sh → 14 × deploy-one.sh) hits the GitHub API once.
#
# Break-glass (TEAM-3066 BG-2/BG-3 — audited, never silent):
#   EVAL_GATE_OVERRIDE=1 EVAL_GATE_OVERRIDE_REASON="INC-123: hotfix, gate is
#   red on an unrelated case" ./deploy/...
# Both variables are required; an empty reason still refuses. The override is
# recorded to s3://$ARTIFACT_BUCKET/eval-gate/overrides/<ts>-<sha>.txt AND to
# .eval-gate-overrides.log (gitignored). If the S3 write fails you must type
# OVERRIDE-UNAUDITED at a real tty; non-interactive + unaudited refuses.

EVAL_GATE_CHECK_NAME="config-evals-gate"

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
# scp-like). Prints it on stdout; returns 1 if the URL is not recognizable.
eval_gate_owner_repo() {
  local _egor="$1"
  _egor="${_egor%.git}"
  _egor="${_egor%/}"
  _egor="${_egor#git@github.com:}"
  _egor="${_egor#ssh://git@github.com/}"
  _egor="${_egor#https://github.com/}"
  _egor="${_egor#http://github.com/}"
  case "$_egor" in
    */*/* | "" | */ | /*) return 1 ;;
    */*) printf '%s\n' "$_egor"; return 0 ;;
    *) return 1 ;;
  esac
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
# clone graft) — deliberately over-matching there, which fails closed.
_eval_gate_commit_files() {
  git -C "$1" diff --name-only "$2^" "$2" 2>/dev/null \
    || git -C "$1" show --pretty=format: --name-only "$2" 2>/dev/null \
    || true
}

_eval_gate_fetch_check() {
  gh api "repos/$1/commits/$2/check-runs?check_name=${EVAL_GATE_CHECK_NAME}&filter=latest" 2>&1
}

# Audited break-glass path (BG-2/BG-3). Returns 0 to let the caller proceed,
# 1 when the override itself must be refused (unaudited + non-interactive, or
# the operator declined the unaudited confirmation).
_eval_gate_break_glass() {
  local refusal="$1"
  local ts sha ident record repo_root log_file s3_ok
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
  if ! printf '%s\n' "$record" >>"$log_file" 2>/dev/null; then
    echo "eval-gate: WARNING — could not append to $log_file" >&2
  fi

  s3_ok=0
  if [ -n "${ARTIFACT_BUCKET:-}" ] \
    && printf '%s\n' "$record" | aws s3 cp - "s3://${ARTIFACT_BUCKET}/eval-gate/overrides/${ts}-${sha}.txt" >/dev/null 2>&1; then
    s3_ok=1
    echo "eval-gate: override audited to s3://${ARTIFACT_BUCKET}/eval-gate/overrides/${ts}-${sha}.txt and $log_file" >&2
  fi

  if [ "$s3_ok" != "1" ]; then
    echo "eval-gate: S3 audit write FAILED (ARTIFACT_BUCKET='${ARTIFACT_BUCKET:-unset}')." >&2
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

require_eval_gate() {
  # Latch: one green verdict per process tree (deploy-fleet fans out 14×).
  if [ "${EVAL_GATE_CHECKED:-}" = "1" ]; then
    return 0
  fi
  if [ "$#" -eq 0 ]; then
    echo "require_eval_gate: called with no gated globs — refusing (fail closed)." >&2
    exit 1
  fi

  local repo_root
  if ! repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    _eval_gate_refuse "not inside a git checkout — cannot verify the eval gate for HEAD" \
      "  Run deploys from a clone of the repository."
    export EVAL_GATE_CHECKED=1
    return 0
  fi

  # 0. A dirty tree touching gated paths would ship state no gate ever saw.
  local dirty_hit
  if dirty_hit="$(git -C "$repo_root" status --porcelain 2>/dev/null \
      | sed -e 's/^...//' -e 's/^.* -> //' | _eval_gate_any_match "$@")"; then
    _eval_gate_refuse "working tree has uncommitted changes to gated path '$dirty_hit'" \
      "  Deploys ship only committed, gated state. Commit the change, let the
  config-evals-gate PR check run green, merge, then deploy — or stash it."
    export EVAL_GATE_CHECKED=1
    return 0
  fi

  # 1. Tooling — refuse (fail closed) rather than guessing.
  if ! command -v gh >/dev/null 2>&1; then
    _eval_gate_refuse "GitHub CLI 'gh' is not installed — cannot query the gate check" \
      "  Install it (https://cli.github.com/), run 'gh auth login', and retry."
    export EVAL_GATE_CHECKED=1
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    _eval_gate_refuse "'jq' is not installed — cannot parse the check-runs API response" \
      "  Install jq (https://jqlang.github.io/jq/) and retry."
    export EVAL_GATE_CHECKED=1
    return 0
  fi
  if ! gh auth status >/dev/null 2>&1; then
    _eval_gate_refuse "'gh' is not authenticated — cannot query the gate check" \
      "  Run 'gh auth login' (or export GH_TOKEN=<token with repo read>) and retry."
    export EVAL_GATE_CHECKED=1
    return 0
  fi

  # 2. Latest config-evals-gate check run on HEAD.
  local origin_url owner_repo head_sha api_json
  origin_url="$(git -C "$repo_root" remote get-url origin 2>/dev/null || true)"
  if [ -z "$origin_url" ] || ! owner_repo="$(eval_gate_owner_repo "$origin_url")"; then
    _eval_gate_refuse "cannot derive owner/repo from the 'origin' remote (url: '${origin_url:-<none>}')" \
      "  The guard needs a github.com origin remote to look up check runs."
    export EVAL_GATE_CHECKED=1
    return 0
  fi
  head_sha="$(git -C "$repo_root" rev-parse HEAD)"
  if ! api_json="$(_eval_gate_fetch_check "$owner_repo" "$head_sha")"; then
    _eval_gate_refuse "GitHub API error while querying check runs for $head_sha" \
      "  $api_json"
    export EVAL_GATE_CHECKED=1
    return 0
  fi

  local total run_status conclusion url
  total="$(printf '%s' "$api_json" | jq -r '.total_count // 0' 2>/dev/null || echo "")"
  if [ -z "$total" ]; then
    _eval_gate_refuse "unparseable check-runs API response for $head_sha" "  $api_json"
    export EVAL_GATE_CHECKED=1
    return 0
  fi

  if [ "$total" -ge 1 ] 2>/dev/null; then
    run_status="$(printf '%s' "$api_json" | jq -r '.check_runs[0].status // ""')"
    conclusion="$(printf '%s' "$api_json" | jq -r '.check_runs[0].conclusion // ""')"
    url="$(printf '%s' "$api_json" | jq -r '.check_runs[0].html_url // ""')"

    # 3. Green ⇒ deploy, and latch for the rest of the process tree.
    if [ "$conclusion" = "success" ]; then
      echo "eval-gate: ✓ ${EVAL_GATE_CHECK_NAME} is green on HEAD ($head_sha)."
      export EVAL_GATE_CHECKED=1
      return 0
    fi

    # 4. Still running ⇒ wait, don't race it.
    case "$run_status" in
      queued | in_progress)
        _eval_gate_refuse "the ${EVAL_GATE_CHECK_NAME} check on HEAD ($head_sha) is still running ($run_status)" \
          "  Wait for it to finish: ${url:-<no url>}"
        export EVAL_GATE_CHECKED=1
        return 0
        ;;
    esac

    # 5. Failed / cancelled / timed_out / action_required ⇒ refuse with detail.
    local failing
    failing="$(printf '%s' "$api_json" | jq -r '.check_runs[0].output.summary // ""' \
      | grep -E '^- |❌' | head -20 || true)"
    _eval_gate_refuse "the ${EVAL_GATE_CHECK_NAME} check on HEAD ($head_sha) concluded '$conclusion'" \
      "  Check run: ${url:-<no url>}
${failing:+  Failing lines from the gate summary:
$failing}"
    export EVAL_GATE_CHECKED=1
    return 0
  fi

  # 6. ABSENT — no check on HEAD. Only acceptable when nothing gated changed.
  local hit
  if hit="$(_eval_gate_commit_files "$repo_root" "$head_sha" | _eval_gate_any_match "$@")"; then
    _eval_gate_refuse "no ${EVAL_GATE_CHECK_NAME} check exists on HEAD ($head_sha), but HEAD's diff touches gated path '$hit'" \
      "  The gate was bypassed (direct push?). Land gated-path changes through a
  PR so ${EVAL_GATE_CHECK_NAME} runs, and deploy only a green commit."
    export EVAL_GATE_CHECKED=1
    return 0
  fi

  # Belt: the NEWEST gated-path touch in the last 20 first-parent commits must
  # itself carry a green check — a green check on an older ancestor does not
  # cover a later ungated touch, and commits above the newest touch changed
  # nothing gated (or we'd have refused already).
  local c
  for c in $(git -C "$repo_root" rev-list --first-parent --max-count=20 --skip=1 HEAD 2>/dev/null || true); do
    if hit="$(_eval_gate_commit_files "$repo_root" "$c" | _eval_gate_any_match "$@")"; then
      if api_json="$(_eval_gate_fetch_check "$owner_repo" "$c")" \
        && [ "$(printf '%s' "$api_json" | jq -r '.check_runs[0].conclusion // ""' 2>/dev/null)" = "success" ]; then
        break
      fi
      _eval_gate_refuse "ancestor commit $c touched gated path '$hit' without a green ${EVAL_GATE_CHECK_NAME} check" \
        "  The gate was bypassed between that commit and HEAD ($head_sha). Land
  gated-path changes through a PR and deploy only green commits."
      export EVAL_GATE_CHECKED=1
      return 0
    fi
  done

  echo "eval-gate: no ${EVAL_GATE_CHECK_NAME} check on HEAD ($head_sha), but neither HEAD nor the last 20 first-parent commits touched this target's gated paths — proceeding (informational)."
  export EVAL_GATE_CHECKED=1
  return 0
}
