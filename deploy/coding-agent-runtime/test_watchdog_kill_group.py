#!/usr/bin/env python3
"""Unit tests for the coding-runtime watchdog's process-GROUP kill (TEAM-4389).

The failure this locks down: the per-turn watchdog killed only the launcher PID.
Every CLI here spawns children that inherit the stdout pipe (kiro-cli re-execs as
kiro-cli-chat, claude and codex start MCP servers), so the write end stayed open,
`for line in proc.stdout` never saw EOF, the runner never yielded its timeout
`error`/`done` frames, and the turn stayed journalled as "running" FOREVER — the
microVM pinned HealthyBusy and the caller's agent-task claim stranded.

The fix has two layers and this suite proves both, behaviorally:

  1. Popen with start_new_session=True + os.killpg(SIGKILL) on the child's own
     group, a read loop that breaks on the timed_out event instead of trusting
     pipe EOF, and terminal frames that are emitted even when the kill unwinds
     the read as an exception. Asserted against a REAL fake CLI (a /bin/sh script
     that backgrounds a child inheriting stdout and then sleeps, printing
     nothing) for ALL THREE stream runners: a `done` frame carrying "timed out"
     always arrives (test 1), and NOTHING in the CLI's process group survives the
     kill (test 2 — the actual bug: the grandchild used to outlive the kill and
     hold the pipe).
  2. _run_turn_async's wedge grace: even a generator that never yields at all
     gets a verdict journalled ("runner wedged after watchdog") instead of
     leaving the turn "running" (test 3).

The single seam is main.subprocess.Popen: the side_effect asserts the
start_new_session contract (the thing that makes a group kill possible at all)
and then launches the fake CLI, ignoring whichever argv the runner built. That
covers claude, codex and kiro without touching _kiro_args or the hardcoded
/app/run-codex.sh.

Hermetic: no AWS, no network, no real claude/codex/kiro binary; WORKSPACE_ROOT,
CLAUDE_CONFIG_DIR and KIRO_HOME all point at a tempdir, and nothing is written
outside it. POSIX-only (needs os.killpg) — skipped elsewhere.

Run: python3 -m pytest deploy/coding-agent-runtime/test_watchdog_kill_group.py -v
(also: python3 -m unittest test_watchdog_kill_group -v from this directory)
"""

import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest import mock

_HERE = Path(__file__).resolve().parent
_TMP = tempfile.mkdtemp(prefix="coding-killgroup-")

# The real Popen, captured before any patching: the fake-CLI seam patches
# main.subprocess.Popen (the module attribute, process-wide) and still needs to
# actually launch a process.
_REAL_POPEN = subprocess.Popen

_POSIX_GROUPS = hasattr(os, "killpg") and hasattr(signal, "SIGKILL")
_HAVE_PROC = os.path.isdir("/proc/self")  # the live-vs-zombie check reads /proc


def _load_main(module_name: str, env_overrides: dict | None = None):
    """Exec main.py fresh under `module_name` with env overrides in effect for
    the load, so import-time reads (KIRO_API_KEY, KIRO_HOME, WORKSPACE_ROOT) see
    the tempdir. `log` is a sibling module, so this dir must be importable."""
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


# KIRO_API_KEY must be non-empty at import or _stream_kiro returns before Popen.
_ENV = {
    "WORKSPACE_ROOT": _TMP,
    "CLAUDE_CONFIG_DIR": os.path.join(_TMP, ".claude-data"),
    "CODEX_HOME": os.path.join(_TMP, ".codex"),
    "CODEX_SQLITE_HOME": os.path.join(_TMP, ".codex-sqlite"),
    "KIRO_HOME": os.path.join(_TMP, ".kiro-data"),
    "KIRO_API_KEY": "dummy-key-not-a-real-credential",
}
main = _load_main("coding_agent_main_killgroup", _ENV)

# A CLI that prints NOTHING and leaves a child holding our stdout pipe — the
# exact shape that used to wedge the read loop past the watchdog kill.
_FAKE_CLI = os.path.join(_TMP, "fake-wedged-cli.sh")
with open(_FAKE_CLI, "w") as _f:
    _f.write("#!/bin/sh\nsh -c 'sleep 120' &\nsleep 120\n")
os.chmod(_FAKE_CLI, 0o755)


def _live_group_members(pgid: int):
    """PIDs in process group `pgid` that are NOT zombies, read from /proc.

    Why not the obvious `os.killpg(pgid, 0)` → ProcessLookupError? Because a
    ZOMBIE is still a member of its process group, and pid 1 in this sandbox (and
    in plenty of CI containers) is a plain interpreter, not a reaping init — so an
    orphaned grandchild that the group kill really DID kill sits un-reaped for the
    rest of the run and killpg(pgid, 0) keeps succeeding forever. Measured here:
    after the group SIGKILL both survivors were state "Z" and killpg still
    succeeded. A zombie runs no code and holds no file descriptor, so it cannot
    keep the inherited stdout pipe open — only a LIVE member can, and that is the
    bug under test. Do not "tighten" this back to killpg: it flakes on the
    reaper's policy, not on the fix.

    /proc/<pid>/stat fields after the comm field (which can itself contain ')',
    hence the rsplit): [0]=state, [1]=ppid, [2]=pgrp."""
    live = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/stat") as fh:
                stat = fh.read()
            fields = stat.rsplit(")", 1)[1].split()
            state, pgrp = fields[0], int(fields[2])
        except (OSError, IndexError, ValueError):
            continue  # raced with exit, or an unparsable entry
        if pgrp == pgid and state != "Z":
            live.append(int(entry))
    return live


def _describe(pids) -> str:
    out = []
    for pid in pids or []:
        try:
            with open(f"/proc/{pid}/cmdline") as fh:
                cmd = fh.read().replace("\0", " ").strip()
        except OSError:
            cmd = "?"
        out.append(f"{pid}:{cmd or '?'}")
    return ", ".join(out)


def _wait_group_dead(pgid: int, timeout: float = 3.0):
    """Poll until nothing LIVE remains in `pgid`. Returns (ok, detail)."""
    deadline = time.monotonic() + timeout
    live = []
    while True:
        live = _live_group_members(pgid)
        if not live:
            # Either the group is gone entirely or only un-reaped zombies are
            # left — nothing is holding the CLI's stdout pipe either way.
            return True, ""
        if time.monotonic() >= deadline:
            return False, f"live survivors in group {pgid}: {_describe(live)}"
        time.sleep(0.1)


def _drain(gen):
    """Consume an SSE generator into a list of decoded event dicts."""
    events = []
    for chunk in gen:
        line = chunk.strip()
        if line.startswith("data:"):
            events.append(json.loads(line[len("data:"):].strip()))
    return events


@unittest.skipUnless(_POSIX_GROUPS, "process groups / killpg are POSIX-only")
class _FakeCliBase(unittest.TestCase):
    """Shared harness: run a real wedged CLI through a stream runner under a 2s
    cap, with main.subprocess.Popen swapped for the fake-CLI launcher."""

    TURN_TIMEOUT_S = 2
    RUNNERS = ("claude", "codex", "kiro")

    def setUp(self):
        self.workdir = tempfile.mkdtemp(prefix="kg-work-", dir=_TMP)
        # The runners re-read some of these from os.environ at call time.
        env = mock.patch.dict(os.environ, _ENV, clear=False)
        env.start()
        self.addCleanup(env.stop)
        self._groups: list[int] = []
        self.addCleanup(self._cleanup_groups)

    def _cleanup_groups(self):
        """Belt and braces: never leak a `sleep 120` out of the test run, even if
        an assertion failed before the watchdog got there."""
        for pgid in self._groups:
            try:
                os.killpg(pgid, signal.SIGKILL)
            except OSError:
                pass

    def _run_wedged(self, cli: str):
        """Drive one stream runner against the fake wedged CLI. Returns
        (events, pgid, elapsed_seconds)."""
        launched = []

        def fake_popen(*args, **kwargs):
            # THE contract that makes a group kill possible (and keeps it from
            # ever signalling the server's own group): the child must lead a new
            # session, so its pgid is its own pid.
            self.assertIs(
                kwargs.get("start_new_session"), True,
                f"{cli} must Popen with start_new_session=True or the watchdog "
                f"cannot kill the CLI's process group safely",
            )
            proc = _REAL_POPEN([_FAKE_CLI], **kwargs)
            launched.append(proc)
            self._groups.append(os.getpgid(proc.pid))
            return proc

        with mock.patch.object(main.subprocess, "Popen", side_effect=fake_popen):
            runner = {"claude": main._stream_claude, "codex": main._stream_codex,
                      "kiro": main._stream_kiro}[cli]
            t0 = time.monotonic()
            events = _drain(runner("wedge forever", self.workdir, None,
                                   turn_timeout_s=self.TURN_TIMEOUT_S))
            elapsed = time.monotonic() - t0

        self.assertEqual(len(launched), 1, f"{cli} should have launched exactly one CLI")
        return events, self._groups[-1], elapsed


class TestWedgedCliAlwaysYieldsTerminalFrames(_FakeCliBase):
    """AC1 — a CLI whose child holds stdout open past the cap still produces the
    timeout error AND the terminal done frame, promptly. Before the fix the read
    loop waited on an EOF that never came and the generator returned nothing."""

    def test_wedged_cli_yields_timeout_done_frame(self):
        for cli in self.RUNNERS:
            with self.subTest(cli=cli):
                events, _pgid, elapsed = self._run_wedged(cli)

                done = [e for e in events if e.get("type") == "done"]
                self.assertEqual(
                    len(done), 1,
                    f"{cli} must always emit exactly one terminal done frame after a "
                    f"watchdog kill; got {events}",
                )
                self.assertIn(
                    "timed out", str(done[0].get("response") or ""),
                    f"{cli}'s done frame must say the turn timed out; got {done[0]}",
                )
                errors = [e for e in events if e.get("type") == "error"]
                self.assertTrue(
                    any(f"timed out after {self.TURN_TIMEOUT_S}s" in str(e.get("error") or "")
                        for e in errors),
                    f"{cli}'s timeout error must carry the per-turn cap; got {errors}",
                )
                # The whole point: the runner unwedges at the cap instead of
                # blocking on the pipe until the CLI's 120s sleeps expire.
                self.assertLess(
                    elapsed, 15.0,
                    f"{cli} took {elapsed:.1f}s to unwind a {self.TURN_TIMEOUT_S}s cap "
                    f"— the read loop is still waiting on pipe EOF",
                )

    @unittest.skipUnless(_HAVE_PROC, "the live-vs-zombie survivor check needs /proc")
    def test_no_surviving_child_after_kill(self):
        """AC2 — the kill takes the ENTIRE group. The grandchild (`sh -c 'sleep
        120'`, which inherited stdout) is the process that used to outlive
        proc.kill() and hold the pipe; nothing in the group may be left alive."""
        for cli in self.RUNNERS:
            with self.subTest(cli=cli):
                _events, pgid, _elapsed = self._run_wedged(cli)
                ok, detail = _wait_group_dead(pgid, timeout=3.0)
                self.assertTrue(
                    ok,
                    f"{cli}: the watchdog left the CLI's process group alive — {detail}. "
                    f"A survivor holding the inherited stdout pipe is exactly the "
                    f"TEAM-4389 hang.",
                )


@unittest.skipUnless(_POSIX_GROUPS, "process groups / killpg are POSIX-only")
class TestRunnerWedgeGrace(unittest.TestCase):
    """AC3 — the belt-and-braces layer. Even if a generator never yields a single
    frame (a grandchild that somehow escaped the group kill, a wedged artifact
    harvest), _run_turn_async must abandon the drain after the cap plus the grace
    and journal a done record with a verdict — never leave the turn "running"."""

    def setUp(self):
        self.workdir = tempfile.mkdtemp(prefix="kg-wedge-", dir=_TMP)
        env = mock.patch.dict(os.environ, _ENV, clear=False)
        env.start()
        self.addCleanup(env.stop)
        main._ACTIVE_TURNS.clear()
        self.addCleanup(main._ACTIVE_TURNS.clear)
        # Beat fast so the (harmless) "running" beats definitely interleave with
        # the wedge window — the terminal record must still win.
        hb = mock.patch.object(main, "TURN_HEARTBEAT_S", 1)
        hb.start()
        self.addCleanup(hb.stop)

    def test_run_turn_async_journals_verdict_when_generator_never_yields(self):
        def never_yields(*_args, **_kwargs):
            for _ in range(200):   # ~10s, well past the wedge window
                time.sleep(0.05)
            return
            yield  # pragma: no cover — makes this a generator function

        turn_id = "turn-wedged-u4"
        journal = main._turn_journal_path("sess-wedged-u4", turn_id)

        with mock.patch.object(main, "_stream_claude", side_effect=never_yields):
            t0 = time.monotonic()
            main._run_turn_async(turn_id, journal, "claude", "p", self.workdir,
                                 None, None, None, None, None,
                                 turn_timeout_s=1, wedge_grace_s=2)
            elapsed = time.monotonic() - t0

        self.assertLess(elapsed, 8.0,
                        f"_run_turn_async must give up at cap+grace, took {elapsed:.1f}s")

        with open(journal) as fh:
            record = json.load(fh)
        self.assertEqual(
            record.get("status"), "done",
            f"a silent generator must still be journalled done, not left running: {record}",
        )
        self.assertIn(
            "runner wedged after watchdog", str(record.get("error") or ""),
            f"the journalled verdict must name the wedge; got {record}",
        )
        # The in-memory table a poll on this VM consults first must agree.
        self.assertEqual(
            main._ACTIVE_TURNS.get(turn_id), record,
            "_ACTIVE_TURNS must hold the same done record the journal does",
        )


if __name__ == "__main__":
    unittest.main()
