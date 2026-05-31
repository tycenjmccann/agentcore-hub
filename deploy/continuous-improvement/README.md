# Continuous Improvement Pipeline

This directory contains deployment scripts for the **eval-packager** continuous improvement pipeline.

## Architecture Overview

```
CloudWatch Logs → eval-packager Lambda → DynamoDB buffer → S3 batch → improver agent
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

3. **DynamoDB Buffer** (`agentcore-hub-eval-config` table):
   - Keyed by canonical `agentId` (e.g., `agentcore_hub_frontend_dev`)
   - Accumulates sessions in `sessionBuffer` list attribute
   - Flushes when buffer reaches configured `batchSize`

4. **S3 Batch Output** (`fleet-imp-agent/prd/`):
   - JSON files containing enriched evaluator results
   - Each batch includes `sessions[]` with parsed evaluator scores, evidence, and metadata
   - Named: `batch-<agentId>-<timestamp>.json`

5. **Improver Agent**:
   - Consumes S3 batch files
   - Synthesizes actionable improvement recommendations from evaluator scores and evidence

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

This structure enables the improver agent to directly synthesize insights without re-parsing raw log data.

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
