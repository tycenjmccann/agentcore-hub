# Decision Log

Architectural decisions and their rationale. Newest first.

---

## DL-011: Port / pull — move a live coding session laptop↔cloud

**Date:** 2026-06-19
**Status:** IMPLEMENTED
**Context:** Cloud Code (DL-010) lets a session run server-side, but starting one
meant a cold cloud session. Wanted to hand off an *in-flight local* Claude Code
session to the cloud (close the laptop mid-task, resume on the train) and bring
it back later — losslessly.

**Decisions:**
- **Native `claude --resume`, not a text summary.** Ship the *raw* transcript
  (`~/.claude/projects/<slug>/<id>.jsonl`) to S3; the runtime drops it at the
  workspace's project slug and runs `claude --resume <id>`. Same session id, full
  history, no size cap. (A first cut shipped an extracted text seed — replaced;
  the user correctly pushed for native resume.)
- **Slug rule, verified empirically:** `re.sub(r'[^a-zA-Z0-9]','-', realpath(cwd))`
  — Claude slugifies the *real* path, every non-alphanumeric → `-`. `--resume`
  404s if it doesn't match exactly (early bug: only `/`→`-`, broke on spaces/dots).
- **Local stdio MCP** (`mcp/port-session/`), not a remote one — it needs laptop
  git + filesystem access. Separate package, excluded from the app tsconfig.
- **Transport:** presigned S3 PUT (port) / GET (pull) so the 16–20 MB transcript
  never goes through the app or hits the DynamoDB item-size cap.
- **Pre-warm at port:** a `warm` invoke (clone + checkout + install, no CLI run)
  fires right after upload, so opening the link is instant.
- **Round trip (pull):** a `checkpoint` invoke uploads the *grown* transcript
  back; the laptop overwrites its stale copy (cloud is canonical) — backing up a
  differing prior copy to `.bak-<stamp>`. Skips a dirty local tree.
- **View persists:** `defaultView` (chat|terminal) on the session row so a sidebar
  tap reopens the right surface; terminal auto-runs `claude --resume` in the PTY.
- **Account guard:** `EXPECTED_ACCOUNT_ID` (in gitignored `.env.local`, sourced by
  config.sh + deploy.py) refuses wrong-account deploys, after a duplicate stack
  got created in the wrong AWS account.

**Open follow-ups:** Claude-only (Codex `thread_id` resume not wired); no auth on
port/checkpoint endpoints + presigned URLs yet (tighten before public/multi-user).

See `mcp/port-session/README.md`, `deploy/coding-agent-runtime/{README,DECISIONS}.md`.

---

## DL-010: Cloud Code — cloud-hosted coding agent (separate from the fleet)

**Date:** 2026-06-18
**Status:** IMPLEMENTED
**Context:** Wanted Claude Code / Codex to run server-side ("safe to close your
laptop") so a coding session survives the device, per the AWS blog +
`awslabs/agentcore-samples`. An earlier attempt forced the coding CLI through
the 14-agent workflow pipeline and failed — the pipeline assumes local files;
coding is Git-native and conversational.

**Decisions:**
- **Standalone runtime, not the fleet.** Built on the official `/invocations` +
  `claude --resume` model (sample-01), not the commands-API model.
- **EFS workspace, not sessionStorage.** The default ~1 GB session storage
  overflowed on a real repo (git + node_modules → ENOSPC); moved to EFS
  (`02-claude-code-with-efs` pattern) — elastic, POSIX, survives cold microVMs.
- **Per-session isolated checkouts** under `/mnt/efs/sessions/<id>` so concurrent
  sessions on the same repo don't collide. CLI config (CLAUDE_CONFIG_DIR/
  CODEX_HOME) stays shared per user.
- **No-login terminal:** the PTY pre-loads Bedrock auth (env file written by the
  server to the EFS mount; sourced via /etc/bash.bashrc).
- **Per-user config bundles** (MCP/skills/agents) materialized on turn start;
  Codex config.toml merged so our Bedrock-Mantle provider always wins.
- **MCP via the existing `agentis-gateway`**, wired into both CLIs by default.
- **Streaming:** Claude over SSE (`stream-json --include-partial-messages`);
  Codex buffered. Shared SSE reader (`src/lib/sse.ts`) across all stream surfaces.
- **Single-user now** (`userId:"default"`), ready for the Cognito-sub swap.

**Open follow-ups:** gateway auth NONE→IAM; GitHub App + Gateway to replace the
shared PAT; app-wide SSO; Codex resume + streaming.

See `deploy/coding-agent-runtime/{README,DECISIONS}.md`, `docs/MODULES.md`
(Module: Cloud Code), `docs/streaming-sse.md`.

---

## DL-009: Consolidate Ticket Lambdas into Single Router

**Date:** 2026-05-26
**Status:** PROPOSED
**Context:** We currently have two separate Lambdas implementing the same tool interface (`Tickets___create_ticket`, `Tickets___transition_ticket`, etc.):
- `agentcore-hub-jira` — routes to Jira Cloud API
- `agentcore-hub-tickets` — routes to DynamoDB

Every upstream service (runtime agents, workflow-output Lambda, orchestrator) must be configured with `TICKET_TOOLS_LAMBDA` env var pointing to the correct one. Missing this config on even one service causes silent failures (e.g., workflow-output Lambda was missing it, causing `report_completion` to fail to transition tickets).

**Decision:** Consolidate into a single Lambda (`agentcore-hub-tickets`) that reads `TICKET_PROVIDER` env var and routes internally to the correct adapter. Callers never need to know which provider is in use.

**Architecture:**
```
agentcore-hub-tickets (single entry point)
  ├── TICKET_PROVIDER=jira     → jira-adapter.mjs (Jira Cloud API)
  ├── TICKET_PROVIDER=dynamodb → ddb-adapter.mjs (DynamoDB)
  ├── TICKET_PROVIDER=asana    → asana-adapter.mjs (future)
  └── TICKET_PROVIDER=linear   → linear-adapter.mjs (future)
```

**Benefits:**
- Eliminates per-service `TICKET_TOOLS_LAMBDA` config (one fewer env var to miss)
- Adding new providers = adding an adapter file, not a new Lambda + reconfiguring all upstreams
- Agents don't change at all — same tool interface regardless of provider

**Risks:**
- Migration: need to update all deployed services to point to the consolidated Lambda
- Single point of failure (mitigated: Lambda is stateless, auto-scales)

---

## DL-008: Catch-Up Replay (Live)

**Date:** 2026-05-19
**Status:** IMPLEMENTED
**Context:** Users joining mid-workflow need to see what happened before they opened the page.
**Decision:** Implemented live catch-up replay via events table polling.

---

## DL-007: Timeline Replay (Completed Workflows)

**Date:** 2026-05-19
**Status:** IMPLEMENTED
**Context:** Need to review completed workflows step-by-step.
**Decision:** Timeline replay reads from events table with playback controls.

---
