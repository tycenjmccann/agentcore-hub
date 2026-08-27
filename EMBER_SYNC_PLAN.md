# Ember → Cloud Code Sync Plan (v2 — adversarially verified)

Fork history: Cloud Code tab cloned from Ember 2026-06-19; four features cherry-picked
2026-07-22. Ember has ~40 substantive commits since. Every claim below was verified by
an independent adversarial pass against both repos (2026-08-25); verdicts and the
corrections they forced are baked in.

Ember repo: `~/Desktop/Q Projects/ember`. Hub prod: profile
`tycenj-prod`, Colima image builds (see `coding-agent-runtime` memory).

---

## Verification outcomes (what changed from v1)

| v1 claim | Verdict | Consequence |
|---|---|---|
| Voice bugs in hub | **REFUTED — inverted** | Hub already has both fixes (PR #57); *Ember* has the bugs. Dropped from plan. Optional: backport hub's fix to Ember. |
| Terminal refresh types resume cmd into TUI | Confirmed | PR 1. Exact 6-file port recipe below. |
| Codex buffered / stream gaps | Confirmed **+ worse** | Hub never installs a ported codex rollout at all; codex errors read stderr only (codex writes them to stdout); client disconnect kills BOTH persist paths — turn fully lost. |
| Global stream state bleeds across sessions | Confirmed | One nuance: stop-routing is already session-keyed; rendering/sending/acc text are not. |
| DELETE leaks storage | Confirmed | Scope = storage only: microVM ages out via platform lifecycle; workflow-origin dirs have a 14-day GC; **human sessions leak EFS + S3 forever**. |
| Auth-flip breaks | **Partial** | (a)(b)(d) confirmed; (c) wrong about shell — shell route mints NO GitHub token at all (that's the terminal-git-auth gap, now PR 7). |
| Attachments + gitMode absent | Confirmed | But hub already has 3 reusable pieces (see PR 4) — reconcile, don't duplicate. |

## Preserve (hub is ahead — do not clobber)

- `mutateSession` optimistic concurrency + `STOP_MARKER` (better than Ember's re-read+put).
- Workflow-origin sessions (`origin`/`workflowId`/`agentId`, list filters, sidebar badge).
- Voice fixes (hub-only), test suite + `data-testid` hooks.
- GitHub App fixes Ember lacks: no negative config caching, full HTML-escape manifest form, `encodeUserId` dot-escape.
- Runtime: pipeline-persona invocation, workflow-session GC, model tiers, OTEL metrics.
- Hub auth substrate (`@/lib/auth/*`), env names, legacy-unprefixed default-tenant keys.

## Skip

Cognito/Cloudflare tenancy substrate ports, subscription authMode, per-tenant silo
runtimes, Ember flame branding, ECS Express deploy tier. **Kiro CLI: deferred** (say the
word and it becomes PR 8).

---

## PR 1 — Terminal resume done server-side (fixes the refresh bug)

**Bug (confirmed):** `ShellTerminal.tsx:101-109` types `cd … && claude --resume …\n`
from the browser in `ws.onopen`; the guard is a per-mount ref, so every refresh
remounts, reattaches to the same live PTY (`shellId = sh-<sessionId>`), and the line
lands inside the running Claude TUI's composer. Fires on EVERY claude terminal open
(`page.tsx:530` passes `resumeSessionId` unconditionally).

**Fix (Ember's mechanism):** the *server* launches the resume; the browser only types
the first-prompt seed, gated on a `resumeReady` flag.

Files (all six required — UI-only would silently break resume):
1. `deploy/coding-agent-runtime/main.py` — port `_write_resume_launch_hint` /
   `_restore_resume_launch_hint` (durable per-session EFS copy, rebuilt on recycled
   VMs); return `resume_ready` from warm + prepare. Claude-only variant is fine (hub
   has no per-session codex home).
2. `deploy/coding-agent-runtime/shell-init.sh` — auto-resume exec block (Ember
   `shell-init.sh:182-204`): source the hint, `exec claude --resume`, run-once guard so
   PTY reattach never re-fires.
3. `src/lib/cloud-code/runtime.ts` — warm/prepare parse the response body → `{resumeReady}`
   (hub currently discards it).
4. `shell/route.ts` — ported sessions await full warm (bounded race, `maxDuration` 30→60);
   return `resumeReady`.
5. `ShellTerminal.tsx` — delete the cd+resume typing; type only the seed, gated on
   `data.resumeReady`, prompt then `\r` as separate writes with socket-open re-check.
6. `page.tsx` — drop the `resumeSessionId` prop.

**Deploy:** runtime image rebuild + push (Colima, prod profile) *and* app deploy, same PR.

## PR 2 — Streaming reliability (runtime + message route)

1. **Codex streaming**: port `_stream_codex` (Ember `main.py:2197-2290` — per-step JSONL →
   text frames, `turn.completed` → done); drop the `cli == "claude"` gates in hub
   `main.py:1191-1195` and `message/route.ts:86-87`. Kills the proxy-idle-timeout risk on
   long codex turns.
2. **Client-disconnect persist** (worst confirmed bug): hub's relay `enqueue` throws on
   browser disconnect, and the catch block's own `enqueue` rethrows — both `persistTurn`
   calls skipped, turn lost. Port Ember's `clientGone` flag: stop relaying, keep draining
   upstream, persist the full reply. Keep hub's `mutateSession` persistence.
3. **Codex resume install + sanitize**: hub's transcript install is claude-only, so a
   ported codex session lands with no resumable transcript. Port the codex install path
   + `_sanitize_codex_rollout` (strip non-Mantle `encrypted_content` reasoning items +
   trailing unpaired function_calls; keep pristine S3 copy for pull-home) + codex
   stdout error surfacing.

**Deploy:** runtime image + app.

## PR 3 — Per-session stream isolation + concurrent turns (page.tsx)

Confirmed globals: `sending`, `stopping`, single `turnRef`/`genRef`/`accRef` —
mid-stream session switch bleeds the reply into the wrong window; second session can't
run concurrently. Port Ember `fea6a53` wholesale, all three pieces:
- `liveCtrl` Map + `liveTurns` overlay keyed by sessionId,
- `sendingIds`/`stoppingIds` Sets,
- drop-recovery: `visibilitychange` + `focus` + poll-while-visible (`pendingRecover`).
Keep hub's `data-testid` hooks + workflow-session UI. App-only deploy.

## PR 4 — Chat attachments (reconcile with existing plumbing)

Hub already has: presigned-PUT upload endpoint (`artifacts/route.ts` POST), per-turn S3
artifact restore into the workspace (`_install_artifacts`, runs every turn), post-turn
harvest (`_sync_turn_artifacts`). The `[coding-artifacts]` footer is the *pipeline*
runtime — irrelevant here.

Missing chat-side pieces only:
1. `attachments` field on `CloudCodeTurn` + message-route payload (sanitized rel paths,
   cap 20) + attachment-only turns get a default prompt.
2. Composer UI: upload via the existing artifacts endpoint → pending chips → inline
   thumbnails + Lightbox in chat.
3. Presign-on-session-GET (`withAttachmentUrls`) so reloads keep thumbnails.
4. Runtime: per-turn `attachments` fetch + append on-disk paths to the prompt (Ember
   `_fetch_attachments`) — small since restore already exists.

**Deploy:** runtime image + app.

## PR 5 — Flexible git handoff

Zero partial support in hub (verified). Port whole: `gitMode`
(`pushed|bundle|selfContained|none`) + `cloneUrl` + `resumeBundleKey` in types/port
route, `_apply_resume_bundle` in runtime, bundle creation in MCP `git.ts`,
`parseRepoFromUrl` title fallback, port/checkpoint artifact legs + orientation prompt
(pairs with PR 4's prefixes). **Deploy:** runtime image + app + MCP republish.

## PR 6 — Session lifecycle: soft-delete + reaper (storage reclamation)

Confirmed leak per deleted human session: EFS `sessions/<sid>/` (full clone) +
transcript files, S3 `resume/<sid>/{*.jsonl, artifacts/*}` and
`checkpoint/{<sid>,<resumeId>}/…`. Compute doesn't leak. Port Ember's three-part
design, adapted to hub tables/roles:
1. `softDeleteSession` (deletedAt + short TTL; list filters tombstones) — keep hub's
   `mutateSession` for the write.
2. DDB stream → reaper Lambda (`deploy/session-reaper`): StopRuntimeSession + runtime
   purge action (hub main.py has none — port it; must also cover the
   resumeId-keyed checkpoint prefix) — failed reap re-arms the TTL.
3. S3 lifecycle backstop rule.
Optional rider: tenant-index GSI (listSessions Query instead of Scan).
**Deploy:** runtime image + new Lambda + app.

## PR 7 — Auth-flip landing prep (do BEFORE enabling AUTH_MODE=cloudflare-access)

Verified breaks when auth flips on:
1. **MCP dies entirely**: middleware 401s `/api/*`; hub's port-session MCP sends zero
   credentials (port, checkpoint, warm, config sync all fail at the first call). Fix:
   token file + fetch wrapper adding Authorization, middleware accepts the bearer
   alongside the CF assertion (Ember's pattern minus Cognito), or CF service-token
   headers — service tokens carry no email, so the CF adapter needs a
   service-token→tenant mapping.
2. **Legacy rows orphaned**: real SSO identities (tenant = email domain) can't see
   `default`-keyed sessions/config/github rows. Fix: one-time re-key migration script
   (sessions.tenantId, `config:default`, `github:default`, S3 config prefix) — or a
   documented read-fallback for the deploy operator.
3. **Requester-bound clone tokens**: message + warm mint from `session.userId`
   (creator); shell mints nothing. Fix: mint from `getIdentity(request).userId`
   (fallback to creator when requester has no GitHub connection), and pass
   token through `prepareCodingSession` so App-connected users' terminals stay
   repo-scoped instead of using the broad PAT.
4. **Admin gate**: `isAdmin()` = everyone under AUTH_MODE=none; under SSO it fails
   closed to the `admin` group → flip-on risk is *lockout*. Prep: define the admin
   group in the Access policy first; note the manifest route is everyone-accessible
   until then.

**Deploy:** app + MCP republish; migration script run once at flip time.

---

## Sequencing

1 → 2 → 3 ship independently, in that order (2 before 3: the isolation UI assumes all
CLIs stream). 4 → 5 after 2 (attachments ride the streaming payload). 6 anytime.
7 gates the auth flip, not the other PRs. Runtime-image PRs (1, 2, 4, 5, 6) each need
the Colima build + prod push; batch pushes where PRs land close together.

Tests: extend the Tier-1 merge-gate suite per PR; Ember's demo-flow E2E spec
(`6109093`) is the template. After every runtime change, smoke the pipeline personas
(workflow-origin sessions share `/invocations`).
