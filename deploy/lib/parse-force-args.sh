#!/bin/bash
# ─── deploy/lib/parse-force-args.sh — shared --force CLI parsing (TEAM-3426) ───
#
# The feature contract (security review "--force audit trail"; Ship scope
# "deploy preflight + --force audit logging") promises a `--force` break-glass
# CLI path, but break-glass used to be env-var-only. Worse, deploy-one.sh
# assigned $1 straight to AGENT_NAME, so `deploy-one.sh --force <agent>`
# SILENTLY treated "--force" as the agent name and ran the normal gate, while
# deploy.sh rejected --force as an unknown agent. FINDING 4 (P3, contract gap).
#
# This helper is the ONE parser both deploy/runtime-agent/deploy.sh and
# deploy/runtime-agent/deploy-one.sh use, so the two can't drift:
#
#   source "$SCRIPT_DIR/../lib/parse-force-args.sh"
#   parse_force_args "$@" || { usage >&2; exit 1; }
#   set -- ${FORCE_ARGS_POSITIONAL[@]+"${FORCE_ARGS_POSITIONAL[@]}"}
#
# --force is pure SUGAR over the existing audited env-var break-glass: it
# exports EVAL_GATE_OVERRIDE=1 and EVAL_GATE_OVERRIDE_REASON="<reason>" BEFORE
# require_eval_gate runs, so the override flows through the SAME
# _eval_gate_break_glass helper in check-eval-gate.sh — same loud banner, same
# S3 + local audit records, same refusal when no durable audit sink exists
# (BG-2/BG-3). No audit logic is duplicated here.
#
# Recognized flags:
#   --force                     request the audited break-glass override
#   --force-reason <reason>     the mandatory why (also --force-reason=<reason>)
#   --                          end of options; everything after is positional
#
# Rules (fail closed, never a silent misparse):
#   * --force with no non-empty reason REFUSES up front — BG-2: an unexplained
#     override is never allowed. A reason inherited from an already-set
#     EVAL_GATE_OVERRIDE_REASON env var counts, so
#     `EVAL_GATE_OVERRIDE_REASON=... deploy.sh --force` is accepted.
#   * A CLI --force-reason always WINS over an env reason, and is never
#     silently dropped.
#   * --force-reason without --force REFUSES rather than being ignored.
#   * Any other leading-dash argument REFUSES with a message naming it. Agent
#     names and fleet indices never start with '-', so this can't shadow a
#     legitimate positional; use `--` if one ever does.
#
# Sets FORCE_ARGS_POSITIONAL (array, possibly empty) to the non-flag arguments
# in order. Returns 0 on success, 1 on a parse/validation error with the reason
# already printed to stderr — callers print their own usage and exit non-zero.

# Shared usage lines, so both scripts document the flags identically.
eval_gate_force_usage_lines() {
  echo "  --force               Break-glass: deploy even if the eval gate refuses"
  echo "                        (audited — requires --force-reason)"
  echo "  --force-reason <why>  Why the override is needed (incident id, etc.)."
  echo "                        Same thing as EVAL_GATE_OVERRIDE=1 plus"
  echo "                        EVAL_GATE_OVERRIDE_REASON=...; every override is"
  echo "                        recorded to S3 and .eval-gate-overrides.log, and"
  echo "                        is REFUSED if neither record can be written."
}

parse_force_args() {
  local _pfa_force=0 _pfa_reason="" _pfa_reason_given=0
  FORCE_ARGS_POSITIONAL=()

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --force)
        _pfa_force=1
        shift
        ;;
      --force-reason)
        if [ "$#" -lt 2 ]; then
          echo "ERROR: --force-reason requires a value (e.g. --force-reason 'INC-123: gate red on an unrelated case')" >&2
          return 1
        fi
        _pfa_reason="$2"
        _pfa_reason_given=1
        shift 2
        ;;
      --force-reason=*)
        _pfa_reason="${1#--force-reason=}"
        _pfa_reason_given=1
        shift
        ;;
      --)
        shift
        while [ "$#" -gt 0 ]; do
          FORCE_ARGS_POSITIONAL+=("$1")
          shift
        done
        ;;
      -*)
        echo "ERROR: unknown option '$1'." >&2
        return 1
        ;;
      *)
        FORCE_ARGS_POSITIONAL+=("$1")
        shift
        ;;
    esac
  done

  if [ "$_pfa_reason_given" = "1" ] && [ "$_pfa_force" != "1" ]; then
    echo "ERROR: --force-reason was given without --force — refusing rather than ignoring it. Add --force to actually request the override." >&2
    return 1
  fi

  [ "$_pfa_force" = "1" ] || return 0

  # BG-2: an override with no explanation is refused here, up front, instead of
  # letting the deploy get as far as the gate before failing.
  local _pfa_source=""
  if [ "$_pfa_reason_given" = "1" ]; then
    if [ -z "$_pfa_reason" ]; then
      echo "ERROR: --force requires a non-empty --force-reason — an unexplained break-glass override is refused (BG-2)." >&2
      return 1
    fi
    # A CLI reason always wins over an inherited env one, and is never dropped.
    export EVAL_GATE_OVERRIDE_REASON="$_pfa_reason"
    _pfa_source="--force-reason"
  elif [ -n "${EVAL_GATE_OVERRIDE_REASON:-}" ]; then
    export EVAL_GATE_OVERRIDE_REASON
    _pfa_source="EVAL_GATE_OVERRIDE_REASON env var"
  else
    echo "ERROR: --force requires --force-reason '<incident/why>' — an unexplained break-glass override is refused (BG-2)." >&2
    echo "       e.g. --force --force-reason 'INC-123: hotfix, gate is red on an unrelated case'" >&2
    return 1
  fi

  export EVAL_GATE_OVERRIDE=1
  echo "deploy: --force break-glass requested — routing through the audited eval-gate override (reason from $_pfa_source: ${EVAL_GATE_OVERRIDE_REASON})." >&2
  echo "deploy: the override is recorded to S3 and .eval-gate-overrides.log; it is REFUSED if no durable audit record can be written." >&2
  return 0
}
