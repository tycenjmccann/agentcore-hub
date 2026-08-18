#!/usr/bin/env python3
"""Bind a connector to an agent so its tools/creds are available when that agent runs.

Usage:
  python3 bind_connector.py <agentId> <connectorId> [<connectorId> ...]

Adds the connector id(s) to the agent's `connectors` list in
s3://$ARTIFACT_BUCKET/config/agents.json. At invocation the runtime reads this list,
fetches each connector's secret from Secrets Manager (with its own role), and wires
it in (env vars / MCP server / SigV4 gateway) — no redeploy, no secret in the roster.

The agent must already exist in config/agents.json (compose an existing one or
write_blueprint.py first). The connector must exist in config/connectors.json
(list_connectors.py / register_connector.py). Binding a connector still in
"needs_credentials" is allowed — it simply has no effect until a human enters the
credential, at which point it activates for every agent bound to it.
"""

import argparse
import json
import os
import sys

import boto3

REGION = os.environ.get("AWS_REGION", "us-east-1")
ARTIFACT_BUCKET = os.environ["ARTIFACT_BUCKET"]

s3 = boto3.client("s3", region_name=REGION)


def read_json(key, default):
    try:
        return json.loads(s3.get_object(Bucket=ARTIFACT_BUCKET, Key=key)["Body"].read())
    except s3.exceptions.NoSuchKey:
        return default


def main():
    p = argparse.ArgumentParser()
    p.add_argument("agent_id")
    p.add_argument("connector_ids", nargs="+")
    args = p.parse_args()

    known = {c.get("id") for c in read_json("config/connectors.json", {"connectors": []}).get("connectors", [])}
    unknown = [c for c in args.connector_ids if c not in known]
    if unknown:
        raise SystemExit(
            f"VALIDATION FAILED: connector(s) {unknown} not in config/connectors.json. "
            "Run register_connector.py first."
        )

    cfg = read_json("config/agents.json", {"agents": []})
    agents = cfg.get("agents", [])
    entry = next((a for a in agents if a.get("agentId") == args.agent_id), None)
    if not entry:
        raise SystemExit(
            f"VALIDATION FAILED: agent '{args.agent_id}' not in config/agents.json. "
            "Compose an existing agent or write_blueprint.py first."
        )

    current = list(entry.get("connectors", []))
    merged = current + [c for c in args.connector_ids if c not in current]
    entry["connectors"] = merged
    cfg["agents"] = agents
    s3.put_object(
        Bucket=ARTIFACT_BUCKET,
        Key="config/agents.json",
        Body=json.dumps(cfg, indent=2).encode(),
        ContentType="application/json",
    )

    print(json.dumps({
        "agentId": args.agent_id,
        "connectors": merged,
        "added": [c for c in args.connector_ids if c not in current],
        "note": "Live on the next invocation (runtime reads agents.json from S3 per session).",
    }, indent=2))


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        print(str(e), file=sys.stderr)
        raise
