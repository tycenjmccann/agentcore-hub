#!/usr/bin/env python3
"""Unit tests for the OTel telemetry init block in main.py (TEAM-3103 AC1.5).

Importing main.py wholesale pulls strands/bedrock_agentcore/boto3 clients, so
instead we extract the real shipped init block (between its '# --- OTel
telemetry init' markers) from main.py source and exec it against mocked
opentelemetry/strands modules. This tests the exact code that ships, without
its heavyweight neighbors.

Run: python3 -m unittest deploy/runtime-agent/test_telemetry_init.py
"""

import asyncio
import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

_MAIN = Path(__file__).parent / "main.py"
_START = "# --- OTel telemetry init (TEAM-3102)"
_ANCHOR_START = "# --- Session anchor span (TEAM-3366"
_END = "\n# ---------------------------------------------------------------------------"


def _extract_block(start_marker=_START):
    src = _MAIN.read_text()
    start = src.index(start_marker)
    end = src.index(_END, start)
    return src[start:end]


def _extract_anchor_helper():
    """The shipped _emit_session_anchor_span (TEAM-3366 P0-A), from def to the
    next module-level def — same extract-and-exec approach as the init block."""
    src = _MAIN.read_text()
    start = src.index("async def _emit_session_anchor_span")
    end = src.index("\ndef ", start)
    return src[start:end]


def _fake_modules(provider, strands_telemetry_cls):
    fake_otel = types.ModuleType("opentelemetry")
    fake_otel.trace = types.SimpleNamespace(get_tracer_provider=lambda: provider)
    fake_strands_telemetry = types.ModuleType("strands.telemetry")
    fake_strands_telemetry.StrandsTelemetry = strands_telemetry_cls
    fake_strands = types.ModuleType("strands")
    fake_strands.telemetry = fake_strands_telemetry
    return {
        "opentelemetry": fake_otel,
        "strands": fake_strands,
        "strands.telemetry": fake_strands_telemetry,
    }


class TestTelemetryInit(unittest.TestCase):
    def test_block_extraction_sane(self):
        block = _extract_block()
        self.assertIn("def _init_telemetry", block)
        self.assertIn("_init_telemetry()", block)
        self.assertIn("_TELEMETRY_INITIALIZED", block)

    def test_adot_provider_attaches_nothing(self):
        # Provider exposing add_span_processor → ADOT owns the pipeline;
        # StrandsTelemetry must never be constructed.
        provider = types.SimpleNamespace(add_span_processor=lambda p: None)
        strands_cls = mock.Mock()
        ns = {"logger": mock.Mock()}
        with mock.patch.dict(sys.modules, _fake_modules(provider, strands_cls)):
            exec(compile(_extract_block(), str(_MAIN), "exec"), ns)
        strands_cls.assert_not_called()
        self.assertTrue(ns["_TELEMETRY_INITIALIZED"])

    def test_no_sdk_provider_installs_strands_fallback(self):
        # Bare object() (API-default ProxyTracerProvider stand-in, no
        # add_span_processor) → StrandsTelemetry().setup_otlp_exporter() once.
        # The fallback is gated on AGENT_OBSERVABILITY_ENABLED=true (the
        # gate-off cases live in tests/test_telemetry_spans.py).
        strands_cls = mock.Mock()
        ns = {"logger": mock.Mock()}
        with mock.patch.dict(sys.modules, _fake_modules(object(), strands_cls)), \
                mock.patch.dict(os.environ, {"AGENT_OBSERVABILITY_ENABLED": "true"}):
            exec(compile(_extract_block(), str(_MAIN), "exec"), ns)
        strands_cls.assert_called_once_with()
        strands_cls.return_value.setup_otlp_exporter.assert_called_once_with()
        self.assertTrue(ns["_TELEMETRY_INITIALIZED"])

    def test_idempotent_on_repeat_calls(self):
        # Warm microVM re-entry: repeat _init_telemetry() calls are no-ops —
        # StrandsTelemetry constructed at most once.
        strands_cls = mock.Mock()
        ns = {"logger": mock.Mock()}
        with mock.patch.dict(sys.modules, _fake_modules(object(), strands_cls)), \
                mock.patch.dict(os.environ, {"AGENT_OBSERVABILITY_ENABLED": "true"}):
            exec(compile(_extract_block(), str(_MAIN), "exec"), ns)
            ns["_init_telemetry"]()
            ns["_init_telemetry"]()
        strands_cls.assert_called_once()
        strands_cls.return_value.setup_otlp_exporter.assert_called_once()

    def test_init_failure_swallowed(self):
        # TEAM-3313: telemetry init failure must never abort module import
        # (which would kill the agent before app = BedrockAgentCoreApp()).
        def _raise():
            raise RuntimeError("otel exploded")

        fake = _fake_modules(object(), mock.Mock())
        fake["opentelemetry"].trace = types.SimpleNamespace(
            get_tracer_provider=_raise
        )
        logger = mock.Mock()
        ns = {"logger": logger}
        with mock.patch.dict(sys.modules, fake):
            exec(compile(_extract_block(), str(_MAIN), "exec"), ns)
        logger.warning.assert_called_once()
        self.assertTrue(ns["_TELEMETRY_INITIALIZED"])

    def test_init_failure_not_retried(self):
        # After a failed attempt, repeat calls stay no-ops — retrying against
        # partially-mutated global OTel state is worse than no telemetry.
        strands_cls = mock.Mock()
        strands_cls.return_value.setup_otlp_exporter.side_effect = RuntimeError(
            "otlp endpoint down"
        )
        logger = mock.Mock()
        ns = {"logger": logger}
        with mock.patch.dict(sys.modules, _fake_modules(object(), strands_cls)), \
                mock.patch.dict(os.environ, {"AGENT_OBSERVABILITY_ENABLED": "true"}):
            exec(compile(_extract_block(), str(_MAIN), "exec"), ns)
            ns["_init_telemetry"]()
        strands_cls.assert_called_once()
        logger.warning.assert_called_once()
        self.assertTrue(ns["_TELEMETRY_INITIALIZED"])

    def test_anchor_span_fail_open(self):
        # TEAM-3366 P0-A: the anchor span helper must never break an
        # invocation — a tracer failure is swallowed and logged once.
        def _raise(*args, **kwargs):
            raise RuntimeError("otel exploded")

        fake = _fake_modules(object(), mock.Mock())
        fake["opentelemetry"].trace = types.SimpleNamespace(get_tracer=_raise)
        logger = mock.Mock()
        ns = {"logger": logger}
        with mock.patch.dict(sys.modules, fake):
            exec(compile(_extract_anchor_helper(), str(_MAIN), "exec"), ns)
            result = asyncio.run(ns["_emit_session_anchor_span"](
                "test_agent", "sess-123", "wf-1", "T-1"
            ))
        self.assertIsNone(result)
        logger.warning.assert_called_once()

    def test_idempotent_on_adot_path(self):
        provider = types.SimpleNamespace(add_span_processor=lambda p: None)
        strands_cls = mock.Mock()
        logger = mock.Mock()
        ns = {"logger": logger}
        with mock.patch.dict(sys.modules, _fake_modules(provider, strands_cls)):
            exec(compile(_extract_block(), str(_MAIN), "exec"), ns)
            first_info_calls = logger.info.call_count
            ns["_init_telemetry"]()
        strands_cls.assert_not_called()
        self.assertEqual(logger.info.call_count, first_info_calls)


class TestSessionAnchorSpan(unittest.TestCase):
    """TEAM-3366 P0-A: _emit_session_anchor_span from main.py, extracted and
    exec'd the same way as the init block. The real opentelemetry SDK is
    installed for these tests (tests/requirements-test.txt), but the helper is
    pointed at a LOCAL in-memory SDK provider via a fake `opentelemetry`
    module, so no test ever mutates the process-global TracerProvider."""

    def _load_helper(self, fake_trace, logger=None):
        # The helper imports opentelemetry at CALL time, so the fake module
        # must be in sys.modules during each call — not just during exec.
        fake_otel = types.ModuleType("opentelemetry")
        fake_otel.trace = fake_trace
        ns = {"logger": logger or mock.Mock()}
        exec(compile(_extract_block(_ANCHOR_START), str(_MAIN), "exec"), ns)

        def call(*args):
            with mock.patch.dict(sys.modules, {"opentelemetry": fake_otel}):
                return asyncio.run(ns["_emit_session_anchor_span"](*args))

        return call

    @staticmethod
    def _sdk_provider_and_exporter():
        from opentelemetry import trace as real_trace
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import SimpleSpanProcessor
        from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
            InMemorySpanExporter,
        )

        exporter = InMemorySpanExporter()
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        fake_trace = types.SimpleNamespace(
            get_tracer=provider.get_tracer,
            get_tracer_provider=lambda: provider,
            set_tracer_provider=mock.Mock(),
            SpanKind=real_trace.SpanKind,
        )
        return provider, exporter, fake_trace

    def test_anchor_span_exported_without_agent_loop(self):
        # The whole point of the anchor: one ENDED, spec-compliant invoke_agent
        # span exists in the exporter with NO Agent loop having run at all.
        _provider, exporter, fake_trace = self._sdk_provider_and_exporter()
        helper = self._load_helper(fake_trace)

        helper("test_agent", "sess-123", "wf-1", "TEAM-1")

        spans = exporter.get_finished_spans()
        self.assertEqual(len(spans), 1)
        span = spans[0]
        self.assertEqual(span.name, "invoke_agent test_agent")
        self.assertIsNotNone(span.end_time)
        self.assertEqual(span.attributes.get("gen_ai.operation.name"), "invoke_agent")
        self.assertEqual(span.attributes.get("session.id"), "sess-123")
        self.assertIs(span.attributes.get("agentcore.hub.anchor"), True)

    def test_anchor_session_id_falls_back_to_workflow_id(self):
        # TEAM-3387: no runtime session_id (direct_code_deploy fallback path)
        # → the anchor keys itself as wf-<workflow_id>, the same fallback the
        # SDK span's trace_attributes use, because an unkeyed span is
        # invisible to the eval service.
        _provider, exporter, fake_trace = self._sdk_provider_and_exporter()
        helper = self._load_helper(fake_trace)

        helper("test_agent", None, "wf-1", "TEAM-1")

        spans = exporter.get_finished_spans()
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0].attributes.get("session.id"), "wf-wf-1")

    def test_anchor_fail_open_on_tracer_error(self):
        # get_tracer exploding must neither raise out of the helper (it runs
        # in the invocation hot path) nor stay silent — one warning logged.
        def _raise(*args, **kwargs):
            raise RuntimeError("otel exploded")

        logger = mock.Mock()
        helper = self._load_helper(
            types.SimpleNamespace(get_tracer=_raise), logger=logger
        )

        helper("test_agent", "sess-123", "wf-1", "TEAM-1")  # must not raise

        logger.warning.assert_called_once()

    def test_anchor_never_replaces_tracer_provider(self):
        # _init_telemetry invariant (TEAM-3102/TEAM-3313): under an existing
        # (ADOT-owned) provider the helper may only read it — the global
        # provider identity is unchanged and set_tracer_provider never called.
        provider, _exporter, fake_trace = self._sdk_provider_and_exporter()
        helper = self._load_helper(fake_trace)

        helper("test_agent", "sess-123", "wf-1", "TEAM-1")

        self.assertIs(fake_trace.get_tracer_provider(), provider)
        fake_trace.set_tracer_provider.assert_not_called()


if __name__ == "__main__":
    unittest.main()
