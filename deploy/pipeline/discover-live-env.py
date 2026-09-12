#!/usr/bin/env python3
"""Derive the pipeline stack's optional deploy inputs from the LIVE stack.

deploy.sh evals this script's output before `cdk deploy`. Every optional input
the stack reads from the shell (PIPELINE_CONNECTION_ARN, ECS_SERVICE_ARN,
PIPELINE_CI_WEBHOOK, PIPELINE_APPROVAL_SNS_ARN) is a re-deploy hazard: a shell
that lacks it silently tells CDK "mint a new one" / "turn it off", and the
stack faithfully does so. A missing PIPELINE_CONNECTION_ARN would swap the
Source action onto a fresh PENDING CodeConnections link (pipeline dead until a
human redoes the GitHub handshake); a missing ECS_SERVICE_ARN drops the app
roll. NEXT_PUBLIC_PIPELINE_ENABLED went this way on 2026-09-09 (the /pipeline
tab vanished for three days) before it was hardcoded.

Rule: a value already in the environment wins. Otherwise, if the live stack
IMPORTS the resource (no stack-owned logical resource of that kind) the live
value is exported so the redeploy keeps importing it. A stack-OWNED resource is
never exported as an import — that would drop the resource from the template
while still referencing it. First deploy (no stack) exports nothing.

Only emits `export KEY='value'` lines (shell-quoted) on stdout; diagnostics go
to stderr. Pure logic lives in derive(); the AWS reads live in main().
"""
import json
import os
import shlex
import subprocess
import sys

STACK_NAME = "AgentcoreHubPipeline"
CONNECTION_TYPE = "AWS::CodeConnections::Connection"
TOPIC_TYPE = "AWS::SNS::Topic"


def derive(*, current_env, stack_exists, resource_types, outputs, deploy_project_env, ci_webhook_present):
    """Return {KEY: value} for inputs the live stack implies and the env lacks.

    current_env         mapping of the caller's environment
    stack_exists        False on first deploy -> nothing to derive
    resource_types      set of ResourceType strings the stack OWNS
    outputs             {OutputKey: OutputValue} of the live stack
    deploy_project_env  {name: value} env of the live deploy CodeBuild project
    ci_webhook_present  True when the live CI project has a webhook
    """
    if not stack_exists:
        return {}
    out = {}

    def want(key):
        return not (current_env.get(key) or "").strip()

    conn = (outputs or {}).get("ConnectionArn") or ""
    if want("PIPELINE_CONNECTION_ARN") and conn and CONNECTION_TYPE not in resource_types:
        out["PIPELINE_CONNECTION_ARN"] = conn

    topic = (outputs or {}).get("ApprovalTopicArn") or ""
    if want("PIPELINE_APPROVAL_SNS_ARN") and topic and TOPIC_TYPE not in resource_types:
        out["PIPELINE_APPROVAL_SNS_ARN"] = topic

    ecs = (deploy_project_env or {}).get("ECS_SERVICE_ARN") or ""
    if want("ECS_SERVICE_ARN") and ecs:
        out["ECS_SERVICE_ARN"] = ecs

    if want("PIPELINE_CI_WEBHOOK") and ci_webhook_present:
        out["PIPELINE_CI_WEBHOOK"] = "1"

    return out


def _aws(args, region):
    cmd = ["aws", *args, "--region", region, "--output", "json"]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        return None
    return json.loads(res.stdout or "null")


def main(argv):
    region = None
    for i, a in enumerate(argv):
        if a == "--region" and i + 1 < len(argv):
            region = argv[i + 1]
    region = region or os.environ.get("AWS_REGION") or "us-east-1"

    stacks = _aws(["cloudformation", "describe-stacks", "--stack-name", STACK_NAME], region)
    stack = (stacks or {}).get("Stacks", [None])[0] if stacks else None
    if not stack:
        print(f"# {STACK_NAME}: no live stack in {region} - first deploy, nothing to derive", file=sys.stderr)
        return 0
    outputs = {o["OutputKey"]: o["OutputValue"] for o in stack.get("Outputs", [])}

    res = _aws(["cloudformation", "list-stack-resources", "--stack-name", STACK_NAME], region) or {}
    resource_types = {r["ResourceType"] for r in res.get("StackResourceSummaries", [])}

    projects = _aws(
        ["codebuild", "batch-get-projects", "--names", "agentcore-hub-deploy", "agentcore-hub-ci"], region
    ) or {}
    deploy_env, ci_webhook = {}, False
    for p in projects.get("projects", []):
        if p.get("name") == "agentcore-hub-deploy":
            deploy_env = {e["name"]: e.get("value", "") for e in p.get("environment", {}).get("environmentVariables", [])}
        if p.get("name") == "agentcore-hub-ci":
            ci_webhook = bool((p.get("webhook") or {}).get("url"))

    derived = derive(
        current_env=os.environ,
        stack_exists=True,
        resource_types=resource_types,
        outputs=outputs,
        deploy_project_env=deploy_env,
        ci_webhook_present=ci_webhook,
    )
    for k, v in derived.items():
        print(f"export {k}={shlex.quote(v)}")
        print(f"# derived from live stack: {k}={v}", file=sys.stderr)
    if not derived:
        print("# live stack inspected: every optional input already set (or stack-owned)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
