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
`WM_MIN_BUDGET_MS`, `WM_RELAY_TIMEOUT_MS`, `DEPLOY_PIPELINE_NAME`.

`DEPLOY_PIPELINE_NAME` enables the CI/CD deploy-approval bridge (TEAM-3740):
the poller watches this CodePipeline for a `ManualApproval` action awaiting a
decision, pings allowlisted chats with Approve / Reject buttons, and maps the
tap to `codepipeline:PutApprovalResult`. It is **fail-closed**: unset (OSS /
accounts without the pipeline) makes the whole path a no-op, so the variable is
purely additive. Set it to the deploy pipeline name (`agentcore-hub-deploy`).

## IAM

This function is account-local — its execution role is managed out of band (see
Provenance), not by a repo-tracked SAM/CDK stack — so the role's statements are
documented here rather than declared in infra. Beyond the DynamoDB /
Bedrock / Transcribe access the intake paths need, the deploy-approval bridge
requires two CodePipeline actions, scoped least-privilege to the deploy pipeline
ARN (`arn:aws:codepipeline:<region>:<account>:agentcore-hub-deploy`):

- `codepipeline:GetPipelineState` — poll for an approval action awaiting a decision.
- `codepipeline:PutApprovalResult` — record the Approve / Reject tap.

Both are unused while `DEPLOY_PIPELINE_NAME` is unset; grant them only where the
pipeline exists.

## Deploy

The function has no dependencies to bundle — it imports only AWS SDK v3 clients,
which the `nodejs20.x` runtime provides. So a deploy is the zip and nothing else:

```bash
cd deploy/telegram-bug-intake
zip function.zip index.mjs
aws lambda update-function-code \
  --function-name telegram-bug-intake \
  --zip-file fileb://function.zip
rm function.zip
```

`update-function-code` does not touch environment variables — config changes need
a separate `update-function-configuration`.

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
