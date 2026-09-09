#!/usr/bin/env python3
"""Fleet cold-start healthcheck — the pipeline's post-promote smoke.

The fleet's heavy imports are LAZY (the MCP transport lives inside the tool-mount
function), so a dependency API break passes `docker build`, passes
UpdateAgentRuntime's READY check, and only surfaces when a persona cold-starts.
Fleet v41 (2026-09-09) did exactly that: every session died in under a second at
`from mcp.client.streamable_http import streamablehttp_client` and the fleet
stayed broken for ten hours, bug_fixer included, so the pipeline could not
self-heal. `_healthcheck` runs those imports on demand and the promote script
rolls the image back when the OK marker is missing.

Hermetic: reuses test_remote_coding's import stubs and stubs the lazy import
surface too (strands_tools / the MCP transport are not installed in CI), so what
is under test is the check's structure and failure reporting — the REAL imports
are asserted at image-build time by the Dockerfile and in prod by the smoke call.

Run: env -u AWS_PROFILE pytest deploy/runtime-agent/test_healthcheck.py
"""

import asyncio
import json
import sys
import types
import unittest
from unittest import mock

from test_remote_coding import main  # shared stubbed import of main.py


def _module(name, **attrs):
    mod = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    return mod


def _install_lazy_import_stubs(mcp_transport_names=("streamablehttp_client",)):
    """Register the modules _healthcheck imports lazily.

    mcp_transport_names controls which symbol(s) the MCP transport module
    exposes — () reproduces the v41 break (neither the old nor the new name).
    """
    saved = {k: sys.modules.get(k) for k in (
        "strands.tools", "strands.tools.mcp", "mcp", "mcp.client",
        "mcp.client.streamable_http", "strands_tools",
        "strands_tools.code_interpreter", "strands_tools.browser",
        "aws_bedrock_token_generator",
    )}

    strands_tools_pkg = _module("strands.tools")
    strands_tools_mcp = _module("strands.tools.mcp", MCPClient=object)
    strands_tools_pkg.mcp = strands_tools_mcp
    sys.modules["strands.tools"] = strands_tools_pkg
    sys.modules["strands.tools.mcp"] = strands_tools_mcp
    sys.modules["strands"].tools = strands_tools_pkg

    transport = _module("mcp.client.streamable_http",
                        **{n: (lambda **_k: None) for n in mcp_transport_names})
    mcp_client = _module("mcp.client", streamable_http=transport)
    mcp_pkg = _module("mcp", client=mcp_client)
    sys.modules["mcp"] = mcp_pkg
    sys.modules["mcp.client"] = mcp_client
    sys.modules["mcp.client.streamable_http"] = transport

    tool_names = ("http_request", "current_time", "calculator", "file_read",
                  "file_write", "editor", "shell", "environment", "python_repl",
                  "retrieve")
    st = _module("strands_tools", **{n: object() for n in tool_names})
    st_ci = _module("strands_tools.code_interpreter", AgentCoreCodeInterpreter=object)
    st_br = _module("strands_tools.browser", AgentCoreBrowser=object)
    st.code_interpreter, st.browser = st_ci, st_br
    sys.modules["strands_tools"] = st
    sys.modules["strands_tools.code_interpreter"] = st_ci
    sys.modules["strands_tools.browser"] = st_br

    sys.modules["aws_bedrock_token_generator"] = _module(
        "aws_bedrock_token_generator", provide_token=lambda **_k: "tok"
    )
    return saved


def _restore(saved):
    for k, v in saved.items():
        if v is None:
            sys.modules.pop(k, None)
        else:
            sys.modules[k] = v


class HealthcheckTestCase(unittest.TestCase):
    def setUp(self):
        self._saved = _install_lazy_import_stubs()
        self.addCleanup(_restore, self._saved)

    def test_ok_when_every_lazy_import_resolves(self):
        # ARTIFACT_BUCKET empty → the roster read is skipped (roster == -1), so
        # this exercises the import path alone.
        with mock.patch.object(main, "ARTIFACT_BUCKET", ""):
            result = main._healthcheck()
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["marker"], main.HEALTHCHECK_OK)
        self.assertEqual(result["roster"], -1)
        # Versions are reported for the deps that have broken us before.
        for dist in ("mcp", "strands-agents", "boto3"):
            self.assertIn(dist, result["versions"])

    def test_reports_not_ok_when_the_mcp_transport_import_breaks(self):
        # v41: mcp 2.x exposed NEITHER the old nor the new name under the name
        # our compat block tries first.
        _restore(self._saved)
        self._saved = _install_lazy_import_stubs(mcp_transport_names=())
        with mock.patch.object(main, "ARTIFACT_BUCKET", ""):
            result = main._healthcheck()
        self.assertFalse(result["ok"])
        self.assertEqual(result["marker"], main.HEALTHCHECK_FAIL)
        self.assertIn("cannot import name", result["error"])

    def test_the_compat_name_alone_is_enough(self):
        # mcp 2.x's rename must NOT fail the check — main.py falls back to it.
        _restore(self._saved)
        self._saved = _install_lazy_import_stubs(
            mcp_transport_names=("streamable_http_client",)
        )
        with mock.patch.object(main, "ARTIFACT_BUCKET", ""):
            result = main._healthcheck()
        self.assertTrue(result["ok"], result)

    def test_roster_read_failure_is_a_failure(self):
        # The roster read also proves S3 + the runtime's IAM role.
        with mock.patch.object(main, "ARTIFACT_BUCKET", "bucket"), \
             mock.patch.object(main.boto3, "client",
                               side_effect=RuntimeError("AccessDenied")):
            result = main._healthcheck()
        self.assertFalse(result["ok"])
        self.assertIn("AccessDenied", result["error"])

    def test_roster_count_is_returned_when_the_read_succeeds(self):
        body = mock.MagicMock()
        body.read.return_value = json.dumps(
            {"agents": [{"agentId": "a"}, {"agentId": "b"}]}
        ).encode()
        s3 = mock.MagicMock()
        s3.get_object.return_value = {"Body": body}
        with mock.patch.object(main, "ARTIFACT_BUCKET", "bucket"), \
             mock.patch.object(main.boto3, "client", return_value=s3):
            result = main._healthcheck()
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["roster"], 2)

    def test_entrypoint_short_circuits_before_any_agent_work(self):
        async def _collect():
            out = []
            with mock.patch.object(main, "_run_agent_invocation",
                                   side_effect=AssertionError("must not run the agent")), \
                 mock.patch.object(main, "ARTIFACT_BUCKET", ""):
                async for ev in main.agent_invocation({"healthcheck": True}, None):
                    out.append(ev)
            return out

        events = asyncio.run(_collect())
        self.assertEqual(len(events), 1)
        text = events[0]["event"]["contentBlockDelta"]["delta"]["text"]
        self.assertEqual(json.loads(text)["marker"], main.HEALTHCHECK_OK)


if __name__ == "__main__":
    unittest.main()
