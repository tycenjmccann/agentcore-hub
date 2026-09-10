#!/usr/bin/env python3
"""The wait/kill probe shell scripts, run under a REAL bash against REAL
processes (DL-026).

_wait_coding_turn's decisions are only as good as what these scripts report, and
the two bugs that cost the most on 2026-09-09/10 were both about process state,
not about control flow:

  • `kill -0` reports a SIGKILLed process as ALIVE while it lingers as a zombie
    (PID 1 in the coding container does not reap), so "is the CLI still running"
    answered yes for 2h40m after the CLI was dead. The scripts therefore read the
    state field of /proc/<pid>/stat and treat Z as exited.
  • a launcher's grandchildren survive a kill aimed at the launcher pid, so the
    kill must target the process GROUP.

Mocking either away proves nothing, so this suite drives the actual scripts.
Linux-only: /proc/<pid>/stat, `kill -- -pgid` semantics and zombie lifetime are
what is under test. Skipped elsewhere (macOS dev machines); CI runs Linux.

Run: python3 -m pytest deploy/runtime-agent/test_turn_probe_scripts.py -v
"""

import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_remote_coding import main  # noqa: E402 — imports main.py with its stubs installed

_LINUX = sys.platform.startswith("linux")


def _run_script(script: str, turn_dir: str, secs: int = 0, timeout: int = 60) -> dict:
    """Run a probe exactly as the runtime would: the base64-wrapped command the
    fleet sends, executed by a real bash. Returns the parsed KEY=VALUE fields."""
    turn_id = os.path.basename(turn_dir)
    command = main._probe_command(script, turn_id, secs)
    # _probe_command hardcodes /tmp/turns/<id>; point it at the temp dir instead
    # so the test never touches a real turn.
    command = command.replace(shlex.quote(f"/tmp/turns/{turn_id}"), shlex.quote(turn_dir))
    proc = subprocess.run(["/bin/bash", "-c", command], capture_output=True,
                          text=True, timeout=timeout)
    fields = {"exit_code": proc.returncode}
    for line in proc.stdout.splitlines():
        key, _, value = line.strip().partition("=")
        if key:
            fields[key.lower()] = value
    return fields


@unittest.skipUnless(_LINUX, "process-state semantics under test are Linux-specific")
class ProbeScriptTestCase(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="turn-probe-")
        self.turn_dir = os.path.join(self.root, "turn-probe-test")
        os.makedirs(self.turn_dir)
        self.children: list = []

    def tearDown(self):
        for pid in self.children:
            for sig in (9,):
                try:
                    os.killpg(pid, sig)
                except OSError:
                    try:
                        os.kill(pid, sig)
                    except OSError:
                        pass
        for pid in self.children:
            try:
                os.waitpid(pid, os.WNOHANG)
            except OSError:
                pass

    def _spawn(self, argv, write_pid=True):
        """A process in its OWN group, like the coding runtime's Popen(
        start_new_session=True), with its pid published the way the runner does."""
        proc = subprocess.Popen(argv, start_new_session=True,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.children.append(proc.pid)
        if write_pid:
            with open(os.path.join(self.turn_dir, "pid"), "w") as f:
                f.write(str(proc.pid))
        return proc

    def _write_done(self, record):
        with open(os.path.join(self.turn_dir, "done.json"), "w") as f:
            json.dump(record, f)


class TestWaitScriptVerdicts(ProbeScriptTestCase):
    def test_missing_when_the_turn_dir_does_not_exist(self):
        fields = _run_script(main._WAIT_SCRIPT, os.path.join(self.root, "nope"), 0)
        self.assertEqual(fields.get("verdict"), "missing")
        self.assertEqual(fields["exit_code"], 0, "the probe must always exit 0")

    def test_starting_when_meta_exists_but_no_pid_yet(self):
        main._turn_write_json = getattr(main, "_turn_write_json", None)  # runtime-only helper
        with open(os.path.join(self.turn_dir, "meta.json"), "w") as f:
            json.dump({"phase": "setup"}, f)
        fields = _run_script(main._WAIT_SCRIPT, self.turn_dir, 0)
        self.assertEqual(fields.get("verdict"), "starting")

    def test_running_while_the_process_lives(self):
        self._spawn(["sleep", "30"])
        fields = _run_script(main._WAIT_SCRIPT, self.turn_dir, 0)
        self.assertEqual(fields.get("verdict"), "running")
        self.assertNotEqual(fields.get("state"), "Z")
        self.assertTrue(fields.get("etimes", "").isdigit(),
                        "the error message needs the CLI's real age")
        self.assertLess(int(fields["etimes"]), 60,
                        f"etimes={fields['etimes']} for a process seconds old — "
                        f"stat field 22 is a start time in clock ticks, not an "
                        f"elapsed time")

    def test_etimes_grows_with_the_process_age(self):
        self._spawn(["sleep", "30"])
        first = _run_script(main._WAIT_SCRIPT, self.turn_dir, 0)
        time.sleep(2.5)
        second = _run_script(main._WAIT_SCRIPT, self.turn_dir, 0)
        self.assertGreater(int(second["etimes"]), int(first["etimes"]) - 1)
        self.assertLess(int(second["etimes"]), 60)

    def test_exited_no_done_for_a_zombie(self):
        """THE D1 SIGNATURE. The CLI is dead but unreaped, so `kill -0` still
        succeeds; the script must call it exited or a dead turn reads as live
        forever."""
        proc = self._spawn(["sleep", "30"])
        os.killpg(proc.pid, 9)
        time.sleep(0.3)
        # Prove the naive check would have lied.
        os.kill(proc.pid, 0)  # raises if truly gone; a zombie answers fine
        fields = _run_script(main._WAIT_SCRIPT, self.turn_dir, 0)
        self.assertEqual(fields.get("state"), "Z", "expected an unreaped zombie")
        self.assertEqual(fields.get("verdict"), "exited_no_done")

    def test_exited_no_done_when_the_process_is_fully_gone(self):
        proc = self._spawn(["true"])
        proc.wait(timeout=10)
        fields = _run_script(main._WAIT_SCRIPT, self.turn_dir, 0)
        self.assertEqual(fields.get("state"), "gone")
        self.assertEqual(fields.get("verdict"), "exited_no_done")

    def test_done_takes_precedence_and_carries_a_verified_payload(self):
        record = {"status": "done", "response": "the work", "claude_session_id": "s-1"}
        self._write_done(record)
        self._spawn(["sleep", "30"])  # still running: done must still win
        fields = _run_script(main._WAIT_SCRIPT, self.turn_dir, 0)
        self.assertEqual(fields.get("verdict"), "done")
        self.assertEqual(main._decode_done_payload(fields), record,
                         "the fleet must be able to decode what the script printed")

    def test_done_payload_survives_a_response_with_shell_metacharacters(self):
        """CLI output is arbitrary text; base64 is what keeps it out of the
        shell's way."""
        record = {"status": "done",
                  "response": "$(rm -rf /) `whoami` 'quoted' \"double\" | pipe & bg\nnewline"}
        self._write_done(record)
        fields = _run_script(main._WAIT_SCRIPT, self.turn_dir, 0)
        self.assertEqual(fields.get("verdict"), "done")
        self.assertEqual(main._decode_done_payload(fields), record)

    def test_large_payload_is_withheld_but_still_checksummed(self):
        record = {"status": "done", "response": "x" * 300_000}
        self._write_done(record)
        fields = _run_script(main._WAIT_SCRIPT, self.turn_dir, 0)
        self.assertEqual(fields.get("verdict"), "done")
        self.assertNotIn("done_b64", fields, "over the cap the payload is not inlined")
        self.assertIn("done_sha256", fields)
        # ...and the uncapped fetch script brings it back.
        fetched = _run_script(main._FETCH_SCRIPT, self.turn_dir, 0)
        self.assertEqual(main._decode_done_payload(fetched), record)

    def test_wait_returns_as_soon_as_done_appears(self):
        """The slice length is an upper bound, not a poll interval: a turn that
        finishes early must not cost the rest of the slice."""
        self._spawn(["sleep", "30"])
        writer = subprocess.Popen(
            ["/bin/bash", "-c",
             f'sleep 1; echo {shlex.quote(json.dumps({"status": "done", "response": "quick"}))} '
             f'> {shlex.quote(os.path.join(self.turn_dir, "done.json"))}'])
        self.addCleanup(writer.wait)
        t0 = time.monotonic()
        fields = _run_script(main._WAIT_SCRIPT, self.turn_dir, 30, timeout=60)
        elapsed = time.monotonic() - t0
        self.assertEqual(fields.get("verdict"), "done")
        self.assertLess(elapsed, 10, f"waited {elapsed:.1f}s for a turn that "
                                     f"finished after 1s")

    def test_wait_honours_its_own_bound_and_leaks_nothing(self):
        """A slice that reaches its limit must exit on its own. Letting the
        platform's `timeout` fire instead returns TIMED_OUT and leaves the wait
        loop running inside the container (measured in prod)."""
        self._spawn(["sleep", "30"])
        t0 = time.monotonic()
        fields = _run_script(main._WAIT_SCRIPT, self.turn_dir, 3, timeout=30)
        elapsed = time.monotonic() - t0
        self.assertEqual(fields.get("verdict"), "running")
        self.assertLess(elapsed, 12, "the script must bound itself")
        self.assertEqual(fields["exit_code"], 0)

    def test_state_field_is_parsed_past_a_command_name_with_spaces(self):
        """/proc/<pid>/stat's comm field can contain spaces and parens, so the
        state must be read after the LAST ')' — otherwise a CLI named e.g.
        'node (worker)' is misread as exited."""
        proc = self._spawn(["bash", "-c", "exec -a 'weird (name) here' sleep 30"])
        del proc
        fields = _run_script(main._WAIT_SCRIPT, self.turn_dir, 0)
        self.assertEqual(fields.get("verdict"), "running",
                         f"state misparsed: {fields}")


class TestKillScript(ProbeScriptTestCase):
    def test_kill_reaps_the_grandchild_that_holds_the_pipe(self):
        """The 2026-09-09 mechanism: killing the launcher alone leaves a
        grandchild holding stdout, so the runner never sees EOF. The kill targets
        the group."""
        sentinel = os.path.join(self.root, "grandchild-survived")
        self._spawn(["bash", "-c",
                     f"bash -c 'sleep 3; touch {shlex.quote(sentinel)}; sleep 30' & wait"])
        time.sleep(0.5)
        fields = _run_script(main._KILL_SCRIPT, self.turn_dir, 0, timeout=60)
        self.assertIn("killed", fields)
        time.sleep(4)
        self.assertFalse(os.path.exists(sentinel),
                         "a grandchild outlived the kill — the whole group must die")
        self.assertEqual(fields.get("verdict"), "exited_no_done")

    def test_kill_reports_done_when_the_runner_records_one(self):
        """After the group dies the runner unwinds and writes its own record; the
        kill script waits briefly so the fleet can log what happened."""
        self._spawn(["sleep", "30"])
        record = {"status": "done", "response": "⚠ kiro timed out", "error": "timeout"}
        writer = subprocess.Popen(
            ["/bin/bash", "-c",
             f'sleep 1; echo {shlex.quote(json.dumps(record))} > '
             f'{shlex.quote(os.path.join(self.turn_dir, "done.json"))}'])
        self.addCleanup(writer.wait)
        fields = _run_script(main._KILL_SCRIPT, self.turn_dir, 0, timeout=60)
        self.assertEqual(fields.get("verdict"), "done")

    def test_kill_without_a_pid_file_is_harmless(self):
        fields = _run_script(main._KILL_SCRIPT, self.turn_dir, 0)
        self.assertNotIn("killed", fields)
        self.assertEqual(fields.get("verdict"), "starting"
                         if os.path.exists(os.path.join(self.turn_dir, "meta.json"))
                         else "starting")
        self.assertEqual(fields["exit_code"], 0)


if __name__ == "__main__":
    unittest.main()
