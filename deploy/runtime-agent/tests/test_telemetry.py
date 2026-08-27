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

import logging
from pathlib import Path

from strands import Agent
from strands.models import Model

_MAIN = Path(__file__).parent.parent / "main.py"


def _load_anchor_helper():
    """Extract _emit_session_anchor_span from main.py (TEAM-3366 P0-A) and exec
    it standalone — same reason as above: main.py itself can't be imported. The
    helper binds the process-global TracerProvider set up in conftest.py."""
    src = _MAIN.read_text()
    start = src.index("# --- Session anchor span (TEAM-3366")
    end = src.index(
        "\n# ---------------------------------------------------------------------------",
        start,
    )
    ns = {"logger": logging.getLogger("test-anchor")}
    exec(compile(src[start:end], str(_MAIN), "exec"), ns)
    return ns["_emit_session_anchor_span"]


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


def test_anchor_span_exported_without_agent_loop(span_exporter):
    """TEAM-3366 P0-A: the session-anchor helper alone — no Agent loop at all —
    yields one exported, ended, spec-compliant invoke_agent span. This is the
    microVM-interrupted-mid-loop scenario where the SDK's own loop-spanning
    invoke_agent span is lost."""
    _load_anchor_helper()("test_agent", "sess-123", "wf-1", "TEAM-1")

    span = _find_invoke_agent_span(span_exporter)
    assert span.name == "invoke_agent test_agent"
    assert span.end_time is not None
    assert span.attributes.get("gen_ai.agent.name") == "test_agent"
    assert span.attributes.get("session.id") == "sess-123"
    assert span.attributes.get("agentcore.hub.anchor") is True


def test_anchor_plus_completed_run_yields_two_distinguishable_spans(span_exporter):
    """TEAM-3366 P0-A: a run that DOES complete produces the anchor span plus
    the SDK's loop span — two invoke_agent spans, distinguishable by the
    agentcore.hub.anchor attribute so evals/dashboards can tell them apart."""
    _load_anchor_helper()("test_agent", "sess-123", "wf-1", "TEAM-1")
    _invoke_agent(name="test_agent")

    spans = [
        s
        for s in span_exporter.get_finished_spans()
        if s.attributes.get("gen_ai.operation.name") == "invoke_agent"
    ]
    assert len(spans) == 2, f"expected anchor + SDK loop span, got {len(spans)}"
    anchors = [s for s in spans if s.attributes.get("agentcore.hub.anchor") is True]
    assert len(anchors) == 1
    assert all(s.name == "invoke_agent test_agent" for s in spans)
