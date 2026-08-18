#!/usr/bin/env python3
"""Create/update a prompt-only persona blueprint and register it in the roster.

Usage:
  python3 write_blueprint.py <agentId> <phase> <workflowDefId> \
      --blueprint-file /mnt/workspace/<name>.md \
      --display-name "Ad Performance Analyst" \
      [--description "..."] [--tools tool1,tool2]

Writes:
  - s3://$ARTIFACT_BUCKET/blueprints/<agentId>.md   (the process instructions the
    agent loads via load_blueprint at runtime — hot, no redeploy)
  - appends/replaces the agent's entry in s3://$ARTIFACT_BUCKET/config/agents.json

IMPORTANT — a persona blueprint changes HOW an agent behaves, but an agent phase
can only be INVOKED once a runtime exists for that agentId. Reusing an already
deployed agent (compose an existing one) needs nothing further. A brand-new
agentId prints a NEEDS_RUNTIME notice: a human must run
`cd deploy/runtime-agent && ./deploy-one.sh <agentId>` (with a prompt file) before
that phase can run. Prefer composing existing agents whenever possible.
"""

import argparse
import json
import os
import sys

import boto3

REGION = os.environ.get("AWS_REGION", "us-east-1")
ARTIFACT_BUCKET = os.environ["ARTIFACT_BUCKET"]
DEFAULT_MODEL = os.environ.get("MODEL_ID", "Claude Opus 4.6")

s3 = boto3.client("s3", region_name=REGION)

# A sane default toolset for a prompt-only persona — the same durable tools the
# marketing/analysis personas use. Callers can override with --tools.
DEFAULT_TOOLS = [
    "S3Storage___list_objects", "S3Storage___read_object", "S3Storage___write_object",
    "Tickets___add_comment", "Tickets___create_ticket", "Tickets___list_tickets",
    "Tickets___search_issues", "Tickets___transition_ticket", "Tickets___update_ticket",
    "WorkflowOutput___report_completion", "WorkflowOutput___save_design_doc",
    "WorkflowOutput___submit_ticket_plan", "browser", "calculator", "claude_code",
    "code_interpreter", "current_time", "http_request", "image_reader",
    "load_blueprint", "python_repl", "retrieve",
]


def read_agents():
    try:
        body = s3.get_object(Bucket=ARTIFACT_BUCKET, Key="config/agents.json")["Body"].read()
        return json.loads(body)
    except s3.exceptions.NoSuchKey:
        return {"agents": []}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("agent_id")
    p.add_argument("phase")
    p.add_argument("workflow_def_id")
    p.add_argument("--blueprint-file", required=True)
    p.add_argument("--display-name", required=True)
    p.add_argument("--description", default="")
    p.add_argument("--tools", default="")
    args = p.parse_args()

    with open(args.blueprint_file) as f:
        blueprint = f.read()
    if len(blueprint.strip()) < 40:
        raise SystemExit("VALIDATION FAILED: blueprint content looks empty/too short")

    # 1) Blueprint → S3 (hot; load_blueprint reads it at runtime)
    s3.put_object(
        Bucket=ARTIFACT_BUCKET,
        Key=f"blueprints/{args.agent_id}.md",
        Body=blueprint.encode(),
        ContentType="text/markdown",
    )

    # 2) Roster entry → config/agents.json (replace if exists)
    tools = [t.strip() for t in args.tools.split(",") if t.strip()] or DEFAULT_TOOLS
    entry = {
        "agentId": args.agent_id,
        "displayName": args.display_name,
        "description": args.description or f"{args.display_name} (routine persona)",
        "phase": args.phase,
        "workflowDefId": args.workflow_def_id,
        "type": "runtime",
        "model": DEFAULT_MODEL,
        "evaluationsEnabled": False,
        "runtimeArn": None,  # NEVER write a real ARN into the roster (repo is public)
        "tools": tools,
    }

    cfg = read_agents()
    agents = [a for a in cfg.get("agents", []) if a.get("agentId") != args.agent_id]
    existed = len(agents) != len(cfg.get("agents", []))
    agents.append(entry)
    cfg["agents"] = agents
    s3.put_object(
        Bucket=ARTIFACT_BUCKET,
        Key="config/agents.json",
        Body=json.dumps(cfg, indent=2).encode(),
        ContentType="application/json",
    )

    print(json.dumps({
        "wrote_blueprint": f"s3://{ARTIFACT_BUCKET}/blueprints/{args.agent_id}.md",
        "roster_entry": "replaced" if existed else "added",
        "needs_runtime": not existed,
        "notice": (
            "NEEDS_RUNTIME: this is a brand-new agentId. Before its phase can run, a "
            f"human must deploy a runtime: cd deploy/runtime-agent && ./deploy-one.sh {args.agent_id} "
            "(with a matching prompts/<agentId>.txt). Reusing an existing agent avoids this."
        ) if not existed else "Reused existing agent — no runtime deploy needed.",
    }, indent=2))


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        print(str(e), file=sys.stderr)
        raise
