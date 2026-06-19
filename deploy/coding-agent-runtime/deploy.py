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
# EFS mount — elastic, POSIX, survives cold microVMs. Required for a real code
# workspace (git + node_modules exceed the ~1 GB sessionStorage quota). Provision
# the VPC/EFS with setup-coding-efs.sh first (writes efs.config).
EFS_MOUNT = "/mnt/efs"


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


def _load_env_file(path: str, prefix: str = "") -> None:
    """Load KEY=VALUE / `export KEY=VALUE` lines from a dotenv-style file into the
    environment (without overwriting anything already set). Used for efs.config and
    .env.local so a deploy never silently drops GITHUB_PAT / ARTIFACT_BUCKET / role
    just because the caller forgot to `source` first."""
    if not os.path.exists(path):
        return
    with open(path) as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith(prefix):
                line = line[len(prefix):]
            k, sep, v = line.partition("=")
            if not sep:
                continue
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def _load_efs_config() -> None:
    """Source efs.config (VPC/EFS ids) AND repo .env.local (PAT, bucket, role,
    gateway) so a bare `python deploy.py` has the full env, same as the shell
    scripts that `source config.sh`."""
    here = os.path.dirname(os.path.abspath(__file__))
    _load_env_file(os.path.join(here, "efs.config"), prefix="export ")
    # .env.local lives at the repo root (deploy/coding-agent-runtime/ → ../../).
    _load_env_file(os.path.abspath(os.path.join(here, "..", "..", ".env.local")))


def _load_env_local() -> None:
    """Source the repo's gitignored .env.local so runtime env (GITHUB_PAT,
    ARTIFACT_BUCKET, model ids, etc.) is always forwarded — without it, clones
    of private repos 401 and the resume-transcript install silently skips."""
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    envf = os.path.join(repo_root, ".env.local")
    if not os.path.exists(envf):
        return
    with open(envf) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def main() -> None:
    _load_env_local()
    _load_efs_config()
    region = os.environ.get("AWS_REGION", "us-east-1")
    image_uri = os.environ.get("IMAGE_URI")
    role_arn = os.environ.get("CODING_RUNTIME_ROLE_ARN")

    if not image_uri:
        fail("IMAGE_URI is required (run build-and-push.sh first)")
    if not role_arn:
        fail("CODING_RUNTIME_ROLE_ARN is required (run setup-coding-runtime-role.sh first)")

    account_id = resolve_account_id(region)

    # EFS + VPC are required (from setup-coding-efs.sh → efs.config).
    efs_ap_arn = os.environ.get("CODING_EFS_ACCESS_POINT_ARN")
    subnet_1 = os.environ.get("CODING_SUBNET_1")
    subnet_2 = os.environ.get("CODING_SUBNET_2")
    security_group = os.environ.get("CODING_SECURITY_GROUP")
    if not (efs_ap_arn and subnet_1 and subnet_2 and security_group):
        fail("EFS/VPC config missing — run setup-coding-efs.sh and source efs.config "
             "(need CODING_EFS_ACCESS_POINT_ARN, CODING_SUBNET_1/2, CODING_SECURITY_GROUP)")

    control = boto3.client("bedrock-agentcore-control", region_name=region)

    artifact = {"containerConfiguration": {"containerUri": image_uri}}
    # VPC mode so the runtime can reach the EFS mount targets in private subnets.
    network = {
        "networkMode": "VPC",
        "networkModeConfig": {
            "subnets": [subnet_1, subnet_2],
            "securityGroups": [security_group],
        },
    }
    protocol = {"serverProtocol": "HTTP"}
    # Persistent code workspace on EFS — elastic, survives cold microVMs.
    filesystem = [{"efsAccessPoint": {"accessPointArn": efs_ap_arn, "mountPath": EFS_MOUNT}}]
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
        # Workspace + CLI config dirs live on the EFS mount (elastic, persistent).
        "WORKSPACE_ROOT": EFS_MOUNT,
        "CLAUDE_CONFIG_DIR": f"{EFS_MOUNT}/.claude-data",
        "CODEX_HOME": f"{EFS_MOUNT}/.codex",
    }
    # Artifact bucket — where per-user config bundles live; the server fetches
    # cloud-code/configs/{userId}/{version}.zip and materializes it on turn start.
    if bucket := os.environ.get("ARTIFACT_BUCKET"):
        env_vars["ARTIFACT_BUCKET"] = bucket
    # Default MCP gateway — wired into both CLIs on session start.
    if mcp_url := os.environ.get("MCP_GATEWAY_URL"):
        env_vars["MCP_GATEWAY_URL"] = mcp_url
        env_vars["MCP_GATEWAY_NAME"] = os.environ.get("MCP_GATEWAY_NAME", "agentis_gateway")
    # GitHub auth for private repo clone/push (launchers configure git from it).
    if gh_pat := os.environ.get("GITHUB_PAT"):
        env_vars["GITHUB_PAT"] = gh_pat

    print("=" * 63)
    print(f"  Deploying {RUNTIME_NAME}")
    print(f"  Region:   {region}")
    print(f"  Image:    {image_uri}")
    print(f"  Network:  VPC ({subnet_1}, {subnet_2})")
    print(f"  Storage:  {EFS_MOUNT} (EFS — elastic, persistent)")
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
