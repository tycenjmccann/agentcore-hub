#!/usr/bin/env python3
"""update-runtime-image.py — swap ONE AgentCore runtime's container image, in place.

The pipeline's runtime-image Deploy action rebuilds a fleet/coding runtime image
(deploy/runtime-agent, deploy/coding-agent-runtime) and calls this to promote it.
It does an IMAGE-ONLY swap: read the LIVE runtime config via GetAgentRuntime,
change ONLY agentRuntimeArtifact.containerConfiguration.containerUri, and
UpdateAgentRuntime with every other field preserved verbatim
(environmentVariables, roleArn, networkConfiguration, lifecycleConfiguration,
and — for the coding runtime — protocolConfiguration + filesystemConfigurations).

Why read-then-swap instead of rebuilding the env from scratch (deploy-one-robust.py
/ deploy.py): UpdateAgentRuntime REPLACES the whole env, and the live runtime
carries values a from-scratch build would silently drop — MEMORY_ID (fleet loses
memory + dashboard history), GITHUB_PAT/KIRO_API_KEY (coding clone/turn fails), and
lifecycleConfiguration.maxLifetime=28800 (the 8h session cap that has reverted to
1h three times when a deploy re-sent that block, stranding every workflow at 60min).
Config changes go through the setup scripts (a human handoff); the pipeline only
rolls the image. So this script never invents env — it preserves it.

NEVER prints environmentVariables (GITHUB_PAT/KIRO_API_KEY are plaintext there).

Usage:
  update-runtime-image.py deploy   <runtime_name> <new_image_ref>   # promote
  update-runtime-image.py rollback <runtime_name> <prev_image_ref>  # trap restore

deploy mode writes the prior image ref to $RT_SNAPSHOT_DIR/<name>.prev (for the
buildspec's rollback trap) and emits a `runtime.deploy` marker to $EVENTS_TABLE so
the performance card / anomaly watcher can attribute a step-change in workflow
cost/quality to a specific prompt/tool deploy. A marker-write failure warns but
never fails the deploy (the image is already live).
"""
from __future__ import annotations

import datetime as _dt
import os
import sys
import time

import boto3
from botocore.exceptions import ClientError

# GetAgentRuntime returns these config structures in the exact shape
# UpdateAgentRuntime accepts. Everything else it returns (metadataConfiguration,
# workloadIdentityDetails, status, timestamps, version) is OUTPUT-only and must
# NOT be echoed back into Update.
_PRESERVED = [
    "roleArn",
    "networkConfiguration",
    "protocolConfiguration",
    "filesystemConfigurations",
    "lifecycleConfiguration",
    "environmentVariables",
]


def _fail(name: str, reason: str) -> None:
    print(f"FAIL {name} ({reason})", file=sys.stderr)
    sys.exit(1)


def _find_runtime(control, name: str) -> str | None:
    paginator = control.get_paginator("list_agent_runtimes")
    for page in paginator.paginate():
        for rt in page.get("agentRuntimes", []):
            if rt.get("agentRuntimeName") == name:
                return rt["agentRuntimeId"]
    return None


def _wait_ready(control, runtime_id: str, name: str, timeout_s: int = 900) -> None:
    start = time.time()
    status = "UNKNOWN"
    while time.time() - start < timeout_s:
        rt = control.get_agent_runtime(agentRuntimeId=runtime_id)
        status = rt.get("status")
        if status == "READY":
            return
        if status in ("CREATE_FAILED", "UPDATE_FAILED", "DELETE_FAILED"):
            _fail(name, f"runtime status={status}: {rt.get('failureReason', 'no reason')}")
        time.sleep(5)
    _fail(name, f"timed out waiting for READY (last status={status})")


def _update_kwargs_from_live(live: dict, new_image: str) -> dict:
    """Build the UpdateAgentRuntime kwargs: the live config verbatim with only the
    container image changed — minus fields the API returns but refuses on Update.

    requireServiceS3Endpoint: GetAgentRuntime echoes it inside
    networkModeConfig, but runtimes created after 2026-06-11 reject ANY Update
    that carries the key — even the unchanged live value (ValidationException,
    run fcde61ac 2026-09-04: coding-runtime swap failed, fleet swap rolled back).
    """
    kwargs: dict = {
        "agentRuntimeId": live["agentRuntimeId"],
        "agentRuntimeArtifact": {"containerConfiguration": {"containerUri": new_image}},
    }
    for field in _PRESERVED:
        if field in live and live[field] is not None:
            kwargs[field] = live[field]
    if live.get("description"):
        kwargs["description"] = live["description"]
    net = kwargs.get("networkConfiguration")
    if isinstance(net, dict) and isinstance(net.get("networkModeConfig"), dict):
        net["networkModeConfig"] = {
            k: v for k, v in net["networkModeConfig"].items() if k != "requireServiceS3Endpoint"
        }
    return kwargs


def _swap(control, name: str, new_image: str) -> tuple[str, str]:
    """UpdateAgentRuntime with only the container image changed. Returns
    (runtime_id, prior_image_ref)."""
    runtime_id = _find_runtime(control, name)
    if runtime_id is None:
        _fail(name, "runtime not found (create it once with its own deploy script)")

    live = control.get_agent_runtime(agentRuntimeId=runtime_id)
    prior_image = (
        live.get("agentRuntimeArtifact", {})
        .get("containerConfiguration", {})
        .get("containerUri", "")
    )

    live["agentRuntimeId"] = runtime_id
    kwargs = _update_kwargs_from_live(live, new_image)

    try:
        control.update_agent_runtime(**kwargs)
    except ClientError as e:
        _fail(name, f"{e.response['Error']['Code']}: {e.response['Error']['Message']}")

    _wait_ready(control, runtime_id, name)
    return runtime_id, prior_image


def _emit_marker(region: str, name: str, new_image: str, prior_image: str) -> None:
    """Write a runtime.deploy marker to the events table so the performance
    analysis can correlate an agent prompt/tool change with the workflows that
    ran after it. Best-effort: the image is already live, so a failure here only
    warns."""
    table = os.environ.get("EVENTS_TABLE", "agentcore-hub-events")
    ts = _dt.datetime.now(_dt.timezone.utc).isoformat()
    digest = new_image.split("@", 1)[1] if "@" in new_image else ""
    item = {
        "workflowId": {"S": "__runtime_deploys__"},
        "eventId": {"S": f"{ts}#{name}"},
        "type": {"S": "runtime.deploy"},
        "ts": {"S": ts},
        "runtime": {"S": name},
        "image": {"S": new_image},
        "prevImage": {"S": prior_image or "(none)"},
        "gitSha": {"S": os.environ.get("GIT_SHA", "unknown")},
    }
    if digest:
        item["imageDigest"] = {"S": digest}
    try:
        boto3.client("dynamodb", region_name=region).put_item(TableName=table, Item=item)
        print(f"  marker: runtime.deploy {name} @ {ts}")
    except ClientError as e:
        print(f"  WARN: could not write runtime.deploy marker ({e.response['Error']['Code']})", file=sys.stderr)


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[0] not in ("deploy", "rollback"):
        print("usage: update-runtime-image.py deploy|rollback <runtime_name> <image_ref>", file=sys.stderr)
        return 2
    mode, name, image = argv
    region = os.environ.get("AWS_REGION", "us-east-1")
    control = boto3.client("bedrock-agentcore-control", region_name=region)

    if mode == "rollback":
        # Restore a prior image (called by the buildspec trap). No marker.
        _swap(control, name, image)
        print(f"ROLLED_BACK {name} → {image}")
        return 0

    # deploy: snapshot the prior image FIRST so the trap can restore only the
    # runtimes we actually touched, then swap + emit the marker.
    snapshot_dir = os.environ.get("RT_SNAPSHOT_DIR")
    runtime_id, prior_image = None, ""
    # Peek prior image for the snapshot before mutating.
    rid = _find_runtime(control, name)
    if rid is None:
        _fail(name, "runtime not found (create it once with its own deploy script)")
    prior_image = (
        control.get_agent_runtime(agentRuntimeId=rid)
        .get("agentRuntimeArtifact", {})
        .get("containerConfiguration", {})
        .get("containerUri", "")
    )
    if snapshot_dir and prior_image:
        os.makedirs(snapshot_dir, exist_ok=True)
        with open(os.path.join(snapshot_dir, f"{name}.prev"), "w") as fh:
            fh.write(prior_image)

    runtime_id, prior_image = _swap(control, name, image)
    _emit_marker(region, name, image, prior_image)
    print(f"OK {name} → {image}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
