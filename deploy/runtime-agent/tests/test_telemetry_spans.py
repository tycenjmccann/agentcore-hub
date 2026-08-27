"""Offline regression tests for the runtime agent's OTel instrumentation.

These tests exist because of a silent, expensive failure: eval batches scored
0/10 for every persona, and the cause was not agent quality at all — main.py
never registered a TracerProvider, so Strands' Tracer no-opped and the
`invoke_agent` span the evaluator requires was never exported. Nothing in the
runtime failed loudly; the spans simply weren't there.

So there are exactly two things worth pinning down here:

  1. That a Strands ``Agent`` consumed the way main.py consumes it (manually
     iterating ``stream_async``) really does emit one ``invoke_agent`` span with
     the attributes the evaluator matches on. This is an assertion about the
     installed Strands version, and it is meant to break loudly on upgrade if
     the span shape changes.
  2. That ``_init_telemetry()`` makes the correct decision in all three states
     it can find the process in: a real provider already installed by
     auto-instrumentation, no provider with observability enabled, and no
     provider with observability off.

Hermetic by construction: no AWS, no network, no credentials. The model is a
stub and spans go to an in-memory exporter.
"""

from __future__ import annotations

import ast
import logging
import os
from pathlib import Path
from typing import Any, AsyncGenerator

import pytest
from opentelemetry import trace as trace_api
from opentelemetry.sdk.trace import TracerProvider as SDKTracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.util._once import Once

from strands import Agent
from strands.models.model import Model

MAIN_PY = Path(__file__).resolve().parent.parent / "main.py"


# ─── Test doubles ────────────────────────────────────────────────────────────


class MockModel(Model):
    """A Model that streams a fixed reply without touching Bedrock.

    ``config`` is a real attribute because ``Agent._start_agent_trace_span``
    reads ``self.model.config.get("model_id")`` to populate
    ``gen_ai.request.model``.
    """

    def __init__(self, text: str = "hello back") -> None:
        self.config: dict[str, Any] = {"model_id": "mock-model"}
        self._text = text

    def update_config(self, **model_config: Any) -> None:
        self.config.update(model_config)

    def get_config(self) -> Any:
        return self.config

    def structured_output(self, *args: Any, **kwargs: Any) -> Any:  # pragma: no cover
        raise NotImplementedError("structured output is not exercised by these tests")

    async def stream(self, *args: Any, **kwargs: Any) -> AsyncGenerator[dict[str, Any], None]:
        # The exact event sequence strands.event_loop.streaming.process_stream
        # expects. Omitting any of these makes the event loop raise rather than
        # close the span, which would look like a telemetry failure.
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockDelta": {"delta": {"text": self._text}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}
        yield {
            "metadata": {
                "usage": {"inputTokens": 3, "outputTokens": 2, "totalTokens": 5},
                "metrics": {"latencyMs": 1, "timeToFirstByteMs": 1},
            }
        }


# ─── Fixtures ────────────────────────────────────────────────────────────────


def _reset_otel_globals() -> None:
    """Un-set the process-global TracerProvider.

    ``trace_api.set_tracer_provider`` is deliberately write-once (a module-level
    ``Once``), which is right for a real process and useless for a test suite
    that needs three different global states. Reaching into these internals is
    the accepted way to reset them; it is confined to this helper.
    """
    trace_api._TRACER_PROVIDER = None
    trace_api._TRACER_PROVIDER_SET_ONCE = Once()
    # Strands caches its Tracer (and with it the provider it resolved) in a
    # module-level singleton, so clearing the OTel global alone is not enough.
    import strands.telemetry.tracer as strands_tracer

    strands_tracer._tracer_instance = None


@pytest.fixture
def clean_otel():
    """Give each test a pristine OTel global state, before *and* after.

    Cleaning up afterwards matters as much as before: one test installs a real
    provider via StrandsTelemetry, and leaking that into the next test would
    make its "no provider configured" precondition silently false.
    """
    _reset_otel_globals()
    yield
    _reset_otel_globals()


@pytest.fixture
def span_exporter(clean_otel) -> InMemorySpanExporter:
    """Install a real SDK provider exporting to memory, and hand back the sink.

    SimpleSpanProcessor rather than BatchSpanProcessor: spans are readable the
    instant they end, with no flush and no background thread.
    """
    exporter = InMemorySpanExporter()
    provider = SDKTracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace_api.set_tracer_provider(provider)
    return exporter


# ─── Test 1: the span the evaluator actually looks for ───────────────────────


@pytest.mark.asyncio
async def test_stream_async_emits_invoke_agent_span(span_exporter: InMemorySpanExporter) -> None:
    """A manually-consumed stream_async emits exactly one invoke_agent span.

    "Exactly one" is the load-bearing part. The evaluator selects the agent
    invocation from a session's spans by
    ``gen_ai.operation.name == "invoke_agent"``; zero matches is the 0/10 bug,
    and more than one would make attribution ambiguous.
    """
    # Constructed *inside* the test, after the fixture installed the provider:
    # Agent.__init__ calls get_tracer(), which resolves and caches the provider
    # at construction time.
    agent = Agent(
        model=MockModel(),
        name="test_agent",
        system_prompt="You are a test agent.",
        tools=[],
        callback_handler=None,
    )

    # Mirrors main.py's consumption loop: iterate the async generator to
    # completion rather than calling agent() or awaiting invoke_async, because
    # that is the code path the runtime actually takes.
    events = [event async for event in agent.stream_async("hello")]
    assert events, "stream_async yielded nothing — the event loop never ran"

    invoke_spans = [
        span
        for span in span_exporter.get_finished_spans()
        if span.attributes.get("gen_ai.operation.name") == "invoke_agent"
    ]
    assert len(invoke_spans) == 1, (
        "expected exactly one invoke_agent span, got "
        f"{[(s.name, dict(s.attributes)) for s in span_exporter.get_finished_spans()]}"
    )
    span = invoke_spans[0]

    # The evaluator resolves spans by instrumentation scope, so this name is
    # part of the contract, not an implementation detail.
    assert span.instrumentation_scope.name == "strands.telemetry.tracer"
    assert span.name == "invoke_agent test_agent"

    attrs = dict(span.attributes)
    # `name=` on the Agent is what puts the persona id on the span.
    assert attrs["gen_ai.agent.name"] == "test_agent"
    assert attrs["gen_ai.system"] == "strands-agents"
    assert attrs["gen_ai.request.model"] == "mock-model"
    # Passed through as a **kwarg by _start_agent_trace_span, so it lands as a
    # plain span attribute rather than a gen_ai.* one.
    assert attrs["system_prompt"] == "You are a test agent."

    # Under the default (legacy) GenAI conventions the message content rides on
    # span events. The evaluator reads the prompt and the response from these.
    events_by_name = {event.name: dict(event.attributes or {}) for event in span.events}
    assert "gen_ai.user.message" in events_by_name, f"span events: {list(events_by_name)}"
    assert "content" in events_by_name["gen_ai.user.message"]
    assert "hello" in events_by_name["gen_ai.user.message"]["content"]
    assert "gen_ai.choice" in events_by_name, f"span events: {list(events_by_name)}"
    assert "message" in events_by_name["gen_ai.choice"]
    assert "hello back" in events_by_name["gen_ai.choice"]["message"]


@pytest.mark.asyncio
async def test_trace_attributes_land_on_the_invoke_agent_span(
    span_exporter: InMemorySpanExporter,
) -> None:
    """trace_attributes are what tie a span back to a persona and a workflow run.

    main.py passes ``{"agent.id": …, "workflow.id": …}``; without them a span
    can be found but not attributed.
    """
    agent = Agent(
        model=MockModel(),
        name="agentcore_hub_backend_dev",
        system_prompt="You are a test agent.",
        tools=[],
        callback_handler=None,
        trace_attributes={"agent.id": "agentcore_hub_backend_dev", "workflow.id": "wf-123"},
    )

    async for _ in agent.stream_async("hello"):
        pass

    (span,) = [
        s
        for s in span_exporter.get_finished_spans()
        if s.attributes.get("gen_ai.operation.name") == "invoke_agent"
    ]
    assert span.attributes["agent.id"] == "agentcore_hub_backend_dev"
    assert span.attributes["workflow.id"] == "wf-123"


# ─── Test 2: _init_telemetry's three decisions ───────────────────────────────


def _load_init_telemetry(logger: logging.Logger):
    """Extract ``_init_telemetry`` from main.py and compile it in isolation.

    Why not just import main.py? Because importing it is not possible offline:
    module scope reads a dozen AWS env vars, imports ``bedrock_agentcore``,
    downloads a Node toolchain, and fetches system prompts from S3 — and it
    calls ``_init_telemetry()`` itself at import time, which would consume the
    very global state each case below needs to control.

    sys.modules monkeypatching was the alternative and it is worse: it would
    take a stub per third-party import and still run every side effect at module
    scope. Parsing the file and compiling the single function definition keeps
    the test honest (it executes the shipped source, byte for byte, and fails if
    the function is renamed or deleted) without executing anything else.
    """
    tree = ast.parse(MAIN_PY.read_text())
    func = next(
        (
            node
            for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "_init_telemetry"
        ),
        None,
    )
    assert func is not None, (
        f"_init_telemetry is not defined at module scope in {MAIN_PY}. It must run at import "
        "time, before any Agent is constructed — if it moved inside a function, the fix is dead."
    )

    module = ast.Module(body=[func], type_ignores=[])
    namespace: dict[str, Any] = {"os": os, "logger": logger}
    exec(compile(module, str(MAIN_PY), "exec"), namespace)  # noqa: S102
    return namespace["_init_telemetry"]


def test_init_telemetry_runs_before_any_agent_is_constructed() -> None:
    """The guard is worthless if it runs after the tracer singleton is cached."""
    tree = ast.parse(MAIN_PY.read_text())
    call_line = next(
        (
            node.lineno
            for node in tree.body
            if isinstance(node, ast.Expr)
            and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Name)
            and node.value.func.id == "_init_telemetry"
        ),
        None,
    )
    assert call_line is not None, "main.py defines _init_telemetry but never calls it at module scope"

    first_model = next(
        (
            node.lineno
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in {"Agent", "BedrockModel"}
        ),
        None,
    )
    if first_model is not None:
        assert call_line < first_model, (
            f"_init_telemetry() is called at line {call_line}, after the first "
            f"Agent/BedrockModel construction at line {first_model}"
        )


def test_init_telemetry_keeps_an_existing_provider(clean_otel, caplog) -> None:
    """Auto-instrumentation wins: never register a second provider over ADOT's.

    On the container path the Dockerfile CMD is ``opentelemetry-instrument``, and
    on direct_code_deploy the platform injects ADOT — either way a real provider
    is global before main.py loads. Replacing it would send spans to a second,
    unconfigured pipeline and lose them.
    """
    existing = SDKTracerProvider()
    trace_api.set_tracer_provider(existing)

    logger = logging.getLogger("test-telemetry-existing")
    with caplog.at_level(logging.INFO, logger=logger.name):
        _load_init_telemetry(logger)()

    assert trace_api.get_tracer_provider() is existing
    assert "existing global TracerProvider" in caplog.text


def test_init_telemetry_installs_fallback_when_observability_enabled(
    clean_otel, caplog, monkeypatch
) -> None:
    """No provider + AGENT_OBSERVABILITY_ENABLED=true → install one.

    This is the branch that actually fixes the 0/10 scores: the deploy paths set
    the OTel env vars but nothing calls set_tracer_provider, so without this
    StrandsTelemetry fallback the provider stays a ProxyTracerProvider forever.
    """
    monkeypatch.setenv("AGENT_OBSERVABILITY_ENABLED", "true")
    # Keep the exporter pointed at a local, unused port: it is constructed but
    # never flushed (no spans are emitted here), so nothing leaves the process.
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318")
    assert isinstance(trace_api.get_tracer_provider(), trace_api.ProxyTracerProvider)

    logger = logging.getLogger("test-telemetry-fallback")
    with caplog.at_level(logging.WARNING, logger=logger.name):
        _load_init_telemetry(logger)()

    provider = trace_api.get_tracer_provider()
    assert not isinstance(provider, trace_api.ProxyTracerProvider)
    assert isinstance(provider, SDKTracerProvider), f"unexpected provider {type(provider)}"
    assert "OTLP fallback active" in caplog.text

    # The point of registering a provider at all: Strands' Tracer must now
    # resolve to a real, recording tracer instead of a no-op.
    from strands.telemetry.tracer import get_tracer

    assert not isinstance(get_tracer().tracer_provider, trace_api.ProxyTracerProvider)

    provider.shutdown()


def test_init_telemetry_no_provider_when_observability_disabled(
    clean_otel, caplog, monkeypatch
) -> None:
    """No provider + observability not enabled → stay a no-op, but say so.

    Silently no-opping is exactly how this bug survived, so the warning is part
    of the contract: it is the string the DEPLOY.md startup probe greps for.
    """
    monkeypatch.delenv("AGENT_OBSERVABILITY_ENABLED", raising=False)

    logger = logging.getLogger("test-telemetry-disabled")
    with caplog.at_level(logging.WARNING, logger=logger.name):
        _load_init_telemetry(logger)()

    assert isinstance(trace_api.get_tracer_provider(), trace_api.ProxyTracerProvider)
    assert "spans will NOT be exported" in caplog.text


@pytest.mark.parametrize("value", ["false", "0", "", "TRUE "])
def test_init_telemetry_only_accepts_the_literal_true(clean_otel, monkeypatch, value: str) -> None:
    """The gate is an exact, case-insensitive "true" — nothing else opts in."""
    monkeypatch.setenv("AGENT_OBSERVABILITY_ENABLED", value)
    _load_init_telemetry(logging.getLogger("test-telemetry-gate"))()
    assert isinstance(trace_api.get_tracer_provider(), trace_api.ProxyTracerProvider)
