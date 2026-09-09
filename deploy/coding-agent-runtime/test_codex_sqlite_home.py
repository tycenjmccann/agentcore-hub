#!/usr/bin/env python3
"""Codex's SQLite state DBs must never land on the shared EFS CODEX_HOME.

Codex opens state_5/logs_2/goals_1/memories_1.sqlite in WAL mode; WAL across
NFS clients corrupts them, and CODEX_HOME is one EFS directory shared by every
session microVM. The fix pins CODEX_SQLITE_HOME to container-local /tmp on every
surface that launches codex. These tests guard each surface:

  1. main.py exposes the default and threads it into BOTH codex spawn sites
     (buffered `_run_codex` and streaming `_stream_codex`), honouring an
     operator override from the runtime env;
  2. the PTY shell export list carries it so an override reaches the Terminal;
  3. run-codex.sh, shell-init.sh and the Dockerfile default it too, so a shell
     that skips the server env (Terminal tab, commands API) is covered.

Hermetic: the CLI subprocess is faked; no codex binary, EFS or network.

Run: python3 -m pytest deploy/coding-agent-runtime/test_codex_sqlite_home.py -v
"""

import importlib.util
import json
import os
import re
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

_HERE = Path(__file__).resolve().parent
_TMP = tempfile.mkdtemp(prefix="coding-sqlitehome-")
DEFAULT = "/tmp/codex-sqlite"


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


main = _load_main("coding_agent_main_sqlitehome", {"WORKSPACE_ROOT": _TMP})


class _FakeProc:
    """Minimal Popen stand-in for the streaming path: one thread.started line."""

    def __init__(self):
        self.stdout = iter([json.dumps({"type": "thread.started", "thread_id": "t-1"}) + "\n"])
        self.stderr = types.SimpleNamespace(read=lambda: "")
        self.returncode = 0
        self.pid = 4242

    def wait(self, timeout=None):
        return 0

    def poll(self):
        return 0

    def kill(self):
        pass


class TestModuleDefault(unittest.TestCase):
    def test_default_is_container_local(self):
        self.assertEqual(main.CODEX_SQLITE_HOME, DEFAULT)
        self.assertFalse(main.CODEX_SQLITE_HOME.startswith(main.WORKSPACE_ROOT))

    def test_env_override_at_import(self):
        mod = _load_main("coding_agent_main_sqlitehome_override",
                         {"WORKSPACE_ROOT": _TMP, "CODEX_SQLITE_HOME": "/var/tmp/cx"})
        self.assertEqual(mod.CODEX_SQLITE_HOME, "/var/tmp/cx")


class TestBufferedSpawnEnv(unittest.TestCase):
    def _captured_env(self, **env_overrides):
        captured = {}

        def fake_run(*args, **kw):
            captured["env"] = kw.get("env")
            return types.SimpleNamespace(
                returncode=0,
                stdout=json.dumps({"type": "thread.started", "thread_id": "t-1"}),
                stderr="",
            )

        with mock.patch.dict(os.environ, env_overrides, clear=False), \
                mock.patch.object(main.subprocess, "run", side_effect=fake_run):
            main._run_codex("do it", _TMP, None)
        return captured["env"]

    def test_default_threaded_into_codex_env(self):
        env = self._captured_env()
        self.assertEqual(env.get("CODEX_SQLITE_HOME"), DEFAULT)

    def test_runtime_env_override_wins(self):
        env = self._captured_env(CODEX_SQLITE_HOME="/var/tmp/cx")
        self.assertEqual(env.get("CODEX_SQLITE_HOME"), "/var/tmp/cx")


class TestStreamingSpawnEnv(unittest.TestCase):
    def test_default_threaded_into_codex_env(self):
        captured = {}

        def fake_popen(*args, **kw):
            captured["env"] = kw.get("env")
            return _FakeProc()

        with mock.patch.object(main.subprocess, "Popen", side_effect=fake_popen):
            gen = main._stream_codex("do it", _TMP, None)
            for _ in gen:  # drain so the spawn actually happens
                pass
        self.assertEqual(captured["env"].get("CODEX_SQLITE_HOME"), DEFAULT)


class TestPtyExportList(unittest.TestCase):
    def test_runtime_env_writer_exports_it(self):
        src = (_HERE / "main.py").read_text()
        body = src.split("def _export_runtime_env", 1)[1]
        keys_block = body.split("keys = [", 1)[1].split("]", 1)[0]
        self.assertIn('"CODEX_SQLITE_HOME"', keys_block)


class TestShellSurfaces(unittest.TestCase):
    """Each shell surface must default the var, never read it back from EFS."""

    def test_run_codex_sh(self):
        src = (_HERE / "run-codex.sh").read_text()
        self.assertRegex(src, r'export CODEX_SQLITE_HOME="\$\{CODEX_SQLITE_HOME:-/tmp/codex-sqlite\}"')
        self.assertIn('mkdir -p "$CODEX_SQLITE_HOME"', src)

    def test_shell_init_sh(self):
        src = (_HERE / "shell-init.sh").read_text()
        self.assertRegex(src, r'export CODEX_SQLITE_HOME="\$\{CODEX_SQLITE_HOME:-/tmp/codex-sqlite\}"')
        self.assertIn('mkdir -p "$CODEX_SQLITE_HOME"', src)

    def test_dockerfile_env(self):
        src = (_HERE / "Dockerfile").read_text()
        self.assertRegex(src, re.compile(r"^\s*CODEX_SQLITE_HOME=/tmp/codex-sqlite", re.M))


if __name__ == "__main__":
    unittest.main()
