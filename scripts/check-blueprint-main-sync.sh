#!/usr/bin/env bash
# ─── Blueprint main-sync parity guard (TEAM-4529) ─────────────────────────────
#
# Branch staleness is not a code defect. Every agent on the delivery chain owns
# the SAME rule: a branch merely behind the repo default branch — or `mergeable:
# CONFLICTING` only because of that — is never a finding and never a fix ticket;
# the agent merges `origin/<default branch>` INTO the branch in its own turn
# (merge commit, never a rebase or force-push) and only escalates a genuine
# behaviour conflict. Root cause it exists for: in wf_1789170903227_c3x6k1 the
# code reviewer filed "won't merge into main" as a must-fix in rounds 1 AND 2,
# burning must-fix slots and forcing two extra re-reviews on a branch whose only
# problem was that main had moved.
#
# Blueprints are served one file at a time (`load_blueprint`, s3://…/blueprints/
# <name>.md) and CANNOT include each other, so the rule is duplicated verbatim in
# nine files. Duplication drifts silently: one reviewer blueprint that still
# treats staleness as a defect re-creates the exact failure above, and one
# blueprint that says "rebase" instead of "merge" rewrites a shared integration
# branch's history under agents that are still working on it. This guard is what
# keeps the nine copies honest:
#
#   1. the 14-line canonical block is byte-identical in all nine blueprints
#   2. every dev blueprint also wires the sync into its delivery step
#   3. the code reviewer states, where it classifies findings, that staleness is
#      NOT one
#   4. each downstream blueprint scopes push/no-push and names the fix kind a
#      NON-TRIVIAL conflict escalates through
#   5. no blueprint instructs a rebase / force-push / hard reset, and the CI
#      agent's pre-CI P0 pushed sync + `sync_fix` escalation still exist (the
#      dev-side sync is the first line of defence, P0 is the safety net — the
#      guard refuses to let the net be deleted)
#
# Same shape as scripts/check-fix-kinds-parity.sh: no AWS, no network, pure text.
# `--self-test` re-runs every check against seeded-broken copies and fails if any
# check would have passed — a guard nobody proved can fail is not a guard.
set -euo pipefail
cd "$(dirname "$0")/.."

MARKER='## Main-sync rule (a branch behind the default branch is NOT a defect)'
BLOCK_LINES=14
CANON_BP="backend-dev"                                    # the canonical copy
DEV_BPS=(backend-dev api-dev frontend-dev bug-fixer code-sweeper)
DOWNSTREAM_BPS=(code-reviewer qa-verifier ci-agent release-manager)
ALL_BPS=("${DEV_BPS[@]}" "${DOWNSTREAM_BPS[@]}")
# The fix-ticket kind each downstream agent escalates a NON-TRIVIAL conflict
# through. No new kind was minted for staleness on purpose (see
# scripts/check-fix-kinds-parity.sh): each agent reuses the one it already owns.
declare -A ESCALATION_KIND=(
  [code-reviewer]="codex_fix"
  [qa-verifier]="qa_fix"
  [ci-agent]="sync_fix"
  [release-manager]="ship_fix"
)

RULE="TEAM-4529: the Main-sync rule block is duplicated verbatim in every
        blueprint that syncs a branch. Copy it byte-for-byte from
        blueprints/${CANON_BP}.md and put the role-specific push/no-push and
        escalation wording in the '**Your scope:**' paragraph AFTER it."

# The canonical block, extracted from one file: the marker line plus the next
# $BLOCK_LINES-1 lines. Exits 1 when the marker is absent.
extract_block() { # $1 = blueprint path
  awk -v marker="$MARKER" -v n="$BLOCK_LINES" '
    !found && index($0, marker) == 1 { found = 1 }
    found && printed < n { print; printed++ }
    END { if (!found) exit 1 }
  ' "$1"
}

# Line number of the marker (0 when absent).
marker_line() { grep -Fxn "$MARKER" "$1" 2>/dev/null | head -1 | cut -d: -f1 || true; }

run_checks() { # $1 = repo root to check (the tree, not just blueprints/)
  local root="$1" bp f fail=0 canon block scope_line n
  canon="$(mktemp)"
  if ! extract_block "$root/blueprints/${CANON_BP}.md" >"$canon"; then
    echo "FAIL: the canonical Main-sync block is missing from blueprints/${CANON_BP}.md" >&2
    echo "      $RULE" >&2
    rm -f "$canon"
    return 1
  fi
  if [ "$(wc -l <"$canon")" -ne "$BLOCK_LINES" ]; then
    echo "FAIL: blueprints/${CANON_BP}.md has fewer than $BLOCK_LINES lines of Main-sync block" >&2
    fail=1
  fi

  # ─── 1. byte-identical block in all nine blueprints ─────────────────────────
  for bp in "${ALL_BPS[@]}"; do
    f="$root/blueprints/${bp}.md"
    if [ ! -f "$f" ]; then
      echo "FAIL: $f does not exist — update ALL_BPS in $0 if a blueprint was renamed" >&2
      fail=1
      continue
    fi
    if ! extract_block "$f" >"$canon.$bp" 2>/dev/null; then
      echo "FAIL: blueprints/${bp}.md is missing the Main-sync rule block" >&2
      echo "      $RULE" >&2
      fail=1
      continue
    fi
    if ! diff -u "$canon" "$canon.$bp" >/dev/null; then
      echo "FAIL: the Main-sync block in blueprints/${bp}.md differs from blueprints/${CANON_BP}.md:" >&2
      diff -u --label "blueprints/${CANON_BP}.md" --label "blueprints/${bp}.md" \
        "$canon" "$canon.$bp" >&2 || true
      echo "      $RULE" >&2
      fail=1
    fi
    # ─── 4a. every blueprint scopes push/no-push right after the block ────────
    n="$(marker_line "$f")"
    scope_line="$(sed -n "$((n + BLOCK_LINES + 1))p" "$f")"
    if [[ "$scope_line" != '**Your scope:**'* ]]; then
      echo "FAIL: blueprints/${bp}.md has no '**Your scope:**' paragraph directly after the Main-sync block" >&2
      echo "      (push vs local-only and the escalation route are role-specific — they belong there, not in the shared block)" >&2
      fail=1
    fi
    rm -f "$canon.$bp"
  done

  # ─── 2. dev blueprints wire the sync into their delivery step ───────────────
  # Two references minimum: the block heading itself, plus the delivery step
  # pointing back at it. A block nobody's process step invokes is decoration.
  for bp in "${DEV_BPS[@]}"; do
    f="$root/blueprints/${bp}.md"
    [ -f "$f" ] || continue
    if [ "$(grep -c 'Main-sync rule' "$f")" -lt 2 ]; then
      echo "FAIL: blueprints/${bp}.md never references the Main-sync rule from its delivery step" >&2
      echo "      A dev must sync base_branch with origin/<default branch> BEFORE report_completion." >&2
      fail=1
    fi
  done

  # ─── 3. the reviewer says staleness is not a finding, where it classifies ───
  f="$root/blueprints/code-reviewer.md"
  if [ -f "$f" ] && ! grep -q 'Staleness is NOT a finding' "$f"; then
    echo "FAIL: blueprints/code-reviewer.md does not state 'Staleness is NOT a finding'" >&2
    echo "      Without it the ZERO-FINDINGS GATE re-swallows a branch that only needs a main-merge" >&2
    echo "      (wf_1789170903227_c3x6k1: must-fix in rounds 1 and 2)." >&2
    fail=1
  fi

  # ─── 4b. each downstream blueprint names its escalation kind ────────────────
  for bp in "${DOWNSTREAM_BPS[@]}"; do
    f="$root/blueprints/${bp}.md"
    [ -f "$f" ] || continue
    if ! grep -q "${ESCALATION_KIND[$bp]}" "$f"; then
      echo "FAIL: blueprints/${bp}.md never names ${ESCALATION_KIND[$bp]} — a non-trivial conflict has nowhere to go" >&2
      fail=1
    fi
  done

  # ─── 5a. nobody instructs a rebase / force-push / hard reset ────────────────
  # "Never rebase, never force-push, never reset" is prose, not an instruction,
  # so the patterns below match only the commands themselves.
  for bp in "${ALL_BPS[@]}"; do
    f="$root/blueprints/${bp}.md"
    [ -f "$f" ] || continue
    if grep -nE 'git rebase|push [^`]*--force|--force-with-lease|git reset --hard' "$f" >/dev/null; then
      echo "FAIL: blueprints/${bp}.md instructs a rebase / force-push / hard reset on a shared branch:" >&2
      grep -nE 'git rebase|push [^`]*--force|--force-with-lease|git reset --hard' "$f" >&2
      echo "      Sync means MERGE: rewriting an integration branch's history breaks every agent still on it." >&2
      fail=1
    fi
  done

  # ─── 5b. the CI agent's pre-CI P0 sync is the safety net — keep it ──────────
  f="$root/blueprints/ci-agent.md"
  if [ -f "$f" ]; then
    grep -q 'git merge origin/<default branch>' "$f" || {
      echo "FAIL: blueprints/ci-agent.md lost its P0 'git merge origin/<default branch>' sync" >&2
      echo "      The dev-side sync is the first line of defence; P0 is the net that proves the certified SHA is the SHA that lands." >&2
      fail=1
    }
    grep -q 'Fix (sync-main)' "$f" || {
      echo "FAIL: blueprints/ci-agent.md lost its 'Fix (sync-main)' escalation for non-trivial conflicts" >&2
      fail=1
    }
  fi

  rm -f "$canon"
  return "$fail"
}

# ─── --self-test: every check must actually be able to fail ───────────────────
self_test() {
  local tmp seeded pass=0 fail=0
  echo "self-test: seeding one violation at a time; each MUST make the guard fail"
  # name|command run inside the seeded copy (sed etc.), all relative to $tmp
  local -a CASES=(
    "block deleted from a downstream blueprint|sed -i '/^## Main-sync rule /,+13d' blueprints/qa-verifier.md"
    "block reworded in one blueprint (drift)|sed -i 's/means MERGE, never rebase/means merge/' blueprints/release-manager.md"
    "'Your scope' paragraph dropped|sed -i '0,/^\\*\\*Your scope:\\*\\*/{/^\\*\\*Your scope:\\*\\*/d}' blueprints/code-reviewer.md"
    "dev delivery step no longer invokes the rule|sed -i '0,/^## Main-sync rule /!{s/Main-sync rule/main sync/g}' blueprints/backend-dev.md"
    "reviewer's staleness carve-out removed|sed -i 's/Staleness is NOT a finding/Staleness is a finding/' blueprints/code-reviewer.md"
    "escalation kind removed from a blueprint|sed -i 's/ship_fix/SOME_OTHER_KIND/g' blueprints/release-manager.md"
    "a blueprint instructs a rebase|sed -i 's|git fetch origin \&\& git checkout|git rebase origin/main \&\& git checkout|' blueprints/ci-agent.md"
    "CI agent's P0 pushed sync deleted|sed -i 's|git merge origin/<default branch>|git status|g' blueprints/ci-agent.md"
  )
  for case in "${CASES[@]}"; do
    tmp="$(mktemp -d)"
    mkdir -p "$tmp/blueprints"
    cp blueprints/*.md "$tmp/blueprints/"
    seeded="${case#*|}"
    ( cd "$tmp" && eval "$seeded" )
    if run_checks "$tmp" >/dev/null 2>&1; then
      echo "  SELF-TEST FAIL: guard still passed with: ${case%%|*}" >&2
      fail=$((fail + 1))
    else
      echo "  ok — caught: ${case%%|*}"
      pass=$((pass + 1))
    fi
    rm -rf "$tmp"
  done
  echo "self-test: $pass caught, $fail missed"
  [ "$fail" -eq 0 ]
}

if [ "${1:-}" = "--self-test" ]; then
  self_test || { echo "" >&2; echo "blueprint main-sync guard SELF-TEST FAILED" >&2; exit 1; }
  exit 0
fi

if ! run_checks "."; then
  echo "" >&2
  echo "blueprint main-sync guard FAILED (scripts/check-blueprint-main-sync.sh)" >&2
  exit 1
fi

echo "blueprint main-sync guard: OK"
echo "  blueprints  = ${#ALL_BPS[@]} carrying a byte-identical ${BLOCK_LINES}-line block"
echo "  dev sync    = ${#DEV_BPS[@]} blueprints wire it into their delivery step"
echo "  downstream  = ${#DOWNSTREAM_BPS[@]} blueprints scope push/no-push + name their escalation kind"
