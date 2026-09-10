"""Setup-failure answers must REACH the caller (TEAM-3790/3799 fake outage).

A pre-CLI workspace failure (clone 404, bad repo field) used to be a bare
HTTP 500/400. AgentCore drops the body of non-2xx runtime responses, so the
fleet only ever saw "Received error (500)" — indistinguishable from a VM
death — and looped resubmits. For async submits the reason now travels as a
200 body flagged setup_failed AND is written to <turn_dir>/done.json under the
caller's turn_id, so the fleet's wait probe resolves it too (DL-026).
Synchronous callers keep the HTTP status.

Hermetic: main.py is exec'd with WORKSPACE_ROOT pointed at a temp dir; no AWS,
no git, no CLI.
"""

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
_TMP = tempfile.mkdtemp(prefix="coding-setupfail-")


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


main = _load_main("coding_agent_main_setupfail",
                  {"WORKSPACE_ROOT": _TMP, "TURNS_ROOT": os.path.join(_TMP, "turns")})

CLONE_404 = ("git clone failed: remote: Repository not found.\n"
             "fatal: repository 'https://github.com/tycenj/agentcore-hub.git/' not found")


def _body(resp) -> dict:
    return json.loads(resp.body)


class TestSyncCallersKeepHttpStatus(unittest.TestCase):
    def test_sync_setup_failure_keeps_500_and_carries_reason(self):
        resp = main._setup_failure_response({"prompt": "x"}, "claude", "sess-1", CLONE_404, 500)
        self.assertEqual(resp.status_code, 500)
        self.assertEqual(_body(resp)["error"], CLONE_404)
        self.assertTrue(_body(resp)["setup_failed"])

    def test_sync_bad_repo_field_keeps_400(self):
        resp = main._setup_failure_response({"prompt": "x"}, "codex", None, "repo 'tycenj' is not clonable", 400)
        self.assertEqual(resp.status_code, 400)

    def test_sync_failure_writes_no_turn_record(self):
        main._setup_failure_response({"prompt": "x", "turn_id": "turn-sync"}, "claude", "sess-sync", CLONE_404, 500)
        self.assertIsNone(main._turn_read_done(main._turn_dir("turn-sync")))
        self.assertNotIn("turn-sync", main._ACTIVE_TURNS)


class TestAsyncSubmitsGetA200Body(unittest.TestCase):
    def test_async_setup_failure_is_200_with_setup_failed_flag(self):
        payload = {"prompt": "x", "mode": "async", "turn_id": "turn-a1"}
        resp = main._setup_failure_response(payload, "codex", "sess-a1", CLONE_404, 500)
        self.assertEqual(resp.status_code, 200, "non-2xx bodies never reach the fleet")
        b = _body(resp)
        self.assertEqual(b["error"], CLONE_404)
        self.assertTrue(b["setup_failed"])
        self.assertEqual(b["turn_id"], "turn-a1")
        self.assertEqual(b["cli"], "codex")

    def test_async_setup_failure_is_recorded_as_terminal_done(self):
        payload = {"prompt": "x", "mode": "async", "turn_id": "turn-a2"}
        main._setup_failure_response(payload, "claude", "sess-a2", CLONE_404, 500)
        with open(os.path.join(main._turn_dir("turn-a2"), "done.json")) as f:
            rec = json.load(f)
        self.assertEqual(rec["status"], "done")
        self.assertEqual(rec["error"], CLONE_404)
        self.assertTrue(rec["setup_failed"])

    def test_async_setup_failure_releases_the_session_claim(self):
        """A registered turn whose setup failed is DONE, not running — otherwise
        the next turn on that session answers session_busy forever."""
        payload = {"prompt": "x", "mode": "async", "turn_id": "turn-a5"}
        main._register_turn("turn-a5", "claude", "sess-a5", 1500)
        self.assertEqual(main._session_busy_turn("sess-a5", "other"), "turn-a5")
        main._setup_failure_response(payload, "claude", "sess-a5", CLONE_404, 500)
        self.assertIsNone(main._session_busy_turn("sess-a5", "other"))

    def test_lookup_after_lost_response_resolves_to_done_error_not_unknown(self):
        # The 200 body can still be lost client-side; the turn record must then
        # say done+error, never 'unknown' (which is what fed the VM-death loop).
        payload = {"prompt": "x", "mode": "async", "turn_id": "turn-a3"}
        main._setup_failure_response(payload, "kiro", "sess-a3", CLONE_404, 500)
        status = main._poll_turn("sess-a3", "turn-a3")
        self.assertEqual(status["status"], "done")
        self.assertEqual(status["error"], CLONE_404)
        self.assertTrue(status.get("setup_failed"))

    def test_async_without_turn_id_still_returns_200_body(self):
        payload = {"prompt": "x", "mode": "async"}
        resp = main._setup_failure_response(payload, "claude", "sess-a4", CLONE_404, 500)
        self.assertEqual(resp.status_code, 200)
        self.assertNotIn("turn_id", _body(resp))


class TestVerdictSurvivesAnUnwritableDisk(unittest.TestCase):
    """Codex #346 P1 — a 200 setup_failed body asserts a terminal verdict the
    caller can still find after a lost response. On EFS that needed a 503 escape
    hatch, because an unwritable journal meant no record existed at all. The
    record now lives on the VM's own /tmp AND in _ACTIVE_TURNS, so even a failed
    write leaves the in-memory verdict the wait probe and the poll shim read —
    hence a plain 200, and no EFS in this path at all (DL-026)."""

    def test_unwritable_turn_dir_still_returns_200_with_setup_failed(self):
        payload = {"prompt": "x", "mode": "async", "turn_id": "turn-nj"}
        with mock.patch.object(main, "_turn_write_json", return_value=False):
            resp = main._setup_failure_response(payload, "claude", "sess-nj", CLONE_404, 500)
        self.assertEqual(resp.status_code, 200)
        b = _body(resp)
        self.assertTrue(b["setup_failed"])
        self.assertIn("Repository not found", b["error"], "the setup reason must survive")

    def test_unwritable_turn_dir_still_leaves_a_terminal_in_memory_verdict(self):
        payload = {"prompt": "x", "mode": "async", "turn_id": "turn-nj3"}
        with mock.patch.object(main, "_turn_write_json", return_value=False):
            main._setup_failure_response(payload, "claude", "sess-nj3", CLONE_404, 500)
        status = main._poll_turn("sess-nj3", "turn-nj3")
        self.assertEqual(status["status"], "done")
        self.assertEqual(status["error"], CLONE_404)

    def test_writable_turn_dir_still_returns_200(self):
        payload = {"prompt": "x", "mode": "async", "turn_id": "turn-nj2"}
        resp = main._setup_failure_response(payload, "claude", "sess-nj2", CLONE_404, 500)
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(_body(resp)["setup_failed"])

    def test_sync_callers_unaffected_by_disk_state(self):
        with mock.patch.object(main, "_turn_write_json", return_value=False):
            resp = main._setup_failure_response({"prompt": "x"}, "claude", "s", CLONE_404, 500)
        self.assertEqual(resp.status_code, 500)
        self.assertTrue(_body(resp)["setup_failed"])


if __name__ == "__main__":
    unittest.main()
