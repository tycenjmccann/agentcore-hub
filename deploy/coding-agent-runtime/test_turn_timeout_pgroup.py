#!/usr/bin/env python3
"""TEAM-4359 — a timed-out CLI must die WITH ITS GRANDCHILDREN, and a runner that
outlives its cap must still journal a terminal record.

The 2026-09-09 incident: a kiro turn wedged, the journal heartbeated `running`
for 2h20m, and no terminal record was ever written. Two defects made that
possible, and this suite covers both.

  1. `_kill_on_timeout` did `proc.kill()` on the LAUNCHER pid only, and Popen had
     no start_new_session. CLI launchers spawn grandchildren that inherit our
     stdout pipe (run-codex.sh → codex; anything claude/kiro shells out to), so
     with the launcher dead but a grandchild holding the write end, the reader's
     `for line in proc.stdout` never saw EOF — the timed_out branch, the terminal
     frame and watchdog.cancel() were all unreachable. Closing the pipe is not a
     fix: BufferedReader.close() blocks on the buffer lock the stuck read holds,
     and os.close() does not wake an in-flight read(2) on Linux (both measured).
     Fix = start_new_session=True + os.killpg(proc.pid, SIGKILL).
  2. `_run_turn_async`'s heartbeat had no bound tied to turn_timeout_s, so the
     journal never went stale and _poll_turn never said dead. Fix =
     _TURN_TERMINAL_GRACE_S, after which the runner FORCES a terminal record.

Unlike test_turn_timeout.py (which fakes Popen to stay fast), the process-group
tests here launch REAL `sh` processes with a REAL grandchild — the bug is
entirely about kernel process/pipe semantics, and a fake proc models it away.
Nothing else is real: no CLI binary, no workspace, no network, no AWS.

Liveness of the grandchild is checked with a SENTINEL FILE, not
os.killpg(pgid, 0): SIGKILLed processes linger as zombies when PID 1 does not
reap (as in this container), so the group id stays valid even after a successful
kill. "Did the grandchild live long enough to run its next command" is the
question that actually matters.

Run: python3 -m pytest deploy/coding-agent-runtime/test_turn_timeout_pgroup.py -v
"""

import importlib.util
import json
import os
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
import uuid
from pathlib import Path
from unittest import mock

_HERE = Path(__file__).resolve().parent
_TMP = tempfile.mkdtemp(prefix="coding-pgroup-")

# Bound on how long we wait for a generator that SHOULD have unwound at its cap.
# Generous vs the 1s caps used below; the point is to fail rather than hang.
_DRAIN_TIMEOUT_S = 15


def _load_main(module_name: str, env_overrides: dict | None = None):
    """Exec main.py fresh under `module_name` with env overrides in effect for the
    load. Mirrors test_turn_timeout.py's loader — `log` is a sibling module, so
    this dir must be importable."""
    if str(_HERE) not in sys.path:
        sys.path.insert(0, str(_HERE))
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


main = _load_main("coding_agent_main_pgroup", {
    "WORKSPACE_ROOT": _TMP,
    "CLAUDE_CONFIG_DIR": os.path.join(_TMP, ".claude-data"),
    "KIRO_HOME": os.path.join(_TMP, ".kiro-data"),
    # kiro's runner returns a canned error frame with no key, never reaching Popen.
    "KIRO_API_KEY": "fake-key-for-tests",
})

_REAL_POPEN = subprocess.Popen


def _drain_in_thread(gen, seconds=_DRAIN_TIMEOUT_S):
    """Consume an SSE generator on a worker thread. Returns
    (frames, outcome, elapsed) where outcome is 'finished', 'raised:...' or
    'STILL BLOCKED' — the last being the pre-fix behaviour this suite catches."""
    frames: list = []
    q: queue.Queue = queue.Queue()

    def _run():
        try:
            for chunk in gen:
                line = chunk.strip()
                if line.startswith("data:"):
                    frames.append(json.loads(line[len("data:"):].strip()))
            q.put("finished")
        except BaseException as exc:  # noqa: BLE001 — report, never propagate
            q.put(f"raised:{exc!r}")

    t = threading.Thread(target=_run, daemon=True)
    t0 = time.monotonic()
    t.start()
    t.join(seconds)
    elapsed = time.monotonic() - t0
    outcome = q.get_nowait() if not q.empty() else "STILL BLOCKED"
    return frames, outcome, elapsed


class _PgroupBase(unittest.TestCase):
    """Per-test marker + sentinel, plus a Popen wrapper that swaps only argv."""

    def setUp(self):
        self.marker = f"T4359-{uuid.uuid4().hex}"
        self.sentinel = os.path.join(_TMP, f"{self.marker}.survived")
        self.captured: list = []
        # `sh` is the launcher the watchdog kills; the inner `sh` is the
        # GRANDCHILD that inherits stdout and would keep the read loop pinned.
        # Two things must be true of the grandchild for this to reproduce:
        #   • it touches the sentinel at ~4s, so with a 1s cap the file must
        #     never appear (that is the "was it killed" probe — see the module
        #     docstring on why killpg(pgid, 0) is not usable here). The 4s gap
        #     (vs the 1s cap) gives the Timer thread + killpg a wide margin
        #     under CI load; and
        #   • it then stays alive indefinitely, so that if the kill misses it,
        #     the write end of stdout is never released and the reader really
        #     does block forever. A short-lived grandchild would close the pipe
        #     on its own and mask the bug.
        # The idle loop keeps the marker in the surviving process's own argv so
        # tearDown's pkill can always find it; its transient `sleep` children
        # exit on their own within 5s.
        self.wedge_argv = [
            "sh", "-c",
            f'echo {self.marker}; '
            f'sh -c "sleep 4; touch {self.sentinel}; while :; do sleep 5; done" & wait',
        ]

    def tearDown(self):
        # Reap anything that survived. The marker is in both shells' cmdlines and
        # is unique to this test. Deliberately NOT os.killpg(os.getpgid(pid), ...):
        # for a child that is not a session leader that resolves to OUR OWN group.
        try:
            subprocess.run(["pkill", "-f", self.marker],
                           capture_output=True, check=False)
        except FileNotFoundError:
            # procps not installed on this image — fall back to a manual
            # /proc scan for anything whose cmdline carries our marker.
            for entry in os.listdir("/proc"):
                if not entry.isdigit():
                    continue
                try:
                    with open(f"/proc/{entry}/cmdline", "rb") as f:
                        cmdline = f.read()
                except OSError:
                    continue
                if self.marker.encode() in cmdline:
                    try:
                        os.kill(int(entry), signal.SIGKILL)
                    except OSError:
                        pass

    def _popen(self, argv=None):
        """Popen stand-in that records the kwargs main.py asked for and forwards
        every one of them verbatim to the REAL Popen, substituting only argv.

        This is why the start_new_session assertions below are behavioural rather
        than mock theatre: the flag is not intercepted, it reaches the kernel. If
        main.py stopped passing it, the launcher would land in this test process's
        own group and the kill would also fail to unwind the reader."""
        target = argv or self.wedge_argv

        def _wrapped(args, **kwargs):
            self.captured.append(dict(kwargs))
            kwargs.pop("cwd", None)          # the wedge needs no checkout
            kwargs["env"] = {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}
            return _REAL_POPEN(target, **kwargs)

        return mock.patch.object(main.subprocess, "Popen", side_effect=_wrapped)

    def _quiet_side_effects(self):
        """Suppress the post-turn bookkeeping the timeout path never reaches
        anyway, so a healthy-path test doesn't touch S3/EFS."""
        return [
            mock.patch.object(main, "_remember_session"),
            mock.patch.object(main, "_write_resume_launch_hint"),
            mock.patch.object(main, "_sync_turn_artifacts", return_value={"keys": []}),
            mock.patch.object(main, "_kiro_newest_id", return_value="conv-test"),
        ]

    def _stream(self, cli, turn_timeout_s=1):
        if cli == "claude":
            return main._stream_claude("do it", _TMP, None, None, "cc-sess", None,
                                       None, turn_timeout_s)
        if cli == "codex":
            return main._stream_codex("do it", _TMP, None, None, "cc-sess", None,
                                      turn_timeout_s)
        return main._stream_kiro("do it", _TMP, None, None, "cc-sess", None,
                                 turn_timeout_s)

    def _drive_wedge(self, cli):
        with self._popen():
            stack = self._quiet_side_effects()
            for p in stack:
                p.start()
            try:
                return _drain_in_thread(self._stream(cli, turn_timeout_s=1))
            finally:
                for p in stack:
                    p.stop()


class TestWatchdogKillsProcessGroup(_PgroupBase):
    """A wedged CLI whose GRANDCHILD holds stdout must still produce a terminal
    frame at the cap, and the grandchild must be dead."""

    def _assert_killed_and_terminal(self, cli, frames, outcome, elapsed):
        self.assertEqual(
            outcome, "finished",
            f"[{cli}] generator did not unwind within {_DRAIN_TIMEOUT_S}s "
            f"(outcome={outcome}); the grandchild still holds stdout")
        types_seen = [f.get("type") for f in frames]
        self.assertIn("error", types_seen, f"[{cli}] no error frame: {frames}")
        self.assertIn("done", types_seen, f"[{cli}] no terminal done frame: {frames}")
        # The done frame is last and carries the soft warning the persona sees.
        done = [f for f in frames if f.get("type") == "done"][-1]
        self.assertTrue(done["response"].startswith("⚠"),
                        f"[{cli}] done response should be the ⚠ timeout notice; got {done}")
        self.assertIn(f"{cli} timed out after 1s", done["response"])
        errors = [f["error"] for f in frames if f.get("type") == "error"]
        self.assertTrue(any(f"{cli} timed out after 1s" in e for e in errors),
                        f"[{cli}] timeout error must carry the cap; got {errors}")
        # Well inside the drain bound: the kill unwinds the read immediately.
        self.assertLess(elapsed, 10.0, f"[{cli}] kill overshot the 1s cap ({elapsed:.2f}s)")

    def _assert_grandchild_dead(self, cli):
        # The grandchild would touch the sentinel at ~4s. Give it until well past
        # that; the file must never appear.
        time.sleep(4.5)
        self.assertFalse(
            os.path.exists(self.sentinel),
            f"[{cli}] the grandchild outlived the process-group kill and ran its "
            f"next command — killpg did not reach it")

    def test_stream_claude_kills_grandchild_and_yields_done(self):
        frames, outcome, elapsed = self._drive_wedge("claude")
        self._assert_killed_and_terminal("claude", frames, outcome, elapsed)
        self._assert_grandchild_dead("claude")

    def test_stream_codex_kills_grandchild_and_yields_done(self):
        frames, outcome, elapsed = self._drive_wedge("codex")
        self._assert_killed_and_terminal("codex", frames, outcome, elapsed)
        self._assert_grandchild_dead("codex")

    def test_stream_kiro_kills_grandchild_and_yields_done(self):
        frames, outcome, elapsed = self._drive_wedge("kiro")
        self._assert_killed_and_terminal("kiro", frames, outcome, elapsed)
        self._assert_grandchild_dead("kiro")


class TestStreamingPopenFlags(_PgroupBase):
    """The kill scope depends entirely on the launcher being a session leader."""

    def test_all_three_runners_launch_with_start_new_session(self):
        for cli in ("claude", "codex", "kiro"):
            with self.subTest(cli=cli):
                self.captured.clear()
                self._drive_wedge(cli)
                self.assertEqual(len(self.captured), 1,
                                 f"[{cli}] expected exactly one Popen")
                kw = self.captured[0]
                self.assertIs(kw.get("start_new_session"), True,
                              f"[{cli}] streaming Popen must start a new session so "
                              f"proc.pid is the pgid killpg targets")
                # The rest of the pipe wiring must be untouched by the fix.
                self.assertEqual(kw.get("stdout"), subprocess.PIPE)
                self.assertEqual(kw.get("stderr"), subprocess.PIPE)
                self.assertIs(kw.get("text"), True)
                self.assertEqual(kw.get("bufsize"), 1)
                self.assertEqual(kw.get("stdin"), subprocess.DEVNULL)

    def test_watchdog_does_not_kill_the_runtimes_own_process_group(self):
        """The guard against the obvious mis-implementation. Using
        os.killpg(os.getpgid(pid), SIGKILL) on a non-session-leader child
        resolves to OUR group and SIGKILLs the runtime itself."""
        own_pgid_before = os.getpgid(0)
        launched: list = []

        def _capture_popen(args, **kwargs):
            kwargs.pop("cwd", None)
            kwargs["env"] = {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}
            proc = _REAL_POPEN(self.wedge_argv, **kwargs)
            launched.append(proc)
            return proc

        with mock.patch.object(main.subprocess, "Popen", side_effect=_capture_popen):
            child_pgid = None
            # Read the pgid while the child is alive, before the cap fires.
            def _peek():
                nonlocal child_pgid
                for _ in range(200):
                    if launched:
                        try:
                            child_pgid = os.getpgid(launched[0].pid)
                        except ProcessLookupError:
                            pass
                        return
                    time.sleep(0.005)
            peeker = threading.Thread(target=_peek, daemon=True)
            peeker.start()
            _drain_in_thread(self._stream("kiro", turn_timeout_s=1))
            peeker.join(5)

        self.assertEqual(os.getpgid(0), own_pgid_before,
                         "the test process's own group must be untouched")
        self.assertIsNotNone(child_pgid, "never observed the child's pgid")
        self.assertNotEqual(child_pgid, own_pgid_before,
                            "the CLI must run in its OWN group, not the runtime's")
        self.assertEqual(child_pgid, launched[0].pid,
                         "start_new_session must make the launcher its own pgid")
        # We are still here, which is the real assertion.
        self.assertTrue(True)

    def test_streaming_timeout_logs_turn_timeout(self):
        """The streaming path used to log NOTHING on timeout — only the buffered
        path did — so the incident left no turn_timeout record to search for."""
        with self._popen():
            stack = self._quiet_side_effects()
            for p in stack:
                p.start()
            try:
                with self.assertLogs(main.logger, level="ERROR") as cap:
                    _drain_in_thread(self._stream("kiro", turn_timeout_s=1))
            finally:
                for p in stack:
                    p.stop()
        self.assertTrue(any("turn_timeout" in r.getMessage() for r in cap.records),
                        f"expected a turn_timeout ERROR; got "
                        f"{[r.getMessage() for r in cap.records]}")
        rec = [r for r in cap.records if "turn_timeout" in r.getMessage()][0]
        self.assertEqual(getattr(rec, "cli", None), "kiro")
        self.assertEqual(getattr(rec, "turn_timeout_s", None), 1)

    def test_killpg_failure_falls_back_to_proc_kill(self):
        """A group that is already gone (or a session that never took) must not
        leave the CLI unkilled — the guarded fallback is the last resort."""
        fake = mock.MagicMock()
        fake.pid = 987654
        with mock.patch.object(main.os, "killpg",
                               side_effect=ProcessLookupError) as killpg:
            main._killpg_on_timeout(fake, "kiro")
        killpg.assert_called_once_with(fake.pid, signal.SIGKILL)
        fake.kill.assert_called_once_with()

    def test_killpg_targets_proc_pid_not_the_resolved_group(self):
        """os.getpgid must never be consulted: on a child that is not a session
        leader it returns the RUNTIME's group id."""
        fake = mock.MagicMock()
        fake.pid = 987654
        with mock.patch.object(main.os, "killpg") as killpg, \
             mock.patch.object(main.os, "getpgid",
                               side_effect=AssertionError("getpgid must not be used")):
            main._killpg_on_timeout(fake, "claude")
        killpg.assert_called_once_with(fake.pid, signal.SIGKILL)
        fake.kill.assert_not_called()

    def test_healthy_cli_is_never_killed(self):
        """Control: a fast CLI under a generous cap completes cleanly and the
        watchdog never fires. Proves the kills above are the cap, not the harness."""
        frame = json.dumps({"type": "result", "result": "shipped", "session_id": "s-1"})
        argv = ["sh", "-c", f"printf '%s\\n' '{frame}'"]
        with self._popen(argv=argv), \
             mock.patch.object(main.os, "killpg",
                               side_effect=AssertionError("healthy CLI was killed")):
            stack = self._quiet_side_effects()
            for p in stack:
                p.start()
            try:
                frames, outcome, _ = _drain_in_thread(
                    self._stream("claude", turn_timeout_s=3600))
            finally:
                for p in stack:
                    p.stop()
        self.assertEqual(outcome, "finished")
        done = [f for f in frames if f.get("type") == "done"]
        self.assertEqual(len(done), 1, f"expected one done frame; got {frames}")
        self.assertEqual(done[0]["response"], "shipped")
        self.assertFalse(any("timed out" in str(f.get("error", "")) for f in frames))


class TestAsyncRunnerForcesTerminalRecord(unittest.TestCase):
    """Defence in depth: whatever the CLI's descendants do, _run_turn_async must
    journal a TERMINAL record within turn_timeout_s + _TURN_TERMINAL_GRACE_S.

    The generator is stubbed to never yield — exactly the post-kill-scope-bug
    state — with the cap, grace and beat interval shrunk so the bound fires in
    ~2s instead of ~1h."""

    TIMEOUT_S = 1
    GRACE_S = 1
    BEAT_S = 0.2

    def setUp(self):
        main._ACTIVE_TURNS.clear()
        self.turn_id = f"turn-{uuid.uuid4().hex[:8]}"
        self.session_id = f"cc-{uuid.uuid4().hex[:8]}"
        self.journal = main._turn_journal_path(self.session_id, self.turn_id)
        self.release = threading.Event()

    def tearDown(self):
        self.release.set()
        main._ACTIVE_TURNS.clear()

    def _wedged_gen(self, *a, **kw):
        # Blocks like a read loop pinned on a grandchild's pipe, then (if
        # released) delivers a LATE real result.
        self.release.wait(30)
        yield 'data: {"type": "done", "response": "late real result", ' \
              '"claude_session_id": "conv-late"}\n\n'

    def _start_runner(self, gen_factory=None):
        patches = [
            mock.patch.object(main, "_stream_kiro",
                              side_effect=gen_factory or self._wedged_gen),
            mock.patch.object(main, "TURN_HEARTBEAT_S", self.BEAT_S),
            mock.patch.object(main, "_TURN_TERMINAL_GRACE_S", self.GRACE_S),
        ]
        for p in patches:
            p.start()
        self.addCleanup(lambda: [p.stop() for p in patches])
        runner = threading.Thread(
            target=main._run_turn_async,
            args=(self.turn_id, self.journal, "kiro", "do it", _TMP, "conv-prev",
                  None, self.session_id, None, None, self.TIMEOUT_S),
            daemon=True)
        runner.start()
        return runner

    def _wait_for_terminal_journal(self, seconds=8.0):
        """Poll the journal until it holds a terminal record. Pre-fix this never
        happens and the test fails on the returned record still being running."""
        end = time.monotonic() + seconds
        record: dict = {}
        while time.monotonic() < end:
            try:
                with open(self.journal) as f:
                    record = json.load(f)
            except (FileNotFoundError, json.JSONDecodeError):
                pass
            if record.get("status") == "done":
                return record
            time.sleep(0.1)
        return record

    def test_wedged_generator_gets_forced_done_record(self):
        self._start_runner()
        record = self._wait_for_terminal_journal()
        self.assertEqual(record.get("status"), "done",
                         f"runner never journaled a terminal record; got {record}")
        self.assertIn("kiro timed out after 1s", record.get("error", ""))
        self.assertTrue(record.get("response", "").startswith("⚠"))
        self.assertEqual(record.get("cli"), "kiro")
        self.assertEqual(record.get("turn_id"), self.turn_id)

    def test_forced_record_has_the_same_keys_as_a_normal_done_record(self):
        """_poll_turn returns the journal record verbatim and the fleet parses it,
        so a forced record must not be a different shape."""
        self._start_runner()
        forced = self._wait_for_terminal_journal()
        self.assertEqual(
            set(forced) - {"error"},
            {"status", "turn_id", "cli", "finished_at", "response", "claude_session_id"},
            f"forced record keys diverge from the normal done record: {sorted(forced)}")
        self.assertEqual(forced.get("claude_session_id"), "conv-prev",
                         "the resume id we were given must survive the timeout")

    def test_forced_record_visible_to_poll_turn_and_active_turns(self):
        self._start_runner()
        self._wait_for_terminal_journal()
        # _ACTIVE_TURNS is the authority a poll consults first; it must agree.
        live = main._ACTIVE_TURNS.get(self.turn_id)
        self.assertIsInstance(live, dict)
        self.assertEqual(live.get("status"), "done")
        verdict = main._poll_turn(self.session_id, self.turn_id)
        self.assertEqual(verdict.get("status"), "done",
                         "a poll must see a terminal verdict, not 'running' forever")
        self.assertIn("timed out", verdict.get("error", ""))

    def test_no_further_running_beats_after_the_forced_record(self):
        self._start_runner()
        first = self._wait_for_terminal_journal()
        self.assertEqual(first.get("status"), "done")
        # Several beat intervals later the journal must be byte-identical: a
        # delayed beat overwriting "done" with "running" would read as stale →
        # dead → a duplicate resubmit of a turn we already reported.
        time.sleep(self.BEAT_S * 6)
        with open(self.journal) as f:
            again = json.load(f)
        self.assertEqual(again, first, "a heartbeat overwrote the terminal record")

    def test_late_real_result_does_not_clobber_the_forced_record(self):
        runner = self._start_runner()
        forced = self._wait_for_terminal_journal()
        self.assertEqual(forced.get("status"), "done")
        # Now let the wedged CLI finally deliver. The caller has already been
        # told the turn timed out, so this result must not be published.
        self.release.set()
        runner.join(20)
        self.assertFalse(runner.is_alive(), "runner thread never exited")
        with open(self.journal) as f:
            after = json.load(f)
        self.assertEqual(after, forced,
                         "a late result overwrote the forced terminal record")
        self.assertEqual(main._ACTIVE_TURNS.get(self.turn_id), forced,
                         "_ACTIVE_TURNS was clobbered by the late result")
        self.assertNotIn("late real result", json.dumps(after))

    def test_forced_terminal_record_is_written_only_once(self):
        real_write = main._journal_write
        terminal: list = []

        def _spy(path, record):
            if record.get("status") == "done":
                terminal.append(dict(record))
            return real_write(path, record)

        with mock.patch.object(main, "_journal_write", side_effect=_spy):
            runner = self._start_runner()
            self._wait_for_terminal_journal()
            time.sleep(self.BEAT_S * 6)
            self.release.set()
            runner.join(20)
        self.assertEqual(len(terminal), 1,
                         f"expected exactly one terminal write; got {terminal}")

    def test_healthy_turn_is_unaffected_by_the_bound(self):
        """A generator that completes promptly journals its REAL result — the
        bound must not turn fast turns into timeouts."""
        def _fast_gen(*a, **kw):
            yield 'data: {"type": "done", "response": "real work", ' \
                  '"claude_session_id": "conv-ok"}\n\n'

        runner = self._start_runner(gen_factory=_fast_gen)
        runner.join(20)
        self.assertFalse(runner.is_alive())
        with open(self.journal) as f:
            record = json.load(f)
        self.assertEqual(record.get("status"), "done")
        self.assertEqual(record.get("response"), "real work")
        self.assertNotIn("error", record)
        self.assertEqual(main._ACTIVE_TURNS[self.turn_id]["response"], "real work")


class TestGraceConstant(unittest.TestCase):
    """The bound is DERIVED from constants that already exist, not a new knob."""

    def test_grace_is_derived_from_existing_constants(self):
        # 15 retries x 4s terminal-write loop + the 30s proc.wait reap + the
        # staleness bar a poll uses. No env var reads this.
        self.assertEqual(main._TURN_TERMINAL_GRACE_S, 15 * 4 + 30 + main.TURN_STALE_S)
        self.assertEqual(main._TURN_TERMINAL_GRACE_S, 210)

    def test_grace_exceeds_a_single_heartbeat_interval(self):
        # Otherwise the very first beat of a healthy turn could force a timeout.
        self.assertGreater(main._TURN_TERMINAL_GRACE_S, main.TURN_HEARTBEAT_S)

    def test_grace_is_not_env_tunable(self):
        with mock.patch.dict(os.environ, {"TURN_TERMINAL_GRACE_S": "7"}, clear=False):
            reloaded = _load_main("coding_agent_main_grace_env",
                                  {"WORKSPACE_ROOT": _TMP})
        self.assertEqual(reloaded._TURN_TERMINAL_GRACE_S,
                         15 * 4 + 30 + reloaded.TURN_STALE_S)

    def test_runtime_verdict_beats_the_fleet_budget(self):
        """Cross-runtime invariant, asserted so it can't silently rot: the
        runtime's forced verdict must land before the fleet poller gives up.

            turn_timeout_s + grace + TURN_STALE_S < effective budget

        Fleet default budget 2700s (deploy/runtime-agent/main.py
        REMOTE_CODING_TURN_BUDGET_S) with a 1500s cap; the incident's per-agent
        3600s cap widens the budget to 2700 + (3600-1500) = 4800s."""
        grace, stale = main._TURN_TERMINAL_GRACE_S, main.TURN_STALE_S
        self.assertLess(1500 + grace + stale, 2700)
        self.assertLess(3600 + grace + stale, 4800)


if __name__ == "__main__":
    unittest.main()
