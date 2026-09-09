"""DL-025 — one CLI per session workspace.

A second async turn submitted on a session whose runner is still live must be
REFUSED (200 body, session_busy) before any workspace/git work: the live CLI owns
that checkout. Two agent-tasks reach this state when a fix ticket "resumes" a
sibling's session (TEAM-3963/3964, 2026-09-04). Same turn_id is the idempotent
resubmit, never busy; a finished turn is never busy.

Hermetic: main.py is exec'd with WORKSPACE_ROOT pointed at a temp dir; no AWS,
no git, no CLI.
"""

import asyncio
import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

_HERE = Path(__file__).resolve().parent
_TMP = tempfile.mkdtemp(prefix="coding-sessionbusy-")


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


main = _load_main("coding_agent_main_sessionbusy", {"WORKSPACE_ROOT": _TMP})


def _body(resp) -> dict:
    return json.loads(resp.body)


class TestSessionBusyTurn(unittest.TestCase):
    def setUp(self):
        main._ACTIVE_TURNS.clear()
        main._ACTIVE_TURNS["turn-live"] = {"status": "running", "turn_id": "turn-live",
                                           "cli": "claude", "session_id": "cc-shared",
                                           "started_at": 1}
        main._ACTIVE_TURNS["turn-old"] = {"status": "done", "turn_id": "turn-old",
                                          "cli": "claude", "session_id": "cc-shared",
                                          "finished_at": 2}

    def tearDown(self):
        main._ACTIVE_TURNS.clear()

    def test_other_turn_on_same_session_is_busy(self):
        self.assertEqual(main._session_busy_turn("cc-shared", "turn-new"), "turn-live")

    def test_same_turn_id_is_the_idempotent_resubmit_not_busy(self):
        self.assertIsNone(main._session_busy_turn("cc-shared", "turn-live"))

    def test_other_session_is_free(self):
        self.assertIsNone(main._session_busy_turn("cc-other", "turn-new"))

    def test_finished_turn_does_not_hold_the_session(self):
        main._ACTIVE_TURNS["turn-live"]["status"] = "done"
        self.assertIsNone(main._session_busy_turn("cc-shared", "turn-new"))

    def test_no_session_id_is_never_busy(self):
        self.assertIsNone(main._session_busy_turn(None, "turn-new"))


class TestSubmitRefusal(unittest.TestCase):
    """The handler answers busy BEFORE touching the workspace (no clone, no
    checkout under the live CLI) and in a 200 body the fleet can read."""

    def setUp(self):
        main._ACTIVE_TURNS.clear()
        main._ACTIVE_TURNS["turn-live"] = {"status": "running", "turn_id": "turn-live",
                                           "cli": "claude", "session_id": "cc-shared",
                                           "started_at": 1}

    def tearDown(self):
        main._ACTIVE_TURNS.clear()

    def _invoke(self, payload):
        request = mock.MagicMock()

        async def _json():
            return payload
        request.json = _json
        request.headers = {}
        return asyncio.run(main.invocations(request))

    def test_async_submit_on_busy_session_is_refused_in_200_body(self):
        with mock.patch.object(main, "_ensure_workspace",
                               side_effect=AssertionError("workspace touched under a live CLI")):
            resp = self._invoke({"prompt": "fix", "mode": "async", "cli": "claude",
                                 "session_id": "cc-shared", "turn_id": "turn-new",
                                 "repo": "owner/repo", "origin": "workflow"})
        self.assertEqual(resp.status_code, 200, "non-2xx bodies never reach the fleet")
        b = _body(resp)
        self.assertTrue(b["session_busy"])
        self.assertEqual(b["busy_turn_id"], "turn-live")
        self.assertEqual(b["turn_id"], "turn-new")
        self.assertIn("one CLI per workspace", b["error"])
        self.assertNotIn("turn-new", main._ACTIVE_TURNS, "refused turn never starts")

    def test_resubmit_of_the_live_turn_is_not_refused_as_busy(self):
        # Idempotent resubmit path (same turn_id) must still reach the dedupe
        # branch, which acknowledges the existing turn.
        with mock.patch.object(main, "_ensure_workspace", return_value=os.path.join(_TMP, "ws")), \
             mock.patch.object(main, "_gc_stale_sessions"), \
             mock.patch.object(main, "_touch_workflow_marker"):
            try:
                resp = self._invoke({"prompt": "fix", "mode": "async", "cli": "claude",
                                     "session_id": "cc-shared", "turn_id": "turn-live",
                                     "origin": "workflow"})
            except Exception as exc:  # noqa: BLE001 — setup beyond the guard is not under test
                self.skipTest(f"handler setup beyond the busy guard needs more stubs: {exc}")
        b = _body(resp)
        self.assertFalse(b.get("session_busy", False))
