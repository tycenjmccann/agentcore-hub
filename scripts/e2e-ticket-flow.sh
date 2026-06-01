#!/usr/bin/env bash
#
# E2E Ticket Flow Test — DAG + Roster Validation
#
# Submits a lightweight workflow that validates the full orchestrator pipeline:
#   Requirements (30s) → 3 Design agents parallel (30s) → Dev (30s)
#   → QA (creates fix-it loop) → Dev fix-it (45s) → QA re-verify (30s) → CI (30s)
#
# Total runtime: ~6-12 minutes
# No real code is written — agents just load blueprints, wait, save artifacts, and advance.
#
# Usage:
#   ./scripts/e2e-ticket-flow.sh                          # runs against localhost:3000
#   ./scripts/e2e-ticket-flow.sh https://your-app.com     # runs against custom URL
#

set -euo pipefail

BASE_URL="${1:-${DEPLOYMENT_URL:-http://localhost:3000}}"
REPO_URL="${REPO_URL:-${TEST_REPO_URL:-https://github.com/octocat/Hello-World}}"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"

echo "▶ Submitting E2E Ticket Flow test to ${BASE_URL}..."

PAYLOAD=$(cat <<'PAYLOAD_EOF'
{
  "title": "[E2E-TEST] Ticket Flow — DAG + Roster Validation",
  "description": "## E2E TICKET FLOW TEST — ORCHESTRATOR VALIDATION\n\n**THIS IS AN AUTOMATED TEST. DO NOT WRITE ANY REAL CODE.**\n\nThe purpose of this test is to validate the orchestrator's ticket tracking, phase transitions, and dependency cascade. Each agent MUST follow their specific steps below EXACTLY.\n\n---\n\n## REQUIREMENTS AGENT — YOUR EXACT STEPS:\n\n1. Call `SkillLoader___load_skill(skill_name=\"requirements-analysis\")` to load your blueprint\n2. Wait 30 seconds (use `current_time` tool, then wait, then check time again — or simply take your time writing a thorough test artifact)\n3. Create EXACTLY these 5 tickets using `Tickets___create_ticket` (NOTE: do NOT create a CI ticket — QA will create it later):\n\n   **Ticket 1:** summary=\"[E2E] Design: Frontend Designer\", assignee=\"agentcore_hub_frontend_designer\", blocked_by=[YOUR_TICKET_ID]\n   **Ticket 2:** summary=\"[E2E] Review: Security Reviewer\", assignee=\"agentcore_hub_security_reviewer\", blocked_by=[YOUR_TICKET_ID]\n   **Ticket 3:** summary=\"[E2E] Review: Legal Compliance\", assignee=\"agentcore_hub_legal_compliance\", blocked_by=[YOUR_TICKET_ID]\n   **Ticket 4:** summary=\"[E2E] Dev: Frontend Dev\", assignee=\"agentcore_hub_frontend_dev\", blocked_by=[TICKET_1, TICKET_2, TICKET_3]\n   **Ticket 5:** summary=\"[E2E] QA: Verifier — CREATES FIX-IT + RE-RUN + CI\", assignee=\"agentcore_hub_qa_verifier\", blocked_by=[TICKET_4]\n\n   DO NOT CREATE A CI TICKET. The QA agent will create the CI ticket blocked by its own re-run ticket.\n\n   IMPORTANT for each ticket description, include these exact instructions for that agent (copy-paste the relevant section below into the ticket description).\n\n4. Save artifact to S3: `workflows/{workflowId}/agents/agentcore_hub_requirements_analyst/test-pass.md` with content \"Requirements complete — created 5 tickets for E2E flow test (CI will be created by QA)\"\n5. Call `WorkflowOutput___report_completion`\n\n---\n\n## INSTRUCTIONS TO PUT IN EACH TICKET DESCRIPTION:\n\n### For Frontend Designer (Ticket 1):\n```\nE2E TEST — Frontend Designer steps:\n1. Call SkillLoader___load_skill(skill_name=\"frontend-design\") to load blueprint\n2. Wait 30 seconds before completing (write a detailed test artifact to use the time)\n3. Save to S3: workflows/{workflowId}/agents/agentcore_hub_frontend_designer/test-pass.md — content: \"Frontend Designer E2E pass — blueprint loaded, 30s timer elapsed, design phase validated\"\n4. Call WorkflowOutput___report_completion\nDO NOT write code. DO NOT clone repos. Just follow these 4 steps.\n```\n\n### For Security Reviewer (Ticket 2):\n```\nE2E TEST — Security Reviewer steps:\n1. Call SkillLoader___load_skill(skill_name=\"code-review\") to load blueprint\n2. Wait 30 seconds before completing (write a detailed test artifact to use the time)\n3. Save to S3: workflows/{workflowId}/agents/agentcore_hub_security_reviewer/test-pass.md — content: \"Security Reviewer E2E pass — blueprint loaded, 30s timer elapsed, review phase validated\"\n4. Call WorkflowOutput___report_completion\nDO NOT write code. DO NOT clone repos. Just follow these 4 steps.\n```\n\n### For Legal Compliance (Ticket 3):\n```\nE2E TEST — Legal Compliance steps:\n1. Call SkillLoader___load_skill(skill_name=\"privacy-compliance\") to load blueprint\n2. Wait 30 seconds before completing (write a detailed test artifact to use the time)\n3. Save to S3: workflows/{workflowId}/agents/agentcore_hub_legal_compliance/test-pass.md — content: \"Legal Compliance E2E pass — blueprint loaded, 30s timer elapsed, review phase validated\"\n4. Call WorkflowOutput___report_completion\nDO NOT write code. DO NOT clone repos. Just follow these 4 steps.\n```\n\n### For Frontend Dev (Ticket 4):\n```\nE2E TEST — Frontend Dev steps:\n1. Call SkillLoader___load_skill(skill_name=\"full-stack\") to load blueprint\n2. Wait 30 seconds before completing (write a detailed test artifact to use the time)\n3. Save to S3: workflows/{workflowId}/agents/agentcore_hub_frontend_dev/test-pass.md — content: \"Frontend Dev E2E pass — blueprint loaded, 30s timer elapsed, dev phase validated\"\n4. Call WorkflowOutput___report_completion\nDO NOT write code. DO NOT clone repos. Just follow these 4 steps.\nNOTE: You may be invoked a second time for a \"fix-it\" ticket from QA. Same steps apply — just save artifact with \"fix-it pass\" and complete.\n```\n\n### For QA Verifier (Ticket 5) — CRITICAL:\n```\nE2E TEST — QA Verifier steps — READ CAREFULLY:\n\nYou must create THREE tickets before completing. This tests the full QA fix-it loop.\n\n1. Call SkillLoader___load_skill(skill_name=\"qa-verification\") to load blueprint\n2. Wait 30 seconds (write a detailed test artifact to use the time)\n3. Create THREE tickets in this EXACT order using Tickets___create_ticket:\n\n   TICKET A — Fix-it for Dev (no blockers, invoked immediately):\n   - summary: \"[E2E] Fix-it: Frontend Dev — QA found simulated issue\"\n   - assignee: \"agentcore_hub_frontend_dev\"\n   - blocked_by: [] (empty — no blockers)\n   - description: \"E2E TEST — Frontend Dev fix-it steps:\n1. Call SkillLoader___load_skill(skill_name=\\\"full-stack\\\")\n2. Wait 45 seconds\n3. Save to S3: workflows/{workflowId}/agents/agentcore_hub_frontend_dev/fix-it-pass.md with content: Frontend Dev fix-it E2E pass — issue resolved\n4. Call WorkflowOutput___report_completion\nDO NOT write code. Just follow these steps.\"\n\n   TICKET B — QA Re-verification (blocked by the fix-it ticket):\n   - summary: \"[E2E] QA Re-verify: Verifier — confirm fix\"\n   - assignee: \"agentcore_hub_qa_verifier\"\n   - blocked_by: [TICKET_A_ID] (blocked by the fix-it ticket you just created)\n   - description: \"E2E TEST — QA Re-verification steps:\n1. Call SkillLoader___load_skill(skill_name=\\\"qa-verification\\\")\n2. Wait 30 seconds\n3. Save to S3: workflows/{workflowId}/agents/agentcore_hub_qa_verifier/rerun-pass.md with content: QA re-verification E2E pass — fix confirmed\n4. Call WorkflowOutput___report_completion\nDO NOT write code. DO NOT create any more tickets. Just verify and complete.\"\n\n   TICKET C — CI Agent (blocked by QA re-verification):\n   - summary: \"[E2E] CI: Agent — final validation\"\n   - assignee: \"agentcore_hub_ci_agent\"\n   - blocked_by: [TICKET_B_ID] (blocked by the QA re-verification ticket)\n   - description: \"E2E TEST — CI Agent steps:\n1. Call SkillLoader___load_skill(skill_name=\\\"ci-verification\\\")\n2. Wait 30 seconds\n3. Save to S3: workflows/{workflowId}/agents/agentcore_hub_ci_agent/test-pass.md with content: CI Agent E2E pass — pipeline validation complete\n4. Call WorkflowOutput___report_completion\nDO NOT write code. Just follow these steps.\"\n\n4. After creating all 3 tickets, save to S3: workflows/{workflowId}/agents/agentcore_hub_qa_verifier/test-pass.md — content: \"QA Verifier E2E pass — created fix-it + re-run + CI tickets\"\n5. Call WorkflowOutput___report_completion\n\nYOU MUST CREATE ALL 3 TICKETS (A, B, C) IN ORDER. The blocking chain must be: A (no blockers) → B (blocked by A) → C (blocked by B). This is the entire point of this test.\n```\n\n---\n\n## SUMMARY OF EXPECTED FLOW:\nRequirements (30s) → Design: 3 agents parallel (30s each) → Dev (30s) → QA (30s, creates 3 tickets) → Dev fix-it (45s) → QA re-verify (30s) → CI (30s) → Complete\n\nThe key test: QA creates a fix-it → dev → QA re-run → CI chain. This validates dynamic ticket creation with proper blocking dependencies.\n\nTotal expected time: ~10-12 minutes",
  "sources": [],
  "repoConfig": {
    "repos": [{"url": "__REPO_URL__", "defaultBranch": "__DEFAULT_BRANCH__"}]
  }
}
PAYLOAD_EOF
)

PAYLOAD="${PAYLOAD//__REPO_URL__/$REPO_URL}"
PAYLOAD="${PAYLOAD//__DEFAULT_BRANCH__/$DEFAULT_BRANCH}"

RESPONSE=$(curl -s -X POST "${BASE_URL}/api/workflow/start" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

# Parse response
WORKFLOW_ID=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('workflowId',''))" 2>/dev/null)
EPIC_ID=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('epicId',''))" 2>/dev/null)
ERROR=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error',''))" 2>/dev/null)

if [ -n "$ERROR" ] && [ "$ERROR" != "" ]; then
  echo "✗ Failed to start workflow: $ERROR"
  exit 1
fi

echo "✓ Workflow started: $WORKFLOW_ID (epic: $EPIC_ID)"
echo ""
echo "  Monitor: ${BASE_URL}/workflow?id=${WORKFLOW_ID}"
echo ""

# Poll for completion
echo "▶ Polling for completion (timeout: 15 min)..."
START_TIME=$(date +%s)
TIMEOUT=900  # 15 minutes

while true; do
  ELAPSED=$(( $(date +%s) - START_TIME ))
  if [ $ELAPSED -gt $TIMEOUT ]; then
    echo "✗ Timed out after ${TIMEOUT}s"
    exit 1
  fi

  STATE=$(curl -s "${BASE_URL}/api/workflow/${WORKFLOW_ID}/state" 2>/dev/null)
  PHASE=$(echo "$STATE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('phase',''))" 2>/dev/null)

  if [ "$PHASE" = "complete" ]; then
    DURATION=$(( $(date +%s) - START_TIME ))
    echo ""
    echo "✓ Workflow COMPLETE in ${DURATION}s"
    echo ""

    # Print agent summary
    echo "$STATE" | python3 -c "
import json, sys
d = json.load(sys.stdin)
tasks = d.get('agentTasks', {})
print('  Agent Results:')
for name, t in sorted(tasks.items(), key=lambda x: x[1].get('completedAt', '')):
    status = t.get('status', '?')
    icon = '✓' if status == 'complete' else '✗'
    print(f'    {icon} {name}: {status}')
print(f'')
print(f'  Total agents: {len(tasks)}')
complete = sum(1 for t in tasks.values() if t.get(\"status\") == \"complete\")
print(f'  Completed: {complete}/{len(tasks)}')
" 2>/dev/null
    exit 0
  fi

  # Show progress
  RUNNING=$(echo "$STATE" | python3 -c "
import json, sys
d = json.load(sys.stdin)
tasks = d.get('agentTasks', {})
running = [n for n, t in tasks.items() if t.get('status') == 'running']
complete = [n for n, t in tasks.items() if t.get('status') == 'complete']
print(f'[{ELAPSED}s] phase={d.get(\"phase\",\"?\")} running={len(running)} complete={len(complete)}', end='')
if running:
    print(f' ({', '.join(running)})', end='')
print()
" 2>/dev/null 2>&1 || echo "[${ELAPSED}s] waiting...")

  sleep 10
done
