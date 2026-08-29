#!/usr/bin/env python3
"""Unit tests for the remote coding-runtime handoff (TEAM-3119 / TEAM-3121) —
pure fixtures, no AWS.

Run: cd deploy/runtime-agent && python3 -m pytest test_remote_coding.py -v
(also runs under: python3 -m unittest test_remote_coding.py)

Covers the silent-hang class from the stuck-fleet postmortems on the
submit+poll transport:
  A. A nested coding turn that never reaches a verdict — the runner reports
     "running" on every poll, which EXTENDS the inner budget each time — must
     be cut off by the overall wall-clock deadline
     (REMOTE_CODING_TURN_DEADLINE_S), return an ERROR string, and emit an
     agent.error event instead of blocking the persona.
  B. Both failure exits of _remote_coding_turn (exception escaping the
     submit+poll, and an {error} result) must publish an agent.error event
     (same events table the dashboard/Workflow Manager read) while still
     returning the ERROR string to the LLM.
  C. A healthy turn finishing under the deadline is untouched — no agent.error,
     response text + session footer intact.
  D. (TEAM-3307 F1) The deadline is a HARD bound: no blocking
     InvokeAgentRuntime call (final poll probe, vm-death resubmit) may be
     STARTED once it has expired — worst-case overshoot is the one call
     already in flight, never deadline + another connect/read window.
  E. (TEAM-3307 F2) agent.error publishing retries transient put_item
     failures (bounded, short backoff) and, when exhausted, logs
     workflow_id + ticket_id without raising.

main.py needs strands / bedrock_agentcore / httpx at import time; those are
stubbed below so this suite runs hermetically (boto3 is real but never called
against AWS — clients are mocks).
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


class FakeJsonBody:
    """Fake buffered JSON response body (fresh per invocation)."""

    def __init__(self, obj):
        self._data = json.dumps(obj).encode("utf-8")

    def read(self):
        return self._data


def _invoke_response(obj):
    return {"contentType": "application/json", "response": FakeJsonBody(obj)}


class RemoteCodingTestCase(unittest.TestCase):
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
        agent_error_calls = [
            c for c in events_client.put_item.call_args_list
            if c.kwargs.get("Item", {}).get("type", {}).get("S") == "agent.error"
        ]
        self.assertTrue(
            agent_error_calls,
            "no agent.error event was published for a failed coding turn "
            "(TEAM-3119: failures must be loud, not just an ERROR string "
            "the dashboard never sees)",
        )
        item = agent_error_calls[-1].kwargs["Item"]
        detail = item["detail"]["M"]
        self.assertEqual(detail["agentId"]["S"], "frontend_dev")
        self.assertEqual(detail["workflowId"]["S"], "wf-test")
        self.assertEqual(detail["ticketId"]["S"], "TEAM-3119")
        self.assertIn(expected_fragment, detail["error"]["S"])


class TestOverallTurnDeadline(RemoteCodingTestCase):
    """Test A — the core TEAM-3119 regression on the submit+poll transport."""

    def test_never_completing_turn_hits_deadline_and_emits_agent_error(self):
        # Pathological live-forever runner: submit is accepted instantly, then
        # every poll answers "running" — which extends the poll loop's inner
        # budget on each iteration. Only the overall wall-clock deadline can
        # end this turn.
        submit_client = mock.MagicMock()
        submit_client.invoke_agent_runtime.side_effect = lambda **kw: _invoke_response(
            {"submitted": True, "turn_id": json.loads(kw["payload"])["turn_id"]}
        )
        poll_client = mock.MagicMock()
        poll_client.invoke_agent_runtime.side_effect = lambda **kw: _invoke_response(
            {"status": "running"}
        )
        events_client = mock.MagicMock()

        box = {}

        def run():
            box["result"] = main._remote_coding_turn("implement the widget", "claude")

        with mock.patch.object(main.boto3, "client", return_value=submit_client), \
             mock.patch.object(main, "_POLL_CLIENT", poll_client, create=True), \
             mock.patch.object(main, "_ddb_events_client", events_client), \
             mock.patch.object(main, "REMOTE_CODING_POLL_S", 0.01), \
             mock.patch.object(main, "REMOTE_CODING_TURN_BUDGET_S", 5), \
             mock.patch.object(main, "REMOTE_CODING_TURN_DEADLINE_S", 0.5, create=True):
            worker = threading.Thread(target=run, daemon=True)
            worker.start()
            worker.join(timeout=3.0)
            still_blocked = worker.is_alive()
            if still_blocked:
                # Pre-fix code blocks until the inner budget's hard stop —
                # drain the leaked worker before the patches lift so it can't
                # touch real clients, then fail the assertions below.
                worker.join(timeout=15.0)

        self.assertFalse(
            still_blocked,
            "a never-completing nested coding turn blocked the persona past "
            "the 0.5s overall deadline (checked at 3.0s) — TEAM-3119 silent hang",
        )
        result = box["result"]
        self.assertTrue(result.startswith("ERROR: remote claude turn"),
                        f"expected a loud ERROR return, got: {result[:120]!r}")
        self.assertIn("deadline", result)
        self._assert_agent_error_published(events_client, "deadline")


class TestFailureExitsSurfaceAgentError(RemoteCodingTestCase):
    """Test B — both failure exits emit agent.error and keep the ERROR string."""

    def test_invoke_exception_publishes_agent_error(self):
        events_client = mock.MagicMock()
        with mock.patch.object(main.boto3, "client", return_value=mock.MagicMock()), \
             mock.patch.object(main, "_ddb_events_client", events_client), \
             mock.patch.object(main, "_submit_and_poll",
                               side_effect=RuntimeError("connection reset by peer")):
            out = main._remote_coding_turn("do the thing", "codex")

        self.assertTrue(out.startswith("ERROR: remote codex turn failed:"))
        self.assertIn("connection reset by peer", out)
        self._assert_agent_error_published(events_client, "connection reset by peer")

    def test_error_result_publishes_agent_error(self):
        # Synchronous setup failure (bad repo / clone) — submit itself answers
        # with {error}; no polling happens.
        submit_client = mock.MagicMock()
        submit_client.invoke_agent_runtime.side_effect = lambda **kw: _invoke_response(
            {"error": "workspace-fatal: clone failed"}
        )
        events_client = mock.MagicMock()
        with mock.patch.object(main.boto3, "client", return_value=submit_client), \
             mock.patch.object(main, "_ddb_events_client", events_client):
            out = main._remote_coding_turn("do the thing", "claude")

        self.assertTrue(out.startswith("ERROR: remote claude turn failed:"))
        self.assertIn("workspace-fatal: clone failed", out)
        self._assert_agent_error_published(events_client, "workspace-fatal: clone failed")


class TestHealthyTurnUnaffected(RemoteCodingTestCase):
    """Test C — the deadline must not preempt or noise up a healthy turn."""

    def test_done_turn_returns_response_without_agent_error(self):
        submit_client = mock.MagicMock()
        submit_client.invoke_agent_runtime.side_effect = lambda **kw: _invoke_response(
            {"submitted": True, "turn_id": json.loads(kw["payload"])["turn_id"]}
        )
        poll_client = mock.MagicMock()
        poll_client.invoke_agent_runtime.side_effect = lambda **kw: _invoke_response(
            {"status": "done", "response": "all done", "claude_session_id": "s-1"}
        )
        events_client = mock.MagicMock()
        with mock.patch.object(main.boto3, "client", return_value=submit_client), \
             mock.patch.object(main, "_POLL_CLIENT", poll_client, create=True), \
             mock.patch.object(main, "_ddb_events_client", events_client), \
             mock.patch.object(main, "REMOTE_CODING_POLL_S", 0.01):
            out = main._remote_coding_turn("implement the widget", "claude")

        self.assertIn("all done", out)
        self.assertIn("[coding-session:", out)
        self.assertNotIn("ERROR", out)
        agent_error_calls = [
            c for c in events_client.put_item.call_args_list
            if c.kwargs.get("Item", {}).get("type", {}).get("S") == "agent.error"
        ]
        self.assertEqual(agent_error_calls, [],
                         "healthy turn must not publish agent.error")
        self.assertEqual(main._CODING_SESSION["conversation_ids"].get("claude"), "s-1")


class TestDeadlineIsHardBound(RemoteCodingTestCase):
    """Test D (TEAM-3307 F1) — the overall deadline must bound EVERY blocking
    call, not just the poll-loop condition. Pre-fix, a blocking call could be
    STARTED after (or across) the deadline and pin the persona for a full
    connect+read window (~630s in prod) past REMOTE_CODING_TURN_DEADLINE_S."""

    def test_blocking_polls_do_not_overshoot_deadline_by_more_than_one_call(self):
        # Every poll BLOCKS for 2s before answering "running" (a slow/hung
        # poll transport). Deadline is 0.5s. A poll already in flight when the
        # deadline expires cannot be interrupted — that one call is the
        # permissible overshoot. Pre-fix, the loop exit was followed by one
        # MORE unconditional blocking probe, doubling the overshoot.
        # Invariant: wall time <= deadline + ~one blocking call, and the
        # failure is still loud (ERROR string + agent.error event).
        poll_block_s = 2.0
        submit_client = mock.MagicMock()
        submit_client.invoke_agent_runtime.side_effect = lambda **kw: _invoke_response(
            {"submitted": True, "turn_id": json.loads(kw["payload"])["turn_id"]}
        )

        def blocking_running_poll(**kw):
            time.sleep(poll_block_s)
            return _invoke_response({"status": "running"})

        poll_client = mock.MagicMock()
        poll_client.invoke_agent_runtime.side_effect = blocking_running_poll
        events_client = mock.MagicMock()

        with mock.patch.object(main.boto3, "client", return_value=submit_client), \
             mock.patch.object(main, "_POLL_CLIENT", poll_client, create=True), \
             mock.patch.object(main, "_ddb_events_client", events_client), \
             mock.patch.object(main, "REMOTE_CODING_POLL_S", 0.01), \
             mock.patch.object(main, "REMOTE_CODING_TURN_BUDGET_S", 5), \
             mock.patch.object(main, "REMOTE_CODING_TURN_DEADLINE_S", 0.5, create=True):
            t0 = time.monotonic()
            result = main._remote_coding_turn("implement the widget", "claude")
            elapsed = time.monotonic() - t0

        self.assertLess(
            elapsed, 0.5 + poll_block_s + 0.5,
            f"turn took {elapsed:.2f}s — a blocking call was started after the "
            f"0.5s deadline expired (TEAM-3307 F1 overshoot)",
        )
        self.assertTrue(result.startswith("ERROR: remote claude turn"),
                        f"expected a loud ERROR return, got: {result[:120]!r}")
        self.assertIn("deadline", result)
        self._assert_agent_error_published(events_client, "deadline")

    def test_submit_is_not_started_once_deadline_expired(self):
        # The vm-death resubmit race: by the time _submit_and_poll runs again,
        # the deadline has expired. The submit invoke here would block for the
        # full read timeout (mocked as 5s; ~630s in prod) — it must not be
        # STARTED at all, and the caller must get the deadline-expired error.
        def blocking_submit(**kw):
            time.sleep(5.0)
            return _invoke_response(
                {"submitted": True, "turn_id": json.loads(kw["payload"])["turn_id"]}
            )

        submit_client = mock.MagicMock()
        submit_client.invoke_agent_runtime.side_effect = blocking_submit
        poll_client = mock.MagicMock()
        poll_client.invoke_agent_runtime.side_effect = lambda **kw: _invoke_response(
            {"status": "running"}
        )
        main._CODING_SESSION["session_id"] = "cc-test-deadline-expired-session"

        expired_deadline = time.monotonic() - 0.001
        with mock.patch.object(main, "_POLL_CLIENT", poll_client, create=True), \
             mock.patch.object(main, "REMOTE_CODING_POLL_S", 0.01):
            t0 = time.monotonic()
            result = main._submit_and_poll(
                submit_client, {"prompt": "x", "cli": "claude"}, expired_deadline)
            elapsed = time.monotonic() - t0

        self.assertLess(
            elapsed, 2.0,
            f"_submit_and_poll took {elapsed:.2f}s with an already-expired "
            f"deadline — the blocking submit was started past it (TEAM-3307 F1)",
        )
        self.assertIn("deadline", result.get("error", ""))
        self.assertTrue(result.get("deadline_exceeded"))
        self.assertEqual(
            submit_client.invoke_agent_runtime.call_count, 0,
            "a blocking InvokeAgentRuntime call was started after the overall "
            "deadline had already expired",
        )


class TestAgentErrorPublishRetry(RemoteCodingTestCase):
    """Test E (TEAM-3307 F2) — agent.error publishing retries transient
    put_item failures, and an exhausted retry logs enough (workflow + ticket)
    to find the lost event — without ever raising."""

    def test_transient_put_item_failures_are_retried_until_published(self):
        events_client = mock.MagicMock()
        events_client.put_item.side_effect = [
            RuntimeError("ThrottlingException"),
            RuntimeError("ThrottlingException"),
            {},  # third attempt succeeds
        ]
        with mock.patch.object(main, "_ddb_events_client", events_client), \
             mock.patch.object(main, "_AGENT_ERROR_PUBLISH_BACKOFF_S", (0, 0),
                               create=True):
            main._publish_agent_error("wf-test", "frontend_dev", "boom",
                                      ticket_id="TEAM-3119")

        self.assertEqual(
            events_client.put_item.call_count, 3,
            "transient put_item failures must be retried — a single-shot "
            "publish silently loses the only record of the failure",
        )
        item = events_client.put_item.call_args_list[-1].kwargs["Item"]
        self.assertEqual(item["type"]["S"], "agent.error")
        self.assertEqual(item["detail"]["M"]["ticketId"]["S"], "TEAM-3119")

    def test_exhausted_retries_never_raise_and_log_workflow_and_ticket(self):
        events_client = mock.MagicMock()
        events_client.put_item.side_effect = RuntimeError("table unavailable")
        with mock.patch.object(main, "_ddb_events_client", events_client), \
             mock.patch.object(main, "_AGENT_ERROR_PUBLISH_BACKOFF_S", (0, 0),
                               create=True), \
             self.assertLogs(main.logger, level="WARNING") as logs:
            # Must never raise, even with every attempt failing.
            main._publish_agent_error("wf-test", "frontend_dev", "boom",
                                      ticket_id="TEAM-3119")

        failure_lines = [line for line in logs.output
                         if "Failed to publish agent.error" in line]
        self.assertTrue(failure_lines,
                        "exhausted publish retries must log a failure line")
        self.assertTrue(
            any("wf-test" in line and "TEAM-3119" in line
                for line in failure_lines),
            f"the give-up log line must carry workflow_id and ticket_id so the "
            f"lost event is discoverable; got: {failure_lines}",
        )


if __name__ == "__main__":
    unittest.main()
