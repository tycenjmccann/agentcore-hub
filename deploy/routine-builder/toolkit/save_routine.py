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
      "modelOverride": null           # optional — catalog id, alias or Claude tier word
    },
    "enabled": true,
    "tenantId": "default"             # optional; defaults to "default"
  }

input.modelOverride, when present, must name a model in config/models.json (a
catalog id, a row alias or a Claude tier word like "opus"); it is stored as the
resolved catalog id. Anything else — a typo, a retired, quarantined, unpriced or
read-only row, an openAiModelConfig object — is refused here.

Env (set on the harness by setup-routine-builder.mjs):
  ROUTINES_TABLE, ROUTINES_RUNNER_ARN, ROUTINES_SCHEDULER_ROLE_ARN,
  ROUTINES_SCHEDULE_GROUP, ARTIFACT_BUCKET, AWS_REGION
"""

import argparse
import json
import os
import re
import sys
import time
import uuid
from datetime import datetime, timezone

import boto3

# A byte-identical copy of deploy/runtime-agent/models_registry.py, shipped in
# this toolkit dir (so sys.path[0] finds it) — pinned by
# scripts/check-models-registry-parity.sh. Never edit it here.
import models_registry

REGION = os.environ.get("AWS_REGION", "us-east-1")
TABLE = os.environ.get("ROUTINES_TABLE", "agentcore-hub-routines")
RUNNER_ARN = os.environ.get("ROUTINES_RUNNER_ARN", "")
SCHEDULER_ROLE_ARN = os.environ.get("ROUTINES_SCHEDULER_ROLE_ARN", "")
GROUP = os.environ.get("ROUTINES_SCHEDULE_GROUP", "agentcore-hub-routines")
DLQ_ARN = os.environ.get("ROUTINES_DLQ_ARN", "")

# One fire per hour max — each fire launches a full LLM pipeline. Mirrors
# validateScheduleFloor in src/lib/routines/cron.ts.
MIN_INTERVAL_MINUTES = 60

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
    floor_err = schedule_floor_error(expr)
    if floor_err:
        fail(floor_err)
    inp = r["input"]
    if not inp.get("titleTemplate") or not inp.get("workflowDefId"):
        fail("input.titleTemplate and input.workflowDefId are required")
    if "modelOverride" in inp:
        _check_model_override(inp)


def _check_model_override(inp):
    """Resolve input.modelOverride against the registry, in place, or fail.

    The override is forwarded verbatim to /api/workflow/start on every fire, and
    that front door 400s a typo, a retired id or a read-only row — so a routine
    saved with a bad one fails silently on its schedule forever (TEAM-5016 F6).
    Same rules, same reason words as the hub's guard
    (src/lib/routines/model-override.ts)."""
    value = inp["modelOverride"]
    if value is None or (isinstance(value, str) and not value.strip()):
        # "Use the configured default": store nothing, as the hub does. main()'s
        # None filter is top-level only, so a null here would be persisted.
        del inp["modelOverride"]
        return
    # Read only now — an S3 GET must not be the price of a routine with no override.
    registry = models_registry.load_registry()
    if registry is None:
        # FAIL CLOSED. The hub falls back to its bundled seed here; this harness
        # ships no seed, and persisting an unvalidated override is the very bug
        # this check exists to stop (TEAM-5019).
        fail("input.modelOverride cannot be validated: config/models.json in "
             f"s3://{os.environ.get('ARTIFACT_BUCKET', '')} is unreadable or invalid. "
             "Retry, or omit modelOverride so the routine runs on the configured default.")
    verdict = models_registry.validate_model_override(registry, value)
    if not verdict["ok"]:
        fail(f"invalid_model_override reason={verdict['reason']} modelOverride={json.dumps(value)}")
    # The NORMALIZED string, for both shapes: a routine's override is a string
    # (RoutineInputTemplate), and the front door re-resolves it at fire time.
    inp["modelOverride"] = verdict["modelId"]


def schedule_floor_error(expression):
    """Reject sub-hourly schedules. Mirrors validateScheduleFloor in cron.ts.
    Returns an error string, or None if acceptable."""
    expr = expression.strip()
    m = re.match(r"^rate\(\s*(\d+)\s+(minute|minutes|hour|hours|day|days)\s*\)$", expr, re.I)
    if m:
        n, unit = int(m.group(1)), m.group(2).lower()
        minutes = n if unit.startswith("minute") else n * 60 if unit.startswith("hour") else n * 1440
        if minutes < MIN_INTERVAL_MINUTES:
            return f"schedule fires every {minutes} min; minimum is {MIN_INTERVAL_MINUTES} min (one fire per hour)"
        return None
    m = re.match(r"^cron\((.+)\)$", expr, re.I)
    if m:
        parts = m.group(1).strip().split()
        minute = parts[0] if parts else ""
        if minute == "*" or any(c in minute for c in "/,-"):
            return "sub-hourly cron schedules are not allowed; use a fixed minute (one fire per hour max)"
        return None
    if expr.startswith("at("):
        return None  # one-shot, no recurrence
    return f"unrecognized schedule expression: {expression}"


def upsert_schedule(routine_id, schedule, enabled):
    name = f"routine-{routine_id}"
    # Bound the retry storm: EventBridge Scheduler defaults to 185 retries over 24h,
    # which would relaunch the same full pipeline repeatedly on a slow/failed fire.
    # Parity with src/lib/routines/schedule.ts.
    target = {
        "Arn": RUNNER_ARN,
        "RoleArn": SCHEDULER_ROLE_ARN,
        "Input": json.dumps({"routineId": routine_id}),
        "RetryPolicy": {"MaximumRetryAttempts": 2, "MaximumEventAgeInSeconds": 300},
    }
    if DLQ_ARN:
        target["DeadLetterConfig"] = {"Arn": DLQ_ARN}
    kwargs = dict(
        Name=name,
        GroupName=GROUP,
        ScheduleExpression=schedule["expression"],
        ScheduleExpressionTimezone=schedule.get("timezone", "UTC"),
        State="ENABLED" if enabled else "DISABLED",
        FlexibleTimeWindow={"Mode": "OFF"},
        Target=target,
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
