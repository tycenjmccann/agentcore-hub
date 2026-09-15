# Telegram bug intake Lambda

Source of the account-local `telegram-bug-intake` Lambda: the Telegram bot that
turns screenshots + descriptions into Jira Bugs, files features into the hub
pipeline, and relays everything else to the Workflow Manager. Account-specific
glue, not part of the OSS core — but it is now versioned here because it carries
real logic (voice transcription, intent classification, review-gate pings) that
needs tests and review like anything else.

## Provenance

This file previously existed **only** in the gitignored `deploy/local/` directory
on the maintainer's laptop and inside the deployed function — no copy was in git
history. It was retrieved verbatim from the deployed code
(`lambda:GetFunction` → `Code.Location`):

| | |
|---|---|
| Function | `telegram-bug-intake` (account `<ACCOUNT_ID>`, `us-east-1`) |
| Runtime | `nodejs20.x`, ESM, handler `index.handler` |
| Deployed code LastModified | 2026-08-27 |
| `sha256(index.mjs)` as deployed | `5eb0bb40a824f57f0b86dfdef99dfeb26a9cabbc35b0bf95066cc74fbe762f81` |

The import commit (`52bbd12`) was byte-identical to the deployed code apart from
one line — `export` on `transcribeVoice` so the tests can import it. Everything
after that is a reviewable diff against the running function; keep it that way.

Changes on top of the imported baseline:

- **TEAM-3464** — `transcribeVoice` now paces audio into Transcribe streaming in
  ~200 ms chunks and terminates the stream with an empty `AudioEvent` (PR #221).
  This fix has since been deployed; if you need to know exactly what the running
  Lambda contains, re-verify against the live function
  (`lambda:GetFunction` → `Code.Location`, compare `sha256(index.mjs)`) rather
  than trusting this note.
- **TEAM-3493** — ship-review P1 fixes: voice transcription is budgeted against
  the remaining Lambda clock (deferred to the next invocation, or rejected if it
  could never fit, instead of dying mid-transcription and replaying forever);
  `ALLOWED_CHAT_IDS` fails closed when empty; review-gate callbacks require an
  allowlisted chat; a gate's 30-day notification claim is released when zero
  pings were delivered.
- **PR #265** — review-gate pings carry an "Open approval in hub" deep link
  straight to the gate ticket's review view
  (`/workflow?id=<workflowId>&ticket=<ticketId>`), the one screen with the full
  formatted breakout and approve controls.
- **PR #293 (TEAM-3740-era deploy gate)** — `scanDeployApprovals` enrichment:
  the commit SHA being deployed is extracted from the Source stage's
  `currentRevision`, and `buildDeployBrief` turns it into a "what's shipping"
  brief (commit subject, associated PR title/body, workflow/epic key, one-line
  summary, file scope) via the GitHub API; the approval ping gains "View PR" /
  "View commit" link buttons. All best-effort — failures fall back to the terse
  message.
- **TEAM-4338 (multi-CD deploy gate)** — the bridge no longer watches one
  hardcoded pipeline. It now reads `config/cd-registry.json` from
  `ARTIFACT_BUCKET` and polls EVERY registered pipeline (its own region, its
  own repo in the brief), in addition to the `DEPLOY_PIPELINE_NAME` fallback.
  See "Secrets and config" and "Multi-target behaviour" below.

- **Gate rework notes (2026-09-10)** — a ❌ Request changes tap parks a 24h
  marker; the chat's next plain message(s) — or a reply to the gate ping at any
  time, keyboard or not (`wf:` label fallback) — are buffered like a report and
  delivered as ONE `in_review → blocked` comment. The marker is cleared only
  after the transition lands; a refusal (e.g. Jira workflow missing a `→ Blocked`
  transition) parks the note WITH the marker and offers Retry / Drop, so a
  re-typed note can never fall through to bug intake. A stray `DECISION:` line
  with no gate waiting gets a hint instead of being filed. See
  `__tests__/gate-rework-note.test.mjs`.

## Architecture

Polling, not webhook — the account blocks public Lambda URLs (and an open webhook
is a liability anyway). EventBridge `rate(1 minute)` → this Lambda long-polls
Telegram `getUpdates` (~50 s per invocation, offset persisted in DynamoDB).
Reserved concurrency is **1**: Telegram 409s on concurrent `getUpdates`.

Per-chat message buffering (`CHAT_SETTLE_MS`) collapses an album or a
multi-message paste into ONE ticket. Three intents: `bug` → Jira Bug,
`feature` → hub `/api/workflow/start`, `chat` → Workflow Manager SSE relay with
`conversationId = tg-{chatId}`. A `wm:` / `/wm` prefix addresses WM directly.

Native voice notes (OGG/Opus @ 48 kHz) go to Amazon Transcribe **streaming** with
no transcoding; the transcript then flows exactly like typed text. See
`__tests__/transcribe-voice.test.mjs` for the delivery contract that path must
honour.

## Secrets and config

No secrets in code. Every credential comes from the Lambda's environment
(populated from Secrets Manager per `DEPLOY.md`), and the module fails fast on a
missing one via `requireEnv`:

Required: `TELEGRAM_BOT_TOKEN`, `JIRA_SITE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`,
`JIRA_PROJECT_KEY`, `GITHUB_TOKEN`, `GITHUB_USER`, `PENDING_TABLE`,
`HUB_API_URL`.

`ALLOWED_CHAT_IDS` is fail-closed: if it is unset or empty, NO chat is
authorized (messages and review-gate buttons are both rejected), so it must be
populated for the bot to do anything.

Optional: `BEDROCK_MODEL_ID`, `CONFIDENCE_THRESHOLD`,
`TRANSCRIBE_LANGUAGE`, `CHAT_SETTLE_MS`, `CHAT_BUFFER_MAX_MS`,
`WM_MIN_BUDGET_MS`, `WM_RELAY_TIMEOUT_MS`, `DEPLOY_PIPELINE_NAME`,
`ARTIFACT_BUCKET`, `PIPELINE_REGIONS`, `EVENT_BUS`, `WM_BUSINESS_TZ`,
`WM_BUSINESS_HOURS` (those three: "Working-hours paging" below), `PING_LEASE_MS`,
`DEPLOY_REPING_INTERVAL_MS`, `DEPLOY_REPING_MAX` (the last three:
"Deploy-approval delivery" below).

`DEPLOY_PIPELINE_NAME` and `ARTIFACT_BUCKET` together enable the CI/CD
deploy-approval bridge (TEAM-3740, multi-target since TEAM-4338): the poller
watches, for EVERY CodePipeline it can see, for a `ManualApproval` action
awaiting a decision, pings allowlisted chats with Approve / Reject buttons, and
maps the tap to `codepipeline:PutApprovalResult` on that pipeline, in its own
region. The claim on the approval token used to mean "exactly one ping per
wait"; since TEAM-4663 it means "at least one **delivered** ping per wait, then a
bounded reminder while the approval is still pending" — see "Deploy-approval
delivery" below. Both unset is the OSS default and makes the whole path a **true
no-op** — zero AWS calls, not even a client constructed — so both variables are
purely additive:

- `ARTIFACT_BUCKET` — when set, the poller reads `config/cd-registry.json`
  from this bucket (60s TTL) and adds every entry that names a `pipeline` as a
  target, in that entry's own `region`. A read failure other than "the key
  doesn't exist yet" — including a **malformed/truncated body** — keeps the last
  good copy rather than going empty, and every attempted read opens the TTL
  window, so a persistent failure costs one GetObject per TTL, not one per scan
  (TEAM-4377, same loader contract as the orchestrator and the `Pipeline___*`
  tools Lambda).
- `DEPLOY_PIPELINE_NAME` — a fallback target in the function's own region,
  deduped against the registry (naming the same pipeline in both places is not
  a double watch). `update-config.sh` only **defaults** this on the function, so
  an operator override survives a re-run — and the inline policy below follows
  the effective value, not the script's default.
- `PIPELINE_REGIONS` — **not read by this Lambda at all.** It exists purely as
  the IAM fan-out list for `update-config.sh` below (which region(s) to grant
  `hub-*-deploy` access in); the poller's actual target list always comes from
  the registry at runtime, so registering a repo never requires an IAM edit.

## IAM

This function is account-local — its execution role is managed out of band (see
Provenance), not by a repo-tracked SAM/CDK stack — so the role's statements are
documented here rather than declared in infra. Beyond the DynamoDB /
Bedrock / Transcribe access the intake paths need, the deploy-approval bridge
requires three statements: three CodePipeline actions, scoped to the function's
**effective** `DEPLOY_PIPELINE_NAME` ARN — `update-config.sh` reads that value
back out of the env document it just applied, so a re-run without re-exporting
still grants an operator's custom pipeline (TEAM-4377) — plus the `hub-*-deploy`
convention per `PIPELINE_REGIONS`, and one S3 read:

- `codepipeline:GetPipelineState` — poll for an approval action awaiting a decision.
- `codepipeline:GetPipelineExecution` — resolve the commit of the execution
  actually parked at that approval, for the cases `GetPipelineState` cannot
  (TEAM-4663: state reports a revision per STAGE, so with two executions in
  flight the Source stage's revision belongs to the newer one). Shares the
  `PipelineStateRead` statement — same pipeline-level resources, no new
  statement. **Best-effort**: while the grant is missing the call AccessDenies,
  the failure is logged once per execution, and the human still gets the ping,
  just the terse one with no commit brief.
- `codepipeline:PutApprovalResult` — record the Approve / Reject tap. This
  function is the ONE place in the account that legitimately holds this
  action — the `Pipeline___*` tools Lambda never gets it (the deploy gate is
  human-only).
- `s3:GetObject` on exactly `config/cd-registry.json` in `ARTIFACT_BUCKET` —
  one key, not a prefix.

Plus one statement for the gate event ("Working-hours paging" below):

- `events:PutEvents` on exactly the effective `EVENT_BUS` (read back the same
  way as the pipeline name). The only event published is `gate.requested`.

`GetPipelineState` and `GetPipelineExecution` are authorized at the PIPELINE
level, but `PutApprovalResult` is authorized at the ACTION level (`arn:...:<pipeline>/<stage>/<action>`), so
its resource is `<pipeline-arn>/*` for each pipeline above, not the bare
pipeline ARN — `update-config.sh` grants them accordingly.

`./update-config.sh` is the tracked, idempotent, re-runnable way to apply both
the env vars above and this inline policy — it **supersedes** the untracked
`deploy/local/telegram-bug-intake/deploy.sh` for that job. Like the zip-and-
`update-function-code` deploy below, it is a **handoff** step: a human runs it;
the pipeline's Deploy stage never touches IAM or env vars.

All three IAM statements are unused while both `DEPLOY_PIPELINE_NAME` and
`ARTIFACT_BUCKET` are unset.

## Multi-target behaviour (TEAM-4338)

Each target the poller finds — one per CD-registry entry with a `pipeline`,
plus the `DEPLOY_PIPELINE_NAME` fallback — gets its own per-region
`CodePipelineClient`, its own claim row (`pipelineName`/`region`/`repo`), and
its own ping: the message names both the pipeline and the repo, and
`buildDeployBrief` is enriched from THAT repo's GitHub history, not the hub's.
One target failing (e.g. a deleted pipeline) never costs another target its
ping. The Approve/Reject callback resolves the pipeline from the claim row and
calls `PutApprovalResult` in that pipeline's own region; a claim row written
before TEAM-4338 (no `region` attribute) still approves, via the function's
default region.

The claim key folds the pipeline name into the hash, so two different
pipelines waiting on tokens that happen to collide get two different claims.
One consequence: on the deploy that ships this change, a wait that is already
mid-flight resolves to a different key than before, so its FIRST scan after
the new code lands can send one duplicate ping for that same wait — the stale
claim row simply TTLs out (7 days) and nothing else is affected.

## Working-hours paging (TEAM-4453 D3)

A review-gate page still fires the instant the gate opens — 02:00 Saturday
included — and nothing here delays or suppresses it. What the window adds is
context and one nudge: every delivered page publishes a `gate.requested` event
(`Source: agentcore-hub.orchestrator`, bus `EVENT_BUS`, default `"default"`)
carrying `outsideHours` and `nextBusinessOpenAt` so the dashboard can tell "the
reviewer was asleep" from "the reviewer was slow", and a page that landed
outside the window earns exactly **one** reminder page when the window next
opens, if the gate is still open — one per notification, not per day, keyed by
`repage#<notif.id>` (a gate re-parked after rework has a new id, so it gets a
fresh page and a fresh reminder). The window is `WM_BUSINESS_TZ` /
`WM_BUSINESS_HOURS` (same names and `HH-HH` half-open format as
`deploy/workflow-manager/toolkit/compute_metrics.py`), but the defaults here are
deliberately the operator's own working day — `America/Los_Angeles` and `09-18`,
Mon–Fri — not the analyzer's `UTC` / `08-18`; an unparseable value warns once
and falls back. Publishing is best-effort: until `update-config.sh` has granted
`events:PutEvents` on the bus, every publish fails and is logged, and paging is
unaffected.

The `gate#<notif.id>` claim carries `pagedAt`, the instant the request-time page
was written (TEAM-4461). The reminder is suppressed when `pagedAt` is already at
or after `nextBusinessOpenAt` — the page landed inside the window on its own
(e.g. requested 08:59, delivered by the 09:00 scan; or a notifier outage delayed
delivery past the opening) — so a "your window is open now" nudge is never sent
for a page the human already received in hours. A claim with no `pagedAt`
(written by an older deployment) falls through to the prior behaviour.

`pagedAt` is **not** a delivery record and TEAM-4663 did not make it one: it is
still the instant the claim was written, and the reminder still keys off exactly
that. Delivery lives in the separate `deliveredAt` attribute added by that
change, and a recovery re-send deliberately leaves `pagedAt` alone — a recovery
lands within one lease (~5 min) plus one scan of the original claim, so the only
way the two could disagree is a page requested within ~5 minutes of a window
edge, and re-dating `pagedAt` would silently change this suppression rule. Do
not conflate the two attributes.

## Deploy-approval delivery (TEAM-4663)

A pending `Approve_deploy` ManualApproval sat **8h45m** with no actionable ping
while this same Lambda kept delivering review-gate pings to the same chat. The
cause was structural, not a Telegram outage: the `dep#` claim row was written
**before** `listChats` + three GitHub calls + the send, recorded nothing about
delivery, and every later scan returned on "already claimed". So an invocation
that died anywhere in that gap stranded the row, and — because the claim key is
derived from the approval **token**, which is stable for the entire wait —
nothing ever re-minted it. Silence for the row's 7-day TTL, in front of an
irreversible production deploy.

The invariant now: a pending approval on a registered pipeline is either pinged
to an allowlisted chat with a working Approve / Reject callback, or re-pinged on
a bounded schedule — never silently parked.

**Two-phase claim.** The claim is phase 1 and records `claimedAt` only; phase 2
(`deliveredAt`, `lastPingAt`, `pingCount`, `messageIds`) is written only after a
confirmed send. `deliveredAt` absent therefore means "nobody was ever paged", a
state the old row could not express. Nothing about the claim key, the
`callback_data` format (`dok|<key>` / `dno|<key>`) or the callback semantics
changed, and the 7-day `ttl` is never extended.

**Recovery.** Losing the conditional Put no longer ends the scan: the row is
consulted, and an undelivered claim older than `PING_LEASE_MS` (default 5 min,
env-overridable) is re-taken with a conditional `UpdateItem` and re-sent, logging
`"… ping never confirmed — re-sending"`. Inside the lease nothing happens — a
send may be in flight in this or a sibling invocation. A recovery that itself
fails to deliver **keeps** the row (its `claimedAt` was just refreshed), so the
next scan past the lease tries again, indefinitely, while the approval is
pending; only a `first`-mode failure releases the claim for the old fast retry.

**Bounded reminders (deploy path only).** A *delivered* claim on a still-pending
approval earns one reminder every `DEPLOY_REPING_INTERVAL_MS` (default 2h), at
most `DEPLOY_REPING_MAX` (default 6) — `pingCount` 1 is the original ping. The
reminder reuses the same key and therefore the same token, so the buttons on the
reminder *and* on the original message all still work; it is titled "still
waiting on your approval" and carries `⏳ Pending 8h 45m · reminder 2 of 6`. The
slot is taken with an optimistic conditional update on
`lastPingAt` + `pingCount`, and a reminder that fails to send burns its slot
(logged; the next one is one interval away).

**Attribution is execution-aware.** `GetPipelineState` reports the latest
revision per **stage**, and an `ActionState` carries no execution id at all, so a
stage's `currentRevision` describes the approval only when that stage's
`latestExecution.pipelineExecutionId` matches the approval stage's. With two
executions in flight it does not, and the incident's ping would have described a
different PR entirely. The Source revision is now used only on a match;
otherwise `GetPipelineExecution` supplies
`pipelineExecution.artifactRevisions[0].revisionId`. Any failure — AccessDenied
included — warns once per pipeline+execution and yields **no** commit, which
means no brief and no GitHub calls rather than a wrong brief. Every ping, terse
or rich, names the execution (`🆔 <first 8 chars>`) so a human can correlate it
with the console and the CD ticket.

**A bad brief can no longer block the ping.** `tgSend` uses legacy
`parse_mode: "Markdown"`, which rejects the *whole* message on one unbalanced
entity, and the old code's only response was release → re-claim → identical
failure every 60s, forever. Each ping is now built twice, rich and terse, and a
Telegram error that is not hopeless (rate-limited, blocked, chat gone) retries
once with the plain-text terse body, same keyboard.

**Scan budget.** The in-loop periodic scans could previously start with as little
as 30s of clock — enough to strand a claim. They now require
`POLL_RESERVE_MS + 90s` (120s) and, when blocked, leave `lastGateScan`
un-stamped, so the next iteration or invocation scans as soon as there is budget.

**Migration.** A `dep#` row from before this change has no `claimedAt`, so its
claim time is derived from the TTL (which *is* claim time + 7 days). One
consequence, and it is deliberate: on the first scan after this deploys, a
legacy row older than the lease gets **one** recovery ping — including the row
stranded by the incident. Same one-duplicate-ping tradeoff already documented
for TEAM-4338, and strictly better than silence.

### Gate + escalation pings

The `gate#<notif.id>` and `esc#<notif.id>` claims (30-day TTL) had the same
claim-before-send hole. A re-parked gate does mint a new `notif.id` — but only
after a human reviews it, which requires that someone was paged, so a strand
there is silent for the row's full 30 days with nothing to re-mint it. Both
paths therefore adopt the **recovery half** through the same generic helpers:
`claimedAt` at claim, `deliveredAt` after a confirmed send, and a lost
conditional Put consults the row and re-sends only when nothing was ever
delivered. As on the deploy path, only a `first`-mode failure releases the claim.
`gate.requested` still fires exactly once per notification — a recovery happens
only when nothing was ever delivered, so nothing was ever published either.

Two deliberate differences from `dep#`:

- **No reminders.** These paths get recovery only. A reminder here would have to
  reason about `repage#`, `REPAGE_SKIP_STATUSES` and the business window, which
  is a design decision, not a bug fix.
- **No TTL fallback.** A `gate#`/`esc#` row with no `claimedAt` is pre-upgrade and
  is **not** recovery-eligible. That is what makes deploying this change page
  nobody twice: without the rule, every gate and escalation open at the time
  would look stranded and be re-paged at once. (`dep#` takes the opposite rule on
  purpose — one row, one incident, and a stale approval ping is cheap.)

`pagedAt` semantics are untouched; see the note in "Working-hours paging" above.

**Follow-up, deliberately not in this change:**

- Bounded reminders for gates and escalations — the design question above.
- Recovery for the `repage#` claim (`index.mjs:899`, released at `943`/`947`).
  It is the mildest case: a lost *reminder* on top of an already-delivered page,
  capped at one ever by design. It also keeps its claim on purpose when the gate
  is already resolved or there are no chats, so "consult the row" needs a rule
  that tells those two states apart from a strand. Those rows already carry
  `claimedAt` (written by the shared claim helper, never read), so the follow-up
  is a two-line change.

## Deploy

The function has no dependencies to bundle — it imports only AWS SDK v3 clients,
which the `nodejs20.x` runtime provides. So a deploy is the zip and nothing else:

```bash
cd deploy/telegram-bug-intake
zip function.zip index.mjs cd-registry.mjs
aws lambda update-function-code \
  --function-name telegram-bug-intake \
  --zip-file fileb://function.zip
rm function.zip
```

`update-function-code` does not touch environment variables or IAM — config
changes need `./update-config.sh` (above), a separate, human-run handoff step.

## Tests

```bash
npx vitest run deploy/telegram-bug-intake
```

`vitest.config.ts` includes `deploy/telegram-bug-intake/**/*.test.mjs`, so
`npm run test:unit` picks these up too. The tests mock only the three AWS SDK
packages and `global.fetch`; the fixture
`__tests__/fixtures/voice-note.oga` is a real 3-second OGG/Opus 48 kHz mono
Telegram-shaped voice note (12,140 bytes,
sha256 `f572e1e28ba97c4f379699562669652eb783bd87629bd9339c891d5355555fe3`).
`@aws-sdk/client-transcribe-streaming` is a devDependency for that reason only —
the Lambda itself uses the runtime-bundled SDK.
