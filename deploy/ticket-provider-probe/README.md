# Ticket Provider Probe (Jira outage replay + keep-alive)

When Jira is down, `report_completion` queues its ticket-side writes instead of
failing the agent. A 5-minute probe checks Jira, pages when it stays down, and
replays the queue once it is back. The same probe is the Jira keep-alive.

Only applies to `TICKET_PROVIDER=jira`. The DynamoDB ticket backend never fails
this way.

**Why it exists.** On 2026-10-08 the Jira site answered `503
SUSPENDED_INACTIVITY`. Runs `db9sx9`, `17w716` and `nmc86c` had already written
their completion records, but the follow-up tickets and the Done transition
could not land. The agents kept retrying, and each run lost about 6 hours.

## Architecture overview

```
agent ── report_completion ──▶ workflow-output Lambda
           1. write completions/<ticket>.json          (always first, unchanged)
           2. ticket-side writes via agentcore-hub-jira
              └─ all failures are "Jira API 5xx:" ──▶ SQS FIFO agentcore-hub-ticket-replay.fifo
                                                      answer {status:"complete", ticketWrites:"queued"}

EventBridge rate(5 minutes) ──▶ agentcore-hub-ticket-provider-probe
           GET /rest/api/3/myself
             ├─ fail ──▶ PutMetricData TicketProviderUnavailable=1   (queue untouched)
             └─ ok   ──▶ PutMetricData TicketProviderUnavailable=0
                         drain the queue in order, one workflow per message group
                           └─ real Done transition ──▶ Jira webhook ──▶ orchestrator
                                                       (agent.complete + orchestrator.unblocked, once)

TicketProviderUnavailable ──▶ alarm agentcore-hub-ticket-provider-unavailable (3 of 3 x 5 min)
```

## When writes are queued

`lambda/workflow-output/index.mjs` `reportCompletion` writes
`completions/<ticket>.json` first, exactly as before. Then it does the
ticket-side writes: create follow-ups, post unfiled notices, post residual
findings, and transition the ticket to Done. The Jira Lambda's `jiraFetch`
returns failures as the string `Jira API <status>: <msg>`. A write counts as a
provider outage when that status is 500-599.

The writes are queued when all of these hold:

- `TICKET_PROVIDER=jira`, and `TICKET_REPLAY_QUEUE_URL` is set on workflow-output.
- The ticket id is a real one, not a synthetic id.
- Either Done was withheld and every pending failure is a 5xx, or Done was
  attempted and failed with a 5xx.

The agent then gets `status:"complete", ticketWrites:"queued"` and a message
telling it not to retry, so the session ends cleanly and the harness publishes
no `agent.died`.

The completion record keeps its **true** status (`complete_pending_follow_ups`
or `complete_transition_failed`) and its `followUpsPending` flag. It also gets
`ticketWrites:"queued"`. The record is the truth, not the response: every guard
that reads the record still sees the pending state.

If `SendMessage` itself fails, the agent gets today's failure response and
retries as before.

### Message shape

```json
{
  "v": 1,
  "workflowId": "db9sx9",
  "ticketId": "TEAM-1234",
  "agentId": "agentcore_hub_operator",
  "transition": "done",
  "followUps": [ { "...": "validated, hashed follow-up entries" } ],
  "residual": { "verdict": "...", "summary": "...", "artifacts": "..." },
  "brief": { "s3Key": "workflows/db9sx9/shared/merge-brief.md" },
  "reportKey": "completions/TEAM-1234.json",
  "journey": { "summary": "first 200 chars", "branch": "feature/...", "pr_url": "..." },
  "queuedAt": "2026-10-08T00:43:12.000Z"
}
```

- `residual` is `null` when the report had no residual review findings.
- `brief` is set only when the report's `evidence_keys` names
  `workflows/<wf>/shared/merge-brief.md`. Otherwise it is `null`.
- `MessageGroupId` = `workflowId`, so one run's writes drain in order.
- `MessageDeduplicationId` = sha256 of the ticket id, the sorted follow-up
  hashes and the transition. A re-dispatched persona that re-reports within the
  5-minute FIFO dedup window is collapsed into the same message.

## The probe

| Item | Value |
|---|---|
| Lambda | `agentcore-hub-ticket-provider-probe` |
| Handler | `ticket-probe.handler` (same zip as workflow-output) |
| Schedule | EventBridge rule `agentcore-hub-ticket-provider-probe`, `rate(5 minutes)` |
| Timeout | 120 s (the drain stops after 90 s) |
| Check | one `GET ${JIRA_SITE_URL}/rest/api/3/myself`, Basic auth, 8 s timeout |
| Credential | `JIRA_*` env vars copied from `agentcore-hub-jira` at deploy |
| Metric | `AgentCoreHub/TicketProvider` / `TicketProviderUnavailable`, dimension `Provider=jira` |

**Rotating the Jira token:** re-run both `node deploy/setup-tickets-lambda.mjs`
and `./deploy/ticket-provider-probe/deploy.sh`. The probe holds a copy, so it
otherwise keeps the old token, fails, and pages.

**Probe fails** (non-2xx, timeout, network error): publish value `1` and return.
The queue is not read.

**Probe succeeds:** publish value `0`, then drain. Each message goes through
`drainCompletion`, in the same order `report_completion` uses. Every step is
idempotent:

0. Read the completion record. If it already says `ticketWrites:"applied"`
   (a redelivered message), the message is `dropped` with no Jira call.
1. Re-read the ticket. A 5xx means `retry`. If the ticket is already Done, the
   transition is skipped.
2. Re-scan the epic's siblings, then create the queued follow-ups. Follow-ups
   that already exist are skipped (the existing `already_materialized` dedupe,
   through the `[fu:<hash>]` title marker and the `completion-followups/` claims).
3. Post unfiled notices (marker-deduped).
4. Post the merge brief, when `brief` is set. The target is the sibling titled
   `Merge Approval:` with a `human:*` assignee that is blocked by this ticket.
   It is skipped if the gate already has a `[brief:<sha12>]` marker comment, or
   already contains the brief's `## Decision` text (the agent posted it itself).
5. Post residual findings, when `residual` is set (marker-deduped).
6. Restamp the record: `status:"complete"`, `followUpsPending:false`,
   `ticketWrites:"queued"`. This comes BEFORE Done, because the ticket Lambdas
   refuse Done while the record still says `followUpsPending:true`.
7. Transition the ticket to Done. Jira fires its webhook on this real change,
   and the orchestrator's cascade (`agent.complete`, `orchestrator.unblocked`)
   follows from it, once.
8. Restamp `ticketWrites:"applied"`, then publish the `workflow.report_completion`
   journey event.

The result is `applied` or `dropped` (the message is deleted), or `retry` (the
message stays). On `retry` the rest of that group's batch goes back with
visibility 0, so order holds. Running the drain twice is safe: the second pass
finds everything applied and deletes the message.

To check Jira without draining, invoke with `{"probeOnly":true}`.

### How the cascade fires

The drain never emits `agent.complete` or `orchestrator.unblocked` itself. It
only performs the real Done transition through the Jira Lambda. Jira fires its
webhook on that status change, `/api/jira/webhook` queues it for the
orchestrator, and the orchestrator emits both events exactly once. Its dedup
guard on `agentTasks[ticket].status` absorbs repeats. So the next ticket
dispatches within one probe interval of Jira coming back. No orchestrator code
changed (DL-009).

## Alarm

| Setting | Value |
|---|---|
| Name | `agentcore-hub-ticket-provider-unavailable` |
| Metric | `AgentCoreHub/TicketProvider` `TicketProviderUnavailable`, `Provider=jira` |
| Statistic / period | Maximum / 300 s |
| Datapoints | 3 of 3 |
| Threshold | `>= 1` |
| Missing data | `breaching` |
| Actions | `ALARM_TOPIC_ARN` when set at deploy, otherwise none |

ALARM after 15 minutes of consecutive failures. One success (a `0`) returns it
to OK. Missing data counts as breaching on purpose: a probe that stops
publishing means the keep-alive has stopped too, which is how the original
incident started.

The alarm is defined in `alarm.json` and applied with
`aws cloudwatch put-metric-alarm --cli-input-json`.

## Keep-alive

The probe is also the Jira keep-alive. An authenticated, write-free REST call
every 5 minutes keeps the site out of `SUSPENDED_INACTIVITY`. There is no
separate keep-alive scheduler.

Caveat: this assumes an authenticated REST read counts as activity. If
Atlassian ever requires a UI login instead, the site can still suspend, and the
alarm still pages.

## Dead-letter queue

| Queue | Settings |
|---|---|
| `agentcore-hub-ticket-replay.fifo` | visibility 60 s, retention 14 days, redrive after 12 receives |
| `agentcore-hub-ticket-replay-dlq.fifo` | FIFO DLQ |

A message moves to the DLQ after 12 receives. Receives only happen on healthy
probes, so that is about 1 hour of Jira being up while the message still fails.
A message stuck at the head of the queue blocks only its own workflow's group.
Other runs keep draining.

There is no DLQ alarm. Check it by hand:

```bash
source deploy/config.sh
DLQ_URL=$(aws sqs get-queue-url --queue-name agentcore-hub-ticket-replay-dlq.fifo \
  --region "$AWS_REGION" --query QueueUrl --output text)

# How many?
aws sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names ApproximateNumberOfMessages --region "$AWS_REGION"

# Look without consuming (the message reappears after the visibility timeout)
aws sqs receive-message --queue-url "$DLQ_URL" --max-number-of-messages 10 \
  --visibility-timeout 0 --attribute-names All --region "$AWS_REGION"
```

Read the probe's CloudWatch logs (`/aws/lambda/agentcore-hub-ticket-provider-probe`)
for that `ticketId` to see why it kept returning `retry`. Fix the cause (for
example a deleted epic or a bad token), then redrive back to the source queue:

```bash
DLQ_ARN=$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names QueueArn --region "$AWS_REGION" --query Attributes.QueueArn --output text)
aws sqs start-message-move-task --source-arn "$DLQ_ARN" --region "$AWS_REGION"
# No --destination-arn: messages go back to the queue they came from.
aws sqs list-message-move-tasks --source-arn "$DLQ_ARN" --region "$AWS_REGION"
```

The next healthy probe drains them. Because the drain is idempotent, a
redriven message that was partly applied finishes without duplicates. If the
ticket should not be finished at all, delete the message from the DLQ instead
and finish the ticket by hand.

## Deploy

```bash
./deploy/ticket-provider-probe/deploy.sh   # queue + DLQ, probe Lambda + role, rule, alarm (idempotent)
./deploy/setup-lambda-role.sh              # adds sqs:SendMessage on the queue to the shared Lambda role
./lambda/workflow-output/deploy.sh         # ships ticket-probe.mjs in the zip, sets TICKET_REPLAY_QUEUE_URL
```

All three are safe to re-run. Names come from `deploy/config.sh`.

`TICKET_REPLAY_QUEUE_URL` is plain config, not a `*_MODE` flag. When it is
unset, workflow-output behaves as before: a 5xx is a failure and the agent
retries.

## Permissions

**workflow-output** (shared Lambda role):
- `sqs:SendMessage` on `agentcore-hub-ticket-replay.fifo`.

**Probe role:**
- `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility`,
  `sqs:GetQueueAttributes` on the replay queue.
- `cloudwatch:PutMetricData`, conditioned on namespace `AgentCoreHub/TicketProvider`.
- `lambda:InvokeFunction` on `agentcore-hub-jira`.
- S3 `GetObject` / `PutObject` on `completions/*`, `completion-followups/*`,
  `completion-notices/*` and `workflows/*/shared/merge-brief.md` in the
  artifact bucket.
- S3 `DeleteObject` on the two claim prefixes (`completion-followups/*`,
  `completion-notices/*`), plus `ListBucket` on the bucket.
- `dynamodb:PutItem` on the events table (`EVENTS_TABLE`).
- Basic Lambda logging.
- Env: `JIRA_*` (copied from `agentcore-hub-jira`).
- No `events:PutEvents`: the drain publishes no EventBridge events.

**Deployer** additionally needs `lambda:GetFunctionConfiguration` on
`agentcore-hub-jira` to copy the credential.

## Live verification after deploy

Run with the deploy role, right after deploy. No mocks on the changed path.

1. **Jira credential and `/myself`:**
   `aws lambda invoke --function-name agentcore-hub-ticket-provider-probe --payload '{"probeOnly":true}' out.json`.
   Expect a real `GET /rest/api/3/myself` returning 200 with an `accountId`
   that matches the Jira Lambda's user. `probeOnly` skips the drain.
2. **CloudWatch:**
   `aws cloudwatch get-metric-statistics --namespace AgentCoreHub/TicketProvider --metric-name TicketProviderUnavailable --dimensions Name=Provider,Value=jira ...`
   shows a `0` datapoint from step 1.
3. **Alarm transitions:** create a scratch alarm from `alarm.json` on
   `Provider=livecheck`. `put-metric-data` value `1` at now-14m, now-9m and
   now-4m; `describe-alarms` should show ALARM. Put `0` at now; it should show
   OK. Delete the scratch alarm.
4. **SQS:** check grants with `aws iam simulate-principal-policy` for the
   shared role (`sqs:SendMessage`) and the probe role (Receive / Delete /
   PutMetricData / InvokeFunction). Then a real round trip: `send-message` a
   `HEALTHCHECK-<ts>` completion (a synthetic id, so no Jira write) and invoke
   the probe. Expect the message to be dropped and deleted, and
   `get-queue-attributes` to show 0 visible and 0 in flight.
5. **EventBridge:** `aws events list-targets-by-rule --rule agentcore-hub-ticket-provider-probe`
   shows the probe, and the next 5-minute tick's log stream shows `/myself 200`.

A real Jira 503 cannot be induced safely. The unit tests cover it with the
recorded `db9sx9` shapes (`lambda/workflow-output/provider-outage.test.mjs`,
`ticket-probe.test.mjs`).

## Known limits

- **Long outages.** An outage longer than the dead-session detector's threshold
  (at least 2x the lease TTL) can re-dispatch the persona while the ticket is
  not yet Done. The re-report is idempotent: the dedup id, or the drain's
  already-Done check, collapses it.
- The response says `complete` while the record says pending. That is by
  design; anything that needs the truth reads the record.
