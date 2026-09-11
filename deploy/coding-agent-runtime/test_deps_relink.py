"""Two ways the per-lockfile deps cache silently degraded back to 40k-files-on-EFS,
both observed in the 2026-09-11 benchmark run C (11.5 min of installs + repeated
build failures after a clean provision):

1. The CLI ran `npm ci` itself. npm replaces a symlink with a real tree, so from
   that moment the checkout read node_modules over NFS, and every later turn saw
   "a real dir — theirs" and kept it.
2. Nothing ever evicted the per-VM extracted copies. Each is ~1.2 GB against
   4.3 GB of local disk, so the third lockfile bump on a warm VM filled the disk;
   builds then failed on ENOSPC and the CLI "fixed" that by installing onto EFS.
"""
import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
_TMP = tempfile.mkdtemp(prefix="relink-ws-")


def _load(env: dict):
    spec = importlib.util.spec_from_file_location(f"cmain_{len(sys.modules)}", os.path.join(HERE, "main.py"))
    mod = importlib.util.module_from_spec(spec)
    with mock.patch.dict(os.environ, env, clear=False):
        spec.loader.exec_module(mod)
    return mod


def _tree(root: str, *rel: str) -> str:
    os.makedirs(root, exist_ok=True)
    for r in rel:
        path = os.path.join(root, r)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:
            fh.write("x")
    return root


class DepsRelinkTest(unittest.TestCase):
    def setUp(self):
        self.ws = tempfile.mkdtemp(prefix="ws-", dir=_TMP)
        self.local = tempfile.mkdtemp(prefix="local-", dir=_TMP)
        self.m = _load({"WORKSPACE_ROOT": self.ws, "DEPS_LOCAL_ROOT": self.local})
        self.workdir = os.path.join(self.ws, "sessions", "cc-1", "owner-repo")
        os.makedirs(self.workdir)
        for name in ("package.json", "package-lock.json"):
            with open(os.path.join(self.workdir, name), "w") as fh:
                fh.write('{"name":"x"}')
        self.lock_hash = self.m._lock_hash(os.path.join(self.workdir, "package-lock.json"))

    def _provisioned_local(self):
        return _tree(os.path.join(self.local, self.lock_hash), "node_modules/left-pad/index.js")

    def test_real_dir_is_replaced_by_the_link_when_a_copy_exists(self):
        self._provisioned_local()
        nm = os.path.join(self.workdir, "node_modules")
        _tree(nm, "installed-over-nfs/index.js")
        info = self.m._provision_deps(self.workdir)
        self.assertEqual(info["deps"], "relinked")
        self.assertTrue(os.path.islink(nm))
        self.assertEqual(os.path.realpath(nm),
                         os.path.realpath(os.path.join(self.local, self.lock_hash, "node_modules")))
        for _ in range(50):  # the discarded tree is removed on a daemon thread
            if not [n for n in os.listdir(self.workdir) if ".stale." in n]:
                break
            time.sleep(0.05)
        self.assertEqual([n for n in os.listdir(self.workdir) if ".stale." in n], [])

    def test_real_dir_is_left_alone_when_nothing_is_provisioned(self):
        nm = os.path.join(self.workdir, "node_modules")
        _tree(nm, "installed-over-nfs/index.js")
        info = self.m._provision_deps(self.workdir)
        self.assertEqual(info["deps"], "present")
        self.assertFalse(os.path.islink(nm))
        self.assertTrue(os.path.isfile(os.path.join(nm, "installed-over-nfs/index.js")))

    def test_relink_refuses_a_path_outside_the_workspace(self):
        self._provisioned_local()
        outside = tempfile.mkdtemp(prefix="outside-", dir=_TMP)
        nm = _tree(os.path.join(outside, "node_modules"), "pkg/index.js")
        self.assertFalse(self.m._relink_over_real_deps(nm, self.lock_hash, {}))
        self.assertFalse(os.path.islink(nm))

    def test_an_existing_link_for_this_lock_is_untouched(self):
        target = os.path.join(self._provisioned_local(), "node_modules")
        nm = os.path.join(self.workdir, "node_modules")
        os.symlink(target, nm)
        self.assertEqual(self.m._provision_deps(self.workdir)["deps"], "linked")


class DepsLocalSweepTest(unittest.TestCase):
    def setUp(self):
        self.ws = tempfile.mkdtemp(prefix="ws-", dir=_TMP)
        self.local = tempfile.mkdtemp(prefix="local-", dir=_TMP)
        self.m = _load({"WORKSPACE_ROOT": self.ws, "DEPS_LOCAL_ROOT": self.local, "DEPS_LOCAL_KEEP": "2"})

    def _hash_dir(self, name: str, age_s: float = 0.0) -> str:
        path = _tree(os.path.join(self.local, name), "node_modules/pkg/index.js")
        if age_s:
            past = time.time() - age_s
            os.utime(path, (past, past))
        return path

    def test_keeps_the_newest_n_and_evicts_the_rest(self):
        old = self._hash_dir("aaa", age_s=9000)
        mid = self._hash_dir("bbb", age_s=3600)
        new = self._hash_dir("ccc")
        self.m._sweep_deps_local()
        self.assertTrue(os.path.isdir(new) and os.path.isdir(mid))
        self.assertFalse(os.path.isdir(old))

    def test_keep_hash_survives_even_as_the_oldest(self):
        old = self._hash_dir("aaa", age_s=9000)
        self._hash_dir("bbb", age_s=3600)
        self._hash_dir("ccc")
        self.m._sweep_deps_local(keep_hash="aaa")
        self.assertTrue(os.path.isdir(old))

    def test_a_dir_a_live_checkout_links_to_is_never_evicted(self):
        old = self._hash_dir("aaa", age_s=9000)
        self._hash_dir("bbb", age_s=3600)
        self._hash_dir("ccc")
        workdir = os.path.join(self.ws, "sessions", "cc-live", "owner-repo")
        os.makedirs(workdir)
        os.symlink(os.path.join(old, "node_modules"), os.path.join(workdir, "node_modules"))
        self.m._sweep_deps_local()
        self.assertTrue(os.path.isdir(old))

    def test_npm_cache_and_staging_dirs_are_not_candidates(self):
        cache = _tree(os.path.join(self.local, ".npm-cache"), "index/x")
        staging = _tree(os.path.join(self.local, "ddd.tmp.abcd1234"), "node_modules/pkg/index.js")
        for n in ("aaa", "bbb", "ccc"):
            self._hash_dir(n)
        self.m._sweep_deps_local()
        self.assertTrue(os.path.isdir(cache))
        self.assertTrue(os.path.isdir(staging))

    def test_zero_keep_disables_the_sweep(self):
        m = _load({"WORKSPACE_ROOT": self.ws, "DEPS_LOCAL_ROOT": self.local, "DEPS_LOCAL_KEEP": "0"})
        dirs = [self._hash_dir(n, age_s=9000 - i) for i, n in enumerate(("aaa", "bbb", "ccc", "ddd"))]
        m._sweep_deps_local()
        self.assertTrue(all(os.path.isdir(d) for d in dirs))

    def test_missing_local_root_is_survivable(self):
        m = _load({"WORKSPACE_ROOT": self.ws, "DEPS_LOCAL_ROOT": os.path.join(self.local, "nope")})
        m._sweep_deps_local()  # must not raise


class DepsLogShapeTest(unittest.TestCase):
    """The OTEL log exporter drops `extra`, so every deps event has to carry its
    fields in the message body (PR #524). Keep the new events consistent."""

    def test_new_events_log_json_in_the_message(self):
        with open(os.path.join(HERE, "main.py"), encoding="utf-8") as fh:
            src = fh.read()
        for event in ("deps_relinked", "deps_local_evicted"):
            self.assertIn(f'"{event} %s"', src.replace("'", '"'), event)


if __name__ == "__main__":
    unittest.main()
