"""Shared telemetry fixtures for the runtime-agent test suite.

The OTel global TracerProvider can be set only ONCE per process, and strands'
Tracer is a module singleton that captures the global provider on first use.
So the in-memory provider must be installed session-wide, before any Agent
runs, and every test reads/clears the same exporter.
"""

import pytest
from opentelemetry import trace as trace_api
from opentelemetry.sdk.trace import TracerProvider as SDKTracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

_EXPORTER = InMemorySpanExporter()
_PROVIDER = SDKTracerProvider()
_PROVIDER.add_span_processor(SimpleSpanProcessor(_EXPORTER))
trace_api.set_tracer_provider(_PROVIDER)


@pytest.fixture()
def span_exporter():
    """The process-global in-memory exporter, cleared before each test."""
    _EXPORTER.clear()
    return _EXPORTER
