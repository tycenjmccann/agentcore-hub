# AgentCore Hub Setup Plugin

A Claude Code plugin that turns AgentCore Hub setup from "read a 900-line README and run six scripts in the right order" into a guided conversation.

## What it does

Run `/agentcore-hub:setup` from inside an `agentcore-hub` clone. The plugin:

1. Asks 4–6 questions to figure out which modules you want.
2. Detects your AWS account/region from existing credentials.
3. Generates a `.env.local` from your answers (existing files are backed up).
4. Runs only the deploy scripts the modules you picked actually need.
5. Verifies each phase before moving to the next, surfacing real errors instead of swallowing them.

## What it deploys

The plugin reasons about four modules (see `docs/MODULES.md` for the full breakdown):

- **Core** — always installed. Discovery, Agents browser, Invoke console.
- **Builder** — `/build` page + `builder-tools` Lambda.
- **Workflow** — multi-agent pipeline + Jira/DynamoDB ticket store + 14-agent runtime fleet.
- **Evaluations** — CloudWatch-driven eval packager + self-improvement loop.

## File layout

```
.claude-plugin/
└── plugin.json                # plugin manifest (must live here)

# The following live at the *plugin root*, not inside .claude-plugin/:
skills/
└── setup/
    └── SKILL.md               # the /agentcore-hub:setup conversation flow
agents/
└── deploy-runner.md           # subagent for long-running deploys (5–15 min)
.claude-plugin/bin/
├── apply-env.sh               # writes .env.local from a JSON answer blob
├── run-module.sh <module>     # the one place that knows script order per module
└── verify-module.sh <module>
```

`bin/run-module.sh` is the single source of truth for "to deploy module X, run scripts A, B, C." If a script is added or removed, this file is the only one to update.

## Validating and installing

```bash
# Validate the manifest (run from repo root)
claude plugin validate . --strict

# Load the plugin for one session — no install, no restart needed
claude --plugin-dir .
```

Once Claude Code starts, type `/agentcore-hub:setup` at the prompt. The skill at `skills/setup/SKILL.md` and the agent at `agents/deploy-runner.md` are auto-discovered from their default directories at the plugin root (Claude Code refuses to load components nested under `.claude-plugin/` itself) — `plugin.json` only carries metadata.

**Iterating on the plugin during development:** edits to `SKILL.md` take effect immediately in the running session. Edits to `agents/`, `bin/*.sh`, or `plugin.json` require `/reload-plugins` (or restarting `claude --plugin-dir .`).

## Hard rules the plugin follows

- Never adds new infra — only orchestrates scripts that already exist in the repo (`deploy/`, `scripts/`, or alongside Lambda source under `lambda/<name>/deploy.sh`).
- Never overwrites `.env.local` — backs up to `.env.local.bak` first.
- Always passes `AWS_PROFILE` + `AWS_REGION` through to every `aws` call. Never assumes `default`.
- Never logs secrets (Jira API token, GitHub PAT). They go straight from the prompt into `.env.local` mode 600.
- Never silences errors — verification failures show the real stderr and the script that produced it.

## Re-runs

`/agentcore-hub:setup` is safe to re-run. Underlying scripts are idempotent and the plugin checks for existing resources before creating new ones.

---

## Design lock — what's branded, what's reused, what's not (read before extending)

The user has signed off on the scope below. **Do not drift from it without updating this section first.** Future sessions extending the plugin should treat these as durable contracts.

### 1. Branding is display-only

`NEXT_PUBLIC_BRAND_NAME` controls the UI string in the header, sidebar, page titles, and pipeline visualization. Defaults to `AgentCore Hub`.

It does **not** rename:

- DynamoDB tables (`agentcore-hub-workflows`, `agentcore-hub-events`, `agentcore-hub-tickets`, `agentcore-hub-eval-config`)
- Lambda functions (`agentcore-hub-jira`, `agentcore-hub-tickets`, `orchestrator`, `workflow-output`, `eval-packager`, `builder-tools`, etc.)
- IAM roles (`agentcore-hub-harness-role`, `agentcore-hub-lambda-role`, runtime roles)
- S3 artifact bucket (`agentcore-hub-artifacts-<ACCOUNT>-<REGION>`)
- AgentCore runtime names (`agentcore_hub_builder`, the 14 fleet roles)

These names are part of the application contract — Lambda env vars, IAM trust policies, the `RUNTIME_ARN_<HARNESS>` lookup convention, deploy scripts, and the orchestrator all reference them by literal name. Renaming any of them would require a coordinated refactor across ~30 files plus an end-to-end test on a clean account. Out of scope for v1.

### 2. App infra is always created fresh — never bring-your-own

The plugin **never** offers to reuse existing copies of:

- App Lambdas
- DynamoDB tables / S3 buckets
- IAM roles + trust policies
- The 14 fleet runtimes
- The Builder runtime

Reason: these are tightly coupled to the codebase. Schema, permissions, env-var conventions, and Lambda code all need to match the version of the repo being installed. Letting users substitute their own would mean shipping every variation as supported, which is unwinnable for an OSS project. First-time installs work end-to-end *because* everything is fresh.

### 3. AgentCore *dependencies* — scan and offer to reuse (v2)

The plugin **may** scan the user's account for these and offer to reuse existing resources:

- AgentCore **Gateways** (especially MCP routing — they're expensive to wire up)
- **MCP servers** (already env-driven via `MCP_SERVERS`)
- **Memory stores**
- **Identity providers / token vaults** (if the user has corp OAuth wired up)

These are dependencies the runtimes consume by ARN, not resources the app modifies. Scanning is read-only (`list-*` APIs in the target region) and offers strong-match / weak-match / skip — never auto-substitutes silently.

**Status: not yet implemented.** Will live in `bin/scan-existing.mjs` + new `Q0` in `setup.md`.

### 4. Existing user agents — evaluate, report, then decide (v3)

If a user wants to plug their own existing agent into the workflow ("this is my bug-fix agent"), the plugin runs Claude as a compatibility evaluator:

- Read the agent's runtime config and prompt/code
- Compare against what the harness expects (ticket tools, OTEL streaming, blueprint tools)
- Report: works as-is / works partially / requires changes
- For "partial" or "requires changes," produce a concrete patch list ("add a stream emitter and these blueprint tools, then it'll get full UI fidelity")

This only applies to **agent runtimes**, not app infra. Streaming/OTEL fidelity gaps are surfaced honestly — the plugin tells the user what to expect rather than pretending everything works.

**Status: not yet implemented.** Lower priority than v2.

### 5. Sequencing summary

| Version | Scope | Status |
|---|---|---|
| v1 | Brand display var, modular Q&A, fresh install of all app infra | **This PR** |
| v2 | Scan-and-reuse for AgentCore Gateways, MCP servers, Memory stores | Next |
| v3 | Evaluate-existing-agents reporter (Claude reads agent config + reports compat) | Later |
| v4 | `RESOURCE_PREFIX` plumbing for truly rebrandable infra | Only if real demand emerges |
