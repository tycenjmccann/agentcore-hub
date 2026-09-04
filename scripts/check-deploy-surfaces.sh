#!/usr/bin/env bash
# ─── Deploy-surface manifest guard ────────────────────────────────────────────
#
# The pipeline's Deploy stage deploys exactly what deploy/pipeline/surfaces.json
# lists (plan-surfaces.py turns changed files into LAMBDA / S3 / HARNESS /
# HANDOFF actions). A Lambda dir or deploy script that is NOT in the manifest is
# invisible to the pipeline and drifts behind main until someone notices — the
# 2026-09-04 audit found eight surfaces 1-7 days behind for exactly that reason.
#
# This gate fails CI when any tracked file under lambda/ or deploy/ is covered by
# no manifest entry: add it as a surface, list it under `handoff` (infra script a
# human runs), or add it to `excluded` with a reason.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 deploy/pipeline/plan-surfaces.py --check
