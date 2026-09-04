# Performance Card

Every terminal workflow run gets a deterministic **performance card**: cost, time
and quality for that run, plus anomaly bands against the same workflow
definition's trailing baseline. The Workflow tab shows a fleet-level card (this
window vs the prior window, by agent, by engine, infra allocation) and a per-run
card on each finished run. No LLM is involved anywhere in the pipeline.

## What is measured

| Group | KPI | Source |
|---|---|---|
| **Cost** | Total / persona LLM / coding CLIs, tokens in/out/cached, $ per task, by engine, by agent | Persona spans (`gen_ai.usage.*` on `aws/spans` + per-runtime span groups), Claude Code `api_request` events, Codex/Kiro `coding_usage` records; priced from `src/config/pricing.json` (Bedrock list, synced to S3 `config/pricing.json`) |
| **Time** | End-to-end wall-clock, human-gate wait (interval union), active (wall − human), agent work (Σ task durations), orchestration idle (active − work), utilization, per phase | Workflow record + events table |
| **Quality** | Agent tasks (+completed), rework rounds (re-invocations of a ticket), change requests (`review.rejected`), fix tickets, review-gate rounds, loops (= change requests + fix tickets), nudges, manager interventions, errors/retries, first-pass yield, PR, outcome | Events table (deduplicated — every event is written twice) + `reviewGateHistory` |
| **Infra** | AgentCore runtime compute / memory, network, storage, CloudWatch, platform, optional (evaluations, CodeBuild fleet, legacy App Runner); per-runtime GB·h/vCPU·h split; per-run allocation | Cost Explorer (trailing 30d, region-scoped) + `AWS/Bedrock-AgentCore` metrics, refreshed at most every 6h |

## Anomaly bands

For each banded KPI the baseline is the same `workflowDefId`'s cards that
completed in the prior 28 days (minimum 5). `sigma = max(1.4826·MAD, 10%·|median|, floor)`;
`z ≥ 2` → **warn**, `z ≥ 3` → **alert**. All banded KPIs are lower-is-better.
The per-run card, the fleet view (`src/lib/workflow/performance.ts`) and the
Lambda (`lambda/cost-report/index.mjs`) share this arithmetic on purpose.

Per-run values are also published as CloudWatch metrics
(`AgentCoreHub/Performance`, dimension `WorkflowDefId`: `CostUsd`,
`PersonaCostUsd`, `CodingCostUsd`, `TokensTotal`, `WallHours`, `ActiveHours`,
`AgentWorkHours`, `HumanWaitHours`, `Tasks`, `ReworkRounds`, `Loops`, `Nudges`,
`Errors`) so CloudWatch anomaly-detection alarms can be attached without touching
the app. Set `PUBLISH_CW_METRICS=0` on the Lambda to stop publishing.

## Artifacts

| Where | What |
|---|---|
| `s3://{ARTIFACT_BUCKET}/workflows/{wfId}/shared/performance-card.json` | Full card (schema `reportVersion: 2`) |
| `…/shared/performance-card.md` | Human-readable card, visible in the artifact viewer |
| `…/shared/cost-report.json` | Alias of the JSON for older readers |
| `s3://{ARTIFACT_BUCKET}/performance/index.json` | Fleet index: compact summary per run + infra snapshot |
| events table `type: workflow.performance` | Per-run summary row with `status` and `anomalies` (dashboards, Workflow Manager) |

## Surfaces

- `GET /api/workflow/performance?days=7|14|30&defId=all|<id>` → fleet view
- `GET /api/workflow/performance?workflowId=<id>` → one run's card
- Workflow tab, no run selected → fleet `PerformanceCard`; terminal run selected → `RunPerformanceCard`

## Operate

```bash
./lambda/cost-report/deploy.sh                  # code + env + IAM (PutMetricData, GetMetricData, ce:GetCostAndUsage)
./lambda/cost-report/deploy.sh --rebuild-index  # + rebuild index, recompute every card's bands, refresh infra
./lambda/cost-report/deploy.sh --backfill       # + regenerate a card for every terminal run first
aws lambda invoke --function-name agentcore-hub-cost-report --payload '{"workflowId":"wf_…"}' /dev/stdout   # one run
```

Trigger in production is the EventBridge rule `agentcore-hub-cost-report-trigger`
on `workflow.complete`. A card whose `cost.totalUsd` is 0 means the run's spans
did not match (runs before the session-id convention, or aged-out logs); the
fleet view excludes those rather than counting them as free.

## Known limits

- Persona spans carry no cache-token fields (Strands does not emit them), which
  also means personas run without prompt caching — the largest cost lever.
- Infra allocation is trailing-30d spend ÷ terminal runs in that window; it is
  an average, not a per-run measurement.
- Codex/Kiro per-turn usage exists only for runs after the coding-runtime usage
  patch (2026-09-01); earlier runs under-report coding-CLI cost.
