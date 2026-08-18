#!/usr/bin/env python3
"""List the fleet's agents + workflow defs so the builder can compose a routine
from what already exists.

Usage: python3 list_fleet_agents.py

Reads (from S3 — the live config the orchestrator uses):
  - s3://$ARTIFACT_BUCKET/config/agents.json
  - s3://$ARTIFACT_BUCKET/config/workflows.json

Prints a compact JSON summary: each agent's id, phase, workflowDefId, and whether
it is deployed (has a runtime). Composing a routine from agents that are already
deployed needs NO new runtime; a brand-new persona does (see write_blueprint.py).
"""

import json
import os
import sys

import boto3

REGION = os.environ.get("AWS_REGION", "us-east-1")
ARTIFACT_BUCKET = os.environ["ARTIFACT_BUCKET"]

s3 = boto3.client("s3", region_name=REGION)


def read_json(key, default):
    try:
        body = s3.get_object(Bucket=ARTIFACT_BUCKET, Key=key)["Body"].read()
        return json.loads(body)
    except s3.exceptions.NoSuchKey:
        return default
    except Exception as e:
        print(f"WARN: could not read {key}: {e}", file=sys.stderr)
        return default


def main():
    agents_cfg = read_json("config/agents.json", {"agents": []})
    workflows_cfg = read_json("config/workflows.json", {"workflows": []})

    agents = []
    for a in agents_cfg.get("agents", []):
        # runtimeArn is intentionally null in the repo copy; the orchestrator wires
        # ARNs via env. "deployed" here means the roster declares one — treat a null
        # as "needs a runtime deploy before an agent phase can invoke it".
        agents.append({
            "agentId": a.get("agentId"),
            "displayName": a.get("displayName"),
            "phase": a.get("phase"),
            "workflowDefId": a.get("workflowDefId", "software-delivery"),
            "hasRuntime": bool(a.get("runtimeArn")),
        })

    workflows = [{
        "id": w.get("id"),
        "name": w.get("name"),
        "intakeAgentId": w.get("intakeAgentId"),
        "requiresRepo": w.get("requiresRepo", False),
        "phases": [{"id": p.get("id"), "name": p.get("name"), "agentPhase": p.get("agentPhase")} for p in w.get("phases", [])],
    } for w in workflows_cfg.get("workflows", [])]

    print(json.dumps({"agents": agents, "workflows": workflows}, indent=2))


if __name__ == "__main__":
    main()
