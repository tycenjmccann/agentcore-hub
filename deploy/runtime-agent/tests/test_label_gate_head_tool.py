"""TEAM-5322 FR-11 — `Tickets___label_gate_head` adds exactly one `head:<40hex>` label.

The twin binds a human's Merge Approval decision to the gate's single `head:`
label (the S3 decision record's `headSha`), so the operator (B7) and the release
manager (Step 5) label the gate when they post the brief. The wrapper is narrow on
purpose: the twins' `labels_add` normalises system labels rather than dropping
them, so a generic wrapper would let any persona stamp `wf:`/`fix:`/`exec:`.

Same harness as test_add_comment_tool.py: the real function body is located with
`ast` and exec'd against a stub `_invoke_lambda` (main.py cannot be imported).
"""

import ast
import json
import re
import textwrap
from pathlib import Path

MAIN_PY = Path(__file__).resolve().parent.parent / "main.py"
TOOL_NAME = "Tickets___label_gate_head"
SHA = "7b3f6fe7" + "0" * 32


def _tool():
    source = MAIN_PY.read_text()
    tree = ast.parse(source)
    fn_node = next(
        (n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == TOOL_NAME),
        None,
    )
    assert fn_node is not None, f"{TOOL_NAME} function def not found in main.py"
    src = textwrap.dedent(ast.get_source_segment(source, fn_node))
    calls = []

    def _invoke_lambda(lambda_name, tool, payload):
        calls.append((lambda_name, tool, payload))
        return "ok"

    ns = {"_invoke_lambda": _invoke_lambda, "TICKET_TOOLS_LAMBDA": "agentcore-hub-tickets", "re": re, "json": json}
    exec(compile(src, str(MAIN_PY), "exec"), ns)
    return ns[TOOL_NAME], calls


def test_sends_one_head_label_to_labels_add_under_both_key_names():
    fn, calls = _tool()
    assert fn(ticket_id="TEAM-42", head_sha=f"  {SHA.upper()} ") == "ok"
    assert calls == [
        ("agentcore-hub-tickets", "Tickets___labels_add", {"ticket_id": "TEAM-42", "issue_key": "TEAM-42", "labels": [f"head:{SHA}"]}),
    ]


def test_refuses_anything_but_a_full_sha_and_invokes_nothing():
    fn, calls = _tool()
    for bad in ["", "7b3f6fe7", SHA + "0", "g" * 40, f"{SHA},wf:wf_1", f"exec:{SHA}"]:
        out = json.loads(fn(ticket_id="TEAM-42", head_sha=bad))
        assert out["ok"] is False, bad
    assert calls == []


def test_registered_and_carries_no_approval_parameter():
    source = MAIN_PY.read_text()
    assert re.search(r"^\s+Tickets___label_gate_head,$", source, re.M), "not registered in the tool list"
    fn_node = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == TOOL_NAME)
    assert not [a.arg for a in fn_node.args.args if re.search(r"approv", a.arg, re.I)]
