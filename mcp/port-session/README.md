# port-session-mcp

Local **stdio MCP server** that moves a live coding session between your laptop
and **Cloud Code** — both directions. Close the laptop mid-task, resume the exact
session on your phone; pick it back up at your desk later. Same session id, full
history, no context lost.

```
        ── port (laptop → cloud) ──▶
you (local Claude Code)                         Cloud Code (cloud microVM)
        ◀── pull (cloud → laptop) ──
```

## The round trip

```
PORT  "port this to the cloud, I'm catching the train"
  1. commit + push in-flight work to a branch     (cloud only sees the remote)
  2. POST /sessions/port  → create session + presigned S3 PUT
  3. upload this session's raw transcript (.jsonl) to S3
  4. pre-warm the microVM (clone + checkout + install transcript) so open is instant
  5. return a deep link  (+ the /pull command for later)
        ▼  open on phone → claude --resume <id>, continue

PULL  "I'm back at my desk"  →  /mcp__port-session__pull cc-...
  1. POST /sessions/[id]/checkpoint → cloud uploads the GROWN transcript to S3
  2. download it → overwrite the local ~/.claude/projects/<slug>/<id>.jsonl
     (prior local copy backed up to .bak-<stamp>)
  3. git pull the cloud's branch (fast-forward; skipped if local tree is dirty)
  4. print:  /exit  then  claude --resume <id>   → continue locally
```

## Why it's lossless (native `--resume`)

- We ship the **raw transcript**, not a summary. Claude Code stores each session
  at `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`; the filename equals the
  `sessionId` inside, so the file *is* the resume handle.
- The cloud drops it under the workspace's project slug
  (`re.sub(r'[^a-zA-Z0-9]','-', realpath(cwd))` — the exact rule Claude uses) and
  runs `claude --resume <id>`. The conversation continues; it's the same session,
  grown — so pull just brings the bigger file home and overwrites the stale one.
- **Cloud is canonical on pull.** Overwrite is the point. A *differing* local copy
  is backed up to `<id>.jsonl.bak-<stamp>` first, so a divergent local branch is
  recoverable.

## Build

```bash
cd mcp/port-session
npm install
npm run build
```

## Register with your local Claude Code

Add to your global MCP config (`~/.claude.json` → `mcpServers`):

```json
{
  "mcpServers": {
    "port-session": {
      "command": "node",
      "args": ["/Users/tycenj/Desktop/agentcore-hub-fresh/mcp/port-session/dist/index.js"],
      "env": {
        "CLOUD_CODE_URL": "https://s4nmap2prm.us-east-1.awsapprunner.com"
      }
    }
  }
}
```

`CLOUD_CODE_URL` = the deployed app base URL. The tool reads git + the transcript
for whatever directory it's launched in (its `cwd`), so run Claude Code from
inside the repo you're porting. Reconnect (`/mcp`) after a rebuild to load changes.

## Tools

### `port_session_to_cloud`  (slash: `/mcp__port-session__port`)

| Arg | Default | Notes |
|---|---|---|
| `title` | `Ported: <repo>` | Session name shown in the sidebar. |
| `branch` | current branch | Branch to push the in-flight work to (and check out in the cloud). |
| `firstPrompt` | a default nudge | First instruction to the resumed agent. |
| `view` | `chat` | Surface the session opens in. `terminal` auto-runs `claude --resume` in a live PTY; persisted to the session so a sidebar tap reopens it the same way. |
| `cli` | `claude` | Cloud CLI to resume with (`claude` or `codex`). |
| `commitMessage` | auto | Message for the in-flight snapshot commit. |
| `cwd` | server cwd | Project dir (transcript + git are read here). |

Slash command's one comma arg: `view, title, first prompt, new branch` (all optional).
Returns a deep link `<CLOUD_CODE_URL>/cloud-code?session=<id>` + the `/pull` command for the return leg.

### `pull_session_from_cloud`  (slash: `/mcp__port-session__pull`)

| Arg | Default | Notes |
|---|---|---|
| `session` | — (required) | The `cc-...` id or the full Cloud Code session URL. |
| `cwd` | server cwd | Project dir to resume into (where the transcript + branch land). |

Brings the cloud's work home and prints `/exit` + `claude --resume <id>`.

### `sync_cli_config`  (slash: `/mcp__port-session__sync-config`)

**One-time setup** (re-run when your local config changes) — mirror this laptop's
coding-CLI configuration to Cloud Code so every future cloud session is a clone of
your local setup. **Not** part of porting; it writes the per-user config bundle the
runtime materializes on each turn (the same `/config` bundle you'd otherwise upload
by hand).

| Arg | Default | Notes |
|---|---|---|
| `cli` | — (required) | `claude` or `codex`. One at a time — run twice for both. |

What it ships per CLI:

| `cli` | Source → bundle | |
|---|---|---|
| `claude` | `~/.claude/CLAUDE.md`, `agents/`, `skills/`, `commands/`, `output-styles/` → `claude/…`; `~/.claude.json` `mcpServers` → `claude/.mcp.json` | |
| `codex` | `~/.codex/config.toml`, `AGENTS.md`, `prompts/` → `codex/…` | |

**Scoped merge** — syncing one CLI folds its subtree into the current bundle and
leaves the other CLI's files intact (the `/config` route merges by top-level dir).

**Portability contract (what runs in the cloud).** The cloud microVM is Linux
ARM64 with `node`/`npx`, `uv`/`uvx`, `pip`, and headless `chromium` baked in — it
carries the *launchers*, not anyone's specific servers, so each server self-installs
on first launch. Sync classifies every MCP server into three buckets and **only
ships the runnable ones**:

| Verdict | What it is | Shipped? |
|---|---|---|
| ✅ **works** | remote (`http`/`sse`) or registry-launched (`npx`/`uvx`/`pipx`) | yes — self-installs |
| 🔑 **needs-secret** | runnable, but an `env` value looks secret (token/key/…) | yes, value blanked — set the token in the cloud later (vault TBD) |
| 🚫 **unsupported** | local-path command, interpreter+local-script, bare binary not in the image, or platform-locked (e.g. `xcodebuild` → needs macOS) | **dropped** — the report tells you to reconfigure as `uvx <pkg>` / `npx <pkg>` |

The sync output prints all three buckets so you know exactly what will and won't
work, and how to fix the rest. `port-session` itself is always excluded. Secret env
is never uploaded (Codex `config.toml` ships verbatim — check it for inline secrets).

## Limits / future

- **Claude only.** `--resume` is a Claude Code mechanism. Codex resume uses a
  different `thread_id`, not wired through the transcript path yet.
- **Single-user.** Uses the app's `userId: "default"`. Multi-user waits on the
  app-wide SSO work; this server would then send an auth token.
- **No auth on the port/checkpoint endpoints / presigned URLs yet** — same posture
  as the rest of Cloud Code today. Tighten before exposing publicly.
- **Pull skips a dirty local tree** (won't clobber uncommitted work) — it fetches
  the branch and tells you to stash/checkout manually.
