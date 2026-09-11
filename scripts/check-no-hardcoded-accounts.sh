#!/usr/bin/env bash
# ─── Hardcoded real-account guard ─────────────────────────────────────────────
#
# The repo is open source. CLAUDE.md forbids hardcoding account IDs, ARNs,
# bucket names or usernames — config.sh derives the account from STS at runtime,
# and every deploy path uses env/derived values. Real account IDs still leaked
# into test fixtures + a doc + source comments via autonomous-pipeline PRs
# (#371, #395, #535); this guard fails CI the moment either real account id
# reappears in a tracked file, in any form (bare id, ARN, or S3 bucket name —
# all embed the account id, so the id is the single anchor to grep).
#
# Placeholders to use instead: 123456789012 (AWS-docs standard) and 210987654321
# (kept distinct so cross-account tests stay distinguishable).
set -euo pipefail
cd "$(dirname "$0")/.."

# The two real accounts this project touches: the hub's prod account and juno's.
BAD='023392223961|838829463875'

# Scan tracked files only. Exclude this script (it must name the ids to grep
# them) and binary PNGs. .local-workspace/ is gitignored, so git grep skips it.
if git grep -nE "$BAD" -- . ':(exclude)scripts/check-no-hardcoded-accounts.sh' ':(exclude)*.png'; then
  echo "" >&2
  echo "FAIL: a real AWS account id is hardcoded above." >&2
  echo "      Never commit real account ids/ARNs/buckets — use 123456789012 or 210987654321." >&2
  exit 1
fi
echo "OK: no real AWS account ids in tracked files."
