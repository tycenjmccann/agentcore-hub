"""TEAM-3544 (P0 review fix): the release-manager runtime must actually expose
`Tickets___get_issue` so the FR-1 escalation-gate decision flow can read a gate
ticket's status + comments and parse the human DECISION: line.

Acceptance check: "verify by listing the tools the release-manager runtime
actually receives." main.py cannot be imported (module top-level installs
Node.js, fetches from S3, chdirs), so — matching test_completion_gate.py — the
tool wiring is verified statically via `ast` against the REAL shipped main.py,
not a copy that could drift.
"""

import ast
from pathlib import Path

MAIN_PY = Path(__file__).resolve().parent.parent / "main.py"
TOOL_NAME = "Tickets___get_issue"


def _tree():
    return ast.parse(MAIN_PY.read_text())


def _get_issue_def(tree):
    """The `def Tickets___get_issue(...)` at module level, or None."""
    return next(
        (
            n
            for n in tree.body
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
            and n.name == TOOL_NAME
        ),
        None,
    )


def _lambda_tools_names(tree):
    """The list of Name ids assigned to the module-level LAMBDA_TOOLS literal."""
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "LAMBDA_TOOLS" for t in node.targets
        ):
            assert isinstance(node.value, ast.List), "LAMBDA_TOOLS must be a list literal"
            return [e.id for e in node.value.elts if isinstance(e, ast.Name)]
    raise AssertionError("LAMBDA_TOOLS assignment not found in main.py")


def test_get_issue_tool_defined_with_tool_decorator():
    """(a) A function def `Tickets___get_issue` decorated with @tool exists."""
    fn = _get_issue_def(_tree())
    assert fn is not None, f"{TOOL_NAME} function def not found in main.py"
    decorators = {
        d.id if isinstance(d, ast.Name) else getattr(d, "attr", None)
        for d in fn.decorator_list
    }
    assert "tool" in decorators, f"{TOOL_NAME} must be decorated with @tool, got {decorators}"


def test_get_issue_registered_in_lambda_tools():
    """(b) The name `Tickets___get_issue` appears in the LAMBDA_TOOLS list literal."""
    names = _lambda_tools_names(_tree())
    assert TOOL_NAME in names, f"{TOOL_NAME} missing from LAMBDA_TOOLS: {names}"


def test_get_issue_invokes_lambda_with_both_arg_keys():
    """(c) Its body invokes _invoke_lambda("Tickets___get_issue", {...}) with an
    arguments dict containing BOTH "ticket_id" and "issue_key" — the Jira backend
    reads issue_key, the DDB backend reads either, so both must be sent."""
    fn = _get_issue_def(_tree())
    assert fn is not None

    call = next(
        (
            n
            for n in ast.walk(fn)
            if isinstance(n, ast.Call)
            and isinstance(n.func, ast.Name)
            and n.func.id == "_invoke_lambda"
        ),
        None,
    )
    assert call is not None, f"{TOOL_NAME} body must call _invoke_lambda"

    # tool-name string arg: _invoke_lambda(LAMBDA, "Tickets___get_issue", {...})
    tool_name_args = [
        a.value for a in call.args if isinstance(a, ast.Constant) and a.value == TOOL_NAME
    ]
    assert tool_name_args, f"_invoke_lambda must be called with tool name {TOOL_NAME!r}"

    # arguments dict is the trailing dict literal positional arg
    arg_dict = next((a for a in call.args if isinstance(a, ast.Dict)), None)
    assert arg_dict is not None, "_invoke_lambda must receive an arguments dict literal"
    keys = {k.value for k in arg_dict.keys if isinstance(k, ast.Constant)}
    assert {"ticket_id", "issue_key"} <= keys, (
        f"arguments dict must contain both 'ticket_id' and 'issue_key', got {keys}"
    )


def test_print_ticket_tools_received_by_runtime(capsys):
    """Acceptance evidence: list the Tickets___* tools the runtime registers."""
    ticket_tools = [n for n in _lambda_tools_names(_tree()) if n.startswith("Tickets___")]
    print("\nTickets___* tools in LAMBDA_TOOLS: " + ", ".join(ticket_tools))
    assert TOOL_NAME in ticket_tools


if __name__ == "__main__":
    tree = _tree()
    fn = _get_issue_def(tree)
    print(f"@tool {TOOL_NAME} defined: {fn is not None}")
    names = _lambda_tools_names(tree)
    ticket_tools = [n for n in names if n.startswith("Tickets___")]
    print("Tickets___* tools in LAMBDA_TOOLS:")
    for n in ticket_tools:
        print(f"  - {n}")
    assert fn is not None
    assert TOOL_NAME in names
    print("OK: Tickets___get_issue is defined with @tool and registered in LAMBDA_TOOLS")
