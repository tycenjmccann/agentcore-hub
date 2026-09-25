#!/usr/bin/env python3
"""The turn result echoes the model the CLI actually ran (TEAM-5013).

The model probe (src/lib/models/probe.ts) sends `model: row.modelId` and must be
able to prove the turn ran THAT model — resolve_coding_model() substitutes
`defaults.coding*` for an id it cannot resolve (retired / quarantined), so a
green turn alone could be green for a different model (TEAM-5008 finding 5).
This suite pins the far side of that contract:

  1. every runner (sync return and streaming `done` frame, including the
     timed-out frame) carries `model` == the id the registry resolved to — the
     same id that went into the CLI's argv, so the echo cannot drift from it;
  2. the async runner copies it from the `done` frame into done.json;
  3. a record for a turn with no `model` stays without one — never defaulted.

Hermetic: main.py is exec'd for real, but load_registry is stubbed (no S3) and
the CLI subprocess is faked. resolve_coding_model stays real.

Run: python3 -m pytest -q deploy/coding-agent-runtime/test_turn_model_echo.py
"""

import importlib.util
import json
import os
import signal
import sys
import tempfile
import time
import types
import unittest
import uuid
from pathlib import Path
from unittest import mock

_HERE = Path(__file__).resolve().parent
_TMP = tempfile.mkdtemp(prefix="coding-model-echo-")
_TURNS_TMP = tempfile.mkdtemp(prefix="coding-model-echo-turns-")


def _load_main(module_name: str, env_overrides: dict | None = None):
    """Exec main.py fresh under `module_name` (same loader as test_turn_timeout.py
    — `log` is a sibling module, so this dir must be importable)."""
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


main = _load_main("coding_agent_main_model_echo", {
    "WORKSPACE_ROOT": _TMP,
    "TURNS_ROOT": _TURNS_TMP,
    "CLAUDE_CONFIG_DIR": os.path.join(_TMP, ".claude-data"),
    "KIRO_HOME": os.path.join(_TMP, ".kiro-data"),
})

OPUS = "us.anthropic.claude-opus-5"
SOL = "openai.gpt-5.5"
# Tier words that resolve to ids different from any env tail, so a pass proves
# the REGISTRY answer is what is echoed.
TEST_REGISTRY = {
    "version": 1,
    "catalog": [
        {"modelId": OPUS, "status": "active", "endpoint": "bedrock-runtime",
         "region": "us-east-1", "api": "converse"},
        {"modelId": SOL, "status": "active", "endpoint": "bedrock-mantle",
         "region": "us-east-2", "api": "responses"},
    ],
    "tiers": {"claude": {"opus": OPUS}, "codex": {"sol": SOL}},
}


class FakeStdout:
    def __init__(self, proc, lines, block_until_killed):
        self._proc, self._lines, self._block = proc, list(lines), block_until_killed

    def __iter__(self):
        yield from self._lines
        if self._block:
            for _ in range(800):  # <= ~8s hard ceiling
                if self._proc.killed:
                    return
                time.sleep(0.01)


class FakeProc:
    """subprocess.Popen stand-in for the streaming path."""

    def __init__(self, lines=None, block_until_killed=False, returncode=0):
        self.killed = False
        self.pid = 424242
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
    events = []
    for chunk in gen:
        line = chunk.strip()
        if line.startswith("data:"):
            events.append(json.loads(line[len("data:"):].strip()))
    return events


def _done(events):
    done = [e for e in events if e.get("type") == "done"]
    assert len(done) == 1, f"expected one done frame; got {events}"
    return done[0]


class _Base(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(main, "load_registry", return_value=TEST_REGISTRY)
        p.start()
        self.addCleanup(p.stop)

    def _quiet_bookkeeping(self):
        """The post-turn side effects the stream runners do on EFS/S3."""
        for name, kw in (("_remember_session", {}), ("_write_resume_launch_hint", {}),
                         ("_sync_turn_artifacts", {"return_value": {"keys": []}})):
            p = mock.patch.object(main, name, **kw)
            p.start()
            self.addCleanup(p.stop)


class TestSyncRunnersEchoModel(_Base):
    def test_run_claude_echoes_the_registry_resolved_id(self):
        captured = {}

        def fake_run(args, **kw):
            captured["args"] = args
            return mock.Mock(returncode=0, stderr="",
                             stdout=json.dumps({"result": "done", "session_id": "c-1"}))

        with mock.patch.object(main.subprocess, "run", side_effect=fake_run):
            out = main._run_claude("do it", _TMP, None, model="opus")
        self.assertEqual(out["model"], OPUS)
        # The echo is the argv value, not a second opinion about it.
        self.assertEqual(captured["args"][captured["args"].index("--model") + 1], out["model"])

    def test_run_codex_echoes_the_registry_resolved_id(self):
        captured = {}
        stdout = "\n".join(json.dumps(o) for o in (
            {"type": "thread.started", "thread_id": "t-1"},
            {"type": "item.completed", "item": {"type": "agent_message", "text": "done"}},
        ))

        def fake_run(args, **kw):
            captured["env"] = kw["env"]
            return mock.Mock(returncode=0, stdout=stdout, stderr="")

        with mock.patch.object(main.subprocess, "run", side_effect=fake_run):
            out = main._run_codex("do it", _TMP, None, model="sol")
        self.assertEqual(out["model"], SOL)
        self.assertEqual(captured["env"]["CODEX_MODEL"], out["model"])
        self.assertEqual(out["claude_session_id"], "t-1")

    def test_run_kiro_echoes_its_configured_model(self):
        # Kiro has no registry; it reports what it was launched with.
        with mock.patch.object(main, "KIRO_API_KEY", "fake-key"), \
             mock.patch.object(main, "KIRO_MODEL", ""), \
             mock.patch.object(main, "_kiro_newest_id", return_value="k-1"), \
             mock.patch.object(main.subprocess, "run",
                               return_value=mock.Mock(returncode=0, stdout="done", stderr="")):
            out = main._run_kiro("do it", _TMP, None)
        self.assertEqual(out["model"], "auto")


class TestStreamRunnersEchoModel(_Base):
    def test_stream_claude_done_frame_carries_the_resolved_id(self):
        self._quiet_bookkeeping()
        line = json.dumps({"type": "result", "result": "shipped", "session_id": "s-1"}) + "\n"
        with mock.patch.object(main.subprocess, "Popen", return_value=FakeProc(lines=[line])):
            done = _done(_drain(main._stream_claude("do it", _TMP, None, model="opus")))
        self.assertEqual(done["model"], OPUS)
        self.assertEqual(done["response"], "shipped")

    def test_stream_claude_timed_out_done_frame_still_says_what_ran(self):
        # The frame the fleet records for a killed turn must still name the model.
        fake = FakeProc(block_until_killed=True)
        with mock.patch.object(main.subprocess, "Popen", return_value=fake), \
             mock.patch.object(main.os, "killpg", side_effect=ProcessLookupError) as killpg:
            done = _done(_drain(main._stream_claude("hang", _TMP, None, model="opus",
                                                    turn_timeout_s=1)))
        killpg.assert_called_once_with(fake.pid, signal.SIGKILL)
        self.assertIn("timed out", done["response"])
        self.assertEqual(done["model"], OPUS)

    def test_stream_codex_done_frame_carries_the_resolved_id(self):
        self._quiet_bookkeeping()
        lines = [json.dumps(o) + "\n" for o in (
            {"type": "thread.started", "thread_id": "t-1"},
            {"type": "item.completed", "item": {"type": "agent_message", "text": "done"}},
            {"type": "turn.completed"},
        )]
        with mock.patch.object(main.subprocess, "Popen", return_value=FakeProc(lines=lines)):
            done = _done(_drain(main._stream_codex("do it", _TMP, None, model="sol")))
        self.assertEqual(done["model"], SOL)


class TestAsyncRecordCarriesModel(unittest.TestCase):
    def setUp(self):
        main._ACTIVE_TURNS.clear()
        self.addCleanup(main._ACTIVE_TURNS.clear)

    def _run(self, frame: dict) -> dict:
        turn_id = f"turn-{uuid.uuid4().hex[:8]}"
        turn_dir = main._register_turn(turn_id, "claude", "cc-echo", 60)

        def _gen(*a, **kw):
            yield f"data: {json.dumps(frame)}\n\n"

        with mock.patch.object(main, "_stream_claude", side_effect=_gen):
            main._run_turn_async(turn_id, turn_dir, "claude", "do it", _TMP, None, None,
                                 "cc-echo", None, "opus", 60)
        with open(os.path.join(turn_dir, "done.json")) as f:
            return json.load(f)

    def test_done_json_copies_model_from_the_done_frame(self):
        record = self._run({"type": "done", "response": "work", "claude_session_id": "c",
                            "model": OPUS})
        self.assertEqual(record["status"], "done")
        self.assertEqual(record["model"], OPUS)

    def test_done_frame_without_model_is_not_given_one(self):
        # A record must never claim a model nothing reported running.
        record = self._run({"type": "done", "response": "work", "claude_session_id": "c"})
        self.assertNotIn("model", record)


if __name__ == "__main__":
    unittest.main()
