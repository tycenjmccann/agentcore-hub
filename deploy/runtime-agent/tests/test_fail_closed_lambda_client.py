"""TEAM-5715/TEAM-5720 — the fail-closed harness's Lambda calls fit inside the
cancel grace.

`_harness_fail_closed` runs on a worker thread, and a cancelled turn waits for it
for at most `_FAIL_CLOSED_CANCEL_GRACE_S` before publishing agent.died. Its ticket
calls used to go through the module `lambda_client` on botocore defaults (60 s read
timeout, legacy retries), so a park in flight at cancel could land after the death,
on the ticket of the re-dispatched invocation.

Now every call it makes, `_annotate`'s add_comment included, goes through
`_FAIL_CLOSED_LAMBDA_CLIENT`, whose worst case (attempts x (connect + read) plus
standard-mode backoff) is below the grace. TEAM-5720: that bound only holds if the
botocore `Config` actually produces the attempt count main.py assumes. Botocore's
client-config `max_attempts` means *retries*, not total attempts — `botocore/args.py`
`_compute_retry_max_attempts` pops it and sets `total_max_attempts = value + 1` — so
a config built with `{"max_attempts": 2}` makes 3 attempts, not 2, and blows the
grace (43s > 30s). main.py now sets `total_max_attempts` directly, so no +1 is
applied. The first test below builds a *real* boto3 client (no network: client
construction never calls out) from main.py's own module-scope code and reads its
normalised `client.meta.config`, so a reintroduced `max_attempts` key would be
caught here instead of only in production.

Both tests drive the shipped source: the config from main.py's module scope, and
the real `_invoke_lambda` + `Tickets___*` tools + `_harness_fail_closed` against
two recording clients.
"""

from __future__ import annotations

import ast
import io
import json
import threading
from typing import Any

import boto3
from botocore.config import Config as BotocoreConfig
from strands import tool

from test_telemetry_spans import MAIN_PY, _load_production_entrypoints, _module_scope_nodes

TICKET = "TEAM-5715"
EPIC = "TEAM-5000"
ESCALATION = "TEAM-5716"
TOOLS = ("Tickets___get_issue", "Tickets___list_tickets", "Tickets___create_ticket",
         "Tickets___transition_ticket", "Tickets___add_comment")
CONFIG_NAMES = ["_FAIL_CLOSED_CANCEL_GRACE_S", "_FAIL_CLOSED_CONNECT_TIMEOUT_S",
                "_FAIL_CLOSED_READ_TIMEOUT_S", "_FAIL_CLOSED_MAX_ATTEMPTS",
                "_FAIL_CLOSED_CALL_BUDGET_S", "_FAIL_CLOSED_LAMBDA_CONFIG",
                "_FAIL_CLOSED_LAMBDA_CLIENT"]
# botocore/retries/standard.py: ExponentialBackoff._MAX_BACKOFF and the
# retry-after allowance it adds on top (_RETRY_AFTER_MAX_ADDITIONAL).
_MAX_BACKOFF_S, _RETRY_AFTER_EXTRA_S = 20, 5


def _exec(names: list[str], namespace: dict[str, Any]) -> dict[str, Any]:
    tree = ast.parse(MAIN_PY.read_text())
    module = ast.Module(body=_module_scope_nodes(tree, names), type_ignores=[])
    exec(compile(module, str(MAIN_PY), "exec"), namespace)  # noqa: S102
    return namespace


def _worst_case_s(normalised_retries: dict, connect_timeout: float, read_timeout: float) -> float:
    """Worst-case wall time from a client's *normalised* `meta.config.retries`.

    `total_max_attempts` is what botocore will actually run — the key the client
    reports after `args.py` has applied its legacy `max_attempts` -> retries + 1
    translation, so this is correct regardless of which key main.py's Config used.
    """
    attempts = normalised_retries["total_max_attempts"]
    backoff = sum(min(2 ** (k - 1), _MAX_BACKOFF_S) + _RETRY_AFTER_EXTRA_S
                  for k in range(1, attempts))
    return attempts * (connect_timeout + read_timeout) + backoff


def test_fail_closed_client_is_bounded_inside_the_cancel_grace(monkeypatch) -> None:
    # Static creds so botocore's credential chain resolves locally instead of
    # probing IMDS/shared config — building a client never makes a network call
    # either way, but this keeps resolution instant and hermetic.
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "x")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "x")
    monkeypatch.delenv("AWS_SESSION_TOKEN", raising=False)

    ns = _exec(CONFIG_NAMES, {
        "BotocoreConfig": BotocoreConfig,
        "REGION": "us-east-1",
        "boto3": boto3,
    })

    client = ns["_FAIL_CLOSED_LAMBDA_CLIENT"]
    assert client is not None and client.meta.service_model.service_name == "lambda"
    retries = client.meta.config.retries
    # The real, botocore-normalised attempt count — not the Config kwarg main.py
    # passed in. This is what would have caught TEAM-5720: `max_attempts: 2` here
    # normalises to `total_max_attempts: 3`.
    assert retries["mode"] == "standard"
    assert retries["total_max_attempts"] == ns["_FAIL_CLOSED_MAX_ATTEMPTS"], (
        f"client will make {retries} total attempts, not the "
        f"{ns['_FAIL_CLOSED_MAX_ATTEMPTS']} main.py's budget assumes")
    assert client.meta.config.connect_timeout == ns["_FAIL_CLOSED_CONNECT_TIMEOUT_S"]
    assert client.meta.config.read_timeout == ns["_FAIL_CLOSED_READ_TIMEOUT_S"]

    worst = _worst_case_s(retries, client.meta.config.connect_timeout, client.meta.config.read_timeout)
    assert worst == ns["_FAIL_CLOSED_CALL_BUDGET_S"], (
        "main.py's own budget constant has drifted from what the real client will do: "
        f"budget says {ns['_FAIL_CLOSED_CALL_BUDGET_S']}s, real worst case is {worst}s")
    assert worst < ns["_FAIL_CLOSED_CANCEL_GRACE_S"], (
        "one fail-closed call, retries and backoff included, must return inside the grace: "
        f"worst case {worst}s >= grace {ns['_FAIL_CLOSED_CANCEL_GRACE_S']}s")


class _Client:
    """A recording Lambda client that answers like the ticket Lambdas."""

    def __init__(self, replies: dict[str, Any] | None = None, on_call=None) -> None:
        self.calls: list[str] = []
        self.replies = replies or {}
        self.on_call = on_call

    def invoke(self, FunctionName: str, Payload: bytes) -> dict:  # noqa: N803 — boto3's names
        event = json.loads(Payload)
        name = event["name"]
        self.calls.append(name)
        if self.on_call:
            self.on_call(name)
        reply = self.replies.get(name, {})
        if callable(reply):
            reply = reply(event["arguments"])
        text = reply if isinstance(reply, str) else json.dumps(reply)
        return {"Payload": io.BytesIO(json.dumps({"content": [{"type": "text", "text": text}]}).encode())}


def _issue(args: dict) -> dict:
    if args["ticket_id"] == TICKET:
        return {"key": TICKET, "fields": {"status": {"name": "In Progress"}, "parent": {"key": EPIC}}}
    return {"key": EPIC, "fields": {"issuetype": {"name": "Epic"}}}


REPLIES = {
    "Tickets___get_issue": _issue,
    "Tickets___list_tickets": {"issues": [], "complete": True},
    "Tickets___create_ticket": {"key": ESCALATION},
    # Refused, so the escalation is annotated: every tool is on the path.
    "Tickets___transition_ticket": "Error: status precondition failed (status is ready)",
    "Tickets___add_comment": {"ok": True},
}


def _harness(bounded: _Client, default: _Client) -> dict[str, Any]:
    ns = _load_production_entrypoints()
    # The real tools and the real _invoke_lambda, replacing the loader's stubs in
    # place: `_harness_fail_closed` resolves them through this same dict.
    ns.update({
        "json": json,
        "tool": tool,
        "_CURRENT_WORKFLOW_ID": "wf_fail_closed",
        "lambda_client": default,
        "_FAIL_CLOSED_LAMBDA_CLIENT": bounded,
    })
    return _exec(["TICKET_TOOLS_LAMBDA", "_CURRENT_CLAIM_STARTED_AT", "_invoke_lambda", *TOOLS], ns)


def test_every_fail_closed_call_uses_the_bounded_client() -> None:
    # Both answer alike, so the only difference the harness can make is which one it calls.
    bounded, default = _Client(REPLIES), _Client(REPLIES)
    ns = _harness(bounded, default)

    outcome = ns["_harness_fail_closed"]("wf_fail_closed", "agentcore_hub_backend_dev", TICKET,
                                         "prose only", epic_id=EPIC, cancel=threading.Event())

    assert default.calls == [], f"fail-closed calls on the unbounded client: {default.calls}"
    assert outcome == "skipped"
    assert set(bounded.calls) == set(TOOLS), f"not every fail-closed call was seen: {bounded.calls}"

    # The override is scoped to the harness: an ordinary tool call keeps the default.
    ns["Tickets___get_issue"](ticket_id=TICKET)
    assert default.calls == ["Tickets___get_issue"]


def test_the_cancelled_path_annotates_on_the_bounded_client() -> None:
    cancel = threading.Event()
    bounded = _Client(REPLIES, on_call=lambda name: name == "Tickets___create_ticket" and cancel.set())
    default = _Client(REPLIES, on_call=bounded.on_call)
    ns = _harness(bounded, default)

    outcome = ns["_harness_fail_closed"]("wf_fail_closed", "agentcore_hub_backend_dev", TICKET,
                                         "prose only", epic_id=EPIC, cancel=cancel)

    assert default.calls == [], f"fail-closed calls on the unbounded client: {default.calls}"
    assert outcome == ""
    assert "Tickets___transition_ticket" not in bounded.calls, "no park is started after cancel"
    assert bounded.calls[-1] == "Tickets___add_comment", "the escalation is still annotated"
