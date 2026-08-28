"""R1 regression tests: invoke_agent span emission (AC1) and fail-open init (R1.4).

These tests pin the strands SDK contract that deploy/runtime-agent/main.py
relies on (design decision D2): main.py passes name=agent_id and
trace_attributes={"session.id": ..., ...} to Agent(...) and does NOT open an
explicit wrapper span, because the SDK itself emits the
`invoke_agent {agent_name}` span (gen_ai.operation.name=invoke_agent,
gen_ai.agent.name=<name>, custom trace_attributes merged in) around the whole
model-loop. If a strands upgrade breaks that contract, these tests fail and
online evaluations would go back to seeing zero invoke_agent spans.

main.py itself is not imported here: its module top-level has heavy side
effects (Node.js install, S3 prompt fetch, chdir). The telemetry init block it
runs (StrandsTelemetry + setup_otlp_exporter, try/except-wrapped) is exercised
directly in test_broken_otlp_endpoint_does_not_raise below.
"""

import ast
import asyncio
import logging
from pathlib import Path

import pytest
from strands import Agent
from strands.models import Model

MAIN_PY = Path(__file__).resolve().parent.parent / "main.py"


def _load_anchor_helper():
    """Extract _emit_session_anchor_span from main.py's shipped source.

    Same rationale as test_telemetry_spans.py's loaders: importing main.py
    wholesale is impossible offline (module scope hits AWS/Node/S3), so the
    single function under test is compiled in isolation — byte for byte, with
    original line numbers — and fails loudly if it is renamed or deleted.
    """
    tree = ast.parse(MAIN_PY.read_text())
    func = next(
        (
            node
            for node in tree.body
            if isinstance(node, ast.FunctionDef)
            and node.name == "_emit_session_anchor_span"
        ),
        None,
    )
    assert func is not None, (
        f"_emit_session_anchor_span is not defined at module scope in {MAIN_PY}"
    )
    namespace = {"logger": logging.getLogger("test-anchor-span")}
    exec(compile(ast.Module(body=[func], type_ignores=[]), str(MAIN_PY), "exec"), namespace)
    return namespace["_emit_session_anchor_span"]


class FakeModel(Model):
    """Minimal in-process model: yields one canned text response, no network."""

    def __init__(self):
        self._config = {"model_id": "fake-model"}

    def update_config(self, **model_config):
        self._config.update(model_config)

    def get_config(self):
        return self._config

    async def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):
        raise NotImplementedError

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {}}}
        yield {"contentBlockDelta": {"delta": {"text": "canned response"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}
        yield {
            "metadata": {
                "usage": {"inputTokens": 1, "outputTokens": 2, "totalTokens": 3},
                "metrics": {"latencyMs": 1},
            }
        }


def _invoke_agent(**agent_kwargs):
    agent = Agent(model=FakeModel(), callback_handler=None, **agent_kwargs)
    return agent("hi")


def _find_invoke_agent_span(exporter):
    spans = [
        s
        for s in exporter.get_finished_spans()
        if s.attributes.get("gen_ai.operation.name") == "invoke_agent"
    ]
    assert spans, (
        "no span with gen_ai.operation.name=invoke_agent — the exact failure "
        "mode online evaluations reported. Finished spans: "
        f"{[s.name for s in exporter.get_finished_spans()]}"
    )
    assert len(spans) == 1, f"expected exactly one invoke_agent span, got {len(spans)}"
    return spans[0]


def test_invoke_agent_span_emitted_with_agent_name(span_exporter):
    """R1 AC1: one span with gen_ai.operation.name=invoke_agent and
    gen_ai.agent.name equal to the Agent name= arg (main.py passes agent_id)."""
    result = _invoke_agent(name="test_agent", system_prompt="You are a test agent.")
    assert "canned response" in str(result)

    span = _find_invoke_agent_span(span_exporter)
    assert span.name == "invoke_agent test_agent"
    assert span.attributes.get("gen_ai.agent.name") == "test_agent"


def test_trace_attributes_land_on_invoke_agent_span(span_exporter):
    """D2: trace_attributes propagate onto the invoke_agent span — main.py
    relies on session.id being there so evaluations can find the span on the
    session's traces."""
    _invoke_agent(
        name="test_agent",
        trace_attributes={"session.id": "sess-123", "workflow.id": "wf-1"},
    )

    span = _find_invoke_agent_span(span_exporter)
    assert span.attributes.get("session.id") == "sess-123"
    assert span.attributes.get("workflow.id") == "wf-1"


def test_broken_otlp_endpoint_does_not_raise(span_exporter, monkeypatch):
    """R1.4: StrandsTelemetry + setup_otlp_exporter with a broken OTLP endpoint
    must not raise at init (exporter failure is deferred to the background
    export thread), and a subsequent agent invocation completes normally.

    Note: the global TracerProvider is already set by conftest, so this also
    exercises the warm-process shape from main.py's D1 comment — the second
    provider is refused globally (OTel logs a warning, no exception)."""
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")

    from strands.telemetry import StrandsTelemetry

    telemetry = StrandsTelemetry()
    telemetry.setup_otlp_exporter()

    result = _invoke_agent(name="test_agent")
    assert "canned response" in str(result)
    _find_invoke_agent_span(span_exporter)


# ─── TEAM-3366 P0-A: session anchor span ─────────────────────────────────────
# The SDK's invoke_agent span above only exports once the whole agent loop
# ENDS. Detached persona runs keep that loop open for hours; a microVM
# interruption loses the un-ended span and the session becomes unevaluable.
# _emit_session_anchor_span closes that gap with a short-lived, spec-compliant
# invoke_agent span emitted (and flushed) at handler entry.


class BlockingModel(FakeModel):
    """A model whose stream never completes — a stand-in for an hours-long
    remote-coding turn holding the SDK's invoke_agent span open."""

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        yield {"messageStart": {"role": "assistant"}}
        await asyncio.Event().wait()  # blocks until cancelled


def test_anchor_span_exported_without_agent_loop(span_exporter):
    """The anchor alone — no Agent run at all — yields one ENDED, exported,
    spec-compliant invoke_agent span carrying the eval-packager keys."""
    _load_anchor_helper()("test_agent", "sess-123", "wf-1", "T-1")

    spans = span_exporter.get_finished_spans()
    assert len(spans) == 1, f"expected exactly one span, got {[s.name for s in spans]}"
    span = spans[0]
    assert span.attributes.get("gen_ai.operation.name") == "invoke_agent"
    assert span.name == "invoke_agent test_agent"
    assert span.attributes.get("gen_ai.agent.name") == "test_agent"
    assert span.attributes.get("session.id") == "sess-123"
    assert span.attributes.get("agentcore.hub.anchor") is True
    assert span.end_time is not None, "anchor span must be ENDED at emission time"


@pytest.mark.asyncio
async def test_interrupted_agent_loop_still_yields_invoke_agent_span(span_exporter):
    """Simulated microVM death mid-loop: cancel the Agent task while its model
    stream is blocked. The exporter must already hold an invoke_agent span
    keyed by session.id — the anchor, emitted before the loop started."""
    _load_anchor_helper()("test_agent", "sess-dead", "wf-1", "T-1")

    agent = Agent(
        model=BlockingModel(),
        name="test_agent",
        callback_handler=None,
        trace_attributes={"session.id": "sess-dead"},
    )

    async def _consume():
        async for _ in agent.stream_async("hi"):
            pass

    task = asyncio.create_task(_consume())
    await asyncio.sleep(0.05)  # let the loop start and block in the model stream
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    anchored = [
        s
        for s in span_exporter.get_finished_spans()
        if s.attributes.get("gen_ai.operation.name") == "invoke_agent"
        and s.attributes.get("session.id") == "sess-dead"
    ]
    assert anchored, (
        "no invoke_agent span with the session.id survived the interruption — "
        "the exact failure online evals reported. Finished spans: "
        f"{[s.name for s in span_exporter.get_finished_spans()]}"
    )
    assert any(s.attributes.get("agentcore.hub.anchor") for s in anchored)


def test_anchor_plus_completed_run_yields_both_spans(span_exporter):
    """Happy path: anchor + completed run coexist, distinguishable by the
    agentcore.hub.anchor attribute (so eval tooling can prefer the real one)."""
    _load_anchor_helper()("test_agent", "sess-123", "wf-1", "T-1")
    _invoke_agent(name="test_agent", trace_attributes={"session.id": "sess-123"})

    spans = [
        s
        for s in span_exporter.get_finished_spans()
        if s.attributes.get("gen_ai.operation.name") == "invoke_agent"
    ]
    assert len(spans) == 2, f"expected anchor + SDK spans, got {[s.name for s in spans]}"
    anchors = [s for s in spans if s.attributes.get("agentcore.hub.anchor")]
    sdk_spans = [s for s in spans if not s.attributes.get("agentcore.hub.anchor")]
    assert len(anchors) == 1 and len(sdk_spans) == 1
    assert anchors[0].name == "invoke_agent test_agent"
    assert sdk_spans[0].attributes.get("gen_ai.agent.name") == "test_agent"
