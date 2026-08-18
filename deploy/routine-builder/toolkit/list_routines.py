#!/usr/bin/env python3
"""List existing routines so the builder can avoid duplicates and reference or edit
prior work.

Usage: python3 list_routines.py [--tenant default]

Reads the ROUTINES_TABLE and prints a compact JSON list.
"""

import argparse
import json
import os
from decimal import Decimal

import boto3

REGION = os.environ.get("AWS_REGION", "us-east-1")
TABLE = os.environ.get("ROUTINES_TABLE", "agentcore-hub-routines")

ddb = boto3.resource("dynamodb", region_name=REGION)


def undecimal(obj):
    if isinstance(obj, Decimal):
        return int(obj) if obj % 1 == 0 else float(obj)
    if isinstance(obj, dict):
        return {k: undecimal(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [undecimal(v) for v in obj]
    return obj


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--tenant", default=None)
    args = p.parse_args()

    items = []
    scan_kwargs = {}
    while True:
        resp = ddb.Table(TABLE).scan(**scan_kwargs)
        items.extend(resp.get("Items", []))
        if "LastEvaluatedKey" not in resp:
            break
        scan_kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]

    out = []
    for r in items:
        if args.tenant and r.get("tenantId", "default") != args.tenant:
            continue
        out.append({
            "routineId": r.get("routineId"),
            "name": r.get("name"),
            "workflowDefId": r.get("workflowDefId"),
            "schedule": undecimal(r.get("schedule")),
            "enabled": r.get("enabled", True),
            "lastRun": undecimal(r.get("lastRun")),
        })

    print(json.dumps({"routines": out}, indent=2))


if __name__ == "__main__":
    main()
