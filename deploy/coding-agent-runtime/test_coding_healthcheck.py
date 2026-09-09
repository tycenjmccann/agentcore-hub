"""Post-promote healthcheck (the pipeline's cold-start smoke).

The image swap's READY status is control-plane only. A coding image whose CLI
install broke presents as "the coding turn vanished" mid-workflow, never as a
failed deploy — so the pipeline invokes {"healthcheck": true} right after the
swap and rolls back on a non-ok body.

Hermetic: main.py is exec'd with WORKSPACE_ROOT in a temp dir; subprocess is
stubbed, no CLI and no AWS.
"""

import asyncio
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
_TMP = tempfile.mkdtemp(prefix="coding-healthcheck-")


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


main = _load_main("coding_agent_main_healthcheck", {"WORKSPACE_ROOT": _TMP})


def _ok_proc(argv, **_kw):
    return subprocess.CompletedProcess(argv, 0, stdout=f"{argv[0]} 1.2.3\n", stderr="")


class TestHealthcheck(unittest.TestCase):
    def test_all_clis_up_and_workspace_writable_is_ok(self):
        with mock.patch.object(main.subprocess, "run", side_effect=_ok_proc):
            result = main._healthcheck()
        self.assertTrue(result["ok"])
        self.assertEqual(result["marker"], main.HEALTHCHECK_OK)
        self.assertEqual(set(result["clis"]), {"claude", "codex", "kiro"})
        self.assertTrue(all(c["ok"] for c in result["clis"].values()))
        self.assertTrue(result["workspace_writable"])

    def test_one_broken_cli_fails_the_whole_check(self):
        def _one_bad(argv, **kw):
            if "codex" in argv[0]:
                return subprocess.CompletedProcess(argv, 127, stdout="", stderr="not found")
            return _ok_proc(argv, **kw)

        with mock.patch.object(main.subprocess, "run", side_effect=_one_bad):
            result = main._healthcheck()
        self.assertFalse(result["ok"])
        self.assertEqual(result["marker"], main.HEALTHCHECK_FAIL)
        self.assertFalse(result["clis"]["codex"]["ok"])
        self.assertTrue(result["clis"]["claude"]["ok"])

    def test_a_hung_cli_is_a_failure_not_an_exception(self):
        def _hang(argv, **_kw):
            raise subprocess.TimeoutExpired(argv, 20)

        with mock.patch.object(main.subprocess, "run", side_effect=_hang):
            result = main._healthcheck()
        self.assertFalse(result["ok"])
        self.assertIn("TimeoutExpired", result["clis"]["claude"]["error"])

    def test_unwritable_workspace_fails_even_with_healthy_clis(self):
        with mock.patch.object(main.subprocess, "run", side_effect=_ok_proc), \
             mock.patch.object(main, "_ensure_sessions_writable", return_value=False):
            result = main._healthcheck()
        self.assertFalse(result["ok"])
        self.assertEqual(result["marker"], main.HEALTHCHECK_FAIL)

    def test_route_returns_the_healthcheck_before_any_workspace_work(self):
        req = mock.MagicMock()

        async def _json():
            return {"healthcheck": True}

        req.json = _json
        with mock.patch.object(main.subprocess, "run", side_effect=_ok_proc), \
             mock.patch.object(main, "_ensure_workspace",
                               side_effect=AssertionError("must not clone")):
            resp = asyncio.run(main.invocations(req))
        body = json.loads(resp.body)
        self.assertTrue(body["ok"])
        self.assertEqual(body["marker"], main.HEALTHCHECK_OK)


if __name__ == "__main__":
    unittest.main()
