"""F3.2 (TEAM-3359) regression tests: ToolSpanMappingException / tool_output.

The live results log groups showed 148 results failing with
``error.type=ToolSpanMappingException``, ``error.message="Failed to parse
tool_output from tool-span with spanId: <hex> and scope:
strands.telemetry.tracer"``. Reproduced here from code (the raw failing spans
were unpullable — Transaction Search sampling): strands'
``Tracer.end_tool_call_span`` mirrors the ENTIRE tool result into the
``execute_tool`` span (the ``gen_ai.choice`` event's ``message`` attribute =
json-serialized ``[{"text": ...}]``), and claude_code/codex return full CLI
transcripts of hundreds of KB. Under an OTel attribute value length limit
(``OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT`` — set by the platform's ADOT env, not
this repo) the SDK truncates that serialized JSON mid-string, which is exactly
an unparseable tool_output.

main.py's fix (the "Tool-span telemetry bounding" block, extracted and exec'd
here the same way test_telemetry_init.py extracts the init block) wraps
end_tool_call_span so only the COPY mirrored into telemetry is bounded; the
model still receives the full tool output and tool return values are
unchanged.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

import pytest
from opentelemetry import trace as trace_api
from opentelemetry.sdk.trace import TracerProvider as SDKTracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from strands import Agent, tool
from strands.models.model import Model

from test_telemetry_spans import _reset_otel_globals

# Captured at import (collection) time: tests/conftest.py's session-wide
# provider, restored after every reset so later modules keep their global.
_SESSION_PROVIDER = trace_api.get_tracer_provider()

MAIN_PY = Path(__file__).resolve().parent.parent / "main.py"
_START = "# --- Tool-span telemetry bounding (TEAM-3359 F3.2)"
_END = "\n# ---------------------------------------------------------------------------"

# The failing shape from the live sessions: a coding tool returning a full CLI
# transcript of hundreds of KB as one string.
BIG_TRANSCRIPT = "line of CLI transcript output\n" * 10_000  # 300k chars
SIMULATED_LIMIT = 1024  # OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT stand-in


def _load_bounding_block() -> dict[str, Any]:
    """Extract and exec the shipped bounding block (byte for byte).

    Exec'ing it also runs ``_install_tool_span_bounding()`` — i.e. it patches
    the real strands Tracer class, exactly as importing main.py does. Tests
    use the ``bounding_ns`` fixture, which restores the original afterwards.
    """
    src = MAIN_PY.read_text()
    start = src.index(_START)
    end = src.index(_END, start)
    ns: dict[str, Any] = {"os": os, "logger": logging.getLogger("test-tool-span-bounding")}
    exec(compile(src[start:end], str(MAIN_PY), "exec"), ns)  # noqa: S102
    return ns


@pytest.fixture
def bounding_ns() -> dict[str, Any]:
    """The exec'd block, with the strands Tracer patch undone on teardown."""
    from strands.telemetry.tracer import Tracer

    original = Tracer.end_tool_call_span
    ns = _load_bounding_block()
    yield ns
    Tracer.end_tool_call_span = original


@pytest.fixture
def limited_span_exporter(monkeypatch) -> InMemorySpanExporter:
    """A provider constructed UNDER the simulated platform attribute limit.

    SpanLimits reads OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT at provider
    construction, so the env var must be set first — the same mechanism the
    platform's ADOT env uses in production.
    """
    monkeypatch.setenv("OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT", str(SIMULATED_LIMIT))
    _reset_otel_globals()
    exporter = InMemorySpanExporter()
    provider = SDKTracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace_api.set_tracer_provider(provider)
    yield exporter
    _reset_otel_globals()
    trace_api.set_tracer_provider(_SESSION_PROVIDER)


# ─── Agent harness: one tool call, then a closing turn ───────────────────────


@tool
def fake_claude_code(task: str) -> str:
    """Stub coding tool returning a full CLI transcript (the failing shape)."""
    return BIG_TRANSCRIPT


@tool
def small_tool(task: str) -> str:
    """Stub tool with an ordinary small result."""
    return "a short result"


class ToolCallingModel(Model):
    """Turn 1 requests ``tool_name``; turn 2 (which SEES the tool result)
    finishes. ``seen_messages`` records what each turn received, so a test can
    assert the model-visible tool result is NOT truncated."""

    def __init__(self, tool_name: str = "fake_claude_code") -> None:
        self.config: dict[str, Any] = {"model_id": "mock-model"}
        self.tool_name = tool_name
        self.turn = 0
        self.seen_messages: list[Any] = []

    def update_config(self, **model_config: Any) -> None:
        self.config.update(model_config)

    def get_config(self) -> Any:
        return self.config

    def structured_output(self, *args: Any, **kwargs: Any) -> Any:  # pragma: no cover
        raise NotImplementedError

    async def stream(self, messages: Any, *args: Any, **kwargs: Any):
        self.turn += 1
        self.seen_messages.append(messages)
        yield {"messageStart": {"role": "assistant"}}
        if self.turn == 1:
            yield {
                "contentBlockStart": {
                    "start": {"toolUse": {"toolUseId": "t1", "name": self.tool_name}}
                }
            }
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"task":"go"}'}}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
        else:
            yield {"contentBlockDelta": {"delta": {"text": "done"}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}
        yield {
            "metadata": {
                "usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2},
                "metrics": {"latencyMs": 1},
            }
        }


async def _run_tool_agent(tool_fn=fake_claude_code, tool_name: str = "fake_claude_code") -> ToolCallingModel:
    model = ToolCallingModel(tool_name)
    agent = Agent(model=model, tools=[tool_fn], callback_handler=None, name="bounding_test")
    async for _ in agent.stream_async("go"):
        pass
    return model


def _tool_output_attr(exporter: InMemorySpanExporter) -> str:
    """The serialized tool output the eval service parses off the tool span."""
    tool_spans = [s for s in exporter.get_finished_spans() if s.name.startswith("execute_tool")]
    assert len(tool_spans) == 1, f"expected one tool span, got {[s.name for s in tool_spans]}"
    span = tool_spans[0]
    # The live error names this scope; it is part of the failing shape.
    assert span.instrumentation_scope.name == "strands.telemetry.tracer"
    choice_events = [e for e in span.events if e.name == "gen_ai.choice"]
    assert choice_events, f"span events: {[e.name for e in span.events]}"
    return dict(choice_events[0].attributes)["message"]


def _model_visible_tool_texts(model: ToolCallingModel) -> list[str]:
    texts = []
    for message in model.seen_messages[-1]:
        for block in message.get("content", []) or []:
            if isinstance(block, dict) and "toolResult" in block:
                for part in block["toolResult"].get("content", []) or []:
                    if isinstance(part, dict) and isinstance(part.get("text"), str):
                        texts.append(part["text"])
    return texts


# ─── The reproduction: the exact failing shape from the live sessions ────────


@pytest.fixture
def unwrapped_tracer(monkeypatch):
    """Guarantee the PRISTINE strands method for the reproduction test.

    Another module in the same pytest process (test_remote_coding.py imports
    main.py at collection) may already have installed the bounding wrapper on
    the real Tracer class; the wrapper publishes the original under
    ``__wrapped__`` (functools convention) precisely so it can be peeled off.
    """
    from strands.telemetry.tracer import Tracer

    method = Tracer.end_tool_call_span
    original = getattr(method, "__wrapped__", None) or method
    monkeypatch.setattr(Tracer, "end_tool_call_span", original)


@pytest.mark.asyncio
async def test_unbounded_tool_output_truncates_to_unparseable_json(
    limited_span_exporter: InMemorySpanExporter, unwrapped_tracer
) -> None:
    """WITHOUT the fix, the mirrored tool output is cut mid-JSON — the
    reproduction of the live ToolSpanMappingException. If a strands upgrade
    makes this pass, the wrapper in main.py may no longer be needed."""
    await _run_tool_agent()

    message = _tool_output_attr(limited_span_exporter)
    assert len(message) == SIMULATED_LIMIT, "the SDK limit should have truncated the value"
    with pytest.raises(json.JSONDecodeError):
        json.loads(message)


# ─── The fix: bounded mirror parses; the model still sees everything ─────────


@pytest.mark.asyncio
async def test_bounded_tool_output_is_parseable_and_model_sees_full_result(
    limited_span_exporter: InMemorySpanExporter, bounding_ns: dict[str, Any]
) -> None:
    model = await _run_tool_agent()

    message = _tool_output_attr(limited_span_exporter)
    assert len(message) < SIMULATED_LIMIT, "bounded value must fit under the SDK limit"
    parsed = json.loads(message)  # the eval service's "parse tool_output" step
    assert isinstance(parsed, list) and "text" in parsed[0]
    assert "truncated for telemetry" in parsed[0]["text"]
    assert parsed[0]["text"].startswith(BIG_TRANSCRIPT[:100])

    # The model-visible tool result is NOT truncated — telemetry only.
    texts = _model_visible_tool_texts(model)
    assert texts, "turn 2 never saw a toolResult block"
    assert any(t == BIG_TRANSCRIPT for t in texts), (
        f"model-visible tool result was altered (lengths: {[len(t) for t in texts]}, "
        f"expected {len(BIG_TRANSCRIPT)})"
    )


@pytest.mark.asyncio
async def test_small_tool_outputs_are_untouched(
    limited_span_exporter: InMemorySpanExporter, bounding_ns: dict[str, Any]
) -> None:
    """Bounding must not rewrite ordinary tool results."""
    await _run_tool_agent(small_tool, "small_tool")

    message = _tool_output_attr(limited_span_exporter)
    parsed = json.loads(message)
    assert parsed[0]["text"] == "a short result"
    assert "truncated for telemetry" not in message


# ─── Unit rows: _bound_tool_result_for_telemetry / _tool_span_text_limit ─────


def test_bound_returns_same_object_when_nothing_to_bound(bounding_ns) -> None:
    bound = bounding_ns["_bound_tool_result_for_telemetry"]
    result = {"toolUseId": "t1", "status": "success", "content": [{"text": "small"}]}
    assert bound(result) is result
    assert bound(None) is None
    assert bound("not a dict") == "not a dict"


def test_bound_caps_text_and_never_mutates_the_original(bounding_ns) -> None:
    bound = bounding_ns["_bound_tool_result_for_telemetry"]
    result = {"toolUseId": "t1", "status": "success", "content": [{"text": BIG_TRANSCRIPT}]}
    out = bound(result)
    assert out is not result
    assert result["content"][0]["text"] == BIG_TRANSCRIPT, "original must never be mutated"
    bounded_text = out["content"][0]["text"]
    assert len(bounded_text) < len(BIG_TRANSCRIPT)
    assert "truncated for telemetry" in bounded_text
    assert "the model received the full output" in bounded_text
    # Non-text blocks and small text blocks ride along unchanged.
    assert out["toolUseId"] == "t1" and out["status"] == "success"


def test_text_limit_defaults_and_tracks_the_env_limit(bounding_ns, monkeypatch) -> None:
    limit = bounding_ns["_tool_span_text_limit"]
    monkeypatch.delenv("OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT", raising=False)
    monkeypatch.delenv("OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT", raising=False)
    assert limit() == bounding_ns["_TOOL_SPAN_TEXT_LIMIT_DEFAULT"]

    # A quarter of the smallest configured limit: JSON quote/escape overhead
    # can inflate the serialized value, so the cap leaves ample headroom.
    monkeypatch.setenv("OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT", "4096")
    assert limit() == 1024

    # The smallest of the two limit vars wins.
    monkeypatch.setenv("OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT", "8192")
    monkeypatch.setenv("OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT", "4096")
    assert limit() == 1024

    # Absurdly small limits floor at 256 — better a slightly-truncated
    # attribute than an empty one.
    monkeypatch.setenv("OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT", "10")
    monkeypatch.delenv("OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT", raising=False)
    assert limit() == 256

    # A generous limit never RAISES the cap past the default.
    monkeypatch.setenv("OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT", "1000000")
    assert limit() == bounding_ns["_TOOL_SPAN_TEXT_LIMIT_DEFAULT"]

    monkeypatch.setenv("OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT", "not-a-number")
    assert limit() == bounding_ns["_TOOL_SPAN_TEXT_LIMIT_DEFAULT"]


def test_bounding_is_fail_open() -> None:
    """A pathological tool_result passes through un-bounded, never raises (R1.4).

    The block is exec'd with a recorder pre-installed as ``end_tool_call_span``
    so the wrapper's captured "original" is the recorder — the wrapper's own
    behavior is then observable in isolation from the real tracer.
    """
    from strands.telemetry.tracer import Tracer

    original = Tracer.end_tool_call_span
    recorded: dict[str, Any] = {}

    def _recorder(self, span, tool_result, error=None):
        recorded["tool_result"] = tool_result

    class Explosive(dict):
        def get(self, *args: Any, **kwargs: Any):
            raise RuntimeError("boom")

    try:
        Tracer.end_tool_call_span = _recorder
        _load_bounding_block()  # wraps the recorder
        wrapper = Tracer.end_tool_call_span
        assert wrapper is not _recorder, "the block failed to install its wrapper"

        explosive = Explosive()
        wrapper(object.__new__(Tracer), None, explosive)  # must not raise
        assert recorded["tool_result"] is explosive, (
            "on a bounding failure the ORIGINAL tool_result must pass through"
        )
    finally:
        Tracer.end_tool_call_span = original


def test_install_is_idempotent() -> None:
    """Re-running the installer must not stack wrappers (warm re-exec shape)."""
    from strands.telemetry.tracer import Tracer

    original = Tracer.end_tool_call_span
    try:
        ns = _load_bounding_block()
        once = Tracer.end_tool_call_span
        ns["_install_tool_span_bounding"]()
        assert Tracer.end_tool_call_span is once, "second install must be a no-op"
    finally:
        Tracer.end_tool_call_span = original
