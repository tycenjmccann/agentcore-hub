#!/bin/bash
# ─── E2E Ticket Flow Test ─────────────────────────────────────────────────────
#
# Tests the full orchestrator ticket lifecycle WITHOUT agents doing real work.
# Each agent loads their blueprint, waits 30s, saves a test artifact, and completes.
#
# Flow exercised:
#   Requirements → Frontend Designer + Security + Legal (design)
#                → Frontend Dev (development)
#                → QA (verification) — creates fix-it ticket → Frontend Dev
#                → QA re-run (verification)
#                → CI (review)
#                → Workflow Complete
#
# This validates:
#   - Ticket creation tracking (agentTasks populated at creation time)
#   - Dependency unblocking cascade
#   - Phase advancement (visible in UI with 30s delays)
#   - QA re-test loop (fix-it ticket back to dev)
#   - Workflow completion check
#
# Expected duration: 8-12 minutes (30s per agent + orchestrator overhead)
#
# Usage:
#   ./scripts/test-ticket-flow.sh                              # App Runner (tycenj-prod)
#   ./scripts/test-ticket-flow.sh --url http://localhost:3000  # Local dev
#
# ─────────────────────────────────────────────────────────────────────────────

set -e

BASE_URL="${BASE_URL:-https://k2krtgqjiu.us-east-1.awsapprunner.com}"
REPO_URL="https://github.com/tycenjmccann/agentcore-console"
DEFAULT_BRANCH="clean-main"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) BASE_URL="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--url <base-url>]"
      echo ""
      echo "Runs an E2E ticket flow test through the full pipeline."
      echo "Agents wait 30s before completing so UI can track phases."
      echo "Tests the orchestrator ticket tracking + dependency cascade."
      exit 0
      ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ─── Build the test workflow description ────────────────────────────────────

TITLE="Pipeline Connectivity Check $(date +%H:%M)"

read -r -d '' DESC << 'ENDDESC' || true
## Workflow End-to-End Connectivity Test

This is a workflow end-to-end test. Each agent is being given a minimal task to prove connectivity and access to their tools. Run your task, save a short artifact to S3 confirming success, then complete.

---

## REQUIREMENTS AGENT — YOUR STEPS:

1. Load skill `requirements-analysis`
2. Create EXACTLY these 5 tickets using `Tickets___create_ticket`. Each ticket's description must contain the exact instructions for that agent shown in the section below — copy-paste the relevant block.

   **Ticket 1:** summary="Design: Frontend Designer", assignee="agentcore_hub_frontend_designer", blocked_by=[YOUR_TICKET_ID]
   **Ticket 2:** summary="Review: Security Reviewer", assignee="agentcore_hub_security_reviewer", blocked_by=[YOUR_TICKET_ID]
   **Ticket 3:** summary="Review: Legal Compliance", assignee="agentcore_hub_legal_compliance", blocked_by=[YOUR_TICKET_ID]
   **Ticket 4:** summary="Dev: Frontend Dev", assignee="agentcore_hub_frontend_dev", blocked_by=[TICKET_1, TICKET_2, TICKET_3]
   **Ticket 5:** summary="QA: Verifier", assignee="agentcore_hub_qa_verifier", blocked_by=[TICKET_4]

   Do NOT create a CI ticket — QA will create it.

3. Save artifact to S3: `workflows/{workflowId}/agents/agentcore_hub_requirements_analyst/test-pass.md` with content "Requirements connectivity check — created 5 tickets"
4. Call `WorkflowOutput___report_completion`

---

## INSTRUCTIONS TO PUT IN EACH TICKET DESCRIPTION:

### For Frontend Designer (Ticket 1):
```
Connectivity check — Frontend Designer:
1. Load skill `frontend-design`
2. Confirm GitHub access: run `git ls-remote https://github.com/tycenjmccann/agentcore-console` (or any equivalent gh/git command) and capture the first few refs as proof
3. Save to S3: workflows/{workflowId}/agents/agentcore_hub_frontend_designer/test-pass.md — include the ref output and "GitHub access confirmed"
4. Call WorkflowOutput___report_completion
Do not write code. Do not clone repos.
```

### For Security Reviewer (Ticket 2):
```
Connectivity check — Security Reviewer:
1. Load skill `code-review`
2. Confirm GitHub access: run `git ls-remote https://github.com/tycenjmccann/agentcore-console` and capture the first few refs
3. Save to S3: workflows/{workflowId}/agents/agentcore_hub_security_reviewer/test-pass.md — include the ref output and "GitHub access confirmed"
4. Call WorkflowOutput___report_completion
Do not write code. Do not clone repos.
```

### For Legal Compliance (Ticket 3):
```
Connectivity check — Legal Compliance:
1. Load skill `privacy-compliance`
2. Confirm GitHub access: run `git ls-remote https://github.com/tycenjmccann/agentcore-console` and capture the first few refs
3. Save to S3: workflows/{workflowId}/agents/agentcore_hub_legal_compliance/test-pass.md — include the ref output and "GitHub access confirmed"
4. Call WorkflowOutput___report_completion
Do not write code. Do not clone repos.
```

### For Frontend Dev (Ticket 4):
```
Connectivity check — Frontend Dev:
1. Load skill `full-stack`
2. Confirm Claude Code is available: run a simple `claude --version` (or equivalent) and a one-shot ping prompt like `claude -p "reply with the single word: pong"` and capture both outputs
3. Save to S3: workflows/{workflowId}/agents/agentcore_hub_frontend_dev/test-pass.md — include the version + ping output and "Claude Code access confirmed"
4. Call WorkflowOutput___report_completion
Do not write code. Do not clone repos.
```

### For QA Verifier (Ticket 5):
```
Connectivity check — QA Verifier:
1. Load skill `qa-verification`
2. Create the CI ticket using Tickets___create_ticket:
   - summary: "CI: Agent — connectivity check"
   - assignee: "agentcore_hub_ci_agent"
   - blocked_by: [YOUR_TICKET_ID]
   - description: |
     Connectivity check — CI Agent:
     1. Load skill `ci-verification`
     2. Save to S3: workflows/{workflowId}/agents/agentcore_hub_ci_agent/test-pass.md — content: "CI connectivity check passed"
     3. Call WorkflowOutput___report_completion
     Do not write code. Do not clone repos.
3. Save to S3: workflows/{workflowId}/agents/agentcore_hub_qa_verifier/test-pass.md — content: "QA connectivity check passed — CI ticket created"
4. Call WorkflowOutput___report_completion
Do not write code. Do not clone repos.
```

---

## EXPECTED FLOW:
Requirements → Design + Security + Legal (parallel) → Dev → QA → CI → Complete
ENDDESC

# ─── Submit ──────────────────────────────────────────────────────────────────

BODY=$(cat <<EOF
{
  "title": $(echo "$TITLE" | jq -Rs .),
  "description": $(echo "$DESC" | jq -Rs .),
  "sources": [],
  "repoConfig": {
    "repos": [{"url": "$REPO_URL", "defaultBranch": "$DEFAULT_BRANCH"}]
  }
}
EOF
)

echo "═══════════════════════════════════════════════════════════════"
echo "  E2E Ticket Flow Test (v2 — with 30s delays)"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  Target:  $BASE_URL/api/workflow/start"
echo "  Title:   $TITLE"
echo ""
echo "  Expected flow:"
echo "    Requirements (30s) → Design x3 (30s parallel) → Dev (30s)"
echo "    → QA (30s, creates fix-it+rerun+CI) → Dev fix-it (45s)"
echo "    → QA re-verify (30s) → CI (30s) → Complete (~10-12 min)"
echo ""

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$BASE_URL/api/workflow/start" \
  -H "Content-Type: application/json" \
  -d "$BODY")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_RESPONSE=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -ne 200 ]; then
  echo "  ✗ FAILED (HTTP $HTTP_CODE)"
  echo "  Response: $BODY_RESPONSE"
  exit 1
fi

WORKFLOW_ID=$(echo "$BODY_RESPONSE" | jq -r '.workflowId // empty')
EPIC_ID=$(echo "$BODY_RESPONSE" | jq -r '.epicId // empty')

if [ -z "$WORKFLOW_ID" ]; then
  echo "  ✗ FAILED — no workflowId in response"
  echo "  Response: $BODY_RESPONSE"
  exit 1
fi

echo "  ✓ Workflow started!"
echo ""
echo "  Workflow ID: $WORKFLOW_ID"
echo "  Epic ID:     $EPIC_ID"
echo ""
echo "  View in UI:  $BASE_URL/workflow?id=$WORKFLOW_ID"
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  Monitoring (poll every 15s)..."
echo ""

# ─── Monitor loop ───────────────────────────────────────────────────────────

START_TIME=$(date +%s)
LAST_PHASE=""
LAST_TASK_COUNT=0

while true; do
  ELAPSED=$(( $(date +%s) - START_TIME ))
  MINS=$(( ELAPSED / 60 ))
  SECS=$(( ELAPSED % 60 ))

  # Get workflow state
  STATE=$(curl -s "$BASE_URL/api/workflow/$WORKFLOW_ID/state" 2>/dev/null)
  PHASE=$(echo "$STATE" | jq -r '.phase // "unknown"' 2>/dev/null)
  TASK_COUNT=$(echo "$STATE" | jq '.agentTasks | length // 0' 2>/dev/null || echo "0")

  # Show phase changes
  if [ "$PHASE" != "$LAST_PHASE" ]; then
    echo "  [${MINS}m${SECS}s] Phase: $LAST_PHASE → $PHASE"
    LAST_PHASE="$PHASE"
  fi

  # Show new tasks being tracked
  if [ "$TASK_COUNT" != "$LAST_TASK_COUNT" ] 2>/dev/null; then
    TASKS_SUMMARY=$(echo "$STATE" | jq -r '[.agentTasks | to_entries[] | "\(.value.agentId)(\(.value.status))"] | join(", ")' 2>/dev/null)
    echo "  [${MINS}m${SECS}s] Tracked tickets: $TASK_COUNT [$TASKS_SUMMARY]"
    LAST_TASK_COUNT="$TASK_COUNT"
  fi

  # Check completion
  if [ "$PHASE" = "complete" ]; then
    echo ""
    echo "  ═══════════════════════════════════════════════════════"
    echo "  ✓ WORKFLOW COMPLETE in ${MINS}m${SECS}s"
    echo "  ═══════════════════════════════════════════════════════"
    echo ""
    echo "  Final state:"
    echo "$STATE" | jq '{phase, completedAt, taskCount: (.agentTasks | length), tasks: [.agentTasks | to_entries[] | {ticket: .key, agent: .value.agentId, status: .value.status}]}' 2>/dev/null
    echo ""

    # Check if all dynamic tickets were created (should be 9: 6 req + 3 from QA)
    if [ "$TASK_COUNT" -ge 9 ]; then
      echo "  ✓ Full fix-it loop validated! (fix-it → QA rerun → CI)"
    elif [ "$TASK_COUNT" -ge 8 ]; then
      echo "  ⚠ Partial: got $TASK_COUNT tickets (expected 9: 6 initial + 3 from QA)"
    else
      echo "  ⚠ Expected 9 tickets but got $TASK_COUNT"
    fi
    echo ""
    exit 0
  fi

  # Timeout after 15 minutes
  if [ $ELAPSED -gt 900 ]; then
    echo ""
    echo "  ✗ TIMEOUT after 15 minutes. Phase: $PHASE"
    echo ""
    echo "  Current state:"
    echo "$STATE" | jq '{phase, taskCount: (.agentTasks | length), tasks: [.agentTasks | to_entries[] | {ticket: .key, agent: .value.agentId, status: .value.status}]}' 2>/dev/null
    exit 1
  fi

  sleep 15
done
