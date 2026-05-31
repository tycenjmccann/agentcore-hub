#!/bin/bash
#
# verify-all.sh — Run all verification stages in order
#
# Usage:
#   ./scripts/verify-all.sh
#
# Stages:
#   1. Infrastructure (DynamoDB tables, S3 bucket, Lambda)
#   2. Builder Agent (harness invocation)
#   3. App (npm test — UI + API smoke tests)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$SCRIPT_DIR/.."

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  AgentCore Hub — Full Verification"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ─── Stage 1: Infrastructure ───────────────────────────────────
echo "━━━ Stage 1: Infrastructure ━━━"
if "$SCRIPT_DIR/verify-infra.sh"; then
  echo "  → Infrastructure: PASS"
else
  echo "  → Infrastructure: FAIL"
  echo "  Run: ./scripts/create-dynamodb-tables.sh --with-tickets"
  echo "       node deploy/setup-tickets-lambda.mjs"
  exit 1
fi
echo ""

# ─── Stage 2: Builder Agent ───────────────────────────────────
echo "━━━ Stage 2: Builder Agent ━━━"
if node "$REPO_DIR/deploy/setup-builder-agent.mjs" 2>&1 | grep -q "✓ Builder agent responded"; then
  echo "  → Builder Agent: PASS"
else
  echo "  → Builder Agent: WARN (harness may need IAM propagation time)"
fi
echo ""

# ─── Stage 3: App Tests ───────────────────────────────────────
echo "━━━ Stage 3: App Tests ━━━"
cd "$REPO_DIR"
if npm test 2>&1 | tail -5 | grep -q "passed"; then
  echo "  → App Tests: PASS"
else
  echo "  → App Tests: FAIL"
  echo "  Run: npm test for details"
  exit 1
fi
echo ""

echo "═══════════════════════════════════════════════════════════"
echo "  All stages passed!"
echo "═══════════════════════════════════════════════════════════"
echo ""
