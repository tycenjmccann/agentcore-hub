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

## Post-deploy telemetry verification

The eval batch classifies a run by the `invoke_agent` span
(`gen_ai.operation.name=invoke_agent`, `scope.name=strands.telemetry.tracer`).
That span only exists if a real OTel `TracerProvider` is registered in the
runtime — so after every deploy that touches telemetry, run both probes below.
A green deploy with no spans still scores 0/10.

### Verification gates (automated, blocking)

The manual probes below are now enforced by two scripts — a deploy is not
telemetry-verified until they pass:

- **`verify-fleet.sh` span probe (blocking):** after each agent's health-check
  invocation, the script polls that runtime's `spans` log stream (up to
  3 × 60s) for a fresh `invoke_agent` span and **fails the deploy** if none
  appears. Broken telemetry can no longer ship silently. Emergency bypass:
  `SKIP_SPAN_PROBE=true` (prints a loud warning; the deploy is then NOT
  telemetry-verified — re-verify as soon as possible).
- **`../evaluations/canary-eval-spans.sh` (E2E canary):** one synthetic
  invocation under a known `runtimeSessionId`, then a blocking check (≤5 min)
  that an `invoke_agent` span carrying that `session.id` landed, plus an
  advisory check (≤30 min, warn-only) that the online-eval results log group
  scored the session (non-null `gen_ai.evaluation.score.value`). Run it
  standalone (`./canary-eval-spans.sh [agent_id]`) or from `verify-fleet.sh`
  with `RUN_EVAL_CANARY=true`.

**AC2.3 (direct_code_deploy auto-instrumentation verification):** the RESULT
for this acceptance criterion is produced by these gates at Stage-1 rollout —
the span probe failing the deploy is the enforcement mechanism, and the
observed outcome (which provider won, spans delivered or not) is to be
recorded on the rollout PR when Stage-1 runs.

### 1. Startup probe — which TracerProvider won?

`_init_telemetry()` in `main.py` logs exactly one `[telemetry]` line at module
import. Read it from the runtime's log group:

```bash
AGENT_ID=<agent_id>   # e.g. agentcore_hub_backend_dev-XXXXXXXXXX
aws logs filter-log-events \
  --log-group-name "/aws/bedrock-agentcore/runtimes/${AGENT_ID}-DEFAULT" \
  --filter-pattern '"[telemetry]"' \
  --max-items 20
```

Interpret:

| Log line | Meaning | Action |
|----------|---------|--------|
| `existing global TracerProvider: opentelemetry.sdk.trace.TracerProvider` (or an ADOT provider class) | Auto-instrumentation applied — the platform/ADOT registered the SDK before `main.py` loaded. **This is the healthy path.** | Continue to probe 2 |
| `auto-instrumentation absent — StrandsTelemetry OTLP fallback active (was ...ProxyTracerProvider, now TracerProvider)` | No auto-instrumentation; `main.py` registered its own OTLP exporter. Spans *may* still ship, but only if `OTEL_EXPORTER_OTLP_*` resolves. | Continue to probe 2; if it fails, escalate (§3) |
| `no TracerProvider and AGENT_OBSERVABILITY_ENABLED != true — spans will NOT be exported` | The observability env vars were not applied to this runtime. | Re-deploy — `AGENT_OBSERVABILITY_ENABLED=true` is missing (check `deploy-one.sh` / `deploy-one-robust.py` ran the current version) |
| *no `[telemetry]` line at all* | Runtime is serving stale code. | Re-deploy and confirm the runtime status went through UPDATE |

### 2. Span probe — did an `invoke_agent` span land?

Invoke one agent (any real task, or `verify-fleet-invoke.py` against a single
ARN), wait ~1 min for export, then:

```bash
aws logs filter-log-events \
  --log-group-name "/aws/bedrock-agentcore/runtimes/${AGENT_ID}-DEFAULT" \
  --log-stream-name-prefix spans \
  --filter-pattern '"invoke_agent"'
```

Confirm in the returned span JSON:

- `gen_ai.operation.name` = `invoke_agent`
- `gen_ai.agent.name` = the persona's `agent_id` (comes from `Agent(name=agent_id)`)
- `session.id` present (the runtime session id)
- `gen_ai.user.message` and `gen_ai.choice` events present on the span
- `agent.id` / `workflow.id` attributes present (from `trace_attributes`)

Repeat once for a **detached** invocation — a payload with `{"detach": true}`,
which is how the orchestrator dispatches workflow persona runs. Detached runs
return to the caller immediately and finish on a background asyncio task, so
they're the case most likely to lose spans if the provider is never flushed.
An `invoke_agent` span must appear for the detached run too.

### 3. Escalation — fallback active and no spans delivered

If probe 1 reports the StrandsTelemetry fallback **and** probe 2 finds no
`invoke_agent` span, stop trying to fix the CodeZip path: `direct_code_deploy`
runtimes have no `opentelemetry-instrument` wrapper, so span delivery depends
entirely on platform ADOT injection. Move the eval fleet to the container path,
which runs `opentelemetry-instrument` explicitly via the Dockerfile `CMD`:

```bash
export DEPLOY_MODE=robust      # build-and-push.sh + deploy-one-robust.py
./deploy-fleet.sh              # or ./deploy-one.sh <agent_name> for a single agent
```

Then re-run probes 1 and 2 — probe 1 should now report an existing SDK/ADOT
`TracerProvider` rather than the fallback.

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
| `AGENT_OBSERVABILITY_ENABLED` | `true` | Platform ADOT injection + gates main.py's StrandsTelemetry fallback |
| `OTEL_PYTHON_DISTRO` | `aws_distro` | Use the AWS OTel distro |
| `OTEL_PYTHON_CONFIGURATOR` | `aws_configurator` | AWS OTel configurator |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | OTLP wire protocol |
| `OTEL_TRACES_EXPORTER` | `otlp` | Export traces over OTLP |
| `UNIFIED_TRACES_DESTINATION_ENABLED` | `true` | Deliver spans to the unified telemetry destination (`spans` log streams) |
| `OTEL_SERVICE_NAME` | *(agent name)* | Service name on every emitted span |

> Runtime-hosted agents get their OTLP endpoint, auth headers and resource
> attributes from the platform. Do **not** set
> `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, `OTEL_EXPORTER_OTLP_LOGS_HEADERS` or
> `OTEL_RESOURCE_ATTRIBUTES`, and **never** set `DISABLE_ADOT_OBSERVABILITY`.

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
