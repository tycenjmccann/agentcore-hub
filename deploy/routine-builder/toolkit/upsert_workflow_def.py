#!/usr/bin/env python3
"""Add or replace a workflow definition in the live config the orchestrator reads.

Usage:
  python3 upsert_workflow_def.py --def-file /mnt/workspace/<id>.json

The def file is a single workflow-def object matching the schema in
config/workflows.json:
  {
    "id": "routine-weekly-ad-report",
    "name": "Weekly Ad Report",
    "description": "...",
    "icon": "CalendarClock",
    "intakeAgentId": "<an agentId whose phase == first agent phase>",
    "requiresRepo": false,
    "featureBranchPhase": null,
    "createsPullRequest": false,
    "completionRequiresAgentPhases": ["analysis", "planning"],
    "phases": [
      {"id": "intake", "name": "Intake", "type": "app", "agentPhase": "intake"},
      {"id": "analysis", "name": "Analysis", "type": "agent", "agentPhase": "analysis"},
      ...
    ]
  }

Writes s3://$ARTIFACT_BUCKET/config/workflows.json (replacing any def with the same
id). The orchestrator reloads config on its next cold start — no redeploy.

VALIDATION: the def must have a unique-ish id, a phases list beginning with an
`app` intake phase, and every agentPhase referenced must have at least one agent
in config/agents.json tagged to this workflowDefId. This fails loudly rather than
writing a def that would strand a phase with no agent.
"""

import argparse
import json
import os
import sys

import boto3

REGION = os.environ.get("AWS_REGION", "us-east-1")
ARTIFACT_BUCKET = os.environ["ARTIFACT_BUCKET"]

s3 = boto3.client("s3", region_name=REGION)


def read_json(key, default):
    try:
        return json.loads(s3.get_object(Bucket=ARTIFACT_BUCKET, Key=key)["Body"].read())
    except s3.exceptions.NoSuchKey:
        return default


def fail(msg):
    raise SystemExit(f"VALIDATION FAILED: {msg}")


def normalize(defn):
    """Fill in phase.type so the board renders agents correctly.

    The board keys agent rendering off phase.type == "agent" (see
    PipelineVisualization / WorkflowBoard). A phase with no explicit type would
    render as a bare box with no agents. Convention: the first phase is the app
    intake; every later phase is an agent phase unless told otherwise.
    """
    for i, ph in enumerate(defn.get("phases", [])):
        if ph.get("type"):
            continue
        ph["type"] = "app" if i == 0 else "agent"


def validate(defn, agents):
    for key in ("id", "name", "intakeAgentId", "phases"):
        if not defn.get(key):
            fail(f"workflow def missing required field: {key}")
    phases = defn["phases"]
    if not isinstance(phases, list) or not phases:
        fail("phases must be a non-empty list")
    if phases[0].get("type") != "app":
        fail("the first phase must be type 'app' (intake)")

    def_id = defn["id"]
    # Every agent phase must be covered by at least one agent tagged to this def.
    agent_phases = {
        a.get("phase")
        for a in agents
        if a.get("workflowDefId", "software-delivery") == def_id
    }
    for ph in phases:
        if ph.get("type") == "agent":
            if ph.get("agentPhase") not in agent_phases:
                fail(
                    f"phase '{ph.get('id')}' (agentPhase='{ph.get('agentPhase')}') has no agent "
                    f"tagged workflowDefId='{def_id}' in config/agents.json. Add/compose an agent "
                    "for it first (write_blueprint.py), then re-run."
                )
    # intakeAgentId must exist and belong to this def.
    intake = next((a for a in agents if a.get("agentId") == defn["intakeAgentId"]), None)
    if not intake:
        fail(f"intakeAgentId '{defn['intakeAgentId']}' not found in config/agents.json")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--def-file", required=True)
    args = p.parse_args()

    with open(args.def_file) as f:
        defn = json.load(f)

    normalize(defn)
    agents_cfg = read_json("config/agents.json", {"agents": []})
    validate(defn, agents_cfg.get("agents", []))

    cfg = read_json("config/workflows.json", {"defaultWorkflowDefId": "software-delivery", "workflows": []})
    workflows = [w for w in cfg.get("workflows", []) if w.get("id") != defn["id"]]
    existed = len(workflows) != len(cfg.get("workflows", []))
    workflows.append(defn)
    cfg["workflows"] = workflows
    s3.put_object(
        Bucket=ARTIFACT_BUCKET,
        Key="config/workflows.json",
        Body=json.dumps(cfg, indent=2).encode(),
        ContentType="application/json",
    )

    print(json.dumps({
        "workflowDefId": defn["id"],
        "action": "replaced" if existed else "added",
        "phases": [ph.get("id") for ph in defn["phases"]],
        "note": "Orchestrator picks this up on its next cold start (config is loaded from S3).",
    }, indent=2))


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        print(str(e), file=sys.stderr)
        raise
