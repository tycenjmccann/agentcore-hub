"""DL-024 — `Tickets___transition_ticket` must forward `blocked_by` (CSV → list)
when the agent supplies it, and send a byte-identical payload when it doesn't.

This is the verb behind the agent self-park contract: after filing fix tickets an
agent parks ITS OWN ticket `blocked` with `blocked_by` = those tickets and exits
without report_completion; the cascade re-Readies it when they close. If the
harness dropped the field, the ticket would park with no blockers and never be
re-woken; if it always sent it (as []), the ticket Lambdas could not tell "no
blocker change" from "clear my blockers".

main.py cannot be imported (module top-level installs Node.js, fetches from S3,
chdirs), so — matching test_create_ticket_tool.py — the REAL shipped function is
located with `ast` and exec'd in isolation against a stub `_invoke_lambda`.
"""

import ast
import textwrap
from pathlib import Path

import pytest

MAIN_PY = Path(__file__).resolve().parent.parent / "main.py"
TOOL_NAME = "Tickets___transition_ticket"


def _transition_ticket(current_ticket="", claim_started_at="", workflow_id="unknown"):
    source = MAIN_PY.read_text()
    tree = ast.parse(source)
    fn_node = next(
        (
            n
            for n in tree.body
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == TOOL_NAME
        ),
        None,
    )
    assert fn_node is not None, f"{TOOL_NAME} function def not found in main.py"
    src = textwrap.dedent(ast.get_source_segment(source, fn_node))

    calls = []

    def _invoke_lambda(lambda_name, tool, payload):
        calls.append((lambda_name, tool, payload))
        return "ok"

    ns = {
        "_invoke_lambda": _invoke_lambda,
        "TICKET_TOOLS_LAMBDA": "agentcore-hub-jira",
        # TEAM-5719: the module globals the entrypoint sets per invocation.
        "_CURRENT_TICKET_ID": current_ticket,
        "_CURRENT_CLAIM_STARTED_AT": claim_started_at,
        # TEAM-5716: the dispatch's workflow ("unknown" is the module default).
        "_CURRENT_WORKFLOW_ID": workflow_id,
    }
    exec(compile(src, str(MAIN_PY), "exec"), ns)
    return ns[TOOL_NAME], calls


def _payload(**kwargs):
    fn, calls = _transition_ticket()
    fn(**{"ticket_id": "TEAM-24", "transition_id": "blocked", **kwargs})
    assert len(calls) == 1
    assert calls[0][1] == TOOL_NAME
    return calls[0][2]


PRE_DL024_PAYLOAD = {"ticket_id": "TEAM-24", "transition_id": "blocked", "reason": ""}


def test_blocked_by_csv_becomes_a_trimmed_list():
    payload = _payload(reason="ship-review r1: waiting on 2 fixes", blocked_by=" TEAM-30, TEAM-31 ,,")
    assert payload["blocked_by"] == ["TEAM-30", "TEAM-31"]
    assert payload["reason"] == "ship-review r1: waiting on 2 fixes"


def test_single_key_is_a_one_element_list():
    assert _payload(blocked_by="TEAM-99")["blocked_by"] == ["TEAM-99"]


@pytest.mark.parametrize("blank", ["", "   ", ",", " , "])
def test_blank_blocked_by_is_omitted_entirely(blank):
    assert _payload(blocked_by=blank) == PRE_DL024_PAYLOAD


def test_omitted_blocked_by_gives_the_pre_dl024_payload_exactly():
    assert _payload() == PRE_DL024_PAYLOAD


def test_docstring_tells_the_agent_how_to_park_itself():
    """The blueprint change (release manager / QA / CI self-park) leans on the tool
    description the LLM sees; keep the contract words in it."""
    source = MAIN_PY.read_text()
    tree = ast.parse(source)
    fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == TOOL_NAME)
    doc = ast.get_docstring(fn) or ""
    for phrase in ("YOUR OWN ticket", "blocked_by", "report_completion", "additive"):
        assert phrase in doc, f"expected {phrase!r} in the tool docstring"


# TEAM-5707: the harness park fences on the source status; a persona call that
# does not pass it keeps the pre-TEAM-5707 payload byte for byte.
def test_expected_status_is_sent_when_supplied():
    assert _payload(expected_status="in_progress")["expected_status"] == "in_progress"


def test_blank_expected_status_is_omitted_entirely():
    assert _payload(expected_status="") == PRE_DL024_PAYLOAD


# TEAM-5719 (R1-3): the runtime attributes ITS OWN park to the claim generation it
# was dispatched under, so the orchestrator releases only that claim. Not a tool
# parameter, so the model cannot forge it; never sent for another ticket's park.
GEN = "2026-10-13T01:00:00.000Z"


def _claim_payload(ticket_id="TEAM-24", transition_id="blocked", current="TEAM-24", gen=GEN, workflow="unknown"):
    fn, calls = _transition_ticket(current_ticket=current, claim_started_at=gen, workflow_id=workflow)
    fn(ticket_id=ticket_id, transition_id=transition_id)
    assert len(calls) == 1
    return calls[0][2]


@pytest.mark.parametrize("transition_id", ["blocked", "block", " Blocked "])
def test_own_park_carries_claim_started_at(transition_id):
    assert _claim_payload(transition_id=transition_id)["claim_started_at"] == GEN


def test_own_park_with_padded_ticket_id_carries_it():
    assert _claim_payload(ticket_id=" TEAM-24 ")["claim_started_at"] == GEN


@pytest.mark.parametrize(
    "kwargs",
    [
        {"ticket_id": "TEAM-99"},           # another ticket's park
        {"transition_id": "done"},          # not a park
        {"transition_id": "ready"},
        {"gen": ""},                        # dispatched without a claim generation
        {"current": ""},                    # unbound invocation
    ],
)
def test_claim_started_at_is_omitted_otherwise(kwargs):
    assert "claim_started_at" not in _claim_payload(**kwargs)


def test_the_tool_signature_does_not_expose_claim_started_at():
    fn, _ = _transition_ticket()
    assert "claim_started_at" not in fn.__code__.co_varnames[: fn.__code__.co_argcount + fn.__code__.co_kwonlyargcount]


# TEAM-5716: the ticket Lambda fences the park on the claim generation, read off the
# workflows row — so the dispatch's workflow rides with claim_started_at (a ticket can
# lack its own workflow id and resolve via its parent/epic). Same rule: never a tool
# argument, never sent without the claim.
def test_own_park_carries_the_dispatch_workflow_id_with_the_claim():
    payload = _claim_payload(workflow="wf_5716")
    assert payload["claim_started_at"] == GEN
    assert payload["workflow_id"] == "wf_5716"


@pytest.mark.parametrize("workflow", ["unknown", ""])
def test_workflow_id_is_omitted_when_the_dispatch_had_none(workflow):
    payload = _claim_payload(workflow=workflow)
    assert payload["claim_started_at"] == GEN
    assert "workflow_id" not in payload


@pytest.mark.parametrize(
    "kwargs",
    [{"ticket_id": "TEAM-99"}, {"transition_id": "done"}, {"gen": ""}, {"current": ""}],
)
def test_workflow_id_is_omitted_whenever_claim_started_at_is(kwargs):
    payload = _claim_payload(workflow="wf_5716", **kwargs)
    assert "claim_started_at" not in payload
    assert "workflow_id" not in payload


def test_the_tool_signature_does_not_expose_workflow_id():
    fn, _ = _transition_ticket()
    assert "workflow_id" not in fn.__code__.co_varnames[: fn.__code__.co_argcount + fn.__code__.co_kwonlyargcount]
