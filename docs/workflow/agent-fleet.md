# Agent Fleet (workflow module)

The Strands personas, their tools/skills, and how they delegate to the coding CLIs on the coding-agent runtime. Runtime infra: `deploy/coding-agent-runtime/README.md`. System topology + decision log: [`../architecture.md`](../architecture.md).

## Fleet Overview

20 specialized agents make up the delivery fleet (16 form the software-delivery pipeline — see below; the other 4 serve the bug-fix, operator, sweep, and self-improvement flows), deployed on AWS Bedrock AgentCore Runtime. 15 run as dedicated runtimes; `release_manager`, `fleet_improver`, `bug_fixer`, `operator`, and `code_sweeper` run on the shared runtime. Each agent is a Strands-based Python process with a baked-in system prompt, shared toolset (38 tools per agent, plus the GitHub MCP tools), and model configuration (personas run on Claude Fable 5.1; `claude_code` delegations pick opus/sonnet/haiku per call — see Plan-first delegation below).

The pipeline flows Requirements → 8 parallel Design → 3 Dev → Review (code review + CI) → Verification (QA) → Ship (release manager). `bug_fixer`, `operator`, and `code_sweeper` are development-phase personas used by the bug-fix / operator / sweep flows; `fleet_improver` closes the self-improvement loop by turning low eval scores into PRDs that re-enter the same pipeline.

| Agent | Role | Phase | Skills Loaded |
|-------|------|-------|---------------|
| `agentcore_hub_requirements_analyst` | Analyzes inputs, creates tickets for relevant agents | Requirements | requirements-analysis |
| `agentcore_hub_frontend_designer` | Designs UI/UX for web features | Design | frontend-design |
| `agentcore_hub_backend_designer` | Designs backend systems & APIs | Design | backend-systems |
| `agentcore_hub_ios_designer` | Designs native iOS features | Design | ios-architecture |
| `agentcore_hub_android_designer` | Designs Android features | Design | general-design |
| `agentcore_hub_analytics_designer` | Designs analytics/tracking | Design | general-design |
| `agentcore_hub_security_reviewer` | Threat modeling, auth flows, OWASP, security architecture review | Design | security-review |
| `agentcore_hub_legal_compliance` | Privacy/compliance review (GDPR/CCPA, data handling) | Design | privacy-compliance |
| `agentcore_hub_localization` | i18n strategy, string extraction, RTL, locale handling | Design | localization, i18n-tooling |
| `agentcore_hub_frontend_dev` | Implements web UI features | Development | full-stack, code-simplifier, feature-dev |
| `agentcore_hub_backend_dev` | Implements backend services | Development | node-typescript, feature-dev |
| `agentcore_hub_api_dev` | Implements API endpoints | Development | node-typescript, feature-dev |
| `agentcore_hub_bug_fixer` | Locates the root cause and fixes a bug in one flow (plan-first) | Development | feature-dev |
| `agentcore_hub_operator` | Owns an operator-workflow run end to end; plan-first Claude Code driver | Development | full-stack |
| `agentcore_hub_code_sweeper` | Detects and surgically removes unused/dead code (language-aware) | Development | code-simplifier |
| `agentcore_hub_code_reviewer` | Adversarial diff review of a dev branch, runs BEFORE QA (on `codex`) | Review | code-review |
| `agentcore_hub_ci_agent` | CI pipeline validation / build-failure triage; certifies the head | Review | ci-verification |
| `agentcore_hub_qa_verifier` | Visual/E2E verification, design-to-implementation checks | Verification | qa-verification |
| `agentcore_hub_release_manager` | Owns the last mile: unified PR, final review, merge, deploy | Ship | — (blueprint-driven) |
| `agentcore_hub_fleet_improver` | Turns low eval scores into PRDs for the delivery pipeline | Self-improvement | — (blueprint-driven) |

---

## Deployment Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  AgentCore Runtime (us-east-1)                              │
│                                                             │
│  ┌─────────────────┐  ┌─────────────────┐                  │
│  │ agentcore_hub_frontend │  │ agentcore_hub_backend │                   │
│  │     _dev         │  │     _dev        │  …×15 runtimes    │
│  │                  │  │                 │                  │
│  │ main.py (shared) │  │ main.py (shared)│                  │
│  │ SYSTEM_PROMPT=.. │  │ SYSTEM_PROMPT=..│                  │
│  └────────┬─────────┘  └────────┬────────┘                  │
│           │                      │                          │
│  ┌────────┴──────────────────────┴────────┐                 │
│  │  Shared Tools (loaded at invocation)    │                 │
│  │                                         │                 │
│  │  Built-in:  shell, editor, file_read,   │                 │
│  │    file_write, python_repl, calculator, │                 │
│  │    http_request, image_reader,          │                 │
│  │    current_time, environment, retrieve  │                 │
│  │                                         │                 │
│  │  AgentCore: Code Interpreter, Browser   │                 │
│  │                                         │                 │
│  │  Claude Code: claude_code tool (SDK)    │                 │
│  │                                         │                 │
│  │  Lambda-backed: S3, Jira, Workflow,     │                 │
│  │    SkillLoader                          │                 │
│  │                                         │                 │
│  │  MCP: GitHub (push, PR, file ops)       │                 │
│  └─────────────────────────────────────────┘                 │
└─────────────────────────────────────────────────────────────┘
```

---

## Tool Inventory (per agent)

### Built-in Strands Tools (13)
| Tool | Purpose |
|------|---------|
| `shell` | Run shell commands (git, npm, etc.) |
| `file_read` | Read files from disk |
| `file_write` | Write files to disk |
| `editor` | Edit files with find/replace |
| `python_repl` | Execute Python code |
| `calculator` | Math operations |
| `http_request` | HTTP GET/POST/etc. |
| `image_reader` | Analyze images (multimodal) |
| `current_time` | Get current time |
| `environment` | Read/set env vars |
| `retrieve` | RAG retrieval |
| `code_interpreter` | AgentCore sandboxed code execution |
| `browser` | AgentCore managed Playwright browser |

### Coding CLI Tools (3)
| Tool | Purpose |
|------|---------|
| `claude_code` | Delegate a coding task to the Claude Code CLI (plan-first — see below) |
| `codex` | Delegate to the Codex CLI on Bedrock Mantle (independent engine, used for adversarial review) |
| `kiro` | Delegate to the Kiro CLI |

### Lambda-Backed Tools (22)
| Tool | Lambda | Purpose |
|------|--------|---------|
| `download_s3_file` | direct boto3 | Download an S3 object to /tmp (feeds `image_reader`) |
| `upload_file_to_s3` | direct boto3 | Upload any-media-type local file to S3 |
| `load_blueprint` | direct boto3 (S3) | Fetch the agent's role blueprint from the artifact bucket |
| `S3Storage___read_object` | agentcore-hub-workflow-output | Read text from S3 |
| `S3Storage___write_object` | agentcore-hub-workflow-output | Write text to S3 |
| `S3Storage___list_objects` | agentcore-hub-workflow-output | List S3 objects |
| `Tickets___create_ticket` | agentcore-hub-tickets / -jira | Create a ticket |
| `Tickets___transition_ticket` | agentcore-hub-tickets / -jira | Change ticket status (with `blocked_by`) |
| `Tickets___update_ticket` | agentcore-hub-tickets / -jira | Update ticket fields |
| `Tickets___list_tickets` | agentcore-hub-tickets / -jira | List child tickets |
| `Tickets___add_comment` | agentcore-hub-tickets / -jira | Comment on a ticket |
| `Tickets___get_issue` | agentcore-hub-tickets / -jira | Read one ticket |
| `Tickets___search_issues` | agentcore-hub-tickets / -jira | Search tickets |
| `Pipeline___get_state` | agentcore-hub-pipeline-tools | Read pipeline/deploy state |
| `Pipeline___start_deploy` | agentcore-hub-pipeline-tools | Trigger the deploy pipeline |
| `Pipeline___get_build_status` | agentcore-hub-pipeline-tools | Poll a build's status |
| `Pipeline___get_build_log` | agentcore-hub-pipeline-tools | Fetch a build log |
| `Pipeline___start_ci_build` | agentcore-hub-pipeline-tools | Trigger a CI build |
| `Pipeline___capabilities` | agentcore-hub-pipeline-tools | Report which pipeline actions are available |
| `WorkflowOutput___report_completion` | agentcore-hub-workflow-output | Mark the agent's work done |
| `WorkflowOutput___save_design_doc` | agentcore-hub-workflow-output | Save a design artifact |
| `WorkflowOutput___submit_ticket_plan` | agentcore-hub-workflow-output | Batch-create the ticket plan |

### MCP Tools (GitHub)
Connected via `GITHUB_PAT` env var to `https://api.githubcopilot.com/mcp/` (9 tools verified):
- `get_me` — Get authenticated user info
- `get_file_contents` — Read files from repos
- `search_code` — Search code across repos
- `list_branches` — List repo branches
- `create_branch` — Create branches
- `create_or_update_file` — Commit file changes
- `push_files` — Push commits to GitHub
- `create_pull_request` — Create PRs
- `search_repositories` — Search repos

---

## Claude Code Integration

### How It Works

The `claude_code` tool runs `claude --print` as a subprocess. When Claude Code operates in a cloned repo, it automatically:
1. Reads `CLAUDE.md` for project conventions
2. Loads plugins from `.claude/plugins/`
3. Has access to its own tools (Read, Write, Edit, Bash, Grep, Glob)
4. Can run slash commands like `/feature-dev`, `/code-review`

### Installed Plugins (in repo `.claude/plugins/`)

| Plugin | Type | What It Does |
|--------|------|-------------|
| `feature-dev` | Command + Agents | 7-phase structured feature development |
| `code-review` | Command | Multi-agent PR review with confidence scoring |
| `pr-review-toolkit` | Agents | 6 specialized review agents |
| `security-guidance` | Hook | Pre-tool-use security pattern detection |

### How Agents Should Use Claude Code

**Dev agents** (frontend, backend, API, bug_fixer) — **plan-first** (the
standard for every coding persona; always on, no flag). The persona splits the
delegation into two turns on one shared `claude_code` conversation (only the
session id is shared, so the model split is free):

1. **Plan turn** — `plan_only=True` runs the CLI in `--permission-mode plan`: it
   reads the repo and returns an implementation plan, writing nothing.
2. **Review** — the persona checks the plan against the design + acceptance
   criteria; a deficient plan goes back for revision (same conversation), capped
   at two rounds.
3. **Execute turn** — `--resume`s the plan turn with full autonomy.

Model split (pinned per blueprint): plan on `opus` (`fable` for ambiguous or
architecture-heavy work), execute on `sonnet` (`opus` when the plan flags high
complexity); never plan on `haiku`. `codex` has no plan mode — codex-default
personas (code-sweeper, code-reviewer) get the plan as text and approve it
before the write turn.
```
# 1. Plan turn — reads the repo, returns a plan, writes nothing:
claude_code(task="Clone https://github.com/org/repo, checkout -b feature/TEAM-123-sidebar.
Plan the collapsible sidebar per the design doc at workflows/wf_xxx/shared/design.md in S3.",
            plan_only=True, model="opus")
# 2. Persona reviews the plan against the design + acceptance criteria (revise if deficient).
# 3. Execute turn — same conversation (--resume), full autonomy:
claude_code(task="Plan approved. Implement it exactly as planned. Commit and push when done.",
            model="sonnet")
```

**QA agent** — QA does the judgment work the mechanical build does NOT: visual,
live-integration, perf, and acceptance verification. In **pipeline mode** the CI
agent has already certified the integration-branch head (QA's ticket is
`blocked_by` the CI ticket), so QA reads the newest CI completion record and does
**not** re-run `npm run build`. QA never runs `npm install` / `npm ci`
(`node_modules` is a provisioned symlink to a per-lockfile cache) and never runs
`playwright install` (Chromium is baked into the image).
```
claude_code(task="Clone https://github.com/org/repo, checkout branch feature/TEAM-123-sidebar.
Start the dev server and screenshot the changed view with Playwright (viewport 1440x900),
save to .cloud-code/artifacts/qa-verification-screenshot.png. Describe what it shows vs the design.")
```

**Code reviewer** (separate `code_reviewer` agent, runs AFTER dev and BEFORE QA)
— an adversarial diff review on `codex` (an independent engine from the
`claude_code` the dev used), falling back to `claude_code` only if codex is
unavailable.
```
codex(task="Clone https://github.com/org/repo, checkout branch feature/TEAM-123-sidebar.
Diff it against origin/main and reason about how the change fails — the failure
modes the author's own tests never exercise. Report findings with file:line references.")
```

### Plugin Loading — No Redeploy Needed

Plugins live in the **repo**, not the agent. When you add/update plugins in `.claude/plugins/`:
- Next time any agent calls `claude_code` and clones the repo, it gets the updated plugins
- No agent redeploy required
- All agents benefit immediately

---

## Agent Roster (Config-Driven)

The agent roster is defined in a single source of truth: `src/config/agents.json`. This file controls:
- Which agents exist (IDs, names, phases, harness names)
- Which agents are valid assignees for tickets
- The orchestrator's agent-to-runtime mapping

### How It Works

```
src/config/agents.json (repo)
    ↓ synced by deploy-all.sh
s3://{ARTIFACT_BUCKET}/config/agents.json
    ↓ loaded on Lambda cold start
orchestrator / agentcore-hub-tickets / agentcore-hub-jira
```

All 3 Lambdas load the roster from S3 at cold start and cache it in memory. If S3 is unreachable, they fall back to a hardcoded copy (last known good).

### Adding/Removing Agents

1. Edit `src/config/agents.json` — add or remove the agent entry
2. Sync to S3:
   ```bash
   aws s3 cp src/config/agents.json s3://agentcore-artifacts-<ACCOUNT_ID>-us-east-1/config/agents.json
   ```
3. Lambdas pick up changes on next cold start (no code redeployment needed)
4. To force immediate pickup, touch any env var on the Lambda to trigger a new execution environment

### Config Schema

```json
{
  "agents": [
    {
      "agentId": "agentcore_hub_frontend_dev",  // Canonical ID + AgentCore Runtime resource name
      "displayName": "Frontend Developer",       // Display name in UI
      "description": "Implement UI from...",     // Role description
      "phase": "development",                    // Pipeline phase
      "type": "developer",                       // Agent type
      "model": "Claude Fable 5.1",               // Persona model (Fable 5.1 fleet-wide)
      "evaluationsEnabled": true,                // Online evals on/off
      "tools": [...],                            // Tool list (synced from main.py)
      "skills": [...],                           // Claude Code skills loaded from S3
      "blueprints": [...],                       // Process instruction names loaded via load_blueprint
      "evalConfigName": "eval_frontend_dev",     // CW Logs eval config (refresh-agents-json.sh writes this)
      "runtimeArn": "arn:aws:..."                // Runtime ARN (refresh-agents-json.sh writes this)
    }
  ],
  "defaults": {
    "intakeAgentId": "agentcore_hub_requirements_analyst",
    "defaultAssigneeId": "agentcore_hub_backend_designer"
  }
}
```

### Consumers

| Consumer | How it reads | What it uses |
|----------|-------------|-------------|
| Frontend (`pipeline-config.ts`) | Direct import at build time | All fields (renders UI) |
| Orchestrator Lambda | S3 read at cold start | `agentId`, `phase`, `runtimeArn` |
| agentcore-hub-tickets Lambda | S3 read at cold start | `id` only (validation Set) |
| agentcore-hub-jira Lambda | S3 read at cold start | `id` only (validation Set) |
| `deploy/runtime-agent/deploy-fleet.sh` | Reads agent list to deploy each runtime | All fields (deploys agents) |

---

## Configuration

### Environment Variables (baked at deploy time)

| Variable | Value | Purpose |
|----------|-------|---------|
| `MODEL_ID` | `us.anthropic.claude-fable-5-1` | Persona LLM model (Fable 5.1 fleet-wide) |
| `AWS_REGION` | `us-east-1` | AWS region |
| `READ_TIMEOUT` | `600` | Boto3 read timeout (10 min) |
| `GATEWAY_ARN` | `arn:aws:bedrock-agentcore:...` | AgentCore gateway |
| `EVENTS_TABLE` | `agentcore-hub-events` | DynamoDB events table |
| `TICKET_TOOLS_LAMBDA` | `agentcore-hub-tickets` or `agentcore-hub-jira` | Ticket operations Lambda (matches TICKET_PROVIDER) |
| `ARTIFACT_BUCKET` | `agentcore-artifacts-...` | S3 artifact bucket |
| `SYSTEM_PROMPT` | (agent-specific) | Baked system prompt |
| `BYPASS_TOOL_CONSENT` | `true` | Non-interactive tools |
| `GITHUB_PAT` | (from .env.local) | GitHub MCP access |

### Deploy Process

```bash
cd deploy/runtime-agent
./deploy-one.sh <agent_name>    # Deploy single agent
# or deploy all:
for agent in $(ls prompts/ | sed 's/.txt$//'); do ./deploy-one.sh "$agent"; done
```

### Fleet Registry

`deploy/runtime-agent/fleet-runtime-ids.json` — Maps agent names to ARNs.

---

## Skills System

Skills are loaded at invocation time via `SkillLoader___load_skill(skill_name="...")`. They return markdown instructions that guide agent behavior for specific tasks.

### Available Skills

| Skill | Used By | Purpose |
|-------|---------|---------|
| `ios-architecture` | iOS designer | Native iOS architecture design |
| `backend-systems` | Backend designer | Backend/API systems design |
| `privacy-compliance` | Legal compliance | GDPR/CCPA compliance design |
| `localization` | Localization agent | i18n design patterns |
| `frontend-design` | Frontend designer | Bold, distinctive UI design |
| `general-design` | Any designer | Generic software design |
| `requirements-analysis` | Requirements analyst | Ticket creation methodology |
| `qa-verification` | QA verifier | Build/test/verify process |
| `ci-verification` | CI agent | CI pipeline process |
| `swift-development` | iOS dev | Swift/SwiftUI implementation |
| `node-typescript` | Backend/API dev | Node.js/TS implementation |
| `full-stack` | Frontend dev | Full-stack development |
| `data-services` | Backend dev | Data processing services |
| `i18n-tooling` | Localization | i18n tooling implementation |
| `code-architect` | Dev agents | Architecture blueprints |
| `type-design` | Dev agents | Type system analysis |
| `code-review` | Security reviewer | Code review methodology |
| `silent-failure-hunter` | QA/Security | Error handling audit |
| `code-simplifier` | Dev agents | Code simplification |
| `test-coverage` | QA/CI | Test coverage analysis |
| `feature-dev` | Dev agents | 7-phase feature development |

---

## Workflow Execution

### Ticket-Driven Pipeline

```
User Input → Requirements Agent → Creates Tickets → DynamoDB Stream
                                                         │
    ┌────────────────────────────────────────────────────┘
    │
    ▼ (for each ticket with status="ready")
Orchestrator Lambda → Invokes Agent via Runtime ARN
    │
    ▼
Agent executes → Uses tools → Writes artifacts → ships, then reports completion
    │
    ▼ (DynamoDB Stream fires on status change)
Orchestrator checks → Unblocks downstream tickets → Invokes next agents
    │
    ▼ (all tickets done)
Workflow Complete
```

**Completion contract (ship-then-report).** The moment the deliverable exists
(commit pushed / PR opened, merged where the step requires it), the agent
persists its evidence to `workflows/{workflowId}/shared/…-evidence/` in S3 and
then calls `WorkflowOutput___report_completion` **immediately** — same turn,
before any summary or reflective text (#457). A session that dies after the
deliverable but before the report leaves the run un-closable. Agents do **not**
loop in place waiting on other work: an agent that needs a fix (QA/CI/reviewer
filing a fix ticket) self-parks by setting `blocked_by` on
`Tickets___transition_ticket`, releasing its invocation claim, and is
re-invoked when the blocker closes (#452/#455, DL-024). The orchestrator only
dispatches and cascades tickets; every "what happens next" decision lives in the
blueprint.

### Dependency Chain

```
Design agents (no blockers) → Dev agents (blocked by design)
    → Code review (Tier 4: code_reviewer, blocked_by all dev tickets)
    → CI (Tier 5: ci_agent, blocked_by the code-review ticket; certifies the integration-branch head)
    → QA (Tier 6: qa_verifier, blocked_by the CI ticket; reads the CI completion record, does not re-run the build)
    → Ship (release_manager: unified PR + final review + human merge gate)
```

The chain is strictly sequential: code review (Tier 4) runs first on the dev
branch, then CI (Tier 5) syncs and certifies the head SHA, then QA (Tier 6) is
`blocked_by` the CI ticket and reads the newest CI completion record rather than
re-compiling. Ship review is **one round** — round 1 raises
every in-diff finding, and mergeability (`gh pr view --json mergeable`) is
checked before the change reaches the human merge gate (#537).

---

## Starting Test Workflows

Use `scripts/start-test-workflow.sh` to start workflows for testing. This is the **only** correct way to create workflows outside the UI — it calls `/api/workflow/start` which initializes all required fields and creates ticket skeletons.

```bash
./scripts/start-test-workflow.sh --scope minimal     # Quick smoke test
./scripts/start-test-workflow.sh --scope full         # Full pipeline exercise
```

See `docs/architecture.md` § "Starting Test Workflows" for full usage.

---

## Monitoring & Debugging

### Real-Time Events
All agent activity writes to `agentcore-hub-events` DynamoDB table:
- `agent.started` — Agent invoked
- `agent.streaming` (type=trace) — Tool use events
- `agent.complete` — Agent finished
- `workflow.nudge` — Stuck tickets auto-fixed

### S3 Artifacts
All agents write output artifacts to S3 under `workflows/{workflowId}/agents/{agentId}/`. These are browsable directly from the pipeline UI:
- Click any S3 output pill in any phase → opens S3 Artifacts Modal
- Modal shows all files grouped by agent, with size, timestamp, and download
- "Download All as ZIP" button for bulk export
- API: `GET /api/workflow/artifacts?workflowId=...&agentId=...`

### Nudge System
`POST /api/workflow/[id]/nudge` — Fixes stuck tickets:
- `todo` with no blockers → `ready` (missed stream event)
- `blocked` with all blockers done → `ready` (missed unblock cascade)

Note: `in_progress` tickets are never reset by nudge — an agent session is actively running. See DL-021 for why this was removed (caused duplicate agent sessions).

### UI Replay
`GET /api/workflow/[id]/events` — Returns all events for timeline replay with scrubber.

---
