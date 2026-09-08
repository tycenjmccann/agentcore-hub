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


def _transition_ticket():
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

    ns = {"_invoke_lambda": _invoke_lambda, "TICKET_TOOLS_LAMBDA": "agentcore-hub-jira"}
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
