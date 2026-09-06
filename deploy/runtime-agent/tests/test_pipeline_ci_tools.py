"""TEAM-4122 FR-4 — `Pipeline___start_ci_build` / `Pipeline___capabilities`
harness wrappers must forward exactly what the Lambda contract expects:
commit_sha always, source_version only when the agent supplied one (never as
""), and both tools must be registered in LAMBDA_TOOLS so the fleet actually
gets them.

main.py cannot be imported (module top-level installs Node.js, fetches from S3,
chdirs), so — matching test_create_ticket_tool.py / test_report_completion_evidence.py
— the REAL shipped function is located with `ast` and exec'd in isolation
against a stub `_invoke_lambda`.
"""

import ast
import textwrap
from pathlib import Path

import pytest

MAIN_PY = Path(__file__).resolve().parent.parent / "main.py"


def _load_tool(tool_name):
    """The real tool body, exec'd with stubbed module globals.

    Returns (fn, calls) where `calls` collects (lambda, tool, payload) tuples.
    """
    source = MAIN_PY.read_text()
    tree = ast.parse(source)
    fn_node = next(
        (
            n
            for n in tree.body
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == tool_name
        ),
        None,
    )
    assert fn_node is not None, f"{tool_name} function def not found in main.py"
    # drop the @tool decorator — strands would wrap the callable in a ToolSpec
    src = textwrap.dedent(ast.get_source_segment(source, fn_node))

    calls = []

    def _invoke_lambda(lambda_name, tool, payload):
        calls.append((lambda_name, tool, payload))
        return "ok"

    ns = {
        "_invoke_lambda": _invoke_lambda,
        "PIPELINE_TOOLS_LAMBDA": "agentcore-hub-pipeline-tools",
    }
    exec(compile(src, str(MAIN_PY), "exec"), ns)
    return ns[tool_name], calls


# ─── start_ci_build ───────────────────────────────────────────────────────────

def test_forwards_commit_sha_only_when_source_version_omitted():
    fn, calls = _load_tool("Pipeline___start_ci_build")
    fn(commit_sha="abc1234")
    assert len(calls) == 1
    lambda_name, tool, payload = calls[0]
    assert lambda_name == "agentcore-hub-pipeline-tools"
    assert tool == "Pipeline___start_ci_build"
    assert payload == {"commit_sha": "abc1234"}
    assert "source_version" not in payload


def test_forwards_source_version_when_supplied():
    fn, calls = _load_tool("Pipeline___start_ci_build")
    fn(commit_sha="abc1234", source_version="pr/42")
    _, _, payload = calls[0]
    assert payload == {"commit_sha": "abc1234", "source_version": "pr/42"}


def test_blank_source_version_is_omitted_like_default():
    fn, calls = _load_tool("Pipeline___start_ci_build")
    fn(commit_sha="abc1234", source_version="")
    _, _, payload = calls[0]
    assert payload == {"commit_sha": "abc1234"}


# ─── capabilities ─────────────────────────────────────────────────────────────

def test_capabilities_forwards_no_args():
    fn, calls = _load_tool("Pipeline___capabilities")
    fn()
    assert len(calls) == 1
    lambda_name, tool, payload = calls[0]
    assert lambda_name == "agentcore-hub-pipeline-tools"
    assert tool == "Pipeline___capabilities"
    assert payload == {}


# ─── LAMBDA_TOOLS registration ────────────────────────────────────────────────

def test_both_tools_registered_in_lambda_tools():
    source = MAIN_PY.read_text()
    tree = ast.parse(source)
    lambda_tools_node = next(
        (
            n
            for n in ast.walk(tree)
            if isinstance(n, ast.Assign)
            and any(isinstance(t, ast.Name) and t.id == "LAMBDA_TOOLS" for t in n.targets)
        ),
        None,
    )
    assert lambda_tools_node is not None, "LAMBDA_TOOLS assignment not found in main.py"
    names = {elt.id for elt in lambda_tools_node.value.elts if isinstance(elt, ast.Name)}
    assert "Pipeline___start_ci_build" in names
    assert "Pipeline___capabilities" in names
