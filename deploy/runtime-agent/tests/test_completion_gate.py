"""R3.2 (AC2) tests: _CompletionGate suppresses post-completion text without
swallowing tool-failure output.

The class under test is the REAL shipped code: main.py cannot be imported
(module top-level installs Node.js, fetches from S3, chdirs), so the
_CompletionGate class definition is extracted from deploy/runtime-agent/main.py
via ast and exec'd — not a copy that could drift.

The harness below mirrors the two gate consumers in _run_agent_invocation:
the stream loop's text branch (`if not completion_gate.engaged:` around the
final_text/DDB appends) and the empty-final_text result fallback
(`if not final_text and result and not completion_gate.engaged:`).
"""

import ast
import logging
from pathlib import Path
from types import SimpleNamespace

MAIN_PY = Path(__file__).resolve().parent.parent / "main.py"


def _load_completion_gate():
    tree = ast.parse(MAIN_PY.read_text())
    cls = next(
        n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "_CompletionGate"
    )
    module = ast.Module(body=[cls], type_ignores=[])
    namespace = {"logger": logging.getLogger("test-completion-gate")}
    exec(compile(module, str(MAIN_PY), "exec"), namespace)
    return namespace["_CompletionGate"]


_CompletionGate = _load_completion_gate()
REPORT_TOOL = _CompletionGate.TOOL

SUCCESS_RESULT = {"status": "success", "content": [{"text": "recorded"}]}


def tool_event(name=REPORT_TOOL, result=SUCCESS_RESULT):
    """Fake strands AfterToolCallEvent: only .tool_use / .result are read."""
    return SimpleNamespace(tool_use={"name": name}, result=result)


def run_harness(gate, events):
    """Minimal reimplementation of _run_agent_invocation's gating.

    Events: {"data": str} text deltas, {"tool": <hook event>} tool boundaries
    (hook fires between deltas, as in the real stream), {"result": str} the
    final result message the fallback would re-extract text from.
    """
    final_text = ""
    result = None
    for event in events:
        if "data" in event and event["data"]:
            # R3.2: post-completion text duplicates the report_completion summary
            if not gate.engaged:
                final_text += event["data"]
        elif "tool" in event:
            gate._on_tool_result(event["tool"])
        if "result" in event:
            result = event["result"]
    # Fallback guard: must not resurrect suppressed text
    if not final_text and result and not gate.engaged:
        final_text = result
    return final_text


def test_successful_completion_engages_gate_and_drops_trailing_text():
    gate = _CompletionGate()
    final = run_harness(gate, [
        {"data": "before"},
        {"tool": tool_event()},
        {"data": "after"},
    ])
    assert gate.engaged
    assert final == "before"


def test_error_status_does_not_engage():
    gate = _CompletionGate()
    final = run_harness(gate, [
        {"data": "before"},
        {"tool": tool_event(result={"status": "error", "content": [{"text": "boom"}]})},
        {"data": "after"},
    ])
    assert not gate.engaged
    assert final == "beforeafter"


def test_lambda_error_string_success_does_not_engage():
    """_invoke_lambda maps a Lambda errorMessage to a status=success ToolResult
    whose text starts "Error: ..." — that is a FAILED completion."""
    gate = _CompletionGate()
    final = run_harness(gate, [
        {"data": "before"},
        {"tool": tool_event(result={"status": "success", "content": [{"text": "Error: boom"}]})},
        {"data": "after"},
    ])
    assert not gate.engaged
    assert final == "beforeafter"


def test_exception_result_does_not_engage():
    gate = _CompletionGate()
    final = run_harness(gate, [
        {"data": "before"},
        {"tool": tool_event(result=RuntimeError("tool execution blew up"))},
        {"data": "after"},
    ])
    assert not gate.engaged
    assert final == "beforeafter"


def test_failed_call_after_success_disengages():
    """Persona TOOL STATUS REPORTING: a retry that fails must let the model's
    failure report through, even though an earlier call succeeded."""
    gate = _CompletionGate()
    final = run_harness(gate, [
        {"tool": tool_event()},
        {"data": "suppressed"},
        {"tool": tool_event(result={"status": "error", "content": [{"text": "retry failed"}]})},
        {"data": "failure report"},
    ])
    assert not gate.engaged
    assert final == "failure report"


def test_fallback_cannot_resurrect_suppressed_text():
    """All text arrives post-completion AND the result message repeats it: the
    stream branch drops it and the gated fallback must not re-extract it."""
    gate = _CompletionGate()
    final = run_harness(gate, [
        {"tool": tool_event()},
        {"data": "post-completion recap"},
        {"result": "post-completion recap"},
    ])
    assert gate.engaged
    assert final == ""


def test_fallback_still_works_when_not_engaged():
    gate = _CompletionGate()
    final = run_harness(gate, [
        {"result": "only-in-result text"},
    ])
    assert final == "only-in-result text"


def test_non_matching_tool_leaves_gate_untouched():
    gate = _CompletionGate()
    gate._on_tool_result(tool_event(name="Tickets___create_ticket"))
    assert not gate.engaged
    # ... and does not disengage an engaged gate either
    gate._on_tool_result(tool_event())
    assert gate.engaged
    gate._on_tool_result(
        tool_event(name="Tickets___create_ticket", result={"status": "error", "content": []})
    )
    assert gate.engaged


def test_hook_never_raises_on_malformed_event():
    gate = _CompletionGate()
    gate._on_tool_result(SimpleNamespace())  # no tool_use / result at all
    gate._on_tool_result(SimpleNamespace(tool_use=None, result=None))
    assert not gate.engaged


def test_succeeded_handles_content_edge_cases():
    ok = _CompletionGate._succeeded
    assert ok({"status": "success", "content": []})
    assert ok({"status": "success", "content": None})
    assert ok({"status": "success", "content": [{"json": {"ok": True}}]})  # non-text block
    assert ok({"status": "success", "content": [{"text": None}]})
    assert not ok({"status": "success", "content": [{"text": "  ERROR: case/space"}]})
    assert not ok(None)
    assert not ok("success")
