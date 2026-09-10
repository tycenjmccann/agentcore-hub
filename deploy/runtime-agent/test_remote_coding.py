#!/usr/bin/env python3
"""Unit tests for the remote coding-runtime handoff (TEAM-3119 / TEAM-3121) —
pure fixtures, no AWS.

Run: cd deploy/runtime-agent && python3 -m pytest test_remote_coding.py -v
(also runs under: python3 -m unittest test_remote_coding.py)

Covers the silent-hang class from the stuck-fleet postmortems on the
submit+poll transport:
  A. A nested coding turn that never reaches a verdict — the runner reports
     "running" on every poll, which pushes the inner deadline forward (clamped
     to the budget since TEAM-4359) — must be cut off by the overall wall-clock
     deadline (REMOTE_CODING_TURN_DEADLINE_S), return an ERROR string, and emit
     an agent.error event instead of blocking the persona.
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
            "adopted": False,
            "turns": 0,
            "fallback_note": None,
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
        # every poll answers "running" — which pushes the poll loop's inner
        # deadline forward on each iteration (clamped to the budget since
        # TEAM-4359). With the budget at 5s and the deadline at 0.5s, the
        # overall wall-clock deadline is the bound that must end this turn.
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


class TestTurnTimeoutForwarded(RemoteCodingTestCase):
    """TEAM-3687 — the resolved per-agent watchdog turnTimeoutSecs must ride the
    submit payload as `turn_timeout_secs` so the coding runtime bounds the CLI
    at the fleet-resolved value (before this it advertised a silently-inert
    per-agent knob). Asserted for the default AND an override."""

    def _submit_payload_for_turn(self):
        captured = []

        def submit(**kw):
            payload = json.loads(kw["payload"])
            captured.append(payload)
            return _invoke_response(
                {"submitted": True, "turn_id": payload["turn_id"]}
            )

        submit_client = mock.MagicMock()
        submit_client.invoke_agent_runtime.side_effect = submit
        poll_client = mock.MagicMock()
        poll_client.invoke_agent_runtime.side_effect = lambda **kw: _invoke_response(
            {"status": "done", "response": "ok", "claude_session_id": "s-1"}
        )
        events_client = mock.MagicMock()
        with mock.patch.object(main.boto3, "client", return_value=submit_client), \
             mock.patch.object(main, "_POLL_CLIENT", poll_client, create=True), \
             mock.patch.object(main, "_ddb_events_client", events_client), \
             mock.patch.object(main, "REMOTE_CODING_POLL_S", 0.01):
            main._remote_coding_turn("implement the widget", "claude")
        # poll rides _POLL_CLIENT, so submit_client only ever sees the submit.
        self.assertTrue(captured, "no submit payload was sent")
        return captured[-1]

    def test_default_turn_timeout_is_forwarded(self):
        payload = self._submit_payload_for_turn()
        self.assertEqual(payload["turn_timeout_secs"],
                         main._WATCHDOG["turnTimeoutSecs"])
        self.assertEqual(payload["turn_timeout_secs"], 1500,
                         "default resolves to the legacy fleet value")

    def test_override_turn_timeout_is_forwarded(self):
        with mock.patch.object(main, "_WATCHDOG",
                               {**main._WATCHDOG, "turnTimeoutSecs": 3600}):
            payload = self._submit_payload_for_turn()
        self.assertEqual(payload["turn_timeout_secs"], 3600,
                         "a per-agent override must be forwarded verbatim")


class TestPollBudgetScaling(RemoteCodingTestCase):
    """TEAM-3687 — a per-agent turnTimeoutSecs above the 1500s the fleet budget
    assumes must widen BOTH the poll budget and the outer deadline by the excess,
    so the persona doesn't declare the turn dead while the far side's CLI is
    still legitimately running. It's a DELTA off the fleet globals, so the
    default cap is byte-identical AND those globals stay authoritative (a
    hardcoded floor would clamp an operator-lowered override)."""

    def _capture_scaling(self):
        captured = {}

        def fake_submit_and_poll(client, payload, outer_deadline=None,
                                 budget_s=None):
            captured["budget_s"] = budget_s
            captured["outer_deadline"] = outer_deadline
            return {"status": "done", "response": "ok", "claude_session_id": "s-1"}

        events_client = mock.MagicMock()
        with mock.patch.object(main.boto3, "client", return_value=mock.MagicMock()), \
             mock.patch.object(main, "_submit_and_poll",
                               side_effect=fake_submit_and_poll), \
             mock.patch.object(main, "_ddb_events_client", events_client):
            t0 = time.monotonic()
            main._remote_coding_turn("implement the widget", "claude")
        captured["deadline_from_now"] = captured["outer_deadline"] - t0
        return captured

    def test_default_budget_and_deadline_are_byte_identical(self):
        cap = self._capture_scaling()
        # excess = 0 at the default cap → the fleet globals pass through verbatim.
        self.assertEqual(cap["budget_s"], main.REMOTE_CODING_TURN_BUDGET_S)
        self.assertEqual(cap["budget_s"], 2700,
                         "default turnTimeoutSecs must not shrink the fleet budget")
        self.assertAlmostEqual(cap["deadline_from_now"],
                               main.REMOTE_CODING_TURN_DEADLINE_S, delta=1.0)

    def test_override_widens_budget_and_deadline_by_the_excess(self):
        with mock.patch.object(main, "_WATCHDOG",
                               {**main._WATCHDOG, "turnTimeoutSecs": 3600}):
            cap = self._capture_scaling()
        excess = 3600 - main._WATCHDOG_LEGACY["turnTimeoutSecs"]  # 3600 - 1500
        # eff_budget = 2700 + 2100 = 4800 (== turnTimeoutSecs + 1200 headroom).
        self.assertEqual(cap["budget_s"], 4800)
        self.assertEqual(cap["budget_s"], main.REMOTE_CODING_TURN_BUDGET_S + excess)
        # eff_deadline = 6000 + 2*2100 = 10200.
        self.assertAlmostEqual(cap["deadline_from_now"],
                               main.REMOTE_CODING_TURN_DEADLINE_S + 2 * excess,
                               delta=1.0)
        # The deadline must clear the scaled budget (else the outer bound would
        # cut off a turn the budget still considers live).
        self.assertGreater(cap["deadline_from_now"],
                           main.REMOTE_CODING_TURN_DEADLINE_S)


class TestPolledTurnHeartbeat(RemoteCodingTestCase):
    """A long polled coding turn must emit prove-alive agent.streaming events so
    the UI never looks frozen and WM's silence timer resets on healthy turns."""

    def test_running_polls_emit_throttled_heartbeats(self):
        events_client = mock.MagicMock()
        # running, running, running, then done — with the interval at 0 every
        # running poll fires one heartbeat.
        statuses = [
            {"status": "running"},
            {"status": "running"},
            {"status": "running"},
            {"status": "done", "response": "ok", "claude_session_id": "s-9"},
        ]
        with mock.patch.object(main, "_poll_once", side_effect=statuses), \
             mock.patch.object(main, "_ddb_events_client", events_client), \
             mock.patch.object(main, "REMOTE_CODING_POLL_S", 0.001), \
             mock.patch.object(main, "REMOTE_CODING_HEARTBEAT_S", 0):
            out = main._poll_coding_turn(mock.MagicMock(), "turn-x", cli="kiro")

        self.assertEqual(out.get("status"), "done")
        beats = [
            c for c in events_client.put_item.call_args_list
            if c.kwargs.get("Item", {}).get("type", {}).get("S") == "agent.streaming"
            and "still working" in c.kwargs["Item"]["detail"]["M"]["content"]["S"]
        ]
        self.assertEqual(len(beats), 3, "one heartbeat per running poll expected")
        detail = beats[0].kwargs["Item"]["detail"]["M"]
        self.assertEqual(detail["agentId"]["S"], "frontend_dev")
        self.assertEqual(detail["workflowId"]["S"], "wf-test")
        self.assertEqual(detail["ticketId"]["S"], "TEAM-3119")
        self.assertIn("kiro", detail["content"]["S"])

    def test_heartbeat_is_throttled(self):
        events_client = mock.MagicMock()
        statuses = [
            {"status": "running"},
            {"status": "running"},
            {"status": "done", "response": "ok"},
        ]
        # A large interval means no running poll in this short turn crosses it.
        with mock.patch.object(main, "_poll_once", side_effect=statuses), \
             mock.patch.object(main, "_ddb_events_client", events_client), \
             mock.patch.object(main, "REMOTE_CODING_POLL_S", 0.001), \
             mock.patch.object(main, "REMOTE_CODING_HEARTBEAT_S", 9999):
            main._poll_coding_turn(mock.MagicMock(), "turn-x", cli="claude")

        beats = [
            c for c in events_client.put_item.call_args_list
            if c.kwargs.get("Item", {}).get("type", {}).get("S") == "agent.streaming"
            and "still working" in c.kwargs["Item"]["detail"]["M"]["content"]["S"]
        ]
        self.assertEqual(len(beats), 0, "throttle must suppress heartbeats within the interval")


if __name__ == "__main__":
    unittest.main()


class TestSetupFailureIsTerminal(RemoteCodingTestCase):
    """TEAM-3790/3799 — a workspace setup failure (clone 404 on a wrong repo
    owner) must surface as a terminal, actionable error: no lost-submit
    recovery, no VM-death resubmit, no 'retry this same call' advice."""

    def _submit_client(self, side_effect):
        client = mock.MagicMock()
        client.invoke_agent_runtime.side_effect = side_effect
        return client

    def test_setup_failed_body_is_terminal_and_actionable(self):
        client = self._submit_client(lambda **kw: _invoke_response({
            "error": "git clone failed: remote: Repository not found.",
            "setup_failed": True, "turn_id": kw and "turn-x", "cli": "codex",
        }))
        events_client = mock.MagicMock()
        main._CODING_SESSION["repo"] = "tycenj/agentcore-hub"
        with mock.patch.object(main.boto3, "client", return_value=client), \
             mock.patch.object(main, "_ddb_events_client", events_client), \
             mock.patch.object(main.time, "sleep"):
            out = main._remote_coding_turn("fix the bug", "codex", repo="tycenj/agentcore-hub")

        self.assertTrue(out.startswith("ERROR: remote codex turn could not START:"), out)
        self.assertIn("Repository not found", out)
        self.assertIn("NOT a runtime outage", out)
        self.assertIn("STOP and escalate", out)
        self.assertNotIn("Retry this same", out)
        # One submit, zero polls, zero resubmits.
        self.assertEqual(client.invoke_agent_runtime.call_count, 1)
        # The bad repo pin is released so a corrected repo= takes effect.
        self.assertIsNone(main._CODING_SESSION["repo"])
        self._assert_agent_error_published(events_client, "Repository not found")

    def test_http_500_from_runtime_is_a_rejection_not_a_lost_submit(self):
        # Legacy coding runtime: body dropped by AgentCore, only the status
        # survives. Still an ANSWER — must not probe/recover/resubmit. But a
        # legacy SYNCHRONOUS path 500s/504s AFTER the CLI ran, so this must not
        # assert "nothing started": verify-first, no repo pin clearing
        # (Codex #346 P2).
        from botocore.exceptions import ClientError
        err = ClientError(
            {"Error": {"Code": "RuntimeClientError",
                       "Message": "Received error (500) from runtime. Please check "
                                  "your CloudWatch logs for more information."}},
            "InvokeAgentRuntime")
        client = self._submit_client(err)
        events_client = mock.MagicMock()
        main._CODING_SESSION["repo"] = "owner/repo"
        with mock.patch.object(main.boto3, "client", return_value=client), \
             mock.patch.object(main, "_ddb_events_client", events_client), \
             mock.patch.object(main.time, "sleep"):
            out = main._remote_coding_turn("fix the bug", "claude")

        self.assertIn("HTTP 500", out)
        self.assertIn("Do NOT re-run", out)
        self.assertNotIn("could not START", out, "cannot claim setup-only failure")
        self.assertNotIn("Retry this same", out)
        self.assertNotIn("vanished", out)
        self.assertEqual(main._CODING_SESSION["repo"], "owner/repo",
                         "an ambiguous legacy failure must not silently drop the pin")
        self.assertEqual(client.invoke_agent_runtime.call_count, 1,
                         "recovery probes / resubmits must not run on a rejection")
        self._assert_agent_error_published(events_client, "HTTP 500")

    def test_setup_failed_clears_ported_clone_overrides(self):
        # Codex #346 P2 — the coding runtime prefers clone_url over repo, so a
        # ported session with a bad saved origin/branch would fail identically
        # on every corrected call unless those are released too.
        client = self._submit_client(lambda **kw: _invoke_response({
            "error": "git clone failed: Repository not found.", "setup_failed": True}))
        main._CODING_SESSION.update({
            "repo": "tycenj/agentcore-hub",
            "clone_url": "https://github.com/tycenj/agentcore-hub.git",
            "branch": "feat/gone",
            "resume_transcript": "s3://key", "resume_session_id": "sess-1",
        })
        with mock.patch.object(main.boto3, "client", return_value=client), \
             mock.patch.object(main, "_ddb_events_client", mock.MagicMock()), \
             mock.patch.object(main.time, "sleep"):
            main._remote_coding_turn("fix the bug", "claude")

        for field in ("repo", "clone_url", "branch"):
            self.assertIsNone(main._CODING_SESSION[field], f"{field} must be released")
        # The conversation itself is still resumable once the target is right.
        self.assertEqual(main._CODING_SESSION["resume_transcript"], "s3://key")
        self.assertEqual(main._CODING_SESSION["resume_session_id"], "sess-1")

    def test_http_400_stays_actionable_setup_failure(self):
        # Codex #348 P2 — 4xx on the coding runtime is only ever pre-CLI (bad
        # body / non-clonable repo field), so it must keep the actionable
        # treatment or the session stays pinned to the bad repo.
        from botocore.exceptions import ClientError
        err = ClientError(
            {"Error": {"Code": "RuntimeClientError",
                       "Message": "Received error (400) from runtime."}},
            "InvokeAgentRuntime")
        client = self._submit_client(err)
        main._CODING_SESSION["repo"] = "tycenjmccann"
        with mock.patch.object(main.boto3, "client", return_value=client), \
             mock.patch.object(main, "_ddb_events_client", mock.MagicMock()), \
             mock.patch.object(main.time, "sleep"):
            out = main._remote_coding_turn("fix the bug", "claude")

        self.assertTrue(out.startswith("ERROR: remote claude turn could not START:"), out)
        self.assertIn("HTTP 400", out)
        self.assertIsNone(main._CODING_SESSION["repo"],
                          "a definitively pre-CLI rejection must release the pin")

    def test_http_503_keeps_retry_advice(self):
        from botocore.exceptions import ClientError
        err = ClientError(
            {"Error": {"Code": "RuntimeClientError",
                       "Message": "Received error (503) from runtime."}},
            "InvokeAgentRuntime")
        client = self._submit_client(err)
        with mock.patch.object(main.boto3, "client", return_value=client), \
             mock.patch.object(main, "_ddb_events_client", mock.MagicMock()), \
             mock.patch.object(main.time, "sleep"):
            out = main._remote_coding_turn("fix the bug", "claude")

        self.assertTrue(out.startswith("ERROR: remote claude turn failed:"), out)
        self.assertIn("Retry this same claude call", out)
        self.assertEqual(client.invoke_agent_runtime.call_count, 1)

    def test_connection_drop_still_takes_recovery_path(self):
        # Regression guard: only HTTP rejections short-circuit. A dropped
        # connection says nothing about the runner and must still recover.
        client = self._submit_client(RuntimeError("Connection was closed before we received a valid response"))
        with mock.patch.object(main.boto3, "client", return_value=client), \
             mock.patch.object(main, "_ddb_events_client", mock.MagicMock()), \
             mock.patch.object(main, "_recover_lost_submit", return_value=None) as rec, \
             mock.patch.object(main.time, "sleep"):
            out = main._remote_coding_turn("fix the bug", "claude")
        rec.assert_called_once()
        self.assertIn("could not be safely recovered", out)

    def test_done_record_with_setup_failed_from_poll_is_terminal(self):
        # Response lost, then the poll returns the journaled setup failure.
        calls = {"n": 0}

        def side_effect(**kw):
            body = json.loads(kw["payload"].decode("utf-8"))
            if body.get("action") == "poll":
                return _invoke_response({"status": "done", "turn_id": body["turn_id"],
                                         "error": "git clone failed: Repository not found.",
                                         "setup_failed": True, "response": ""})
            calls["n"] += 1
            raise RuntimeError("Connection was closed before we received a valid response")

        client = self._submit_client(side_effect)
        with mock.patch.object(main.boto3, "client", return_value=client), \
             mock.patch.object(main, "_ddb_events_client", mock.MagicMock()), \
             mock.patch.object(main.time, "sleep"):
            out = main._remote_coding_turn("fix the bug", "codex")
        self.assertTrue(out.startswith("ERROR: remote codex turn could not START:"), out)
        self.assertEqual(calls["n"], 1, "no resubmit after a journaled setup failure")


class TestSessionBusyFallback(RemoteCodingTestCase):
    """DL-025 — the coding runtime refuses a second CLI on a session whose
    runner is live (session_busy). An ADOPTED session (resume_session from
    another agent-task) that is busy on our first turn is a sibling's: mint our
    own session and go again. Our OWN busy session is a wait-and-retry error."""

    def _client(self, responses):
        client = mock.MagicMock()
        seen = []

        def side_effect(**kw):
            seen.append((kw["runtimeSessionId"], json.loads(kw["payload"])))
            return _invoke_response(responses[len(seen) - 1])
        client.invoke_agent_runtime.side_effect = side_effect
        return client, seen

    def _adopt(self, session_id, conversation="conv-sibling"):
        row = {"Item": {"sessionId": {"S": session_id}, "cli": {"S": "claude"},
                        "claudeSessionId": {"S": conversation}}}
        ddb = mock.MagicMock()
        ddb.get_item.return_value = row
        with mock.patch.object(main.boto3, "client", return_value=ddb):
            main._maybe_resume_session(session_id)
        self.assertTrue(main._CODING_SESSION["adopted"])

    def test_adopted_busy_session_falls_back_to_fresh_session(self):
        self._adopt("cc-sibling-session")
        client, seen = self._client([
            {"error": "session is already running turn turn-other", "session_busy": True,
             "busy_turn_id": "turn-other", "turn_id": "turn-1", "cli": "claude"},
            {"submitted": True, "turn_id": "turn-2"},
        ])
        poll_client = mock.MagicMock()
        poll_client.invoke_agent_runtime.side_effect = lambda **kw: _invoke_response(
            {"status": "done", "response": "fixed it", "claude_session_id": "conv-new"})
        events_client = mock.MagicMock()
        with mock.patch.object(main.boto3, "client", return_value=client), \
             mock.patch.object(main, "_POLL_CLIENT", poll_client, create=True), \
             mock.patch.object(main, "_ddb_events_client", events_client), \
             mock.patch.object(main, "REMOTE_CODING_POLL_S", 0.01), \
             mock.patch.object(main, "_record_coding_session"):
            out = main._remote_coding_turn("fix the bug", "claude")

        self.assertEqual(len(seen), 2, "one refused submit, one fresh submit")
        busy_sid, busy_payload = seen[0]
        fresh_sid, fresh_payload = seen[1]
        self.assertEqual(busy_sid, "cc-sibling-session")
        self.assertEqual(busy_payload["claude_session_id"], "conv-sibling")
        self.assertNotEqual(fresh_sid, "cc-sibling-session")
        self.assertTrue(fresh_sid.startswith("cc-"))
        self.assertEqual(fresh_payload["session_id"], fresh_sid)
        self.assertNotIn("claude_session_id", fresh_payload, "sibling's conversation is not ours")
        self.assertEqual(main._CODING_SESSION["session_id"], fresh_sid)
        self.assertFalse(main._CODING_SESSION["adopted"])
        self.assertEqual(main._CODING_SESSION["turns"], 1)
        self.assertIn("fixed it", out)
        self.assertIn(f"[coding-session: {fresh_sid}", out)
        self.assertIn("mid-turn for another ticket", out)
        self.assertNotIn("ERROR", out)
        agent_errors = [c for c in events_client.put_item.call_args_list
                        if c.kwargs.get("Item", {}).get("type", {}).get("S") == "agent.error"]
        self.assertEqual(agent_errors, [], "fallback is not a failure")

    def test_own_busy_session_is_a_wait_and_retry_error(self):
        # Not adopted: this task minted the session; a busy answer means our own
        # earlier turn is still running (poll gave up) — never fork a new session.
        main._CODING_SESSION["session_id"] = "cc-mine"
        main._CODING_SESSION["turns"] = 1
        client, seen = self._client([
            {"error": "session is already running turn turn-prev", "session_busy": True,
             "busy_turn_id": "turn-prev", "cli": "claude"},
        ])
        events_client = mock.MagicMock()
        with mock.patch.object(main.boto3, "client", return_value=client), \
             mock.patch.object(main, "_ddb_events_client", events_client):
            out = main._remote_coding_turn("continue", "claude")
        self.assertEqual(len(seen), 1)
        self.assertEqual(main._CODING_SESSION["session_id"], "cc-mine")
        self.assertTrue(out.startswith("ERROR: remote claude turn"), out)
        self.assertIn("still running", out)
        self.assertIn("wait", out.lower())
        self.assertNotIn("Retry this same claude call — the session workspace is preserved", out)

    def test_adopted_session_after_first_turn_is_ours(self):
        # Adopted but we already ran a turn in it → it is ours now; a busy answer
        # is our own turn, not a sibling's — no fallback.
        self._adopt("cc-reopened", conversation="conv-mine")
        main._CODING_SESSION["turns"] = 2
        client, seen = self._client([
            {"error": "busy", "session_busy": True, "busy_turn_id": "turn-x", "cli": "codex"},
        ])
        with mock.patch.object(main.boto3, "client", return_value=client), \
             mock.patch.object(main, "_ddb_events_client", mock.MagicMock()):
            out = main._remote_coding_turn("continue", "codex")
        self.assertEqual(len(seen), 1)
        self.assertEqual(main._CODING_SESSION["session_id"], "cc-reopened")
        self.assertTrue(out.startswith("ERROR"), out)

    def test_session_row_carries_ticket_id(self):
        # The orchestrator matches a session to its ticket by this column.
        main._CODING_SESSION["session_id"] = "cc-row"
        ddb = mock.MagicMock()
        with mock.patch.object(main.boto3, "client", return_value=ddb):
            main._record_coding_session("claude")
        item = ddb.put_item.call_args.kwargs["Item"]
        self.assertEqual(item["ticketId"]["S"], "TEAM-3119")
        self.assertEqual(item["agentId"]["S"], "frontend_dev")
        self.assertEqual(item["title"]["S"], "[wf] TEAM-3119 frontend_dev")


class _FakeClock:
    """Stand-in for the `time` module inside main: sleep() ADVANCES the clock, so
    a multi-thousand-second poll loop runs in milliseconds of real time. Only the
    poll loop's own time calls are affected (_publish_coding_heartbeat does its
    own `import time`), so heartbeat behaviour is unchanged."""

    def __init__(self, start=1_000_000.0):
        self._t = start
        self._mono = 0.0
        self.slept = 0.0
        self.sleeps = 0

    def time(self):
        return self._t

    def monotonic(self):
        return self._mono

    def sleep(self, seconds):
        self._t += seconds
        self._mono += seconds
        self.slept += seconds
        self.sleeps += 1


class TestPollBudgetIsTheHardStop(RemoteCodingTestCase):
    """TEAM-4359 — the budget IS the give-up point for _poll_coding_turn.

    A wedged kiro turn heartbeated "running" for 2h20m and the poller waited
    exactly 9600s on a 4800s budget: hard_stop was turn_start + 2*budget, and
    because every "running" poll re-extended `deadline`, nothing else ever fired.
    These tests pin the bound at 1x budget and keep the other exits terminal.

    Driven through _poll_coding_turn directly, on a fake clock, so the assertions
    are about elapsed BUDGET rather than real seconds.
    """

    def _poll(self, statuses, budget=4800, poll_s=20, outer_deadline_s=None):
        """Run the poll loop against a status callable/list on a fake clock.
        Returns (result, clock, poll_count)."""
        clock = _FakeClock()
        calls = {"n": 0}

        def _next(_client, _turn_id):
            calls["n"] += 1
            if callable(statuses):
                return statuses(calls["n"])
            idx = min(calls["n"] - 1, len(statuses) - 1)
            return statuses[idx]

        outer = None if outer_deadline_s is None else clock.monotonic() + outer_deadline_s
        with mock.patch.object(main, "time", clock), \
             mock.patch.object(main, "_poll_once", side_effect=_next), \
             mock.patch.object(main, "REMOTE_CODING_POLL_S", poll_s), \
             mock.patch.object(main, "_publish_coding_heartbeat"):
            result = main._poll_coding_turn(mock.MagicMock(), "turn-x",
                                            outer_deadline=outer, budget_s=budget,
                                            cli="kiro")
        return result, clock, calls["n"]

    def test_perpetual_running_gives_up_at_budget_not_double(self):
        budget = 4800  # the incident's effective budget (2700 + (3600-1500))
        result, clock, polls = self._poll([{"status": "running", "heartbeat_age_s": 1}],
                                          budget=budget)
        self.assertIn("error", result)
        self.assertGreater(polls, 1, "the loop must actually have polled")
        # One poll interval of overshoot is inherent (the sleep precedes the
        # check); 2x budget is the regression.
        self.assertLessEqual(
            clock.slept, budget + main.REMOTE_CODING_POLL_S + 1,
            f"gave up after {clock.slept}s on a {budget}s budget "
            f"({clock.slept / budget:.2f}x) — the 2x hard stop is back")
        self.assertGreaterEqual(clock.slept, budget - main.REMOTE_CODING_POLL_S,
                                "gave up EARLY — a live runner must get its full budget")

    def test_running_extension_never_pushes_past_the_budget(self):
        # A budget SHORTER than one extension quantum (120s) is where an
        # unclamped `deadline = max(deadline, now + 120)` shows up most starkly:
        # pre-fix a single running poll already carried the loop past the budget.
        budget = 60
        _, clock, _ = self._poll([{"status": "running"}], budget=budget, poll_s=1)
        self.assertLessEqual(clock.slept, budget + 1,
                             f"the per-poll extension outlived the {budget}s budget "
                             f"({clock.slept}s)")

    def test_budget_error_keeps_the_verify_first_text_and_no_retry_hint(self):
        result, clock, _ = self._poll([{"status": "running"}], budget=120, poll_s=20)
        self.assertIn("exceeded", result["error"])
        self.assertIn("120s budget", result["error"])
        # Verify-first guidance (TEAM-3307) must survive this change: a blind
        # re-run would race a runner that may still be finishing.
        self.assertIn("Do NOT re-run", result["error"])
        self.assertIn("check the branch on GitHub", result["error"])
        self.assertIs(result.get("no_retry_hint"), True)
        self.assertNotIn("retryable_vm_death", result)
        # The elapsed figure helps read the incident from a log line alone.
        self.assertIn(f"{int(clock.slept)}s", result["error"])

    def test_done_status_returns_immediately(self):
        done = {"status": "done", "response": "shipped", "claude_session_id": "s-1"}
        result, clock, polls = self._poll([done], budget=4800)
        self.assertEqual(result, done)
        self.assertEqual(polls, 1)
        self.assertLessEqual(clock.slept, main.REMOTE_CODING_POLL_S,
                             "a done turn must not consume any budget")

    def test_dead_status_is_retryable_vm_death(self):
        result, clock, polls = self._poll(
            [{"status": "dead", "stale_s": 300}], budget=4800)
        self.assertIs(result.get("retryable_vm_death"), True)
        self.assertIn("died mid-run", result["error"])
        self.assertIn("300s", result["error"])
        self.assertEqual(polls, 1, "death must be reported on the first stale read")
        self.assertLess(clock.slept, 4800)

    def test_three_consecutive_unknowns_are_retryable_vm_death(self):
        result, _, polls = self._poll([{"status": "unknown"}], budget=4800)
        self.assertIs(result.get("retryable_vm_death"), True)
        self.assertIn("vanished", result["error"])
        self.assertEqual(polls, 3, "must demand 3 consecutive confirmations")

    def test_single_unknown_between_runnings_is_not_death(self):
        # The counter resets on any non-unknown status, so a lone flaky read must
        # not be mistaken for a vanished turn.
        def _statuses(n):
            if n == 2:
                return {"status": "unknown"}
            if n >= 5:
                return {"status": "done", "response": "ok"}
            return {"status": "running"}

        result, _, polls = self._poll(_statuses, budget=4800)
        self.assertEqual(result.get("response"), "ok")
        self.assertNotIn("retryable_vm_death", result)
        self.assertEqual(polls, 5)

    def test_poll_exception_is_non_terminal_and_a_later_done_wins(self):
        # A throttle/network blip says nothing about the runner; bailing here
        # would make the persona resubmit into a live workspace.
        def _statuses(n):
            if n <= 3:
                raise RuntimeError("ThrottlingException")
            return {"status": "done", "response": "landed", "claude_session_id": "s-2"}

        result, _, polls = self._poll(_statuses, budget=4800)
        self.assertEqual(result.get("response"), "landed")
        self.assertEqual(polls, 4)

    def test_outer_deadline_still_preempts_the_budget(self):
        # The overall bound (TEAM-3119/3307) is unchanged and still wins when it
        # is tighter than the budget — and no final probe is issued past it.
        result, clock, _ = self._poll([{"status": "running"}], budget=4800,
                                      poll_s=20, outer_deadline_s=100)
        self.assertIs(result.get("deadline_exceeded"), True)
        self.assertIn("overall deadline", result["error"])
        self.assertLessEqual(clock.slept, 120)
