#!/usr/bin/env python3
"""
set-log-group-prefixes.py — switch every online evaluation config from an exact
runtime log group name to a log-group-name PREFIX, and touch nothing else.

Why: a config created with `logGroupNames` pins the runtime's account-generated
id ("/aws/bedrock-agentcore/runtimes/<name>-<id>-DEFAULT"). Recreate the runtime
and the config keeps watching the dead log group — the judge goes dark with no
error anywhere (that was the shape of the Aug 31 -> Sep 14 gap). With
`logGroupNamePrefixes` ("/aws/bedrock-agentcore/runtimes/<name>-") the config
follows the runtime through recreation; `serviceNames` still narrows the traces.

Only `dataSourceConfig` is sent to UpdateOnlineEvaluationConfig. The update is
asynchronous, so the script polls until `status` leaves UPDATING and aborts on
UPDATE_FAILED/ERROR (an immediate read echoes the REQUESTED data source and
would report success for an update that later failed). Once settled, evaluators,
sampling rule, output config and role are asserted unchanged — see the "eval
matrix trim" incident for why that guard exists.

Prefix derivation is deliberately strict: a log group that is not shaped like a
runtime log group (`<name>-<10 alnum>-<endpoint>`) is refused, not guessed at,
and a prefix is refused if any EXISTING log group it matches belongs to a
different runtime name (e.g. "<name>_v2-..."). The trailing "-" is what keeps
"agentcore_hub_coding_runtime-" from matching "agentcore_hub_coding_runtime_ec2-".

Only hub-owned configs (`eval_agentcore_hub_*`) are touched; another
application's configs in the same account are listed and skipped unless
--include-unowned is passed. Needs boto3 >= 1.43.96 (the first release whose CloudWatchLogsInputConfig has
`logGroupNamePrefixes`); the script refuses to run on an older SDK. See
eval_config_lib.py for the region, account-guard and settle rules.

Usage (prod profile; dry-run by default):
  AWS_PROFILE=tycenj-prod AWS_REGION=us-east-1 python3 deploy/evaluations/set-log-group-prefixes.py
  AWS_PROFILE=tycenj-prod AWS_REGION=us-east-1 python3 deploy/evaluations/set-log-group-prefixes.py --apply
  EXPECTED_ACCOUNT_ID=... ... --apply            # asserted, no prompt (CI/scripted)
  ... --config-id eval_agentcore_hub_agent-XXXX  # limit to these configs
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

import boto3

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from eval_config_lib import (  # noqa: E402
    REGION,
    add_common_args,
    guard_account,
    sdk_supports,
    select_configs,
    wait_settled,
)

RUNTIME_LG_PREFIX = "/aws/bedrock-agentcore/runtimes/"
# <prefix><runtime-name>-<10-char account id>-<endpoint>
RUNTIME_LG_RE = re.compile(
    r"^(?P<base>/aws/bedrock-agentcore/runtimes/(?P<name>[A-Za-z0-9_]+))-[A-Za-z0-9]{10}-[A-Za-z0-9_]+$"
)
MAX_PREFIXES = 5


def list_runtime_log_groups(logs) -> list[str]:
    names = []
    for page in logs.get_paginator("describe_log_groups").paginate(logGroupNamePrefix=RUNTIME_LG_PREFIX):
        names.extend(g["logGroupName"] for g in page.get("logGroups", []))
    return names


def derive_prefixes(log_group_names: list[str]) -> tuple[list[str], str | None]:
    """Return (prefixes, error). Error is set if any name is not runtime-shaped."""
    prefixes: list[str] = []
    for lg in log_group_names:
        m = RUNTIME_LG_RE.match(lg)
        if not m:
            return [], f"not a runtime log group, refusing to guess a prefix: {lg}"
        p = m.group("base") + "-"
        if p not in prefixes:
            prefixes.append(p)
    if len(prefixes) > MAX_PREFIXES:
        return [], f"{len(prefixes)} prefixes > API max {MAX_PREFIXES}"
    return prefixes, None


def collision(prefix: str, all_groups: list[str]) -> list[str]:
    """Existing groups the prefix matches that belong to a different runtime name."""
    want = RUNTIME_LG_RE.match(prefix + "XXXXXXXXXX-DEFAULT").group("name")
    bad = []
    for lg in all_groups:
        if not lg.startswith(prefix):
            continue
        m = RUNTIME_LG_RE.match(lg)
        if not m or m.group("name") != want:
            bad.append(lg)
    return bad


def snapshot(cfg: dict) -> dict:
    """The fields that must NOT change when only the data source is updated."""
    return {
        "evaluators": sorted(e["evaluatorId"] for e in cfg.get("evaluators", [])),
        "rule": cfg.get("rule"),
        "outputConfig": cfg.get("outputConfig"),
        "evaluationExecutionRoleArn": cfg.get("evaluationExecutionRoleArn"),
        "executionStatus": cfg.get("executionStatus"),
        "serviceNames": cfg["dataSourceConfig"]["cloudWatchLogs"].get("serviceNames"),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_common_args(ap)
    ap.add_argument("--config-id", action="append", default=[], help="limit to these config ids")
    args = ap.parse_args()

    if not sdk_supports("CloudWatchLogsInputConfig", "logGroupNamePrefixes"):
        print("ERROR: this boto3/botocore predates logGroupNamePrefixes. pip install -U boto3 (>= 1.43.96) and re-run.")
        return 2

    account, rc = guard_account(args.apply, args.expect_account)
    if rc is not None:
        return rc

    control = boto3.client("bedrock-agentcore-control", region_name=REGION)
    logs = boto3.client("logs", region_name=REGION)
    all_groups = list_runtime_log_groups(logs)

    configs, rc = select_configs(control, args.config_id, account, args.include_unowned)
    if rc is not None:
        return rc

    changed = skipped = refused = 0
    for summary in configs:
        cid = summary["onlineEvaluationConfigId"]
        before = control.get_online_evaluation_config(onlineEvaluationConfigId=cid)
        cw = before.get("dataSourceConfig", {}).get("cloudWatchLogs")
        if not cw:
            print(f"↷ {cid}: data source is not CloudWatch Logs — skipping")
            skipped += 1
            continue
        if cw.get("logGroupNamePrefixes") and not cw.get("logGroupNames"):
            # GetOnlineEvaluationConfig echoes the REQUESTED data source even while
            # an update is UPDATING or after it ended UPDATE_FAILED, so "it already
            # has prefixes" is not on its own proof the migration took. Settle first.
            if before.get("status") != "ACTIVE":
                try:
                    before = wait_settled(control, cid)
                except RuntimeError as exc:
                    print(f"✗ {cid}: reports prefixes but never settled ACTIVE: {exc}")
                    print("   treat this config as UNMIGRATED — the judge may still be on the old exact log group")
                    refused += 1
                    continue
            print(f"✓ {cid}: already on prefixes {cw['logGroupNamePrefixes']}")
            skipped += 1
            continue

        prefixes, err = derive_prefixes(cw.get("logGroupNames", []))
        if err:
            print(f"✗ {cid}: {err}")
            refused += 1
            continue
        bad = [lg for p in prefixes for lg in collision(p, all_groups)]
        if bad:
            print(f"✗ {cid}: prefix would also match another runtime's log group(s): {bad}")
            refused += 1
            continue

        matched = sorted(lg for p in prefixes for lg in all_groups if lg.startswith(p))
        print(f"→ {cid} [{before.get('executionStatus')}]")
        print(f"    from logGroupNames      = {cw['logGroupNames']}")
        print(f"    to   logGroupNamePrefixes = {prefixes}")
        print(f"    currently matches       = {matched}")

        if not args.apply:
            continue

        control.update_online_evaluation_config(
            onlineEvaluationConfigId=cid,
            dataSourceConfig={
                "cloudWatchLogs": {"logGroupNamePrefixes": prefixes, "serviceNames": cw["serviceNames"]}
            },
        )
        try:
            after = wait_settled(control, cid)
        except RuntimeError as exc:
            print(f"    ✗ update did not settle ACTIVE: {exc}")
            print("      the judge may still be on the old exact log group — do NOT assume this config migrated")
            return 3
        if snapshot(before) != snapshot(after):
            print("    ✗ OTHER FIELDS CHANGED — inspect immediately:")
            print("      before:", json.dumps(snapshot(before), default=str))
            print("      after: ", json.dumps(snapshot(after), default=str))
            return 3
        got = after["dataSourceConfig"]["cloudWatchLogs"]
        if got.get("logGroupNamePrefixes") != prefixes or got.get("logGroupNames"):
            print(f"    ✗ data source did not land as requested: {json.dumps(got)}")
            return 3
        print("    ✓ applied; evaluators/rule/output/role/status unchanged")
        changed += 1

    mode = "applied" if args.apply else "would change"
    print(f"\n{mode}: {changed if args.apply else len(configs) - skipped - refused}  already-prefix/skipped: {skipped}  refused: {refused}")
    return 1 if refused else 0


if __name__ == "__main__":
    sys.exit(main())
