#!/usr/bin/env python3
"""
audit-eval-matrix.py — report (and optionally repair) online evaluation configs
that have drifted from the operator-approved 10-evaluator matrix.

The matrix is 10 evaluators per config, the API maximum:

  9 built-ins  ToolSelectionAccuracy, ToolParameterAccuracy, InstructionFollowing,
               Correctness, Coherence, Faithfulness, Helpfulness,
               ResponseRelevance, GoalSuccessRate
  10th slot    the custom dependency-chain evaluator for the roles that CREATE the
               ticket dependency graph (requirements_analyst and the shared
               runtime that hosts it), Builtin.Conciseness for everyone else

Both halves are read from setup-evaluations.sh (CUSTOM_EVALUATOR, TICKET_AGENTS)
so this script cannot drift from the script that creates the configs.

Why it exists: configs are created once and then diverge silently. Real drift this
caught in prod on 2026-09-17 — a config created during the never-approved
10-to-5 evaluator trim was still running 5 evaluators, and two harness configs
carried a SUPERSEDED custom dependency-chain evaluator they are out of scope for,
which both scored them against a rubric they cannot satisfy and kept the old
evaluator locked against deletion.

Repair sends ONLY `evaluators`, then asserts data source, sampling rule, output
config, role and execution status came back unchanged. It refuses to reduce a
config's evaluator count — shrinking the matrix is an operator decision, never a
side effect of a repair (see the "eval matrix trim never approved" incident).

Note: attaching a custom evaluator LOCKS it (no update, no delete while any
enabled config references it). Detaching the superseded one is what makes it
deletable.

Usage (prod profile; dry-run by default):
  AWS_PROFILE=tycenj-prod AWS_REGION=us-east-1 python3 deploy/evaluations/audit-eval-matrix.py
  AWS_PROFILE=tycenj-prod AWS_REGION=us-east-1 python3 deploy/evaluations/audit-eval-matrix.py --apply
  EXPECTED_ACCOUNT_ID=... ... --apply            # asserted, no prompt (CI/scripted)
  ... --config-id eval_agentcore_hub_builder-XXXX
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
    list_evaluator_ids,
    select_configs,
    wait_settled,
)

SETUP_SH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "setup-evaluations.sh")

BUILTIN_NINE = [
    "Builtin.ToolSelectionAccuracy",
    "Builtin.ToolParameterAccuracy",
    "Builtin.InstructionFollowing",
    "Builtin.Correctness",
    "Builtin.Coherence",
    "Builtin.Faithfulness",
    "Builtin.Helpfulness",
    "Builtin.ResponseRelevance",
    "Builtin.GoalSuccessRate",
]
FALLBACK_TENTH = "Builtin.Conciseness"
MATRIX_SIZE = 10


def read_setup_sh() -> tuple[str, set[str]]:
    """(CUSTOM_EVALUATOR, {config names that get it}) straight out of setup-evaluations.sh."""
    with open(SETUP_SH, encoding="utf-8") as fh:
        text = fh.read()
    m = re.search(r'^CUSTOM_EVALUATOR="([^"]+)"', text, re.M)
    t = re.search(r'^TICKET_AGENTS="([^"]+)"', text, re.M)
    if not m or not t:
        raise RuntimeError(f"could not read CUSTOM_EVALUATOR / TICKET_AGENTS from {SETUP_SH}")
    return m.group(1), {f"eval_{name}" for name in t.group(1).split()}


def target_matrix(config_name: str, custom: str, ticket_configs: set[str], custom_present: bool) -> list[str]:
    """9 built-ins + the tenth slot.

    setup-evaluations.sh deliberately creates ticket-agent configs with
    Builtin.Conciseness when the custom dependency-chain evaluator is absent from
    the account, so demanding the custom id unconditionally would report a valid
    freshly provisioned deployment as drifted and then refuse to repair it. The
    absence has to be CONFIRMED (a fully paginated list that genuinely lacks it),
    never inferred from a failed read.
    """
    tenth = custom if (config_name in ticket_configs and custom_present) else FALLBACK_TENTH
    return BUILTIN_NINE + [tenth]


def snapshot(cfg: dict) -> dict:
    """The fields that must NOT change when only the evaluator list is updated."""
    return {
        "dataSourceConfig": cfg.get("dataSourceConfig"),
        "rule": cfg.get("rule"),
        "outputConfig": cfg.get("outputConfig"),
        "evaluationExecutionRoleArn": cfg.get("evaluationExecutionRoleArn"),
        "executionStatus": cfg.get("executionStatus"),
    }


def short(evaluator_ids) -> str:
    return ", ".join(sorted(e.replace("Builtin.", "") for e in evaluator_ids))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_common_args(ap)
    ap.add_argument("--config-id", action="append", default=[], help="limit to these config ids")
    args = ap.parse_args()

    custom, ticket_configs = read_setup_sh()

    account, rc = guard_account(args.apply, args.expect_account)
    if rc is not None:
        return rc

    control = boto3.client("bedrock-agentcore-control", region_name=REGION)

    # Let a failed/incomplete read raise: treating it as "the evaluator is gone"
    # would quietly swap the dependency-chain check for a built-in.
    known_evaluators = list_evaluator_ids(control)
    custom_present = custom in known_evaluators
    tenth_for_ticket = custom if custom_present else f"{FALLBACK_TENTH} (custom evaluator absent from account)"
    print(f"matrix: 9 built-ins + {tenth_for_ticket} for {sorted(ticket_configs)}, else {FALLBACK_TENTH}\n")

    configs, rc = select_configs(control, args.config_id, account, args.include_unowned)
    if rc is not None:
        return rc

    ok = repaired = drifted = refused = 0
    for summary in configs:
        cid = summary["onlineEvaluationConfigId"]
        before = control.get_online_evaluation_config(onlineEvaluationConfigId=cid)
        name = before["onlineEvaluationConfigName"]
        want = target_matrix(name, custom, ticket_configs, custom_present)

        # GetOnlineEvaluationConfig echoes the REQUESTED evaluator list while an
        # update is UPDATING and after one ended UPDATE_FAILED, so a matching list
        # is not on its own proof the matrix landed. Settle before reporting.
        if before.get("status") != "ACTIVE":
            try:
                before = wait_settled(control, cid)
            except RuntimeError as exc:
                print(f"✗ {name}: never settled ACTIVE: {exc}")
                print("   its evaluator list is unverifiable — re-run the audit once the config settles")
                refused += 1
                continue

        have = {e["evaluatorId"] for e in before.get("evaluators", [])}
        missing, extra = set(want) - have, have - set(want)

        if not missing and not extra:
            print(f"ok    {name}  ({len(have)} evaluators)")
            ok += 1
            continue

        drifted += 1
        print(f"DRIFT {name}  [{before.get('executionStatus')}, {len(have)} evaluators]")
        if missing:
            print(f"    add    {short(missing)}")
        if extra:
            print(f"    remove {short(extra)}")

        if len(want) < len(have):
            print(f"    ✗ refusing: target has {len(want)} evaluators, config has {len(have)} — "
                  "shrinking the matrix is an operator decision, not a repair")
            refused += 1
            continue
        unknown = [e for e in want if e not in known_evaluators and not e.startswith("Builtin.")]
        if unknown:
            print(f"    ✗ refusing: evaluator(s) not present in account {account}: {unknown}")
            refused += 1
            continue
        if not args.apply:
            continue

        control.update_online_evaluation_config(
            onlineEvaluationConfigId=cid,
            evaluators=[{"evaluatorId": e} for e in want],
        )
        try:
            after = wait_settled(control, cid)
        except RuntimeError as exc:
            print(f"    ✗ update did not settle ACTIVE: {exc}")
            print("      do NOT assume the matrix changed — re-run the audit before touching anything else")
            return 3
        if snapshot(before) != snapshot(after):
            print("    ✗ OTHER FIELDS CHANGED — inspect immediately:")
            print("      before:", json.dumps(snapshot(before), default=str))
            print("      after: ", json.dumps(snapshot(after), default=str))
            return 3
        landed = {e["evaluatorId"] for e in after.get("evaluators", [])}
        if landed != set(want):
            print(f"    ✗ evaluators did not land as requested: {short(landed)}")
            return 3
        print(f"    ✓ repaired to {len(want)} evaluators; data source/rule/output/role/status unchanged")
        repaired += 1

    tail = f"repaired: {repaired}" if args.apply else f"would repair: {drifted - refused}"
    print(f"\nmatching: {ok}  drifted: {drifted}  {tail}  refused: {refused}")
    return 1 if (refused or (drifted and not args.apply)) else 0


if __name__ == "__main__":
    sys.exit(main())
