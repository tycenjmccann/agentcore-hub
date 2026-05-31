#!/bin/bash
# ─── Trace Workflow ──────────────────────────────────────────────────────────
#
# Pulls all logs for a workflow run from CloudWatch + DynamoDB and produces
# a unified, time-ordered trace of every orchestration event.
#
# Usage:
#   ./scripts/trace-workflow.sh <workflow_id>
#   ./scripts/trace-workflow.sh wf_1779511526188_dvjiwq
#   ./scripts/trace-workflow.sh wf_1779511526188_dvjiwq --hours 2
#   ./scripts/trace-workflow.sh wf_1779511526188_dvjiwq --verbose
#
# Output:
#   1. Ticket creation timeline (ticket tools Lambda)
#   2. Webhook events received (orchestrator Lambda)
#   3. Agent invocations (orchestrator Lambda)
#   4. Agent completions (workflow-output Lambda)
#   5. Cascade unblocks (orchestrator Lambda)
#   6. Full unified timeline (all sources merged by timestamp)
#
# Requirements:
#   - AWS CLI v2 configured with appropriate profile
#   - jq installed
#
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────

export AWS_PROFILE="${AWS_PROFILE:?ERROR: Set AWS_PROFILE}"
REGION="${AWS_REGION:-us-east-1}"

# Log groups
LOG_ORCHESTRATOR="/aws/lambda/agentcore-hub-orchestrator"
LOG_TICKET_TOOLS="/aws/lambda/${TICKET_TOOLS_LAMBDA:-agentcore-hub-tickets}"
LOG_WORKFLOW_OUTPUT="/aws/lambda/agentcore-hub-workflow-output"
LOG_AGENT_INVOKER="/aws/lambda/agentcore-hub-agent-invoker"

# DynamoDB tables
TABLE_EVENTS="agentcore-hub-events"
TABLE_TICKETS="agentcore-hub-tickets"
TABLE_WORKFLOWS="agentcore-hub-workflows"

# Defaults
HOURS=4
VERBOSE=false
OUTPUT_DIR=""

# ─── Parse args ──────────────────────────────────────────────────────────────

if [ $# -lt 1 ]; then
  echo "Usage: $0 <workflow_id> [--hours N] [--verbose] [--output DIR]"
  echo ""
  echo "Examples:"
  echo "  $0 wf_1779511526188_dvjiwq"
  echo "  $0 wf_1779511526188_dvjiwq --hours 6 --verbose"
  exit 1
fi

WORKFLOW_ID="$1"
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hours) HOURS="$2"; shift 2 ;;
    --verbose) VERBOSE=true; shift ;;
    --output) OUTPUT_DIR="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ─── Setup ───────────────────────────────────────────────────────────────────

if [ -n "$OUTPUT_DIR" ]; then
  mkdir -p "$OUTPUT_DIR"
else
  OUTPUT_DIR=$(mktemp -d)
fi

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  WORKFLOW TRACE: $WORKFLOW_ID"
echo "║  Time window: last ${HOURS}h"
echo "║  Output dir: $OUTPUT_DIR"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Time range for CloudWatch queries (milliseconds)
NOW_MS=$(date +%s000)
START_MS=$(( $(date +%s) - HOURS * 3600 ))000

# ─── Step 1: Get workflow metadata from DDB ──────────────────────────────────

echo "─── Step 1: Workflow Metadata ───────────────────────────────────"

WORKFLOW_META=$(aws dynamodb get-item \
  --region "$REGION" \
  --table-name "$TABLE_WORKFLOWS" \
  --key "{\"workflowId\":{\"S\":\"$WORKFLOW_ID\"}}" \
  --output json 2>/dev/null || echo "{}")

if echo "$WORKFLOW_META" | jq -e '.Item' > /dev/null 2>&1; then
  EPIC_ID=$(echo "$WORKFLOW_META" | jq -r '.Item.epicId.S // "N/A"')
  STARTED_AT=$(echo "$WORKFLOW_META" | jq -r '.Item.startedAt.S // .Item.startedAt.N // "N/A"')
  STATUS=$(echo "$WORKFLOW_META" | jq -r '.Item.phase.S // .Item.status.S // "N/A"')
  TICKET_PROVIDER=$(echo "$WORKFLOW_META" | jq -r '.Item.ticketProvider.S // "N/A"')
  echo "  Epic: $EPIC_ID"
  echo "  Started: $STARTED_AT"
  echo "  Phase: $STATUS"
  echo "  Ticket Provider: $TICKET_PROVIDER"

  # If we have startedAt as ISO string, convert to epoch ms
  if [ "$STARTED_AT" != "N/A" ]; then
    if [[ "$STARTED_AT" =~ ^[0-9]+$ ]]; then
      START_MS="$STARTED_AT"
    else
      # ISO 8601 string — convert to epoch ms
      EPOCH_S=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${STARTED_AT%%.*}" +%s 2>/dev/null || echo "")
      if [ -n "$EPOCH_S" ]; then
        START_MS="${EPOCH_S}000"
      fi
    fi
  fi
else
  echo "  WARNING: Workflow not found in DDB. Using full time window."
  EPIC_ID=""
fi

echo ""

# ─── Step 2: Get all tickets for this workflow from DDB ──────────────────────

echo "─── Step 2: Tickets for this Workflow ────────────────────────────"

# Query events table to find ticket IDs associated with this workflow
EVENTS_RAW=$(aws dynamodb query \
  --region "$REGION" \
  --table-name "$TABLE_EVENTS" \
  --key-condition-expression "workflowId = :wf" \
  --expression-attribute-values "{\":wf\":{\"S\":\"$WORKFLOW_ID\"}}" \
  --output json 2>/dev/null || echo '{"Items":[]}')

# Extract unique ticket IDs from events (ticketId may be top-level or in detail.M)
TICKET_IDS=$(echo "$EVENTS_RAW" | jq -r '[.Items[] | (.ticketId.S // .detail.M.ticketId.S // empty)] | unique | .[]' 2>/dev/null)

if [ -z "$TICKET_IDS" ]; then
  echo "  No tickets found in events table. Trying tickets table scan..."
  # Fallback: scan tickets table for this workflowId
  TICKETS_RAW=$(aws dynamodb scan \
    --region "$REGION" \
    --table-name "$TABLE_TICKETS" \
    --filter-expression "workflowId = :wf" \
    --expression-attribute-values "{\":wf\":{\"S\":\"$WORKFLOW_ID\"}}" \
    --output json 2>/dev/null || echo '{"Items":[]}')
  TICKET_IDS=$(echo "$TICKETS_RAW" | jq -r '[.Items[].id.S // empty] | unique | .[]' 2>/dev/null)
fi

TICKET_COUNT=$(echo "$TICKET_IDS" | grep -c . || echo 0)
echo "  Found $TICKET_COUNT tickets:"
echo "$TICKET_IDS" | while read -r tid; do
  [ -n "$tid" ] && echo "    - $tid"
done

# Save ticket IDs for log filtering
echo "$TICKET_IDS" > "$OUTPUT_DIR/ticket_ids.txt"
echo ""

# ─── Step 3: Build filter pattern for CloudWatch ─────────────────────────────

# Build a filter pattern that matches any of our ticket IDs
# CloudWatch filter patterns don't support OR well, so we query per-ticket
# But we can search for the workflow ID directly in orchestrator logs

echo "─── Step 3: Pulling CloudWatch Logs ─────────────────────────────"

pull_logs() {
  local log_group="$1"
  local filter="$2"
  local label="$3"
  local outfile="$4"

  echo "  Querying $label..."

  aws logs filter-log-events \
    --region "$REGION" \
    --log-group-name "$log_group" \
    --start-time "$START_MS" \
    --end-time "$NOW_MS" \
    --filter-pattern "$filter" \
    --output json 2>/dev/null | jq -r '.events[] | "\(.timestamp)\t\(.message)"' > "$outfile" 2>/dev/null || true

  local count=$(wc -l < "$outfile" | tr -d ' ')
  echo "    → $count log entries"
}

# ─── 3a: Orchestrator logs (by workflow ID and ticket IDs) ───────────────────

# Primary: search for workflow ID
pull_logs "$LOG_ORCHESTRATOR" "\"$WORKFLOW_ID\"" \
  "Orchestrator (workflowId)" "$OUTPUT_DIR/orchestrator_wf.log"

# Also search per ticket
> "$OUTPUT_DIR/orchestrator_tickets.log"
echo "$TICKET_IDS" | while read -r tid; do
  [ -z "$tid" ] && continue
  aws logs filter-log-events \
    --region "$REGION" \
    --log-group-name "$LOG_ORCHESTRATOR" \
    --start-time "$START_MS" \
    --end-time "$NOW_MS" \
    --filter-pattern "\"$tid\"" \
    --output json 2>/dev/null | jq -r '.events[] | "\(.timestamp)\t\(.message)"' >> "$OUTPUT_DIR/orchestrator_tickets.log" 2>/dev/null || true
done
echo "  Orchestrator (per-ticket): $(wc -l < "$OUTPUT_DIR/orchestrator_tickets.log" | tr -d ' ') entries"

# ─── 3b: Jira-real logs ─────────────────────────────────────────────────────

> "$OUTPUT_DIR/jira_real.log"
echo "$TICKET_IDS" | while read -r tid; do
  [ -z "$tid" ] && continue
  aws logs filter-log-events \
    --region "$REGION" \
    --log-group-name "$LOG_JIRA_REAL" \
    --start-time "$START_MS" \
    --end-time "$NOW_MS" \
    --filter-pattern "\"$tid\"" \
    --output json 2>/dev/null | jq -r '.events[] | "\(.timestamp)\t\(.message)"' >> "$OUTPUT_DIR/jira_real.log" 2>/dev/null || true
done
echo "  Jira-real: $(wc -l < "$OUTPUT_DIR/jira_real.log" | tr -d ' ') entries"

# ─── 3c: Workflow-output logs ────────────────────────────────────────────────

pull_logs "$LOG_WORKFLOW_OUTPUT" "\"$WORKFLOW_ID\"" \
  "Workflow-output" "$OUTPUT_DIR/workflow_output.log"

# ─── 3d: Agent-invoker logs ──────────────────────────────────────────────────

pull_logs "$LOG_AGENT_INVOKER" "\"$WORKFLOW_ID\"" \
  "Agent-invoker" "$OUTPUT_DIR/agent_invoker.log"

echo ""

# ─── Step 4: Parse events from DDB ──────────────────────────────────────────

echo "─── Step 4: DDB Events Timeline ────────────────────────────────"

echo "$EVENTS_RAW" | jq -r '
  .Items
  | sort_by(.timestamp.S // .timestamp.N)
  | .[]
  | [
      (.timestamp.S // .timestamp.N // "?"),
      (.type.S // "?"),
      (.detail.M.agentId.S // .detail.M.ticketId.S // "?"),
      (.detail.M.phase.S // .detail.M.status.S // .detail.M.message.S // "")
    ]
  | @tsv
' > "$OUTPUT_DIR/events_timeline.tsv" 2>/dev/null || true

EVENT_COUNT=$(wc -l < "$OUTPUT_DIR/events_timeline.tsv" | tr -d ' ')
echo "  $EVENT_COUNT events in DDB"
echo ""

# ─── Step 5: Build unified timeline ─────────────────────────────────────────

echo "─── Step 5: Unified Timeline ────────────────────────────────────"
echo ""

# Merge all log sources into a single sorted timeline
{
  # Orchestrator logs (format: timestamp\tmessage)
  if [ -s "$OUTPUT_DIR/orchestrator_wf.log" ]; then
    awk -F'\t' '{print $1 "\t[ORCH] " $2}' "$OUTPUT_DIR/orchestrator_wf.log"
  fi
  if [ -s "$OUTPUT_DIR/orchestrator_tickets.log" ]; then
    awk -F'\t' '{print $1 "\t[ORCH] " $2}' "$OUTPUT_DIR/orchestrator_tickets.log"
  fi

  # Jira-real logs
  if [ -s "$OUTPUT_DIR/jira_real.log" ]; then
    awk -F'\t' '{print $1 "\t[JIRA] " $2}' "$OUTPUT_DIR/jira_real.log"
  fi

  # Workflow-output logs
  if [ -s "$OUTPUT_DIR/workflow_output.log" ]; then
    awk -F'\t' '{print $1 "\t[WFOUT] " $2}' "$OUTPUT_DIR/workflow_output.log"
  fi

  # Agent-invoker logs
  if [ -s "$OUTPUT_DIR/agent_invoker.log" ]; then
    awk -F'\t' '{print $1 "\t[INVOKE] " $2}' "$OUTPUT_DIR/agent_invoker.log"
  fi

  # DDB events
  if [ -s "$OUTPUT_DIR/events_timeline.tsv" ]; then
    awk -F'\t' '{print $1 "\t[EVENT] type=" $2 " agent/ticket=" $3 " " $4}' "$OUTPUT_DIR/events_timeline.tsv"
  fi
} | sort -t$'\t' -k1,1n | uniq > "$OUTPUT_DIR/unified_timeline.log"

UNIFIED_COUNT=$(wc -l < "$OUTPUT_DIR/unified_timeline.log" | tr -d ' ')
echo "  Total unified entries: $UNIFIED_COUNT"
echo ""

# ─── Step 6: Extract key lifecycle events ────────────────────────────────────

echo "─── Step 6: Key Lifecycle Events ────────────────────────────────"
echo ""

# Ticket creations
echo "  ┌─ Ticket Creations ──────────────────────────────────"
grep -i "Created\|create_ticket" "$OUTPUT_DIR/jira_real.log" 2>/dev/null | \
  awk -F'\t' '{
    # Convert ms timestamp to readable
    ts = $1 / 1000
    cmd = "date -r " int(ts) " +\"%H:%M:%S\" 2>/dev/null"
    cmd | getline timestr
    close(cmd)
    print "  │ " timestr " " $2
  }' | head -30
echo "  └─────────────────────────────────────────────────────"
echo ""

# Status transitions (webhooks)
echo "  ┌─ Status Transitions (Webhooks) ─────────────────────"
grep -i "webhook\|→\|status" "$OUTPUT_DIR/orchestrator_wf.log" "$OUTPUT_DIR/orchestrator_tickets.log" 2>/dev/null | \
  sort -t$'\t' -k1,1n | uniq | \
  awk -F'\t' '{
    ts = $1 / 1000
    cmd = "date -r " int(ts) " +\"%H:%M:%S\" 2>/dev/null"
    cmd | getline timestr
    close(cmd)
    print "  │ " timestr " " $2
  }' | head -40
echo "  └─────────────────────────────────────────────────────"
echo ""

# Agent invocations
echo "  ┌─ Agent Invocations ─────────────────────────────────"
grep -i "Invoking agent\|Async invoke sent\|invoke" "$OUTPUT_DIR/orchestrator_wf.log" "$OUTPUT_DIR/orchestrator_tickets.log" 2>/dev/null | \
  sort -t$'\t' -k1,1n | uniq | \
  awk -F'\t' '{
    ts = $1 / 1000
    cmd = "date -r " int(ts) " +\"%H:%M:%S\" 2>/dev/null"
    cmd | getline timestr
    close(cmd)
    print "  │ " timestr " " $2
  }' | head -20
echo "  └─────────────────────────────────────────────────────"
echo ""

# Completions & unblocks
echo "  ┌─ Completions & Cascades ────────────────────────────"
grep -i "done\|Unblocked\|complete" "$OUTPUT_DIR/orchestrator_wf.log" "$OUTPUT_DIR/orchestrator_tickets.log" 2>/dev/null | \
  sort -t$'\t' -k1,1n | uniq | \
  awk -F'\t' '{
    ts = $1 / 1000
    cmd = "date -r " int(ts) " +\"%H:%M:%S\" 2>/dev/null"
    cmd | getline timestr
    close(cmd)
    print "  │ " timestr " " $2
  }' | head -20
echo "  └─────────────────────────────────────────────────────"
echo ""

# ─── Step 7: Anomaly Detection ───────────────────────────────────────────────

echo "─── Step 7: Anomaly Detection ───────────────────────────────────"
echo ""

# Check for "blocked" tickets that received "ready" webhooks
echo "  Checking for blocked→ready race conditions..."
BLOCKED_TICKETS=$(grep -i "Status: blocked\|status.*blocked" "$OUTPUT_DIR/jira_real.log" 2>/dev/null | \
  grep -oE "TEAM-[0-9]+" | sort -u)

if [ -n "$BLOCKED_TICKETS" ]; then
  echo "$BLOCKED_TICKETS" | while read -r btid; do
    READY_HIT=$(grep "$btid.*ready\|ready.*$btid" "$OUTPUT_DIR/orchestrator_tickets.log" 2>/dev/null | head -1)
    if [ -n "$READY_HIT" ]; then
      echo "  ⚠️  RACE: $btid was set 'blocked' by ticket tools but received 'ready' webhook"
      echo "      $READY_HIT" | awk -F'\t' '{print "      at ts=" $1}'
    fi
  done
fi

# Check for unknown agents
UNKNOWN=$(grep -i "Unknown agent" "$OUTPUT_DIR/orchestrator_wf.log" "$OUTPUT_DIR/orchestrator_tickets.log" 2>/dev/null)
if [ -n "$UNKNOWN" ]; then
  echo "  ⚠️  UNKNOWN AGENT errors found:"
  echo "$UNKNOWN" | head -5 | sed 's/^/      /'
fi

# Check for ghost tickets (tickets in orchestrator not in ticket tools)
ORCH_TICKETS=$(grep -oE "TEAM-[0-9]+" "$OUTPUT_DIR/orchestrator_wf.log" "$OUTPUT_DIR/orchestrator_tickets.log" 2>/dev/null | sort -u)
JIRA_TICKETS=$(grep -oE "TEAM-[0-9]+" "$OUTPUT_DIR/jira_real.log" 2>/dev/null | sort -u)

if [ -n "$ORCH_TICKETS" ] && [ -n "$JIRA_TICKETS" ]; then
  GHOSTS=$(comm -23 <(echo "$ORCH_TICKETS") <(echo "$JIRA_TICKETS") 2>/dev/null)
  if [ -n "$GHOSTS" ]; then
    GHOST_COUNT=$(echo "$GHOSTS" | wc -l | tr -d ' ')
    echo "  ⚠️  GHOST TICKETS: $GHOST_COUNT ticket(s) in orchestrator but NOT in ticket tools logs:"
    echo "$GHOSTS" | sed 's/^/      /'
    echo "      (These may be from a previous run sharing the same epic)"
  fi
fi

echo ""

# ─── Summary ─────────────────────────────────────────────────────────────────

echo "═══════════════════════════════════════════════════════════════════"
echo "  TRACE COMPLETE"
echo ""
echo "  Workflow: $WORKFLOW_ID"
echo "  Tickets:  $TICKET_COUNT"
echo "  Events:   $EVENT_COUNT (DDB)"
echo "  Log entries: $UNIFIED_COUNT (unified)"
echo ""
echo "  Full output saved to: $OUTPUT_DIR/"
echo "  Key files:"
echo "    unified_timeline.log   — all sources merged by timestamp"
echo "    orchestrator_wf.log    — orchestrator logs"
echo "    jira_real.log          — ticket creation logs"
echo "    workflow_output.log    — agent completion logs"
echo "    events_timeline.tsv    — DDB events"
echo ""
if [ "$VERBOSE" = true ]; then
  echo "─── Full Unified Timeline (verbose) ───────────────────────────"
  cat "$OUTPUT_DIR/unified_timeline.log" | \
    awk -F'\t' '{
      ts = $1 / 1000
      cmd = "date -r " int(ts) " +\"%H:%M:%S\" 2>/dev/null"
      cmd | getline timestr
      close(cmd)
      printf "  %s %s\n", timestr, $2
    }'
fi
echo "═══════════════════════════════════════════════════════════════════"
