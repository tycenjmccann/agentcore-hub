#!/usr/bin/env python3
"""Unit tests for the OTel telemetry init block in main.py (TEAM-3103 AC1.5).

Importing main.py wholesale pulls strands/bedrock_agentcore/boto3 clients, so
instead we extract the real shipped init block (between its '# --- OTel
telemetry init' markers) from main.py source and exec it against mocked
opentelemetry/strands modules. This tests the exact code that ships, without
its heavyweight neighbors.

Run: python3 -m unittest deploy/runtime-agent/test_telemetry_init.py
"""

import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

_MAIN = Path(__file__).parent / "main.py"
_START = "# --- OTel telemetry init (TEAM-3102)"
_END = "\n# ---------------------------------------------------------------------------"


def _extract_block():
    src = _MAIN.read_text()
    start = src.index(_START)
    end = src.index(_END, start)
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


if __name__ == "__main__":
    unittest.main()
