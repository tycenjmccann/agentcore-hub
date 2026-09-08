"""TEAM-4248 D3 — `WorkflowOutput___submit_ticket_plan` must forward
`root_ticket_id` only when the analyst actually has one.

The Lambda validates the plan against the run's requirements root and reads a
falsy `rootTicketId` as "no root, fail open". Forwarding an empty string would
therefore be worse than forwarding nothing: it looks like a root named "" and
silently disables the check it was added to enable.

main.py cannot be imported (module top-level installs Node.js, fetches from S3,
chdirs), so — matching test_create_ticket_tool.py / test_get_issue_tool.py — the
REAL shipped function is located with `ast` and exec'd in isolation against a
stub `_invoke_lambda`. That runs the actual body rather than a copy that drifts.
"""

import ast
import textwrap
from pathlib import Path

MAIN_PY = Path(__file__).resolve().parent.parent / "main.py"
TOOL_NAME = "WorkflowOutput___submit_ticket_plan"


def _submit_ticket_plan():
    """The real submit_ticket_plan body, exec'd with stubbed module globals.

    Returns (fn, calls) where `calls` collects (lambda, tool, payload) tuples.
    """
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
    # drop the @tool decorator — strands would wrap the callable in a ToolSpec
    src = textwrap.dedent(ast.get_source_segment(source, fn_node))

    calls = []

    def _invoke_lambda(lambda_name, tool, payload):
        calls.append((lambda_name, tool, payload))
        return "ok"

    ns = {
        "_invoke_lambda": _invoke_lambda,
        "WORKFLOW_OUTPUT_LAMBDA": "agentcore-hub-workflow-output",
    }
    exec(compile(src, str(MAIN_PY), "exec"), ns)
    return ns[TOOL_NAME], calls


PLAN = '[{"title": "Sweep", "assignee": "agentcore_hub_code_sweeper", "blockedBy": ["TEAM-4229"]}]'


def _payload(**kwargs):
    fn, calls = _submit_ticket_plan()
    fn(workflow_id="wf_1", epic_id="TEAM-4228", tickets=PLAN, **kwargs)
    assert len(calls) == 1
    return calls[0][2]


def test_root_ticket_id_forwarded_when_supplied():
    payload = _payload(root_ticket_id="TEAM-4229")
    assert payload["root_ticket_id"] == "TEAM-4229"


def test_root_ticket_id_absent_when_omitted():
    payload = _payload()
    assert "root_ticket_id" not in payload


def test_empty_root_ticket_id_is_not_forwarded():
    # An empty string is the default, and the validator reads a falsy root as
    # "no root" and fails open — so sending "" would be indistinguishable from
    # not having asked, while still occupying the field.
    assert "root_ticket_id" not in _payload(root_ticket_id="")


def test_the_three_original_params_are_unchanged():
    payload = _payload(root_ticket_id="TEAM-4229")
    assert payload["workflow_id"] == "wf_1"
    assert payload["epic_id"] == "TEAM-4228"
    assert payload["tickets"] == PLAN


def test_docstring_tells_the_analyst_the_blockedby_rule():
    # The tool description is the only place the analyst reads this before it
    # writes the plan; c2uqki's plan was submitted with an unblocked non-root.
    fn, _ = _submit_ticket_plan()
    doc = fn.__doc__ or ""
    assert "blockedBy" in doc
    assert "root_ticket_id" in doc
