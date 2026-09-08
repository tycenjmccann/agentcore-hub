# Decision Log

Architectural decisions and their rationale. Newest first.

---

## DL-015: Validated ticket plans and a decision ledger (TEAM-4248 D3) — a fact the system knows must reach the agent that needs it

**Date:** 2026-09-08
**Status:** IMPLEMENTED (shadow defaults)
**Context:** Three defects, one failure class. (1) wf_…c2uqki created code sweeper `TEAM-4230` with `blockedBy=[]` and invoked it at 11:40:37.834Z — **92.3 s before** the requirements analyst `TEAM-4229` published `agent.complete` — a 3-of-3 pattern on that repo; nothing validated `ticket-plan.json` and nothing validated `create_ticket`, so an LLM's dependency slip was silently authoritative. (2) All four c2uqki downstream tickets named an invented branch `chore/dead-code-sweep-2026-09-07`; the sweeper actually used `feature/TEAM-4230-code-sweeper`, and the reviewer, QA and CI each spent a session discovering that and reconciling by hand. The orchestrator renders the canonical name — but only for development-phase personas, so the four personas that had to *find* the branch were never told it. (3) wf_…dowtdh's product owner resolved **six** numbered Concerns in one comment at Spec Approval `TEAM-4174` — including Concern 3, "5000 ms window; pause the countdown while Undo has focus or hover" — and restated that one in prose at Design Approval `TEAM-4176`; design recommended the opposite, plan `TEAM-4177` recorded "no focus-pause" with `## Deviations: None yet.`, and `TEAM-4178` (Plan Approval) approved that plan. The dossier's tickets carry **no `comments` array at all** — the human's words existed nowhere in the run's own record, and the decision resurfaced only as reviewer finding F1 P1 at the very end of the run — and F1 caught one of the six.
**Decision:** Turn each of the three into a fact in the pipeline. A zero-import `ticket-plan-validator.mjs` validates plans and tickets under `TICKET_PLAN_VALIDATOR` (unset → shadow, unrecognized → off): a non-advisory, non-fix ticket with an empty `blocked_by` while the requirements root is still open is a violation, and so is any branch token that is neither known nor `feature/<ticketId>-<persona-slug>`. The root is found **by role** (`agentcore_hub_requirements_analyst` / `phase: "requirements"`) or by an explicit `root_ticket_id`, never by position — a submitted plan does not contain its own root, so the first-unblocked heuristic would have exempted exactly the offender; no resolvable root **fails open**. The module ships as **four byte-identical copies** (orchestrator, `workflow-output`, and both `agentcore-hub-jira` and `agentcore-hub-tickets`, because the fleet deploys with `TICKET_TOOLS_LAMBDA=agentcore-hub-jira` and a tickets-only copy would be a production no-op), bound by a `cmp` block in `scripts/check-fix-kinds-parity.sh`. The branch fix is **context-only in every mode** — the only writer of a description flattens it into one ADF paragraph, so persisting a rewrite would destroy the structure of every ticket it touched to correct a branch name. Separately, `DECISION_LEDGER` (unset **and** unrecognized → shadow) makes each gate resolution a committed chain artifact: `extractGateDecisions` reads the comments already in scope at the approval hook, `appendDecisions` appends them idempotently **by id** to `.sdlc/<workflowId>/decisions.md` on the run's feature branch plus an S3 mirror, and design-phase personas and the Plan ticket receive a `## Gate Decisions (REQUIRED checklist)`. A decision is honoured when the artifact **cites its id** anywhere, or names the gate ticket on the **same line or table row** as the concern number — `Concern 3`, `#3`, or a leading `| 3 |` cell, the exact form the real post-fix dowtdh plan uses (`| 3 | … (PO, TEAM-4174 comment 2026-09-06 15:09.) | resolved |`). An exact token rule, never prose matching, because a citation rule is both predictable for the agent being judged and testable for us; and **line-scoped**, which is stricter than a document-wide check (a gate key in a header plus a `Concern 3` eighty lines away is not a citation) precisely so it can accept the table-row form without accepting coincidence. Flagging the real fixed artifact would reopen a good plan under `enforce` — the worst false positive available to this feature. `enforce` adds one behaviour: an artifact citing none of the open decisions means the gate is **withheld**, reworked through `handleReviewRejection`, and no human is paged. `shadow` deliberately **writes**: an empty ledger would leave the enforce flip with nothing to check — the same trap `gateRejectionAdmitted` calls out in code — so `off` is the only byte-identical mode.
**Consequences:** Four byte-identical copies is one more than any other module has; the parity `cmp` block and the zip manifests land in the same commit as the module, because a copy in a zip without a guard is the silent failure that script exists for. `TICKET_PLAN_VALIDATOR=enforce` can loop an analyst that cannot satisfy the validator — bounded by the shadow default, the fail-open root rule, and rejection messages that name the exact violation and both ticket ids. `DECISION_LEDGER=enforce` can cost a design round on a false positive, which is what shadow measures first. The withhold path leaves `gateStates` **untouched** on purpose: `markGateRejected`'s CAS pairs `rejected` with a `requested` row's `requestedAt`, so closing a cycle that was never opened would make the human's later genuine Request-changes classify as a duplicate and be dropped under `GATE_STATE_GUARD=enforce`; `decision.gate_withheld` carries the observability instead. `githubPutFile` needs `contents: write` on `GITHUB_PAT` — a read-only token degrades to the S3 mirror with a warning, so the ledger still exists, just not on the branch. `decisions.md` joins the chain with no `gate` and is required of nobody, so `enforceArtifactChain` can never block a ticket on a file only the orchestrator writes; as with DL-014 the deploy order is code → `workflows.json` → flags. And `submit_ticket_plan`'s `ticket_count` is fixed unconditionally, outside the flag: `main.py` passes `tickets` as a JSON **string**, so the reported count has always been the character count.

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
