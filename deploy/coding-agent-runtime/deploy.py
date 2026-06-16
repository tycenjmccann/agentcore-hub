#!/usr/bin/env python3
"""
deploy.py — Deploy the multi-CLI coding-agent runtime to AgentCore.

Creates (or updates) a single runtime named "agentcore-hub-coding-runtime" with
PERSISTENT session storage mounted at /mnt/workspace, hosting Claude Code and
Codex. The Strands fleet agents invoke this runtime via the commands API for all
coding work.

Why the control API (not `agentcore configure`): only CreateAgentRuntime /
UpdateAgentRuntime can express `filesystemConfigurations` (session storage),
which is what makes /mnt/workspace persist per session. The starter-toolkit
CLI cannot.

Everything is env/STS-derived — no hardcoded account, role, or image.
Required env (defaults from deploy/config.sh):
  IMAGE_URI                  ECR image (from build-and-push.sh)
  CODING_RUNTIME_ROLE_ARN    execution role (from setup-coding-runtime-role.sh)
  AWS_REGION                 default us-east-1
  BEDROCK_MANTLE_REGION      default us-east-2 (Codex GPT-5.5)
  EVENTS_TABLE               default agentcore-hub-events

Usage:
  source deploy/config.sh
  export IMAGE_URI=...        # from build-and-push.sh
  python deploy/coding-agent-runtime/deploy.py
"""
from __future__ import annotations

import json
import os
import sys
import time

import boto3
from botocore.exceptions import ClientError

# AgentCore runtime names must match [a-zA-Z][a-zA-Z0-9_]{0,47} — no hyphens.
RUNTIME_NAME = "agentcore_hub_coding_runtime"
WORKSPACE_MOUNT = "/mnt/workspace"


def fail(reason: str) -> None:
    print(f"FAIL {RUNTIME_NAME} ({reason})", file=sys.stderr)
    sys.exit(1)


def resolve_account_id(region: str) -> str:
    return os.environ.get("ACCOUNT_ID") or boto3.client(
        "sts", region_name=region
    ).get_caller_identity()["Account"]


def find_runtime(control, name: str) -> str | None:
    paginator = control.get_paginator("list_agent_runtimes")
    for page in paginator.paginate():
        for rt in page.get("agentRuntimes", []):
            if rt.get("agentRuntimeName") == name:
                return rt["agentRuntimeId"]
    return None


def wait_until_ready(control, runtime_id: str, timeout_s: int = 600) -> None:
    start = time.time()
    status = "UNKNOWN"
    while time.time() - start < timeout_s:
        rt = control.get_agent_runtime(agentRuntimeId=runtime_id)
        status = rt.get("status")
        if status == "READY":
            return
        if status in ("CREATE_FAILED", "UPDATE_FAILED", "DELETE_FAILED"):
            fail(f"runtime status={status}: {rt.get('failureReason', 'no reason')}")
        time.sleep(5)
    fail(f"timed out waiting for READY (last status={status})")


def main() -> None:
    region = os.environ.get("AWS_REGION", "us-east-1")
    image_uri = os.environ.get("IMAGE_URI")
    role_arn = os.environ.get("CODING_RUNTIME_ROLE_ARN")

    if not image_uri:
        fail("IMAGE_URI is required (run build-and-push.sh first)")
    if not role_arn:
        fail("CODING_RUNTIME_ROLE_ARN is required (run setup-coding-runtime-role.sh first)")

    account_id = resolve_account_id(region)
    control = boto3.client("bedrock-agentcore-control", region_name=region)

    artifact = {"containerConfiguration": {"containerUri": image_uri}}
    network = {"networkMode": "PUBLIC"}
    protocol = {"serverProtocol": "HTTP"}
    # Persistent per-session workspace — the whole point of the dedicated runtime.
    filesystem = [{"sessionStorage": {"mountPath": WORKSPACE_MOUNT}}]
    # HealthyBusy keeps the session alive mid-run; these bound an idle/abandoned one.
    lifecycle = {"idleRuntimeSessionTimeout": 1800, "maxLifetime": 28800}

    env_vars = {
        "AWS_REGION": region,
        "EVENTS_TABLE": os.environ.get("EVENTS_TABLE", "agentcore-hub-events"),
        "CLAUDE_CODE_USE_BEDROCK": "1",
        "ANTHROPIC_MODEL": os.environ.get("ANTHROPIC_MODEL", "us.anthropic.claude-opus-4-6-v1"),
        "CLAUDE_MODEL": os.environ.get("CLAUDE_MODEL", "us.anthropic.claude-opus-4-6-v1"),
        # Codex routes through Bedrock Mantle (us-east-2 for GPT-5.5) via Codex's
        # built-in amazon-bedrock provider; CODEX_MODEL overrides the model.
        "BEDROCK_MANTLE_REGION": os.environ.get("BEDROCK_MANTLE_REGION", "us-east-2"),
        "CODEX_MODEL": os.environ.get("CODEX_MODEL", "openai.gpt-5.5"),
    }

    print("=" * 63)
    print(f"  Deploying {RUNTIME_NAME}")
    print(f"  Region:   {region}")
    print(f"  Image:    {image_uri}")
    print(f"  Storage:  {WORKSPACE_MOUNT} (persistent session storage)")
    print("=" * 63)

    runtime_id = find_runtime(control, RUNTIME_NAME)
    try:
        if runtime_id is None:
            resp = control.create_agent_runtime(
                agentRuntimeName=RUNTIME_NAME,
                agentRuntimeArtifact=artifact,
                roleArn=role_arn,
                networkConfiguration=network,
                protocolConfiguration=protocol,
                filesystemConfigurations=filesystem,
                lifecycleConfiguration=lifecycle,
                environmentVariables=env_vars,
                description="Coding worker (Claude Code, Codex)",
            )
            runtime_id = resp["agentRuntimeId"]
            arn = resp["agentRuntimeArn"]
            print(f"Created runtime {runtime_id}")
        else:
            resp = control.update_agent_runtime(
                agentRuntimeId=runtime_id,
                agentRuntimeArtifact=artifact,
                roleArn=role_arn,
                networkConfiguration=network,
                protocolConfiguration=protocol,
                filesystemConfigurations=filesystem,
                lifecycleConfiguration=lifecycle,
                environmentVariables=env_vars,
                description="Coding worker (Claude Code, Codex)",
            )
            arn = resp["agentRuntimeArn"]
            print(f"Updated runtime {runtime_id}")
    except ClientError as e:
        fail(f"{e.response['Error']['Code']}: {e.response['Error']['Message']}")

    wait_until_ready(control, runtime_id)

    arn_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "coding-runtime-arn.txt")
    with open(arn_file, "w") as f:
        f.write(arn + "\n")

    print("")
    print(f"OK {RUNTIME_NAME} deployed")
    print(f"ARN: {arn}")
    print("")
    print("Set this on the fleet agents (deploy/config.sh or deploy env):")
    print(f"  export CODING_AGENT_RUNTIME_ARN={arn}")


if __name__ == "__main__":
    main()
