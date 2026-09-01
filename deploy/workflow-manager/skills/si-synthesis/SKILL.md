---
name: si-synthesis
description: SYNTHESIZE-mode playbook — batch pending run analyses into ONE system-improvement PRD under the SI banner. Separates agent-level gaps (fleet repo) from harness/system gaps (hub repo), writes the PRD to the fleet-imp-agent/prd/ prefix that prd-submitter watches, and marks the analyses as batched. Load on every SYNTHESIZE invocation.
---

# SI synthesis — run analyses → one system-improvement PRD

You are the system-level half of the SI loop. The agent SI loop batches agent
EVALS and improves agent prompts/blueprints in the fleet repo. You batch
WORKFLOW ANALYSES and improve the system the agents operate in: orchestrator,
gates, workflow defs, runtime/harness infra, intake — in the hub repo.

The trigger prompt lists pending `<workflowId>/<analysisId>` pairs. Your job:
one PRD that fixes the highest-leverage systemic gaps across the batch, not a
re-listing of every finding.

## 1. Gather

Bootstrap the toolkit (system prompt), then pull each pending analysis:

```bash
python3 - <<'EOF'
import boto3, json, os
t = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION","us-east-1")).Table(os.environ["ANALYSES_TABLE"])
pairs = [("wfId","analysisId")]  # from the trigger prompt
out = []
for wf, an in pairs:
    out.append(t.get_item(Key={"workflowId": wf, "analysisId": an}).get("Item"))
json.dump(out, open("/mnt/workspace/si-batch.json","w"), default=str)
EOF
```

Also read your knowledge files (`workflow-manager/knowledge/*.md` in S3) —
they hold the cross-run patterns you've already confirmed.

## 2. Synthesize — agents vs the system

Bucket every finding/recommendation in the batch:

- **Agent-level** (an agent's prompt/blueprint/model is weak): NOTE it in the
  PRD's "agent-level observations" appendix but do NOT make it a deliverable —
  the agent SI loop owns those. If one agent dominates the batch, say so; the
  eval loop may be missing it (crashed runs are invisible to evals).
- **System-level** (yours): orchestrator dispatch/recovery, gate placement and
  convergence, workflow-def phase design, runtime/harness infra (timeouts,
  silent deaths, artifact handoffs), intake scoping. These become the PRD.

Rank by leverage: recurrence across runs × wall-clock or rework cost, citing
analysisIds + metric values. 2-4 deliverables max — a PRD with 10 asks
produces a run that converges on none.

## 3. Write the PRD (chunked — same rule as run-analysis)

Build `/mnt/workspace/si-prd.json` in SMALL tool calls (≤60 lines each;
assemble with python if long). Exact shape prd-submitter expects:

```json
{
  "title": "system: <one-line theme of the batch>",
  "description": "markdown: evidence-cited gaps + 2-4 concrete deliverables with acceptance criteria",
  "repoUrl": "<hub repo URL — from the trigger prompt>",
  "sources": [{"type": "s3", "value": "s3://<bucket>/<analysis s3 key>", "label": "analysis <id>"}],
  "batch": {"analysisIds": ["<wfId>/<analysisId>", "..."], "generatedAt": "<iso>"}
}
```

`repoUrl` is what routes this run to the HUB repo instead of the fleet repo —
never omit it. prd-submitter prefixes the title with `[SI]` itself.

## 4. Publish + mark batched

```bash
aws s3 cp /mnt/workspace/si-prd.json \
  "s3://$ARTIFACT_BUCKET/fleet-imp-agent/prd/system-$(date +%Y%m%dT%H%M%S).json"
```

The upload IS the submission (S3 → EventBridge → prd-submitter → workflow).
Then mark every batched analysis so the next cycle doesn't re-count it:

```bash
python3 - <<'EOF'
import boto3, os, datetime
t = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION","us-east-1")).Table(os.environ["ANALYSES_TABLE"])
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
for wf, an in pairs:  # same pairs as step 1
    t.update_item(Key={"workflowId": wf, "analysisId": an},
                  UpdateExpression="SET siBatchedAt = :t",
                  ExpressionAttributeValues={":t": now})
EOF
```

Mark rows even if you excluded their findings from the PRD — batched means
"considered", not "shipped". If the PRD upload fails, do NOT mark anything.

## 5. Report

Reply with: batch size, the PRD title, the 2-4 deliverables (one line each),
and what you left to the agent SI loop.
