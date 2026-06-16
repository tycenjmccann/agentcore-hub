# Coding-agent runtime (Claude Code + Codex)

A dedicated Amazon Bedrock AgentCore Runtime that hosts two coding CLIs on one
ARM64 image, with a **persistent per-session workspace** (`/mnt/workspace`) and
**full OTel → CloudWatch tracing**. The Strands fleet agents (`deploy/runtime-agent/`)
delegate coding work here via the AgentCore commands API instead of shelling a
CLI subprocess inside their own microVM.

Why: the old subprocess approach was a black box (one `claude_code` tool event,
then a text blob N minutes later) with a cold workspace every call. Hosting the
CLI on its own runtime makes every internal tool call a CloudWatch span, keeps
the repo checkout + deps warm across invocations, and lets multiple CLIs share
the same plumbing.

Pattern validated against `aws-samples/sample-agent-assisted-sdlc` and
`awslabs/agentcore-samples` (code-agents-competition-e2e).

> Kiro CLI was intentionally left out: it can't authenticate headlessly in a
> runtime microVM without a Pro+ subscription key in the AgentCore Identity
> vault. The plumbing here generalizes — adding it later is a launcher + an
> identity setup, not a redesign.

## Architecture

```
Strands fleet agent ── commands API (SigV4 POST /runtimes/{arn}/commands) ──▶ coding runtime (microVM)
   (claude_code / codex tools)     X-Amzn-...-Session-Id: env-{repo_slug}        ├─ /app/run-{cli}.sh
                                   EventStream contentDelta/contentStop          ├─ /mnt/workspace (persistent)
                                                                                 └─ OTel sidecar → aws/spans
```

The runtime `main.py` is **only a health server** — it reports `HealthyBusy`
while any CLI process is alive so AgentCore won't reap the session mid-run. CLIs
launch via the commands API, not the `/invocations` entrypoint.

## CLI auth (verified)

| CLI    | Backend                | Auth                                              | Extra setup |
|--------|------------------------|---------------------------------------------------|-------------|
| Claude | Bedrock                | `CLAUDE_CODE_USE_BEDROCK=1` + microVM IAM role    | none |
| Codex  | Bedrock Mantle         | Codex built-in `amazon-bedrock` provider (SigV4 from the IAM role) | GPT-5.5 model access |

- **Claude**: verified working end-to-end through the runtime (Opus via Bedrock).
- **Codex**: uses Codex's built-in `amazon-bedrock` provider (the AWS blog
  pattern) — no OpenAI key, no `OPENAI_BASE_URL`, no bearer token; Codex signs
  with SigV4 and routes to `bedrock-mantle.<region>.api.aws/openai/v1`. Default
  model `openai.gpt-5.5` in `BEDROCK_MANTLE_REGION` (default `us-east-2`);
  override with `CODEX_MODEL`. **GPT-5.5 must be enabled on Bedrock Mantle for
  your account** — until then Codex returns "Engine not found". The transport,
  auth, and config are verified; only model access gates a live Codex run.

## Deploy

```bash
source deploy/config.sh

# 1. Execution role (Bedrock + Mantle + ECR + observability)
source deploy/coding-agent-runtime/setup-coding-runtime-role.sh   # exports CODING_RUNTIME_ROLE_ARN

# 2. Build + push the ARM64 image
deploy/coding-agent-runtime/build-and-push.sh                     # prints IMAGE_URI
export IMAGE_URI=<printed value>

# 3. Create/update the runtime with session storage
python deploy/coding-agent-runtime/deploy.py                      # prints CODING_AGENT_RUNTIME_ARN
export CODING_AGENT_RUNTIME_ARN=<printed value>

# 4. Redeploy the fleet so agents pick up CODING_AGENT_RUNTIME_ARN
cd deploy/runtime-agent && ./deploy-fleet.sh
```

When `CODING_AGENT_RUNTIME_ARN` is unset on a fleet agent, `claude_code` falls
back to the in-container subprocess path (dev/local keeps working); `codex`
returns an actionable "runtime not configured" message.

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | ARM64 image: Claude Code + Codex + otelcol-contrib |
| `main.py` | FastAPI health server (`HealthyBusy` across both CLIs) + OTel sidecar bootstrap |
| `otel-collector-config.yaml` | SigV4 OTLP → X-Ray + CloudWatch Logs, GenAI semconv normalization |
| `log.py` | stdlib JSON logger |
| `run-claude.sh` / `run-codex.sh` | per-CLI launchers (stream-json/JSONL output) |
| `build-and-push.sh` | build + push (sources `config.sh`, no hardcoded account) |
| `deploy.py` | control-API create/update with `filesystemConfigurations` session storage |
| `setup-coding-runtime-role.sh` | execution role |
