"""F3.1 (TEAM-3359) regression tests: the synthetic fallback invoke_agent span.

The eval service selects a session's agent invocation by
``gen_ai.operation.name == "invoke_agent"``; the Strands SDK emits that span
only once ``Agent(...)`` is constructed and invoked. Every failure BEFORE that
point (started-event publish, model-override construction, builtin tools,
connectors, MCP clients) used to leave the session with zero invoke_agent
spans, and the eval service then failed every evaluator with
ValidationException ("none of the spans contain the required agent
invocation"). main.py now emits ONE synthetic fallback span in that window —
and must emit NOTHING once the SDK owns the span.

Same harness as test_telemetry_spans.py: the shipped ``_run_agent_invocation``
is extracted from main.py source and driven byte for byte; exec'd functions
resolve module-level names in their exec namespace at call time, so a test can
swap any collaborator (e.g. make ``_apply_connectors`` raise) after loading.
Hermetic: stub model, in-memory exporter, no AWS.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from opentelemetry import trace as trace_api
from opentelemetry.sdk.trace import TracerProvider as SDKTracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

from test_telemetry_spans import (
    MockModel,
    _load_production_entrypoints,
    _reset_otel_globals,
)

AGENT_ID = "agentcore_hub_backend_dev"

# The synthetic span is emitted via get_tracer(__name__); in production that is
# "main", and the exec namespace supplies the same so the scope name below is
# exactly what ships.
SYNTHETIC_SCOPE = "main"
SDK_SCOPE = "strands.telemetry.tracer"


# ─── Fixtures (local: order-independent of the other modules' teardowns) ─────

# Captured at import (collection) time, BEFORE any test resets the globals:
# tests/conftest.py installed the session-wide provider at its own import, and
# test_telemetry.py — which runs alphabetically after this module — depends on
# that provider still being the global. Every teardown here restores it.
_SESSION_PROVIDER = trace_api.get_tracer_provider()


@pytest.fixture
def clean_otel():
    _reset_otel_globals()
    yield
    _reset_otel_globals()
    trace_api.set_tracer_provider(_SESSION_PROVIDER)


@pytest.fixture
def span_exporter(clean_otel) -> InMemorySpanExporter:
    exporter = InMemorySpanExporter()
    provider = SDKTracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace_api.set_tracer_provider(provider)
    return exporter


def _load_ns() -> dict[str, Any]:
    ns = _load_production_entrypoints()
    # exec namespaces have no __name__; the shipped code calls
    # get_tracer(__name__), which in production resolves to "main".
    ns["__name__"] = SYNTHETIC_SCOPE
    return ns


def _payload(**extra) -> dict[str, Any]:
    return {"prompt": "hello", "workflow_id": "wf_x", "agent_id": AGENT_ID, **extra}


def _invoke_spans(exporter: InMemorySpanExporter):
    return [
        s
        for s in exporter.get_finished_spans()
        if s.attributes.get("gen_ai.operation.name") == "invoke_agent"
    ]


def _raise_pre_agent(*args, **kwargs):
    raise RuntimeError("pre-agent failure")


# The five real pre-Agent failure points (design §7.1). Each entry is the
# namespace overrides that make exactly that step raise, plus any payload
# extras needed to reach it. (_load_prompt_for_agent is internally fail-safe
# and deliberately absent.)
FAILURE_POINTS: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {
    "_publish_agent_started": ({"_publish_agent_started": _raise_pre_agent}, {}),
    "model_override_construction": (
        {
            "BotocoreConfig": lambda **kwargs: SimpleNamespace(**kwargs),
            "BedrockModel": _raise_pre_agent,
        },
        {"model_override": "opus"},
    ),
    "_load_builtin_tools": ({"_load_builtin_tools": _raise_pre_agent}, {}),
    "_apply_connectors": ({"_apply_connectors": _raise_pre_agent}, {}),
    "_create_mcp_clients": ({"_create_mcp_clients": _raise_pre_agent}, {}),
}


# ─── 1 + 6: every pre-Agent failure point emits exactly one synthetic span ───


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_point", list(FAILURE_POINTS))
async def test_pre_agent_failure_emits_synthetic_invoke_agent_span(
    span_exporter: InMemorySpanExporter, failure_point: str
) -> None:
    overrides, payload_extra = FAILURE_POINTS[failure_point]
    ns = _load_ns()
    ns.update(overrides)
    ctx = SimpleNamespace(session_id="sess-pre-agent")

    # The original exception must propagate unchanged.
    with pytest.raises(RuntimeError, match="pre-agent failure"):
        async for _ in ns["_run_agent_invocation"](_payload(**payload_extra), ctx):
            pass

    spans = _invoke_spans(span_exporter)
    assert len(spans) == 1, (
        f"expected exactly one invoke_agent span for {failure_point}, got "
        f"{[(s.name, s.instrumentation_scope.name) for s in span_exporter.get_finished_spans()]}"
    )
    span = spans[0]
    assert span.name == f"invoke_agent {AGENT_ID}"
    assert span.instrumentation_scope.name == SYNTHETIC_SCOPE
    # The eval-packager keys spans by session.id; the synthetic span must carry
    # the full hoisted _trace_attrs, not just the operation name.
    assert span.attributes["session.id"] == "sess-pre-agent"
    assert span.attributes["gen_ai.agent.name"] == AGENT_ID
    assert span.attributes["agent.id"] == AGENT_ID
    assert span.attributes["workflow.id"] == "wf_x"
    assert span.attributes["error.type"] == "RuntimeError"
    assert span.status.status_code == StatusCode.ERROR


@pytest.mark.asyncio
async def test_synthetic_span_session_id_falls_back_to_workflow(
    span_exporter: InMemorySpanExporter,
) -> None:
    """The hoisted _trace_attrs keep the wf-<workflow_id> fallback — an unkeyed
    synthetic span would be as invisible to the eval-packager as no span."""
    ns = _load_ns()
    ns["_apply_connectors"] = _raise_pre_agent

    with pytest.raises(RuntimeError):
        async for _ in ns["_run_agent_invocation"](_payload(), SimpleNamespace()):
            pass

    (span,) = _invoke_spans(span_exporter)
    assert span.attributes["session.id"] == "wf-wf_x"


# ─── 2: happy path — the SDK's span only, no synthetic double ─────────────────


@pytest.mark.asyncio
async def test_happy_path_emits_exactly_one_sdk_span_and_no_synthetic(
    span_exporter: InMemorySpanExporter,
) -> None:
    ns = _load_ns()
    ctx = SimpleNamespace(session_id="sess-happy")

    events = [event async for event in ns["_run_agent_invocation"](_payload(), ctx)]
    assert events, "the agent loop never ran"

    spans = _invoke_spans(span_exporter)
    assert len(spans) == 1, "double emission would corrupt evaluator attribution"
    assert spans[0].instrumentation_scope.name == SDK_SCOPE
    assert spans[0].status.status_code != StatusCode.ERROR
    assert all(
        s.instrumentation_scope.name != SYNTHETIC_SCOPE
        for s in span_exporter.get_finished_spans()
    ), "no synthetic span may exist on the happy path"


# ─── 3: mid-stream failure — the SDK owns the span, still no synthetic ────────


class MidStreamFailingModel(MockModel):
    """Streams one event, then dies — the Agent exists, so the SDK owns the
    invoke_agent span and the synthetic path must stay silent."""

    async def stream(self, *args: Any, **kwargs: Any):
        yield {"messageStart": {"role": "assistant"}}
        raise ConnectionError("bedrock dropped the stream")


@pytest.mark.asyncio
async def test_midstream_failure_keeps_sdk_span_and_emits_no_synthetic(
    span_exporter: InMemorySpanExporter,
) -> None:
    ns = _load_ns()
    ns["model"] = MidStreamFailingModel()
    ctx = SimpleNamespace(session_id="sess-midstream")

    with pytest.raises(ConnectionError):
        async for _ in ns["_run_agent_invocation"](_payload(), ctx):
            pass

    spans = _invoke_spans(span_exporter)
    assert len(spans) == 1, "the SDK's span must still be exported on a mid-stream failure"
    assert spans[0].instrumentation_scope.name == SDK_SCOPE
    assert all(
        s.instrumentation_scope.name != SYNTHETIC_SCOPE
        for s in span_exporter.get_finished_spans()
    ), "agent is not None here — a synthetic second span would corrupt eval traces"


# ─── 4: fail-open — a broken tracer must not mask the original exception ──────


@pytest.mark.asyncio
async def test_synthetic_path_is_fail_open(
    span_exporter: InMemorySpanExporter, monkeypatch
) -> None:
    ns = _load_ns()

    def _original_failure(agent_id, connectors=None):
        raise ValueError("the original failure")

    ns["_apply_connectors"] = _original_failure

    def _broken_get_tracer(*args: Any, **kwargs: Any):
        raise RuntimeError("tracer exploded")

    monkeypatch.setattr(trace_api, "get_tracer", _broken_get_tracer)

    # The ORIGINAL exception type propagates; no telemetry exception escapes.
    with pytest.raises(ValueError, match="the original failure"):
        async for _ in ns["_run_agent_invocation"](
            _payload(), SimpleNamespace(session_id="sess-failopen")
        ):
            pass


# ─── 5: the finally force_flush runs on the error path too ────────────────────


@pytest.mark.asyncio
async def test_force_flush_runs_on_the_error_path(
    span_exporter: InMemorySpanExporter,
) -> None:
    ns = _load_ns()
    ns["_apply_connectors"] = _raise_pre_agent

    provider = trace_api.get_tracer_provider()
    real_flush = provider.force_flush
    flush_calls: list[int] = []

    def recording_flush(timeout_millis: int = 30000) -> bool:
        flush_calls.append(timeout_millis)
        return real_flush(timeout_millis)

    provider.force_flush = recording_flush

    with pytest.raises(RuntimeError):
        async for _ in ns["_run_agent_invocation"](
            _payload(), SimpleNamespace(session_id="sess-flush")
        ):
            pass

    assert flush_calls == [5000], (
        "the finally force_flush must run on the error path (it delivers the "
        f"synthetic span), got {flush_calls}"
    )
