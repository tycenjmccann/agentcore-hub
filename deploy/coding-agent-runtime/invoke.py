#!/usr/bin/env python3
"""
invoke.py — headless client for the coding-agent runtime.

Proves the "safe to close your laptop" loop end-to-end without any UI:
fire a task, get a response + claude_session_id, then resume the SAME
runtimeSessionId (warm /mnt/workspace) with the next task.

Usage:
  export CODING_AGENT_RUNTIME_ARN=arn:aws:bedrock-agentcore:...:runtime/...
  # New session:
  python invoke.py --repo owner/name "add a CONTRIBUTING.md with a build section"
  # Resume (same workspace + conversation):
  python invoke.py --session <runtimeSessionId> --resume <claude_session_id> \
                   "now add a license section"

Reads CODING_AGENT_RUNTIME_ARN (or --arn) and AWS_REGION (default us-east-1).
"""
import argparse
import json
import os
import sys
import uuid

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError


def invoke(arn, region, session_id, payload):
    client = boto3.client("bedrock-agentcore", region_name=region,
                          config=Config(read_timeout=900, retries={"max_attempts": 0}))
    resp = client.invoke_agent_runtime(
        agentRuntimeArn=arn,
        runtimeSessionId=session_id,
        payload=json.dumps(payload).encode("utf-8"),
    )
    body = resp["response"].read().decode("utf-8")
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return {"_raw": body}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("prompt")
    ap.add_argument("--arn", default=os.environ.get("CODING_AGENT_RUNTIME_ARN"))
    ap.add_argument("--region", default=os.environ.get("AWS_REGION", "us-east-1"))
    ap.add_argument("--repo", help="owner/name or clone URL")
    ap.add_argument("--cli", default="claude", choices=["claude", "codex"])
    ap.add_argument("--session", help="runtimeSessionId to resume (>=33 chars); new if omitted")
    ap.add_argument("--resume", dest="claude_session_id", help="claude_session_id from a prior turn")
    args = ap.parse_args()

    if not args.arn:
        print("error: set CODING_AGENT_RUNTIME_ARN or pass --arn", file=sys.stderr)
        sys.exit(2)

    # AgentCore requires runtimeSessionId >= 33 chars. A fresh uuid4 hex (32) +
    # prefix clears it; reuse the SAME value to land on the warm microVM.
    session_id = args.session or f"cli-{uuid.uuid4().hex}"
    payload = {"prompt": args.prompt, "cli": args.cli}
    if args.repo:
        payload["repo"] = args.repo
    if args.claude_session_id:
        payload["claude_session_id"] = args.claude_session_id

    print(f"→ runtimeSessionId: {session_id}")
    print(f"→ cli={args.cli} repo={args.repo or '(none)'} resume={bool(args.claude_session_id)}\n")

    try:
        result = invoke(args.arn, args.region, session_id, payload)
    except ClientError as e:
        print(f"ClientError: {e}", file=sys.stderr)
        sys.exit(1)

    print("── response ──")
    print(result.get("response", result))
    print("\n── continue this session ──")
    cs = result.get("claude_session_id")
    resume = f" --resume {cs}" if cs else ""
    print(f'  python invoke.py --session {session_id}{resume} "<next task>"')


if __name__ == "__main__":
    main()
