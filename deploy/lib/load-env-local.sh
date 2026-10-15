#!/bin/bash
# ─── .env.local loader (TEAM-6202) ────────────────────────────────────────────
# The ONE home of the "source .env.local safely" pattern. Every deploy script
# that reads .env.local calls load_env_local <path> instead of hand-rolling
# `if [ -f F ]; then set -a; source F; set +a; fi`.
#
# Why: deploy/config.sh (sourced by ~25 scripts) and the direct-source sites
# (deploy/apprunner/deploy.sh, deploy/apprunner/setup-jira-webhook.sh,
# deploy/ecs-express/deploy.sh, deploy/continuous-improvement/
# deploy-token-aggregator.sh, .claude-plugin/bin/run-module.sh,
# .claude-plugin/bin/verify-module.sh) run under `set -euo pipefail`. A
# .env.local line that expands an unset variable (e.g. an optional token:
# GITHUB_TOKEN="$OPTIONAL_REVIEW_TOKEN") makes bash's nounset abort the whole
# script with "unbound variable" before any real work happens — even though
# the exact same file sources fine under plain `set -e`. scripts/
# trace-workflow.sh hit this and TEAM-6200 F4 fixed it there inline
# (set +u / source / set -u); this file generalizes that fix to one place so
# every site gets it the same way.
#
# Contract: no-op (returns 0) if the file does not exist — matches the
# `[ -f ]` guard every call site already had. Suspends nounset only for the
# duration of the source, and restores -u to whatever it was before the call
# (not unconditionally on) — a caller that was NOT running under -u (e.g.
# deploy/config.sh when sourced from a plain `set -e` script) must not have
# -u turned on behind its back. POSIX `case $-` is used instead of bash's
# `[[ -o ]]` since config.sh is sourced by scripts that only promise POSIX sh
# compatibility at the top level. -a is always turned back off afterwards,
# unconditionally, matching every call site's original
# `set -a; source F; set +a` — none of them run under -a themselves.
#
# Caveat: the file is sourced from inside this function, so a `declare`/
# `typeset` line in .env.local would create a function-local variable instead
# of a shell global. Every .env.local in this repo (hand-written or written
# by .claude-plugin/bin/apply-env.sh) uses plain KEY="value" lines, so this
# does not happen in practice.
# ───────────────────────────────────────────────────────────────────────────────

load_env_local() {
  local env_file="$1"
  [ -f "$env_file" ] || return 0

  local had_u=0
  case "$-" in *u*) had_u=1 ;; esac

  set +u
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
  if [ "$had_u" -eq 1 ]; then
    set -u
  fi
}
