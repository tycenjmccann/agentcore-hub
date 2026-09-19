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
import json
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
    # `json` because TEAM-4754's _reports_done parses the tool's payload; main.py
    # imports it at module level, which the extracted class cannot see.
    namespace = {"logger": logging.getLogger("test-completion-gate"), "json": json}
    exec(compile(module, str(MAIN_PY), "exec"), namespace)
    return namespace["_CompletionGate"]


_CompletionGate = _load_completion_gate()
REPORT_TOOL = _CompletionGate.TOOL

SUCCESS_RESULT = {"status": "success", "content": [{"text": "recorded"}]}


def payload_result(payload):
    """A report_completion answer as the tool really returns it: the Lambda's JSON
    body in a text block. Every response the Lambda produces — success, N2's
    pending state and every `ok: false` refusal — arrives this way, which is
    precisely why `_succeeded` alone could not tell them apart."""
    return {"status": "success", "content": [{"text": json.dumps(payload)}]}


COMPLETE = payload_result({"status": "complete", "message": "Ticket transitioned to Done."})
PENDING = payload_result({
    "status": "complete_pending_follow_ups",
    "next_action": "retry_report_completion",
    "followUpsMaterialized": {"created": [], "skipped": [], "failed": [{"reason": "boom", "retryable": True}]},
})
REFUSAL = payload_result({
    "ok": False,
    "reason": "shipped_requires_execution_and_merge_commit",
    "missing": ["pipeline_execution_id"],
})


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


# ─── TEAM-4754: engaging CLAIMS THE TICKET IS DONE ─────────────────────────────
#
# `engaged` is not only about text. It deletes the persona's resume object (the
# on_success callback) and, via _completed → _accounted in _run_agent_invocation,
# it suppresses `agent.died` AND suppresses writing a replacement resume object.
# So a report that left the ticket OPEN must not engage: otherwise a persona that
# reports pending and stops leaves the ticket open with NO recovery signal at all
# — the exact "walk away" N2 exists to close.
#
# It does NOT gate tool calls (the `current_tool_use` branch is ungated), so the
# retry the pending response asks for still runs in the same turn.


def test_complete_status_engages_and_drops_trailing_text():
    """The positive case, on the real payload shape rather than a bare string."""
    gate = _CompletionGate()
    final = run_harness(gate, [
        {"data": "before"},
        {"tool": tool_event(result=COMPLETE)},
        {"data": "after"},
    ])
    assert gate.engaged
    assert final == "before"


def test_pending_follow_ups_does_not_engage_and_leaves_text_alone():
    """N2: the record is saved but the ticket is NOT Done. The model's own account
    of what is still owed must surface, and the resume object must survive."""
    deleted = []
    gate = _CompletionGate(on_success=lambda: deleted.append(True))
    final = run_harness(gate, [
        {"data": "before"},
        {"tool": tool_event(result=PENDING)},
        {"data": "two follow-ups still pending; retrying"},
    ])
    assert not gate.engaged
    assert final == "beforetwo follow-ups still pending; retrying"
    # The resume object is how the orchestrator recovers this turn — deleting it on
    # a ticket that is still open is what made "pending" unrecoverable.
    assert deleted == []


def test_pending_after_success_disengages():
    """Mirrors test_failed_call_after_success_disengages: a first call that landed
    everything, then a retry (a later ticket, a later report) that did not."""
    gate = _CompletionGate()
    final = run_harness(gate, [
        {"tool": tool_event(result=COMPLETE)},
        {"data": "suppressed"},
        {"tool": tool_event(result=PENDING)},
        {"data": "still pending"},
    ])
    assert not gate.engaged
    assert final == "still pending"


def test_refusal_does_not_engage():
    """The pre-existing leak, closed. A DL-030 refusal is `{"ok": false, ...}` —
    a well-formed JSON body, so `_succeeded` read it as a success and the class
    silently did the opposite of what its own docstring promised."""
    deleted = []
    gate = _CompletionGate(on_success=lambda: deleted.append(True))
    final = run_harness(gate, [
        {"tool": tool_event(result=REFUSAL)},
        {"data": "the report was refused: missing pipeline_execution_id"},
    ])
    assert not gate.engaged
    assert final == "the report was refused: missing pipeline_execution_id"
    assert deleted == []


def test_reports_done_defaults_to_true_on_anything_it_cannot_read():
    """The conservative direction, and it is deliberate: mis-reading a real
    completion as still-open would publish a spurious agent.died and re-dispatch
    finished work, which is worse than the rare missed suppression."""
    done = _CompletionGate._reports_done
    assert done(SUCCESS_RESULT)                                    # plain prose, not JSON
    assert done({"status": "success", "content": []})
    assert done({"status": "success", "content": None})
    assert done({"status": "success", "content": [{"text": None}]})
    assert done({"status": "success", "content": [{"text": "   "}]})
    assert done({"status": "success", "content": [{"json": {"status": "x"}}]})  # non-text block
    assert done({"status": "success", "content": [{"text": "[1, 2]"}]})         # JSON, not an object
    assert done({"status": "success", "content": [{"text": "{}"}]})             # no status, no ok
    assert done({"status": "success", "content": [{"text": '{"status": 7}'}]})  # non-string status
    assert done(None)
    assert done("success")
    # …and the two definite negatives.
    assert not done(PENDING)
    assert not done(REFUSAL)
    assert not done({"status": "success", "content": [{"text": '{"ok": false}'}]})


def test_succeeded_is_unchanged_and_still_shared_with_park_gate():
    """_succeeded stays byte-identical on purpose: _ParkGate reuses it, and
    test_park_gate.py pins that reuse by source text. The new predicate is a
    SECOND check in _on_tool_result, not a redefinition of the first."""
    # A refusal is still a "successful call" — that is the distinction being drawn.
    assert _CompletionGate._succeeded(REFUSAL)
    assert _CompletionGate._succeeded(PENDING)
    src = MAIN_PY.read_text()
    assert "self._succeeded(result) and self._reports_done(result)" in src
    assert "_CompletionGate._succeeded(" in src  # the _ParkGate reuse
