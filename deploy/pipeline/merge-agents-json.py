#!/usr/bin/env python3
"""Merge the repo's agents.json onto the deployed S3 copy, preserving injected
runtimeArns. Single source of the merge logic that used to live inline in
DEPLOY.md step 2 — both the human runbook and the pipeline Deploy stage call
this, so they can never drift.

The tracked src/config/agents.json ships runtimeArn:null (open-source contract);
the S3 copy carries the deploy-injected ARNs. We take the repo's roster (the
source of truth for the agent list + prompts) but keep each agent's existing S3
ARN when the repo's is null.

Usage: merge-agents-json.py <s3-copy.json> <repo-copy.json> <out.json>
"""
import json
import sys


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: merge-agents-json.py <s3.json> <repo.json> <out.json>", file=sys.stderr)
        return 2
    s3_path, repo_path, out_path = sys.argv[1:4]

    with open(repo_path) as f:
        repo = json.load(f)
    with open(s3_path) as f:
        s3 = json.load(f)

    arns = {a["agentId"]: a.get("runtimeArn") for a in s3.get("agents", [])}
    for a in repo.get("agents", []):
        a["runtimeArn"] = a.get("runtimeArn") or arns.get(a["agentId"])

    with open(out_path, "w") as f:
        json.dump(repo, f, indent=2)

    # Fail loudly if the merge would ship null ARNs for runtime agents — the
    # exact clobber DEPLOY.md's smoke check guards against, caught pre-upload.
    missing = [
        a["agentId"]
        for a in repo.get("agents", [])
        if a.get("type") == "runtime" and not a.get("runtimeArn")
    ]
    if missing:
        print(f"ERROR: merged agents.json has null runtimeArn for: {missing}", file=sys.stderr)
        return 1
    print(f"merged agents.json OK ({len(repo.get('agents', []))} agents)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
