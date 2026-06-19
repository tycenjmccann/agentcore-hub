# Coding Agent Runtime (resumable Claude Code + Codex)

A dedicated Amazon Bedrock AgentCore Runtime that hosts coding CLIs server-side
with a **persistent per-repo workspace** (`/mnt/workspace`) and **OTel →
CloudWatch tracing**. This is the official "safe to close your laptop" pattern
from [awslabs/agentcore-samples](https://github.com/awslabs/agentcore-samples)
(`04-coding-agents/01-claude-code-with-s3-files`): the CLI runs in a per-session
microVM, the workspace survives, and you **resume a conversation by invoking
again with the same `runtimeSessionId`**.

> This is a standalone, user-facing coding agent — NOT wired into the 14-agent
> workflow fleet. (An earlier attempt to force coding-CLI output through the
> workflow pipeline failed because the pipeline assumes local files; this model
> is Git-native and conversational instead.)

## Interaction model

```
client ── invoke_agent_runtime(runtimeSessionId, {prompt, repo?, cli?, claude_session_id?})
          │
          ▼
   microVM (one per runtimeSessionId)
     main.py /invocations
       ├─ git clone repo → /mnt/workspace/<owner-name>   (first turn only; warm after)
       ├─ claude --print --resume <claude_session_id>    (or run-codex.sh for codex)
       └─ commit / push / open PR
     ← { response, claude_session_id, cli, workspace }

resume = same runtimeSessionId  → same warm microVM + /mnt/workspace
       + claude_session_id       → same Claude Code conversation
```

- **Workspace persistence:** `filesystemConfigurations=[{sessionStorage:{mountPath:"/mnt/workspace"}}]`.
  A re-invoke with the same session id finds the repo already cloned.
- **Conversation resume:** Claude Code's own `--resume <session_id>`. Claude scopes
  a conversation to its working directory, so the server persists a
  `{claude_session_id → repo}` map (`/mnt/workspace/.sessions.json`) and recovers
  the cwd automatically — the caller only needs to pass `claude_session_id`.
- **Git-native:** works from a clone, not your local files. Output = a pushed branch / PR.

## Files

| File | Role |
|---|---|
| `main.py` | Resumable `/invocations` FastAPI server + `/ping` health (HealthyBusy while a CLI runs) |
| `run-codex.sh` | Codex launcher — routes GPT-5.5 through Bedrock Mantle (no OpenAI key) |
| `Dockerfile` | ARM64 image: git, Node, Claude Code, Codex, otelcol-contrib |
| `otel-collector-config.yaml` | SigV4 OTLP → CloudWatch `aws/spans` |
| `setup-coding-runtime-role.sh` | IAM execution role (Bedrock + Mantle + ECR + observability) |
| `build-and-push.sh` | Build/push ARM64 image to ECR (account/region from `config.sh`) |
| `deploy.py` | Create/update the runtime via the control API (session storage) |
| `invoke.py` | Headless client to fire/resume turns |
| `log.py` | Structured JSON logging |

## Deploy

```bash
export AWS_PROFILE=<your-profile>
set -a; source .env.local; set +a          # GITHUB_PAT, GITHUB_OWNER
source deploy/config.sh

source deploy/coding-agent-runtime/setup-coding-runtime-role.sh   # → CODING_RUNTIME_ROLE_ARN
./deploy/coding-agent-runtime/build-and-push.sh                   # → IMAGE_URI
export IMAGE_URI=<account>.dkr.ecr.<region>.amazonaws.com/coding-agent-runtime:latest
python3 deploy/coding-agent-runtime/deploy.py                     # → CODING_AGENT_RUNTIME_ARN
```

## Use (headless)

```bash
export CODING_AGENT_RUNTIME_ARN=arn:aws:bedrock-agentcore:...:runtime/...

# New session on a repo:
python3 deploy/coding-agent-runtime/invoke.py --repo owner/name \
  "add a CONTRIBUTING.md, commit on a new branch, push, open a PR"

# Resume (same workspace + conversation) — only need the two ids it printed:
python3 deploy/coding-agent-runtime/invoke.py \
  --session <runtimeSessionId> --resume <claude_session_id> "now add a license section"

# Codex (GPT-5.5 via Bedrock Mantle) instead of Claude:
python3 deploy/coding-agent-runtime/invoke.py --cli codex --repo owner/name "..."
```

## Payload contract

`POST /invocations` (via `invoke_agent_runtime`):

| Field | Required | Notes |
|---|---|---|
| `prompt` | yes | The task / message for this turn |
| `repo` | no | `owner/name` or clone URL. Cloned on first turn; recovered from the session map on resume |
| `cli` | no | `claude` (default) or `codex` |
| `claude_session_id` | no | From a prior turn's response → resumes that Claude Code conversation |

Response: `{ response, claude_session_id, cli, workspace }` or `{ error }`.

## Verified

- Invoke loop, conversation resume (remembers prior turns), clone→edit→commit→push→**real PR**,
  warm `/mnt/workspace` across invokes with auto-recovered cwd, and Codex (GPT-5.5/Mantle) — all green.

## Streaming

Claude turns stream token-by-token over SSE. `/invocations` with `stream:true`
runs `claude --output-format stream-json --include-partial-messages` and the
server returns a `StreamingResponse` of `data:` frames (`{type:text|done|error}`)
that AgentCore forwards through `InvokeAgentRuntime` (accept `text/event-stream`).
The Next.js chat consumes it via the shared SSE reader. See
[docs/streaming-sse.md](../../docs/streaming-sse.md). Codex stays buffered.

## Known gaps / next
- **Codex resume:** each Codex turn is independent (no `--resume` wired) — Claude has full resume.
- **Single-user:** no auth yet. Session records should carry `userId` (hardcode `"default"` now,
  swap for the Cognito `sub` when app-wide SSO lands).
