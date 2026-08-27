#!/usr/bin/env python3
"""Unit tests for the remote coding-runtime handoff (TEAM-3119 / TEAM-3121) —
pure fixtures, no AWS.

Run: cd deploy/runtime-agent && python3 -m unittest test_remote_coding.py

Covers the two silent-hang gaps from the stuck-fleet postmortem:
  A. _drain_coding_sse must enforce a wall-clock deadline — the client's
     per-read timeout resets on every SSE frame, so a coding runtime that
     streams forever without a done frame otherwise blocks the persona
     indefinitely.
  B. Both failure exits of _remote_coding_turn must publish an agent.error
     event (same events table the dashboard/Workflow Manager read) while
     still returning the ERROR string to the LLM.

main.py needs strands / bedrock_agentcore / httpx at import time; those are
stubbed below so this suite runs hermetically (boto3 is real but never called
against AWS — clients are constructed, requests are mocked).
"""

import importlib.util
import json
import os
import sys
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock


def _install_import_stubs():
    """Provide just enough of main.py's third-party surface to import it."""
    if "strands" not in sys.modules:
        strands = types.ModuleType("strands")
        strands.Agent = mock.MagicMock(name="Agent")
        strands.tool = lambda f: f  # used only as a bare decorator
        strands_models = types.ModuleType("strands.models")

        class BedrockModel:
            def __init__(self, *args, **kwargs):
                pass

        strands_models.BedrockModel = BedrockModel
        strands.models = strands_models
        sys.modules["strands"] = strands
        sys.modules["strands.models"] = strands_models

    if "bedrock_agentcore" not in sys.modules:
        bac = types.ModuleType("bedrock_agentcore")
        bac_runtime = types.ModuleType("bedrock_agentcore.runtime")

        class BedrockAgentCoreApp:
            def entrypoint(self, func):
                return func

            def run(self):
                pass

        bac_runtime.BedrockAgentCoreApp = BedrockAgentCoreApp
        bac.runtime = bac_runtime
        sys.modules["bedrock_agentcore"] = bac
        sys.modules["bedrock_agentcore.runtime"] = bac_runtime

    if "httpx" not in sys.modules:
        httpx = types.ModuleType("httpx")

        class Auth:  # subclassed by _SigV4HttpxAuth at module level
            pass

        httpx.Auth = Auth
        sys.modules["httpx"] = httpx


def _import_main():
    """Import main.py from this directory under a stable module name."""
    _install_import_stubs()
    # main.py's import-time bootstrap installs Node.js unless this marker
    # exists, and chdirs to /tmp — skip the install, restore the cwd.
    Path("/tmp/.node_installed").touch()
    os.environ.pop("SYSTEM_PROMPT_S3_KEY", None)
    cwd = os.getcwd()
    try:
        spec = importlib.util.spec_from_file_location(
            "runtime_agent_main", Path(__file__).parent / "main.py"
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules["runtime_agent_main"] = module
        spec.loader.exec_module(module)
        return module
    finally:
        os.chdir(cwd)


main = _import_main()


class NeverDoneBody:
    """Fake response stream: SSE text frames keep flowing, done never comes —
    the TEAM-3119 hang (per-read timeout resets on every frame). Time-bounded
    so a missing deadline fails the assertions instead of hanging the suite."""

    def __init__(self, max_seconds=8.0):
        self._stop_at = time.monotonic() + max_seconds
        self.closed = False

    def iter_lines(self):
        while time.monotonic() < self._stop_at:
            yield b'data: {"type": "text", "text": "still working..."}'
            time.sleep(0.01)

    def close(self):
        self.closed = True


class BufferedBody:
    """Fake buffered (non-SSE) response body."""

    def __init__(self, obj):
        self._data = json.dumps(obj).encode("utf-8")

    def read(self):
        return self._data


class TestDrainCodingSseDeadline(unittest.TestCase):
    """Test A — the core TEAM-3119 regression."""

    def test_frames_forever_without_done_hits_deadline(self):
        body = NeverDoneBody()
        box = {}

        def run():
            try:
                box["result"] = main._drain_coding_sse(body, deadline_s=0.5)
            except TypeError as e:
                # Pre-fix signature: no wall-clock deadline exists at all.
                box["result"] = {"error": f"no wall-clock deadline support: {e}"}
            except Exception as e:  # noqa: BLE001 — any escape is a test failure, not a hang
                box["result"] = {"error": f"unexpected exception: {e}"}

        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        worker.join(timeout=10)

        self.assertFalse(
            worker.is_alive(),
            "_drain_coding_sse is still blocked on a never-done stream — "
            "no wall-clock deadline (TEAM-3119 silent hang)",
        )
        self.assertEqual(
            box["result"].get("error"),
            "coding turn exceeded 0.5s without completion (deadline)",
        )
        self.assertTrue(body.closed, "stream body was not closed on deadline expiry")

    def test_done_frame_still_wins_under_deadline(self):
        class DoneBody:
            def iter_lines(self):
                yield b'data: {"type": "text", "text": "working"}'
                yield b'data: {"type": "done", "response": "all done", "claude_session_id": "s-1"}'

            def close(self):
                pass

        result = main._drain_coding_sse(DoneBody(), deadline_s=30)
        self.assertEqual(result.get("response"), "all done")
        self.assertNotIn("error", result)


class TestRemoteCodingTurnSurfacesAgentError(unittest.TestCase):
    """Test B — both failure exits emit agent.error and keep the ERROR string."""

    def setUp(self):
        main._CODING_SESSION.update({
            "session_id": None,
            "conversation_ids": {},
            "repo": None,
            "recorded": False,
            "resume_transcript": None,
            "resume_session_id": None,
            "branch": None,
            "git_mode": None,
            "clone_url": None,
        })
        main._CURRENT_WORKFLOW_ID = "wf-test"
        main._CURRENT_AGENT_ID = "frontend_dev"
        main._CURRENT_TICKET_ID = "TEAM-3119"

    def _assert_agent_error_published(self, events_client, expected_fragment):
        self.assertTrue(
            events_client.put_item.called,
            "no agent.error event was published for a failed coding turn",
        )
        kwargs = events_client.put_item.call_args.kwargs
        item = kwargs["Item"]
        self.assertEqual(item["type"]["S"], "agent.error")
        detail = item["detail"]["M"]
        self.assertEqual(detail["agentId"]["S"], "frontend_dev")
        self.assertEqual(detail["workflowId"]["S"], "wf-test")
        self.assertEqual(detail["ticketId"]["S"], "TEAM-3119")
        self.assertIn(expected_fragment, detail["error"]["S"])

    def test_error_result_publishes_agent_error(self):
        fake_client = mock.MagicMock()
        fake_client.invoke_agent_runtime.return_value = {
            "contentType": "application/json",
            "response": BufferedBody({"error": "claude timed out after 1500s"}),
        }
        events_client = mock.MagicMock()
        with mock.patch.object(main.boto3, "client", return_value=fake_client), \
             mock.patch.object(main, "_ddb_events_client", events_client):
            out = main._remote_coding_turn("do the thing", "claude")

        self.assertTrue(out.startswith("ERROR: remote claude turn failed:"))
        self.assertIn("claude timed out after 1500s", out)
        self._assert_agent_error_published(events_client, "claude timed out after 1500s")

    def test_invoke_exception_publishes_agent_error(self):
        fake_client = mock.MagicMock()
        fake_client.invoke_agent_runtime.side_effect = RuntimeError("connection reset by peer")
        events_client = mock.MagicMock()
        with mock.patch.object(main.boto3, "client", return_value=fake_client), \
             mock.patch.object(main, "_ddb_events_client", events_client):
            out = main._remote_coding_turn("do the thing", "codex")

        self.assertTrue(out.startswith("ERROR: remote codex turn failed:"))
        self.assertIn("connection reset by peer", out)
        self._assert_agent_error_published(events_client, "connection reset by peer")


if __name__ == "__main__":
    unittest.main()
