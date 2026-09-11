#!/usr/bin/env python3
"""
deploy-instances.py — stand up (or update / tear down) the coding runtime on the
AgentCore Runtime *Instances* compute type: an EC2 capacity provider in the coding
VPC + one persistent EBS volume per session mounted at /mnt/workspace.

Additive to the microVM + EFS runtime deployed by deploy.py: same image, same
execution role, same env (with the EFS paths rewritten), a new runtime ARN. Both
runtimes run side by side; the fleet picks one per workflow.

Everything account/region-specific is derived: the source runtime is looked up by
name, the VPC comes from the coding VPC CloudFormation stack, the account from STS.

Usage (prod profile):
  AWS_PROFILE=tycenj-prod python deploy-instances.py            # create or update
  AWS_PROFILE=tycenj-prod python deploy-instances.py --delete   # runtime + capacity provider

Knobs (env, all optional):
  CODING_CP_NAME               capacity provider name   (agentcore_hub_coding_cp)
  CODING_INSTANCES_RUNTIME     runtime name             (agentcore_hub_coding_runtime_ec2)
  CODING_SOURCE_RUNTIME        runtime to copy image/role/env from (agentcore_hub_coding_runtime)
  CODING_INSTANCE_TYPES        comma list               (m7g.xlarge)
  CODING_VOLUME_GIB            workspace volume size    (30)
  CODING_VOLUME_SNAPSHOT_ID    seed the volume from an EBS snapshot (unset)
  CODING_ROOT_FREE_GIB         root volume free space   (20)
  CODING_IDLE_S                idle timeout, both layers (1800)
  CODING_MAX_LIFETIME_S        max lifetime, both layers (86400)
  CODING_VPC_STACK             CFN stack with PrivateSubnet1Id/2Id + SecurityGroupId
                               (agentcore-hub-coding-vpc-efs)
  CODING_SUBNET_IDS / CODING_SECURITY_GROUP   override the stack lookup
  CODING_INSTANCE_PROFILE_ARN  optional EC2 instance profile for the capacity provider
  CODING_CP_OPERATOR_ROLE      operator role name (agentcore-hub-coding-cp-operator-role)

Needs boto3 >= 1.43.9x (CreateCapacityProvider). Run from a venv if the system
boto3 is older:  python3 -m venv /tmp/ac-venv && /tmp/ac-venv/bin/pip install -U boto3
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
CP_NAME = os.environ.get("CODING_CP_NAME", "agentcore_hub_coding_cp")
RUNTIME_NAME = os.environ.get("CODING_INSTANCES_RUNTIME", "agentcore_hub_coding_runtime_ec2")
SOURCE_RUNTIME = os.environ.get("CODING_SOURCE_RUNTIME", "agentcore_hub_coding_runtime")
INSTANCE_TYPES = [t.strip() for t in os.environ.get("CODING_INSTANCE_TYPES", "m7g.xlarge").split(",") if t.strip()]
VOLUME_GIB = int(os.environ.get("CODING_VOLUME_GIB", "30"))
VOLUME_SNAPSHOT_ID = os.environ.get("CODING_VOLUME_SNAPSHOT_ID") or None
ROOT_FREE_GIB = int(os.environ.get("CODING_ROOT_FREE_GIB", "20"))
IDLE_S = int(os.environ.get("CODING_IDLE_S", "1800"))
MAX_LIFETIME_S = int(os.environ.get("CODING_MAX_LIFETIME_S", "86400"))
VPC_STACK = os.environ.get("CODING_VPC_STACK", "agentcore-hub-coding-vpc-efs")
OPERATOR_ROLE = os.environ.get("CODING_CP_OPERATOR_ROLE", "agentcore-hub-coding-cp-operator-role")
OPERATOR_POLICY_ARN = "arn:aws:iam::aws:policy/BedrockAgentCoreRuntimeInstancesOperatorRolePolicy"
VOLUME_NAME = "workspace"
MOUNT_PATH = "/mnt/workspace"
ARN_FILE = Path(__file__).with_name("coding-runtime-instances-arn.txt")

control = boto3.client("bedrock-agentcore-control", region_name=REGION)
iam = boto3.client("iam")
cfn = boto3.client("cloudformation", region_name=REGION)
sts = boto3.client("sts")


def die(msg: str) -> None:
    print(f"✗ {msg}", file=sys.stderr)
    sys.exit(1)


def require_sdk() -> None:
    ops = control.meta.service_model.operation_names
    if "CreateCapacityProvider" not in ops:
        die(f"boto3 {boto3.__version__} has no CreateCapacityProvider — upgrade boto3 (see docstring)")


# ─── lookups ─────────────────────────────────────────────────────────────────

def find_runtime(name: str) -> dict | None:
    token = None
    while True:
        kw = {"maxResults": 100}
        if token:
            kw["nextToken"] = token
        page = control.list_agent_runtimes(**kw)
        for rt in page.get("agentRuntimes", []):
            if rt.get("agentRuntimeName") == name:
                return control.get_agent_runtime(agentRuntimeId=rt["agentRuntimeId"])
        token = page.get("nextToken")
        if not token:
            return None


def find_capacity_provider(name: str) -> dict | None:
    token = None
    while True:
        kw = {"maxResults": 100}
        if token:
            kw["nextToken"] = token
        page = control.list_capacity_providers(**kw)
        for cp in page.get("capacityProviders", []):
            if cp.get("name") == name:
                return control.get_capacity_provider(capacityProviderId=cp["capacityProviderId"])
        token = page.get("nextToken")
        if not token:
            return None


def vpc_config() -> tuple[list[str], list[str]]:
    subnets = os.environ.get("CODING_SUBNET_IDS")
    sg = os.environ.get("CODING_SECURITY_GROUP")
    if subnets and sg:
        return [s.strip() for s in subnets.split(",") if s.strip()], [sg]
    outs = {o["OutputKey"]: o["OutputValue"]
            for o in cfn.describe_stacks(StackName=VPC_STACK)["Stacks"][0].get("Outputs", [])}
    try:
        return [outs["PrivateSubnet1Id"], outs["PrivateSubnet2Id"]], [outs["SecurityGroupId"]]
    except KeyError as exc:
        die(f"stack {VPC_STACK} lacks output {exc}; set CODING_SUBNET_IDS + CODING_SECURITY_GROUP")
        raise


# ─── IAM ─────────────────────────────────────────────────────────────────────

def ensure_operator_role(account_id: str) -> str:
    """Role AgentCore assumes to run EC2/EBS on our behalf. Managed policy from AWS."""
    trust = {
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": {"Service": "bedrock-agentcore.amazonaws.com"},
            "Action": "sts:AssumeRole",
            "Condition": {
                "StringEquals": {"aws:SourceAccount": account_id},
                "ArnLike": {"aws:SourceArn": f"arn:aws:bedrock-agentcore:{REGION}:{account_id}:*"},
            },
        }],
    }
    try:
        iam.get_policy(PolicyArn=OPERATOR_POLICY_ARN)
    except ClientError as exc:
        die(f"managed policy {OPERATOR_POLICY_ARN} not found ({exc.response['Error']['Code']})")
    created = False
    try:
        arn = iam.get_role(RoleName=OPERATOR_ROLE)["Role"]["Arn"]
        iam.update_assume_role_policy(RoleName=OPERATOR_ROLE, PolicyDocument=json.dumps(trust))
        print(f"   ✓ operator role exists: {OPERATOR_ROLE}")
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "NoSuchEntity":
            raise
        arn = iam.create_role(
            RoleName=OPERATOR_ROLE,
            AssumeRolePolicyDocument=json.dumps(trust),
            Description="AgentCore Runtime Instances operator role for the hub coding runtime capacity provider",
        )["Role"]["Arn"]
        created = True
        print(f"   ✓ operator role created: {OPERATOR_ROLE}")
    attached = {p["PolicyArn"] for p in iam.list_attached_role_policies(RoleName=OPERATOR_ROLE)["AttachedPolicies"]}
    if OPERATOR_POLICY_ARN not in attached:
        iam.attach_role_policy(RoleName=OPERATOR_ROLE, PolicyArn=OPERATOR_POLICY_ARN)
        created = True
    if created:
        print("   … waiting 15 s for IAM propagation")
        time.sleep(15)
    return arn


# ─── capacity provider ───────────────────────────────────────────────────────

def wait_cp(cp_id: str, timeout_s: int = 900) -> dict:
    t0 = time.time()
    while True:
        cp = control.get_capacity_provider(capacityProviderId=cp_id)
        st = cp["status"]
        if st == "READY":
            print(f"   ✓ capacity provider READY in {time.time() - t0:.0f} s")
            return cp
        if st.endswith("FAILED"):
            die(f"capacity provider {st}: {cp.get('statusCode')} {cp.get('statusReason')}")
        if time.time() - t0 > timeout_s:
            die(f"capacity provider still {st} after {timeout_s} s")
        time.sleep(10)


def ensure_capacity_provider(operator_role_arn: str) -> dict:
    existing = find_capacity_provider(CP_NAME)
    if existing:
        print(f"   ✓ capacity provider exists: {CP_NAME} ({existing['capacityProviderId']}, {existing['status']})")
        if existing["status"] in ("CREATING", "UPDATING"):
            return wait_cp(existing["capacityProviderId"])
        if existing["status"] != "READY":
            die(f"capacity provider {CP_NAME} is {existing['status']}: {existing.get('statusReason')}")
        return existing
    subnets, sgs = vpc_config()
    launch = {
        "operatingSystem": "LINUX_ARM64",
        "instanceRequirements": {"allowedInstanceTypes": INSTANCE_TYPES},
        "monitoring": "BASIC",
    }
    if os.environ.get("CODING_INSTANCE_PROFILE_ARN"):
        launch["instanceProfileArn"] = os.environ["CODING_INSTANCE_PROFILE_ARN"]
    volume = {"name": VOLUME_NAME, "sizeGiB": VOLUME_GIB, "volumeType": "gp3", "encrypted": True}
    if VOLUME_SNAPSHOT_ID:
        volume["snapshotId"] = VOLUME_SNAPSHOT_ID
    compute = {
        "ec2Configuration": {
            "launchTemplateSource": {"launchParameters": launch},
            "vpcConfiguration": {"subnets": subnets, "securityGroups": sgs},
            "volumes": [{"ebsConfiguration": volume}],
            "lifecycleConfiguration": {"idleInstanceTimeout": IDLE_S, "maxLifetime": MAX_LIFETIME_S},
            "rootVolume": {"volumeType": "gp3", "freeSpaceGiB": ROOT_FREE_GIB, "encrypted": True},
        }
    }
    print(f"   Creating capacity provider {CP_NAME}: {INSTANCE_TYPES} arm64, volume {VOLUME_GIB} GiB gp3"
          f"{' from ' + VOLUME_SNAPSHOT_ID if VOLUME_SNAPSHOT_ID else ''}, root +{ROOT_FREE_GIB} GiB, "
          f"idle {IDLE_S} s, max {MAX_LIFETIME_S} s, subnets {subnets}")
    t0 = time.time()
    resp = control.create_capacity_provider(
        name=CP_NAME,
        description="AgentCore Hub coding runtime (Claude Code / Codex / Kiro) on EC2 with a per-session EBS workspace",
        permissionsConfiguration={"capacityProviderOperatorRoleArn": operator_role_arn},
        computeConfiguration=compute,
        tags={"Project": "agentcore-hub", "Component": "coding-runtime-instances"},
    )
    print(f"   → {resp['capacityProviderArn']} (create call {time.time() - t0:.1f} s)")
    return wait_cp(resp["capacityProviderId"])


# ─── runtime ─────────────────────────────────────────────────────────────────

def derive_env(src_env: dict) -> dict:
    env = {k: v.replace("/mnt/efs", MOUNT_PATH) for k, v in src_env.items()}
    env["WORKSPACE_ROOT"] = MOUNT_PATH
    env["OTEL_SERVICE_NAME"] = f"{RUNTIME_NAME}.DEFAULT"
    # Spans to this runtime's own log group (the post-2026-07-20 default); the
    # source runtime predates that and still lands in aws/spans.
    env["UNIFIED_TRACES_DESTINATION_ENABLED"] = "true"
    # The bare-mirror cache exists to share one clone across microVMs on EFS; on a
    # per-session volume it would only add a second copy of every repo.
    env["WORKSPACE_MIRROR_ENABLED"] = "0"
    env["CODING_COMPUTE"] = "instances"
    return env


def wait_runtime(rt_id: str, timeout_s: int = 900) -> dict:
    t0 = time.time()
    while True:
        rt = control.get_agent_runtime(agentRuntimeId=rt_id)
        st = rt["status"]
        if st == "READY":
            print(f"   ✓ runtime READY (v{rt.get('agentRuntimeVersion')}) in {time.time() - t0:.0f} s")
            return rt
        if st.endswith("FAILED"):
            die(f"runtime {st}: {rt.get('failureReason') or rt}")
        if time.time() - t0 > timeout_s:
            die(f"runtime still {st} after {timeout_s} s")
        time.sleep(10)


def ensure_runtime(cp: dict, source: dict) -> dict:
    image = source["agentRuntimeArtifact"]["containerConfiguration"]["containerUri"]
    role = source["roleArn"]
    env = derive_env(source.get("environmentVariables", {}))
    common = {
        "agentRuntimeArtifact": {"containerConfiguration": {"containerUri": image}},
        "roleArn": role,
        "protocolConfiguration": source.get("protocolConfiguration", {"serverProtocol": "HTTP"}),
        "capacityProviderConfiguration": {"capacityProviderArn": cp["capacityProviderArn"]},
        "filesystemConfigurations": [{"capacityProviderVolume": {"volumeName": VOLUME_NAME, "mountPath": MOUNT_PATH}}],
        "lifecycleConfiguration": {"idleRuntimeSessionTimeout": IDLE_S, "maxLifetime": MAX_LIFETIME_S},
        "environmentVariables": env,
        "description": f"Hub coding runtime on Instances ({','.join(INSTANCE_TYPES)}); copies image/role/env from {SOURCE_RUNTIME}",
    }
    existing = find_runtime(RUNTIME_NAME)
    if existing:
        print(f"   Updating runtime {RUNTIME_NAME} ({existing['agentRuntimeId']}) → image {image.split('@')[-1][:19]}")
        resp = control.update_agent_runtime(agentRuntimeId=existing["agentRuntimeId"], **common)
        rt_id = existing["agentRuntimeId"]
    else:
        print(f"   Creating runtime {RUNTIME_NAME} on {cp['name']} with image {image.split('@')[-1][:19]}")
        resp = control.create_agent_runtime(agentRuntimeName=RUNTIME_NAME, **common)
        rt_id = resp["agentRuntimeId"]
    rt = wait_runtime(rt_id)
    ARN_FILE.write_text(resp["agentRuntimeArn"] + "\n")
    print(f"   → {resp['agentRuntimeArn']}\n   → written to {ARN_FILE.name}")
    return rt


# ─── teardown ────────────────────────────────────────────────────────────────

def delete_all() -> None:
    rt = find_runtime(RUNTIME_NAME)
    if rt:
        print(f"   Deleting runtime {RUNTIME_NAME}")
        control.delete_agent_runtime(agentRuntimeId=rt["agentRuntimeId"])
        for _ in range(60):
            try:
                control.get_agent_runtime(agentRuntimeId=rt["agentRuntimeId"])
                time.sleep(5)
            except ClientError as exc:
                if exc.response["Error"]["Code"] == "ResourceNotFoundException":
                    break
                raise
        print("   ✓ runtime gone")
    cp = find_capacity_provider(CP_NAME)
    if cp:
        # Deleting the capacity provider stops + deletes EVERY session and its volume.
        print(f"   Deleting capacity provider {CP_NAME} (all sessions + volumes)")
        control.delete_capacity_provider(capacityProviderId=cp["capacityProviderId"])
        for _ in range(120):
            try:
                st = control.get_capacity_provider(capacityProviderId=cp["capacityProviderId"])["status"]
                if st == "DELETE_FAILED":
                    die("capacity provider DELETE_FAILED")
                time.sleep(10)
            except ClientError as exc:
                if exc.response["Error"]["Code"] == "ResourceNotFoundException":
                    break
                raise
        print("   ✓ capacity provider gone")
    if ARN_FILE.exists():
        ARN_FILE.unlink()


def main() -> None:
    require_sdk()
    account_id = sts.get_caller_identity()["Account"]
    print(f"🧩 Coding runtime on Instances — account {account_id}, region {REGION}")
    if "--delete" in sys.argv:
        delete_all()
        return
    source = find_runtime(SOURCE_RUNTIME)
    if not source:
        die(f"source runtime {SOURCE_RUNTIME} not found — deploy the microVM runtime first")
    print(f"   Source runtime: {SOURCE_RUNTIME} v{source.get('agentRuntimeVersion')}")
    operator_role_arn = ensure_operator_role(account_id)
    cp = ensure_capacity_provider(operator_role_arn)
    rt = ensure_runtime(cp, source)
    print(json.dumps({
        "capacityProviderId": cp["capacityProviderId"],
        "capacityProviderArn": cp["capacityProviderArn"],
        "agentRuntimeArn": rt["agentRuntimeArn"],
        "agentRuntimeId": rt["agentRuntimeId"],
        "version": rt.get("agentRuntimeVersion"),
        "instanceTypes": INSTANCE_TYPES,
        "volumeGiB": VOLUME_GIB,
        "mountPath": MOUNT_PATH,
    }, indent=2))


if __name__ == "__main__":
    main()
