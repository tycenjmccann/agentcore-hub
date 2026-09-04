#!/usr/bin/env python3
"""Unit tests for build_env_vars in deploy-one-robust.py (TEAM-3103 AC3.1).

Pure env-dict assembly — no AWS calls. The script is import-safe (deploy logic
sits behind `if __name__ == "__main__"`), but the filename is hyphenated, so we
load it via importlib.

Run: python3 -m unittest deploy/runtime-agent/test_build_env_vars.py
"""

import importlib.util
import os
import unittest
from pathlib import Path
from unittest import mock

_SCRIPT = Path(__file__).parent / "deploy-one-robust.py"

spec = importlib.util.spec_from_file_location("deploy_one_robust", _SCRIPT)
deploy_one_robust = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy_one_robust)

AGENT = "agentcore_hub_backend_dev"

# Platform/ADOT-managed vars the deploy path must never clobber (TEAM-3103
# design: only the two per-persona vars — OTEL_SERVICE_NAME and
# OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT — are ours to set).
# OTEL_RESOURCE_ATTRIBUTES is platform-injected with aws.log.group.names;
# setting it at deploy time replaces that value and breaks CloudWatch
# log-group correlation (TEAM-3313).
PLATFORM_MANAGED = [
    "AGENT_OBSERVABILITY_ENABLED",
    "OTEL_PYTHON_DISTRO",
    "OTEL_PYTHON_CONFIGURATOR",
    "OTEL_EXPORTER_OTLP_PROTOCOL",
    "OTEL_TRACES_EXPORTER",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_PROPAGATORS",
    "OTEL_RESOURCE_ATTRIBUTES",
    "DISABLE_ADOT_OBSERVABILITY",
]


class TestBuildEnvVars(unittest.TestCase):
    def build(self, extra_env=None):
        # clear=True: only ARTIFACT_BUCKET present, so optional passthroughs
        # (GATEWAY_ARN, MCP_SERVERS, ...) from the host env can't leak in.
        env = {"ARTIFACT_BUCKET": "test-bucket"}
        if extra_env:
            env.update(extra_env)
        with mock.patch.dict(os.environ, env, clear=True):
            return deploy_one_robust.build_env_vars(AGENT, f"prompts/{AGENT}.txt")

    def test_otel_service_name(self):
        self.assertEqual(self.build()["OTEL_SERVICE_NAME"], AGENT)

    def test_otel_resource_attributes_not_set(self):
        # TEAM-3313: covered by the PLATFORM_MANAGED guard too, but assert
        # explicitly — this var regressing silently breaks log correlation.
        self.assertNotIn("OTEL_RESOURCE_ATTRIBUTES", self.build())

    def test_genai_message_capture(self):
        self.assertEqual(
            self.build()["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"], "true"
        )

    def test_platform_managed_vars_absent(self):
        env = self.build()
        for key in PLATFORM_MANAGED:
            self.assertNotIn(key, env, f"{key} is platform-managed and must not be set")

    def test_prompt_cache_vars_absent_when_unset(self):
        # TEAM-3953: main.py owns the defaults (cache on, ttl 1h); the deploy
        # path passes these through ONLY when set in the shell env.
        env = self.build()
        self.assertNotIn("PERSONA_PROMPT_CACHE", env)
        self.assertNotIn("PERSONA_CACHE_TTL", env)

    def test_prompt_cache_vars_passed_through_when_set(self):
        env = self.build(
            {"PERSONA_PROMPT_CACHE": "0", "PERSONA_CACHE_TTL": "5m"}
        )
        self.assertEqual(env["PERSONA_PROMPT_CACHE"], "0")
        self.assertEqual(env["PERSONA_CACHE_TTL"], "5m")


if __name__ == "__main__":
    unittest.main()
