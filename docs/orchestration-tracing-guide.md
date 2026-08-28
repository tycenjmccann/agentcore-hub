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

> **OPERATOR ACTION (TEAM-3366 §2.5)** — this is a one-time, account-level AWS
> Service Quotas change run by a human operator with quota permissions. It is
> NOT performed by CI, any deploy script, or agent code, and it is not
> idempotent to re-request (each call opens a new support case).

**Symptom**: eval results log groups fill with `ThrottlingException` from the
Opus judge; sessions classify as `error` in eval batches; `EvalThrottleRate` /
`EvalThrottleCount` climb on the `agentcore-hub-eval-health` dashboard and the
`eval.batch.null_or_error_rate` metric climbs even though agent telemetry
(`invoke_agent` spans) is healthy.

**First response (no quota change needed)**: verify the load-reduction
mitigations are actually applied — the trimmed 5-evaluator matrix and tiered
sampling (100% gate roles / 25% others) in
`deploy/evaluations/setup-evaluations.sh`, reconciled against the live configs
per that script's reconciliation section. That alone cuts judge calls ~4-8×.

**Step 1 — identify the exact quota (grep, don't guess).** Quota names vary by
model/version, so list them and filter rather than assuming a code:

```bash
aws service-quotas list-service-quotas --service-code bedrock --output json \
 | jq -r '.Quotas[] | select(.QuotaName|test("Opus";"i"))
          | [.QuotaCode, .QuotaName, (.Value|tostring)] | @tsv'
```

The judge quota's expected name pattern is
**"On-demand InvokeModel requests per minute for Anthropic Claude Opus 4.7"**.
Record the `QuotaCode` and the current `Value` before requesting anything.

**Step 2 — request an increase to 200 requests/minute.** Design derivation
(TEAM-3366 §2.5): after the §2.4 load reduction (5 evaluators, tiered
sampling) the judge runs at roughly ~16 RPM sustained, but two sessions
completing simultaneously can burst to ~162 RPM — so 200 RPM gives headroom
without over-asking:

```bash
aws service-quotas request-service-quota-increase \
  --service-code bedrock --quota-code <QuotaCode from above> --desired-value 200
```

Track the resulting case with
`aws service-quotas list-requested-service-quota-change-history --service-code bedrock`.
After the grant, watch `EvalThrottleRate` on the eval-health dashboard for a
full batch window before considering raising sampling rates back up.

**Note — shared on-demand pool.** Check whether online evaluations draw from
the same on-demand InvokeModel pool as the fleet's own model calls: fleet
model overrides include Opus 4.6/4.7, and if the judge and the fleet share one
quota, the 200 RPM target must be re-derived with the fleet's RPM added on
top. Compare the judge's throttling timestamps against fleet invocation spikes
(or ask AWS support which quota the evaluations service consumes) before
treating 200 as sufficient.

---

## Eval health monitoring (dashboard + success-rate alarm)

TEAM-3368 §4: `lambda/eval-packager/index.mjs` emits one EMF record per log
delivery into the `AgentCoreHub/Evaluations` namespace (dimension
`AgentName`), with five health metrics:

| Metric | Meaning |
|---|---|
| `EvalSessionsTotal` | Distinct eval sessions seen in the delivery |
| `EvalSessionsSpanMissing` | Sessions with all-null scores and no `error.type` — the `invoke_agent` span never reached the evaluator (telemetry failure, not agent quality) |
| `EvalSessionsError` | Sessions whose results carry an `error.type` (judge/eval failure) |
| `EvalThrottleCount` | Result records whose `error.type` ends in `ThrottlingException` — judge quota pressure (see the quota section above) |
| `EvalDuplicateResultCount` | Duplicate result rows dropped by dedup (at-least-once delivery / evaluator retries — in-memory per delivery, TEAM-3367, plus the cross-delivery DynamoDB seen-set, TEAM-3376) |
| `EvalThrottleRate` | Throttled sessions / total sessions for the delivery (TEAM-3376; session-level, so 8 retries of one throttled session read as one) |
| `EvalValidationExceptionRate` | Validation-error sessions / total sessions for the delivery (TEAM-3376) |

(One more, `EvalDepChainExcludedCount`, counts dependency-chain evaluator rows
dropped for out-of-scope roles — TEAM-3368 §3.2 config-drift guard.)

Healthy batches emit explicit `0` datapoints for all of them; nothing is
emitted when a delivery contains no sessions.

Apply the dashboard (safe any time — widgets stay empty until metrics flow;
the JSON hardcodes `us-east-1`, substitute the target region at apply time):

```bash
aws cloudwatch put-dashboard --dashboard-name agentcore-hub-eval-health \
  --dashboard-body file://deploy/evaluations/eval-health-dashboard.json
```

Apply the success-rate alarm — fires when fleet
`(total - span_missing - errors) / total` < 0.8 on 3 of 4 hourly datapoints:

```bash
aws cloudwatch put-metric-alarm \
  --cli-input-json file://deploy/evaluations/eval-success-rate-alarm.json
```

**Rollout order:** apply the alarm ONLY AFTER the P0-A runtime telemetry fix
and the P0-B eval-packager fix are deployed AND at least one healthy batch
with non-zero `EvalSessionsTotal` carrying the three new metrics has been
observed — earlier, the rate evaluates on stale/partial data and fires
immediately. Add `AlarmActions` (the environment's SNS topic ARN) to the JSON
at apply time; it is intentionally omitted from the repo copy.

**INSUFFICIENT_DATA during quiet hours is expected** — both eval alarms use
`TreatMissingData: missing`, and no eval sessions means no datapoints. Do not
page on INSUFFICIENT_DATA.

---

## Tracing Script

Use `scripts/trace-workflow.sh` to pull all logs for a workflow run in one shot.

```bash
./scripts/trace-workflow.sh wf_1779511526188_dvjiwq
```

See the script for full usage. It correlates logs from all components by ticket IDs and timestamps.
