"""TEAM-4576 — a max_tokens stop resumes the turn instead of killing the run.

Root cause (TEAM-3125 RCA): when the model stops with stop_reason `max_tokens`,
Strands raises MaxTokensReachedException out of the event loop. The persona
harness treated that as terminal — the loop exited, report_completion never ran,
an agent.error went out with an EMPTY ticketId, and the ticket sat in_progress
holding a live invocation lease. Six runs died that way since 2026-08-25.

The SDK's own contract (strands/types/exceptions.py MaxTokensReachedException):
"The partial message is automatically added to agent.messages and you can
continue the conversation by calling the agent again." So the stop is RESUMABLE.
_stream_agent_turn continues the turn up to _MAX_TOKENS_CONTINUATIONS times with
a short user turn, then re-raises UNCHANGED.

Three things must hold:
  1. Resume works: one max_tokens stop → the turn completes, with exactly ONE
     continuation user message and the partial output preserved.
  2. Give-up is attributed and does NOT touch the board: after the bound the
     exception propagates into the existing detached terminal-failure path, which
     publishes agent.error carrying the PAYLOAD's ticketId and the TEAM-3125
     signature — and does NOT transition or comment on the ticket. The ticket
     stays in_progress on purpose: dead-session-detector.mjs:361 is
     `if (ticket.status !== "in_progress") continue;`, so parking it would
     disqualify it from the very sweep that owns crashed sessions.
  3. Nothing else is swallowed. The handler catches ONLY
     MaxTokensReachedException — a write path must never swallow errors.

main.py cannot be imported (module top-level installs Node.js, reads S3), so each
function under test is AST-extracted and exec'd with stubbed globals — the real
body, not a copy that could drift. Same harness as test_plan_first.py.
"""

import ast
import asyncio
import textwrap
from pathlib import Path
from unittest import mock

import pytest
from strands.types.exceptions import MaxTokensReachedException

MAIN_PY = Path(__file__).resolve().parent.parent / "main.py"
_SRC = MAIN_PY.read_text()
_TREE = ast.parse(_SRC)

# The exact message Bedrock/Strands produced in every one of the six dead runs.
MAX_TOKENS_MSG = "Model stopped generating due to maximum token limit"

_DEFS = (ast.FunctionDef, ast.AsyncFunctionDef)


def _node(pred):
    # walk(), not _TREE.body: _run_detached is nested inside agent_invocation.
    node = next((n for n in ast.walk(_TREE) if pred(n)), None)
    assert node is not None, "definition not found in main.py"
    return node


def _segment(pred):
    # get_source_segment on a FunctionDef starts at `def` — decorators are
    # excluded, which is what we want (strands would wrap the callable).
    return textwrap.dedent(ast.get_source_segment(_SRC, _node(pred)))


def _is_assign(n, name):
    return isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in n.targets)


def _is_def(n, name):
    return isinstance(n, _DEFS) and n.name == name


def _exec(ns, *preds):
    for p in preds:
        exec(compile(_segment(p), str(MAIN_PY), "exec"), ns)
    return ns


# ─── stubs ───────────────────────────────────────────────────────────────────

class _StubAgent:
    """An Agent whose stream_async raises `fail_times` times, then completes."""

    def __init__(self, fail_times, exc_factory=None):
        self.fail_times = fail_times
        self.exc_factory = exc_factory or (lambda: MaxTokensReachedException(MAX_TOKENS_MSG))
        self.prompts = []

    @property
    def calls(self):
        return len(self.prompts)

    def stream_async(self, prompt):
        self.prompts.append(prompt)
        n = self.calls
        should_fail = n <= self.fail_times
        exc_factory = self.exc_factory

        async def _gen():
            # Partial output lands BEFORE the stop, exactly as the real SDK does.
            yield {"data": f"chunk{n} "}
            if should_fail:
                raise exc_factory()
            yield {"result": f"final-after-{n}"}

        return _gen()


def _helper_ns():
    return _exec(
        {"logger": mock.Mock(), "MaxTokensReachedException": MaxTokensReachedException},
        lambda n: _is_assign(n, "_MAX_TOKENS_CONTINUATIONS"),
        lambda n: _is_assign(n, "_MAX_TOKENS_CONTINUATION_PROMPT"),
        lambda n: _is_def(n, "_stream_agent_turn"),
    )


def _drain(ns, agent, prompt="do the work", on_continuation=None):
    async def _go():
        return [e async for e in ns["_stream_agent_turn"](
            agent, prompt, "agentcore_hub_backend_dev", on_continuation=on_continuation)]

    return asyncio.run(_go())


# ─── (a) one max_tokens stop → the turn completes ────────────────────────────

def test_one_max_tokens_stop_resumes_and_completes_the_turn():
    ns = _helper_ns()
    agent = _StubAgent(fail_times=1)
    seen = []
    events = _drain(ns, agent, on_continuation=lambda n, exc: seen.append((n, exc)))

    # The turn completed — the exception did not escape.
    assert events[-1] == {"result": "final-after-2"}
    # Exactly ONE continuation, carrying the continuation user message.
    assert agent.calls == 2
    assert agent.prompts == ["do the work", ns["_MAX_TOKENS_CONTINUATION_PROMPT"]]
    assert len(seen) == 1 and seen[0][0] == 1
    assert isinstance(seen[0][1], MaxTokensReachedException)
    # Partial output from the cut-off turn is preserved, not discarded — the
    # caller accumulates final_text across the resume with no change of its own.
    assert [e["data"] for e in events if "data" in e] == ["chunk1 ", "chunk2 "]


def test_a_clean_turn_is_byte_identical_to_before():
    ns = _helper_ns()
    agent = _StubAgent(fail_times=0)
    seen = []
    events = _drain(ns, agent, on_continuation=lambda n, exc: seen.append(n))
    assert agent.prompts == ["do the work"]  # no extra user turn injected
    assert events == [{"data": "chunk1 "}, {"result": "final-after-1"}]
    assert seen == []


def test_continuations_are_bounded_and_each_one_is_announced():
    ns = _helper_ns()
    bound = ns["_MAX_TOKENS_CONTINUATIONS"]
    agent = _StubAgent(fail_times=bound)  # recovers on the very last allowance
    seen = []
    events = _drain(ns, agent, on_continuation=lambda n, exc: seen.append(n))
    assert agent.calls == bound + 1
    assert seen == list(range(1, bound + 1))
    assert events[-1] == {"result": f"final-after-{bound + 1}"}


# ─── (b) give-up: attributed agent.error, and the board is left alone ────────

def _detached_ns(exc, ticket_id="TEAM-4576", published=None, tools=None):
    """The real _run_detached body, wired to a run that always fails."""
    async def _run_agent_invocation(payload, context):
        raise exc
        yield  # pragma: no cover — makes this an async generator

    ns = {
        "asyncio": asyncio,
        "logger": mock.Mock(),
        "_run_agent_invocation": _run_agent_invocation,
        "_publish_agent_error": published if published is not None else mock.Mock(),
        "app": mock.Mock(),
        "task_id": "task_1",
        "_DETACHED_TASKS": set(),
        "payload": {"workflow_id": "wf-1", "agent_id": "agentcore_hub_backend_dev",
                    "ticket_id": ticket_id},
        "context": mock.Mock(),
        "workflow_id": "wf-1",
        "agent_id": "agentcore_hub_backend_dev",
        # Closure var in the real code — set from payload["ticket_id"] by
        # agent_invocation (see test_ticket_id_comes_from_the_payload below).
        "ticket_id": ticket_id,
    }
    ns.update(tools or {})
    return _exec(ns, lambda n: _is_def(n, "_run_detached"))


def test_give_up_publishes_an_attributed_agent_error_and_never_touches_the_board():
    ns = _helper_ns()
    bound = ns["_MAX_TOKENS_CONTINUATIONS"]
    agent = _StubAgent(fail_times=bound + 1)  # never recovers

    # The helper re-raises UNCHANGED after exactly bound+1 attempts.
    with pytest.raises(MaxTokensReachedException) as raised:
        _drain(ns, agent)
    assert agent.calls == bound + 1
    assert str(raised.value) == MAX_TOKENS_MSG

    # ...into the existing detached terminal-failure path.
    published = mock.Mock()
    tools = {"Tickets___transition_ticket": mock.Mock(),
             "Tickets___add_comment": mock.Mock()}
    d = _detached_ns(raised.value, published=published, tools=tools)
    asyncio.run(d["_run_detached"]())

    published.assert_called_once()
    args, kwargs = published.call_args
    assert args[0] == "wf-1"
    assert args[1] == "agentcore_hub_backend_dev"
    # The ticket is ATTRIBUTED — the whole point of TEAM-4576's second half.
    assert kwargs["ticket_id"] == "TEAM-4576"
    assert kwargs["ticket_id"] != ""
    # ...and the message names both the give-up and the TEAM-3125 signature.
    assert "TEAM-4576 harness give-up" in args[2]
    assert "MaxTokensReachedException" in args[2]
    assert MAX_TOKENS_MSG in args[2]
    assert len(args[2]) <= 500

    # The board is NOT touched: no transition, no comment. in_progress is the
    # precondition the dead-session detector requires
    # (orchestrator/dead-session-detector.mjs:361).
    tools["Tickets___transition_ticket"].assert_not_called()
    tools["Tickets___add_comment"].assert_not_called()

    # The async task is always completed and unpinned, however it failed.
    d["app"].complete_async_task.assert_called_once_with("task_1")


def test_the_ticket_is_left_in_progress_by_construction_not_by_luck():
    # Source-level pin: a future edit that "fixes" the phantom in_progress by
    # parking the ticket would silently double the recovery latency (todo/blocked
    # fall to redispatch's 2x-TTL claim CAS instead of the in_progress branch's
    # generation-CAS steal) and lose the detector entirely. Fail loudly instead.
    src = _segment(lambda n: _is_def(n, "_run_detached"))
    assert "Tickets___transition_ticket" not in src
    assert "Tickets___add_comment" not in src
    assert "in_progress" in src, "the WHY must stay next to the code"
    assert "dead-session-detector.mjs:361" in src


def test_ticket_id_comes_from_the_payload_not_the_shared_global():
    # _CURRENT_TICKET_ID is module state shared by every concurrent detached task
    # on a warm microVM, so a sibling can overwrite it before this task's except
    # runs. agent_invocation must read the payload.
    src = _segment(lambda n: _is_def(n, "agent_invocation"))
    assert 'ticket_id = payload.get("ticket_id", "")' in src
    assert "ticket_id=ticket_id" in src
    # AST, not text: the comment above that line names the global deliberately.
    fn = _node(lambda n: _is_def(n, "agent_invocation"))
    assert not [n for n in ast.walk(fn)
                if isinstance(n, ast.Name) and n.id == "_CURRENT_TICKET_ID"]


def test_publish_agent_error_writes_the_ticket_id_into_the_event_detail():
    # The consumers that were blind to these failures read detail.ticketId.
    src = _segment(lambda n: _is_def(n, "_publish_agent_error"))
    assert '"ticketId": {"S": ticket_id or ""}' in src


# ─── (c) nothing else is swallowed ──────────────────────────────────────────

def test_an_unrelated_exception_is_not_swallowed_or_retried():
    ns = _helper_ns()
    agent = _StubAgent(fail_times=1, exc_factory=lambda: RuntimeError("bedrock throttled"))
    seen = []
    with pytest.raises(RuntimeError, match="bedrock throttled"):
        _drain(ns, agent, on_continuation=lambda n, exc: seen.append(n))
    assert agent.calls == 1  # no continuation, no retry
    assert seen == []


def test_a_max_tokens_subclass_is_caught_but_a_sibling_sdk_error_is_not():
    ns = _helper_ns()

    class _Subclass(MaxTokensReachedException):
        pass

    agent = _StubAgent(fail_times=1, exc_factory=lambda: _Subclass(MAX_TOKENS_MSG))
    assert _drain(ns, agent)[-1] == {"result": "final-after-2"}

    # A ContextWindowOverflowException (the other SDK stop) is a different
    # recovery — it must NOT be absorbed here.
    from strands.types.exceptions import ContextWindowOverflowException
    other = _StubAgent(fail_times=1, exc_factory=lambda: ContextWindowOverflowException("too big"))
    with pytest.raises(ContextWindowOverflowException):
        _drain(ns, other)
    assert other.calls == 1


def test_the_handler_catches_exactly_one_exception_type():
    # Structural, not behavioural: "never swallow errors in a write path" has to
    # survive someone widening the except clause to `Exception` later.
    fn = _node(lambda n: _is_def(n, "_stream_agent_turn"))
    handlers = [h for h in ast.walk(fn) if isinstance(h, ast.ExceptHandler)]
    assert len(handlers) == 1
    assert isinstance(handlers[0].type, ast.Name)
    assert handlers[0].type.id == "MaxTokensReachedException"
    # ...and it must re-raise, never return, on exhaustion.
    assert any(isinstance(n, ast.Raise) and n.exc is None for n in ast.walk(handlers[0]))


# ─── (d) the bound is a constant, and the prompt carries the S3 guidance ────

def test_the_bound_is_a_plain_module_constant_not_an_env_var():
    # DL-009: no new env var, no new *_MODE flag. The bound is a literal int.
    node = _node(lambda n: _is_assign(n, "_MAX_TOKENS_CONTINUATIONS"))
    assert isinstance(node.value, ast.Constant) and isinstance(node.value.value, int)
    assert node.value.value == 3
    segs = _segment(lambda n: _is_assign(n, "_MAX_TOKENS_CONTINUATIONS")) + \
        _segment(lambda n: _is_def(n, "_stream_agent_turn"))
    for forbidden in ("os.getenv", "os.environ", "MAX_TOKENS_CONTINUATIONS\","):
        assert forbidden not in segs
    assert "MAX_TOKENS_CONTINUATIONS" not in (Path(MAIN_PY).parent / "Dockerfile").read_text()


def test_the_continuation_prompt_asks_for_pass_by_reference():
    ns = _helper_ns()
    prompt = ns["_MAX_TOKENS_CONTINUATION_PROMPT"]
    # A turn that died emitting a huge tool argument must not retry the same way.
    assert "S3Storage___write_object" in prompt
    assert "by reference" in prompt
    assert "do not repeat" in prompt.lower()
    assert "cut off" in prompt.lower()


def test_the_call_site_adopts_the_helper_and_announces_each_continuation():
    src = _segment(lambda n: _is_def(n, "_run_agent_invocation"))
    # The single persona invocation site goes through the helper...
    assert "_stream_agent_turn(" in src
    assert "agent.stream_async(" not in src
    # ...and the continuation is visible on the SAME channel the tool events use.
    assert "on_continuation=_note_max_tokens_continuation" in src
    assert "_flush_text_buffer()" in _segment(lambda n: _is_def(n, "_note_max_tokens_continuation"))
    note = _segment(lambda n: _is_def(n, "_note_max_tokens_continuation"))
    # agent.streaming is a lease heartbeat type — correct while work continues.
    assert 'tracker._publish_event("agent.streaming"' in note
    assert "hub.max_tokens_continuation" in note


def test_telemetry_in_the_continuation_notice_fails_open():
    # R1.4: telemetry must never break a run. The span event is a span EVENT (not
    # a new span, which would move test_telemetry_spans' assertions) and its whole
    # block is guarded.
    note = _node(lambda n: _is_def(n, "_note_max_tokens_continuation"))
    tries = [t for t in ast.walk(note) if isinstance(t, ast.Try)]
    assert tries, "the OTel call must be wrapped"
    assert any("add_event" in ast.dump(t) for t in tries)
    assert "start_as_current_span" not in _segment(lambda n: _is_def(n, "_note_max_tokens_continuation"))


def test_the_exception_is_imported_at_module_level_and_asserted_at_build_time():
    assert "from strands.types.exceptions import MaxTokensReachedException" in _SRC
    dockerfile = (MAIN_PY.parent / "Dockerfile").read_text()
    assert "from strands.types.exceptions import MaxTokensReachedException" in dockerfile
