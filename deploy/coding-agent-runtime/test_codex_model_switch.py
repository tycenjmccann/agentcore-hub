#!/usr/bin/env python3
"""A codex thread is resumed only under the model that created it (TEAM-5066).

Codex records reasoning items encrypted for the model that wrote them. Resuming
a thread created on `sol` with `codex exec resume <id> --model terra` makes
Bedrock reject the replay ("encrypted reasoning was created for a different
account or model"). The runtime now records each thread's model in the session
map (.sessions.json) and:

  1. resumes the same thread when the turn's resolved model matches;
  2. starts a NEW thread when it differs, persisting the new id + model;
  3. infers a legacy thread's model from its rollout, and keeps resuming when
     the model is unknown (the pre-fix behaviour);
  4. always resumes a ported laptop transcript (force_resume);
  5. echoes the resolved model on the turn result, including the async
     done.json the fleet reads to build the [coding-session: ...] footer.

Hermetic: the model registry and the codex CLI are faked. The fake CLI runs the
REAL merge-codex-config.py, as run-codex.sh does, so config.toml is asserted
end to end.

Run: python3 -m pytest deploy/coding-agent-runtime/test_codex_model_switch.py -v
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

_HERE = Path(__file__).resolve().parent
_TMP = tempfile.mkdtemp(prefix="coding-model-switch-")

SOL = "us.openai.gpt-6-sol"
TERRA = "us.openai.gpt-6-terra"
TIERS = {"sol": SOL, "terra": TERRA}
# main.subprocess IS the subprocess module, so patching main.subprocess.run
# patches it globally: the fake CLI runs the merger through the real one.
_REAL_RUN = subprocess.run


def _load_main(module_name: str, env_overrides: dict | None = None):
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


main = _load_main("coding_agent_main_model_switch",
                  {"WORKSPACE_ROOT": _TMP, "CODEX_HOME": os.path.join(_TMP, ".codex")})


def _fake_resolve(_registry, model, cli):
    assert cli == "codex"
    return (TIERS.get(model, model), "bedrock-mantle", "us-east-2", "responses", 272000)


class FakeCodex:
    """Stands in for run-codex.sh + codex. Records each argv, writes config.toml
    through the real merger from the env main.py stamped, and answers with a
    thread.started frame: the resumed id, or a new t-N for a fresh run."""

    def __init__(self):
        self.calls: list[list[str]] = []
        self.fresh = 0

    def _run(self, args, env) -> str:
        self.calls.append(list(args))
        codex_home = env.get("CODEX_HOME") or main.CODEX_HOME
        os.makedirs(codex_home, exist_ok=True)
        _REAL_RUN(
            [sys.executable, str(_HERE / "merge-codex-config.py"),
             os.path.join(codex_home, "config.toml"), env["CODEX_MODEL"],
             env["CODEX_BASE_URL"], env["CODEX_ENDPOINT"], "",
             env["CODEX_CONTEXT_WINDOW"]],
            check=True)
        if len(args) > 2:
            tid = args[2]
        else:
            self.fresh += 1
            tid = f"t-{self.fresh}"
        return "\n".join(json.dumps(o) for o in (
            {"type": "thread.started", "thread_id": tid},
            {"type": "item.completed", "item": {"type": "agent_message", "text": "ok"}},
            {"type": "turn.completed", "usage": {"input_tokens": 1, "output_tokens": 1}},
        )) + "\n"

    def run(self, args, **kw):
        return types.SimpleNamespace(returncode=0, stdout=self._run(args, kw["env"]), stderr="")

    def popen(self, args, **kw):
        out = self._run(args, kw["env"])
        return types.SimpleNamespace(
            stdout=iter(out.splitlines(keepends=True)),
            stderr=types.SimpleNamespace(read=lambda: ""),
            returncode=0, pid=4242,
            wait=lambda timeout=None: 0, poll=lambda: 0, kill=lambda: None)


class _Base(unittest.TestCase):
    def setUp(self):
        if os.path.exists(main.SESSION_MAP):
            os.remove(main.SESSION_MAP)
        cfg = os.path.join(main.CODEX_HOME, "config.toml")
        if os.path.exists(cfg):
            os.remove(cfg)
        self.cli = FakeCodex()
        self.workdir = tempfile.mkdtemp(dir=_TMP)
        self._patches = [
            mock.patch.object(main, "load_registry", return_value=None),
            mock.patch.object(main, "resolve_coding_model", side_effect=_fake_resolve),
            mock.patch.object(main.subprocess, "run", side_effect=self.cli.run),
            mock.patch.object(main.subprocess, "Popen", side_effect=self.cli.popen),
            mock.patch.object(main, "_sync_turn_artifacts", return_value={}),
            mock.patch.object(main, "RESUME_HINT_PATH", os.path.join(_TMP, "hint.sh")),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in reversed(self._patches):
            p.stop()

    def turn(self, model, thread=None, stream=True, **kw) -> dict:
        if not stream:
            res = main._run_codex("do it", self.workdir, thread, None, model, **kw)
            # The buffered handler persists after the turn (main.py invocations).
            main._remember_session(res["claude_session_id"], None, model=res.get("model"))
            return res
        done = None
        for frame in main._stream_codex("do it", self.workdir, thread, model=model, **kw):
            obj = json.loads(frame[len("data: "):])
            if obj.get("type") == "done":
                done = obj
        self.assertIsNotNone(done, "stream produced no done frame")
        return done

    def config_model(self) -> str:
        with open(os.path.join(main.CODEX_HOME, "config.toml")) as f:
            for line in f:
                if line.startswith("model ="):
                    return line.split("=", 1)[1].strip().strip('"')
        return ""

    def session_map(self) -> dict:
        with open(main.SESSION_MAP) as f:
            return json.load(f)


class TestTierSwitch(_Base):
    def _assert_switch(self, stream):
        first = self.turn("sol", stream=stream)
        self.assertEqual(first["claude_session_id"], "t-1")
        self.assertEqual(first["model"], SOL)
        self.assertEqual(self.session_map()["t-1"]["model"], SOL)

        with self.assertLogs(main.logger, level="INFO") as logs:
            second = self.turn("terra", thread="t-1", stream=stream)
        self.assertEqual(len(self.cli.calls[-1]), 2, "must not resume the sol thread")
        self.assertNotIn("t-1", self.cli.calls[-1])
        self.assertEqual(second["claude_session_id"], "t-2")
        self.assertEqual(second["model"], TERRA)
        self.assertEqual(self.session_map()["t-2"]["model"], TERRA)
        self.assertEqual(self.config_model(), TERRA)
        self.assertTrue(any(f"model changed {SOL} → {TERRA}; new thread t-2" in m
                            for m in logs.output), logs.output)

    def test_tier_switch_starts_new_thread_streaming(self):
        self._assert_switch(stream=True)

    def test_tier_switch_starts_new_thread_buffered(self):
        self._assert_switch(stream=False)

    def test_same_tier_resumes_same_thread(self):
        self.turn("sol")
        again = self.turn("sol", thread="t-1")
        self.assertEqual(self.cli.calls[-1][2], "t-1")
        self.assertEqual(again["claude_session_id"], "t-1")
        self.assertEqual(self.cli.fresh, 1)
        self.assertEqual(self.config_model(), SOL)

    def test_switch_back_starts_fresh_from_the_new_thread(self):
        self.turn("sol")
        self.turn("terra", thread="t-1")
        back = self.turn("sol", thread="t-2")
        self.assertEqual(len(self.cli.calls[-1]), 2)
        self.assertEqual(back["claude_session_id"], "t-3")
        self.assertEqual(self.config_model(), SOL)


class TestLegacyThreads(_Base):
    def _write_rollout(self, tid, model):
        d = os.path.join(main.CODEX_HOME, "sessions", "2026", "09", "24")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"rollout-2026-09-24T00-00-00-{tid}.jsonl"), "w") as f:
            f.write(json.dumps({"type": "session_meta", "payload": {"id": tid}}) + "\n")
            f.write(json.dumps({"type": "turn_context", "payload": {"model": model}}) + "\n")

    def test_model_inferred_from_rollout(self):
        self._write_rollout("legacy-1", SOL)
        done = self.turn("terra", thread="legacy-1")
        self.assertEqual(len(self.cli.calls[-1]), 2)
        self.assertEqual(done["claude_session_id"], "t-1")

    def test_rollout_same_model_resumes(self):
        self._write_rollout("legacy-2", TERRA)
        self.turn("terra", thread="legacy-2")
        self.assertEqual(self.cli.calls[-1][2], "legacy-2")

    def test_unknown_model_keeps_resuming(self):
        done = self.turn("terra", thread="no-record")
        self.assertEqual(self.cli.calls[-1][2], "no-record")
        self.assertEqual(done["claude_session_id"], "no-record")
        self.assertEqual(self.session_map()["no-record"]["model"], TERRA)

    def test_ported_transcript_forces_resume(self):
        self._write_rollout("ported-1", "gpt-5.5")  # the laptop's OpenAI id
        self.turn("terra", thread="ported-1", force_resume=True)
        self.assertEqual(self.cli.calls[-1][2], "ported-1")


class TestSessionMap(_Base):
    def test_write_without_model_keeps_the_stored_model(self):
        main._remember_session("t-9", "org/repo", model=SOL)
        main._remember_session("t-9", "org/repo")
        self.assertEqual(self.session_map()["t-9"], {"repo": "org/repo", "model": SOL})

    def test_legacy_repo_only_entry_is_unknown(self):
        main._remember_session("t-8", "org/repo")
        self.assertIsNone(main._codex_thread_model("t-8"))


class TestAsyncDoneCarriesModel(unittest.TestCase):
    def test_done_json_has_model_and_forwards_force_resume(self):
        seen = {}

        def fake_stream(*args, **kw):
            seen.update(kw)
            yield "data: " + json.dumps({"type": "done", "response": "ok",
                                         "claude_session_id": "t-2", "model": TERRA}) + "\n\n"

        turn_dir = tempfile.mkdtemp(dir=_TMP)
        with mock.patch.object(main, "_stream_codex", side_effect=fake_stream):
            main._run_turn_async("turn-1", turn_dir, "codex", "do it", _TMP, "t-1",
                                 None, "sess-1", None, "terra", 60, None, True)
        rec = main._turn_read_done(turn_dir)
        self.assertEqual(rec["model"], TERRA)
        self.assertEqual(rec["claude_session_id"], "t-2")
        self.assertTrue(seen.get("force_resume"))


if __name__ == "__main__":
    unittest.main()
