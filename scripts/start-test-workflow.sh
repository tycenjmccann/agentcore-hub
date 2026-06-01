#!/bin/bash
# ─── Start Test Workflow ─────────────────────────────────────────────────────
#
# Submits a workflow via the /api/workflow/start endpoint.
# This is the ONLY correct way to start a workflow — it ensures:
#   - Workflow metadata in agentcore-hub-workflows has all required fields (startedAt, etc.)
#   - Epic + requirements ticket created in agentcore-hub-tickets
#   - DynamoDB Stream fires → orchestrator Lambda invokes agents
#
# Usage:
#   ./scripts/start-test-workflow.sh                     # Default test scope
#   ./scripts/start-test-workflow.sh --title "My feature" --desc "Details here"
#   ./scripts/start-test-workflow.sh --scope sidebar     # Pre-defined scope
#   ./scripts/start-test-workflow.sh --scope minimal     # Smallest possible test
#
# Requirements:
#   - Next.js dev server running on localhost:3000 (or set BASE_URL)
#   - AWS credentials configured (DynamoDB access)
#
# ─────────────────────────────────────────────────────────────────────────────

set -e

BASE_URL="${BASE_URL:-http://localhost:3000}"
REPO_URL="${REPO_URL:-${TEST_REPO_URL:-https://github.com/octocat/Hello-World}}"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"

# ─── Parse args ──────────────────────────────────────────────────────────────

TITLE=""
DESC=""
SCOPE=""
MODEL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title) TITLE="$2"; shift 2 ;;
    --desc|--description) DESC="$2"; shift 2 ;;
    --scope) SCOPE="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --url) BASE_URL="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--title <title>] [--desc <description>] [--scope <name>] [--model <model>]"
      echo ""
      echo "Scopes:"
      echo "  minimal   - Single-file change (fastest, ~5 min)"
      echo "  sidebar   - Collapsible sidebar feature (medium, ~20 min)"
      echo "  full      - Multi-component feature (longest, ~30 min)"
      echo ""
      echo "Models: sonnet (default), opus"
      exit 0
      ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ─── Pre-defined scopes ──────────────────────────────────────────────────────

case "${SCOPE:-}" in
  minimal)
    TITLE="${TITLE:-[TEST] Add /health endpoint}"
    DESC="${DESC:-Add a health check endpoint at src/app/api/health/route.ts that returns {status: \"ok\", timestamp: ISO string, uptime: process.uptime()}. Single file, no dependencies.}"
    ;;
  sidebar)
    TITLE="${TITLE:-Collapsible Sidebar Navigation}"
    DESC="${DESC:-Add collapse/expand functionality to the existing sidebar navigation component.

## Current State
- Sidebar is at src/components/layout/Sidebar.tsx (60 lines, simple nav list)
- Layout is at src/app/layout.tsx — sidebar is fixed w-64, main content uses ml-64
- Sidebar uses lucide-react icons and the cn() utility from @/lib/utils
- Styling uses CSS variables: --color-text-primary, --color-text-muted, --color-text-secondary, surface-1 through surface-4, brand-600/400
- The app uses Next.js 15 App Router with a ThemeProvider context

## Requirements (ONLY these — nothing else)
1. Add a toggle button at the bottom of the sidebar (use ChevronLeft/ChevronRight from lucide-react)
2. Collapsed state: sidebar shrinks to w-16 (icons only), expanded state: w-64 (current behavior)
3. In collapsed mode, show tooltip on hover for each nav item (CSS-only tooltip, no library)
4. Persist collapse state in localStorage key 'sidebar-collapsed'
5. Main content area (ml-64 in layout.tsx) must adjust its left margin dynamically when sidebar collapses
6. Use transition-all duration-300 for smooth animation
7. Prevent layout flash on page load by reading localStorage in a script tag in <head>

## Implementation Constraints
- Create a SidebarContext (React context) in src/components/layout/sidebar/SidebarContext.tsx for collapse state
- Create a MainContent client component in src/components/layout/MainContent.tsx that reads context and sets margin
- Modify src/components/layout/Sidebar.tsx to use context and conditionally render labels
- Modify src/app/layout.tsx to wrap with SidebarProvider and use MainContent component
- Do NOT add new API calls, polling, or data fetching
- Do NOT add workflow history, agent status, or any other new sections to the sidebar
- Do NOT add quick action buttons or shortcut links
- Do NOT add new hooks (useAgentStatus, useWorkflowHistory, etc.)
- Do NOT create new API routes
- Keep the existing nav items exactly as they are (Dashboard, Agents, Build, Workflow, Ticket History)
- Total new code should be under 150 lines across all files}"
    ;;
  full)
    TITLE="${TITLE:-[TEST] Data Table with Sorting and Filtering}"
    DESC="${DESC:-Create a reusable data table component with:
- Column sorting (asc/desc toggle)
- Text search filtering across all columns
- Pagination (10/25/50 rows per page)
- Row selection with checkbox
- Export selected rows to CSV

Use it on the agents page to replace the current agent list.

Files to create: src/components/ui/DataTable.tsx, src/components/ui/DataTable.test.tsx
Files to modify: src/app/agents/page.tsx}"
    ;;
  "")
    # Default: use sidebar if no title/desc provided
    if [ -z "$TITLE" ] && [ -z "$DESC" ]; then
      TITLE="[TEST] Status Badge Component System"
      DESC="Create a reusable StatusBadge component that displays agent/ticket status with appropriate colors and icons. Support statuses: active, idle, error, complete, blocked, running. Use it on the dashboard agent table. Files to modify: src/app/page.tsx. Files to create: src/components/ui/StatusBadge.tsx"
    fi
    ;;
esac

# ─── Validate repo URL ───────────────────────────────────────────────────────

if [[ "$REPO_URL" == *"your-org"* || "$REPO_URL" == *"your-repo"* ]]; then
  echo "  ✗ ERROR: REPO_URL is still set to placeholder ($REPO_URL)"
  echo "  Set REPO_URL env var or use --repo <url>"
  exit 1
fi

OWNER_REPO=$(echo "$REPO_URL" | sed -E 's|https?://github\.com/||; s|\.git$||; s|/$||')
GITHUB_PAT="${GITHUB_PAT:-}"
AUTH_HEADER=""
[ -n "$GITHUB_PAT" ] && AUTH_HEADER="Authorization: token $GITHUB_PAT"

REPO_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  "https://api.github.com/repos/$OWNER_REPO" 2>/dev/null)

if [ "$REPO_STATUS" = "404" ]; then
  echo "  ✗ ERROR: Repository not found: $REPO_URL (HTTP 404)"
  echo "  Verify the URL exists and is accessible."
  exit 1
elif [ "$REPO_STATUS" = "200" ] || [ "$REPO_STATUS" = "401" ] || [ "$REPO_STATUS" = "403" ]; then
  echo "  ✓ Repo validated: $OWNER_REPO"
else
  echo "  ⚠ Repo check returned HTTP $REPO_STATUS — proceeding anyway"
fi

# ─── Build request body ──────────────────────────────────────────────────────

BODY=$(cat <<EOF
{
  "title": $(echo "$TITLE" | jq -Rs .),
  "description": $(echo "$DESC" | jq -Rs .),
  "sources": [],
  "repoConfig": {
    "repos": [{"url": "$REPO_URL", "defaultBranch": "$DEFAULT_BRANCH"}]
  }$([ -n "$MODEL" ] && echo ", \"modelOverride\": \"$MODEL\"")
}
EOF
)

# ─── Submit ──────────────────────────────────────────────────────────────────

echo "═══════════════════════════════════════════════════════"
echo "  Starting Test Workflow"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  Target:  $BASE_URL/api/workflow/start"
echo "  Title:   $TITLE"
echo "  Repo:    $REPO_URL"
[ -n "$MODEL" ] && echo "  Model:   $MODEL"
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
echo "  Monitor:"
echo "    curl -s $BASE_URL/api/workflow/$WORKFLOW_ID/state | jq .phase"
echo ""
echo "═══════════════════════════════════════════════════════"
