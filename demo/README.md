# AgentCore Hub — Demo & Testing

## Running Test Workflows

Use the standard test script to start workflows via the API:

```bash
# From repo root:
./scripts/start-test-workflow.sh                     # Default test
./scripts/start-test-workflow.sh --scope minimal     # Fastest (~5 min)
./scripts/start-test-workflow.sh --scope sidebar     # Medium (~20 min)
./scripts/start-test-workflow.sh --scope full        # Full pipeline (~30 min)
./scripts/start-test-workflow.sh --model sonnet      # Use Sonnet (faster/cheaper)
```

Requires the Next.js dev server on `localhost:3000` and AWS credentials. See `docs/workflow-pipeline-architecture.md` for full details.

> **Warning**: Do NOT start workflows by writing directly to DynamoDB or using custom scripts that bypass `/api/workflow/start`. This produces broken records with missing dates and no ticket skeletons.

---

## Architecture Pipeline Visualization

**File:** `agentcore-hub-v1-pipeline.html`
**Type:** Single-file HTML (self-contained, no external dependencies)
**Size:** ~141KB (icons are base64-embedded)

## What This Is

An animated architecture visualization showing the full AgentCore Hub multi-agent development pipeline. It demonstrates how 13 AWS Bedrock AgentCore agents across 5 phases autonomously take a PRD/mockup from intake to shipped code with zero human intervention.

Open `agentcore-hub-v1-pipeline.html` directly in any modern browser — no server needed.

## Pipeline Architecture (5 Phases)

### Phase 1: Intake (Web Application)
- **Type:** Next.js 15 App Router (not an agent)
- **Function:** User uploads PRD/mockup/Figma, sets target repo, artifacts stored in S3
- **Trigger:** Creates epic + pre-creates ALL 13 agent ticket skeletons with dependency chains in DynamoDB. Requirements ticket starts as "todo" (no blockers), all others start "blocked". DynamoDB Stream triggers orchestrator.

### Phase 2: Requirements (1 Agent)
- **Agent:** Requirements Analyst
- **Model:** Claude Opus 4.6 via Bedrock (`us.anthropic.claude-opus-4-6-v1`)
- **Built-in Tools:** S3 Read/Write, Jira (list_tickets, transition_ticket, update_ticket, add_comment), image_reader, http_request, current_time
- **MCP Tools:** GitHub (`get_file_contents`, `search_code`) + any customer-configured MCP servers
- **Process:** Read PRD from S3 → Analyze requirements → List pre-created ticket skeletons under epic → Skip irrelevant agents (transition "skip" with reason) → Update relevant tickets with detailed requirements → Transition own ticket to "done" → DynamoDB Stream cascade unblocks design phase

### Phase 3: Design (7 Agents in Parallel)
- **Agents:** iOS Designer, Backend Designer, Android Designer, Security Reviewer, Legal & Compliance, Localization, Analytics Designer
- **Model:** Claude Opus 4.6 via Bedrock
- **Built-in Tools:** S3 Read/Write, Agent-to-Agent invoke, image_reader, http_request, current_time
- **MCP Tools:** GitHub (`get_file_contents`, `search_code`) + any customer-configured MCP servers
- **Process:** Unblocked by requirements completion → All non-skipped agents wake simultaneously → Read requirements from S3 → Produce design docs in parallel → Write artifacts to S3 → Orchestrator marks ticket "done" → DynamoDB Stream cascade unblocks dev phase

### Phase 4: Development (3 Agents in Parallel)
- **Agents:** Backend Developer, API Developer, Frontend Developer
- **Model:** Claude Opus 4.6 via Bedrock
- **Built-in Tools:** S3 Read/Write, Code Interpreter, Agent-to-Agent invoke, image_reader, http_request, current_time
- **MCP Tools:** GitHub (`get_file_contents`, `create_or_update_file`, `create_branch`, `create_pull_request`, `search_code`) + any customer-configured MCP servers
- **Process:** Unblocked by ALL design tickets completing → Code in parallel → Commit to feature branch + push PR via GitHub MCP → Orchestrator marks ticket "done" → DynamoDB Stream cascade unblocks QA

### Phase 5: QA & Ship (2 Agents)
- **Agents:** QA Verifier, CI Validation Agent
- **Model:** Claude Opus 4.6 via Bedrock
- **Built-in Tools:** S3 Read/Write, Code Interpreter, Agent-to-Agent invoke, image_reader, http_request, current_time
- **MCP Tools:** GitHub (`get_file_contents`, `create_or_update_file`, `create_branch`, `create_pull_request`) + any customer-configured MCP servers
- **Process:** Unblocked by ALL dev tickets completing → Read feature branch via GitHub MCP tools → Run tests in Code Interpreter sandbox → Code review + test verification → Workflow complete

## Tool Delivery: MCP (Model Context Protocol)

All external tools (GitHub, GitLab, Jira, Asana, etc.) are delivered to agents via **MCP** — the universal protocol for connecting AI agents to tools. Each agent connects to configured MCP servers at invocation time using Strands MCPClient.

**Configuration:**
- `GITHUB_PAT` env var — shorthand for GitHub's hosted MCP (`https://api.githubcopilot.com/mcp/`)
- `MCP_SERVERS` env var — JSON array for any MCP server: `[{"url":"...","headers":{...}}]`

This means agents are **tool-agnostic** — customers plug in their own infrastructure (GitHub, GitLab, Bitbucket, Jira, Linear, Asana, internal tools) without changing agent code.

## Agent Runtime

Agents are deployed on **AgentCore Runtime** (not Harness) using Strands Agents SDK (Python). Key details:
- **Deploy type:** `direct_code_deploy` (CodeZip, no Docker)
- **Runtime:** Python 3.10
- **Timeout:** 600s botocore read_timeout (configurable via `READ_TIMEOUT` env var)
- **Source:** `deploy/runtime-agent/main.py`
- **Deploy script:** `deploy/runtime-agent/deploy-fleet.sh`

## Animation Behavior

### Timing
- Each phase activates sequentially (pipeline flow)
- Within phases, parallel agents activate **simultaneously** (not cascading)
- Tools activate when used, re-activate when re-used (e.g., S3 tool lights up again when writing output)
- Git CLI and output items (Feature Branch, PR) light up simultaneously to show they're the same action

### Visual States
| State | Border Color | Effect |
|-------|-------------|--------|
| Inactive | `#1e293b` (dark) | 35% opacity |
| Active | `#0ea5e9` (blue) | Blue glow |
| Working | `#0ea5e9` (blue) | Breathing pulse animation |
| Done | `#22c55e` (green) | Subtle green glow |
| Trigger | `#f97316` (orange) | Brief scale pulse (connector fires) |

### Celebration Effect
On pipeline completion, all elements burst simultaneously using CSS `@keyframes` animations (not transitions — transitions can stagger due to browser paint order). Burst starts bright orange/white and settles back to subtle done state over 1.2s.

Key implementation detail: `document.body.offsetHeight` forces a reflow before adding the `celebrate` class, ensuring all animations start on the exact same frame.

## AWS Icons Used

All icons are from the official **AWS Architecture Icons** package (version 04302026), 48px PNG variants, base64-embedded:

| Icon | Service | Used For |
|------|---------|----------|
| `Arch_Amazon-Bedrock_48.png` | Amazon Bedrock | Model provider (Claude Opus 4.6) |
| `Arch_Amazon-Bedrock-AgentCore_48.png` | Bedrock AgentCore | Agent runtime |
| `Arch_Amazon-Simple-Storage-Service_48.png` | Amazon S3 | Artifact storage |
| `Arch_Amazon-EventBridge_48.png` | Amazon EventBridge | Intake trigger |
| `Arch_AWS-CodeBuild_48.png` | (repurposed) | Code Interpreter sandbox |

Icons source: https://aws.amazon.com/architecture/icons/

## How to Recreate

### Prerequisites
1. Download AWS Architecture Icons: https://aws.amazon.com/architecture/icons/
2. Extract to get the 48px PNG files from `Architecture-Service-Icons_*/Arch_*/48/`

### Base64 Encoding Icons
```bash
# Example: encode an icon to base64 for embedding
base64 -i "Arch_Amazon-Bedrock_48.png" | tr -d '\n'
```

### Structure
The file is a single HTML document with:
1. `<style>` block — all CSS including animations
2. `<body>` — HTML structure (legend, 5 phase columns, status bar, controls)
3. `<script>` block — animation orchestration (async/await with sleep intervals)

### Key CSS Classes
- `.phase` — column container (states: active, done)
- `.agent-box` — phase header box (states: awake, done)
- `.item` — individual row (states: active, working, done, trigger)
- `.flow-path` — SVG connector between phases

### Key JavaScript Functions
- `activate(id, desc)` — light up an item (removes done state for re-activation)
- `startWorking(id)` — start breathing pulse
- `done(id)` — mark complete
- `trigger(id)` — orange flash (for connector-firing items)
- `wakeAgent(boxId)` / `doneAgent(boxId)` — phase box states
- `animateConnector(fromId, fromSide, toId, toSide, duration)` — draw animated SVG path between elements

### Animation Timing (approximate)
- Phase 1 (Intake): ~3.5s
- Phase 2 (Requirements): ~6s
- Phase 3 (Design): ~5s
- Phase 4 (Development): ~6s
- Phase 5 (QA & Ship): ~7s
- Celebration: 1.5s
- **Total runtime: ~30s**

## Architectural Accuracy Notes

- **Pre-created ticket skeletons** — ALL 13 tickets are created at workflow start with dependency chains. Requirements agent SKIPs irrelevant ones (transitions to "done"). No runtime ticket creation needed.
- **DynamoDB Streams cascade** — the SOLE orchestration mechanism. Ticket status changes fire stream events → orchestrator Lambda unblocks dependents → next agents invoke.
- **Orchestrator Lambda** — async fire-and-forget. Invokes AgentCore Runtime agents, streams output via SSE to UI, marks ticket "done" after agent completes.
- **Agents own the logic** — agents use their Jira tools to skip/update/transition tickets. No application-layer parsing of agent output.
- **SSE** is used for real-time UI notifications (agent streaming output, phase transitions, tool use events).
- **Code Interpreter** is the actual Bedrock AgentCore tool (not AWS CodeBuild, but we use that icon as a visual stand-in)
- **Git operations** use GitHub MCP tools directly (via MCPClient + streamable HTTP transport), not a separate gateway target
- **Agent-to-Agent** (`invoke_team_agent`) allows cross-agent queries within the same workflow
- **MCP servers** are connected per-invocation by the Runtime agent code — each agent gets the same set of MCP tools configured via environment variables

## File Location

- **Canonical copy:** `demo/agentcore-hub-v1-pipeline.html` (relative to repo root)
