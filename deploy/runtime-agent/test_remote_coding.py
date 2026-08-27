#!/usr/bin/env python3
"""Unit tests for the remote coding-runtime handoff (TEAM-3168 / TEAM-3194,
prior work TEAM-3119 / TEAM-3121) — pure fixtures, no AWS.

Run: cd deploy/runtime-agent && python3 -m unittest test_remote_coding.py

Covers the silent-hang gaps from the stuck-fleet postmortem (a nested
InvokeAgentRuntime to the coding runtime hung forever, leaving a dangling
status=UNSET "Bedrock AgentCore.InvokeAgentRuntime" span):
  A. _drain_coding_sse must enforce a wall-clock deadline — the client's
     per-read timeout resets on every SSE frame, so a coding runtime that
     streams forever without a done frame otherwise blocks the persona
     indefinitely.
  B. _drain_coding_sse must ALSO trip when the stream goes fully idle (the
     underlying read blocks and never returns a frame) — a deadline check
     that only runs between frames never fires on a wedged read.
  C. Both failure exits of _remote_coding_turn must publish an agent.error
     event (same events table the dashboard/Workflow Manager read) AND mark
     the active OTEL span with status=ERROR, while still returning the
     ERROR string to the LLM.

main.py needs strands / bedrock_agentcore / httpx at import time; those are
stubbed below so this suite runs hermetically (boto3 is real but never called
against AWS — clients are constructed, requests are mocked)."""

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


def _install_otel_stub():
    """Stub opentelemetry so _record_span_error's imports resolve without the
    real SDK; returns the MagicMock span it will hand out."""
    span = mock.MagicMock(name="current_span")
    otel = types.ModuleType("opentelemetry")
    trace_mod = types.ModuleType("opentelemetry.trace")

    class StatusCode:
        ERROR = "ERROR"
        OK = "OK"
        UNSET = "UNSET"

    class Status:
        def __init__(self, status_code, description=""):
            self.status_code = status_code
            self.description = description

    trace_mod.get_current_span = lambda: span
    trace_mod.Status = Status
    trace_mod.StatusCode = StatusCode
    otel.trace = trace_mod
    sys.modules["opentelemetry"] = otel
    sys.modules["opentelemetry.trace"] = trace_mod
    return span


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


_OTEL_SPAN = _install_otel_stub()
main = _import_main()


class NeverDoneBody:
    """Fake response stream: SSE text frames keep flowing, done never comes —
    the per-read timeout resets on every frame, so only a wall-clock deadline
    stops the drain. Time-bounded so a missing deadline fails the assertions
    instead of hanging the suite."""

    def __init__(self, max_seconds=8.0):
        self._stop_at = time.monotonic() + max_seconds
        self.closed = False

    def iter_lines(self):
        while time.monotonic() < self._stop_at:
            yield b'data: {"type": "text", "text": "still working..."}'
            time.sleep(0.01)

    def close(self):
        self.closed = True


class SilentBody:
    """Fake response stream whose read blocks and never yields a frame — the
    wedged-socket variant of the hang (a between-frames deadline check never
    runs because iter_lines never returns). Time-bounded for suite safety."""

    def __init__(self, max_seconds=8.0):
        self._max_seconds = max_seconds
        self._closed_event = threading.Event()
        self.closed = False

    def iter_lines(self):
        self._closed_event.wait(timeout=self._max_seconds)
        return iter(())

    def close(self):
        self.closed = True
        self._closed_event.set()


class BufferedBody:
    """Fake buffered (non-SSE) response body."""

    def __init__(self, obj):
        self._data = json.dumps(obj).encode("utf-8")

    def read(self):
        return self._data


class TestDrainCodingSseDeadline(unittest.TestCase):
    """Tests A + B — the core silent-hang regression."""

    def _drain_in_thread(self, body, **kwargs):
        box = {}

        def run():
            try:
                box["result"] = main._drain_coding_sse(body, **kwargs)
            except TypeError as e:
                # Pre-fix signature: no wall-clock deadline exists at all.
                box["result"] = {"error": f"no wall-clock deadline support: {e}"}
            except Exception as e:  # noqa: BLE001 — any escape is a test failure, not a hang
                box["result"] = {"error": f"unexpected exception: {e}"}

        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        worker.join(timeout=10)
        return worker, box

    def test_frames_forever_without_done_hits_deadline(self):
        body = NeverDoneBody()
        worker, box = self._drain_in_thread(body, deadline_s=0.5)

        self.assertFalse(
            worker.is_alive(),
            "_drain_coding_sse is still blocked on a never-done stream — "
            "no wall-clock deadline (TEAM-3168 silent hang)",
        )
        self.assertEqual(
            box["result"].get("error"),
            "coding turn exceeded 0.5s without completion (deadline)",
        )
        self.assertTrue(body.closed, "stream body was not closed on deadline expiry")

    def test_idle_stream_with_no_frames_hits_idle_timeout(self):
        body = SilentBody()
        worker, box = self._drain_in_thread(body, deadline_s=5, idle_timeout_s=0.3)

        self.assertFalse(
            worker.is_alive(),
            "_drain_coding_sse is still blocked on a silent stream — a "
            "wedged read never trips a between-frames deadline check "
            "(TEAM-3194 idle-stream hang)",
        )
        self.assertEqual(
            box["result"].get("error"),
            "coding stream sent no frame for 0.3s (idle timeout)",
        )
        self.assertTrue(body.closed, "stream body was not closed on idle expiry")

    def test_idle_stream_past_deadline_reports_deadline(self):
        body = SilentBody()
        worker, box = self._drain_in_thread(body, deadline_s=0.3, idle_timeout_s=5)

        self.assertFalse(worker.is_alive())
        self.assertEqual(
            box["result"].get("error"),
            "coding turn exceeded 0.3s without completion (deadline)",
        )
        self.assertTrue(body.closed)

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

    def test_reader_exception_propagates(self):
        class BrokenBody:
            def iter_lines(self):
                yield b'data: {"type": "text", "text": "working"}'
                raise ConnectionError("connection reset by peer")

            def close(self):
                pass

        with self.assertRaises(ConnectionError):
            main._drain_coding_sse(BrokenBody(), deadline_s=30)


class TestRemoteCodingTurnSurfacesErrors(unittest.TestCase):
    """Test C — both failure exits emit agent.error, mark the OTEL span
    status=ERROR, and keep the ERROR string returned to the LLM."""

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
        main._CURRENT_TICKET_ID = "TEAM-3194"
        _OTEL_SPAN.reset_mock()

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
        self.assertEqual(detail["ticketId"]["S"], "TEAM-3194")
        self.assertIn(expected_fragment, detail["error"]["S"])

    def _assert_span_marked_error(self, expected_fragment):
        self.assertTrue(
            _OTEL_SPAN.set_status.called,
            "active OTEL span was not marked failed — the "
            "InvokeAgentRuntime trace stays status=UNSET",
        )
        status = _OTEL_SPAN.set_status.call_args.args[0]
        self.assertEqual(status.status_code, "ERROR")
        self.assertIn(expected_fragment, status.description)

    def test_error_result_publishes_agent_error_and_marks_span(self):
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
        self._assert_span_marked_error("claude timed out after 1500s")

    def test_invoke_exception_publishes_agent_error_and_marks_span(self):
        fake_client = mock.MagicMock()
        fake_client.invoke_agent_runtime.side_effect = RuntimeError("connection reset by peer")
        events_client = mock.MagicMock()
        with mock.patch.object(main.boto3, "client", return_value=fake_client), \
             mock.patch.object(main, "_ddb_events_client", events_client):
            out = main._remote_coding_turn("do the thing", "codex")

        self.assertTrue(out.startswith("ERROR: remote codex turn failed:"))
        self.assertIn("connection reset by peer", out)
        self._assert_agent_error_published(events_client, "connection reset by peer")
        self._assert_span_marked_error("connection reset by peer")
        self.assertTrue(
            _OTEL_SPAN.record_exception.called,
            "exception was not recorded on the active OTEL span",
        )

    def test_hung_sse_stream_end_to_end(self):
        """A coding turn whose SSE stream never completes returns an ERROR
        string within the deadline and surfaces agent.error + span error."""
        body = NeverDoneBody()
        fake_client = mock.MagicMock()
        fake_client.invoke_agent_runtime.return_value = {
            "contentType": "text/event-stream",
            "response": body,
        }
        events_client = mock.MagicMock()
        box = {}

        def run():
            with mock.patch.object(main.boto3, "client", return_value=fake_client), \
                 mock.patch.object(main, "_ddb_events_client", events_client), \
                 mock.patch.object(main, "REMOTE_CODING_TURN_DEADLINE_S", 0.5):
                box["out"] = main._remote_coding_turn("do the thing", "claude")

        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        worker.join(timeout=10)

        self.assertFalse(
            worker.is_alive(),
            "_remote_coding_turn is still blocked on a never-done stream — "
            "the nested InvokeAgentRuntime handoff has no deadline "
            "(TEAM-3168 silent hang)",
        )
        self.assertTrue(box["out"].startswith("ERROR: remote claude turn failed:"))
        self.assertIn("(deadline)", box["out"])
        self._assert_agent_error_published(events_client, "(deadline)")
        self._assert_span_marked_error("(deadline)")


if __name__ == "__main__":
    unittest.main()
