# Continuous Improvement Pipeline

This directory contains deployment scripts for the **eval-packager** continuous improvement pipeline.

## Architecture Overview

```
CloudWatch Logs → eval-packager Lambda → agentcore-hub-eval-results (one row per
                                          judge result, kept forever)
                                       → agentcore-hub-eval-daily (day buckets)
                                       → DynamoDB buffer
   → (on flush) archive raw batch to batches/
   → invoke Fleet Improver runtime → synthesized PRD to prd/
   → prd-submitter (S3→EventBridge) → workflow API → fix PR

EventBridge (rate(1 day)) → eval-packager {mode:"reconcile"} → re-read the same
   log groups → converge results rows + day buckets (no buffer, no PRD)
```

### Pipeline Stages

1. **CW Logs Ingestion**: Bedrock AgentCore evaluation harnesses emit results to CloudWatch Logs groups following the pattern:
   ```
   /aws/bedrock-agentcore/evaluations/results/eval_<short_id>
   ```
   where `<short_id>` is the agent's `agentId` with the `agentcore_hub_` prefix stripped.

2. **Eval Packager Lambda** (`lambda/eval-packager/index.mjs`):
   - Triggered by CW Logs subscription filters, or by the daily reconcile rule
     (`{mode:"reconcile"}` — see [Two entry points, one code path](#two-entry-points-one-code-path))
   - Resolves agent identity from `LEGACY_RESULTS_GROUPS_B64` first, then from the
     log group harness name
   - Parses evaluator results (scores, evidence, evaluator name) from log event messages
   - **Writes one row per judge result to `agentcore-hub-eval-results`** — before
     the per-agent gates, so the audit trail is complete even when the loop is not
   - Applies per-agent controls (enabled flag, sample rate)
   - Atomically appends enriched session data to a DynamoDB buffer
   - **On flush, invokes the Fleet Improver runtime to synthesize a PRD** (see stage 5)

3. **DynamoDB Buffer** (`agentcore-hub-eval-config` table):
   - Keyed by canonical `agentId` (e.g., `agentcore_hub_frontend_dev`)
   - Accumulates sessions in `sessionBuffer` list attribute
   - Flushes when buffer reaches configured `batchSize`

3b. **DynamoDB dedup seen-set** (`agentcore-hub-eval-seen` table):
   - **Purpose**: CloudWatch Logs subscription delivery is at-least-once, and two
     concurrent invocations can each see a copy of the same evaluator result. The
     in-memory per-delivery dedup in `extractSessionData` cannot catch either, so
     duplicates double-counted the rolling `evalScores` / `evalSessionCount` /
     `evalStatusCounts` aggregates. Two phases: `checkSeenSet` reads the table
     (`BatchGetItem`, 100 keys per request) **before** classification, aggregation
     and buffering and drops rows whose key is already present; `claimSeenSet`
     then writes one conditional `PutItem` per surviving key **after** the buffer
     append succeeds.
   - **Items** are `{ dedupKey, expiresAt, outcome }`, where `outcome` is
     `scored` / `error` / `other`. It exists so a *scored* row supersedes **any
     non-scored** claim for the same evaluation attempt (TEAM-3406 — mirroring
     the `OUTCOME_RANK` preference `scored > other > error`): an eval retry
     storm emits a throttled ERROR record and then the real SCORED record with
     the same trace/span/evaluator, and a pending row (or a sampled-out
     delivery) claims `other` before the score exists — in either case dropping
     the later scored row as a duplicate would misclassify the session and lose
     the score permanently. Legacy items with no `outcome` attribute count as
     non-scored and are supersedable too.
   - **Check-then-claim, never claim-then-process**: the claim is deliberately
     ordered after `appendToBuffer`. Claiming first meant that an invocation which
     threw *after* claiming (a DDB throttle, or the 400KB item cap on a long
     cooldown hold) poisoned its own CloudWatch re-delivery — the retry saw every
     key claimed and dropped every row permanently. The cost of the safe ordering
     is that a crashed invocation's rows can be counted twice in the rolling
     aggregates, and that two truly concurrent invocations can both pass the check
     before either claims. Both are recoverable; lost evaluations are not.
   - **Partition key**: `dedupKey` (S) — no sort key, no GSI. The key is built by
     `dedupKeyFor` in `index.mjs`: `req|<requestId>|<evaluatorName>` when the
     record carried a request id, `raw|<timestamp>|<sha256-16 of the raw line>`
     for an unparseable line, else a `content|…` key ending in the content
     fingerprint. Every variant is capped well under DynamoDB's 2048-byte
     partition-key limit — an oversized key would make every `PutItem` throw
     `ValidationException`, silently disabling dedup for good.
   - **TTL**: enabled on the `expiresAt` attribute (24h, `SEEN_TTL_SECONDS`).
     DynamoDB TTL is **opt-in per table**: without the
     `aws dynamodb update-time-to-live` call in `deploy-all.sh` the table grows
     without bound.
   - **Billing**: `PAY_PER_REQUEST` (one small write per evaluator-result row).
   - **Fail-open**: a missing table, a denied `BatchGetItem`/`PutItem`, or any
     non-conditional DynamoDB error treats the record as fresh — double-counting
     beats data loss.
     The consequence is that a *misconfigured* seen-set is invisible in the
     happy path; the `failed open for N record(s)` warning in the packager's logs
     is the signal to check the table and the IAM grant.
   - **Env var**: `EVAL_SEEN_TABLE` on the eval-packager Lambda (set by
     `deploy.sh`, defaulted in `deploy/config.sh`). Set it to the empty string to
     disable the persistent check and keep only per-delivery dedup.
   - **Deploy order**: `deploy/setup-lambda-role.sh` (IAM grant) →
     `deploy-all.sh` (creates the table + TTL) → `deploy.sh` (sets the env var).
     Deploying the Lambda before the table exists is exactly the permanent
     fail-open above.

### Concurrency model (TEAM-3385)

The packager has no lock on the whole pipeline — CloudWatch Logs subscription
delivery is at-least-once and concurrent invocations for the same agent are
expected, so every piece of shared state is either idempotent or
conditionally written instead of being globally serialized:

- **Seen-set (above)**: check-then-claim, never claim-then-process. The claim
  is a conditional `PutItem` ordered strictly *after* the buffer append
  succeeds, so an invocation that crashes between check and claim leaves its
  rows unclaimed — the next CloudWatch redelivery reprocesses them instead of
  finding them permanently marked seen. The cost is a possible double-count in
  the rolling aggregates; per the fail-open posture used throughout this
  pipeline, that is preferred over silently losing an evaluation.
- **Flush claim**: `flushBuffer`'s buffer-reset `UpdateItem` is conditioned on
  `bufferVersion` holding the version of the exact `ALL_NEW` snapshot the flush
  is archiving (TEAM-3406). `appendToBuffer` atomically increments
  `bufferVersion` on every append, so the reset can only succeed if **no**
  append landed after the snapshot — the old `lastFlushedAt` condition (which
  appends never touched) let a reset wipe rows appended between the snapshot
  and the reset, losing them permanently once their seen-set keys were claimed.
  Versions are unique per append, so of N concurrent invocations only the one
  holding the latest version wins, and its snapshot is a superset of every
  earlier one — of two invocations that both decide to flush, still exactly one
  does, and the flushed batch always contains the loser's rows. The loser gets
  `ConditionalCheckFailedException`, logs `eval.flush.claim_lost`, and returns
  immediately with **no** S3 archive, no batch metric and no PRD synthesis — a
  losing invocation has zero side effects beyond the failed conditional write.
  The reset still writes `lastFlushedAt` (the flush-cooldown gate reads it) and
  deliberately leaves `bufferVersion` in place, monotonically increasing forever
  — removing it would let a recycled version win a stale compare-and-swap (ABA).
- **Scorecard aggregation**: `aggregateScoresToDdb` merges each delivery's
  score deltas into the per-agent `evalScores` / `evalStatusCounts` under
  optimistic locking on an `evalAggVersion` counter, since the merge touches
  nested map paths that atomic `ADD` can't reach. A lost version check
  re-reads and re-merges, bounded at 3 attempts with jittered backoff;
  exhausting the retries is non-fatal (the write is skipped, logged, and the
  handler carries on) because the scorecard is a dashboard tally, not a
  ledger. `evalSessionCount` in particular stays **approximate** under
  at-least-once delivery regardless of locking — that's accepted, not chased.

### Operational metrics: per-day buckets, selectable window

The Evaluations tab's Operational Metrics (sessions, evaluator scores, tokens,
cache hit, cost) are all read from the **`agentcore-hub-eval-daily`** table —
one item per agent per UTC day (PK `agentId`, SK `day` = `YYYY-MM-DD`) — and
folded over the window the caller picks (`GET /api/evaluations?days=7|30|90|all`,
`parseWindow` / `windowDaysFor` in `src/lib/eval-metrics.ts`; `days` defaults to
7 and an unrecognised value is a 400). There is no weekly reset and no all-time
counter in the UI path any more (the legacy `tokenTotalInput` / `tokenByModel`
counters on the eval-config row and the `agentcore-hub-token-reset-weekly`
cron were retired; the all-time `evalScores` / `evalSessionCount` fields are
still written for the anomaly-watcher and the Workflow Manager dossier).

The buckets deliberately do **not** live on the eval-config row: that row also
carries `sessionBuffer` and sits at DynamoDB's 400KB item cap for the busy
agents (Hub Agent, Workflow Manager), so any extra map there fails with
"Item size to update has exceeded the maximum allowed size".

Items are FLAT so each writer needs exactly one atomic `UpdateItem ... ADD`
(create-or-increment, no path set-up, no read-modify-write, no CAS):

| Writer | Attributes | Source records |
|--------|-----------|----------------|
| `lambda/token-aggregator` | `tokensIn` (full prompt incl. cache), `tokensOut`, `cacheRead`, `cacheWrite`, `cacheWrite1h`, `calls`, `costUsd`, `m\|<model>\|<field>` | Strands `chat` spans (`strands.telemetry.tracer`) on Strands runtimes — the only record whose input count includes prompt-cache reads/writes; EMF `gen_ai.client.token.usage` metrics on managed harnesses; `claude_code.api_request` events on the coding runtime |
| `lambda/eval-packager` (`aggregateScoresToDdb`) | `sessions`, `e\|<evaluator>\|sum`, `e\|<evaluator>\|count` | evaluator results, same deduped entries as the all-time aggregates |

**The buckets are permanent.** TTL on this table is **disabled** (`deploy-all.sh`
turns it off) and neither Lambda writes `expiresAt` any more, which is what makes
the 30 / 90 / all-time windows answerable — a 14-day TTL had been deleting the
history the wider windows need. `DAILY_RETAIN_DAYS` is gone from
`deploy-token-aggregator.sh`. Rows written before the change still carry a stale
`expiresAt` attribute; with TTL off it is inert, so there is nothing to clean up.

**Persona rows.** All 18 pipeline personas share one runtime
(`agentcore_hub_agent`), so that runtime's item is a rollup and a per-persona score
is invisible in it. The packager therefore ALSO increments a second item keyed
`PK <agentId>#<persona>` with the same score attributes (`sessions`,
`e|<evaluator>|sum`, `e|<evaluator>|count`). Token and cost attributes
(`m|<model>|<field>`) stay runtime-only — they are not attributable per persona.
`_runtime` (a session with no persona in its id, or whose persona IS the hosting
runtime) gets no separate item: it IS the rollup. `splitDailyItems` in
`src/lib/eval-metrics.ts` is what separates the two shapes read-side.

Cost is computed read-side from `src/config/pricing.json`
(`cachedInputDiscount`, `cacheWriteMultiplier` by TTL). Env var
`EVAL_DAILY_TABLE` on both Lambdas and the app (default
`agentcore-hub-eval-daily`).

Deploy / repair:

```bash
bash deploy/continuous-improvement/deploy-all.sh                # creates the tables, disables the eval-daily TTL
bash deploy/continuous-improvement/deploy-token-aggregator.sh   # Lambda + per-shape subscription filters, deletes the weekly reset
# Rebuild day buckets by reconciling the results log groups (see below).
# backfill-daily.mjs is a deprecation stub that exits 1.
node deploy/continuous-improvement/backfill-results.mjs --from 2026-06-01 --to 2026-06-30
```

Why the shapes matter: the previous aggregator only matched the EMF metric,
whose `input` type on Strands runtimes carries the *uncached* input (a few tokens
per call once prompt caching is on) — the dashboard showed 3K in / 2M out for
the shared runtime — and the coding runtime, which never emits that metric,
always showed $0.

### Per-result store: `agentcore-hub-eval-results`

Aggregates alone could never explain a score. The hub kept an all-time sum/count
per evaluator on the eval-config row plus 14 days of day buckets on a TTL, so a
score could be *seen* but not *explained*, and no window wider than 14 days could
be offered because the evidence had been deleted. `agentcore-hub-eval-results`
(env `EVAL_RESULTS_TABLE`, created by `deploy-all.sh`) fixes that: **one row per
judge result, `PAY_PER_REQUEST`, PITR on, no TTL, kept forever.**

The evaluator results CloudWatch Logs groups
(`/aws/bedrock-agentcore/evaluations/results/<configId>`) remain the **system of
record**. This table is a queryable **mirror**, kept equal to them by a daily
reconcile — if the two ever disagree, the log groups are right and a reconcile is
the repair.

**Keys.** PK `agentId` (S), SK `sk` (S) = `<evaluatedAt ISO>#<dedupKey>`, where
`dedupKey` is the SAME key the cross-delivery seen-set uses. That shared key is
what makes push, reconcile and backfill converge on one row: every write is a
conditional `PutItem` with `attribute_not_exists(sk)`, so a second sighting of the
same evaluation attempt is a counted duplicate, not a second row.

**GSIs** (all `ProjectionType=ALL`):

| Index | HASH | RANGE | Notes |
|-------|------|-------|-------|
| `bySession` | `gsi1pk` = `sessionId` | `gsi1sk` = `<evaluator>#<evaluatedAt>` | the session drilldown |
| `byPersona` | `gsi2pk` = `<agentId>#<persona>` | `sk` | one persona's results over time |
| `byWorkflow` | `gsi3pk` = `workflowId` | `sk` | **sparse** — only pipeline session ids parse into a `workflowId`, so canary / cloud-code / `si-` / chat rows never appear in it |

**Row attributes**: `persona`, `sessionId`, `workflowId`, `ticketId`, `evaluator`,
`day`, `evaluatedAt`, `score`, `scoreLabel`, `explanation` (truncated to 8192
bytes, with `explanationTruncated: true` when it was), `errorType`,
`errorMessage`, `status`, `statusReason`, `traceId`, `spanId`, `requestId`,
`logGroup`, `source` (`push` | `reconcile`), `ingestedAt`.

#### Two entry points, one code path

`lambda/eval-packager/` is reached two ways and both run the same
extract → dedup → role-guard → row-mapper → put chain:

- **Push** — the CloudWatch Logs subscription filter calls the handler. Results
  rows are written AFTER extract → in-delivery dedup → role guard and
  **BEFORE** the config / enabled / sample-rate gates. That ordering is
  deliberate: those gates govern the IMPROVER LOOP, not the record of what the
  judge said, so a paused loop, a disabled agent or a 25%-sampled agent still
  leaves a complete audit trail. The day buckets stay behind the gates
  (behaviour unchanged) and the reconcile converges them.
- **Reconcile** — `{ mode: "reconcile", days | from/to, group?, dryRun? }`,
  handled *before* the `awslogs` decode. It re-reads the results log groups with
  `DescribeLogGroups` + `FilterLogEvents` and pushes the events through that same
  chain, then rewrites the day buckets with `SET` recomputed from the stored rows
  — idempotent, where a second `ADD` would double-count. A reconcile **never**
  touches the eval-config item (all-time scorecard, `sessionBuffer`,
  `lastFlushedAt`), the seen-set, or the improver: it can neither flush a batch
  nor synthesize a PRD. That is the whole reason a backfill over months of
  history is safe to run.

Two new fields land on the existing `AgentCoreHub/Evaluations` EMF record:
`EvalResultsWritten` and `EvalResultsDuplicate`. A healthy steady state is mostly
duplicates on the daily reconcile and mostly writes on the push path.

#### `LEGACY_RESULTS_GROUPS_B64`

Packager env var: **base64 of the compact JSON** of
`deploy/evaluations/legacy-results-groups.json`. It is base64 because
`aws lambda update-function-configuration --environment` takes a
`Variables={K=V,...}` shell list that raw JSON cannot survive. Keys are results
log-group leaf names (or a distinguishing substring), values are canonical
`agentId`s; keys starting with `_` are metadata and are ignored. The map is
consulted **before** the name-based `resolveAgentId()`, which would otherwise
mis-attribute a pre-consolidation log group to one persona's `agentId`. Keep it
small: it rides in the Lambda's 4KB env budget.

#### Schedule and IAM

- EventBridge rule **`agentcore-hub-eval-reconcile`**, `rate(1 day)` → the
  packager with `{"mode":"reconcile","days":2}` (created by `deploy.sh`). Two days
  of overlap covers a late-arriving judge result without re-reading history.
- Inline policy **`EvalResultsAccess`** on the shared
  `agentcore-hub-lambda-role`, added by `deploy.sh`: DynamoDB
  `PutItem`/`Query`/`BatchGetItem` on the results table and its `/index/*`,
  `logs:DescribeLogGroups`, and `logs:FilterLogEvents` on the results groups. It
  is a separate, additive document, so it never fights the `DynamoDBAccess`
  document that `deploy/setup-lambda-role.sh` writes.

#### Backfill

```bash
node deploy/continuous-improvement/backfill-results.mjs \
  --from YYYY-MM-DD --to YYYY-MM-DD [--dry-run] [--group <name>] [--region r]
```

One reconcile invoke per UTC day, printing per-day rows / duplicates / sessions
plus a total. Idempotent by construction (the conditional `PutItem` plus the `SET`
day-bucket rewrite), so re-running a range costs writes and changes nothing.
`--dry-run` first is the habit. **`backfill-daily.mjs` is now a deprecation stub
that exits 1** and points here.

#### Reader surfaces

The app reads this table through `src/lib/eval-results.ts` (query helpers for the
four access patterns; the opaque `cursor` is base64 JSON of the DynamoDB
`LastEvaluatedKey`) behind `GET /api/evaluations/timeseries`,
`/api/evaluations/results` and `/api/evaluations/sessions/<sessionId>`. See
[`docs/MODULES.md`](../../docs/MODULES.md) for the exact response shapes,
including the results-route pagination seam (a session can straddle a page
boundary; the session detail route is the authoritative per-session view).

### Human handoff: prod rollout steps, in order

The CI/CD pipeline ships Lambda **code only** — no `UpdateFunctionConfiguration`,
no `iam:*`, no table creation. Tables, IAM, env and schedules are operator-run
bash against the prod profile, in this order:

1. `bash deploy/continuous-improvement/deploy-all.sh` — creates the results table
   with PITR, and turns the `agentcore-hub-eval-daily` TTL off.
2. `bash deploy/continuous-improvement/deploy.sh` — packager env
   (`EVAL_RESULTS_TABLE`, `LEGACY_RESULTS_GROUPS_B64`), the `EvalResultsAccess`
   policy, and the reconcile schedule.
3. `bash deploy/continuous-improvement/deploy-token-aggregator.sh` — re-sets env
   without `DAILY_RETAIN_DAYS`.
4. `node deploy/continuous-improvement/backfill-results.mjs --from 2026-06-01 --to <today> --dry-run`,
   then the same command live.
5. Compare per-agent distinct sessions in the results table against the
   `evalSessionCount` on the eval-config rows. `evalSessionCount` is approximate
   under at-least-once delivery (see the concurrency model above), so expect
   close-but-not-equal; an order-of-magnitude gap means a log group the map or the
   backfill range missed.
6. `PUT /api/evaluations/agents/agentcore_hub_coding_runtime {enabled:false}` —
   the coding-runtime judge has no supported span scopes, so it fails 100% with
   `ValidationException`. It is DISABLED, not deleted (the existing route flips
   `executionStatus`), so the config and its results log group stay readable. See
   the `coding_runtime_configs` note in `deploy/evaluations/eval-config-ids.json`.
7. Confirm `agentcore-hub-eval-reconcile` fired once (rule metrics, or
   `EvalResultsDuplicate` on the packager's EMF record).

4. **S3 Batch Archive** (`fleet-imp-agent/batches/`):
   - The raw flushed batch (`{agentId, batchSize, flushedAt, sessions[]}`)
   - Named: `batch-<agentId>-<timestamp>.json`
   - **Distinct from the `prd/` prefix** — raw batches must NOT trigger prd-submitter

5. **Fleet Improver synthesis** (in `flushBuffer`, env `IMPROVEMENT_AGENT_ARN`):
   - eval-packager SigV4-invokes the Fleet Improver runtime with the batch
   - The runtime returns a JSON object `{ title, description }` (description is the markdown PRD)
   - `extractPrd` JSON-parses it (tolerates a stray code fence / prose; falls back to a generic title + raw body)
   - The PRD is written to `fleet-imp-agent/prd/prd-<agentId>-<timestamp>.json`
   - That `prd/` write is what triggers prd-submitter → workflow → PR
   - If the improver ARN is unset or the call fails, the batch is still archived
     (stage 4) and the buffer resets — the flush never wedges, it just skips the
     workflow trigger and logs a warning

## Agent ID Resolution

The packager Lambda resolves agent identity dynamically from `config/agents.json` stored in the artifacts S3 bucket:

1. On cold start, loads `s3://<ARTIFACTS_BUCKET>/config/agents.json`
2. Builds an `agentId` lookup set (cached for warm starts)
3. Extracts agent identifier from the CW Logs log group (substring after `eval_`)
4. Resolves to canonical agent ID by prefixing with `agentcore_hub_` (e.g., `frontend_dev` → `agentcore_hub_frontend_dev`)

This replaces the previously hardcoded `CONFIG_TO_AGENT` map, ensuring the packager stays in sync with the canonical agent registry.

### Agents Config Source of Truth

The file `src/config/agents.json` defines all agents with their:
- `agentId`: Canonical agent identifier (snake_case, e.g., `agentcore_hub_frontend_dev`). The runtime resource name is the same string.

## Enriched Batch Payloads

Each session in the S3 batch `sessions[]` array contains **parsed evaluator results**, not raw CW Logs event envelopes:

```json
{
  "agentId": "agentcore_hub_frontend_dev",
  "batchSize": 10,
  "flushedAt": "2025-01-15T10:30:00.000Z",
  "sessions": [
    {
      "logGroup": "/aws/bedrock-agentcore/evaluations/results/eval_frontend_dev",
      "logStream": "stream-id",
      "timestamp": "2025-01-15T10:29:55.000Z",
      "evaluatorResults": [
        {
          "timestamp": 1705312195000,
          "evaluatorName": "code-quality",
          "score": 0.85,
          "evidence": "Clean component structure, proper prop typing",
          "metadata": { "category": "maintainability" },
          "result": "pass"
        }
      ]
    }
  ]
}
```

This structure (archived under `batches/`) is what eval-packager sends to the
Fleet Improver runtime. The improver returns a JSON `{ title, description }`,
which `extractPrd` reads into the object written to `prd/`:

```json
{
  "title": "fix(agentcore_hub_frontend_dev): <top fix summary>",
  "description": "<full markdown PRD>",
  "agentId": "agentcore_hub_frontend_dev",
  "generatedAt": "2026-06-14T20:41:16.474Z",
  "sources": ["s3://<bucket>/fleet-imp-agent/batches/batch-...json"]
}
```

prd-submitter reads `title` + `description` from this object — which is why a
raw batch (no `title`/`description`) reaching `prd/` produced `[SI] undefined`
before this synthesis step existed.

## Deployment

### Prerequisites

- AWS CLI configured with appropriate credentials
- `jq` installed
- Access to the target AWS account

### Running

```bash
# Deploy with default region (us-east-1)
./deploy-all.sh

# Deploy to a specific region
./deploy-all.sh --region us-west-2
```

### What it does

1. **Creates the DynamoDB tables** with on-demand billing if they don't exist:
   - `agentcore-hub-eval-config` (PK `agentId`) — per-agent controls + session buffer
   - `agentcore-hub-eval-seen` (PK `dedupKey`) — the dedup seen-set, with TTL
     enabled on `expiresAt`.
   - `agentcore-hub-eval-daily` (PK `agentId`, SK `day`) — the day buckets, and it
     **disables** TTL on this table (permanent history).
   - `agentcore-hub-eval-results` (PK `agentId`, SK `sk`) — one row per judge
     result, with the `bySession` / `byPersona` / `byWorkflow` GSIs and PITR
     enabled. No TTL, ever.

   Every create, the TTL enable, the TTL disable and the PITR enable are
   idempotent: a re-run skips an existing table, an already-`ENABLED` TTL and an
   already-`DISABLED` one rather than aborting under `set -e`.
2. **Seeds one eval-config row per agent** from `src/config/agents.json` with default eval configuration:
   - `enabled: true`
   - `sampleRate: 100` (100%)
   - `batchSize: 10`
   - Empty `sessionBuffer`

The seed is idempotent — existing rows are not overwritten (`attribute_not_exists(agentId)` condition).

Run `deploy-all.sh` **before** `deploy.sh`: the latter points the eval-packager
Lambda's `EVAL_SEEN_TABLE` and `EVAL_RESULTS_TABLE` at the tables created here and
grants `EvalResultsAccess` against them (see the deploy-order comment at the top of
`deploy.sh`). Deploying the packager first means every results write fails on a
missing table.

### DDB Rows Created

| agentId | Source |
|---------|--------|
| agentcore_hub_requirements_analyst | agents.json |
| agentcore_hub_ios_designer | agents.json |
| agentcore_hub_backend_designer | agents.json |
| agentcore_hub_frontend_designer | agents.json |
| agentcore_hub_android_designer | agents.json |
| agentcore_hub_security_reviewer | agents.json |
| agentcore_hub_legal_compliance | agents.json |
| agentcore_hub_localization | agents.json |
| agentcore_hub_analytics_designer | agents.json |
| agentcore_hub_backend_dev | agents.json |
| agentcore_hub_api_dev | agents.json |
| agentcore_hub_frontend_dev | agents.json |
| agentcore_hub_qa_verifier | agents.json |
| agentcore_hub_ci_agent | agents.json |

## Troubleshooting

- **"Agents config file not found"**: Ensure you're running from the repo root or that the path `src/config/agents.json` is accessible relative to the script.
- **Agent not resolving**: Verify the agent's `agentId` in `src/config/agents.json` matches the CW Logs group suffix (after stripping the `agentcore_hub_` prefix).
- **Stale agent map**: The Lambda caches `agents.json` for warm starts. A cold start (redeploy or timeout) will reload it.
