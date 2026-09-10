#!/usr/bin/env python3
"""Unit tests for the remote coding-runtime handoff (TEAM-3119 / TEAM-3121) —
pure fixtures, no AWS.

Run: cd deploy/runtime-agent && python3 -m pytest test_remote_coding.py -v
(also runs under: python3 -m unittest test_remote_coding.py)

Covers the silent-hang class from the stuck-fleet postmortems, now on the
submit + command-API-wait transport (DL-026): the coding runtime acks a turn and
the fleet learns the outcome by running a short shell probe inside that same
container, which reports one of done / missing / starting / running /
exited_no_done.
  A. A nested coding turn that never reaches a verdict — every probe answers
     "running" — must be cut off, return an ERROR string, and emit an agent.error
     event instead of blocking the persona.
  B. Both failure exits of _remote_coding_turn (exception escaping the
     submit+wait, and an {error} result) must publish an agent.error event
     (same events table the dashboard/Workflow Manager read) while still
     returning the ERROR string to the LLM.
  C. A healthy turn finishing under the deadline is untouched — no agent.error,
     response text + session footer intact.
  D. (TEAM-3307 F1) The deadline is a HARD bound: no blocking call (recovery
     probe, vm-death resubmit) may be STARTED once it has expired — worst-case
     overshoot is the one call already in flight.
  E. (TEAM-3307 F2) agent.error publishing retries transient put_item
     failures (bounded, short backoff) and, when exhausted, logs
     workflow_id + ticket_id without raising.
  F. Every probe verdict maps to exactly one outcome, a CLI alive past its cap is
     KILLED from outside, and no loop can outlive its bound.

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


def _probe_stream(lines, exit_code=0, status="COMPLETED"):
    """One InvokeAgentRuntimeCommand response: stdout split across chunks the way
    the platform actually delivers it (arbitrary boundaries, so the parser must
    concatenate before splitting lines), then a contentStop."""
    text = "".join(f"{line}\n" for line in lines)
    mid = len(text) // 2
    return {"stream": [
        {"chunk": {"contentDelta": {"stdout": text[:mid]}}},
        {"chunk": {"contentDelta": {"stdout": text[mid:]}}},
        {"chunk": {"contentStop": {"exitCode": exit_code, "status": status}}},
    ]}


def _done_lines(record):
    """The lines the wait script prints for a finished turn."""
    import base64 as _b64, hashlib as _hl
    raw = json.dumps(record).encode()
    return [f"DONE_BYTES={len(raw)}",
            f"DONE_SHA256={_hl.sha256(raw).hexdigest()}",
            f"DONE_B64={_b64.b64encode(raw).decode()}",
            "VERDICT=done"]


def _verdict_lines(verdict, **fields):
    lines = [f"{k.upper()}={v}" for k, v in fields.items()]
    return lines + [f"VERDICT={verdict}"]


class FakeCommandClient:
    """Scripted stand-in for the bedrock-agentcore command client.

    `script` is a list of responses (or exceptions to raise) consumed in order;
    the last entry repeats forever, so a test can say "running, then done" or
    "running for ever" without counting slices."""

    def __init__(self, script):
        self.script = list(script)
        self.calls: list = []
        self.stopped: list = []

    def invoke_agent_runtime_command(self, **kwargs):
        self.calls.append(kwargs)
        item = self.script[min(len(self.calls) - 1, len(self.script) - 1)]
        if isinstance(item, BaseException):
            raise item
        return item

    def stop_runtime_session(self, **kwargs):
        self.stopped.append(kwargs)
        return {"statusCode": 200}

    # convenience for assertions
    @property
    def commands(self):
        return [c["body"]["command"] for c in self.calls]

    def decoded_scripts(self):
        """The base64 payload of every command, decoded — proves what actually
        ran inside the container."""
        import base64 as _b64, re as _re
        out = []
        for cmd in self.commands:
            m = _re.search(r"echo ([A-Za-z0-9+/=]+) \| base64 -d", cmd)
            out.append(_b64.b64decode(m.group(1)).decode() if m else "")
        return out


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
        # every probe answers "running" with the CLI's cap far in the future, so
        # neither the kill bound nor the hard stop fires. The overall wall-clock
        # deadline is the bound that must end this turn.
        submit_client = mock.MagicMock()
        submit_client.invoke_agent_runtime.side_effect = lambda **kw: _invoke_response(
            {"submitted": True, "turn_id": json.loads(kw["payload"])["turn_id"]}
        )
        cmd = FakeCommandClient([_probe_stream(_verdict_lines("running", state="S", etimes=1))])
        events_client = mock.MagicMock()

        box = {}

        def run():
            box["result"] = main._remote_coding_turn("implement the widget", "claude")

        with mock.patch.object(main.boto3, "client", return_value=submit_client), \
             mock.patch.object(main, "_CMD_CLIENT", cmd, create=True), \
             mock.patch.object(main, "_ddb_events_client", events_client), \
             mock.patch.object(main, "REMOTE_CODING_WAIT_SLICE_S", 0.01), \
             mock.patch.dict(main._WATCHDOG, {"turnTimeoutSecs": 3600}), \
             mock.patch.object(main, "REMOTE_CODING_TURN_DEADLINE_S", 0.5, create=True):
            worker = threading.Thread(target=run, daemon=True)
            worker.start()
            worker.join(timeout=3.0)
            still_blocked = worker.is_alive()
            if still_blocked:
                # Pre-fix code blocks until an inner bound — drain the leaked
                # worker before the patches lift so it can't touch real clients,
                # then fail the assertions below.
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
             mock.patch.object(main, "_submit_and_wait",
                               side_effect=RuntimeError("connection reset by peer")):
            out = main._remote_coding_turn("do the thing", "codex")

        self.assertTrue(out.startswith("ERROR: remote codex turn failed:"))
        self.assertIn("connection reset by peer", out)
        self._assert_agent_error_published(events_client, "connection reset by peer")

    def test_error_result_publishes_agent_error(self):
        # Synchronous setup failure (bad repo / clone) — submit itself answers
        # with {error}; no waiting happens.
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
        cmd = FakeCommandClient([_probe_stream(_done_lines(
            {"status": "done", "response": "all done", "claude_session_id": "s-1"}))])
        events_client = mock.MagicMock()
        with mock.patch.object(main.boto3, "client", return_value=submit_client), \
             mock.patch.object(main, "_CMD_CLIENT", cmd, create=True), \
             mock.patch.object(main, "_ddb_events_client", events_client), \
             mock.patch.object(main, "REMOTE_CODING_WAIT_SLICE_S", 0.01):
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

    def test_blocking_probes_do_not_overshoot_deadline_by_more_than_one_call(self):
        # Every probe BLOCKS for 2s before answering "running" (a slice that runs
        # its full length). Deadline is 0.5s. A probe already in flight when the
        # deadline expires cannot be interrupted — that one call is the
        # permissible overshoot; nothing else may be started after it.
        probe_block_s = 2.0
        submit_client = mock.MagicMock()
        submit_client.invoke_agent_runtime.side_effect = lambda **kw: _invoke_response(
            {"submitted": True, "turn_id": json.loads(kw["payload"])["turn_id"]}
        )

        class _SlowCommandClient(FakeCommandClient):
            def invoke_agent_runtime_command(self, **kwargs):
                time.sleep(probe_block_s)
                return super().invoke_agent_runtime_command(**kwargs)

        cmd = _SlowCommandClient([_probe_stream(_verdict_lines("running", state="S"))])
        events_client = mock.MagicMock()

        with mock.patch.object(main.boto3, "client", return_value=submit_client), \
             mock.patch.object(main, "_CMD_CLIENT", cmd, create=True), \
             mock.patch.object(main, "_ddb_events_client", events_client), \
             mock.patch.object(main, "REMOTE_CODING_WAIT_SLICE_S", 0.01), \
             mock.patch.dict(main._WATCHDOG, {"turnTimeoutSecs": 3600}), \
             mock.patch.object(main, "REMOTE_CODING_TURN_DEADLINE_S", 0.5, create=True):
            t0 = time.monotonic()
            result = main._remote_coding_turn("implement the widget", "claude")
            elapsed = time.monotonic() - t0

        self.assertLess(
            elapsed, 0.5 + probe_block_s + 0.5,
            f"turn took {elapsed:.2f}s — a blocking call was started after the "
            f"0.5s deadline expired (TEAM-3307 F1 overshoot)",
        )
        self.assertEqual(len(cmd.calls), 1,
                         "only the probe already in flight may run past the deadline")
        self.assertTrue(result.startswith("ERROR: remote claude turn"),
                        f"expected a loud ERROR return, got: {result[:120]!r}")
        self.assertIn("deadline", result)
        self._assert_agent_error_published(events_client, "deadline")

    def test_submit_is_not_started_once_deadline_expired(self):
        # The vm-death resubmit race: by the time _submit_and_wait runs again,
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
        cmd = FakeCommandClient([_probe_stream(_verdict_lines("running", state="S"))])
        main._CODING_SESSION["session_id"] = "cc-test-deadline-expired-session"

        expired_deadline = time.monotonic() - 0.001
        with mock.patch.object(main, "_CMD_CLIENT", cmd, create=True), \
             mock.patch.object(main, "REMOTE_CODING_WAIT_SLICE_S", 0.01):
            t0 = time.monotonic()
            result = main._submit_and_wait(
                submit_client, {"prompt": "x", "cli": "claude"}, expired_deadline)
            elapsed = time.monotonic() - t0

        self.assertLess(
            elapsed, 2.0,
            f"_submit_and_wait took {elapsed:.2f}s with an already-expired "
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
        cmd = FakeCommandClient([_probe_stream(_done_lines(
            {"status": "done", "response": "ok", "claude_session_id": "s-1"}))])
        events_client = mock.MagicMock()
        with mock.patch.object(main.boto3, "client", return_value=submit_client), \
             mock.patch.object(main, "_CMD_CLIENT", cmd, create=True), \
             mock.patch.object(main, "_ddb_events_client", events_client), \
             mock.patch.object(main, "REMOTE_CODING_WAIT_SLICE_S", 0.01):
            main._remote_coding_turn("implement the widget", "claude")
        # Waiting rides the command client, so submit_client only sees the submit.
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


class TestCliBoundFromWatchdog(RemoteCodingTestCase):
    """TEAM-3687 / DL-026 — the only per-turn bound the fleet computes is the
    CLI's own cap (per-agent turnTimeoutSecs) plus a kill grace. No budget
    arithmetic, no heartbeat-driven extension: the pre-DL-026 code derived a
    budget from the cap and then let every "running" poll push it forward, so the
    only bound that ever fired was 2x budget (9600s on a 4800s budget, 2026-09-09)."""

    def _capture_bound(self):
        captured = {}

        def fake_submit_and_wait(client, payload, outer_deadline=None,
                                 cli_bound_s=None):
            captured["cli_bound_s"] = cli_bound_s
            captured["outer_deadline"] = outer_deadline
            return {"status": "done", "response": "ok", "claude_session_id": "s-1"}

        events_client = mock.MagicMock()
        with mock.patch.object(main.boto3, "client", return_value=mock.MagicMock()), \
             mock.patch.object(main, "_submit_and_wait",
                               side_effect=fake_submit_and_wait), \
             mock.patch.object(main, "_ddb_events_client", events_client):
            t0 = time.monotonic()
            main._remote_coding_turn("implement the widget", "claude")
        captured["deadline_from_now"] = captured["outer_deadline"] - t0
        return captured

    def test_default_bound_is_the_cap_plus_kill_grace(self):
        cap = self._capture_bound()
        self.assertEqual(cap["cli_bound_s"],
                         main._WATCHDOG["turnTimeoutSecs"] + main.REMOTE_CODING_KILL_GRACE_S)
        self.assertEqual(cap["cli_bound_s"], 1560, "1500s cap + 60s kill grace")

    def test_override_raises_the_bound_by_exactly_the_override(self):
        with mock.patch.object(main, "_WATCHDOG",
                               {**main._WATCHDOG, "turnTimeoutSecs": 3600}):
            cap = self._capture_bound()
        self.assertEqual(cap["cli_bound_s"], 3600 + main.REMOTE_CODING_KILL_GRACE_S)

    def test_outer_deadline_does_not_scale_with_the_cap(self):
        """It is an absolute ceiling on the whole nested turn, so it must be the
        same number whatever the per-agent cap is — and must clear the largest
        supported cap plus both graces."""
        default = self._capture_bound()
        with mock.patch.object(main, "_WATCHDOG",
                               {**main._WATCHDOG, "turnTimeoutSecs": 3600}):
            raised = self._capture_bound()
        self.assertAlmostEqual(default["deadline_from_now"],
                               raised["deadline_from_now"], delta=1.0)
        self.assertAlmostEqual(default["deadline_from_now"],
                               main.REMOTE_CODING_TURN_DEADLINE_S, delta=1.0)
        self.assertGreater(
            main.REMOTE_CODING_TURN_DEADLINE_S,
            3600 + main.REMOTE_CODING_KILL_GRACE_S + main.REMOTE_CODING_HARVEST_GRACE_S
            + main.REMOTE_CODING_START_GRACE_S,
            "the outer deadline must not preempt a legitimately long turn")


class TestWaitHeartbeat(RemoteCodingTestCase):
    """A long coding turn must emit prove-alive agent.streaming events: they are
    the ONLY liveness signal the orchestrator's dead-session sweep reads
    (lambda/orchestrator/lease.mjs lastAgentActivity), so without them a healthy
    turn gets its ticket re-dispatched, and the UI looks frozen."""

    def _wait(self, script, heartbeat_s):
        events_client = mock.MagicMock()
        cmd = FakeCommandClient(script)
        with mock.patch.object(main, "_CMD_CLIENT", cmd, create=True), \
             mock.patch.object(main, "_ddb_events_client", events_client), \
             mock.patch.object(main, "REMOTE_CODING_WAIT_SLICE_S", 0.001), \
             mock.patch.object(main, "REMOTE_CODING_HEARTBEAT_S", heartbeat_s):
            out = main._wait_coding_turn("turn-x", cli="kiro", cli_bound_s=9999)
        beats = [
            c for c in events_client.put_item.call_args_list
            if c.kwargs.get("Item", {}).get("type", {}).get("S") == "agent.streaming"
            and "still working" in c.kwargs["Item"]["detail"]["M"]["content"]["S"]
        ]
        return out, beats

    def test_running_slices_emit_throttled_heartbeats(self):
        running = _probe_stream(_verdict_lines("running", state="S", etimes=5))
        out, beats = self._wait(
            [running, running, running,
             _probe_stream(_done_lines({"status": "done", "response": "ok",
                                        "claude_session_id": "s-9"}))],
            heartbeat_s=0)
        self.assertEqual(out.get("response"), "ok")
        self.assertEqual(len(beats), 3, "one heartbeat per running slice expected")
        detail = beats[0].kwargs["Item"]["detail"]["M"]
        self.assertEqual(detail["agentId"]["S"], "frontend_dev")
        self.assertEqual(detail["workflowId"]["S"], "wf-test")
        self.assertEqual(detail["ticketId"]["S"], "TEAM-3119")
        self.assertIn("kiro", detail["content"]["S"])

    def test_heartbeat_is_throttled(self):
        running = _probe_stream(_verdict_lines("running", state="S"))
        _, beats = self._wait(
            [running, running,
             _probe_stream(_done_lines({"status": "done", "response": "ok"}))],
            heartbeat_s=9999)
        self.assertEqual(len(beats), 0,
                         "throttle must suppress heartbeats within the interval")

    def test_starting_slices_also_pulse(self):
        """Workspace setup (clone + checkout) can outlast the lease TTL on its
        own, so the pulse cannot wait for the CLI to exist."""
        _, beats = self._wait(
            [_probe_stream(_verdict_lines("starting")),
             _probe_stream(_verdict_lines("starting")),
             _probe_stream(_done_lines({"status": "done", "response": "ok"}))],
            heartbeat_s=0)
        self.assertEqual(len(beats), 2)


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
             mock.patch.object(main, "_recover_lost_submit",
                               return_value={"submitted": True, "turn_id": "turn-r"}) as rec, \
             mock.patch.object(main, "_wait_coding_turn",
                               return_value={"error": "recovered then failed"}), \
             mock.patch.object(main.time, "sleep"):
            out = main._remote_coding_turn("fix the bug", "claude")
        rec.assert_called_once()
        self.assertIn("recovered then failed", out)

    def test_done_record_with_setup_failed_is_terminal(self):
        # Submit response lost, then the wait probe finds the setup failure the
        # runtime recorded in done.json — terminal, and no resubmit.
        calls = {"n": 0}

        def side_effect(**kw):
            calls["n"] += 1
            raise RuntimeError("Connection was closed before we received a valid response")

        client = self._submit_client(side_effect)
        cmd = FakeCommandClient([_probe_stream(_done_lines(
            {"status": "done", "error": "git clone failed: Repository not found.",
             "setup_failed": True, "response": ""}))])
        with mock.patch.object(main.boto3, "client", return_value=client), \
             mock.patch.object(main, "_CMD_CLIENT", cmd, create=True), \
             mock.patch.object(main, "REMOTE_CODING_WAIT_SLICE_S", 0.01), \
             mock.patch.object(main, "_ddb_events_client", mock.MagicMock()), \
             mock.patch.object(main.time, "sleep"):
            out = main._remote_coding_turn("fix the bug", "codex")
        self.assertTrue(out.startswith("ERROR: remote codex turn could not START:"), out)
        self.assertEqual(calls["n"], 1, "no resubmit after a recorded setup failure")


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
        cmd = FakeCommandClient([_probe_stream(_done_lines(
            {"status": "done", "response": "fixed it", "claude_session_id": "conv-new"}))])
        events_client = mock.MagicMock()
        with mock.patch.object(main.boto3, "client", return_value=client), \
             mock.patch.object(main, "_CMD_CLIENT", cmd, create=True), \
             mock.patch.object(main, "_ddb_events_client", events_client), \
             mock.patch.object(main, "REMOTE_CODING_WAIT_SLICE_S", 0.01), \
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
    """Stand-in for the `time` module inside main: sleep() ADVANCES the clock, so a
    multi-thousand-second wait runs in milliseconds of real time. Only the wait
    loop's own time calls are affected (_publish_coding_heartbeat does its own
    `import time`), so heartbeat behaviour is unchanged."""

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


class _ClockedCommandClient(FakeCommandClient):
    """Command client that advances a fake clock by the slice length on every
    probe, the way a real blocking slice would. Lets a 3600s bound be exercised
    without waiting an hour."""

    def __init__(self, script, clock, slice_s):
        super().__init__(script)
        self.clock = clock
        self.slice_s = slice_s

    def invoke_agent_runtime_command(self, **kwargs):
        resp = super().invoke_agent_runtime_command(**kwargs)
        self.clock.sleep(self.slice_s)
        return resp


class TestWaitVerdicts(RemoteCodingTestCase):
    """Test F — every probe verdict maps to exactly one outcome, and every phase
    is bounded by a number the fleet decided in advance.

    Before DL-026 this logic read a heartbeat file the runner wrote about itself:
    a wedged CLI whose heartbeat thread was healthy read as "running" forever, and
    each running poll pushed the deadline out, so the only bound that ever fired
    was 2x budget (9600s on a 4800s budget, 2026-09-09). Now the probe reports the
    CLI process state and the fleet kills it at a fixed bound.

    Driven through _wait_coding_turn directly on a fake clock, so the assertions
    are about the decisions, not about wall time."""

    SLICE_S = 60

    def _wait(self, script, cli_bound_s=1560, events_client=None):
        clock = _FakeClock()
        cmd = _ClockedCommandClient(script, clock, self.SLICE_S)
        with mock.patch.object(main, "_CMD_CLIENT", cmd, create=True), \
             mock.patch.object(main, "time", clock), \
             mock.patch.object(main, "REMOTE_CODING_WAIT_SLICE_S", self.SLICE_S), \
             mock.patch.object(main, "_ddb_events_client",
                               events_client or mock.MagicMock()):
            result = main._wait_coding_turn("turn-x", cli="kiro", cli_bound_s=cli_bound_s)
        return result, cmd, clock

    # ── done ────────────────────────────────────────────────────────────────
    def test_done_returns_the_record_and_stops_probing(self):
        record = {"status": "done", "response": "the work", "claude_session_id": "s-1",
                  "artifacts": ["a.png"]}
        result, cmd, clock = self._wait([_probe_stream(_done_lines(record))])
        self.assertEqual(result["response"], "the work")
        self.assertEqual(result["claude_session_id"], "s-1")
        self.assertEqual(result["artifacts"], ["a.png"])
        self.assertEqual(len(cmd.calls), 1, "a finished turn must not be probed twice")

    def test_done_payload_is_verified_against_its_checksum(self):
        """A truncated stream must not be parsed as a result: the script prints a
        sha256 of done.json and a mismatch triggers a refetch."""
        record = {"status": "done", "response": "the work"}
        bad = _done_lines(record)
        bad[1] = "DONE_SHA256=" + "0" * 64
        result, cmd, _ = self._wait([_probe_stream(bad),
                                     _probe_stream(_done_lines(record))])
        self.assertEqual(len(cmd.calls), 2, "a checksum mismatch must refetch")
        self.assertEqual(result["response"], "the work")

    def test_oversized_done_record_is_fetched_with_a_second_command(self):
        """Over the inline cap the script prints only the checksum, so the record
        comes back on its own probe rather than being lost."""
        record = {"status": "done", "response": "x" * 100}
        lines = [l for l in _done_lines(record) if not l.startswith("DONE_B64=")]
        result, cmd, _ = self._wait([_probe_stream(lines),
                                     _probe_stream(_done_lines(record))])
        self.assertEqual(len(cmd.calls), 2)
        self.assertEqual(result["response"], "x" * 100)

    def test_unreadable_done_record_is_terminal_and_verify_first(self):
        lines = ["DONE_BYTES=3", "DONE_SHA256=" + "0" * 64, "DONE_B64=!!!not-base64!!!",
                 "VERDICT=done"]
        result, _, _ = self._wait([_probe_stream(lines)])
        self.assertTrue(result.get("no_retry_hint"),
                        "an unreadable result must never advise a blind re-run")
        self.assertIn("check the branch", result["error"].lower())

    # ── running / the kill bound ─────────────────────────────────────────────
    def test_perpetual_running_is_killed_at_the_bound_not_at_twice_it(self):
        running = _probe_stream(_verdict_lines("running", state="S", etimes=99))
        result, cmd, clock = self._wait([running], cli_bound_s=1560)
        self.assertLessEqual(clock.slept, 1560 + 2 * self.SLICE_S,
                             f"waited {clock.slept}s against a 1560s bound — the "
                             f"pre-DL-026 code ran to 2x its bound")
        self.assertLess(clock.slept, 2 * 1560,
                        "the give-up point must be the bound, never twice it")
        self.assertGreaterEqual(clock.slept, 1560 - self.SLICE_S,
                        "must not give up before the CLI's own cap")
        scripts = cmd.decoded_scripts()
        self.assertTrue(any("kill -KILL" in sc for sc in scripts),
                        "a CLI alive past its bound must be killed from outside")
        self.assertTrue(result.get("no_retry_hint"))
        self.assertIn("1560s", result["error"])

    def test_kill_error_reports_the_real_elapsed_time(self):
        """D1c — the old message named a bound that had not fired ('exceeded
        4800s' after 9600s), so every downstream RCA reasoned about the wrong
        number."""
        running = _probe_stream(_verdict_lines("running", state="S"))
        result, _, clock = self._wait([running], cli_bound_s=600)
        self.assertIn("600s", result["error"], "the bound that fired must be named")
        self.assertRegex(result["error"], r"killed after \d+s",
                         "the actual elapsed time must be reported")

    def test_a_late_done_after_the_kill_is_not_reported_as_success(self):
        """A killed codex/kiro turn writes a done record whose response is
        '⚠ ... timed out' with no error key — reading that as a result would tell
        the persona its work succeeded."""
        running = _probe_stream(_verdict_lines("running", state="S"))
        killed = _probe_stream(_verdict_lines("done") if False else
                               _done_lines({"status": "done",
                                            "response": "⚠ kiro timed out after 600s",
                                            "claude_session_id": "s-2"}))
        result, _, _ = self._wait([running, killed], cli_bound_s=1)
        self.assertTrue(result.get("no_retry_hint"))
        self.assertIn("exceeded its", result["error"])
        self.assertNotIn("response", result)

    # ── starting ─────────────────────────────────────────────────────────────
    def test_starting_is_tolerated_then_bounded(self):
        starting = _probe_stream(_verdict_lines("starting"))
        result, _, clock = self._wait([starting])
        self.assertLessEqual(clock.slept,
                             main.REMOTE_CODING_START_GRACE_S + 2 * self.SLICE_S)
        self.assertTrue(result.get("retryable_vm_death"),
                        "a turn whose CLI never started is worth one resubmit")
        self.assertIn("never started", result["error"])

    def test_starting_then_running_then_done_is_a_normal_turn(self):
        result, cmd, _ = self._wait([
            _probe_stream(_verdict_lines("starting")),
            _probe_stream(_verdict_lines("running", state="S")),
            _probe_stream(_done_lines({"status": "done", "response": "ok"})),
        ])
        self.assertEqual(result["response"], "ok")
        self.assertEqual(len(cmd.calls), 3)

    # ── missing ──────────────────────────────────────────────────────────────
    def test_missing_needs_two_probes_then_is_retryable(self):
        missing = _probe_stream(_verdict_lines("missing"))
        result, cmd, _ = self._wait([missing])
        self.assertTrue(result.get("retryable_vm_death"))
        self.assertEqual(len(cmd.calls), 2,
                         "one missing probe could be a restart race; two is a verdict")

    def test_single_missing_between_runnings_is_not_death(self):
        result, _, _ = self._wait([
            _probe_stream(_verdict_lines("running", state="S")),
            _probe_stream(_verdict_lines("missing")),
            _probe_stream(_verdict_lines("running", state="S")),
            _probe_stream(_done_lines({"status": "done", "response": "ok"})),
        ])
        self.assertEqual(result["response"], "ok")
        self.assertNotIn("retryable_vm_death", result)

    # ── exited_no_done ───────────────────────────────────────────────────────
    def test_exited_then_done_is_the_normal_harvest_window(self):
        result, _, _ = self._wait([
            _probe_stream(_verdict_lines("exited_no_done", state="Z")),
            _probe_stream(_verdict_lines("exited_no_done", state="gone")),
            _probe_stream(_done_lines({"status": "done", "response": "harvested"})),
        ])
        self.assertEqual(result["response"], "harvested")

    def test_exited_without_a_record_is_bounded_and_reaps_the_session(self):
        """The zombie case that hid D1: kill -0 says a SIGKILLed CLI is alive, so
        the old code waited out its budget. A zombie is EXITED, and if the runner
        never renders a verdict the session is wedged and must be stopped, or its
        in-memory turn table answers session_busy until the microVM ages out."""
        result, cmd, clock = self._wait(
            [_probe_stream(_verdict_lines("exited_no_done", state="Z"))])
        self.assertLessEqual(clock.slept,
                             main.REMOTE_CODING_HARVEST_GRACE_S + 2 * self.SLICE_S)
        self.assertTrue(result.get("no_retry_hint"))
        self.assertIn("check github", result["error"].lower())
        self.assertEqual(len(cmd.stopped), 1, "the wedged session must be reaped")

    # ── probe failures ───────────────────────────────────────────────────────
    def test_probe_failures_are_non_terminal_and_a_later_done_wins(self):
        result, _, _ = self._wait([
            RuntimeError("ThrottlingException"),
            RuntimeError("connection reset"),
            _probe_stream(_done_lines({"status": "done", "response": "eventually"})),
        ])
        self.assertEqual(result["response"], "eventually")

    def test_sustained_probe_failure_is_bounded_and_verify_first(self):
        result, _, clock = self._wait([RuntimeError("runtime unreachable")])
        self.assertLessEqual(clock.slept,
                             main.REMOTE_CODING_PROBE_FAIL_S + 2 * self.SLICE_S)
        self.assertTrue(result.get("no_retry_hint"))
        self.assertIn("lost contact", result["error"])

    def test_unparsable_probe_output_does_not_end_the_turn(self):
        """A verdict we cannot read is not evidence of anything; keep waiting."""
        result, _, _ = self._wait([
            _probe_stream(["something unexpected"]),
            _probe_stream(_done_lines({"status": "done", "response": "ok"})),
        ])
        self.assertEqual(result["response"], "ok")

    # ── bounds that hold regardless of the caller ────────────────────────────
    def test_outer_deadline_still_preempts_everything(self):
        clock = _FakeClock()
        cmd = _ClockedCommandClient(
            [_probe_stream(_verdict_lines("running", state="S"))], clock, self.SLICE_S)
        with mock.patch.object(main, "_CMD_CLIENT", cmd, create=True), \
             mock.patch.object(main, "time", clock), \
             mock.patch.object(main, "REMOTE_CODING_WAIT_SLICE_S", self.SLICE_S), \
             mock.patch.object(main, "_ddb_events_client", mock.MagicMock()):
            result = main._wait_coding_turn("turn-x", outer_deadline=clock.monotonic() + 120,
                                            cli="kiro", cli_bound_s=99999)
        self.assertTrue(result.get("deadline_exceeded"))
        self.assertLessEqual(clock.slept, 120 + self.SLICE_S)

    def test_probes_use_the_turn_dir_the_runtime_reported(self):
        """The runtime's turn root is configurable, so the fleet must not assume a
        path: the submit response says where the state is."""
        clock = _FakeClock()
        cmd = _ClockedCommandClient(
            [_probe_stream(_done_lines({"status": "done", "response": "ok"}))],
            clock, self.SLICE_S)
        with mock.patch.object(main, "_CMD_CLIENT", cmd, create=True), \
             mock.patch.object(main, "time", clock), \
             mock.patch.object(main, "REMOTE_CODING_WAIT_SLICE_S", self.SLICE_S), \
             mock.patch.object(main, "_ddb_events_client", mock.MagicMock()):
            main._wait_coding_turn("turn-x", cli="kiro", cli_bound_s=999,
                                   turn_dir="/mnt/scratch/turns/turn-x")
        self.assertIn("/mnt/scratch/turns/turn-x", cmd.commands[0])
        self.assertNotIn("/tmp/turns/turn-x", cmd.commands[0])

    def test_probes_fall_back_to_the_default_turn_dir(self):
        _, cmd, _ = self._wait([_probe_stream(_done_lines({"status": "done"}))])
        self.assertIn(main.REMOTE_CODING_TURNS_ROOT, cmd.commands[0])

    def test_wait_terminates_even_with_no_deadline_and_a_huge_bound(self):
        """No loop in the coding path may depend on the caller remembering to
        pass a deadline (TEAM-3119): the wait computes its own hard stop."""
        starting = _probe_stream(_verdict_lines("starting"))
        result, _, clock = self._wait([starting], cli_bound_s=10 ** 9)
        self.assertTrue(result.get("error"))
        self.assertLess(clock.slept, 10 ** 9,
                        "the hard stop must bound an absurd cli_bound_s")


if __name__ == "__main__":
    unittest.main()
