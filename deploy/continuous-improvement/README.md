# Continuous Improvement Pipeline

This directory contains deployment scripts for the **eval-packager** continuous improvement pipeline.

## Architecture Overview

```
CloudWatch Logs → eval-packager Lambda → DynamoDB buffer
   → (on flush) archive raw batch to batches/
   → invoke Fleet Improver runtime → synthesized PRD to prd/
   → prd-submitter (S3→EventBridge) → workflow API → fix PR
```

### Pipeline Stages

1. **CW Logs Ingestion**: Bedrock AgentCore evaluation harnesses emit results to CloudWatch Logs groups following the pattern:
   ```
   /aws/bedrock-agentcore/evaluations/results/eval_<short_id>
   ```
   where `<short_id>` is the agent's `agentId` with the `agentcore_hub_` prefix stripped.

2. **Eval Packager Lambda** (`lambda/eval-packager/index.mjs`):
   - Triggered by CW Logs subscription filters
   - Resolves agent identity from the log group harness name
   - Parses evaluator results (scores, evidence, evaluator name) from log event messages
   - Applies per-agent controls (enabled flag, sample rate)
   - Atomically appends enriched session data to a DynamoDB buffer
   - **On flush, invokes the Fleet Improver runtime to synthesize a PRD** (see stage 5)

3. **DynamoDB Buffer** (`agentcore-hub-eval-config` table):
   - Keyed by canonical `agentId` (e.g., `agentcore_hub_frontend_dev`)
   - Accumulates sessions in `sessionBuffer` list attribute
   - Flushes when buffer reaches configured `batchSize`

4. **S3 Batch Archive** (`fleet-imp-agent/batches/`):
   - The raw flushed batch (`{agentId, batchSize, flushedAt, sessions[]}`)
   - Named: `batch-<agentId>-<timestamp>.json`
   - **Distinct from the `prd/` prefix** — raw batches must NOT trigger prd-submitter

5. **Fleet Improver synthesis** (in `flushBuffer`, env `IMPROVEMENT_AGENT_ARN`):
   - eval-packager SigV4-invokes the Fleet Improver runtime with the batch
   - The runtime returns a markdown PRD (first line is a `TITLE:` contract line)
   - `parsePrd` splits it into `{ title, description }`
   - The PRD is written to `fleet-imp-agent/prd/prd-<agentId>-<timestamp>.json`
   - That `prd/` write is what triggers prd-submitter → workflow → PR
   - If the improver ARN is unset or the call fails, the batch is still archived
     (stage 4) and the buffer resets — the flush never wedges, it just skips the
     workflow trigger and logs a warning

## Agent ID Resolution

The packager Lambda resolves agent identity dynamically from `config/agents.json` stored in the artifacts S3 bucket:

1. On cold start, loads `s3://<ARTIFACTS_BUCKET>/config/agents.json`
2. Builds an `agentId` lookup set (cached for warm starts)
3. Extracts agent identifier from the CW Logs log group (substring after `eval_`)
4. Resolves to canonical agent ID by prefixing with `agentcore_hub_` (e.g., `frontend_dev` → `agentcore_hub_frontend_dev`)

This replaces the previously hardcoded `CONFIG_TO_AGENT` map, ensuring the packager stays in sync with the canonical agent registry.

### Agents Config Source of Truth

The file `src/config/agents.json` defines all agents with their:
- `agentId`: Canonical agent identifier (snake_case, e.g., `agentcore_hub_frontend_dev`). The runtime resource name is the same string.

## Enriched Batch Payloads

Each session in the S3 batch `sessions[]` array contains **parsed evaluator results**, not raw CW Logs event envelopes:

```json
{
  "agentId": "agentcore_hub_frontend_dev",
  "batchSize": 10,
  "flushedAt": "2025-01-15T10:30:00.000Z",
  "sessions": [
    {
      "logGroup": "/aws/bedrock-agentcore/evaluations/results/eval_frontend_dev",
      "logStream": "stream-id",
      "timestamp": "2025-01-15T10:29:55.000Z",
      "evaluatorResults": [
        {
          "timestamp": 1705312195000,
          "evaluatorName": "code-quality",
          "score": 0.85,
          "evidence": "Clean component structure, proper prop typing",
          "metadata": { "category": "maintainability" },
          "result": "pass"
        }
      ]
    }
  ]
}
```

This structure (archived under `batches/`) is what eval-packager sends to the
Fleet Improver runtime. The improver returns a markdown PRD, which `parsePrd`
turns into the object written to `prd/`:

```json
{
  "title": "fix(agentcore_hub_frontend_dev): <top fix summary>",
  "description": "<full markdown PRD>",
  "agentId": "agentcore_hub_frontend_dev",
  "generatedAt": "2026-06-14T20:41:16.474Z",
  "sources": ["s3://<bucket>/fleet-imp-agent/batches/batch-...json"]
}
```

prd-submitter reads `title` + `description` from this object — which is why a
raw batch (no `title`/`description`) reaching `prd/` produced `[SI] undefined`
before this synthesis step existed.

## Deployment

### Prerequisites

- AWS CLI configured with appropriate credentials
- `jq` installed
- Access to the target AWS account

### Running

```bash
# Deploy with default region (us-east-1)
./deploy-all.sh

# Deploy to a specific region
./deploy-all.sh --region us-west-2
```

### What it does

1. **Creates DynamoDB table** (`agentcore-hub-eval-config`) with on-demand billing if it doesn't exist
2. **Seeds 14 agent rows** from `src/config/agents.json` with default eval configuration:
   - `enabled: true`
   - `sampleRate: 100` (100%)
   - `batchSize: 10`
   - Empty `sessionBuffer`

The seed is idempotent — existing rows are not overwritten (`attribute_not_exists(agentId)` condition).

### DDB Rows Created

| agentId | Source |
|---------|--------|
| agentcore_hub_requirements_analyst | agents.json |
| agentcore_hub_ios_designer | agents.json |
| agentcore_hub_backend_designer | agents.json |
| agentcore_hub_frontend_designer | agents.json |
| agentcore_hub_android_designer | agents.json |
| agentcore_hub_security_reviewer | agents.json |
| agentcore_hub_legal_compliance | agents.json |
| agentcore_hub_localization | agents.json |
| agentcore_hub_analytics_designer | agents.json |
| agentcore_hub_backend_dev | agents.json |
| agentcore_hub_api_dev | agents.json |
| agentcore_hub_frontend_dev | agents.json |
| agentcore_hub_qa_verifier | agents.json |
| agentcore_hub_ci_agent | agents.json |

## Troubleshooting

- **"Agents config file not found"**: Ensure you're running from the repo root or that the path `src/config/agents.json` is accessible relative to the script.
- **Agent not resolving**: Verify the agent's `agentId` in `src/config/agents.json` matches the CW Logs group suffix (after stripping the `agentcore_hub_` prefix).
- **Stale agent map**: The Lambda caches `agents.json` for warm starts. A cold start (redeploy or timeout) will reload it.
