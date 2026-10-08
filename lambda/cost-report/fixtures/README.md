# cost-report fixtures

| File | What it is | Read by |
|---|---|---|
| `kpi-cases.json` | Hand-built scorer cases, shared by the Lambda scorer and its TS mirror | `kpi.test.mjs`, `src/lib/workflow/performance.test.ts` |
| `codex-5038-usage.json` | Codex usage records from a real run | `index.test.mjs` |
| `replay-{rfq233,znl7a4,c3x6k1,v51wtn}.json` | Four real runs, trimmed (below) | `replay.test.mjs` (TEAM-5428) |

## Replay fixtures: provenance

Pulled read-only on 2026-10-08 from the hub's own account (us-east-1):

| Run | Workflow id | Why it is here |
|---|---|---|
| rfq233 | `wf_1791311636588_rfq233` | cancelled; scored 63/D before the cap bound |
| znl7a4 | `wf_1791220686225_znl7a4` | manual close-out of an unmerged CD run, so outcome `stopped` |
| c3x6k1 | `wf_1789170903227_c3x6k1` | merged and deployed; live card 68 |
| v51wtn | `wf_1789169249023_v51wtn` | clean merged run; live card 100 |

Sources:
- `workflow`: DynamoDB `agentcore-hub-workflows`, `GetItem {workflowId}`.
- `events`: DynamoDB `agentcore-hub-events`, `Query workflowId = :w` (all pages).
- `completions`: S3 `s3://agentcore-hub-artifacts-<account>-<region>/completions/<ticketId>.json`, one GET for each ticket in `workflow.agentTasks`.

What was trimmed:
- **`workflow`** keeps only the fields the scorer reads:
  - `phase`, `startedAt`, `cancelledAt`, `completedAt`, `completeReason`, `finalizedAt`, `delivery`, `prUrl`, `reviewGateHistory`;
  - for each `agentTasks` entry: `agentId`, `status`, `title`, `phase`, `labels`, `createdAt`, `startedAt`, `completedAt`, `mergeCommit`, `outcome`, `prUrl`, `spawnedBy`.
  - Dropped: agent `output` and `humanNotifications`. These only feed the `quality.prUrl` fallback.
- **`events`** are reduced in four steps:
  1. Collapsed to one copy each (`dedupeEvents`).
  2. Filtered to the types the quality path reads: agent invoke/complete/error/died/retry, `ticket.created`, `workflow.report_completion`, `workflow.complete`, `workflow.nudge`, `review.*`, `manager.intervention`, `orchestrator.unblocked` and `orchestrator.escalation_decided`.
  3. Detail strings clipped to 240 characters.
  4. Each event reduced to `{type, timestamp, detail}`.
- **`completions`** only records that an object exists: `{}`, or `{ci_status}` when the object carries one. Report bodies are not kept.
- **Account id:** every occurrence of the account id is replaced with `000000000000`.

The trim was accepted only after the full quality path gave a deep-equal `assembleQuality` result (outcome, delivery and quality) and the same `review.needed` count on the trimmed fixture as on the raw record. If the scorer starts reading a new field or event type, re-pull the record and re-check, rather than hand-editing a fixture.
