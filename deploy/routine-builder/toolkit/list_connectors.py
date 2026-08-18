#!/usr/bin/env python3
"""List the connectors available to bind to agents (metadata only, never secrets).

Usage:
  python3 list_connectors.py

Reads s3://$ARTIFACT_BUCKET/config/connectors.json. Prints each connector's id,
name, kind, required secret keys, and status (active | needs_credentials). Use this
before bind_connector.py to pick an existing connector; register_connector.py mints
a new one when nothing fits.
"""

import json
import os

import boto3

REGION = os.environ.get("AWS_REGION", "us-east-1")
ARTIFACT_BUCKET = os.environ["ARTIFACT_BUCKET"]

s3 = boto3.client("s3", region_name=REGION)


def main():
    try:
        body = s3.get_object(Bucket=ARTIFACT_BUCKET, Key="config/connectors.json")["Body"].read()
        connectors = json.loads(body).get("connectors", [])
    except s3.exceptions.NoSuchKey:
        connectors = []

    print(json.dumps({
        "count": len(connectors),
        "connectors": [
            {
                "id": c.get("id"),
                "name": c.get("name"),
                "kind": c.get("kind"),
                "secretKeys": c.get("secretKeys", []),
                "status": c.get("status"),
            }
            for c in connectors
        ],
    }, indent=2))


if __name__ == "__main__":
    main()
