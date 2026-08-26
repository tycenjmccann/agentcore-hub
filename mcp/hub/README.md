# @agentcore-hub/hub-mcp

**ONE local stdio MCP server for all of AgentCore Hub.** Any MCP-compatible
client (Claude Code, Claude Desktop, Cursor) gets the full hub surface from a
single registration:

| Domain | Tools | Talks to |
|--------|-------|----------|
| **Workflows** | `submit_workflow`, `list_workflows`, `list_workflow_definitions`, `get_workflow_status`, `get_workflow_artifacts`, `cancel_workflow`, `nudge_workflow` | `/api/workflow/*` |
| **Routines** | `create_routine`, `list_routines`, `get_routine`, `update_routine`, `delete_routine`, `run_routine` | `/api/routines/*` |
| **Cloud Code** | `port_session_to_cloud`, `pull_session_from_cloud`, `sync_cli_config` (+ `/port`, `/pull`, `/sync-config` prompts) | `/api/cloud-code/*` |

This server **supersedes** the former standalone `mcp/workflow` (workflow-mcp)
and `mcp/port-session` (port-session-mcp) servers. Tool names are unchanged, so
existing automations keep working — just re-point the registration.

## Build

```bash
cd mcp/hub
npm install
npm run build
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HUB_URL` | **Yes** | Base URL of the deployed hub (e.g. `https://hub.example.com`). Trailing slash stripped. Legacy names `DEPLOYMENT_URL` and `CLOUD_CODE_URL` are accepted as fallbacks. |
| `PROJECT_CWD` | No | Project directory for Cloud Code porting. Defaults to the server's cwd. |
| `AUTH_TOKEN` | No | Legacy bearer token, sent as `Authorization: Bearer <token>`. |
| `CF_ACCESS_CLIENT_ID` | No | Cloudflare Access service-token client ID. **Required once the hub runs with `AUTH_MODE=cloudflare-access`** — the middleware only accepts a verified `Cf-Access-Jwt-Assertion`, not `Authorization`. |
| `CF_ACCESS_CLIENT_SECRET` | No | Pairs with `CF_ACCESS_CLIENT_ID`. Also readable from `~/.cloud-code/service-token.json` (`{"clientId","clientSecret"}`). |

Service-token credentials are sent **only** to `HUB_URL` — never to the
presigned S3 URLs the port/pull flows use (those carry their own SigV4 query
auth).

## MCP Client Configuration

```json
{
  "mcpServers": {
    "agentcore-hub": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/hub/dist/index.js"],
      "env": {
        "HUB_URL": "https://hub.example.com"
      }
    }
  }
}
```

Or with Claude Code:

```bash
claude mcp add agentcore-hub -e HUB_URL=https://hub.example.com \
  -- node /absolute/path/to/mcp/hub/dist/index.js
```

## Cloud Code porting — the round trip

```
        ── port (laptop → cloud) ──▶
you (local Claude Code)                         Cloud Code (cloud microVM)
        ◀── pull (cloud → laptop) ──
```

```
PORT  "port this to the cloud, I'm catching the train"   → /mcp__agentcore-hub__port
  1. commit + push in-flight work to a branch (or ship a git bundle — see below)
  2. POST /api/cloud-code/sessions/port → create session + presigned S3 PUTs
  3. upload this session's raw transcript (.jsonl) to S3
  4. pre-warm the microVM (clone + checkout + install transcript)
  5. return a deep link — open on any device, claude --resume continues

PULL  "I'm back at my desk"   → /mcp__agentcore-hub__pull cc-...
  1. POST /sessions/[id]/checkpoint → cloud uploads the GROWN transcript
  2. download it → install where `claude --resume <id>` finds it
     (prior local copy backed up to .bak-<stamp>)
  3. pull the cloud's code home — branch fast-forward, or a return git bundle
     for read-only / no-remote repos
  4. /exit  then  claude --resume <id>  → continue locally
```

Porting is lossless: the **raw transcript** ships (not a summary), the cloud
installs it under the workspace's project slug, and `claude --resume <id>`
continues the exact session. Codex sessions ship the sanitized rollout the same
way.

Git handoff adapts to the repo (`gitMode`): `pushed` (writable origin),
`bundle` (read-only origin — laptop commits ride a git bundle), `selfContained`
(no usable remote — whole-repo `bundle --all`), `none` (bare workspace).
Session-touched untracked files (images/exports/data) auto-ship as artifacts
both directions.

`sync_cli_config` is one-time setup, not part of porting: it mirrors your local
CLI config (CLAUDE.md / AGENTS.md, skills, agents, MCP servers) into the cloud
config bundle. Local-path MCP servers are dropped (they can't run in the
microVM) and secret-looking env values are redacted before upload.

## Architecture

```
src/
  index.ts            server: tool/prompt registry + dispatch
  config.ts           HUB_URL resolution (legacy env fallbacks)
  auth.ts             hubFetch (CF Access service token) + JSON request wrapper
  workflow/
    tools.ts          workflow + routine tool defs & handlers
    schemas.ts        zod input schemas
  cloud-code/
    tools.ts          port / pull / sync tool defs & handlers + prompts
    git.ts            git state, flexible handoff, pullBranch/pullFromBundle
    transcript.ts     transcript discovery + local install for --resume
    artifacts.ts      artifact detection, upload/download, containment guards
    cli-config.ts     local CLI config gathering + MCP server classification
```
