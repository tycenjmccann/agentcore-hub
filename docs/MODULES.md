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

The core never imports from an optional module. Optional modules may share core
libraries (`src/lib/agentcore-sdk.ts`, `src/lib/client-cache.ts`, etc.) and the
shared `src/config/agents.json` roster, but not each other. Nav entries are
declared in a single registry (`src/config/modules.ts`) so removing a module is
a one-place edit.

---

## Module: Workflow

The orchestration pipeline. Self-contained surface.

**UI routes**
- `src/app/workflow/` — pipeline board + detail views
- `src/app/tickets/` — ticket history

**API routes**
- `src/app/api/workflow/` — start/state/list/events/stream/cancel/retry/artifacts/webhook
- `src/app/api/jira/` — Jira webhook + metrics
- `src/app/api/models/` — model picker (used only by the workflow intake form)

**Frontend code**
- `src/components/workflow/`
- `src/lib/workflow/` (types, jira-client, model-config)
- `src/lib/pipeline-config.ts`

**Lambdas** (`lambda/`)
- `orchestrator` — drives the pipeline state machine
- `agentcore-hub-jira` — Jira Cloud ticket tools (deployed when `TICKET_PROVIDER=jira`)
- `agentcore-hub-tickets` — DynamoDB-backed ticket tools (deployed when `TICKET_PROVIDER=dynamodb`)
- `workflow-output` — collects agent artifacts

**DynamoDB tables** (defaults in `deploy/config.sh`)
- `agentcore-hub-workflows` (`WORKFLOWS_TABLE`)
- `agentcore-hub-events` (`EVENTS_TABLE`)
- `agentcore-hub-tickets` (`TICKETS_TABLE`)

**Deploy scripts**
- `deploy/setup-tickets-lambda.mjs` and the orchestrator/Jira/output Lambdas

**Coding-agent runtime** (`deploy/coding-agent-runtime/`)
- Dedicated AgentCore Runtime hosting Claude Code + Codex on one ARM64 image,
  with persistent `/mnt/workspace` session storage and OTel → CloudWatch tracing.
  The fleet's `claude_code` / `codex` tools invoke it via the AgentCore commands API.
- ECR repo: `coding-agent-runtime`. Execution role: `agentcore-hub-coding-runtime-role`.
- Deploy: `setup-coding-runtime-role.sh` → `build-and-push.sh` → `deploy.py`.
- Env vars: `CODING_AGENT_RUNTIME_ARN` (set on the fleet after deploy),
  `BEDROCK_MANTLE_REGION`. When `CODING_AGENT_RUNTIME_ARN` is unset, `claude_code`
  falls back to an in-container subprocess.

**`agents.json` fields it reads**
- `harnessName` — maps an agent to its AgentCore runtime via the `RUNTIME_ARN_<HARNESS_NAME_UPPER>` convention
- `runtimeArn` — optional explicit ARN; when `null`, the orchestrator resolves the runtime from the env var above

**Env vars** — `WORKFLOWS_TABLE`, `EVENTS_TABLE`, `TICKETS_TABLE`, `ARTIFACT_BUCKET`,
`RUNTIME_ARN_<HARNESS>` (one per agent harness), `LAMBDA_ROLE_ARN`.

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

## Shared seams

These are the three places where modules touch shared ground. A cherry-picker
needs to be aware of them — none of them prevent removal, but they explain why
the optional modules expect certain shape.

1. **`src/config/agents.json`** is the one roster shared by core + all modules.
   Core fields: `id`, `name`, `role`, `phase`, `type`, `model`, `tools`,
   `keywords`, `canQueryAgents`. Workflow adds `harnessName` + `runtimeArn`;
   Evaluations adds `evaluationsEnabled` + `evalConfigName`. Extra fields are
   ignored by modules that don't use them, so leaving them in is harmless.

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
