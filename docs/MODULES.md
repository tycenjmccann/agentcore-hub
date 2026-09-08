# Modules

AgentCore Hub is built as a small **always-on core** plus a set of **optional
feature modules** ("bolt-ons"). Every navigable surface is namespaced — its UI
routes, API routes, Lambdas, and DynamoDB tables live under predictable paths —
so you can deploy only the modules you want and cherry-pick the rest out without
breaking the core.

This is verified, not aspirational: with the Workflow surface removed (and again
with the Evaluations surface removed), the remaining app still passes
`npx tsc --noEmit` and `npm run build`. See [Removing a module](#removing-a-module).

---

## Core vs. optional

| Module | Required? | What it is |
| --- | --- | --- |
| **Core** | Always | Dashboard, Agents browser, Invoke console, region switching, AgentCore runtime discovery/traces. |
| **Builder** | Optional | The `/build` page + builder-tools Lambda for scaffolding agents. |
| **Workflow** | Optional | Multi-agent orchestration pipeline: intake → requirements → design → development → verification → review, with Jira + ticket tracking. |
| **Evaluations** | Optional | Self-improvement loop: ingests AgentCore evaluation results from CloudWatch Logs, buffers them, and feeds an improver agent. |
| **Registry** | Optional | Browse/manage the Amazon Bedrock AgentCore Registry — catalogs of registries and their records (MCP servers, A2A agents, custom resources, agent skills) with an approval lifecycle. |
| **Cloud Code** | Optional | "Safe to close your laptop" coding agent — Claude Code / Codex run server-side on a dedicated AgentCore Runtime with an EFS workspace; chat (streaming) + a live terminal, resumable from any device. |
| **Routines** | Optional | The `/routines` page — scheduled/recurring workflow runs built from a chat-based routine builder (`lambda/routines-runner`, `deploy/routine-builder/`). |
| **Connectors** | Optional | The `/connectors` page — reusable connector primitive for external services (secrets in Secrets Manager, LLM-blind; `deploy/connectors/`). |
| **Pipeline** | Optional | AWS-native CI/CD (CodeBuild + CodePipeline) for a repo the hub builds into, with agent-driven CD via `Pipeline___*` tools and a human deploy gate. See [Module: Pipeline](#module-pipeline-optional). |

The core never imports from an optional module. Optional modules may share core
libraries (`src/lib/agentcore-sdk.ts`, `src/lib/client-cache.ts`, etc.) and the
shared `src/config/agents.json` roster, but not each other. Nav entries are
declared in a single registry (`src/config/modules.ts`) so removing a module is
a one-place edit. One tolerated soft seam exists between two optional modules:
Workflow's `WorkflowBoard.tsx` polls the Pipeline module's `/api/pipeline/status`
for the deploy-gate banner, with a silent catch so the board works unchanged when
the Pipeline module is absent.

---

## Module: Workflow

The orchestration pipeline. Self-contained surface.

**UI routes**
- `src/app/workflow/` — pipeline board + detail views
- `src/app/tickets/` — ticket history

**API routes**
- `src/app/api/workflow/` — start/state/list/events/stream/cancel/retry/artifacts/webhook/agent-output/complete/nudge/performance (plus definitions, tickets, watch, escalations, analysis under `[id]/`)
- `src/app/api/workflow/cd-registry/` — the **CD registry** (which repos the hub merges + deploys): GET list / `?repo=` lookup, POST upsert, DELETE remove → `s3://ARTIFACT_BUCKET/config/cd-registry.json`
- `src/app/api/jira/` — Jira webhook + metrics
- `src/app/api/models/` — model picker (used only by the workflow intake form)

**Frontend code**
- `src/components/workflow/`
- `src/lib/workflow/` (~30 modules: types, ticket providers (`ticket-provider*.ts`), board state, leases, ship-review, event transforms, jira-client, model-config, watchdog, performance (fleet performance card — see `docs/performance-card.md`), …)
- `src/lib/pipeline-config.ts`
- `src/lib/cd-registry.ts` (core lib, no module imports) + `src/config/cd-registry.json` (first-deploy seed; ships empty) — mirror of `lambda/orchestrator/cd-registry.mjs`. Unregistered repo = **handoff**: no Ship / Merge Approval / CD tickets, the orchestrator opens the unified PR at completion and leaves it open for the owning team (`workflow.delivery = { mode: "handoff", prUrl }`). Registered = full ship phase; an entry with a `pipeline` also turns on Pipeline Mode for that repo's agents.

**Lambdas** (`lambda/`)
- `orchestrator` — drives the pipeline state machine
- `agentcore-hub-jira` — Jira Cloud ticket tools (deployed when `TICKET_PROVIDER=jira`)
- `agentcore-hub-tickets` — DynamoDB-backed ticket tools (deployed when `TICKET_PROVIDER=dynamodb`)
- `workflow-output` — collects agent artifacts
- `cost-report` — per-run performance card (cost / time / quality + anomaly bands) on `workflow.complete`; writes `workflows/{id}/shared/performance-card.{json,md}`, `performance/index.json`, `workflow.performance` events and `AgentCoreHub/Performance` CloudWatch metrics (`docs/performance-card.md`)

**DynamoDB tables** (defaults in `deploy/config.sh`)
- `agentcore-hub-workflows` (`WORKFLOWS_TABLE`)
- `agentcore-hub-events` (`EVENTS_TABLE`)
- `agentcore-hub-tickets` (`TICKETS_TABLE`)

**Deploy scripts**
- `deploy/setup-tickets-lambda.mjs` and the orchestrator/Jira/output Lambdas
- `lambda/cost-report/deploy.sh` (`--backfill` / `--rebuild-index`)

**`agents.json` fields it reads**
- `harnessName` — maps an agent to its AgentCore runtime via the `RUNTIME_ARN_<HARNESS_NAME_UPPER>` convention
- `runtimeArn` — optional explicit ARN; when `null`, the orchestrator resolves the runtime from the env var above

**Env vars** — `WORKFLOWS_TABLE`, `EVENTS_TABLE`, `TICKETS_TABLE`, `ARTIFACT_BUCKET`,
`RUNTIME_ARN_<HARNESS>` (one per agent harness), `LAMBDA_ROLE_ARN`; performance card:
`PERFORMANCE_INDEX_KEY` (default `performance/index.json`), `PUBLISH_CW_METRICS`, `INFRA_REGION`;
intake source validation: `SOURCE_VALIDATION_MODE` (`lenient` default | `strict`, see `src/lib/workflow/intake.ts`).

**Verdict gate flags (TEAM-4246 D1, `lambda/orchestrator/`)** — three independent
`off | shadow | enforce` flags, same convention as `LIVE_REVERIFY`: unset defaults
to `shadow`, an unrecognized value falls to `off` (a typo must not silently
enforce a hold). `shadow` only publishes the "would have…" observation event
below and changes no ticket state; `enforce` writes the hold/block described.
The single prose→verdict ladder they all read lives in the zero-import
`lambda/orchestrator/verdict-contract.mjs` (`GATE_PERSONAS`, `VERDICTS`,
`deriveVerdict`) — never duplicated elsewhere in this Lambda.
- `VERDICT_GATE` — a gate persona's (`code_reviewer`/`qa_verifier`/`ci_agent`/
  `release_manager`) non-`PASS` completion holds its cascade successor on the
  fix ticket(s) it spawned, or — if it spawned none — on an orchestrator-filed
  `kind:"gate"` re-verify ticket instead (`live-reverify.mjs`), so a gate refusal
  with no fix ticket still blocks something.
- `FIX_BEFORE_VERIFY` — a new fix ticket (`spawnedBy.kind` in `FIX_KINDS`) blocks
  the run's open QA/CI siblings at ticket-creation time, so a verifier is never
  dispatched against code a filed-but-unstarted fix has not touched yet.
- `VERIFIED_HEAD_COMPLETION` — `completeWorkflow`'s gate #3: refuses to close the
  run while QA's, CI's, and the shipped commit's heads disagree, or while any
  fix ticket under the epic is still open in no required phase. `enforce` holds
  completion and, on a head disagreement, files one stale-gate re-verify per
  stale persona; the TS twin (`src/lib/workflow/verified-heads.ts`, used by
  `POST /api/workflow/[id]/complete`) applies the identical predicate so the
  human-driven completion route cannot bypass it. `heads.pr` is derived locally
  — the latest recorded `commitSha` among done non-gate-persona tasks — never a
  GitHub call, since the PR does not exist yet at this gate and the gate must
  stay replayable offline.

**Sweep detection flag (TEAM-4247 D2, `lambda/orchestrator/`)** — same
`off | shadow | enforce` convention as the three above (unset → `shadow`,
unrecognized → `off`), normalized by the same `normalizeVerdictMode`.
- `SWEEP_DETECTION_PHASE` — a `dead-code-sweep` run whose **detection** ticket
  completes with `verified_removable: 0` (a strict integer 0; absent is not a
  zero yield) has no work left to do. `enforce` closes the run as the terminal
  outcome `nothing-to-remove` — labels the PR `sweep:no-op` if one exists,
  publishes `workflow.nothing_to_remove`, and **skips the cascade for that
  ticket** so no reviewer / QA / CI / release manager is ever dispatched against
  a branch that does not exist (the `agent.complete` publish still happens first,
  so the stream reads ticket-done → run-closed). `shadow` publishes
  `sweep.detection_observed` and behaves exactly as today.
- The sweep def's `completionRequiresAgentPhases` lists `"detection"`, but
  `stripUnenforcedDetectionPhase` (`lambda/orchestrator/index.mjs`) removes it
  from the **effective** def unless this flag is `enforce` — the same
  flag/context-conditional pattern as `cd-registry.mjs`'s `stripShipPhases`.
  Without the strip, every sweep run would hang the moment the config synced,
  because nothing else requires the detection ticket to exist yet. The def's
  `phases[]` is **never** stripped: the analyst must still plan and stamp the
  detection ticket under `shadow`, or `shadow` observes nothing.
- **Deploy order matters, because config and code ship separately.** The
  detection phase only exists for the Lambdas once
  `s3://$ARTIFACT_BUCKET/config/workflows.json` carries it (read on cold start,
  no redeploy). The CD deploy stage
  (`deploy/pipeline/buildspec-deploy.yml`) and `deploy/runtime-agent/deploy-topology.sh`
  both do this copy; deploying by hand it is DEPLOY.md step 2:
  `aws s3 cp src/config/workflows.json "s3://$ARTIFACT_BUCKET/config/workflows.json"`
  (`ARTIFACT_BUCKET` from `deploy/config.sh` — never hardcoded). Order: ship the
  orchestrator code → sync `workflows.json` → only then set
  `SWEEP_DETECTION_PHASE=enforce`. Flipping the flag first makes `enforce`
  unreachable (no detection phase, so the gate never matches); syncing the config
  first is harmless (the strip keeps the phase non-required).

**Sweep cadence gate (TEAM-4247 D2, `SWEEP_CADENCE_GATE`)** — the one flag in
this family that lives on the **Next.js service**, not the orchestrator Lambda:
it is read by `POST /api/workflow/start` (`src/lib/workflow/sweep-cadence.ts`),
so it goes in the App Runner / ECS task env (both `deploy/apprunner/deploy.sh`
and `deploy/ecs-express/deploy.sh` forward it when set), never in
`lambda/orchestrator/deploy.sh`. Same three modes, same `shadow` default, same
garbage → `off` rule.
- A **scheduled** `dead-code-sweep` start is skipped when the same repo was swept
  less than 14 days ago (`recent-sweep`) or still has an open sweep PR
  (`open-sweep-pr`, matched on head branch / title / labels — see the match rule
  in `sweep-cadence.ts`). `enforce` answers **HTTP 200**
  `{ status: "skipped", reason, evidence }` — a skip is a successful no-op, and
  the routines-runner treats 4xx as a terminal filing failure — and writes one
  tombstone plus one `workflow.skipped` event. `shadow` runs both checks,
  publishes `sweep.cadence_observed { wouldSkip, evidence, repo, defId }`, and
  starts the run as today. `off` scans and probes nothing.
- The gate runs **above** the dedup marker and every create, so a skip leaves no
  epic, no tickets and no run row — nothing to clean up.
- Only `trigger: "scheduled"` is gated. `lambda/routines-runner/index.mjs` stamps
  it on every schedule tick; the "Run now" route
  (`src/lib/routines/payload.ts`, `{ trigger: "manual" }`) and the SI
  `prd-submitter` (`"autonomous"`) are never cadence-skipped, and an ad-hoc API
  call with no `trigger` is likewise treated as deliberate.
- The tombstone is **not a run**: PK `skip_<owner-repo>_<yyyymmdd>` (deterministic,
  written with `attribute_not_exists`, so a repeat tick the same day writes
  nothing and reports the same skip), `type: "skipped"`, `deleted: true`,
  `phase: "cancelled"`, `skipReason: "sweep-cadence"`, plus `reason`, `evidence`,
  `repo`, `defId`, `at`. `deleted: true` is load-bearing — it keeps the row out of
  `listWorkflowsFromDynamo` and out of `cost-report`'s terminal scan, so a skip
  can never appear as a zero-cost run on a performance card. `type: "skipped"`
  keeps it out of the gate's own cadence evaluation (a skip must never be the
  evidence for the next skip).
- The open-PR probe needs `GITHUB_PAT` and **fails open**: with no token, a rate
  limit or a 5xx, `evidence.prProbe` records `{ probed: false, reason }` and only
  the cadence half decides. An expired token degrades to cadence-only, never to
  "no sweeps ever again". The cadence read is a **filtered, projected, paginated
  Scan** of the workflows table (no def GSI exists) — acceptable for a handful of
  scheduled starts a week, off the hot human path; a very large workflows table
  would want an index.

**Ticket-plan + decision flags (TEAM-4248 D3)** — two more `off | shadow | enforce`
flags, same convention, different defaults, and the first one in this family that
is read by **four** Lambdas.
- `TICKET_PLAN_VALIDATOR` (unset → `shadow`, unrecognized → `off`) — read by
  `lambda/orchestrator/`, `lambda/workflow-output/`,
  `lambda/agentcore-hub-jira/` **and** `lambda/agentcore-hub-tickets/`, because
  `Tickets___create_ticket` is served by whichever provider Lambda the fleet points
  at (`deploy/runtime-agent/deploy-one.sh` ships `TICKET_TOOLS_LAMBDA=agentcore-hub-jira`
  by default, so a tickets-only copy would be a production no-op). The rule module
  `ticket-plan-validator.mjs` is zero-import and **byte-copied to all four**,
  guarded by a `cmp` block in `scripts/check-fix-kinds-parity.sh` — edit the
  orchestrator copy and `cp` it to the other three in the same commit. Two checks:
  a non-advisory, non-fix ticket with an empty `blocked_by` while the requirements
  root is still open (the root is found by **role** — `agentcore_hub_requirements_analyst`
  or `phase: "requirements"` — never by position, since a submitted plan does not
  contain its own root), and a branch token that is neither known nor
  `feature/<ticketId>-<persona-slug>`. `shadow` warns (a `warnings[]` on
  `submit_ticket_plan`, a `warning` field on the created ticket) and still writes;
  `enforce` rejects before anything is minted. No root resolvable → **fail open**,
  silently. The branch rewrite is **context-only in both modes** — the orchestrator
  never rewrites a stored description, only the prompt it renders. Non-`off` also
  renders `## Branch` for **every** persona (with a "you do not push to this
  branch" note off the development phase), because the reviewer, QA and CI are
  exactly the personas that previously had to guess.
- `DECISION_LEDGER` (unset **and** unrecognized → `shadow`) — orchestrator only,
  and the one flag in the family whose unknown mode still **writes**: losing a
  human decision is the defect, and an empty ledger would give an `enforce` flip
  nothing to check (the same argument `gateRejectionAdmitted` makes in code).
  `shadow` and `enforce` both extract resolutions from gate comments
  (`extractGateDecisions` in `lambda/orchestrator/artifact-chain.mjs`), append them
  idempotently **by id** to `.sdlc/<workflowId>/decisions.md` on the run's feature
  branch via a new `githubPutFile` (`PUT /contents`, the read `sha` as the CAS
  token, one retry on 409/422, then warn and fail open), mirror the same bytes to
  `workflows/<id>/shared/decisions.md`, publish `decision.recorded`, lead the
  review package with a `Decisions not honoured` section, and emit
  `## Gate Decisions (REQUIRED checklist)` to design-phase personas and the Plan
  ticket. A decision counts as honoured when the artifact cites its id, or cites
  the gate key **and** the concern number — so a `## Deviations` row naming the id
  passes; the rule is "cite it or deviate from it explicitly", never "obey it".
  `enforce` adds one thing: when an artifact cites none of the open decisions the
  gate is **withheld** rather than presented — `handleReviewRejection` reopens the
  authoring ticket, no human is paged, and `gateStates` is left **untouched**
  (`markGateRequested` / `markGateRejected` / `appendReviewNotificationOnce` are
  all skipped, so the human's later genuine Request-changes on the re-presented
  gate cannot be dropped as a duplicate under `GATE_STATE_GUARD=enforce`).
  `off` is byte-identical to pre-D3: nothing read, written or published.
  Needs `contents: write` on `GITHUB_PAT`; a read-only token degrades to the S3
  mirror plus a warning, never to a failed run.
- **Deploy order, same reason as `SWEEP_DETECTION_PHASE`:** the `decisions.md`
  chain member lives in `src/config/workflows.json`, which the Lambdas read from S3
  on cold start. Ship the code → `aws s3 cp src/config/workflows.json
  "s3://$ARTIFACT_BUCKET/config/workflows.json"` (`ARTIFACT_BUCKET` from
  `deploy/config.sh` — never hardcoded) → only then set the flags. Syncing the
  config first is harmless: `decisions.md` is owed by nobody (see the chain note
  below), so it can never block a ticket.

**`decisions.md` joins the playbook artifact chain (TEAM-4248 D3)** — the playbook
overlay's `artifactChain.artifacts` gains `{ name: "decisions.md", owner:
"orchestrator" }` after `intent.md`, making the chain
`intent.md → decisions.md → spec.md → design/<agent>.md → plan.md → findings.md`.
It has **no `gate`** and is deliberately absent from `requiredArtifactsForTicket`
(`src/lib/workflow/workflow-defs.ts`), so `enforceArtifactChain` can never send a
ticket back to Blocked over a file only the orchestrator writes. `"orchestrator"`
is a new `owner` value — the field is a plain `string`, so no type change was
needed. The visible effect is one line: every persona's `chain:` context now names
it, which is what makes the checklist citable.

**The `nothing-to-remove` terminal outcome (TEAM-4247 D2)** — a sixth terminal
`WorkflowPhase`, deliberately **not** folded into `SHIP_BLOCKED_OUTCOMES`: a no-op
sweep is a healthy run, not a blocked one, so it must not enter the ship-verdict
gates, the blocked-run EventBridge rule or the blocked-run alerting.
- Source of truth `NO_OP_OUTCOMES` in `src/lib/workflow/types.ts`, spread into
  `TERMINAL_PHASES`. Hand-written mirrors in `lambda/orchestrator/completion.mjs`,
  `lambda/workflow-analyzer/index.mjs`, `lambda/anomaly-watcher/index.mjs`,
  `lambda/cost-report/index.mjs`, four `api/workflow/**` routes and
  `deploy/workflow-manager/toolkit/run_outcomes.py` (the ONE Python copy —
  `save_analysis.py` and `compute_metrics.py` both import it). All of them are
  bound together by `src/lib/workflow/run-outcome-parity.test.ts`; add a value
  there and to every mirror in the SAME commit.
- **Excluded from every baseline** (FR-D2.8): a run with no work in it cannot be
  the comparator that defines "anomalous", and a fleet swept on a cadence that
  keeps finding nothing would otherwise halve the median and widen sigma until a
  genuine cost blow-out stopped alerting. `cost-report`'s `isBaselineEligible`,
  `buildFleetView`'s `baseline` slice (`src/lib/workflow/performance.ts`) and the
  toolkit's `baseline_analyses` all drop it. The **current** window keeps it — the
  run happened and cost money, so it is still listed, still in the totals, still
  carded (`status: "ok"`, `noOp: true`). Consequence: a no-op card publishes **no**
  `workflow.performance` event, so anything counting runs by that event
  under-counts them by design.
- **Yield-aware gate depth (FR-D2.6)** — when a zero-yield sweep runs on anyway
  (the flag is `off`/`shadow`, or the close's CAS was lost), the diff is a
  candidate ledger with no deletions in it. `sweepYieldNote` puts ONE ≤200-char
  line into the QA verifier's and CI agent's `## Sweep Yield` context block
  ("ledger-accuracy QA only … CI builds once") and the opposite line into the code
  reviewer's and the human merge gate's review package (ledger re-verification
  retained in full). Read by `blueprints/{qa-verifier,ci-agent}.md`;
  `blueprints/code-reviewer.md` is untouched by D2 on purpose. Depth is set by
  data on the run, never by an env flag the model cannot see.
- `blueprints/code-sweeper.md` no longer terminates its own run: it reports
  `verified_removable=<n>` + `candidates=<n>` and stops. The pre-D2 Step 2.5 had
  the model hand-`skip` every downstream ticket in reverse dependency order — a
  mass ticket mutation as the run's only termination mechanism.

**New events (TEAM-4248 D3)**
- `ticket_plan.branch_rewritten_observed { workflowId, ticketId, assignee, phase, canonical, rewrites: [{ from, to }] }` — `TICKET_PLAN_VALIDATOR=shadow` found an invented branch name in a ticket description; the prompt is left byte-identical
- `ticket_plan.branch_rewritten { …identical detail… }` — `enforce`, the same finding, and the only mode in which the rewritten text reaches the model. Neither event ever means a stored ticket changed
- `decision.recorded { workflowId, gateTicketId, mode, added, ids, committed }` — `DECISION_LEDGER` non-`off`, published only when `added > 0` (a redelivered webhook appends nothing and publishes nothing). `committed: false` = the GitHub PUT failed and only the S3 mirror exists
- `decision.unhonoured_observed { workflowId, gateTicketId, phase, mode, ids }` — the artifact under review cites none of those open decisions; published in **both** non-`off` modes, subject = the gate ticket
- `decision.gate_withheld { workflowId, gateTicketId, phase, ids }` — `enforce` only: the gate was **not** presented, the authoring ticket was reopened for rework, no human was paged, and `gateStates` was left untouched. This event is the sole record of a presentation that never happened

**New events (TEAM-4247 D2)**
- `workflow.nothing_to_remove { workflowId, outcome, verifiedRemovable, candidates, prUrl, featureBranch, ticketId }` — `SWEEP_DETECTION_PHASE=enforce` closed a zero-yield sweep. Published **instead of** `workflow.complete`, never alongside it, and deliberately **not** added to the analyzer's EventBridge rule (auto-analysis of no-op sweeps is out of D2)
- `sweep.detection_observed { workflowId, verifiedRemovable, candidates, wouldClose }` — `SWEEP_DETECTION_PHASE=shadow`, subject = the detection ticket
- `workflow.skipped { reason, evidence, repo, defId, trigger }` — `SWEEP_CADENCE_GATE=enforce` skipped a scheduled start; one per tombstone
- `sweep.cadence_observed { wouldSkip, reason, evidence, repo, defId }` — `SWEEP_CADENCE_GATE=shadow`, the run then starts as today

**New events (TEAM-4246 D1)**
- `orchestrator.verdict_observed { workflowId, verdict, verdictSource, wouldSuppress, spawnedTickets, testedHead }` — `VERDICT_GATE=shadow`, every gate completion
- `orchestrator.verdict_suppressed { workflowId, verdict, unblocked, blockers, spawnedTickets }` — `VERDICT_GATE=enforce`, a non-PASS gate held its successor
- `orchestrator.fix_before_verify_observed { workflowId, fixId, wouldBlock }` — `FIX_BEFORE_VERIFY=shadow`, spelled `blocked` (not `wouldBlock`) under `enforce`
- `orchestrator.completion_blocked { workflowId, reason, heads: { qa, ci, pr } }`, `reason` ∈ `"head-divergence" | "open-fix"` — `VERIFIED_HEAD_COMPLETION`, either mode; claimed once per `(workflow, reason, heads)` via `store.claimCompletionBlocked` so a redelivered completion attempt never double-escalates
- `agent.complete` detail gained four optional keys on a gate persona's completion: `verdict`, `verdictSource` (`"declared" | "inferred" | "none"`, `null` for a non-gate persona), `testedHead`, `spawnedTickets` — written by `enrichCompleteDetail` in both `agent.complete` publish sites (webhook + DDB-stream) so the two twins can never diverge
- `quality.gateMetricSource` (`"verdict-events" | "reviewGateHistory"`) on the cost-report performance card / fleet index — says whether `reworkRounds` / `gateRounds` / `firstPassYield` on that card came from the run's verdict events or (pre-D1 runs) the task/review-request fallback

Fleet runtime agents (`deploy/runtime-agent`, see `DEPLOY.md`) additionally read:
- `PERSONA_PROMPT_CACHE` — `1` (default on); Bedrock prompt caching for the persona system prompt + tools, set `0` to disable
- `PERSONA_CACHE_TTL` — `1h` (`5m`|`1h`, default `1h`); prompt-cache TTL, invalid values fall back to `1h`

---

## Module: Evaluations

The continuous-improvement loop. Self-contained surface.

**UI routes**
- `src/app/evaluations/` — dashboard + `config/` page

**API routes**
- `src/app/api/evaluations/` — config, per-agent stats, flush, loop

**Frontend / lib code**
- `src/lib/eval*` (evaluation helpers)

**Lambdas** (`lambda/`)
- `eval-packager` — triggered by CloudWatch Logs subscription filters; parses
  evaluator results and buffers them
- `token-aggregator` — token/cost aggregation
- `prd-submitter` — S3-triggered handoff into the improver agent

**DynamoDB tables**
- `agentcore-hub-eval-config` — per-agent eval controls + session buffer

**CloudWatch wiring**
- Subscription filters on `/aws/bedrock-agentcore/evaluations/results/eval_<harnessName>`
  log groups → `eval-packager`

**Deploy scripts**
- `deploy/evaluations/setup-evaluations.sh`
- `deploy/continuous-improvement/deploy.sh` (see `deploy/continuous-improvement/README.md`)

**`agents.json` fields it reads**
- `evaluationsEnabled` — per-agent on/off
- `evalConfigName` — substring used to match the agent's eval log groups

**Env vars** — `EVAL_CONFIG_TABLE`, `ARTIFACT_BUCKET`, `LAMBDA_ROLE_ARN`.

---

## Module: Builder (optional)

- **UI:** `src/app/build/`
- **Lambda:** `builder-tools`
- **Deploy:** `deploy/setup-builder-agent.mjs`

> **Heads-up — harness vs runtime.** The builder is an AgentCore *harness*, not a runtime. When the harness is created, AgentCore auto-provisions a runtime sibling named `harness_agentcore_hub_builder-…` under the hood. If you list runtimes (`aws bedrock-agentcore-control list-agent-runtimes` or the AgentCore MCP `list_agent_runtimes`), you'll see it — but `/build` only ever invokes the harness ARN, built from `BUILDER_AGENT_ID` in `.env.local`. The runtime sibling is irrelevant to `/build`. To verify the builder, query `list-harnesses` / `GetHarness`, not the runtime APIs.

---

## Module: Registry (optional)

A console over the **Amazon Bedrock AgentCore Registry** service. Two-level data
model: a *registry* (catalog) holds *registry records* (MCP servers, A2A agents,
custom resources, agent skills) that move through a DRAFT → PENDING_APPROVAL →
APPROVED/REJECTED → DEPRECATED lifecycle.

Unlike the other modules, Registry is **pure AWS-service-backed** — it has **no
DynamoDB tables and no Lambdas**. All reads and writes go straight through the
AWS SDK to the AgentCore Registry APIs.

**UI routes**
- `src/app/registry/` — registries list + records browser + record detail/approval

**API routes** (all under `src/app/api/agentcore/registry/`)
- `/api/agentcore/registry` — list/create/get/update/delete registries
- `/api/agentcore/registry/records` — list/create/get/update/delete records
- `/api/agentcore/registry/search` — data-plane record search
- `/api/agentcore/registry/approval` — submit-for-approval / approve / reject / deprecate (status transitions)

**AWS services**
- `bedrock-agentcore-control` (control plane) — registry + record CRUD and status transitions
- `bedrock-agentcore` (data plane) — `SearchRegistryRecords`

Both clients are constructed in `src/lib/agentcore-sdk.ts` (region only, ambient
credentials) — no module-specific credentials config.

**Lambdas** — none.

**DynamoDB tables** — none.

**Seed/demo data**
- `scripts/seed-registry.sh` — creates a demo registry plus a few example records (idempotent, re-runnable)

**Removing the module**
- Delete the `/registry` nav entry tagged `module: "registry"` in `src/config/modules.ts`
- `rm -rf src/app/registry src/app/api/agentcore/registry`
- Nothing else to tear down (no Lambdas/tables); then `npx tsc --noEmit && npm run build`

---

## Module: Cloud Code (optional)

A standalone, user-facing coding agent — the AWS "safe to close your laptop"
pattern (`awslabs/agentcore-samples` 04-coding-agents). Claude Code and Codex
(GPT-5.5 via Bedrock Mantle) run **server-side** in a dedicated AgentCore
Runtime; the browser is a thin client. Sessions are resumable from any device.
This module is **not** part of the 14-agent workflow fleet — it's Git-native and
conversational.

**UI routes**
- `src/app/cloud-code/` — session sidebar (warm/idle/cold, resume) + chat
  (streaming) + a live terminal (xterm over a presigned WebSocket PTY).
- `src/components/cloud-code/ShellTerminal.tsx` — the terminal.

**API routes** (under `src/app/api/cloud-code/`)
- `/sessions` — list / create sessions
- `/sessions/[id]` — get / delete
- `/sessions/[id]/message` — run a turn; `?stream=1` relays SSE (Claude streams,
  Codex buffered). See [streaming-sse.md](./streaming-sse.md).
- `/sessions/[id]/shell` — mint a SigV4-presigned `wss://` URL; the browser
  connects directly to the runtime PTY (App Runner does not proxy it).
- `/sessions/port` — "port to cloud" handoff: create a session + presigned S3 PUT
  for the laptop transcript (see the hub MCP below).
- `/sessions/[id]/warm` — pre-warm the microVM (clone + checkout + install
  transcript + materialize the config bundle) so a ported session opens instantly.
- `/sessions/[id]/shell` — also fires a config-only `prepare` invoke before
  presigning the PTY URL, so a terminal-only session gets the user's skills + MCP
  servers materialized (a terminal never runs a chat turn, the other trigger).
- `/sessions/[id]/checkpoint` — round-trip return leg: ask the runtime to upload
  the grown transcript back to S3, return a presigned GET for the laptop to pull.
- `/config` — per-user CLI config bundle: GET list / POST upload→S3 / PUT set-current.

**Port / pull / sync MCP** — `mcp/hub/` cloud-code domain (part of the unified
hub MCP — one local stdio server also carrying the workflow/routine tools; its
own package, excluded from the app tsconfig). Three tools: `port_session_to_cloud`
(commit+push, ship the raw `.jsonl` to S3, native `claude --resume` in the cloud),
`pull_session_from_cloud` (checkpoint the grown transcript home, `claude --resume`
locally — same session id both ways), and `sync_cli_config` (one-time: mirror the
laptop's CLI config — CLAUDE.md/AGENTS.md, skills, agents, MCP servers — into the
per-user `/config` bundle; scoped per CLI, classifies each MCP server works /
needs-secret / unsupported and ships only the runnable ones, redacts secret env).
See [mcp/hub/README.md](../mcp/hub/README.md).

**Lib**
- `src/lib/cloud-code/{types,sessions,runtime,config-store,shell-protocol}.ts`
- `src/lib/sse.ts` — shared SSE reader (also used by agent-detail/builder streams).

**The runtime** (separate from the fleet) — `deploy/coding-agent-runtime/`:
- EFS-backed `/mnt/efs` workspace (elastic, survives cold microVMs; the default
  ~1 GB sessionStorage overflowed). VPC + EFS provisioned by `cfn-vpc-efs.yaml` /
  `setup-coding-efs.sh`.
- `main.py` resumable `/invocations` server; per-session isolated checkouts;
  no-login terminal (Bedrock env + token); default MCP gateway + user config
  bundle materialized on turn start. See `deploy/coding-agent-runtime/README.md`.

**AWS services**
- `bedrock-agentcore` (data plane) — `InvokeAgentRuntime` (chat) + the WebSocket
  shell (`InvokeAgentRuntimeCommandShell`).
- `bedrock-agentcore-control` — create/update the runtime (VPC + EFS).
- Bedrock (Claude) + Bedrock Mantle (Codex GPT-5.5), EFS, S3 (config bundles),
  optional AgentCore Gateway (MCP tools).

**DynamoDB tables**
- `agentcore-hub-cloud-code-sessions` — one row per session (turns, cli, repo,
  claudeSessionId, userId, `defaultView` chat|terminal, and for ported sessions
  `branch` + `resumeTranscriptKey` + `pendingSeed`); also holds `config:{userId}`
  rows for config-bundle metadata. Single-user today (`userId:"default"`; swap
  for the Cognito sub).

**App env** (App Runner) — `CODING_AGENT_RUNTIME_ARN`, `CLOUD_CODE_TABLE`,
`MCP_GATEWAY_URL`; instance role needs `bedrock-agentcore:InvokeAgentRuntime` +
`InvokeAgentRuntimeCommandShell`.

**Removing the module**
- Delete the `/cloud-code` nav entry tagged `module: "cloud-code"` in `src/config/modules.ts`
- `rm -rf src/app/cloud-code src/app/api/cloud-code src/lib/cloud-code src/components/cloud-code` and the `cloud-code/` domain in `mcp/hub`
- Optionally tear down the runtime (`deploy/coding-agent-runtime/`), the
  `agentcore-hub-cloud-code-sessions` table, and the VPC/EFS stack
  (`agentcore-hub-coding-vpc-efs`). `src/lib/sse.ts` is shared — keep it.
- `npx tsc --noEmit && npm run build`

---

## Module: Pipeline (optional)

AWS-native CI/CD for a repo the hub builds into (pilot: the hub's own repo). A
bolt-on that moves the deterministic build/test/deploy work OUT of the SDLC
agents and INTO CodeBuild + CodePipeline, so the agents only author/judge/react.
Full design + rationale: [`cicd-pipeline-module-design.md`](./cicd-pipeline-module-design.md).
Operator-facing operating model (agents own CD): [`agents-own-cd.md`](./agents-own-cd.md).

**Gated + inert by default.** Nothing runs unless you both deploy the CDK stack
AND set the enable flags. With them unset the `/pipeline` nav entry is hidden and
the CI/QA/release-manager blueprints run their legacy self-build path unchanged.

**UI routes**
- `src/app/pipeline/` — read-only status board (CI builds + deploy pipeline stages).

**API routes** (under `src/app/api/pipeline/`)
- `/status` — recent CodeBuild builds + CodePipeline stage state (pure reads).

**Lib**
- `src/lib/pipeline/status.ts` — CodeBuild + CodePipeline SDK reads (server-side).

**Lambdas** (`lambda/`)
- `agentcore-hub-pipeline-tools` (`lambda/agentcore-hub-pipeline-tools/index.mjs`)
  — exposes `Pipeline___get_state` / `Pipeline___start_deploy` /
  `Pipeline___get_build_status` / `Pipeline___get_build_log` to the fleet
  (read + trigger only; **deliberately NO `codepipeline:PutApprovalResult`** —
  the deploy gate is human-only). Deployed via
  `deploy/setup-pipeline-tools-lambda.mjs`; reached from
  `deploy/runtime-agent/main.py` via the `PIPELINE_TOOLS_LAMBDA` env var
  (default `agentcore-hub-pipeline-tools`).

**Infra (CDK, self-contained)** — `deploy/pipeline/`:
- `bin/pipeline.ts` + `lib/pipeline-stack.ts` — CodeConnections link, CI CodeBuild
  (PR check → required commit status), Build + Deploy CodeBuild projects,
  CodePipeline (Source → Build → ManualApproval/SNS → Deploy), scoped IAM,
  cdk-nag. Imports NOTHING from `src/`.
- `buildspec-ci.yml` (gates + build-once artifact emission), `buildspec-deploy.yml`
  (the 3-target `DEPLOY.md`, promote-by-digest, smoke checks).
- `merge-agents-json.py` (single source of the agents.json merge, extracted from
  `DEPLOY.md`), `ecs-primary-container.py`, `deploy.sh`. See
  [`deploy/pipeline/README.md`](../deploy/pipeline/README.md).

**AWS services** — CodeConnections, CodeBuild, CodePipeline, SNS (approval),
CloudWatch Logs. Deploy role is deliberately narrow (Lambda code-only, no
`UpdateFunctionConfiguration`, no `iam:*`).

**Enable flags**
- `NEXT_PUBLIC_PIPELINE_ENABLED=1` — shows the `/pipeline` nav entry + tab (app).
- `PIPELINE_ENABLED=1` — on the fleet/orchestrator context: CI/QA/release-manager
  blueprints read pipeline results instead of shelling builds.
- The **CD registry** (Workflow module, `config/cd-registry.json` in the artifact
  bucket) scopes that signal: a run gets the `## Pipeline Mode` block (with
  `pipeline_name`) only when its repo is registered with a `pipeline`. A registered
  repo without one takes the legacy DEPLOY.md path; an unregistered repo is a
  handoff (no ship phase at all). `CD_REGISTRY_TTL_MS` (orchestrator, default 60000)
  is the re-read interval.
- `PIPELINE_TOOLS_LAMBDA` — fleet runtime: name of the tools Lambda (default
  `agentcore-hub-pipeline-tools`).
- `PIPELINE_NAME` / `BUILD_PROJECT` / `CI_PROJECT` — on the tools Lambda
  (defaults `agentcore-hub-deploy` / `agentcore-hub-build` / `agentcore-hub-ci`).
- `PIPELINE_CI_WEBHOOK` — CDK-time flag turning on the CodeBuild PR-check
  webhook (default OFF; required PR checks today come from GitHub Actions).
- `DEPLOY_PIPELINE_NAME` — on the **telegram-bug-intake** Lambda: enables the
  deploy-gate Telegram approval bridge (unset = the whole path is a no-op).

**Removing the module**
- Delete the `/pipeline` nav entry tagged `module: "pipeline"` (and the
  `enabledBy`/`moduleEnabled` gating) in `src/config/modules.ts`
- `rm -rf src/app/pipeline src/app/api/pipeline src/lib/pipeline deploy/pipeline`
- `rm -rf lambda/agentcore-hub-pipeline-tools deploy/setup-pipeline-tools-lambda.mjs`
  (if deployed, also delete the AWS function)
- Remove the `Pipeline___*` tool grants from `src/config/agents.json`
  (`ci_agent` + `release_manager`) and the `Pipeline___*` `@tool` wrappers in
  `deploy/runtime-agent/main.py`
- Unset `DEPLOY_PIPELINE_NAME` on the telegram-bug-intake Lambda (the approval
  bridge is a no-op without it)
- Drop `@aws-sdk/client-codebuild` + `@aws-sdk/client-codepipeline` from
  `package.json` if nothing else uses them
- Revert the `PIPELINE_ENABLED` blocks in `blueprints/{ci-agent,qa-verifier,release-manager}.md`
- If deployed: `cdk destroy` the `AgentcoreHubPipeline` stack
- The Workflow board's deploy-gate banner fails silent when `/api/pipeline/status`
  is absent — no Workflow-side change needed
- `npx tsc --noEmit && npm run build`

---

## Shared seams

These are the three places where modules touch shared ground. A cherry-picker
needs to be aware of them — none of them prevent removal, but they explain why
the optional modules expect certain shape.

1. **`src/config/agents.json`** is the one roster shared by core + all modules.
   Core fields: `id`, `name`, `role`, `phase`, `type`, `model`, `tools`,
   `keywords`, `canQueryAgents`. Workflow adds `harnessName` + `runtimeArn`;
   Evaluations adds `evaluationsEnabled` + `evalConfigName`. There is also a
   `watchdog` config block (per-agent, with a fleet-wide fallback under
   `defaults.watchdog`: `enabled`, `heartbeatIntervalMs`, `toolDeadlineSecs`,
   `turnTimeoutSecs`) read by the orchestrator's watchdog/dead-session sweep and
   the runtime agents. Extra fields are ignored by modules that don't use them,
   so leaving them in is harmless.

2. **Runtime naming convention.** The orchestrator derives a runtime env key per
   agent as `RUNTIME_ARN_<HARNESS_NAME_UPPER>` and the eval-packager matches log
   groups by the `evalConfigName` substring. If you keep the conventional names
   (`agentcore_hub_<role>` / `eval_agentcore_hub_<role>`) the lookups work with
   zero code changes; if you rename them you must update both lookups.

3. **Shared IAM role.** `agentcore-hub-lambda-role` (`LAMBDA_ROLE_ARN` in
   `deploy/config.sh`) is reused across the Workflow and Evaluations Lambdas. If
   you deploy only one module you can scope the role down to just that module's
   permissions.

---

## Removing a module

Example — drop **Workflow** from a deployment:

```bash
# 1. UI + API + frontend code
rm -rf src/app/workflow src/app/tickets \
       src/app/api/workflow src/app/api/jira src/app/api/models \
       src/components/workflow src/lib/workflow src/lib/pipeline-config.ts

# 2. Lambdas (if already deployed, also delete the AWS functions/tables)
rm -rf lambda/orchestrator lambda/agentcore-hub-jira \
       lambda/agentcore-hub-tickets lambda/workflow-output

# 3. Nav: delete the two entries tagged module: "workflow" in src/config/modules.ts
#    (Workflow + Ticket History)

# 4. Verify the rest still builds
npx tsc --noEmit && npm run build
```

Example — drop **Evaluations**:

```bash
rm -rf src/app/evaluations src/app/api/evaluations src/lib/eval*
rm -rf lambda/eval-packager lambda/token-aggregator lambda/prd-submitter
# delete the entry tagged module: "evaluations" in src/config/modules.ts
npx tsc --noEmit && npm run build
```

Both removals were validated: the remaining app compiles and builds cleanly. The
`agents.json` module fields left behind (e.g. `harnessName`, `evalConfigName`)
are inert once their module is gone, so you can leave them or strip them.

---

## Adding a module back / adding a new one

1. Add the UI route(s) under `src/app/<feature>/` and API under `src/app/api/<feature>/`.
2. Add a nav entry in `src/config/modules.ts` tagged with a new `ModuleId`.
3. Add any Lambdas under `lambda/<feature>/` and a deploy script under `deploy/`.
4. If the module needs per-agent config, add optional fields to `agents.json`
   and read them defensively (treat missing as "feature off").
