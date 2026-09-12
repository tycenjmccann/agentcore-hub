# Performance Card

Every terminal workflow run gets a deterministic **performance card**: cost, time
and quality for that run, plus anomaly bands against the same workflow
definition's trailing baseline. The Workflow tab shows a fleet-level card (this
window vs the prior window, by agent, by engine, infra allocation) and a per-run
card on each finished run. No LLM is involved anywhere in the pipeline.

Since `reportVersion 5` the card also carries `kpi` — a single 0-100 **quality
score**, plus cost and wall-clock, each with its own anomaly band. Every weight,
tolerance, cap and grade threshold that produces it lives in one file,
`src/config/kpi.json` (`kpiVersion`), so the score is reproducible and sits
**alongside**, not instead of, the Workflow Manager's agent-authored assessment.
See "Hero KPIs" below.

**Version history** — `3`: baseline card schema. `4`: uncached-input pricing
(cache tokens no longer double-billed). `5`: the `card.kpi` contract
(deterministic quality score), `kpiVersion 1`.

## What is measured

| Group | KPI | Source |
|---|---|---|
| **Cost** | Total / persona LLM / coding CLIs, tokens in/out/cache-read/cache-write, persona cache hit rate, $ per task, by engine, by agent | Persona spans (`gen_ai.usage.*` on `aws/spans` + per-runtime span groups), Claude Code `api_request` events, Codex/Kiro `coding_usage` records; priced from `src/config/pricing.json` (Bedrock list, synced to S3 `config/pricing.json`) |
| **Time** | End-to-end wall-clock, human-gate wait (interval union), active (wall − human), agent work (Σ task durations), orchestration idle (active − work), utilization, per phase | Workflow record + events table |
| **Quality** | Agent tasks (+completed), rework rounds (re-invocations of a ticket), change requests (`review.rejected`), fix tickets, review-gate rounds, loops (= change requests + fix tickets), nudges, manager interventions, errors/retries, first-pass yield, CI verdict, PR, outcome, deterministic quality score (`kpi.quality`) | Events table (deduplicated — every event is written twice) + `reviewGateHistory` + `completions/{ticketId}.json` |
| **Infra** | AgentCore runtime compute / memory, network, storage, CloudWatch, platform, optional (evaluations, CodeBuild fleet, legacy App Runner); per-runtime GB·h/vCPU·h split; per-run allocation | Cost Explorer (trailing 30d, region-scoped) + `AWS/Bedrock-AgentCore` metrics, refreshed at most every 6h |

## Anomaly bands

For each banded KPI the baseline is the same `workflowDefId`'s cards that
completed in the prior 28 days (minimum 5). `sigma = max(1.4826·MAD, 10%·|median|, floor)`;
`z ≥ 2` → **warn**, `z ≥ 3` → **alert**. Most banded KPIs are lower-is-better
(a spike is the anomaly); the two `ratio` KPIs invert this — a **drop** is the
anomaly (`direction: lower`):

| Banded KPI | Path | Unit | Floor | Anomaly direction |
|---|---|---|---|---|
| First-pass yield | `quality.firstPassYield` | ratio | 0.1 | lower (a drop) |
| Persona cache hit rate | `cost.personaCacheHitRate` | ratio | 0.1 | lower (a drop) |
| Quality score | `quality.score` | count | 5 | lower |

The per-run card, the fleet view (`src/lib/workflow/performance.ts`) and the
Lambda (`lambda/cost-report/index.mjs`) share this arithmetic on purpose.

Per-run values are also published as CloudWatch metrics
(`AgentCoreHub/Performance`, dimension `WorkflowDefId`: `CostUsd`,
`PersonaCostUsd`, `CodingCostUsd`, `TokensTotal`, `WallHours`, `ActiveHours`,
`AgentWorkHours`, `HumanWaitHours`, `Tasks`, `ReworkRounds`, `Loops`, `Nudges`,
`Errors`, `QualityScore`) so CloudWatch anomaly-detection alarms can be attached
without touching the app. `QualityScore` is omitted for a run whose score is
null (insufficient evidence) — the existing finite-value filter drops it like
any other non-finite metric. Set `PUBLISH_CW_METRICS=0` on the Lambda to stop
publishing.

## Hero KPIs — `card.kpi` v1

`card.kpi` puts the three hero numbers — cost, wall-clock, quality — in one
place with a config-driven quality **score**, so a reader never has to
recompute or reconcile them from the card's other sections.

### Contract

| Field | Type | Nullable | Source |
|---|---|---|---|
| `version` | int | no | `config.kpiVersion` (`src/config/kpi.json`) |
| `computedAt` | ISO string | no | `card.generatedAt` |
| `cost.usd` | number | yes, when `dataQuality.costMissing` | `card.cost.totalUsd` |
| `cost.band` | `"ok"\|"warn"\|"alert"\|"insufficient"\|"unknown"` | no | `bands.kpis["cost.totalUsd"]`, copied by `stampKpiBands` |
| `cost.z` | number | yes | same, `null` on a thin baseline |
| `time.wallMs` / `time.activeMs` / `time.humanWaitMs` | number | no | `card.time.*` verbatim |
| `time.band` / `time.z` | as cost | as cost | `bands.kpis["time.wallMs"]` |
| `quality.score` | int 0-100 | yes (`confidence: "insufficient"`) | `computeKpi` |
| `quality.grade` | `"A"\|"B"\|"C"\|"D"\|"F"` | yes | `config.grades`, first entry with `score >= min` |
| `quality.confidence` | `"full"\|"partial"\|"insufficient"` | no | evidence weight vs. 100 / `minEvidenceWeight` |
| `quality.evidenceWeight` | 0-100 | no | Σ weight of the included components |
| `quality.outcome` | string | yes | `card.run.outcome` |
| `quality.band` / `quality.z` | as cost | as cost | `bands.kpis["quality.score"]` |
| `quality.components[]` | array | — | one entry per configured component: `{key, label, weight, raw, normalized, points, included, note}` |
| `quality.excluded[]` | array of component keys | — | components with no usable evidence this run |
| `quality.capsApplied[]` | array | — | `{kind:"outcome", outcome, cap}`, recorded only when the cap actually lowered the score |

All three bands read `"unknown"` until `stampKpiBands` runs (needs the fleet
index) and `"insufficient"` on a workflow def with too few prior runs to band
against (no `z` in that case).

`quality.ci` — the CI verdict the `ci` scoring component reads — lives on
`card.quality.ci`, not inside `card.kpi`:

```
quality.ci = { verdict: "pass" | "fail" | "unknown", source: string, ticketId: string | null }
```

Derived, never asserted by an agent's prose. Rules, first match wins:

1. **fail** / `fix-ticket:ci-open` — a CI-fix ticket (`spawnedBy.kind === "ci_fix"`
   or a title matching `/^Fix \(CI\)/i`) is still open (not complete/done) at the
   terminal state.
2. **pass** / `completion:certified` — the CI agent's own ticket's completion
   record has `ci_status === "certified"`.
3. **pass** / `completion:github-actions-proxy` — same record,
   `ci_status === "github-actions-proxy"`.
4. **pass** / `merge-commit` — any task has a non-empty `mergeCommit`, or
   `outcome === "shipped"`.
5. **unknown** / `completion:unverified` (`ci_status === "unverified"`), or
   `none` (no CI ticket, no record, or a read error — recorded as a
   `dataQuality.gaps` entry, never thrown).

The CI agent's ticket is chosen among entries with
`agentId === "agentcore_hub_ci_agent"`: latest `completedAt` wins, ties break on
ascending `ticketId`. `static-ci-only` is **never** mapped to `fail` — it is a
run that never claimed a CI build, not one that failed it. `quality.ci` is not
added to `summarize()`.

### Formula

Six weighted components, config order, each independently normalized to
`[0, 1]` before clamping — a run out past its tolerance shows a negative
`normalized` (visible on the card) even though the points it earns are clamped
to 0:

| Component | Weight | Kind | Source | Tolerance / params |
|---|---|---|---|---|
| `firstPass` | 30 | ratio | `quality.firstPassYield` | — |
| `rework` | 20 | rate | `quality.reworkRounds` / `quality.tasks` | 0.6 |
| `loops` | 20 | count | `quality.loops` | 8 |
| `stability` | 15 | sum | `quality.errors` + `quality.nudges` + `quality.interventions` | 6 |
| `gates` | 10 | excess | `max(0, quality.gateRounds − time.humanGates)` | 4 |
| `ci` | 5 | verdict | `quality.ci.verdict` (`pass`→1, `fail`→0; `unknown`/`null` neutral) | — |

Per-kind normalization, and when a component is excluded rather than scored:

| Kind | Raw | Normalized | Excluded when |
|---|---|---|---|
| `ratio` | `get(source)` | `raw` | raw is null / non-finite |
| `rate` | `get(source) / get(per)` | `1 − raw / tolerance` | `per` is 0/null/non-finite, or source is null |
| `count` | `get(source)` | `1 − raw / tolerance` | raw is null / non-finite |
| `sum` | `Σ get(s)` over sources | `1 − raw / tolerance` | every source is null |
| `excess` | `max(0, get(source) − get(baseline))` | `1 − raw / tolerance` | source or baseline is null |
| `verdict` | `get(source)` (string) | `values[raw]` | `raw` is in `neutralOn` (`"unknown"`/`null`), or not a key of `values` |

`points = round4(weight × clamp(normalized, 0, 1))`.

1. `evidenceWeight` = Σ weight of the included components. If it is below
   `config.quality.minEvidenceWeight` (**51**) there is no honest number to
   report: `confidence: "insufficient"`, `score: null`, `grade: null`,
   `capsApplied: []` — stop here.
2. `score = round_half_up(100 × Σ points_unrounded / evidenceWeight)`, where
   `round_half_up(x) = Math.floor(x + 0.5)` — written explicitly (not
   `Math.round`) so a tie always rounds up, including negatives.
3. If `outcome` is a key of `config.outcomeCaps`
   (`deploy-blocked` / `static-ci-only` / `error` / `cancelled` → **69**) and
   `score > cap`: record `{kind:"outcome", outcome, cap}` in `capsApplied` and
   set `score = cap`. Recorded **only** when the cap actually lowered the
   score — a run that scored 40 anyway is not "capped".
4. `confidence = evidenceWeight === 100 ? "full" : "partial"` (already
   `"insufficient"` was handled at step 1).
5. `grade` = the first `config.grades[]` entry with `score >= min`
   (A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F ≥ 0).

Computed by `computeKpi(card, config)` — pure, no clock/I/O/randomness, same
card in ⇒ same object out, forever. R-3: every weight, tolerance, cap and grade
threshold lives only in `src/config/kpi.json`; the scorer's only numeric
literals are `0`, `1` and `100`.

### Worked example

Run `wf_example`, outcome `complete`. Inputs: `tasks 18`, `reworkRounds 3`,
`firstPassYield 15/18 = 0.8333333`, `changeRequests 1`, `fixTickets 2`
(`loops 3`), `errors 1`, `nudges 1`, `interventions 0`, `gateRounds 3`,
`humanGates 2`, `ci.verdict "pass"`.

| Component | raw | normalized | × weight | points |
|---|---|---|---|---|
| firstPass | 0.8333333 | 0.8333333 | × 30 | **25.0000** |
| rework | 3 / 18 = 0.1666667 | 1 − 0.1666667/0.6 = 0.7222222 | × 20 | **14.4444** |
| loops | 3 | 1 − 3/8 = 0.6250000 | × 20 | **12.5000** |
| stability | 2 | 1 − 2/6 = 0.6666667 | × 15 | **10.0000** |
| gates | max(0, 3−2) = 1 | 1 − 1/4 = 0.75 | × 10 | **7.5000** |
| ci | "pass" | 1.0 | × 5 | **5.0000** |

`Σ points = 74.4444` → **score 74, grade C**, `confidence "full"`,
`capsApplied []`.

- **CI unknown:** `ci` excluded → `100 × 69.4444 / 95 = 73.1` → **73 / C /
  partial / excluded ["ci"]**.
- **Outcome `deploy-blocked`:** `min(74, 69)` → **69 / D**,
  `capsApplied: [{kind:"outcome", outcome:"deploy-blocked", cap:69}]`.
- **Clean run** (fpy 1.0, no rework/loops/signals, `gateRounds === humanGates`,
  CI pass) → **100 / A**.

The card itself stores `firstPassYield` through `round4` (`0.8333`, not the
unrounded `15/18 = 0.8333333` used above), so the *actual* `firstPass` points
are `24.999` rather than `25.0000` and `Σ points = 74.4434444` rather than
`74.4444` — still `floor(74.4434444 + 0.5) = 74` → **74/C**, the same result.
This is `lambda/cost-report/fixtures/kpi-cases.json`'s `worked-example` case
verbatim; do not "fix" the rounding to make the two arithmetics match — the
card's stored precision is the correct input, and the score is unaffected.

## Artifacts

| Where | What |
|---|---|
| `s3://{ARTIFACT_BUCKET}/workflows/{wfId}/shared/performance-card.json` | Full card (schema `reportVersion: 5`), incl. `kpi` |
| `…/shared/performance-card.md` | Human-readable card, visible in the artifact viewer |
| `…/shared/cost-report.json` | Alias of the JSON for older readers |
| `s3://{ARTIFACT_BUCKET}/performance/index.json` | Fleet index: compact summary per run + infra snapshot |
| `s3://{ARTIFACT_BUCKET}/config/kpi.json` | Advisory copy of `src/config/kpi.json`, synced by `deploy.sh`; the Lambda never loads it from S3 (see Operate) |
| `lambda/cost-report/kpi.json` | Git symlink (mode `120000`) → `../../src/config/kpi.json` — one file, no copy, so the deployed zip and the repo's config can never drift apart |
| events table `type: workflow.performance` | Per-run summary row with `status` and `anomalies` (dashboards, Workflow Manager) |

## Surfaces

- `GET /api/workflow/performance?days=7|14|30&defId=all|<id>` → fleet view
- `GET /api/workflow/performance?workflowId=<id>` → one run's card
- `POST /api/workflow/performance` → on-demand card generation. Body
  `{workflowId}`; `202 {accepted, workflowId, pollAfterMs:3000}` when a build
  was kicked off, `200 {card}` when one already exists, `400` bad body, `404`
  unknown workflow, `409 {error:"run is not terminal"}`,
  `429 {error, retryAfterMs, pollAfterMs}` when one is already in flight for
  that workflow (per-task in-flight dedupe), `500` a static error body.
  Invokes the Lambda with `InvocationType: "Event"`.
  **Forward-documentation**: this route is implemented by the sibling
  TEAM-4477 api ticket on the same integration branch, not by this one — it is
  documented here so the contract is visible before it lands.
- Workflow tab, no run selected → fleet `PerformanceCard`; terminal run selected → `RunPerformanceCard`

The Workflow Manager toolkit (`deploy/workflow-manager/toolkit/`) is also a
consumer: `compute_metrics.py` is **card-first** when a run has a
`reportVersion >= 5` card — it cites the card's own numbers instead of
recomputing them, setting `metrics.source = "performance-card@v5"`,
`metrics.kpi` (verbatim), and `metrics.kpiVersion`; `save_analysis.py` persists
that `kpiVersion` on the analysis row. See `docs/workflow-pipeline-architecture.md`
and the `run-analysis` skill for how the agent is told to use it.

## Operate

```bash
./lambda/cost-report/deploy.sh                             # code + env + IAM (PutMetricData, GetMetricData, ce:GetCostAndUsage) + reserved concurrency
./lambda/cost-report/deploy.sh --rebuild-index             # + rebuild index, recompute every card's bands, refresh infra
./lambda/cost-report/deploy.sh --backfill                  # + regenerate a card for every terminal run completed in the last 90 days
./lambda/cost-report/deploy.sh --backfill --since-days 0   # + regenerate a card for EVERY terminal run ever (0 = no cutoff)
aws lambda invoke --function-name agentcore-hub-cost-report --payload '{"workflowId":"wf_…"}' /dev/stdout   # one run
```

`--backfill` defaults to the last 90 days (`--since-days N` to change the
window, `0` for everything); it always chains into `--rebuild-index` so the
fleet index reflects the regenerated cards. The Lambda's reserved concurrency
is floored at 5 (`COST_REPORT_RESERVED_CONCURRENCY` to override) because
`--backfill` fans out via `xargs -P 5` sync invokes.

Trigger in production is the EventBridge rule `agentcore-hub-cost-report-trigger`
on `workflow.complete`.

A run whose telemetry produced no cost at all still gets a card — its time and
quality are real, only the cost KPIs abstain. `dataQuality.costMissing` is set
(existing gap text unchanged), `kpi.cost.usd` is `null`, and the run is
excluded from the cost anomaly baseline (`bands.baseline.nCost`) while still
counting toward the time/quality baseline (`bands.baseline.n`) — a run with no
priced spans is not evidence about cost, but it is still evidence about how
long the run took and how clean it was. The fleet view's own validity filter
(`src/lib/workflow/performance.ts`) is a separate surface owned by the sibling
TEAM-4477 api ticket on the same branch; whether it relaxes to match is that
ticket's call, not this doc's.

`kpi.json` never loads from S3 — `KPI_CONFIG` is read once from the file next
to `index.mjs` at cold start (`readFileSync`, `KPI_CANDIDATES`), so the S3 copy
under `config/kpi.json` is advisory only, for other readers.

**R-5**: any edit to a weight, tolerance, cap, threshold or `minEvidenceWeight`
in `src/config/kpi.json` must bump `kpiVersion` **and** `REPORT_VERSION`
**and** be followed by `--backfill`. Without the `REPORT_VERSION` bump,
`rebuildIndex` keeps every old card as current and the fleet silently mixes
scores from two different rubrics; `--backfill` is what actually re-scores the
historical runs under the new one.

## Prompt caching

Personas run with Bedrock prompt caching (TEAM-3953): the system prompt + tool
schemas are cached with a `cachePoint`, so repeated turns re-read the cached
prefix instead of re-billing it as fresh input. Two runtime knobs control it
(set on the fleet runtime agents; see `deploy/runtime-agent/DEPLOY.md`):

| Env var | Default | Meaning |
|---|---|---|
| `PERSONA_PROMPT_CACHE` | `1` (default on) | Bedrock prompt caching for the persona system prompt + tools; set `0` to disable |
| `PERSONA_CACHE_TTL` | `1h` (`5m`\|`1h`, default `1h`) | Prompt-cache TTL; invalid values warn and fall back to `1h` |

**Cache-aware pricing** (from `src/config/pricing.json`, `reportVersion: 3`):

- **Cache reads** are billed at the model's input rate × `cachedInputDiscount`
  (`0.1×`) — a cached input token costs a tenth of a fresh one.
- **Cache writes** are billed at the input rate × `cacheWriteMultiplier`, keyed
  by the span's `hub.cache_ttl`: `5m → 1.25×`, `1h → 2×`, `default → 1.25×`
  (used when the ttl is absent/unknown, e.g. coding-CLI usage records).
- `inputTokens` excludes cached tokens; cache-read and cache-write tokens are
  tracked separately and all three are totaled into `tokens.total`.

**Card / summarize fields** — each engine and `byModel` bucket carries
`cacheRead` and `cacheWrite` (input tokens); the card exposes `cost.cacheHitRate`
(fleet/engine) and `cost.personaCacheHitRate` (persona spans only). Hit rate =
`cacheRead / (input + cacheRead + cacheWrite)`, and is `null` when the
denominator is 0 (no traffic to rate).

## Known limits

- Infra allocation is trailing-30d spend ÷ terminal runs in that window; it is
  an average, not a per-run measurement.
- Codex/Kiro per-turn usage exists only for runs after the coding-runtime usage
  patch (2026-09-01); earlier runs under-report coding-CLI cost.
- `quality.score` reflects `minEvidenceWeight` (51): a run missing more than
  about half the scoring evidence (e.g. `tasks 0`, no CI record) gets
  `confidence: "insufficient"` and a `null` score rather than a guess — that is
  a signal in itself, not a data gap to fill.
