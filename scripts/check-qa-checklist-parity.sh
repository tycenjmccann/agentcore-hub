#!/usr/bin/env bash
# ─── QA-checklist parity guard ────────────────────────────────────────────────
#
# The hub has ONE verification standard: blueprints/qa-checklist.md. It is not a
# persona — any agent that has to decide "does this change actually work?" loads
# it with load_blueprint("qa-checklist") and runs the checks that apply. Two
# agents load it today: the QA verifier (its Steps 3-4) and the operator (its
# B3b LIVE VERIFY step).
#
# Root cause it exists for: wf_1789180719970_e7fdjx (operator def, PR #558)
# shipped Agent Chat with 96 mocked vitest cases + 5 mocked Playwright cases and
# never rendered a single reply. The live-verification rules existed, but only
# inside blueprints/qa-verifier.md — and the operator def dispatches no QA
# persona, so nine layers passed a feature nobody had run. The fix was to make
# the checklist a shared blueprint. This guard keeps it that way:
#
#   1. the checklist file exists and still carries every MANDATORY check, the
#      Verification Ledger, the evidence_kind semantics and the no-mock rule
#   2. every loader blueprint calls load_blueprint("qa-checklist")
#   3. no persona blueprint re-inlines the checklist's rules (a second copy is a
#      fork that drifts — exactly how the operator ended up with none)
#   4. the operator wires the checklist into its process: a B3b step, a
#      `## Live verification` plan section, a LIVE VERIFY PROMPT, the ledger in
#      the merge brief, and evidence_kind="live" reserved for checks that ran
#
# Same shape as scripts/check-blueprint-main-sync.sh: no AWS, no network, pure
# text. `--self-test` re-runs every check against seeded-broken copies and fails
# if any check would have passed — a guard nobody proved can fail is not a guard.
set -euo pipefail
cd "$(dirname "$0")/.."

CHECKLIST="blueprints/qa-checklist.md"
LOADERS=(qa-verifier operator)
LOAD_CALL='load_blueprint("qa-checklist")'

# Every persona blueprint that is NOT the checklist. A checklist-only phrase
# showing up in one of these means the rules were copied instead of loaded.
persona_blueprints() {
  for f in blueprints/*.md; do
    [ "$f" = "$CHECKLIST" ] && continue
    echo "$f"
  done
}

# Phrases that must exist in the checklist (one per mandatory element).
CHECKLIST_MUST_HAVE=(
  '## C1. Visual verification (MANDATORY for UI changes)'
  '## C2. Live integration verification (MANDATORY when the change calls anything outside the process)'
  '## C3. iOS projects (MANDATORY'
  '## C4. Performance re-measure (MANDATORY when the change claims a perf fix)'
  '## C5. Acceptance criteria walk'
  '## C6. Verification Ledger + verdict'
  'you may NOT substitute'
  'Verified by construction'
  'evidence_kind'
  'Never emit "CONDITIONAL PASS"'
  'a PASS covers only what actually'
)

# Phrases that belong to the checklist ONLY. If a persona blueprint carries one,
# it re-inlined the rules. Chosen to be the checklist's own headings/definitions,
# not words a loader legitimately uses when pointing at it.
CHECKLIST_ONLY=(
  'Visual Verification (MANDATORY for UI changes)'
  'Visual verification (MANDATORY for UI changes)'
  'Live Integration Verification (MANDATORY'
  'Live integration verification (MANDATORY'
  'MANDATORY when the ticket claims a perf fix'
  'MANDATORY when the change claims a perf fix'
  '| Compile / build | yes/NO |'
  'may NOT substitute'
)

# What the operator must wire, and where the text has to say it.
OPERATOR_MUST_HAVE=(
  '### B3b. LIVE VERIFY'
  '## Live verification ('
  '**LIVE VERIFY PROMPT**'
  'VERIFICATION LEDGER (verbatim from B3b'
  'DECISION: BLOCKED'
  '`evidence_kind="live"` ONLY when B3b'
  '"Verified by construction" is a P1'
  'B3b (live verify, the shared QA checklist)'
  '**Ledger source check.**'
)

run_checks() { # $1 = repo root to check
  local root="$1" fail=0 f bp phrase
  local cl="$root/$CHECKLIST"

  # ─── 1. the checklist exists and is intact ─────────────────────────────────
  if [ ! -f "$cl" ]; then
    echo "FAIL: $CHECKLIST is missing — it is the hub's one verification standard" >&2
    return 1
  fi
  for phrase in "${CHECKLIST_MUST_HAVE[@]}"; do
    if ! grep -qF -- "$phrase" "$cl"; then
      echo "FAIL: $CHECKLIST lost a mandatory element: '$phrase'" >&2
      fail=1
    fi
  done

  # ─── 2. every loader points at it ──────────────────────────────────────────
  for bp in "${LOADERS[@]}"; do
    f="$root/blueprints/${bp}.md"
    if [ ! -f "$f" ]; then
      echo "FAIL: $f does not exist — update LOADERS in $0 if a blueprint was renamed" >&2
      fail=1
      continue
    fi
    if ! grep -qF -- "$LOAD_CALL" "$f"; then
      echo "FAIL: blueprints/${bp}.md no longer calls $LOAD_CALL" >&2
      echo "      Verification rules live in ONE file; a loader that stops loading it has no standard." >&2
      fail=1
    fi
  done

  # ─── 3. nobody re-inlines the checklist ────────────────────────────────────
  for f in $(cd "$root" && persona_blueprints); do
    for phrase in "${CHECKLIST_ONLY[@]}"; do
      if grep -qF -- "$phrase" "$root/$f"; then
        echo "FAIL: $f re-inlines the QA checklist ('$phrase')" >&2
        echo "      Load it with $LOAD_CALL instead — a second copy forks the standard." >&2
        fail=1
      fi
    done
  done

  # ─── 4. the operator wires it into its process ─────────────────────────────
  f="$root/blueprints/operator.md"
  if [ -f "$f" ]; then
    for phrase in "${OPERATOR_MUST_HAVE[@]}"; do
      if ! grep -qF -- "$phrase" "$f"; then
        echo "FAIL: blueprints/operator.md lost its checklist wiring: '$phrase'" >&2
        fail=1
      fi
    done
    # The plan template must not let "mocked only" satisfy live verification.
    if ! grep -qF -- '"Mocked only" is not an option here' "$f"; then
      echo "FAIL: blueprints/operator.md's PLAN PROMPT no longer rules out a mocked-only live verification" >&2
      fail=1
    fi
  fi

  return "$fail"
}

# ─── --self-test: every check must actually be able to fail ───────────────────
self_test() {
  local tmp seeded pass=0 fail=0
  echo "self-test: seeding one violation at a time; each MUST make the guard fail"
  local -a CASES=(
    "checklist deleted|rm blueprints/qa-checklist.md"
    "C2 live-integration check removed from the checklist|sed -i.bak '/^## C2\\. Live integration/,/^## C3\\./{/^## C3\\./!d;}' blueprints/qa-checklist.md"
    "no-mock rule reworded|sed -i.bak 's/you may NOT substitute/you may substitute/' blueprints/qa-checklist.md"
    "qa-verifier stops loading the checklist|sed -i.bak 's/load_blueprint(\"qa-checklist\")/load_blueprint(\"qa-verifier\")/g' blueprints/qa-verifier.md"
    "operator stops loading the checklist|sed -i.bak 's/load_blueprint(\"qa-checklist\")/load_blueprint(\"review-package\")/g' blueprints/operator.md"
    "a persona re-inlines the visual check|printf '\\n### Step 3: Visual Verification (MANDATORY for UI changes)\\n' >> blueprints/frontend-dev.md"
    "a persona re-inlines the ledger table|printf '\\n| Compile / build | yes/NO | pass | key |\\n' >> blueprints/release-manager.md"
    "operator B3b step deleted|sed -i.bak '/^### B3b\\. LIVE VERIFY/,/^### B4\\./{/^### B4\\./!d;}' blueprints/operator.md"
    "operator plan template drops Live verification|sed -i.bak '/^## Live verification (/d' blueprints/operator.md"
    "operator brief drops the ledger|sed -i.bak 's/VERIFICATION LEDGER (verbatim from B3b/LEDGER (optional/' blueprints/operator.md"
    "operator lets evidence_kind=live float|sed -i.bak 's/`evidence_kind=\"live\"` ONLY when B3b/`evidence_kind=\"live\"` when B3b/' blueprints/operator.md"
    "operator reviewer drops verified-by-construction|sed -i.bak 's/\"Verified by construction\" is a P1/\"Verified by construction\" is a P3/' blueprints/operator.md"
    "operator plan template allows mocked-only|sed -i.bak 's/\"Mocked only\" is not an option here/\"Mocked only\" is fine/' blueprints/operator.md"
    "operator ship-recovery loop drops B3b|sed -i.bak 's/B3b (live verify, the shared QA checklist)/B3 (verify again)/' blueprints/operator.md"
    "operator B7 lets the ledger be written from memory|sed -i.bak 's/\*\*Ledger source check\.\*\*/Ledger note./' blueprints/operator.md"
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
  self_test || { echo "" >&2; echo "QA-checklist guard SELF-TEST FAILED" >&2; exit 1; }
  exit 0
fi

if ! run_checks "."; then
  echo "" >&2
  echo "QA-checklist parity guard FAILED (scripts/check-qa-checklist-parity.sh)" >&2
  exit 1
fi

echo "QA-checklist parity guard: OK"
echo "  checklist = $CHECKLIST carries ${#CHECKLIST_MUST_HAVE[@]} mandatory elements"
echo "  loaders   = ${LOADERS[*]} call $LOAD_CALL"
echo "  personas  = $(persona_blueprints | wc -l | tr -d ' ') blueprints checked for re-inlined rules"
