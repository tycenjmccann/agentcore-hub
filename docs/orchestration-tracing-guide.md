# Orchestration Tracing Guide

> **Purpose**: Step-by-step operational reference for tracing a workflow execution through all components. Use this when debugging stuck, out-of-order, or duplicated ticket behavior.

---

## The Flow (Jira Mode) — Every Step, Every Log

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 1: Workflow Start                                                       │
│ Who:   App Runner (Next.js)                                                  │
│ What:  POST /api/workflow/start                                              │
│ Does:  Creates Jira epic + requirements ticket via agentcore-hub-tickets Lambda  │
│ Logs:  App Runner stdout (CloudWatch: /aws/apprunner/agentcore-hub-hub/...)        │
│ IDs:   Returns { workflowId, epicId }                                        │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 2: Ticket Creation (agentcore-hub-tickets Lambda)                           │
│ Who:   Lambda function agentcore-hub-tickets                                     │
│ What:  Creates issue in Jira + writes to DDB (dual-write)                    │
│ Does:  1. POST /rest/api/3/issue → gets TEAM-XXX key                         │
│         2. POST /rest/api/3/issueLink (if blocked_by provided)               │
│         3. POST /rest/api/3/issue/{id}/transitions → "Blocked" or "Ready"    │
│         4. DDB PutItem with same TEAM-XXX key                                │
│ Logs:  CloudWatch: /aws/lambda/agentcore-hub-tickets                             │
│ Key log patterns:                                                            │
│   - "tool=Tickets___create_ticket params={...}"  (input)             │
│   - "Created TEAM-XXX in Jira + DDB. Status: blocked|todo"  (result)         │
│   - "Could not transition TEAM-XXX to Blocked: ..."  (CRITICAL — silent fail)│
│   - "tool=Tickets___transition_ticket params={...}"                   │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 3: Jira Webhook Fires                                                   │
│ Who:   Jira Cloud → App Runner webhook endpoint                              │
│ What:  Jira sends issue_updated event on every status transition              │
│ Does:  App Runner route /api/jira/webhook parses event, invokes orchestrator  │
│ Logs:  App Runner stdout (search for "jira webhook" or the ticket ID)        │
│ Payload to orchestrator:                                                     │
│   { source: "jira-webhook", ticketId, newStatus, oldStatus }                 │
│                                                                              │
│ ⚠️  RACE CONDITION: Jira fires webhooks for EVERY transition.                │
│     Creating a ticket fires: new→todo                                        │
│     Transitioning it fires: todo→blocked OR todo→ready                       │
│     If "Blocked" transition fails, Jira may fire todo→ready from elsewhere   │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 4: Orchestrator Lambda Processes Webhook                                │
│ Who:   Lambda function agentcore-hub-orchestrator                                  │
│ What:  Routes ticket status changes to appropriate handler                   │
│ Does:                                                                        │
│   - "todo": Logs and waits (Jira mode — ticket tools Lambda will transition)           │
│   - "ready": Calls handleTicketReadyUnified → invokes agent                  │
│   - "in_progress": Publishes agent.started event                             │
│   - "done": Calls handleTicketDoneUnified → unblocks dependents              │
│ Logs:  CloudWatch: /aws/lambda/agentcore-hub-orchestrator                          │
│ Key log patterns:                                                            │
│   - "[orchestrator] Jira webhook: TEAM-XXX → {status}"                       │
│   - "[orchestrator] TEAM-XXX: {old} → {new}"                                │
│   - "[orchestrator] handleTicketReady: TEAM-XXX assignee=... parentId=..."   │
│   - "[orchestrator] Invoking agent {name} for ticket TEAM-XXX"               │
│   - "[orchestrator] Async invoke sent for {name} (session: ...)"             │
│   - "[orchestrator] TEAM-XXX done. Unblocked: [...]"                         │
│   - "[orchestrator] Unknown agent: ..."  (CRITICAL — invalid assignee)       │
│   - "Ignoring Jira webhook — TICKET_PROVIDER=..."  (guard rejection)         │
│   - "Ignoring DDB stream — TICKET_PROVIDER=jira"  (guard rejection)          │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 5: Agent Invocation (fire-and-forget)                                   │
│ Who:   Orchestrator → Bedrock AgentCore Runtime                              │
│ What:  Async invoke of the agent's Runtime session                           │
│ Does:  Sends POST to AgentCore invoke_async endpoint, returns on HTTP 200    │
│ Logs:  orchestrator log: "Async invoke sent for ... (session: ...)"          │
│ Session ID format: {ticketId}_{workflowId}-{agentId}-{timestamp}             │
│                                                                              │
│ ⚠️  After this point, the orchestrator Lambda EXITS.                         │
│     The agent runs independently in its own microVM.                         │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 6: Agent Execution (Runtime microVM)                                    │
│ Who:   Bedrock AgentCore Runtime (Python main.py)                            │
│ What:  Agent runs with tools, publishes events, produces output              │
│ Does:                                                                        │
│   1. Publishes agent.started event to agentcore-hub-events (DDB direct)            │
│   2. Calls tools (Jira, GitHub, S3, SkillLoader) — each publishes tool_use   │
│   3. Buffers text output, publishes agent.streaming events periodically      │
│   4. On completion: calls WorkflowOutput___report_completion tool            │
│ Logs:  CloudWatch: /aws/bedrock-agentcore/{runtime-name}/session logs         │
│        (Not easily queryable by workflow ID — use session ID from step 5)    │
│ Events written to: agentcore-hub-events DDB table                                  │
│   - type: agent.started, agent.streaming, tool_use                           │
│   - Each has workflowId + agentId + timestamp                                │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 7: Agent Completion (report_completion)                                 │
│ Who:   Agent calls WorkflowOutput tool → agentcore-hub-workflow-output Lambda      │
│ What:  Writes output to S3 + marks ticket "done" in DDB + publishes event    │
│ Does:                                                                        │
│   1. Writes full output to S3: workflows/{wfId}/agents/{agentId}/output.md   │
│   2. Updates agentcore-hub-tickets DDB: status → "done"                            │
│   3. Publishes agent.completed event to agentcore-hub-events                       │
│ Logs:  CloudWatch: /aws/lambda/agentcore-hub-workflow-output                        │
│ Key log patterns:                                                            │
│   - "Writing output to S3: ..."                                              │
│   - "Marking ticket TEAM-XXX done in DDB"                                    │
│                                                                              │
│ ⚠️  The DDB status write fires the Jira transition:                          │
│     The workflow-output Lambda also transitions the Jira ticket to "Done"    │
│     This fires ANOTHER webhook → orchestrator → handleTicketDone             │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 8: Cascade — Unblock Dependents                                         │
│ Who:   Orchestrator Lambda (triggered by "done" webhook)                     │
│ What:  Removes completed ticket from siblings' blockedBy, unblocks next      │
│ Does:                                                                        │
│   1. Gets all children of the epic from Jira                                 │
│   2. For each sibling with this ticket in blockedBy:                         │
│      - Removes from blockedBy                                                │
│      - If blockedBy now empty → transitions to "Ready" in Jira               │
│   3. That "Ready" transition fires webhook → back to Step 4 for next agent   │
│ Logs:  orchestrator log: "TEAM-XXX done. Unblocked: [TEAM-YYY, ...]"        │
│                                                                              │
│ ⚠️  BLOCKER RESOLUTION uses Jira issue links.                                │
│     If the link wasn't created properly in Step 2, the cascade breaks.       │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 9: Workflow Completion                                                   │
│ Who:   Orchestrator Lambda                                                   │
│ What:  Checks if ALL children of epic are "done"                             │
│ Does:  Queries Jira for all children, checks statuses                        │
│        If all done → publishes workflow.complete event, updates DDB workflow  │
│ Logs:  orchestrator log: "workflow.complete" or "isWorkflowComplete: true"    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Log Locations Summary

| Component | CloudWatch Log Group | Correlation ID |
|-----------|---------------------|----------------|
| App Runner (Next.js) | `/aws/apprunner/agentcore-hub-hub/application` | workflowId in URL params |
| Jira Tool Lambda | `/aws/lambda/agentcore-hub-tickets` | Ticket IDs (TEAM-XXX) in log messages |
| Orchestrator Lambda | `/aws/lambda/agentcore-hub-orchestrator` | Ticket IDs + "workflowId=" in handleTicketReady |
| Agent Invoker | `/aws/lambda/agentcore-hub-agent-invoker` | Session ID (contains workflowId) |
| Workflow Output | `/aws/lambda/agentcore-hub-workflow-output` | ticketId + workflowId in payload |
| Runtime Agents | `/aws/bedrock-agentcore/...` | Session ID from orchestrator invoke |
| Events Table | DynamoDB `agentcore-hub-events` | workflowId (partition key) |

---

## Common Failure Patterns

### 1. Tickets fire out of order (all run in parallel)
**Symptom**: Dev/QA/CI agents start before design agents finish
**Root cause**: `blocked_by` not set, OR Jira "Blocked" transition failed silently
**How to trace**:
1. Check `agentcore-hub-tickets` logs for the `create_ticket` call — was `blocked_by` in params?
2. Check the result — does it say `Status: blocked` or `Status: todo`?
3. If `blocked`, check orchestrator logs — did a "ready" webhook arrive anyway?
4. If yes → the "Blocked" transition in Jira failed (Jira workflow may not have that status)

### 2. Agent never invoked (ticket stuck at "ready")
**Symptom**: Ticket shows "Ready" in Jira but no agent activity
**Root cause**: Orchestrator rejected the webhook (wrong TICKET_PROVIDER), or unknown agent
**How to trace**:
1. Check orchestrator logs for the ticket ID
2. Look for "Ignoring" messages (guard rejection)
3. Look for "Unknown agent:" (invalid assignee)
4. Look for "No workflow found" (workflowId label missing from Jira ticket)

### 3. Duplicate agent sessions
**Symptom**: Same agent runs 2-3x simultaneously
**Root cause**: Nudge reset `in_progress` → `ready`, or DDB stream re-delivery
**How to trace**:
1. Check orchestrator logs — multiple "Invoking agent X for ticket Y" entries?
2. Check if a nudge event preceded the duplicate invocation
3. Check if `ConditionalCheckFailedException` was logged (idempotency guard worked)

### 4. Workflow never completes (stuck at last phase)
**Symptom**: All agents done but workflow shows "review" not "complete"
**Root cause**: Orphan tickets from a previous run, or Jira query includes unexpected children
**How to trace**:
1. Check Jira: how many children does the epic have? Are any NOT "done"?
2. Check orchestrator logs for `isWorkflowComplete` — it queries ALL Jira children
3. Look for tickets created by a previous failed run that share the same epic

### 5. "Blocked" transition not available
**Symptom**: Tickets with blockers fire immediately instead of waiting
**Root cause**: Jira workflow missing the "Blocked" status or transitions to it
**How to trace**:
1. Check `ticket tools Lambda` logs for `No "Blocked" transition available for TEAM-XXX`
2. Fix: Jira Project Settings → Board → Workflow — ensure all-to-all transitions exist (see README)

---

## Eval judge throttling (quota)

**Symptom**: eval results log groups (`/aws/bedrock-agentcore/evaluations/results/eval_*`) fill with
`error.type=ThrottlingException` / "Rate exceeded" records; `EvalThrottleRate` climbs on the
`agentcore-hub-eval-health` dashboard; the `agentcore-hub-eval-success-rate` alarm fires with
error-heavy (not span_missing-heavy) sessions.

**Root cause**: every sampled session costs one Opus judge call *per evaluator* in its eval config.
The judge model's requests-per-minute Service Quota is shared with everything else in the account
using that model, and a busy fleet burst exceeds it. The evaluator retries each throttled call 8-10
times, so throttling also multiplies log volume (the eval-packager dedups those retries, but the
underlying judge calls are still lost).

**First response (no quota change needed)**: verify the TEAM-3376 mitigations are actually applied —
the trimmed 5-evaluator matrix and tiered sampling (100% gate roles / 25% others) in
`deploy/evaluations/setup-evaluations.sh`, reconciled against the live configs per that script's
reconciliation section. That alone cuts judge calls ~4-8×.

**Quota increase — OPERATOR action, never CI.** A quota request needs a human to pick the value and
own the AWS support conversation; do not script it into any pipeline.

1. Find the quota for the judge model (Opus). Record the `QuotaCode` and current `Value`:

   ```bash
   aws service-quotas list-service-quotas \
     --service-code bedrock \
     --query "Quotas[?contains(QuotaName, 'Opus')].{Name:QuotaName,Code:QuotaCode,Value:Value}" \
     --output table
   ```

   Look for the on-demand **requests per minute** quota matching the judge model id in
   `deploy/evaluations/eval-config-ids.json` (`us.anthropic.claude-opus-4-7`). If the list is empty
   in your region, drop the `--query` filter and grep the full output for "Opus".

2. Request the increase to **200 requests/minute**:

   ```bash
   aws service-quotas request-service-quota-increase \
     --service-code bedrock \
     --quota-code <QuotaCode-from-step-1> \
     --desired-value 200
   ```

3. Track the request until it's granted (large increases route to AWS Support for human review):

   ```bash
   aws service-quotas list-requested-service-quota-change-history \
     --service-code bedrock \
     --query "RequestedQuotas[?QuotaCode=='<QuotaCode>'].{Status:Status,Requested:DesiredValue}"
   ```

4. After the grant, watch `EvalThrottleRate` on the eval-health dashboard for a full batch window
   before considering raising sampling rates back up.

---

## Tracing Script

Use `scripts/trace-workflow.sh` to pull all logs for a workflow run in one shot.

```bash
./scripts/trace-workflow.sh wf_1779511526188_dvjiwq
```

See the script for full usage. It correlates logs from all components by ticket IDs and timestamps.
