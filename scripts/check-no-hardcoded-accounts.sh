#!/usr/bin/env bash
# ─── Hardcoded real-account guard ─────────────────────────────────────────────
#
# The repo is open source. CLAUDE.md forbids hardcoding account IDs, ARNs,
# bucket names or usernames — config.sh derives the account from STS at runtime,
# and every deploy path uses env/derived values. Real account IDs still leaked
# into test fixtures + a doc + source comments via autonomous-pipeline PRs
# (#371, #395, #535); this guard fails CI the moment either real account id
# reappears in a tracked file, in any form (bare id, ARN, or S3 bucket name —
# all embed the account id, so the id is the single anchor to grep). The ids
# themselves come from the REAL_ACCOUNT_IDS environment variable, never this file.
#
# Placeholders to use instead: 123456789012 (AWS-docs standard) and 210987654321
# (kept distinct so cross-account tests stay distinguishable).
set -euo pipefail
cd "$(dirname "$0")/.."

# The real account ids this project touches live OUTSIDE the repo: CI supplies
# them as the REAL_ACCOUNT_IDS secret (pipe-separated, e.g. 111111111111|222222222222);
# locally, export the same variable (deploy/config.sh knows the hub account).
# Listing them here would publish the very ids the guard exists to keep out.
BAD="${REAL_ACCOUNT_IDS:-}"
if [ -z "$BAD" ]; then
  echo "SKIP: REAL_ACCOUNT_IDS is unset - nothing to grep for (set it in CI secrets or your shell)."
  exit 0
fi

# Scan tracked files only, skipping binary PNGs. .local-workspace/ is gitignored,
# so git grep never sees it.
if git grep -nE "$BAD" -- . ':(exclude)*.png'; then
  echo "" >&2
  echo "FAIL: a real AWS account id is hardcoded above." >&2
  echo "      Never commit real account ids/ARNs/buckets — use 123456789012 or 210987654321." >&2
  exit 1
fi
echo "OK: no real AWS account ids in tracked files."
