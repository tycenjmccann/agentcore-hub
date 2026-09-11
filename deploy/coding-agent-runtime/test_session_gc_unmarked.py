#!/usr/bin/env python3
"""TEAM-4418 — GC a second candidate class in {WORKSPACE_ROOT}/sessions/*: dirs
with NO `.workflow-session` origin marker whose last activity is older than
SESSION_TTL_DAYS. Most session dirs never got the marker (older workflow
sessions, aborted setups, sessions created before the marker existed), so the
marker-only sweep in _gc_stale_sessions left the EFS volume growing unbounded
(~640 dirs / ~330 GB). Human Cloud Code sessions must still never be
auto-deleted, and there is no positive human marker anywhere in this system —
so the class defaults to SESSION_GC_UNMARKED=dry-run (log candidates, delete
nothing) and only deletes in `enforce`. These tests pin:

  1. a stale unmarked dir is a candidate, a fresh one is not;
  2. last-activity = max mtime of the dir, its known marker files, and its
     TOP-LEVEL entries only — never a recursive walk (EFS walks are too slow
     for a turn path) — a deep nested recent write does not rescue a dir;
  3. a dir named in the (conservative, over-matching) human-session map, or
     carrying a laptop port/pull artifact, is never a candidate;
  4. an active-turn dir is never a candidate, nor are the special roots
     (.mirrors/.deps/.claude-data/.codex/.kiro-data) or a symlink;
  5. dry-run deletes nothing and logs one candidates summary; enforce deletes
     exactly the candidates (respecting the delete cap); off skips the class;
     an invalid mode falls back to dry-run;
  6. the marker class's own behaviour is unchanged in every mode.

Hermetic: main.py is exec'd per-mode with WORKSPACE_ROOT pointed at a temp dir;
no AWS, no git, no CLI.

Run: python3 -m pytest deploy/coding-agent-runtime/test_session_gc_unmarked.py -v
"""

import importlib.util
import json
import os
import shutil
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest import mock

_HERE = Path(__file__).resolve().parent

DAY = 86400


def _load_main(module_name: str, workspace_root: str, env_overrides: dict | None = None):
    if str(_HERE) not in sys.path:
        sys.path.insert(0, str(_HERE))
    if "uvicorn" not in sys.modules:
        try:
            import uvicorn  # noqa: F401
        except ImportError:
            sys.modules["uvicorn"] = types.ModuleType("uvicorn")
    env = {"WORKSPACE_ROOT": workspace_root, "TURNS_ROOT": os.path.join(workspace_root, "turns"),
           **(env_overrides or {})}
    ctx = mock.patch.dict(os.environ, env, clear=False)
    ctx.start()
    try:
        spec = importlib.util.spec_from_file_location(module_name, _HERE / "main.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        return module
    finally:
        ctx.stop()


def _touch(path: str, age_days: float = 0) -> None:
    """Create/touch a file with mtime `age_days` in the past."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).touch()
    ts = time.time() - age_days * DAY
    os.utime(path, (ts, ts))


def _mkdir(root: str, name: str, age_days: float, marker: bool = False,
           extra_files: tuple = ()) -> str:
    """Build a session dir under `root` whose own mtime AND every file inside
    it are `age_days` old (so it is unambiguously stale unless something in
    `extra_files` is fresher)."""
    d = os.path.join(root, name)
    os.makedirs(d, exist_ok=True)
    if marker:
        _touch(os.path.join(d, ".workflow-session"), age_days)
    for f in extra_files:
        _touch(os.path.join(d, f), age_days)
    ts = time.time() - age_days * DAY
    os.utime(d, (ts, ts))
    return d


class GcUnmarkedTestBase(unittest.TestCase):
    """Each test gets a fresh WORKSPACE_ROOT and a freshly-exec'd main module,
    so _GC_MARKER's 6h-per-mount interval guard and module-level env constants
    never leak between tests."""

    ENV: dict = {}

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="coding-gc-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.main = _load_main(f"coding_agent_main_gc_{id(self)}", self.tmp, self.ENV)
        self.sessions_root = os.path.join(self.tmp, "sessions")
        os.makedirs(self.sessions_root, exist_ok=True)

    def sweep(self):
        self.main._gc_stale_sessions()


class TestCandidateScan(GcUnmarkedTestBase):
    """Exercises _unmarked_gc_candidates directly — the pure, no-delete scan."""

    def _candidates(self, live=(), human=()):
        cutoff = self.main.time.time() - self.main.SESSION_TTL_DAYS * DAY
        out = self.main._unmarked_gc_candidates(self.sessions_root, cutoff, set(live), set(human))
        return [os.path.basename(p) for p, _age in out]

    def test_stale_unmarked_dir_is_a_candidate(self):
        _mkdir(self.sessions_root, "stale", 20)
        self.assertEqual(self._candidates(), ["stale"])

    def test_fresh_unmarked_dir_is_not(self):
        _mkdir(self.sessions_root, "fresh", 1)
        self.assertEqual(self._candidates(), [])

    def test_recent_top_level_entry_keeps_a_stale_dir(self):
        d = _mkdir(self.sessions_root, "mixed", 20)
        _touch(os.path.join(d, "workspace"), age_days=1)
        os.utime(d, (self.main.time.time() - 20 * DAY,) * 2)  # dir itself still old
        self.assertEqual(self._candidates(), [], "a fresh top-level entry is activity")

    def test_deep_nested_recent_file_does_not_rescue(self):
        d = _mkdir(self.sessions_root, "deep", 20)
        nested = os.path.join(d, "workspace", "src")
        _touch(os.path.join(nested, "recent.txt"), age_days=0)
        os.utime(os.path.join(d, "workspace"), (self.main.time.time() - 20 * DAY,) * 2)
        os.utime(d, (self.main.time.time() - 20 * DAY,) * 2)
        with mock.patch.object(self.main.os, "walk", side_effect=AssertionError("must not walk")):
            self.assertEqual(self._candidates(), ["deep"], "only the top level counts as activity")

    def test_human_mapped_dir_is_never_a_candidate(self):
        _mkdir(self.sessions_root, "cc-abc123", 20)
        self.assertEqual(self._candidates(human=["cc-abc123"]), [])

    def test_laptop_port_artifacts_spare_a_dir(self):
        _mkdir(self.sessions_root, "ported", 20, extra_files=(".bundle-applied",))
        self.assertEqual(self._candidates(), [])

    def test_active_turn_dir_is_never_a_candidate(self):
        _mkdir(self.sessions_root, "busy", 20)
        self.assertEqual(self._candidates(live=["busy"]), [])

    def test_marked_dir_is_not_an_unmarked_candidate(self):
        _mkdir(self.sessions_root, "marked", 20, marker=True)
        self.assertEqual(self._candidates(), [], "marker class owns this dir")

    def test_special_roots_are_never_scanned_even_if_old(self):
        for special in (".mirrors", ".deps", ".claude-data", ".codex", ".kiro-data"):
            d = os.path.join(self.sessions_root, special)
            os.makedirs(d, exist_ok=True)
            os.utime(d, (self.main.time.time() - 20 * DAY,) * 2)
        self.assertEqual(self._candidates(), [])

    def test_symlink_is_never_a_candidate(self):
        real = _mkdir(self.tmp, "elsewhere", 20)
        os.symlink(real, os.path.join(self.sessions_root, "link"))
        self.assertEqual(self._candidates(), [])

    def test_dotdir_is_never_a_candidate(self):
        _mkdir(self.sessions_root, ".hidden", 20)
        self.assertEqual(self._candidates(), [])

    def test_oldest_first_ordering(self):
        _mkdir(self.sessions_root, "younger", 15)
        _mkdir(self.sessions_root, "older", 30)
        self.assertEqual(self._candidates(), ["older", "younger"])


class TestSweepDryRun(GcUnmarkedTestBase):
    ENV = {"SESSION_GC_UNMARKED": "dry-run"}

    def test_dry_run_deletes_nothing_and_logs_the_count(self):
        _mkdir(self.sessions_root, "stale-a", 20)
        _mkdir(self.sessions_root, "stale-b", 25)
        _mkdir(self.sessions_root, "fresh", 1)
        with self.assertLogs("coding-agent-runtime", level="INFO") as cm:
            self.sweep()
        self.assertTrue(os.path.isdir(os.path.join(self.sessions_root, "stale-a")))
        self.assertTrue(os.path.isdir(os.path.join(self.sessions_root, "stale-b")))
        msgs = [r.getMessage() for r in cm.records if "session_gc_unmarked_candidates" in r.getMessage()]
        self.assertEqual(len(msgs), 1)
        payload = json.loads(msgs[0].split(" ", 1)[1])
        self.assertEqual(payload["count"], 2)
        self.assertEqual(payload["mode"], "dry-run")
        self.assertIn("stale-b", payload["examples"])
        self.assertIn("stale-a", payload["examples"])
        self.assertGreaterEqual(payload["oldest_age_days"], 24.9)

    def test_marker_class_removed_in_dry_run(self):
        _mkdir(self.sessions_root, "old-marked", 20, marker=True)
        self.sweep()
        self.assertFalse(os.path.exists(os.path.join(self.sessions_root, "old-marked")),
                         "marker-class GC behaviour must be unchanged in dry-run")

    def test_no_candidates_logs_nothing_and_deletes_nothing(self):
        _mkdir(self.sessions_root, "fresh", 1)
        with mock.patch.object(self.main.logger, "info") as info:
            self.sweep()
        for call in info.call_args_list:
            self.assertNotIn("session_gc_unmarked", call.args[0] if call.args else "")
        self.assertTrue(os.path.isdir(os.path.join(self.sessions_root, "fresh")))

    def test_invalid_mode_falls_back_to_dry_run(self):
        invalid = _load_main(f"coding_agent_main_gc_invalid_{id(self)}", self.tmp,
                             {"SESSION_GC_UNMARKED": "delete-everything"})
        self.assertEqual(invalid.SESSION_GC_UNMARKED, "dry-run")


class TestSweepEnforce(GcUnmarkedTestBase):
    ENV = {"SESSION_GC_UNMARKED": "enforce"}

    def test_enforce_deletes_exactly_the_candidates(self):
        _mkdir(self.sessions_root, "stale", 20)
        _mkdir(self.sessions_root, "fresh", 1)
        _mkdir(self.sessions_root, "human", 20)
        _mkdir(self.sessions_root, "active", 20)
        _mkdir(self.sessions_root, "marked-fresh", 1, marker=True)
        self.main._load_session_map = lambda: {"human": {}}
        self.main._session_dir = lambda sid: os.path.join(self.sessions_root, sid) if sid else \
            os.path.join(self.sessions_root, "default")
        self.main._ACTIVE_TURNS["t1"] = {"session_id": "active"}
        with self.assertLogs("coding-agent-runtime", level="INFO") as cm:
            self.sweep()
        self.assertFalse(os.path.exists(os.path.join(self.sessions_root, "stale")))
        for keep in ("fresh", "human", "active", "marked-fresh"):
            self.assertTrue(os.path.isdir(os.path.join(self.sessions_root, keep)), keep)
        msgs = [r.getMessage() for r in cm.records if "session_gc_unmarked_removed" in r.getMessage()]
        self.assertEqual(len(msgs), 1)
        payload = json.loads(msgs[0].split(" ", 1)[1])
        self.assertEqual(payload["removed"], 1)
        self.assertFalse(payload["capped"])

    def test_marker_class_unchanged_under_enforce(self):
        _mkdir(self.sessions_root, "old-marked", 20, marker=True)
        _mkdir(self.sessions_root, "fresh-marked", 1, marker=True)
        self.sweep()
        self.assertFalse(os.path.exists(os.path.join(self.sessions_root, "old-marked")))
        self.assertTrue(os.path.isdir(os.path.join(self.sessions_root, "fresh-marked")))

    def test_special_roots_are_untouched_by_enforce(self):
        specials = {}
        for special in (".mirrors", ".deps", ".claude-data", ".codex", ".kiro-data"):
            d = os.path.join(self.sessions_root, special)
            os.makedirs(os.path.join(d, "payload"), exist_ok=True)
            os.utime(d, (self.main.time.time() - 20 * DAY,) * 2)
            specials[special] = d
        self.sweep()
        for special, d in specials.items():
            self.assertTrue(os.path.isdir(d), special)

    def test_symlink_is_untouched_by_enforce(self):
        real = _mkdir(self.tmp, "elsewhere", 20)
        link = os.path.join(self.sessions_root, "link")
        os.symlink(real, link)
        self.sweep()
        self.assertTrue(os.path.islink(link))
        self.assertTrue(os.path.isdir(real))

    def test_enforce_respects_the_delete_cap(self):
        capped = _load_main(f"coding_agent_main_gc_cap_{id(self)}", self.tmp,
                            {"SESSION_GC_UNMARKED": "enforce", "SESSION_GC_MAX_DELETES": "2"})
        sroot = os.path.join(self.tmp, "sessions")
        os.makedirs(sroot, exist_ok=True)
        for i, age in enumerate((30, 25, 20)):
            _mkdir(sroot, f"stale-{i}", age)
        capped._gc_stale_sessions()
        remaining = sorted(os.listdir(sroot))
        self.assertEqual(len(remaining), 1, "oldest two of three deleted, one left")


class TestSweepOff(GcUnmarkedTestBase):
    ENV = {"SESSION_GC_UNMARKED": "off"}

    def test_off_skips_the_class_entirely(self):
        _mkdir(self.sessions_root, "stale", 20)
        self.sweep()
        self.assertTrue(os.path.isdir(os.path.join(self.sessions_root, "stale")))

    def test_off_still_runs_marker_class(self):
        _mkdir(self.sessions_root, "old-marked", 20, marker=True)
        self.sweep()
        self.assertFalse(os.path.exists(os.path.join(self.sessions_root, "old-marked")))


if __name__ == "__main__":
    unittest.main()
