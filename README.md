# AgentCore Hub

A platform for getting the most out of Amazon Bedrock AgentCore — run all your agents and workflows from one place. It dynamically discovers your deployed agents (no hardcoded ARNs, memory IDs, or account numbers), then layers on a metrics dashboard, a chat playground with full OTEL execution traces and session history, a Registry, a chat-based agent builder, config-driven multi-agent workflows, and a cloud coding agent (Claude Code / Codex). Clone, configure your AWS credentials, and it works.

## Features

- **Dashboard** — Real metrics from CloudWatch and OTEL traces: invocations, per-agent token usage, latency, sessions
- **Agents** — Card grid of harnesses and runtimes; click for detail + invoke
- **Agent Detail** — Model, tools, memory, logs + live chat with sessions and full OTEL execution trace
- **Registry** — Browse, search, and manage records in the Amazon Bedrock AgentCore Registry (MCP servers, A2A agents, custom resources, agent skills): full CRUD, semantic search, and the approval lifecycle
- **Builder** — Chat-based agent creation (harness with code_interpreter + MCP)
- **Workflow** — Config-driven multi-agent pipelines: submit a request and a roster of agents produce the deliverable. Ships four workflows (Software Delivery → a PR; Marketing; Sales; Legal), each defined in `src/config/workflows.json`. Real-time pipeline visualization with animated phases, timeline replay/scrubber, S3 artifact browsing, optional **human review gates**, and dynamic header titles
- **Cloud Code** — A coding agent that lives in the cloud ("safe to close your laptop"): Claude Code / Codex run server-side on a dedicated AgentCore Runtime with an EFS workspace. Streaming chat + a live terminal, per-session isolated checkouts, resumable from any device, MCP-gateway tools, and per-user CLI config bundles. **Port a live local session to the cloud and pull it back** — a [local MCP](mcp/hub/README.md) ships your raw transcript so `claude --resume` continues losslessly, laptop↔cloud. Opens PRs from a clone — Git-native, separate from the workflow fleet
- **Pipeline** — AWS-native CI/CD (CodeBuild + CodePipeline) with a read-only `/pipeline` status board. Agents own CD through narrow `Pipeline___*` tools (trigger + watch + read build logs — never approve); the deploy gate is a human decision delivered to Telegram. See [`docs/cicd-pipeline-module-design.md`](docs/cicd-pipeline-module-design.md), [`docs/pipeline-quickstart.md`](docs/pipeline-quickstart.md), and [`docs/agents-own-cd.md`](docs/agents-own-cd.md)

### Modular by design

The console is a small always-on **core** (Dashboard, Agents, Invoke) plus
optional **bolt-on modules** (Workflow, Registry, Evaluations, Builder, Cloud Code,
Routines, Connectors, Pipeline). Each
module's UI, API routes, Lambdas, and DynamoDB tables are namespaced, so you can
deploy only what you need and cherry-pick the rest out. See
[`docs/MODULES.md`](docs/MODULES.md) for the core-vs-optional breakdown, per-module
deploy checklists, and exact removal steps.

## Prerequisites

- Node.js 18+
- AWS credentials configured (via `~/.aws/credentials`, env vars, or IAM role)
- [Claude Code](https://claude.com/claude-code) (only for the guided `/agentcore-hub:setup` quick start below)

## Quick start with `/agentcore-hub:setup` (recommended)

This repo ships a Claude Code plugin that turns the manual stages below into a guided conversation. There's no install step — `--plugin-dir .` loads the plugin for that one session.

```bash
git clone https://github.com/tycenjmccann/agentcore-hub.git
cd agentcore-hub

# Launch Claude Code with this repo's plugin loaded for the session.
# Run from the repo root — the path is the plugin directory, not the manifest.
claude --plugin-dir .
```

Then at the Claude Code prompt:

```
/agentcore-hub:setup
```

That's it — no exit, no restart. `/agentcore-hub:setup` asks 4–6 questions, detects your AWS account/region, writes `.env.local`, and runs only the deploy scripts the modules you picked actually need — verifying each phase before moving on. Safe to re-run (Ctrl-C, then `/agentcore-hub:setup` again in a fresh `claude --plugin-dir .` session); never overwrites `.env.local` (backs up to `.env.local.bak` first). See [`.claude-plugin/README.md`](.claude-plugin/README.md) for the full plugin design.

> **Want it permanently?** Once a marketplace entry is published, `claude plugin install agentcore-hub@<marketplace>` installs it across all sessions. Until then, use `--plugin-dir .` per session.

If you'd rather drive the install by hand (or you're not using Claude Code), follow the progressive stages below.

## Setup (Progressive Stages)

Each stage builds on the previous one. Every stage includes a built-in verification step so you know it worked before moving on.

```bash
npm install
cp .env.example .env.local
```

### Stage 1: Configuration

Choose your ticket provider and edit `.env.local`:

| `TICKET_PROVIDER` | Backend | Orchestration Trigger | Best For |
|---|---|---|---|
| `dynamodb` | DynamoDB table | DynamoDB Streams (automatic) | Quick setup, no external dependencies |
| `jira` | Jira Cloud | Jira webhooks (HTTP) | Production with existing Jira workflow |

**Always required:**

| Variable | Description |
|----------|-------------|
| `TICKET_PROVIDER` | `jira` or `dynamodb` |
| `WORKFLOWS_TABLE` | DynamoDB table for workflow metadata (default: `agentcore-hub-workflows`) |
| `EVENTS_TABLE` | DynamoDB table for real-time events (default: `agentcore-hub-events`) |
| `ARTIFACT_BUCKET` | S3 bucket for agent outputs (convention: `agentcore-hub-artifacts-<ACCOUNT_ID>`) |
| `GITHUB_PAT` | GitHub Personal Access Token for MCP tools (code push, PRs) |

**For DynamoDB mode, also set:**

| Variable | Description |
|----------|-------------|
| `TICKETS_TABLE` | DynamoDB tickets table (default: `agentcore-hub-tickets`) |
| `TICKET_TOOLS_LAMBDA` | Set to `agentcore-hub-tickets` (the DynamoDB-backed Lambda) |

**For Jira mode, also set:**

| Variable | Description |
|----------|-------------|
| `JIRA_SITE_URL` | Your Jira site (e.g., `your-site.atlassian.net`) |
| `JIRA_EMAIL` | Jira account email |
| `JIRA_API_TOKEN` | Jira API token |
| `JIRA_PROJECT_KEY` | Project key (e.g., `TEAM`) |
| `TICKET_TOOLS_LAMBDA` | Set to `agentcore-hub-jira` (the Jira Cloud Lambda) |

### Stage 2: Infrastructure (DynamoDB + S3)

```bash
# Create DynamoDB tables
# Default: workflows + events tables (for Jira mode)
# With --with-tickets: also creates tickets table with DynamoDB Streams (for DynamoDB mode)
./scripts/create-dynamodb-tables.sh --with-tickets

# Create S3 artifacts bucket
aws s3 mb s3://agentcore-hub-artifacts-<ACCOUNT_ID> --region us-east-1
```

**Verify:**
```bash
./scripts/verify-infra.sh
```

### Stage 3: Tickets Lambda

Deploys the Lambda that agents call to create/update/query tickets. The script reads your `TICKET_PROVIDER` setting and deploys the correct Lambda:

- `TICKET_PROVIDER=jira` → deploys `lambda/agentcore-hub-jira/` (calls Jira Cloud REST API)
- `TICKET_PROVIDER=dynamodb` → deploys `lambda/agentcore-hub-tickets/` (reads/writes DynamoDB)

Both expose the identical tool interface to agents (`Tickets___create_ticket`, `Tickets___transition_ticket`, etc.) — agents don't know or care which backend is in use.

```bash
node deploy/setup-tickets-lambda.mjs
```

Expected output: `✓ Lambda responded — created ticket: TEAM-1`

### Stage 4: App Smoke Test

```bash
npm run dev    # Start the app
npm test       # In another terminal — runs UI + API smoke tests (~15 seconds)
```

All tabs should load, all API routes should respond. The dashboard will show 0 agents until you deploy them.

### Stage 5: Builder Agent

Deploys the Builder Agent harness — enables the Build page for chat-based agent creation. The script creates the IAM role, auto-provisions an AgentCore Memory store (so past builds inform future ones), deploys the harness, and verifies with a test invocation.

```bash
node deploy/setup-builder-agent.mjs
```

> Memory is on by default. Pass `--no-memory` for a stateless builder, or `--memory-id <existing>` to reuse a store you already have.

Expected output: `✓ Builder agent responded (XXX chars)`

Add the output to `.env.local`:
```bash
BUILDER_AGENT_ID=agentcore_hub_builder-xxxxxxxxxx
```

### Stage 6: Agent Fleet (14 Agents)

See [Deploying the Agent Fleet](#deploying-the-agent-fleet) below for full details.

### Full Verification

After all stages are complete, run the full verification suite:

```bash
./scripts/verify-all.sh
```

### Optional Variables

| Variable | Description |
|----------|-------------|
| `AWS_REGION` | Defaults to `us-east-1` |
| `HARNESS_EXECUTION_ROLE_ARN` | IAM role for creating new harness agents (enables Deploy button on Build page) |
| `MCP_SERVERS` | JSON array of MCP server configs for custom tooling beyond GitHub |
| `PIPELINE_ENABLED` | Fleet/orchestrator context — CI/QA/release-manager blueprints read pipeline results instead of shelling builds |
| `NEXT_PUBLIC_PIPELINE_ENABLED` | Build-time — shows the `/pipeline` tab (Pipeline module) |

## How It Works

1. **Discovery** — On load, the Control Plane SDK (`ListHarnesses`, `ListAgentRuntimes`, `ListMemories`) discovers all agents in your account
2. **Invocation** — Chat uses `InvokeHarness` (for harnesses) or `InvokeAgentRuntime` (for runtimes) via the Data Plane SDK
3. **Memory** — Conversation history stored/retrieved via AgentCore Memory (`CreateEvent`, `ListEvents`)
4. **Metrics** — Per-agent token usage from `aws/spans` OTEL trace data; invocations and latency from `AWS/Bedrock-AgentCore` CloudWatch metrics
5. **Traces** — Full OTEL execution traces (model calls, tool executions, event loops) from the `aws/spans` CloudWatch Logs group

## Tech Stack

- Next.js 14 (App Router)
- TypeScript
- Tailwind CSS
- AWS SDKs: `@aws-sdk/client-bedrock-agentcore`, `@aws-sdk/client-bedrock-agentcore-control`, `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-cloudwatch`, `@aws-sdk/client-cloudwatch-logs`

---

## Multi-Format Agent Invocation

Different agents expect different payload structures. The console auto-handles this with configurable payload formats per agent.

### Supported Request Formats

| Format | Payload Sent | Use Case |
|--------|---|---|
| `prompt` (default) | `{"prompt": "..."}` | Most custom agents |
| `messages` | `{"messages": [{"role":"user","content":[{"text":"..."}]}]}` | Converse-style agents |
| `input_text` | `{"input": {"text": "..."}}` | Simple input agents |
| `query` | `{"query": "..."}` | RAG agents |
| `custom` | Raw user input as JSON | Agents expecting custom JSON structs |

### Supported Response Formats (auto-detected)

The console parses agent responses in any of these shapes:
- SSE streams (`data: ...` lines)
- `{ result: { content: [{ text: "..." }] } }` — MCP/A2A style
- `{ output: { message: { content: [{ text: "..." }] } } }` — Converse output
- `{ output: { text: "..." } }` — Simple output
- `{ completion: "..." }` — Completion style
- `{ response: "..." }` — Generic response
- `{ answer: "..." }` — Q&A style
- Raw text fallback

### Configuring Per-Agent Format

```bash
# Set format for a specific agent
curl -X POST http://localhost:3000/api/agentcore/payload-format \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "my-agent-id", "format": "messages"}'

# Check current format
curl http://localhost:3000/api/agentcore/payload-format?agent_id=my-agent-id
```

Format is persisted in `.payload-formats.json` and used automatically on all subsequent invocations. Can also be passed per-request via the `payloadFormat` field in the invoke body.

### Adding a New Invoke Pattern

If your agent uses a payload structure not listed above, add it in two places:

**1. Request format** — `src/lib/agentcore-sdk.ts`, in the `PAYLOAD_BUILDERS` object:

```typescript
// In src/lib/agentcore-sdk.ts, find the PAYLOAD_BUILDERS constant:
const PAYLOAD_BUILDERS: Record<string, (prompt: string, sessionId: string) => object> = {
  prompt: (prompt) => ({ prompt }),
  messages: (prompt) => ({ messages: [{ role: "user", content: [{ text: prompt }] }] }),
  input_text: (prompt) => ({ input: { text: prompt } }),
  query: (prompt) => ({ query: prompt }),
  // ADD YOUR FORMAT HERE:
  my_format: (prompt) => ({ my_field: { nested: prompt }, session: sessionId }),
};
```

**2. Response format** — same file, in the response parsing block (search for `// Handle various response structures`):

```typescript
// Add a new else-if for your agent's response shape:
} else if (parsed.my_response_field?.text) {
  text = parsed.my_response_field.text;
}
```

**3. Register the format name** — `src/app/api/agentcore/payload-format/route.ts`, add your format name to the `valid` array:

```typescript
const valid = ["prompt", "messages", "input_text", "query", "custom", "my_format"];
```

**4. Configure your agent to use it:**

```bash
curl -X POST http://localhost:3000/api/agentcore/payload-format \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "your-agent-id", "format": "my_format"}'
```

That's it — the console will now use your custom format for that agent on every invocation.

---

## Builder Agent (Agent that Creates Agents)

The Build tab is powered by a real AgentCore harness agent that can create other agents. It uses:
- **code_interpreter** — runs Python/boto3 to call AgentCore APIs (CreateHarness, ListAgentRuntimes, etc.)
- **Remote MCP** (optional) — connects to your MCP servers so the builder can discover available tools and wire them into agents it creates

### Deploying the Builder Agent

```bash
# Minimal — builder with code_interpreter only
node deploy/setup-builder-agent.mjs \
  --harness-role-arn arn:aws:iam::ACCOUNT:role/YourHarnessRole

# With MCP servers for tool discovery
node deploy/setup-builder-agent.mjs \
  --harness-role-arn arn:aws:iam::ACCOUNT:role/YourHarnessRole \
  --mcp-url https://api.githubcopilot.com/mcp/ \
  --mcp-url https://my-tools.example.com/mcp

# Memory is auto-provisioned by default. To reuse an existing store instead:
node deploy/setup-builder-agent.mjs \
  --harness-role-arn arn:aws:iam::ACCOUNT:role/YourHarnessRole \
  --mcp-url https://my-tools.example.com/mcp \
  --memory-id my-builder-memory

# Opt out of memory entirely (stateless builder):
node deploy/setup-builder-agent.mjs \
  --harness-role-arn arn:aws:iam::ACCOUNT:role/YourHarnessRole \
  --no-memory
```

**What this creates:**
1. **Builder Agent harness** (`agentcore_hub_builder`) with code_interpreter + any MCP servers you specify
2. **AgentCore Memory store** (`agentcore_hub_builder_memory`, semantic + summary strategies) wired to the harness — unless `--no-memory`

**Output:**
```bash
BUILDER_AGENT_ID=agentcore_hub_builder-xxxxxxxxxx
```

Add to `.env.local` — the Build page will use the real harness agent instead of direct Converse.

### Prerequisites

1. **IAM execution role** for the harness — needs Bedrock model access + AgentCore control plane permissions (CreateHarness, ListHarnesses, ListAgentRuntimes, etc.)
2. **(Optional) MCP server URL(s)** — any MCP server the builder should discover tools from. The builder can then wire these into child agents it creates.
3. **(Optional) AgentCore Memory ID** — for persistent context across sessions

### How It Works

```
User (Build page) → InvokeHarness(agentcore_hub_builder)
                         ↓
              Builder Agent (Claude Sonnet 4.5)
                    ↓ tool calls ↓
    ┌────────────────────────────────────────┐
    │ code_interpreter (boto3)               │
    │  • CreateHarness → deploy new agents  │
    │  • ListHarnesses → see existing       │
    │  • ListGateways → find tools          │
    │  • ListMemories → find memories       │
    ├────────────────────────────────────────┤
    │ Remote MCP Server(s) (optional)        │
    │  • Tools auto-discovered via MCP      │
    │  • Any provider: GitHub, GitLab, Jira │
    │  • Builder wires these into children  │
    └────────────────────────────────────────┘
                    ↓
              Streams response back
```

Without `BUILDER_AGENT_ID`, the Build page falls back to a direct Converse API call (no tools, no memory — just config generation).

---

## Workflow Pipelines (config-driven)

The Workflow tab runs config-driven multi-agent pipelines. A pipeline's **shape**
(ordered phases, intake agent, completion criteria, review gates) is defined in
`src/config/workflows.json`; the **agent roster** is derived from
`src/config/agents.json` (each agent tagged with `workflowDefId` + `phase`). Six
workflows ship by default:

| Workflow | Intake → phases | Output |
|----------|-----------------|--------|
| **Software Delivery** | requirements → design → development → QA | a pull request |
| **Bug Fix** | intake → triage → fix → QA | a fix PR |
| **Dead Code Sweep** | intake → sweep → QA | a cleanup PR |
| **Marketing Campaign** | strategy → creative (social/blog/ads) → assets → brand QA → scheduling | a launched campaign |
| **Sales Proposal** | qualification → drafting → deal review → approval | a routed proposal |
| **Legal Contract Review** | triage → review → redline → sign-off | redlined contract |

Adding a workflow is a config edit (a new `workflows.json` def + agents tagged
with its `workflowDefId`) — no orchestration code changes. The intake agent reads
its `## Available Agents` roster at runtime and fans out the ticket graph.

### Architecture

- **Agents:** Strands agents on AgentCore Runtime (configurable 600s timeout); the software-delivery fleet is 14 agents
- **Orchestration:** ticket-status cascade — DynamoDB Streams (dynamodb mode) or Jira webhooks (jira mode) trigger the next phase
- **Tools:** Agents connect to external tools via MCP (GitHub, GitLab, Jira, etc.) — configurable per deployment
- **Model:** per-agent in `src/config/agents.json` (default Claude Fable 5; fleet-wide fallback via `MODEL_ID` env var)

### Human Review Gates (optional)

Any phase can require human approval before the next phase proceeds. Gates are
declared per workflow in `src/config/workflows.json`:

```jsonc
"reviewGates": [
  {
    "afterPhase": "design",        // gate fires when this phase's agent tickets are all done
    "name": "Design Review",
    "blocking": true,               // true → downstream waits; false → advisory
    "condition": "flagged",         // "always" → always on; "flagged" → opt-in per run (intake form)
    "onReject": "rework",           // "rework" re-opens the reviewed work; "hold" just pauses
    "assignee": "human:design-lead" // a person, not an agent
  }
]
```

How it works (reuses the existing ticket cascade — no new engine):
- The intake agent inserts a review ticket assigned to `human:<who>`, blocked by the phase's agent tickets.
- The orchestrator recognizes `human:*` assignees: it parks the ticket in **in_review** and records a `review_needed` notification instead of invoking an agent. Downstream tickets stay blocked.
- In the UI ticket modal, the reviewer clicks **Approve** (→ done, the cascade resumes) or **Request changes** (→ blocked; a required note is fed back to the reworked agents).
- Works in both backends: Jira shows the **In Review** column with a `reviewer:<who>` label; DynamoDB uses the `in_review` status.
- `flagged` gates are opt-in checkboxes on the intake form; `always` gates apply to every run.

### Jira Integration (Real Jira Cloud)

The platform supports two ticket backends, switchable via a single env var:

| Mode | `TICKET_PROVIDER` | Backend | Trigger |
|------|-------------------|---------|---------|
| Mock | `dynamodb` (code default when unset) | DynamoDB tables | DynamoDB Streams → orchestrator Lambda |
| Real | `jira` (what `.env.example`/`Dockerfile` ship) | Jira Cloud REST API | Jira webhook → `/api/jira/webhook` |

**To switch to real Jira:**

```bash
# .env.local (or App Runner / container env vars)
TICKET_PROVIDER=jira
JIRA_SITE_URL=your-site.atlassian.net
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=your-api-token
JIRA_PROJECT_KEY=TEAM
```

**Jira project requirements:**
- Project type: **Team-managed** (next-gen) software project
- Issue link type: `Blocks` (standard, exists by default)
- Agent assignments stored as labels: `agent:agentcore_hub_frontend_dev`
- Workflow IDs stored as labels: `wf:wf_123456`

**Workflow setup (required):**

The project workflow must have exactly these 6 statuses with transitions between all of them:

| Status | Category | Purpose |
|--------|----------|---------|
| `To Do` | To Do | Initial state on ticket creation |
| `Blocked` | In Progress | Ticket has unresolved dependencies |
| `Ready` | In Progress | All blockers resolved, agent can start |
| `In Progress` | In Progress | Agent is actively working |
| `In Review` | In Progress | Agent output under review |
| `Done` | Done | Agent completed successfully |

To configure:
1. Go to **Project Settings → Board → Workflow**
2. Add all 6 statuses as columns
3. Every status must be able to transition to every other status (all-to-all)

> **Note:** This is the only supported workflow configuration. Other Jira workflow setups will not work.

**Webhook setup** (required for cascade orchestration):
1. In Jira → Settings → Webhooks → Create webhook
2. URL: `https://your-deployed-app.com/api/jira/webhook`
3. Events: `issue_created`, `issue_updated`
   - `issue_updated` drives the cascade (transitions on existing tickets)
   - `issue_created` enables the third intake path: filing a Bug directly in Jira auto-bootstraps a workflow (the orchestrator creates the workflow row + analyst sub-task and routes it through the bug-fix flow)
4. Filter: project = YOUR_PROJECT_KEY

**Three intake paths** (all converge on the same orchestrator):
1. **In-app form** — `POST /api/workflow/start` (UI submission)
2. **Programmatic API** — `POST /api/workflow/start` with the same payload (Claude Code, scripts, CI)
3. **Jira-native bug** — file a `Bug` issue in Jira directly. The `issue_created` webhook bootstraps a workflow keyed off the Bug, creates a requirements-analyst sub-task under it, and the analyst loads the `bug-fix-requirements` blueprint to produce a 3-subtask chain (Fix → QA → CI).

**Agent Jira Lambda** (separate infra, agents call Jira through this):
- Function: `agentcore-hub-jira` — SAM-deployed Lambda (for Jira mode) or `agentcore-hub-tickets` (for DynamoDB mode)
- Only invocable by `bedrock-agentcore.amazonaws.com`
- Deploy: see `lambda/agentcore-hub-jira/` for Jira mode or `lambda/agentcore-hub-tickets/` for DynamoDB mode

### Agent Roster (Config-Driven)

The roster of valid agents is defined in `src/config/agents.json` — the single source of truth. This file is synced to S3 during deployment, and all Lambdas (orchestrator, agentcore-hub-tickets, agentcore-hub-jira) load it on cold start.

**To add/remove agents:**
1. Edit `src/config/agents.json`
2. Sync to S3: `aws s3 cp src/config/agents.json s3://{ARTIFACT_BUCKET}/config/agents.json`
3. Lambdas pick up changes on next cold start — no redeployment needed

The orchestrator uses this to resolve agent ID → Runtime ARN mapping. The ticket Lambdas use it to validate assignees before accepting a ticket (rejects unknown agent IDs with a helpful error). See `docs/agent-fleet-documentation.md` § "Agent Roster" for full details.

### Deploying the Agent Fleet

**Prerequisites:**
- Install the AgentCore CLI: `pip install "bedrock-agentcore-starter-toolkit>=0.1.21"`
- `ARTIFACT_BUCKET` set in `.env.local` (prompts and config are uploaded to S3 for each agent)
- `GITHUB_PAT` set in `.env.local` — agents need this for GitHub MCP tools (PRs, code push, file reads). Without it, agents can still run but cannot interact with GitHub.

The script automatically creates the IAM execution role (`agentcore-hub-agentcore-role`) if it doesn't exist. It also configures:
- `CLAUDE_CODE_USE_BEDROCK=1` — enables the Claude Code SDK tool to authenticate via Bedrock (no API key needed)
- `GITHUB_PAT` — read from `.env.local` and passed to each agent for GitHub MCP access

```bash
# Deploy all 14 agents (reads GITHUB_PAT from .env.local automatically)
cd deploy/runtime-agent
./deploy-fleet.sh

# With custom MCP servers (JSON array — overrides GITHUB_PAT shorthand)
MCP_SERVERS='[{"url":"https://api.githubcopilot.com/mcp/","headers":{"Authorization":"Bearer ghp_xxx"}}]' \
  ./deploy-fleet.sh
```

The script deploys all 14 agents (3 concurrent), then runs a health check that invokes each agent to verify it responds.

Expected output: `Results: 14/14 passed, 0 failed`

### MCP Flexibility

Each customer plugs in their own tooling via the `MCP_SERVERS` environment variable — a JSON array of `{url, headers}` objects. Examples:
- **GitHub:** `https://api.githubcopilot.com/mcp/` + Bearer token
- **GitLab:** Your GitLab MCP server URL
- **Jira/Linear/Asana:** Any project management MCP server
- **Custom tools:** Any MCP-compatible server

`GITHUB_PAT` is supported as a shorthand for the common GitHub case.

### Pipeline Phases (Software Delivery workflow)

| Phase | Agents | Function |
|-------|--------|----------|
| Requirements | 1 (Requirements Analyst) | Analyze PRD, create tickets, skip irrelevant agents |
| Design | 8 (Frontend, iOS, Android, Backend, Security, Legal, Localization, Analytics) | Parallel design docs |
| Development | 3 (Backend Dev, API Dev, Frontend Dev) | Parallel code generation + PR |
| QA | 2 (QA Verifier, CI Agent) | Test verification + code review |

The Marketing, Sales, and Legal workflows have their own phase/agent rosters —
see `src/config/workflows.json` and `src/config/agents.json`.

### Why the workflow fleet uses Runtime agents

The workflow fleet ships as AgentCore **Runtime** agents, not Harness agents. Runtime agents emit OTEL spans from their own code while running, which is what powers the live UI streaming. With harnesses, event capture is tied to the synchronous `InvokeHarness` response, so a fire-and-forget invocation (which the orchestrator uses) loses the stream. The Builder agent is a harness because single-turn chat doesn't need event streaming. The `InvokeHarness` invocation path is preserved in the app for that reason.

---

## Continuous Improvement (Self-Improvement Loop)

The platform includes an optional **self-improvement loop** that automatically evaluates every agent invocation and fixes issues without human intervention.

### How It Works

```
Agent runs → OTEL traces → XRay → Online Evaluation (10 evaluators)
    → eval-packager Lambda buffers sessions; on flush it
    → invokes the Fleet Improver runtime → root-cause analysis → JSON PRD {title, description}
    → writes PRD to s3 prd/ → prd-submitter → [SI] Workflow Run → PR
```

The Fleet Improver runtime must be deployed for synthesis to run
(`cd deploy/runtime-agent && ./deploy-one.sh agentcore_hub_fleet_improver`).
Without it, eval-packager archives batches but skips the workflow trigger.

Every agent invocation is evaluated by 10 criteria (tool selection, instruction following, correctness, etc.) using a judge model. When scores drop, the fleet improver agent determines whether the fix is a prompt change, a missing tool, a permissions issue, or an infrastructure problem — then creates a PRD that triggers the same 14-agent pipeline to produce a fix PR.

### One-Command Setup

```bash
export DEPLOYMENT_URL=https://your-service.ecs.us-east-1.on.aws
cd deploy/continuous-improvement
./deploy-all.sh
```

This sets up: XRay indexing (100%), online eval configs for all 14 agents, the eval-packager and prd-submitter Lambdas, CW Logs subscription filters, and EventBridge wiring.

### Verification

```bash
./verify.sh    # Checks all 8 components of the loop
```

### Toggle On/Off

The Evaluations page in the UI provides a toggle. Under the hood, it sets eval-packager Lambda concurrency to 0 (paused) or removes the limit (active). Eval results still accumulate when paused.

See [`deploy/continuous-improvement/README.md`](deploy/continuous-improvement/README.md) for full architecture, IAM requirements, and troubleshooting.

---

## Production Deployment

> **Note:** If you followed the Setup stages above, infrastructure (DynamoDB, S3, Lambda) is already created. This section covers deploying the app to a hosted environment instead of `localhost:3000`.

This app is designed to be deployed into a customer's AWS environment. The AWS SDK credential chain means **zero code changes** are needed — just deploy where an IAM role is available.

### Infrastructure Prerequisites

Create the required DynamoDB tables before deploying (run once per account — **skip if you already ran Stage 3**):

```bash
# Default: creates workflows + events tables (for Jira ticket provider)
./scripts/create-dynamodb-tables.sh

# With DynamoDB tickets table (for TICKET_PROVIDER=dynamodb)
./scripts/create-dynamodb-tables.sh --with-tickets
```

This creates:
- `agentcore-hub-workflows` — PK: `workflowId` (S), GSI: `epicId-index`
- `agentcore-hub-events` — PK: `workflowId` (S), SK: `eventId` (S)
- `agentcore-hub-tickets` *(only with `--with-tickets`)* — PK: `ticketId` (S), with DynamoDB Streams enabled for orchestration

**Which mode should I use?**
- `TICKET_PROVIDER=jira` — Jira Cloud is the ticket store. No tickets table needed.
- `TICKET_PROVIDER=dynamodb` — DynamoDB is the ticket store. Pass `--with-tickets` to create the table.

### Deployment Options

#### Option A: Amazon ECS Express Mode + ECR (Recommended)

One script provisions everything — ECR repo, the three IAM roles, a Docker
build+push, and an ECS Express Mode service (Fargate + Application Load Balancer
+ auto scaling + a public `https://<service>.ecs.<region>.on.aws` URL). This is
AWS's recommended path now that **App Runner is closed to new customers and is
being sunset (April 30, 2026)** — see the [App Runner availability change](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html).
Express Mode is the named successor and preserves App Runner's operational
simplicity.

```bash
# Prereqs: AWS CLI v2 >= 2.34, Docker running, a default VPC with public subnets
# in AWS_REGION, and .env.local populated (runtime env vars are forwarded in).
./deploy/ecs-express/deploy.sh
```

The script is idempotent: re-running it rebuilds the image and updates the
existing service in place (found by name in the `default` cluster). It writes the
resulting public URL back to `.env.local` as `DEPLOYMENT_URL`.

**Roles it creates** (execution vs task vs infrastructure are distinct — do not
conflate them):
- `ecsTaskExecutionRole` — ECS pulls the image + writes logs (managed policy `AmazonECSTaskExecutionRolePolicy`)
- `ecsInfrastructureRoleForExpressServices` — ECS provisions the ALB/scaling (managed policy `AmazonECSInfrastructureRoleforExpressGatewayServices`)
- `agentcore-hub-ecs-task` — **the app's own** runtime permissions (DynamoDB, S3, Bedrock, AgentCore, Secrets Manager, CloudWatch); this is the direct successor to the App Runner instance role

**Tuning knobs** (env vars, all optional): `EXPRESS_CPU` (CPU units, default
`1024` = 1 vCPU), `EXPRESS_MEMORY` (MiB, default `2048` = 2 GB — must be a valid
Fargate combo with the CPU), `EXPRESS_SUBNETS` + `EXPRESS_SECURITY_GROUPS`
(comma-separated — only needed if you have no usable default VPC),
`EXPRESS_CLUSTER` (default `default`).

> **Redeploys replace running tasks.** `update-express-gateway-service` rolls out
> a new task set; env var / secret changes take effect only on that new
> deployment (no hot-reload). The script does this automatically on every run.

**Build-time configuration:**

The Dockerfile sets `ENV TICKET_PROVIDER=jira` in the builder stage. This value is baked into the frontend bundle at build time (controls the dashboard UI label). If you're deploying for DynamoDB mode, change this to `dynamodb` before building:

```dockerfile
ENV TICKET_PROVIDER=dynamodb  # Set BEFORE 'RUN npm run build'
```

**Dockerfile requirements:**

The `Dockerfile` uses a multi-stage build with a non-root `nextjs` user. The following line is **critical** and must appear before `USER nextjs`:

```dockerfile
RUN mkdir -p /app/.next/cache && chown -R nextjs:nodejs /app/.next/cache
```

Without this, Next.js cannot write its ISR/fetch cache at runtime, which causes EACCES errors that destabilize the process and make the ALB health check fail (the deployment circuit breaker then rolls the service back).

Also critical for any container host (baked into the Dockerfile + set by the
deploy script): `HOSTNAME=0.0.0.0` and `PORT=8080`. Next.js standalone binds to
whatever `HOSTNAME` resolves to, and some hosts inject their own at launch — pin
it to all-interfaces or the health check on `:8080` never passes.

**Deployment troubleshooting:**

| Symptom | Cause | Fix |
|---------|-------|-----|
| Health check fails, app logs show `EACCES: permission denied, mkdir '/app/.next/cache'` | Cache dir not writable by nextjs user | Add the `mkdir`/`chown` line above |
| Health check fails, app logs show repeating error loops (e.g. DDB query errors) | A background process (SSE stream, polling) crashes the Node.js process | Fix the error in the offending route — error loops destabilize the container |
| ALB returns 502 Bad Gateway | Container not listening on `:8080`, or `HOSTNAME` not `0.0.0.0` | Verify the two env vars above; check the task's CloudWatch logs |
| Service stuck deploying then rolls back | Health check failing on the new task set | `aws ecs describe-express-gateway-service --service-arn <arn>`; check stopped-task reasons in the ECS console |
| `AccessDeniedException` on AWS calls from the app | Perms on the execution role instead of the **task** role | Ensure `agentcore-hub-ecs-task` carries the runtime policy (the deploy script does this) |

**Required IAM roles** (all created by `deploy/ecs-express/deploy.sh`):
- `ecsTaskExecutionRole` — ECS pulls the image + writes logs
- `ecsInfrastructureRoleForExpressServices` — ECS provisions the ALB + auto scaling
- `agentcore-hub-ecs-task` — the app's runtime permissions (DynamoDB, Bedrock, Lambda invoke, S3, CloudWatch Logs, BedrockAgentCore, Secrets Manager)

The deploy script forwards runtime env vars from `.env.local` into the container automatically. If setting them by hand elsewhere:
- `TICKET_PROVIDER=jira` (or `dynamodb`)
- `WORKFLOWS_TABLE=agentcore-hub-workflows`
- `EVENTS_TABLE=agentcore-hub-events`
- `ARTIFACT_BUCKET=agentcore-hub-artifacts-<ACCOUNT_ID>-<REGION>` (e.g. `agentcore-hub-artifacts-123456789012-us-east-1`)
- `GITHUB_PAT=ghp_xxx` (for MCP tools)
- `TICKET_TOOLS_LAMBDA=agentcore-hub-jira` (or `agentcore-hub-tickets` for DynamoDB mode)

For Jira mode, also set:
- `JIRA_SITE_URL=your-site.atlassian.net`
- `JIRA_EMAIL=you@company.com`
- `JIRA_API_TOKEN=your-api-token`
- `JIRA_PROJECT_KEY=TEAM`

**Note:** When using `TICKET_PROVIDER=jira`, deploy the `agentcore-hub-jira` Lambda. When using `TICKET_PROVIDER=dynamodb`, deploy the `agentcore-hub-tickets` Lambda. Set `TICKET_TOOLS_LAMBDA` on your agents to match whichever you deploy.

#### Option B: AWS Amplify Hosting

1. Connect your repo to Amplify Hosting
2. Amplify provides an IAM service role — attach the required policy (below)
3. Add Cognito for user authentication
4. Done — Amplify handles build, deploy, CDN, and custom domains

#### Option C: ECS/Fargate or Lambda Web Adapter

1. Use the included `Dockerfile` (`npm run build` + standalone output)
2. Deploy to ECS Fargate or Lambda via Lambda Web Adapter
3. Attach an **IAM Task Role** (ECS) or **Lambda Execution Role** with the required policy
4. Front with ALB or CloudFront + API Gateway
5. Add auth via Cognito, IAM Identity Center, or existing IdP

#### Option D: Integrate Into Existing Site

If you already have a hosted Next.js or React app:

1. Merge the `src/app/api/agentcore/` routes and `src/lib/agentcore-sdk.ts` into your existing app
2. Add the dashboard page (`src/app/page.tsx`) and agent detail page (`src/app/agents/[id]/page.tsx`)
3. Install the required AWS SDK packages (see `package.json`)
4. Add the IAM permissions below to your existing compute role
5. No additional credential configuration needed — uses whatever role your app already runs as

#### Option E: AWS App Runner (legacy — existing customers only)

> App Runner is **closed to new customers** and being sunset (April 30, 2026).
> Only use this if your account already runs an App Runner service; new deploys
> should use Option A (ECS Express Mode). See the [availability change notice](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html).

The original App Runner script is preserved at `deploy/apprunner/deploy.sh` for
existing users. It creates the ECR repo, the `AppRunnerECRAccessRole` +
`agentcore-hub-apprunner-instance` roles, builds + pushes, and creates/updates
the service. To migrate to Express Mode, AWS recommends a blue/green DNS cutover
(run both, shift traffic via Route 53 weighted records); the [migration guide](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html)
has the steps.

### SSE Proxy Considerations

The workflow UI relies on Server-Sent Events (`/api/workflow/[id]/stream`) for real-time event streaming. SSE requires an unbuffered, long-lived HTTP connection — most reverse proxies break this by default. The response sets `X-Accel-Buffering: no` and `Content-Encoding: identity` to handle nginx-style proxies, but some platforms need additional config:

| Platform | SSE works out of the box? | Required config |
|----------|---------------------------|-----------------|
| **ECS Express Mode** (Option A) | Yes, with config | Runs behind a managed ALB — raise the ALB `idle_timeout` to `>= 3600` (default 60s kills long SSE connections). Set it on the Express service's load balancer in the EC2 console. |
| **Amplify Hosting** (Option B) | Yes | None — runs behind CloudFront with origin-shield bypass |
| **ECS/Fargate behind ALB** (Option C) | Yes, with config | Set ALB `IdleTimeout >= 3600` (default 60s kills SSE) |
| **Lambda Web Adapter** (Option C) | Limited | Use Lambda function URL with `RESPONSE_STREAM` invocation. API Gateway buffers and has 30s timeout — **don't put SSE behind API Gateway** |
| **App Runner** (Option E, legacy) | Yes | None — Envoy honors response headers |
| **EKS with ingress-nginx** | Yes, with annotation | Add `nginx.ingress.kubernetes.io/proxy-buffering: "off"` to the ingress |
| **CloudFront** in front of any origin | No | CloudFront buffers + has 30s idle timeout. Route SSE endpoints around CloudFront (separate path → ALB direct) |
| **Cloudflare** in front | Yes, with rule | Add a Cache Rule that bypasses cache for `/api/workflow/*/stream` |

**Symptom that you have a buffering proxy:** The replay widget's live event counter doesn't tick up in real time, but `curl -N` directly to `/api/workflow/[id]/stream` shows events flowing fine. The browser is receiving chunks in batches because the proxy is holding bytes.

### Required IAM Policy

Attach this policy to whichever IAM role your compute uses (Amplify service role, ECS task role, Lambda execution role, etc.):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AgentCoreFullAccess",
      "Effect": "Allow",
      "Action": [
        "bedrock-agentcore:InvokeAgentRuntime",
        "bedrock-agentcore:InvokeHarness",
        "bedrock-agentcore:ListAgentRuntimes",
        "bedrock-agentcore:ListHarnesses",
        "bedrock-agentcore:ListMemories",
        "bedrock-agentcore:GetAgentRuntime",
        "bedrock-agentcore:GetHarness",
        "bedrock-agentcore:CreateHarness",
        "bedrock-agentcore:ListSessions",
        "bedrock-agentcore:ListActors",
        "bedrock-agentcore:ListEvents",
        "bedrock-agentcore:CreateEvent",
        "bedrock-agentcore:RetrieveMemoryRecords"
      ],
      "Resource": "*"
    },
    {
      "Sid": "PassRoleForHarnessCreation",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::*:role/*",
      "Condition": {
        "StringEquals": {
          "iam:PassedToService": "bedrock-agentcore.amazonaws.com"
        }
      }
    },
    {
      "Sid": "CloudWatchMetrics",
      "Effect": "Allow",
      "Action": [
        "cloudwatch:GetMetricStatistics",
        "cloudwatch:ListMetrics"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CloudWatchLogsTraces",
      "Effect": "Allow",
      "Action": [
        "logs:StartQuery",
        "logs:GetQueryResults",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams"
      ],
      "Resource": [
        "arn:aws:logs:*:*:log-group:aws/spans:*",
        "arn:aws:logs:*:*:log-group:/aws/bedrock-agentcore/runtimes/*"
      ]
    },
    {
      "Sid": "BedrockModelAccess",
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": "arn:aws:bedrock:*:*:inference-profile/*"
    }
  ]
}
```

#### Scoping Down Permissions

To restrict to specific agents or regions:

- Replace `"Resource": "*"` in `AgentCoreFullAccess` with specific agent ARNs:
  ```
  "arn:aws:bedrock-agentcore:us-east-1:ACCOUNT_ID:runtime/*"
  "arn:aws:bedrock-agentcore:us-east-1:ACCOUNT_ID:harness/*"
  "arn:aws:bedrock-agentcore:us-east-1:ACCOUNT_ID:memory/*"
  ```
- The `CloudWatchLogsTraces` statement is already scoped to AgentCore log groups and the `aws/spans` group
- The `PassRoleForHarnessCreation` statement is only needed if using the Deploy button on the Build page. Scope the `Resource` to your specific harness execution role ARN for tighter security.
- The `BedrockModelAccess` is only needed if using the Builder feature (agent creation via Converse API)

### Agent Runtime Role (`agentcore-hub-agentcore-role`)

The 14 pipeline agents run on AgentCore Runtime with their own execution role. This role needs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], "Resource": "*"},
    {"Effect": "Allow", "Action": ["bedrock-agentcore:*"], "Resource": "*"},
    {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:ListBucket"], "Resource": ["arn:aws:s3:::agentcore-hub-artifacts-ACCOUNT-REGION", "arn:aws:s3:::agentcore-hub-artifacts-ACCOUNT-REGION/*"]},
    {"Effect": "Allow", "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], "Resource": "*"},
    {"Effect": "Allow", "Action": ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem", "dynamodb:BatchWriteItem"], "Resource": "arn:aws:dynamodb:*:*:table/agentcore-hub-*"},
    {"Effect": "Allow", "Action": ["lambda:InvokeFunction"], "Resource": "arn:aws:lambda:*:*:function:agentcore-hub-*"},
    {"Effect": "Allow", "Action": ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"], "Resource": "*"}
  ]
}
```

> **Critical:** The XRay permissions are required for the Self-Improvement loop. Without them, the OTEL collector cannot export traces, and evaluations will report "No spans found."

### Authentication

The app itself has no built-in auth. For production, add one of:

- **Amazon Cognito** — Easiest with Amplify; add a User Pool + hosted UI
- **IAM Identity Center** — For internal/enterprise use with SSO
- **Existing IdP** — SAML/OIDC federation through Cognito or directly

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AWS_REGION` | No | `us-east-1` | AWS region where agents are deployed |
| `AWS_ACCESS_KEY_ID` | No* | — | Only needed for local dev; use IAM roles in production |
| `AWS_SECRET_ACCESS_KEY` | No* | — | Only needed for local dev; use IAM roles in production |

*The AWS SDK credential chain automatically picks up: env vars → IAM role (ECS/Lambda/EC2) → `~/.aws/credentials`. In production, always use IAM roles — never hardcode keys.

---

## Testing

The project includes a comprehensive Playwright test suite that validates all UI tabs, API routes, and end-to-end workflow execution.

### Setup

```bash
npm install
npx playwright install chromium
```

### Run Tests

```bash
# Quick UI validation — all tabs + API routes (~15 seconds)
npm test

# Full suite including real workflow submission (~5-10 minutes)
./tests/run-all.sh --full

# Individual tab tests
npx playwright test tests/tab-dashboard.spec.ts
npx playwright test tests/tab-agents.spec.ts
npx playwright test tests/tab-build.spec.ts
npx playwright test tests/tab-workflow.spec.ts
npx playwright test tests/tab-tickets.spec.ts

# End-to-end workflow (submits real workflow, monitors pipeline)
npx playwright test tests/e2e-workflow-full.spec.ts --timeout 600000
```

### Test Coverage

| Suite | What it validates |
|-------|-------------------|
| `tab-dashboard` | Metrics, navigation, sidebar collapse/expand |
| `tab-agents` | Agent discovery, card rendering, detail page chat |
| `tab-build` | Builder chat interface, inputs, deploy button |
| `tab-workflow` | Intake form, model selector, workflow history |
| `tab-tickets` | Ticket history table, search/filter |
| `e2e-api-routes` | All API endpoints return expected data |
| `e2e-workflow-full` | Real workflow submission + phase progression |

Screenshots are saved to `test-results/` on failure for debugging.

### Agent Fleet Integration Test (Full Tool Validation)

After deploying the fleet (Stage 6), run the comprehensive integration test that exercises **every tool** each agent has — 40 tests across 9 groups per agent:

```bash
# One-time setup: uploads S3 fixtures, validates Jira/GitHub access
cd deploy/runtime-agent
./setup-healthcheck.sh

# Run full integration test (14 agents × 40 tests, ~10 minutes)
python3 verify-fleet-invoke.py \
  --fleet-file fleet-runtime-ids.json \
  --timeout 540 \
  --parallel 3

# Test a single agent (faster iteration)
python3 verify-fleet-invoke.py \
  --fleet-file fleet-runtime-ids.json \
  --agent agentcore_hub_requirements_analyst \
  --timeout 540 --verbose
```

This validates:
- Built-in Strands tools (shell, file_read, editor, python_repl, code_interpreter, browser, etc.)
- Claude Code SDK integration
- Lambda-backed tools (S3, Jira lifecycle, workflow output, skill loader)
- GitHub MCP tools (branches, PRs, file commits)
- Knowledge Base retrieve (if configured)

Expected output: per-agent tool matrix showing pass/fail/missing for every tool, plus role-based validation ensuring each agent type has the tools it needs.

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.

## Security

See [CONTRIBUTING.md](CONTRIBUTING.md#security-issue-notifications) for information about reporting security issues. Do not create a public GitHub issue for security vulnerabilities.

## License

This project is licensed under the Apache License 2.0. See the [LICENSE](LICENSE) and [NOTICE](NOTICE) files for details.
