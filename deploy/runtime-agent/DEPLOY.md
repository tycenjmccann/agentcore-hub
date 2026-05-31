# Agent Fleet Deployment Guide

## Prerequisites

1. AWS CLI configured with a profile that has access to your target account
2. `agentcore` CLI installed
3. Environment variables set (see below)

## Quick Deploy (all 14 agents)

```bash
cd deploy/runtime-agent

# Source central config (derives ACCOUNT_ID from your credentials)
source ../config.sh

# Set these for your environment:
export AWS_PROFILE=your-profile
export GATEWAY_ARN="arn:aws:bedrock-agentcore:${AWS_REGION}:${ACCOUNT_ID}:gateway/your-gateway-id"

# Deploy all agents
for agent in agentcore_hub_requirements_analyst agentcore_hub_frontend_designer agentcore_hub_ios_designer agentcore_hub_backend_designer agentcore_hub_android_designer agentcore_hub_security_reviewer agentcore_hub_legal_compliance agentcore_hub_localization agentcore_hub_analytics_designer agentcore_hub_backend_dev agentcore_hub_api_dev agentcore_hub_frontend_dev agentcore_hub_qa_verifier agentcore_hub_ci_agent; do
  echo "--- $agent ---"
  bash deploy-one.sh "$agent"
done
```

## Post-Deploy Validation

```bash
GITHUB_OWNER=$GITHUB_OWNER \
GITHUB_REPO=your-repo \
python3 verify-fleet-invoke.py \
  --fleet-file fleet-runtime-ids.json \
  --timeout 600 \
  --parallel 5
```

Optional: test with a different model:
```bash
python3 verify-fleet-invoke.py --fleet-file fleet-runtime-ids.json --timeout 600 --parallel 5 --model us.anthropic.claude-sonnet-4-6
```

## Environment Variables Reference

### Required Shell Env (set BEFORE running deploy-one.sh)

| Variable | Example | Purpose |
|----------|---------|---------|
| `AWS_PROFILE` | your-profile | AWS credentials profile |
| `AGENTCORE_ROLE_ARN` | `arn:aws:iam::${ACCOUNT_ID}:role/agentcore-hub-agentcore-role` | Runtime execution role |
| `ARTIFACT_BUCKET` | `agentcore-hub-artifacts-${ACCOUNT_ID}-${REGION}` | S3 bucket for prompts & artifacts |
| `GATEWAY_ARN` | `arn:aws:bedrock-agentcore:us-east-1:${ACCOUNT_ID}:gateway/...` | AgentCore MCP gateway |
| `AWS_REGION` | `us-east-1` | Deployment region |
| `GITHUB_PAT` | *(from .env.local)* | GitHub MCP authentication |

### Runtime Env Vars (set ON the deployed agent)

These are passed via `--env` in deploy-one.sh and available inside the runtime at invocation time:

| Variable | Value | Purpose |
|----------|-------|---------|
| `AGENTCORE_HUB_ARTIFACT_BUCKET` | `agentcore-hub-artifacts-${ACCOUNT_ID}-${REGION}` | S3 bucket for agent file ops |
| `GATEWAY_ARN` | *(gateway ARN)* | AgentCore gateway reference |
| `MODEL_ID` | `us.anthropic.claude-opus-4-6-v1` | Default model for agents |
| `READ_TIMEOUT` | `600` | Bedrock invoke timeout (seconds) |
| `EVENTS_TABLE` | `agentcore-hub-events` | DynamoDB table for streaming events |
| `TICKET_TOOLS_LAMBDA` | `agentcore-hub-tickets` or `agentcore-hub-jira` | Lambda for ticket operations (matches your TICKET_PROVIDER) |
| `SYSTEM_PROMPT_S3_KEY` | `prompts/{agent_name}.txt` | S3 key for agent system prompt |
| `BYPASS_TOOL_CONSENT` | `true` | Non-interactive tool execution |
| `CLAUDE_CODE_USE_BEDROCK` | `1` | Claude Code uses Bedrock |
| `CLAUDE_MODEL` | `us.anthropic.claude-opus-4-6-v1` | Claude Code model |
| `ANTHROPIC_MODEL` | `us.anthropic.claude-opus-4-6-v1` | Claude Code model (alt) |
| `GITHUB_PAT` | *(token)* | GitHub MCP access |

## Known Gotchas

### 1. ARTIFACT_BUCKET is a reserved name

AgentCore CLI injects a system env var called `ARTIFACT_BUCKET` pointing to its internal CodeBuild source bucket (`agentcore-artifacts-{account}-{region}`). This OVERRIDES any value you pass.

**Solution:** We use `AGENTCORE_HUB_ARTIFACT_BUCKET` instead. In main.py:
```python
ARTIFACT_BUCKET = os.getenv("AGENTCORE_HUB_ARTIFACT_BUCKET", os.getenv("ARTIFACT_BUCKET", ""))
```

### 2. Do NOT source .env.local fully

`.env.local` may contain values for a different account. The deploy script only extracts `GITHUB_PAT` from it.

### 3. Entrypoint must be "main.py" only

Older toolkit versions used `"opentelemetry-instrument,main.py"` — this no longer works. Use `-e "main.py"`.

### 4. --auto-update-on-conflict behavior

This flag updates existing runtimes in-place (same ARN). Env vars ARE applied on update. If S3 tools break after deploy, check the bucket env var first.

### 5. Cold start on new sessions

Prompts load from S3 at session cold start. After deploying new prompts, the next invocation will pick them up (new session = new prompt).

## Architecture

```
deploy-one.sh
  ├── sources ../config.sh (gets ACCOUNT_ID, ROLE_ARN, BUCKET)
  ├── agentcore configure (creates .bedrock_agentcore.yaml)
  ├── uploads prompt to s3://{ARTIFACT_BUCKET}/prompts/{agent}.txt
  └── agentcore deploy --auto-update-on-conflict --env ...
        └── Creates/updates runtime in your account
              └── At invocation: loads prompt from S3, creates Agent, streams response
```

## Fleet Runtime ARNs

See `fleet-runtime-ids.json` (generated at deploy time, gitignored) for all 14 agent ARNs.
