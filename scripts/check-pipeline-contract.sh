#!/usr/bin/env bash
# ─── Pipeline arg contract guard (TEAM-4563 / TEAM-4579) ──────────────────────
#
# The CodeBuild projects and CodePipeline actions in deploy/pipeline/lib/
# pipeline-stack.ts PROVIDE env vars; the buildspecs CONSUME them. PR #576 made
# buildspec-deploy.yml and buildspec-runtime-images.yml read DEPLOY_PREAPPROVED,
# provided by the stack SOURCE as an action-level #{BuildVars.DEPLOY_PREAPPROVED}.
# Source and buildspec agreed - but ./deploy/pipeline/deploy.sh is a HANDOFF and
# had not run, CodePipeline resolved the unknown variable to "", and every main
# deploy failed at PRE_BUILD until a human redeployed the stack and PR #579 made
# the gate tolerate empty.
#
# A contract generated from the stack would have passed #576. So
# deploy/pipeline/pipeline-contract.json is a DECLARED list a human advances when
# the deployed pipeline actually provides an arg, and the guard is asymmetric:
# a contract entry must exist in stack source (the contract cannot invent an
# arg), but a stack-source arg missing from the contract is "declared, not yet
# confirmed deployed" and any buildspec reading it fails here. Same pass shape as
# scripts/check-deploy-surfaces.sh (bash -> python3, stdlib only, no AWS).
set -euo pipefail
cd "$(dirname "$0")/.."
python3 deploy/pipeline/check-pipeline-contract.py "$@"
