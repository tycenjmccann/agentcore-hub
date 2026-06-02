#!/bin/bash
# Run the full Playwright test suite
# Usage: ./tests/run-all.sh [--full]
#
# Without --full: runs UI tab tests only (fast, ~30s)
# With --full: also runs the end-to-end workflow test (slow, 5-10min)

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

echo "=== AgentCore Hub Playwright Test Suite ==="
echo ""

# Ensure test-results directory exists
mkdir -p test-results

# Step 1: Tab tests (fast)
echo "--- Running Tab Tests (UI validation) ---"
npx playwright test \
  tests/tab-dashboard.spec.ts \
  tests/tab-agents.spec.ts \
  tests/tab-build.spec.ts \
  tests/tab-workflow.spec.ts \
  tests/tab-tickets.spec.ts \
  --reporter=list

echo ""
echo "--- Tab tests complete ---"

# Step 2: Builder E2E — exercises /api/agentcore/builder against the real
# harness so IAM/role drift surfaces here instead of as a 500 in the UI.
echo ""
echo "--- Running Builder E2E ---"
npx playwright test tests/e2e-build-deploy-invoke.spec.ts --reporter=list

echo ""
echo "--- Builder e2e complete ---"

# Step 3: API smoke tests
echo ""
echo "--- Running API Route Tests ---"
npx playwright test tests/e2e-api-routes.spec.ts --reporter=list

echo ""
echo "--- API tests complete ---"

# Step 4: Full E2E (only with --full flag)
if [ "$1" = "--full" ]; then
  echo ""
  echo "--- Running Full E2E Workflow Test (this takes 5-10 minutes) ---"
  npx playwright test tests/e2e-workflow-full.spec.ts --timeout 600000 --reporter=list
  echo ""
  echo "--- E2E workflow test complete ---"
fi

echo ""
echo "=== All tests passed ==="
