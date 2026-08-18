#!/usr/bin/env python3
"""Persist a routine record + create its EventBridge schedule. The ONLY write path
for routines from the builder — validation happens here so a malformed routine
never lands.

Usage:
  python3 save_routine.py --routine-file /mnt/workspace/routine.json

The routine file:
  {
    "name": "Weekly Ad Report",
    "description": "...",
    "workflowDefId": "routine-weekly-ad-report",
    "schedule": {"expression": "cron(0 9 ? * MON *)", "timezone": "America/Los_Angeles"},
    "input": {
      "titleTemplate": "Weekly Ad Report {date}",
      "description": "...",           # the prompt/brief the intake agent receives
      "workflowDefId": "routine-weekly-ad-report",
      "repoConfig": {...},            # optional (repo-touching routines)
      "sources": [],                  # optional intake sources
      "modelOverride": null           # optional
    },
    "enabled": true,
    "tenantId": "default"             # optional; defaults to "default"
  }

Env (set on the harness by setup-routine-builder.mjs):
  ROUTINES_TABLE, ROUTINES_RUNNER_ARN, ROUTINES_SCHEDULER_ROLE_ARN,
  ROUTINES_SCHEDULE_GROUP, ARTIFACT_BUCKET, AWS_REGION
"""

import argparse
import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone

import boto3

REGION = os.environ.get("AWS_REGION", "us-east-1")
TABLE = os.environ.get("ROUTINES_TABLE", "agentcore-hub-routines")
RUNNER_ARN = os.environ.get("ROUTINES_RUNNER_ARN", "")
SCHEDULER_ROLE_ARN = os.environ.get("ROUTINES_SCHEDULER_ROLE_ARN", "")
GROUP = os.environ.get("ROUTINES_SCHEDULE_GROUP", "agentcore-hub-routines")

ddb = boto3.resource("dynamodb", region_name=REGION)
scheduler = boto3.client("scheduler", region_name=REGION)


def fail(msg):
    raise SystemExit(f"VALIDATION FAILED: {msg}")


def validate(r):
    if not RUNNER_ARN or not SCHEDULER_ROLE_ARN:
        fail("ROUTINES_RUNNER_ARN and ROUTINES_SCHEDULER_ROLE_ARN must be set on the harness "
             "(run lambda/routines-runner/deploy.sh, then redeploy the harness).")
    for key in ("name", "workflowDefId", "schedule", "input"):
        if not r.get(key):
            fail(f"routine missing required field: {key}")
    sch = r["schedule"]
    if not isinstance(sch, dict) or not sch.get("expression"):
        fail("schedule.expression is required (rate(...) or cron(...))")
    expr = sch["expression"]
    if not (expr.startswith("rate(") or expr.startswith("cron(") or expr.startswith("at(")):
        fail("schedule.expression must be a rate(), cron(), or at() expression")
    inp = r["input"]
    if not inp.get("titleTemplate") or not inp.get("workflowDefId"):
        fail("input.titleTemplate and input.workflowDefId are required")


def upsert_schedule(routine_id, schedule, enabled):
    name = f"routine-{routine_id}"
    kwargs = dict(
        Name=name,
        GroupName=GROUP,
        ScheduleExpression=schedule["expression"],
        ScheduleExpressionTimezone=schedule.get("timezone", "UTC"),
        State="ENABLED" if enabled else "DISABLED",
        FlexibleTimeWindow={"Mode": "OFF"},
        Target={
            "Arn": RUNNER_ARN,
            "RoleArn": SCHEDULER_ROLE_ARN,
            "Input": json.dumps({"routineId": routine_id}),
        },
    )
    try:
        scheduler.get_schedule(Name=name, GroupName=GROUP)
        scheduler.update_schedule(**kwargs)
    except scheduler.exceptions.ResourceNotFoundException:
        try:
            scheduler.create_schedule(**kwargs)
        except scheduler.exceptions.ResourceNotFoundException:
            # Schedule group missing — create it once, then the schedule.
            scheduler.create_schedule_group(Name=GROUP)
            scheduler.create_schedule(**kwargs)
    account = RUNNER_ARN.split(":")[4]
    return f"arn:aws:scheduler:{REGION}:{account}:schedule/{GROUP}/{name}"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--routine-file", required=True)
    args = p.parse_args()

    with open(args.routine_file) as f:
        r = json.load(f)
    validate(r)

    routine_id = f"rt-{uuid.uuid4().hex}"
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    enabled = r.get("enabled", True)
    schedule = {"expression": r["schedule"]["expression"], "timezone": r["schedule"].get("timezone", "UTC")}

    schedule_arn = upsert_schedule(routine_id, schedule, enabled)

    item = {
        "routineId": routine_id,
        "tenantId": r.get("tenantId", "default"),
        "name": r["name"],
        "description": r.get("description"),
        "workflowDefId": r["workflowDefId"],
        "schedule": schedule,
        "scheduleArn": schedule_arn,
        "input": r["input"],
        "enabled": enabled,
        "createdBy": "routine-builder",
        "createdAt": now,
        "updatedAt": now,
    }
    item = {k: v for k, v in item.items() if v is not None}
    ddb.Table(TABLE).put_item(Item=item)

    print(json.dumps({
        "saved": True,
        "routineId": routine_id,
        "scheduleArn": schedule_arn,
        "enabled": enabled,
    }, indent=2))


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        print(str(e), file=sys.stderr)
        raise
