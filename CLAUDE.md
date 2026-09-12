# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AgentCore Hub — a Next.js 14 (App Router) + TypeScript web console for Amazon Bedrock AgentCore. It **dynamically discovers** deployed agents in the configured AWS account at runtime (no hardcoded ARNs/account IDs) and lets you invoke them, watch metrics/traces, build new agents, and run a 16-agent autonomous software-delivery pipeline.

Config is environment-driven (`.env.local`, copied from `.env.example`). `deploy/config.sh` derives account ID, role ARNs, bucket, and table names from credentials + conventions — never hardcode those.

## Commands

```bash
npm run dev          # next dev (localhost:3000)
npm run build        # next build — also the module-removal smoke test (must pass)
npm run lint         # next lint
npm test             # fast Playwright: tab UI + API smoke (~30s, no live harness)
npm run test:full    # adds builder e2e + full workflow e2e (5-10min, needs BUILDER_AGENT_ID + harness role)

# Run a single Playwright spec / test
npx playwright test tests/tab-dashboard.spec.ts
npx playwright test tests/tab-dashboard.spec.ts -g "test name"
```

Infra/deploy entry points (each is idempotent / re-runnable):
```bash
./scripts/create-dynamodb-tables.sh --with-tickets   # workflows+events (+tickets for dynamodb mode)
./scripts/verify-infra.sh ; ./scripts/verify-all.sh  # verification suites
node deploy/setup-tickets-lambda.mjs                 # deploys jira OR tickets Lambda per TICKET_PROVIDER
node deploy/setup-builder-agent.mjs                  # builder harness
cd deploy/runtime-agent && ./deploy-fleet.sh         # all 15 fleet runtime agents (needs AgentCore CLI)
node deploy/setup-pipeline-tools-lambda.mjs          # Pipeline___* tools Lambda (pipeline module)
./deploy/pipeline/deploy.sh                          # CI/CD pipeline CDK stack (pipeline module)
```

The guided alternative to manual setup is the Claude Code plugin: `claude --plugin-dir .` then `/agentcore-hub:setup`.

## Architecture

### Modular core + bolt-ons
The app is a small always-on **core** (Dashboard, Agents, Invoke, region switch, runtime discovery/traces) plus **optional modules** (Workflow, Evaluations, Builder, Registry, Cloud Code, Routines, Connectors, Pipeline — see `src/config/modules.ts`). Rules that matter when editing:
- **Core never imports from an optional module.** Optional modules may use core libs (`src/lib/agentcore-sdk.ts`, `client-cache.ts`) and shared `src/config/agents.json`, but **not each other**.
- Nav entries live in one registry: `src/config/modules.ts`. Removing a module should be a one-place edit, and the app must still pass `npx tsc --noEmit` + `npm run build`.
- Every module's UI routes, API routes, Lambdas, and DynamoDB tables are namespaced. See `docs/MODULES.md` for the exact per-module file/table/env-var breakdown — consult it before adding or removing a surface.

### Layout
- `src/app/` — App Router pages + `api/*/route.ts` handlers (server-side AWS calls).
- `src/lib/agentcore-sdk.ts` — central AgentCore abstraction (discovery, invoke, payload/response handling). `src/lib/workflow/` holds pipeline + ticket-provider logic.
- `src/config/agents.json` — **single source of truth** for the agent roster (see below).
- `lambda/` — per-function Lambda source (orchestrator, jira/tickets ticket-tools, builder-tools, eval-packager, token-aggregator, prd-submitter, workflow-output, cost-report, agentcore-hub-pipeline-tools, routines-runner, anomaly-watcher, workflow-analyzer).
- `deploy/` — deploy scripts + `config.sh`. `blueprints/` — markdown agent instructions. `skills/`, `agents/` — Claude Code plugin assets.

### Multi-format invocation
Agents expect different payload shapes. `src/lib/agentcore-sdk.ts` has a `PAYLOAD_BUILDERS` map (`prompt`/`messages`/`input_text`/`query`/`custom`) and a response-parsing block that auto-detects many response shapes. Per-agent format is persisted in `.payload-formats.json` and settable via `POST /api/agentcore/payload-format`. Adding a new format = edit `PAYLOAD_BUILDERS` + the response parser + the `valid` array in `src/app/api/agentcore/payload-format/route.ts` (README "Adding a New Invoke Pattern").

### Agent roster (config-driven)
`src/config/agents.json` defines all valid agents. It is **synced to S3** at deploy and loaded by every Lambda on cold start. To change agents: edit the file, then `aws s3 cp src/config/agents.json s3://{ARTIFACT_BUCKET}/config/agents.json` — Lambdas pick it up on next cold start, no redeploy. The orchestrator resolves `agentId` → runtime ARN via the `RUNTIME_ARN_<HARNESS_NAME_UPPER>` env convention (or explicit `runtimeArn`).

### Workflow pipeline orchestration
Submit a feature request → 16 Strands agents on AgentCore **Runtime** (requirements → 8 parallel design → 3 dev → code review → CI certification → QA verification → ship) produce a PR. Cascade is driven by ticket status changes:
- **`TICKET_PROVIDER=dynamodb`** (code default when unset): DynamoDB Streams on the tickets table trigger the orchestrator Lambda.
- **`TICKET_PROVIDER=jira`** (what `.env.example`/`Dockerfile` ship): real Jira Cloud; Jira webhooks hit `/api/jira/webhook`. Requires a specific 6-status team-managed workflow (see README "Jira Integration").

Both ticket Lambdas expose the identical `Tickets___*` tool interface — agents don't know which backend is active. The fleet uses **Runtime** (not Harness) agents because runtimes emit OTEL spans during execution, which powers live UI streaming; the Builder is a Harness because single-turn chat needs no streaming.

**Thin orchestrator (DL-009, `docs/architecture.md`).** `lambda/orchestrator/` is an event router and nothing more: dispatch a Ready ticket, cascade a Done ticket's dependents, claim/release invocation leases, reap dead sessions, evaluate completion. Any behaviour that decides *what work happens next* — parking a ticket behind fixes, re-verifying a fix, syncing a branch, probing CI or GitHub, capping loops, routing by label — lives in the agent blueprint (`blueprints/*.md`) using the ticket tools (`Tickets___create_ticket`, `Tickets___transition_ticket` with `blocked_by`, `WorkflowOutput___report_completion`), never in the orchestrator and never behind a new `*_MODE` flag. A PRD, ticket or PR that adds orchestrator logic or a flag is rejected on that ground alone; `scripts/check-orchestrator-surface.sh` enforces the module list, env allow-list and line budget in CI.

### Coding CLIs on a dedicated runtime
The coding CLIs (Claude Code, Codex) run on a separate, observable **coding-agent runtime** (`deploy/coding-agent-runtime/`) with a persistent `/mnt/workspace` and full OTel tracing, invoked by the fleet's `claude_code` / `codex` / `kiro` tools. A turn is submitted with `mode:"async"` (the platform kills any invocation silent for 15 min) and the fleet then waits by running a short probe inside the same container via the AgentCore commands API (`POST /runtimes/{arn}/commands`), which reports the CLI's own process state — see DL-026 in `docs/architecture.md`. Turn state is VM-local, never on EFS. Each CLI's internal tool calls become CloudWatch spans, and live `agent.streaming` events still flash in the UI. Set `CODING_AGENT_RUNTIME_ARN` on the fleet to enable it; when unset, `claude_code` falls back to an in-container subprocess (codex needs the runtime). Codex uses its built-in `amazon-bedrock` provider (the AWS blog pattern) — SigV4 from the IAM role, routing to Bedrock Mantle (`BEDROCK_MANTLE_REGION`, default us-east-2), default model `openai.gpt-5.5` (`CODEX_MODEL` to override). GPT-5.5 must be enabled on Mantle for the account. The coding runtime exists twice with the same image: `agentcore_hub_coding_runtime` (microVM + EFS, `deploy.py`) and `agentcore_hub_coding_runtime_ec2` (AgentCore **Instances**: EC2 capacity provider + one EBS volume per session, `deploy-instances.py`); CD swaps the image digest into both. `CODING_AGENT_RUNTIME_ARN` on the fleet runtime and on the hub ECS service picks which one is active, and every coding-session row records the `runtimeArn` it was minted on, so the hub always talks to the runtime that owns the session and rework never resumes a session from the other runtime. The session reaper's 15-minute `sweep` releases compute behind finished runs (deletes the EBS volume on Instances, purges the EFS dir on microVM) and stamps `computeReleasedAt` on the row; rows stay for history. Flip env only with `deploy/runtime-agent/set-runtime-env.py` / `deploy/ecs-express/set-env.sh` (the raw update APIs replace the whole env). See `deploy/coding-agent-runtime/README.md`.

### CD registry — who merges and deploys
`config/cd-registry.json` in the artifact bucket (seeded empty from `src/config/cd-registry.json`; edit via Workflow tab → CD registry…, `POST /api/workflow/cd-registry`, or `scripts/cd-registry.sh`) lists the repos the hub is allowed to **merge + deploy**. A run on a registered repo gets the full ship phase (release manager → human Merge Approval → merge/deploy via the entry's `pipeline` or DEPLOY.md). A run on any other repo is a **handoff**: the orchestrator strips the ship phase from the effective def (`lambda/orchestrator/cd-registry.mjs`), intake plans no Ship/Merge/CD tickets, and at completion the orchestrator opens the unified PR and leaves it open for the owning team. The deploy stage only seeds the S3 file when missing — never overwrite the live registry with the repo copy.

It is a **runtime allow-list**, not just intake config: the orchestrator, the `Pipeline___*` tools Lambda, the Telegram deploy-gate bridge and the hub UI all read it, so registry write access equals deploy-trigger authority. Each entry carries `pipeline`, `region` and optionally `ciProject` (plus, for cross-account CD, optional `account`, `roleArn` — an `arn:aws:iam::<account>:role/hub-cd-trigger-<slug>` role the hub assumes to trigger a pipeline in another account, though only the `Pipeline___*` tools Lambda assumes it today; `/pipeline` (`src/lib/pipeline/status.ts`) and the Telegram gate bridge still use ambient creds, so they cannot yet read or approve a cross-account pipeline — and `externalId`); every other resource name is derived from `pipeline` by one shared rule — `pipelineProjects()` (canonical, `lambda/orchestrator/cd-registry.mjs`) and its TS mirror `pipelineProjectsFor()` (`src/lib/cd-registry.ts`) strip a trailing `-deploy` and append `-ci` / `-build` / `-deploy`, with an explicit `ciProject` winning. Convention is `hub-<slug>-*` (slug = repo name lowercased, `[^a-z0-9]+` → `-`, ≤40 chars) and `hub-` is reserved for hub-managed pipelines; the hub's own resources keep `agentcore-hub-*`. Never derive these names a second time in a new place — call the mirror.

### CI/CD pipeline module (optional)
Agents own CD via the `Pipeline___*` tools (`get_state`/`start_deploy`/`start_ci_build`/`get_build_status`/`get_build_log`/`capabilities`) on a narrow Lambda (`lambda/agentcore-hub-pipeline-tools/`) — deliberately **no `PutApprovalResult`**: the in-pipeline ManualApproval deploy gate is human-only, bridged to Telegram. That gate is **conditional, never auto-approved** (DL-028): passing `approved_head_sha` to `Pipeline___start_deploy` records a ship-approval at `s3://$ARTIFACT_BUCKET/pipeline-artifacts/ship-approvals/<merge_commit>.json`, the Build stage's `deploy/pipeline/preapproved-check.sh decide` exports `DEPLOY_PREAPPROVED`, and a `VariableCheck` stage-entry condition skips the approval only on the literal `1` (re-verified again in Deploy), so anything unproven — including a post-approval `main` sync — pages the human as before. Merge does not auto-trigger the pipeline; the release manager calls `Pipeline___start_deploy`. The orchestrator's ship merge-verify gate blocks a ship-phase run from completing while its feature branch is provably unmerged (`SHIP_MERGE_VERIFY=off` to opt out). The CI agent auto-remediates whitelisted mechanical failures (prettier/eslint --fix/lockfile — `blueprints/ci-agent.md` P2a) and tickets logic failures to dev. See `docs/pipeline/design.md`.

### Evaluations / self-improvement (optional)
AgentCore online evaluations score invocations; low scores trigger `eval-packager` (via CloudWatch Logs subscription filters) → fleet improver agent writes a PRD → `prd-submitter` re-enters the same 16-agent pipeline. Toggle = set `eval-packager` Lambda concurrency to 0 (paused) vs unlimited.

### Metrics & traces
Per-agent token usage comes from `aws/spans` OTEL trace data; invocations/latency from `AWS/Bedrock-AgentCore` CloudWatch metrics; full execution traces from the `aws/spans` Logs group. Every terminal run also gets deterministic hero KPIs — cost, wall-clock and a 0-100 quality score whose weights, tolerances and caps live only in `src/config/kpi.json` — which sit alongside, not instead of, the Workflow Manager's agent-authored assessment.

## Conventions
- Never hardcode account IDs, ARNs, bucket names, or usernames in deploy scripts — source `deploy/config.sh` and use env/derived values.
- Use hyphens, not em dashes, in AWS resource names/descriptions.
- Path alias `@/*` → `src/*`. TypeScript `strict` is on.
