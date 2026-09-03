#!/usr/bin/env python3
"""Validate and persist a workflow analysis. The ONLY write path for analyses —
the Workflow Manager cannot malform the DDB row because validation happens here.

Usage:
  python3 save_analysis.py <workflowId> [--workspace DIR] [--trigger auto|manual|watch]

Reads {workspace}/analysis.json (the LLM-authored fields), {workspace}/metrics.json,
{workspace}/dossier.json. Writes:
  - DDB ANALYSES_TABLE item {workflowId, analysisId, ...}
  - s3://$ARTIFACT_BUCKET/workflows/{wfId}/analysis/{analysisId}/{analysis,metrics,dossier}.json
"""

import argparse
import json
import os
import random
import string
import sys
import time
from datetime import datetime, timezone
from decimal import Decimal

import boto3

REGION = os.environ.get("AWS_REGION", "us-east-1")
ARTIFACT_BUCKET = os.environ["ARTIFACT_BUCKET"]
ANALYSES_TABLE = os.environ.get("ANALYSES_TABLE", "agentcore-hub-workflow-analyses")
MODEL_ID = os.environ.get("MODEL_ID", "us.anthropic.claude-opus-5")

SCHEMA_VERSION = 1
FINDING_KINDS = {"bottleneck", "failure", "success", "risk"}
SEVERITIES = {"critical", "high", "medium", "low"}
PRIORITIES = {"P0", "P1", "P2"}
REC_TYPES = {"workflow-def", "prompt", "gate-config", "process", "tooling"}
SCORE_KEYS = {"overall", "planning", "execution", "reviewEfficiency", "reworkDiscipline"}
# TEAM-3747 D2 — includes the lifecycle-integrity terminal outcomes so a run
# closed as deploy-blocked / static-ci-only is recorded HONESTLY (mapping the
# phase straight through below) instead of masquerading as "complete". PARITY:
# src/lib/workflow/types.ts SHIP_BLOCKED_OUTCOMES + analysis-types.ts RunOutcome.
RUN_OUTCOMES = {"complete", "cancelled", "error", "deploy-blocked", "static-ci-only"}


def fail(msg):
    raise SystemExit(f"VALIDATION FAILED: {msg}")


def validate(analysis):
    scores = analysis.get("scores")
    if not isinstance(scores, dict) or set(scores) != SCORE_KEYS:
        fail(f"scores must have exactly keys {sorted(SCORE_KEYS)}")
    for k, v in scores.items():
        if not isinstance(v, (int, float)) or not 0 <= v <= 100:
            fail(f"scores.{k} must be a number 0-100")
    if not isinstance(analysis.get("verdict"), str) or not analysis["verdict"].strip():
        fail("verdict must be a non-empty string")
    findings = analysis.get("findings")
    if not isinstance(findings, list) or not findings:
        fail("findings must be a non-empty list")
    for i, f in enumerate(findings):
        if f.get("kind") not in FINDING_KINDS:
            fail(f"findings[{i}].kind must be one of {sorted(FINDING_KINDS)}")
        if f.get("severity") not in SEVERITIES:
            fail(f"findings[{i}].severity must be one of {sorted(SEVERITIES)}")
        for key in ("title", "evidence"):
            if not isinstance(f.get(key), str) or not f[key].strip():
                fail(f"findings[{i}].{key} must be a non-empty string")
    if not any(f["kind"] == "success" for f in findings):
        fail('findings must include at least one kind:"success" (what worked)')
    recs = analysis.get("recommendations")
    if not isinstance(recs, list):
        fail("recommendations must be a list")
    for i, r in enumerate(recs):
        if r.get("priority") not in PRIORITIES:
            fail(f"recommendations[{i}].priority must be one of {sorted(PRIORITIES)}")
        if r.get("type") not in REC_TYPES:
            fail(f"recommendations[{i}].type must be one of {sorted(REC_TYPES)}")
        for key in ("title", "description", "expectedImpact"):
            if not isinstance(r.get(key), str) or not r[key].strip():
                fail(f"recommendations[{i}].{key} must be a non-empty string")
    trend = analysis.get("trend")
    if not isinstance(trend, dict) or "priorRunsCompared" not in trend:
        fail("trend must be an object with priorRunsCompared")
    if not isinstance(analysis.get("summaryMarkdown"), str) or len(analysis["summaryMarkdown"]) < 200:
        fail("summaryMarkdown must be a markdown report (>=200 chars)")


def to_ddb(obj):
    if isinstance(obj, float):
        return Decimal(str(obj))
    if isinstance(obj, dict):
        return {k: to_ddb(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [to_ddb(v) for v in obj]
    return obj


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("workflow_id")
    parser.add_argument("--workspace", default=None)
    parser.add_argument("--trigger", default="auto", choices=["auto", "manual", "watch"])
    args = parser.parse_args()
    workspace = args.workspace or f"/mnt/workspace/{args.workflow_id}"

    with open(os.path.join(workspace, "analysis.json")) as f:
        analysis = json.load(f)
    with open(os.path.join(workspace, "metrics.json")) as f:
        metrics = json.load(f)
    with open(os.path.join(workspace, "dossier.json")) as f:
        dossier = json.load(f)

    validate(analysis)

    workflow = dossier.get("workflow") or {}
    phase = workflow.get("phase", "complete")
    run_outcome = phase if phase in RUN_OUTCOMES else "complete"
    analysis_id = f"{int(time.time() * 1000)}-{''.join(random.choices(string.ascii_lowercase + string.digits, k=4))}"
    s3_prefix = f"workflows/{args.workflow_id}/analysis/{analysis_id}/"

    item = {
        "workflowId": args.workflow_id,
        "analysisId": analysis_id,
        "schemaVersion": SCHEMA_VERSION,
        "workflowDefId": dossier.get("workflowDefId") or "software-delivery",
        "epicId": dossier.get("epicId"),
        "analyzedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "trigger": args.trigger,
        "runOutcome": run_outcome,
        "model": MODEL_ID,
        "s3Prefix": s3_prefix,
        "metrics": metrics,
        "scores": analysis["scores"],
        "verdict": analysis["verdict"],
        "findings": analysis["findings"],
        "recommendations": analysis["recommendations"],
        "trend": analysis["trend"],
        "summaryMarkdown": analysis["summaryMarkdown"],
    }

    s3 = boto3.client("s3", region_name=REGION)
    for name, payload in (
        ("analysis.json", item),
        ("metrics.json", metrics),
        ("dossier.json", dossier),
    ):
        s3.put_object(
            Bucket=ARTIFACT_BUCKET,
            Key=s3_prefix + name,
            Body=json.dumps(payload, indent=1, default=str).encode(),
            ContentType="application/json",
        )

    boto3.resource("dynamodb", region_name=REGION).Table(ANALYSES_TABLE).put_item(
        Item=to_ddb(item)
    )
    print(json.dumps({
        "saved": True,
        "workflowId": args.workflow_id,
        "analysisId": analysis_id,
        "s3Prefix": f"s3://{ARTIFACT_BUCKET}/{s3_prefix}",
    }, indent=2))


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        print(str(e), file=sys.stderr)
        raise
