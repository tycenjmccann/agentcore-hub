#!/usr/bin/env python3
"""
set-runtime-env.py — set (or unset) environment variables on a deployed AgentCore
runtime WITHOUT touching anything else about it.

UpdateAgentRuntime REPLACES the environment map (and needs every other config
block re-sent), so a bare CLI call wipes whatever you did not repeat. This reads
the live runtime, merges your changes into its env, and re-submits the image,
role, network, protocol, filesystem, lifecycle and capacity-provider config
exactly as they are. Values are never printed (runtime env carries credentials).

Usage (prod profile):
  AWS_PROFILE=tycenj-prod python3 deploy/runtime-agent/set-runtime-env.py agentcore_hub_agent \\
      CODING_AGENT_RUNTIME_ARN="$(cat deploy/coding-agent-runtime/coding-runtime-instances-arn.txt)"
  python3 set-runtime-env.py <runtime-name> KEY=VALUE [KEY=VALUE ...] [--unset KEY ...] [--dry-run]

Prints the keys that changed and waits for the runtime to be READY again.
"""
from __future__ import annotations

import argparse
import os
import sys
import time

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")

# GetAgentRuntime returns these in the exact shape UpdateAgentRuntime accepts.
# Everything else it returns is output-only and must not be echoed back
# (mirrors deploy/pipeline/update-runtime-image.py).
_PRESERVED = [
    "roleArn",
    "networkConfiguration",
    "protocolConfiguration",
    "filesystemConfigurations",
    "lifecycleConfiguration",
    "capacityProviderConfiguration",
]


def find_runtime(control, name: str) -> dict | None:
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


def update_kwargs(live: dict, env: dict) -> dict:
    kwargs = {
        "agentRuntimeId": live["agentRuntimeId"],
        "agentRuntimeArtifact": live["agentRuntimeArtifact"],
        "environmentVariables": env,
    }
    for field in _PRESERVED:
        if live.get(field) is not None:
            kwargs[field] = live[field]
    if live.get("description"):
        kwargs["description"] = live["description"]
    net = kwargs.get("networkConfiguration")
    if isinstance(net, dict) and isinstance(net.get("networkModeConfig"), dict):
        # Output-only member of the network block; Update rejects it.
        net["networkModeConfig"] = {k: v for k, v in net["networkModeConfig"].items()
                                    if k != "requireServiceS3Endpoint"}
    return kwargs


def wait_ready(control, runtime_id: str, timeout_s: int = 600) -> None:
    t0 = time.time()
    while True:
        rt = control.get_agent_runtime(agentRuntimeId=runtime_id)
        st = rt["status"]
        if st == "READY":
            print(f"   ✓ READY (v{rt.get('agentRuntimeVersion')}) in {time.time() - t0:.0f} s")
            return
        if st.endswith("FAILED"):
            sys.exit(f"✗ runtime {st}: {rt.get('failureReason')}")
        if time.time() - t0 > timeout_s:
            sys.exit(f"✗ runtime still {st} after {timeout_s} s")
        time.sleep(10)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("runtime", help="agentRuntimeName")
    ap.add_argument("assignments", nargs="*", help="KEY=VALUE")
    ap.add_argument("--unset", action="append", default=[], metavar="KEY")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    sets = {}
    for a in args.assignments:
        if "=" not in a:
            sys.exit(f"✗ expected KEY=VALUE, got {a!r}")
        k, v = a.split("=", 1)
        sets[k] = v
    if not sets and not args.unset:
        sys.exit("✗ nothing to do")

    control = boto3.client("bedrock-agentcore-control", region_name=REGION)
    live = find_runtime(control, args.runtime)
    if not live:
        sys.exit(f"✗ runtime {args.runtime} not found in {REGION}")
    env = dict(live.get("environmentVariables") or {})
    changed, removed = [], []
    for k, v in sets.items():
        if env.get(k) != v:
            changed.append(k)
        env[k] = v
    for k in args.unset:
        if k in env:
            env.pop(k)
            removed.append(k)
    print(f"🔧 {args.runtime} v{live.get('agentRuntimeVersion')} ({live['agentRuntimeId']}) — "
          f"set {changed or 'nothing'}, unset {removed or 'nothing'}; {len(env)} vars total")
    if not changed and not removed:
        print("   nothing changed")
        return
    if args.dry_run:
        print("   dry run — no update")
        return
    try:
        control.update_agent_runtime(**update_kwargs(live, env))
    except ClientError as exc:
        sys.exit(f"✗ {exc.response['Error']['Code']}: {exc.response['Error']['Message']}")
    wait_ready(control, live["agentRuntimeId"])


if __name__ == "__main__":
    main()
