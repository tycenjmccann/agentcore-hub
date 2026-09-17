"""
Shared helpers for the online-evaluation-config operator scripts in this
directory (set-log-group-prefixes.py, audit-eval-matrix.py).

Three things every one of them has to get right:

1. **Region.** boto3 ignores AWS_REGION when the active profile carries its own
   region (tycenj-prod resolves to us-west-2 and returns zero configs), so the
   region is always passed explicitly.
2. **Account guard.** These scripts write to whatever account the ambient
   credentials resolve to. The expected account must come from a source
   INDEPENDENT of those credentials or the check is tautological, so it is read
   from --expect-account, then $EXPECTED_ACCOUNT_ID, then EXPECTED_ACCOUNT_ID in
   the gitignored repo-root .env.local that deploy/config.sh sources. Never from
   `aws sts get-caller-identity` — that is the value being guarded.
3. **Async updates.** UpdateOnlineEvaluationConfig returns while status is
   UPDATING and can land on UPDATE_FAILED/ERROR afterwards, and a read in the
   meantime echoes the REQUESTED shape. Nothing counts as applied until the
   config settles ACTIVE.
"""
from __future__ import annotations

import os
import shlex
import sys
import time

import boto3
import botocore.session

REGION = os.environ.get("AWS_REGION", "us-east-1")
ENV_LOCAL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".env.local")

TERMINAL_BAD = {"UPDATE_FAILED", "CREATE_FAILED", "ERROR", "DELETING"}
SETTLE_TIMEOUT_S = 180
SETTLE_POLL_S = 5


def expected_account_from_env_local(path: str = ENV_LOCAL) -> str | None:
    """Read EXPECTED_ACCOUNT_ID out of .env.local without executing the file."""
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return None
    value = None
    for raw in lines:
        line = raw.strip()
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if not line.startswith("EXPECTED_ACCOUNT_ID=") or line.startswith("#"):
            continue
        # Last assignment wins, matching how a shell would source the file. shlex
        # handles quoting and trailing comments in one pass — stripping quotes and
        # "#" separately gets `'123456789012'  # prod` wrong.
        try:
            parts = shlex.split(line.split("=", 1)[1], comments=True)
        except ValueError:
            continue
        value = parts[0] if parts else None
    return value or None


def default_expected_account() -> str | None:
    return os.environ.get("EXPECTED_ACCOUNT_ID") or expected_account_from_env_local()


def add_common_args(ap) -> None:
    ap.add_argument("--apply", action="store_true", help="write the change (default: dry-run)")
    ap.add_argument(
        "--expect-account",
        default=default_expected_account(),
        help="account id the credentials must resolve to (default: $EXPECTED_ACCOUNT_ID, else "
        "EXPECTED_ACCOUNT_ID in the gitignored .env.local that deploy/config.sh sources); "
        "skips the --apply confirmation prompt",
    )


def sdk_supports(shape: str, member: str) -> bool:
    model = botocore.session.get_session().get_service_model("bedrock-agentcore-control")
    return member in model.shape_for(shape).members


def guard_account(apply: bool, expect_account: str | None) -> tuple[str, int | None]:
    """Return (account, exit_code). exit_code is not None when the caller must abort."""
    identity = boto3.client("sts", region_name=REGION).get_caller_identity()
    account = identity["Account"]
    if expect_account and expect_account != account:
        print(f"ERROR: credentials resolve to account {account}, expected {expect_account} — refusing.")
        return account, 2
    if apply and not expect_account:
        print(f"About to UPDATE online evaluation configs in account {account}, region {REGION}")
        print(f"  caller: {identity['Arn']}")
        if not sys.stdin.isatty():
            print(
                "ERROR: --apply needs a TTY to confirm, or an expected account from a source independent "
                "of these credentials ($EXPECTED_ACCOUNT_ID or --expect-account). Refusing."
            )
            return account, 2
        if input("Type the account id to continue: ").strip() != account:
            print("account id did not match — nothing was changed.")
            return account, 2
    print(f"account {account} / region {REGION}\n")
    return account, None


def list_configs(control) -> list[dict]:
    out, token = [], None
    while True:
        kw = {"maxResults": 50}
        if token:
            kw["nextToken"] = token
        page = control.list_online_evaluation_configs(**kw)
        out.extend(page.get("onlineEvaluationConfigs", []))
        token = page.get("nextToken")
        if not token:
            return out


def select_configs(control, config_ids: list[str], account: str) -> tuple[list[dict], int | None]:
    """All configs, or just `config_ids`. A misspelled/deleted id aborts rather
    than being silently dropped — that would look like the config was handled."""
    configs = list_configs(control)
    if config_ids:
        live = {c["onlineEvaluationConfigId"] for c in configs}
        unknown = [cid for cid in config_ids if cid not in live]
        if unknown:
            print(f"ERROR: no such online evaluation config in account {account}: {unknown}")
            return [], 2
        configs = [c for c in configs if c["onlineEvaluationConfigId"] in set(config_ids)]
    if not configs:
        print("no online evaluation configs found")
        return [], 1
    return configs, None


def wait_settled(control, cid: str) -> dict:
    """Poll until status leaves UPDATING. Raises on a terminal failure/timeout."""
    deadline = time.monotonic() + SETTLE_TIMEOUT_S
    while True:
        cfg = control.get_online_evaluation_config(onlineEvaluationConfigId=cid)
        status = cfg.get("status")
        if status in TERMINAL_BAD:
            raise RuntimeError(f"status={status} failureReason={cfg.get('failureReason') or '(none)'}")
        if status == "ACTIVE":
            return cfg
        if time.monotonic() >= deadline:
            raise RuntimeError(f"still {status} after {SETTLE_TIMEOUT_S}s — check the console before re-running")
        time.sleep(SETTLE_POLL_S)
