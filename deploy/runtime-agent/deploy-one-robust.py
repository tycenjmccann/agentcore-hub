#!/usr/bin/env python3
"""
deploy-one-robust.py — Deploy one agent in robust mode (custom container).

Robust mode bakes Node, claude-code, Playwright Chromium, and curated skills
into a Docker image (see Dockerfile + install-skills.sh), pushes to ECR, and
points an AgentCore Runtime at the image URI directly via the
bedrock-agentcore-control API.

The new @aws/agentcore CLI (agentcore.json) does not expose a way to reference
a pre-built ECR image — it always wants to rebuild from source. We bypass it
and call CreateAgentRuntime / UpdateAgentRuntime directly.

Usage:
  IMAGE_URI=<account-id>.dkr.ecr.us-east-1.amazonaws.com/runtime-agent:v15 \
  AGENTCORE_ROLE_ARN=arn:aws:iam::...:role/agentcore-hub-agentcore-role \
  ARTIFACT_BUCKET=agentcore-hub-artifacts-... \
  ./deploy-one-robust.py <agent_name>

Prints "OK <name> <arn>" on success, "FAIL <name> <reason>" on failure.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import boto3
from botocore.exceptions import ClientError


def fail(agent_name: str, reason: str) -> None:
    print(f"FAIL {agent_name} ({reason})")
    sys.exit(1)


def upload_prompt(s3, agent_name: str, bucket: str, region: str) -> str:
    prompt_path = Path(__file__).parent / "prompts" / f"{agent_name}.txt"
    if not prompt_path.is_file():
        fail(agent_name, f"no prompt file: {prompt_path}")

    key = f"prompts/{agent_name}.txt"
    s3.upload_file(str(prompt_path), bucket, key)
    return key


def build_env_vars(agent_name: str, prompt_key: str) -> dict[str, str]:
    """Mirror the env vars set by the lightweight CodeZip path in deploy-one.sh."""
    env = {
        "BYPASS_TOOL_CONSENT": "true",
        "MODEL_ID": "us.anthropic.claude-opus-4-6-v1",
        "READ_TIMEOUT": "1200",
        "AWS_REGION": "us-east-1",
        "EVENTS_TABLE": "agentcore-hub-events",
        "TICKET_TOOLS_LAMBDA": os.environ.get("TICKET_TOOLS_LAMBDA", "agentcore-hub-jira"),
        "AGENTCORE_HUB_ARTIFACT_BUCKET": os.environ["ARTIFACT_BUCKET"],
        "CLAUDE_CODE_USE_BEDROCK": "1",
        "CLAUDE_MODEL": "us.anthropic.claude-opus-4-6-v1",
        "ANTHROPIC_MODEL": "us.anthropic.claude-opus-4-6-v1",
        # Codex via Bedrock Mantle (GPT-5.5, us-east-2) — no OpenAI key.
        "BEDROCK_MANTLE_REGION": os.environ.get("BEDROCK_MANTLE_REGION", "us-east-2"),
        "CODEX_MODEL": os.environ.get("CODEX_MODEL", "openai.gpt-5.5"),
        # In the baked image Playwright Chromium lives under /root/.cache/ms-playwright.
        # Override only if the caller explicitly sets it.
        "HOME": "/root",
        "TMPDIR": "/tmp",
        "SYSTEM_PROMPT_S3_KEY": prompt_key,
    }
    if gw := os.environ.get("GATEWAY_ARN"):
        env["GATEWAY_ARN"] = gw
    if mcp := os.environ.get("MCP_SERVERS"):
        env["MCP_SERVERS"] = mcp
    elif pat := os.environ.get("GITHUB_PAT"):
        env["GITHUB_PAT"] = pat
    return env


def find_runtime(client, name: str) -> str | None:
    paginator = client.get_paginator("list_agent_runtimes")
    for page in paginator.paginate():
        for rt in page.get("agentRuntimes", []):
            if rt.get("agentRuntimeName") == name:
                return rt["agentRuntimeId"]
    return None


def wait_until_ready(client, runtime_id: str, agent_name: str, timeout_s: int = 600) -> None:
    start = time.time()
    while time.time() - start < timeout_s:
        rt = client.get_agent_runtime(agentRuntimeId=runtime_id)
        status = rt.get("status")
        if status == "READY":
            return
        if status in ("CREATE_FAILED", "UPDATE_FAILED", "DELETE_FAILED"):
            fail(agent_name, f"runtime status={status}: {rt.get('failureReason', 'no reason')}")
        time.sleep(5)
    fail(agent_name, f"timed out waiting for READY (last status={status})")


def deploy(agent_name: str) -> None:
    region = os.environ.get("AWS_REGION", "us-east-1")
    role_arn = os.environ.get("AGENTCORE_ROLE_ARN")
    image_uri = os.environ.get("IMAGE_URI")
    bucket = os.environ.get("ARTIFACT_BUCKET")

    for var, val in [("AGENTCORE_ROLE_ARN", role_arn), ("IMAGE_URI", image_uri), ("ARTIFACT_BUCKET", bucket)]:
        if not val:
            fail(agent_name, f"env var {var} is required")

    s3 = boto3.client("s3", region_name=region)
    control = boto3.client("bedrock-agentcore-control", region_name=region)

    prompt_key = upload_prompt(s3, agent_name, bucket, region)
    env_vars = build_env_vars(agent_name, prompt_key)

    artifact = {"containerConfiguration": {"containerUri": image_uri}}
    network = {"networkMode": "PUBLIC"}
    lifecycle = {"idleRuntimeSessionTimeout": 3600, "maxLifetime": 3600}

    runtime_id = find_runtime(control, agent_name)
    try:
        if runtime_id is None:
            resp = control.create_agent_runtime(
                agentRuntimeName=agent_name,
                agentRuntimeArtifact=artifact,
                roleArn=role_arn,
                networkConfiguration=network,
                lifecycleConfiguration=lifecycle,
                environmentVariables=env_vars,
            )
            runtime_id = resp["agentRuntimeId"]
            arn = resp["agentRuntimeArn"]
        else:
            resp = control.update_agent_runtime(
                agentRuntimeId=runtime_id,
                agentRuntimeArtifact=artifact,
                roleArn=role_arn,
                networkConfiguration=network,
                lifecycleConfiguration=lifecycle,
                environmentVariables=env_vars,
            )
            arn = resp["agentRuntimeArn"]
    except ClientError as e:
        fail(agent_name, f"{e.response['Error']['Code']}: {e.response['Error']['Message']}")

    wait_until_ready(control, runtime_id, agent_name)
    print(f"OK {agent_name} {arn}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: deploy-one-robust.py <agent_name>", file=sys.stderr)
        sys.exit(2)
    deploy(sys.argv[1])
