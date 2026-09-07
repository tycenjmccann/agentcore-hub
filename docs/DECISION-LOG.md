# Decision Log

Architectural decisions and their rationale. Newest first.

---

## DL-014: Nothing-to-remove (TEAM-4247 D2) — the orchestrator ends a zero-yield sweep, not the model

**Date:** 2026-09-07
**Status:** IMPLEMENTED (shadow default)
**Context:** wf_…c2uqki swept 93 candidates, verified zero as dead, and had no way to say so. `blueprints/code-sweeper.md` Step 2.5 made termination the model's job — `Tickets___list_tickets(epic)` then hand-`skip` every downstream ticket "in REVERSE dependency order" — so one missed or mis-ordered ticket dispatches a reviewer/QA/CI/release-manager against a branch that does not exist and pages a human to approve a merge with no PR. There was also no terminal outcome for it (the run closed as a fake `complete` or hung), zero-cost no-op runs polluted every performance baseline, and nothing stopped a weekly re-sweep of a repo whose previous sweep PR was still open.
**Decision:** Make the yield a **number** and termination the orchestrator's. `report_completion` carries `verified_removable`/`candidates`; a strict integer `0` on a `dead-code-sweep` detection ticket closes the run as the new terminal outcome `nothing-to-remove` **before** `cascadeUnblock`, so there are zero successor dispatches and never a `workflow.complete`. `nothing-to-remove` is added to `NO_OP_OUTCOMES` and every terminal mirror but deliberately **not** to `SHIP_BLOCKED_OUTCOMES` — a no-op sweep is healthy, not blocked — and it is excluded from every baseline (cost-report, `buildFleetView`, the analysis toolkit) while staying visible and carded in the current window. A separate `SWEEP_CADENCE_GATE` skips a scheduled sweep of a repo swept < 14 days ago or with an open sweep PR, answering HTTP 200 with a tombstone rather than creating a run. All of it behind `off|shadow|enforce` flags defaulting to `shadow`, on the D1 ladder.
**Consequences:** Config and code ship separately, so the detection phase is stripped from the effective def until `SWEEP_DETECTION_PHASE=enforce` (otherwise a synced `workflows.json` would wedge every sweep on an unsatisfiable required phase); the deploy order is code → `workflows.json` → flag. A no-op card publishes no `workflow.performance` event, so run counts taken from that event under-count by design. The open-PR probe fails open, so an expired `GITHUB_PAT` degrades to cadence-only rather than stopping all sweeps.

---

## DL-013: Verdict gate (TEAM-4246 D1) — bind cascade/completion to gate verdicts, not ticket-done

**Date:** 2026-09-07
**Status:** IMPLEMENTED (shadow default)
**Context:** wf_1788731227559_dowtdh shipped over a reviewer CHANGES-NEEDED and a QA FAIL because the cascade advanced on ticket-done and completion never compared heads; the verdict existed only as prose.
**Decision:** Three independent `off|shadow|enforce` flags (`VERDICT_GATE`, `FIX_BEFORE_VERIFY`, `VERIFIED_HEAD_COMPLETION`) gate the cascade, fix-ticket creation, and completion on a structured `verdict`/`tested_head` now carried on `report_completion` and `agent.complete`, resolved by one zero-import ladder (`lambda/orchestrator/verdict-contract.mjs`).

---

## DL-012: Cloud CLI config that works in chat AND terminal, portable across engineers

**Date:** 2026-06-20
**Status:** IMPLEMENTED
**Context:** `sync_cli_config` (DL-011's MCP) uploads a per-user bundle (skills,
agents, `.mcp.json`) that the runtime materializes into the shared EFS config dir.
It worked in **chat** but a terminal-opened session showed empty `/skills` + `/mcp`.
And it must scale to ~hundreds of engineers, each with a different local setup, as a
one-time setup — without per-user images.

**Decisions:**
- **Root cause was the trigger, not config loading.** Interactive cloud `claude`
  *does* read `$CLAUDE_CONFIG_DIR/.mcp.json`. But materialization only ran inside
  `/invocations` (chat turns + `warm`); a terminal opens via `/shell` (presign-only)
  and `warm` didn't even pass `user_id`/`config_version`. Fix: a config-only
  **`prepare`** invoke (apply bundle + default MCP, no clone, no CLI) that `/shell`
  fires (bounded-await, marker-idempotent) before handing over the PTY URL; plus
  pass the config ids through `warm`.
- **One shared image carries launchers, not servers.** Added `uv`/`uvx` + headless
  `chromium` to the ARM64 image (pip already had Node/npx). Each engineer's declared
  servers self-install on first launch (`npx -y`, `uvx`). No per-user builds ever.
- **Portability contract — classify + report, ship only the runnable.** Sync sorts
  each MCP server into **works** (remote / npx / uvx / pipx), **needs-secret**
  (runnable but a secret env value — shipped blanked), or **unsupported** (local
  path, interpreter+local-script, bare binary not in the image, or platform-locked
  like `xcodebuild`→macOS). Unsupported servers are dropped (cloud never advertises a
  dead server) and the sync output tells the engineer to reconfigure as `uvx/npx`.
- **Secrets vault deferred.** Secret env is redacted at sync (never in S3); the
  servers that need a token stay inactive until a KMS-backed per-user vault lands.
- **Per-user config dirs deferred.** Safe today because `userId` is hardcoded
  `"default"` (one user). When SSO lands, config must move to per-user EFS subtrees
  (shared `.mcp.json` would otherwise collide / leak secrets across users).

**Open follow-ups:** per-user secrets vault; per-user config dirs at SSO; puppeteer
needs `--no-sandbox` in its server config to launch chromium in the microVM.

See `mcp/hub/README.md`, `deploy/coding-agent-runtime/README.md`.

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
- **Local stdio MCP** (`mcp/hub/` — the unified hub MCP), not a remote one — it needs laptop
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

See `mcp/hub/README.md`, `deploy/coding-agent-runtime/{README,DECISIONS}.md`.

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
