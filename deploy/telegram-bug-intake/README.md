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
`ARTIFACT_BUCKET`, `PIPELINE_REGIONS`.

`DEPLOY_PIPELINE_NAME` and `ARTIFACT_BUCKET` together enable the CI/CD
deploy-approval bridge (TEAM-3740, multi-target since TEAM-4338): the poller
watches, for EVERY CodePipeline it can see, for a `ManualApproval` action
awaiting a decision, pings allowlisted chats with Approve / Reject buttons, and
maps the tap to `codepipeline:PutApprovalResult` on that pipeline, in its own
region. Both unset is the OSS default and makes the whole path a **true
no-op** — zero AWS calls, not even a client constructed — so both variables are
purely additive:

- `ARTIFACT_BUCKET` — when set, the poller reads `config/cd-registry.json`
  from this bucket (60s TTL) and adds every entry that names a `pipeline` as a
  target, in that entry's own `region`. A read failure other than "the key
  doesn't exist yet" keeps the last good copy rather than going empty.
- `DEPLOY_PIPELINE_NAME` — a fallback target in the function's own region,
  deduped against the registry (naming the same pipeline in both places is not
  a double watch).
- `PIPELINE_REGIONS` — **not read by this Lambda at all.** It exists purely as
  the IAM fan-out list for `update-config.sh` below (which region(s) to grant
  `hub-*-deploy` access in); the poller's actual target list always comes from
  the registry at runtime, so registering a repo never requires an IAM edit.

## IAM

This function is account-local — its execution role is managed out of band (see
Provenance), not by a repo-tracked SAM/CDK stack — so the role's statements are
documented here rather than declared in infra. Beyond the DynamoDB /
Bedrock / Transcribe access the intake paths need, the deploy-approval bridge
requires three statements: two CodePipeline actions, scoped to the configured
deploy pipeline ARN plus the `hub-*-deploy` convention per `PIPELINE_REGIONS`,
and one S3 read:

- `codepipeline:GetPipelineState` — poll for an approval action awaiting a decision.
- `codepipeline:PutApprovalResult` — record the Approve / Reject tap. This
  function is the ONE place in the account that legitimately holds this
  action — the `Pipeline___*` tools Lambda never gets it (the deploy gate is
  human-only).
- `s3:GetObject` on exactly `config/cd-registry.json` in `ARTIFACT_BUCKET` —
  one key, not a prefix.

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
