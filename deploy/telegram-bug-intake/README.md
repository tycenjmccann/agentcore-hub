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
| Function | `telegram-bug-intake` (account `838829463875`, `us-east-1`) |
| Runtime | `nodejs20.x`, ESM, handler `index.handler` |
| Deployed code LastModified | 2026-08-27 |
| `sha256(index.mjs)` as deployed | `5eb0bb40a824f57f0b86dfdef99dfeb26a9cabbc35b0bf95066cc74fbe762f81` |

**The only textual difference from the deployed bytes** is `export` added to
`async function transcribeVoice(fileId)` (line 716) so the unit tests can import
it directly. Nothing else was touched; `diff` against the deployed `index.mjs`
shows that one line and nothing more. Keep it that way: when editing, the diff
against the running function should always be reviewable line-by-line.

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

Optional: `ALLOWED_CHAT_IDS`, `BEDROCK_MODEL_ID`, `CONFIDENCE_THRESHOLD`,
`TRANSCRIBE_LANGUAGE`, `CHAT_SETTLE_MS`, `CHAT_BUFFER_MAX_MS`,
`WM_MIN_BUDGET_MS`, `WM_RELAY_TIMEOUT_MS`.

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
