#!/usr/bin/env python3
"""Unit tests for the per-turn wall-clock cap on the coding runtime (TEAM-3687).

The orchestrator resolves a per-agent watchdog `turnTimeoutSecs` (agents.json →
env → legacy 1500) and the runtime-agent now forwards it in the submit payload
as `turn_timeout_secs`. This suite is the FAR SIDE of that contract: it proves
the coding runtime

  1. resolves the payload field with the documented precedence (payload-first,
     env `WATCHDOG_TURN_TIMEOUT_SECS` at import, legacy 1500 tail) — and
     degrades a zero/negative/unparsable/absent value to the fleet default
     instead of disabling the cap; and
  2. actually ENFORCES the resolved value: the streaming path arms its
     threading.Timer watchdog at exactly the resolved seconds (override AND
     default), a CLI that outlives a tiny cap is killed with an error string
     carrying that cap, the same CLI under a large cap survives; and the
     buffered path hands the value straight to subprocess.run(timeout=...).

Hermetic: fastapi/uvicorn/boto3 import for real but are never driven against
AWS. The CLI subprocess is faked (Popen / subprocess.run patched), so no claude
binary, workspace, or network is touched.

Run: python3 -m pytest deploy/coding-agent-runtime/test_turn_timeout.py -v
(also: python3 -m unittest test_turn_timeout.py from this directory)
"""

import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

_HERE = Path(__file__).resolve().parent


def _load_main(module_name: str, env_overrides: dict | None = None):
    """Exec main.py fresh under `module_name`, optionally with env overrides in
    effect for the duration of the load (so import-time env parses like
    TURN_TIMEOUT_S are observable). `log` is a sibling module, so this dir must
    be importable."""
    if str(_HERE) not in sys.path:
        sys.path.insert(0, str(_HERE))
    # uvicorn is imported at module scope but only .run() is used (under
    # __main__); stub it if the env lacks it so the load never depends on it.
    if "uvicorn" not in sys.modules:
        try:
            import uvicorn  # noqa: F401
        except ImportError:
            sys.modules["uvicorn"] = types.ModuleType("uvicorn")

    ctx = mock.patch.dict(os.environ, env_overrides or {}, clear=False)
    ctx.start()
    try:
        spec = importlib.util.spec_from_file_location(module_name, _HERE / "main.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        return module
    finally:
        ctx.stop()


# One shared import for the behavioral tests; the env-precedence test reloads
# under its own name so it can vary WATCHDOG_TURN_TIMEOUT_SECS at import.
main = _load_main("coding_agent_main")


class FakeStdout:
    """Iterable stdout that yields canned lines, then optionally blocks until
    the owning proc is killed (models a wedged CLI holding the pipe open)."""

    def __init__(self, proc, lines, block_until_killed):
        self._proc = proc
        self._lines = list(lines)
        self._block = block_until_killed

    def __iter__(self):
        for ln in self._lines:
            yield ln
        if self._block:
            # Poll the kill flag in short slices so the watchdog's proc.kill()
            # unwinds us within ~10ms; hard ceiling keeps the test bounded even
            # if the timer somehow never fires.
            for _ in range(800):  # <= ~8s
                if self._proc.killed:
                    return
                time.sleep(0.01)


class FakeProc:
    """subprocess.Popen stand-in for the streaming path."""

    def __init__(self, lines=None, block_until_killed=False, returncode=0):
        self.killed = False
        self.returncode = returncode
        self.stdout = FakeStdout(self, lines or [], block_until_killed)
        self.stderr = None

    def kill(self):
        self.killed = True

    def wait(self, timeout=None):
        return self.returncode

    def poll(self):
        return self.returncode


def _drain(gen):
    """Consume an SSE generator into a list of decoded event dicts."""
    events = []
    for chunk in gen:
        line = chunk.strip()
        if line.startswith("data:"):
            events.append(json.loads(line[len("data:"):].strip()))
    return events


class TestResolveTurnTimeout(unittest.TestCase):
    """_resolve_turn_timeout precedence — payload-first, sane degradation."""

    def test_positive_payload_value_wins(self):
        self.assertEqual(main._resolve_turn_timeout(3600), 3600)

    def test_numeric_string_is_accepted(self):
        self.assertEqual(main._resolve_turn_timeout("7200"), 7200)

    def test_float_and_float_string_truncate_to_int(self):
        self.assertEqual(main._resolve_turn_timeout(1500.0), 1500)
        self.assertEqual(main._resolve_turn_timeout("900.9"), 900)

    def test_absent_falls_back_to_module_default(self):
        self.assertEqual(main._resolve_turn_timeout(None), main.TURN_TIMEOUT_S)

    def test_zero_negative_and_unparsable_degrade_to_default(self):
        # A cap of 0/-1 would DISABLE the watchdog — must degrade, not honor.
        for bad in (0, -5, "abc", "", "  ", [], {}):
            self.assertEqual(
                main._resolve_turn_timeout(bad), main.TURN_TIMEOUT_S,
                f"{bad!r} should degrade to the fleet default, never disable the cap",
            )

    def test_module_default_honors_env_at_import(self):
        # TURN_TIMEOUT_S is WATCHDOG_TURN_TIMEOUT_SECS → TURN_TIMEOUT_S → 1500.
        reloaded = _load_main(
            "coding_agent_main_envtest",
            {"WATCHDOG_TURN_TIMEOUT_SECS": "4242"},
        )
        try:
            self.assertEqual(reloaded.TURN_TIMEOUT_S, 4242)
            self.assertEqual(reloaded._resolve_turn_timeout(None), 4242)
        finally:
            sys.modules.pop("coding_agent_main_envtest", None)

    def test_default_is_1500_absent_any_env(self):
        reloaded = _load_main("coding_agent_main_default")
        try:
            # Guard: only meaningful when the ambient env sets neither knob.
            if not (os.environ.get("WATCHDOG_TURN_TIMEOUT_SECS")
                    or os.environ.get("TURN_TIMEOUT_S")):
                self.assertEqual(reloaded.TURN_TIMEOUT_S, 1500)
        finally:
            sys.modules.pop("coding_agent_main_default", None)


class _StreamTimeoutBase(unittest.TestCase):
    def setUp(self):
        # Keep os.makedirs(config_dir) off the real EFS mount.
        self._tmp = tempfile.mkdtemp(prefix="tt-claude-")
        self._env = mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": self._tmp})
        self._env.start()
        self.addCleanup(self._env.stop)


class TestStreamClaudeArmsWatchdogAtResolvedValue(_StreamTimeoutBase):
    """The armed Timer interval IS the resolved per-turn cap — the seam the
    forwarded turn_timeout_secs must reach. Asserted for an override AND the
    default so a regression that ignores the arg (reverting to TURN_TIMEOUT_S)
    fails on the override case."""

    def _captured_interval(self, turn_timeout_s):
        intervals = []

        def spy(interval, fn):
            intervals.append(interval)
            return mock.MagicMock()  # start()/cancel() are no-ops

        result_frame = json.dumps(
            {"type": "result", "result": "done", "session_id": "s-1"}
        ) + "\n"
        fake = FakeProc(lines=[result_frame], returncode=0)

        with mock.patch.object(main.threading, "Timer", side_effect=spy), \
             mock.patch.object(main.subprocess, "Popen", return_value=fake), \
             mock.patch.object(main, "_remember_session"), \
             mock.patch.object(main, "_write_resume_launch_hint"), \
             mock.patch.object(main, "_sync_turn_artifacts", return_value={"keys": []}):
            events = _drain(main._stream_claude(
                "do it", self._tmp, None, turn_timeout_s=turn_timeout_s))

        self.assertEqual(intervals, [turn_timeout_s],
                         "streaming watchdog must be armed at the resolved cap")
        # Healthy completion — a done frame with the CLI's text, no timeout.
        self.assertTrue(any(e.get("type") == "done" for e in events))
        self.assertFalse(any("timed out" in str(e.get("error", "")) for e in events))
        return intervals[0]

    def test_override_arms_watchdog_at_override(self):
        self.assertEqual(self._captured_interval(3600), 3600)

    def test_default_arms_watchdog_at_default(self):
        # Byte-identical to today when nothing is forwarded: the arg defaults to
        # TURN_TIMEOUT_S.
        self.assertEqual(self._captured_interval(main.TURN_TIMEOUT_S),
                         main.TURN_TIMEOUT_S)


class TestStreamClaudeEnforcesTimeout(_StreamTimeoutBase):
    """Behavioral proof: a fake CLI that outlives a tiny cap is KILLED and the
    error string carries the per-turn value; the same CLI under a large cap
    survives. Uses the REAL threading.Timer, so it exercises the actual kill."""

    def test_cli_outliving_tiny_cap_is_killed_with_that_value(self):
        fake = FakeProc(lines=[], block_until_killed=True)
        with mock.patch.object(main.subprocess, "Popen", return_value=fake):
            t0 = time.monotonic()
            events = _drain(main._stream_claude(
                "hang forever", self._tmp, None, turn_timeout_s=1))
            elapsed = time.monotonic() - t0

        self.assertTrue(fake.killed, "the watchdog must have killed the wedged CLI")
        self.assertLess(elapsed, 5.0, f"kill overshot the 1s cap badly ({elapsed:.2f}s)")
        errors = [e for e in events if e.get("type") == "error"]
        self.assertTrue(any("claude timed out after 1s" in e["error"] for e in errors),
                        f"timeout error must carry the per-turn value; got {errors}")

    def test_same_cli_survives_under_large_cap(self):
        # Same fast-completing CLI, generous cap → clean done, no timeout error,
        # not killed. Proves the kill above was the cap firing, not the fake.
        result_frame = json.dumps(
            {"type": "result", "result": "shipped", "session_id": "s-9"}
        ) + "\n"
        fake = FakeProc(lines=[result_frame], returncode=0)
        with mock.patch.object(main.subprocess, "Popen", return_value=fake), \
             mock.patch.object(main, "_remember_session"), \
             mock.patch.object(main, "_write_resume_launch_hint"), \
             mock.patch.object(main, "_sync_turn_artifacts", return_value={"keys": []}):
            events = _drain(main._stream_claude(
                "quick task", self._tmp, None, turn_timeout_s=3600))

        self.assertFalse(fake.killed)
        done = [e for e in events if e.get("type") == "done"]
        self.assertEqual(len(done), 1)
        self.assertEqual(done[0]["response"], "shipped")
        self.assertFalse(any("timed out" in str(e.get("error", "")) for e in events))


class TestBufferedRunnersReceiveTimeout(_StreamTimeoutBase):
    """The sync runners must pass the per-turn cap straight to
    subprocess.run(timeout=...) — override AND default."""

    def _run_claude_timeout(self, **kwargs):
        captured = {}

        def fake_run(*args, **kw):
            captured["timeout"] = kw.get("timeout")
            return types.SimpleNamespace(
                returncode=0,
                stdout=json.dumps({"result": "ok", "session_id": "s-1"}),
                stderr="",
            )

        with mock.patch.object(main.subprocess, "run", side_effect=fake_run):
            main._run_claude("do it", self._tmp, None, **kwargs)
        return captured["timeout"]

    def test_run_claude_uses_override(self):
        self.assertEqual(self._run_claude_timeout(turn_timeout_s=1234), 1234)

    def test_run_claude_defaults_to_module_timeout(self):
        # No turn_timeout_s → the byte-identical default.
        self.assertEqual(self._run_claude_timeout(), main.TURN_TIMEOUT_S)

    def test_run_codex_uses_override(self):
        captured = {}

        def fake_run(*args, **kw):
            captured["timeout"] = kw.get("timeout")
            return types.SimpleNamespace(
                returncode=0,
                stdout=json.dumps({"type": "thread.started", "thread_id": "t-1"}),
                stderr="",
            )

        with mock.patch.object(main.subprocess, "run", side_effect=fake_run):
            main._run_codex("do it", self._tmp, None, turn_timeout_s=4800)
        self.assertEqual(captured["timeout"], 4800)


if __name__ == "__main__":
    unittest.main()
