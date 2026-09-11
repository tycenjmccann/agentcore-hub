#!/usr/bin/env python3
"""node_modules must be PROVISIONED into a checkout, never `npm ci`'d on EFS.

Every workflow ticket's checkout is a fresh clone, so the CLI ran `npm ci` on the
EFS workspace (3-8 min over NFS, zero-byte packages under load) and again for
every subagent worktree — 50-75% of a coding turn's wall clock in the 2026-09-10
operator pilots. main.py now does ONE `npm ci` per lockfile hash, publishes it
as a tarball on EFS (.deps/<hash>.tar), extracts it once per microVM onto local
disk (/tmp/deps/<hash>) and symlinks node_modules to that copy; a post-checkout
hook extends the link to every `git worktree add`. These tests pin:

  1. the cache key is sha256(package-lock.json)[:16];
  2. a checkout gets a symlink hidden from `git status` (a symlink is NOT
     matched by the `node_modules/` gitignore rule);
  3. a worktree inherits the link through the hook, only when its lock matches;
     a foreign hook is never clobbered; a real node_modules dir is left alone;
  4. warm re-runs are idempotent, a lock change re-links, a dangling link heals;
  5. tier order: local copy → tarball extracted locally → tarball unpacked on
     EFS when local disk lacks room → build once (npm faked) and publish;
  6. the kill switch restores the old behaviour.

Hermetic apart from `git` (worktree behaviour is the point) and `tar`; npm is
never invoked (the install step is faked).

Run: python3 -m pytest deploy/coding-agent-runtime/test_deps_provision.py -v
"""

import hashlib
import importlib.util
import os
import re
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

_HERE = Path(__file__).resolve().parent
# The hook check reads `git config core.hooksPath` with the PROCESS env; a dev
# box whose system gitconfig sets one (e.g. a corporate hooks manager) would make
# main.py skip the hook and fail these tests for reasons unrelated to the code.
os.environ["GIT_CONFIG_NOSYSTEM"] = "1"
os.environ["GIT_CONFIG_GLOBAL"] = "/dev/null"
_TMP = tempfile.mkdtemp(prefix="coding-deps-")
LOCAL = os.path.join(_TMP, "local-deps")
LOCK_A = b'{"name":"a","lockfileVersion":3,"packages":{}}\n'
LOCK_B = b'{"name":"b","lockfileVersion":3,"packages":{}}\n'


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


main = _load_main("coding_agent_main_deps", {
    "WORKSPACE_ROOT": _TMP, "TURNS_ROOT": os.path.join(_TMP, "turns"), "DEPS_LOCAL_ROOT": LOCAL,
})

GIT_ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@x",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@x"}


def _git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, env=GIT_ENV, check=True,
                          capture_output=True, text=True).stdout


def _hash(lock: bytes) -> str:
    return hashlib.sha256(lock).hexdigest()[:16]


def _fake_node_modules(parent: str, marker: str = "typescript") -> str:
    nm = os.path.join(parent, "node_modules")
    os.makedirs(os.path.join(nm, marker), exist_ok=True)
    Path(nm, marker, "package.json").write_text('{"name":"%s"}' % marker)
    os.makedirs(os.path.join(nm, ".bin"), exist_ok=True)
    if not os.path.lexists(os.path.join(nm, ".bin", marker)):
        os.symlink(f"../{marker}/package.json", os.path.join(nm, ".bin", marker))
    return nm


def _local_copy(lock: bytes) -> str:
    return _fake_node_modules(os.path.join(LOCAL, _hash(lock)))


def _publish_tar(lock: bytes, marker: str = "vitest") -> str:
    """Put a tarball on the fake EFS exactly as _publish_deps_tar would."""
    os.makedirs(main.DEPS_ROOT, exist_ok=True)
    src = tempfile.mkdtemp(prefix="tarsrc-", dir=_TMP)
    _fake_node_modules(src, marker)
    tar = main._deps_tar_path(_hash(lock))
    subprocess.run(["tar", "-cf", tar, "-C", src, "node_modules"], check=True)
    return tar


def _repo(lock: bytes = LOCK_A) -> str:
    wd = tempfile.mkdtemp(prefix="repo-", dir=_TMP)
    _git(wd, "init", "-q", "-b", "main")
    Path(wd, "package.json").write_text('{"name":"x","version":"1.0.0"}\n')
    Path(wd, "package-lock.json").write_bytes(lock)
    Path(wd, ".gitignore").write_text("node_modules/\n")
    _git(wd, "add", "-A")
    _git(wd, "commit", "-q", "-m", "init")
    return wd


def _reset_caches():
    for d in (LOCAL, main.DEPS_ROOT):
        shutil.rmtree(d, ignore_errors=True)


class TestLockHash(unittest.TestCase):
    def test_is_sha256_first_16_hex(self):
        p = os.path.join(_TMP, "lock.json")
        Path(p).write_bytes(LOCK_A)
        self.assertEqual(main._lock_hash(p), hashlib.sha256(LOCK_A).hexdigest()[:16])

    def test_missing_file_is_none(self):
        self.assertIsNone(main._lock_hash(os.path.join(_TMP, "nope.json")))


class TestLinkAndHook(unittest.TestCase):
    def setUp(self):
        _reset_caches()
        self.nm_a = _local_copy(LOCK_A)
        self.wd = _repo()

    def test_links_local_copy_and_hides_it_from_git(self):
        info = main._provision_deps(self.wd)
        self.assertEqual(info["deps"], "local")
        self.assertEqual(info["lock_hash"], _hash(LOCK_A))
        nm = os.path.join(self.wd, "node_modules")
        self.assertTrue(os.path.islink(nm))
        self.assertEqual(os.path.realpath(nm), os.path.realpath(self.nm_a))
        self.assertTrue(os.path.isfile(os.path.join(nm, "typescript", "package.json")))
        # `node_modules/` (trailing slash) does NOT ignore a symlink — info/exclude must.
        self.assertEqual(_git(self.wd, "status", "--porcelain").strip(), "")
        self.assertIn("node_modules", Path(self.wd, ".git", "info", "exclude").read_text().split())

    def test_hook_installed_and_worktree_inherits_link(self):
        self.assertEqual(main._provision_deps(self.wd)["deps"], "local")
        hook = Path(self.wd, ".git", "hooks", "post-checkout")
        self.assertTrue(hook.exists() and os.access(hook, os.X_OK))
        self.assertIn(main._DEPS_HOOK_MARK, hook.read_text())
        wt = os.path.join(_TMP, "wt-" + os.path.basename(self.wd))
        _git(self.wd, "worktree", "add", "-q", wt, "-b", "wt/unit-1", "main")
        wt_nm = os.path.join(wt, "node_modules")
        self.assertTrue(os.path.islink(wt_nm), "worktree must inherit node_modules via post-checkout")
        self.assertEqual(os.path.realpath(wt_nm), os.path.realpath(self.nm_a))
        self.assertEqual(_git(wt, "status", "--porcelain").strip(), "")
        # A clean worktree removes instantly — the link is not a tree to delete.
        _git(self.wd, "worktree", "remove", wt)
        self.assertFalse(os.path.exists(wt))
        self.assertTrue(os.path.isdir(self.nm_a), "removing the worktree must not touch the target")

    def test_worktree_with_a_different_lock_gets_no_link(self):
        main._provision_deps(self.wd)
        _git(self.wd, "checkout", "-q", "-b", "bump")
        Path(self.wd, "package-lock.json").write_bytes(LOCK_B)
        _git(self.wd, "commit", "-q", "-am", "bump lock")
        _git(self.wd, "checkout", "-q", "main")
        wt = os.path.join(_TMP, "wt-bump-" + os.path.basename(self.wd))
        _git(self.wd, "worktree", "add", "-q", wt, "bump")
        self.assertFalse(os.path.lexists(os.path.join(wt, "node_modules")),
                         "a worktree whose lock differs must not borrow the wrong deps")

    def test_foreign_post_checkout_hook_is_not_clobbered(self):
        hook = Path(self.wd, ".git", "hooks", "post-checkout")
        hook.parent.mkdir(parents=True, exist_ok=True)
        hook.write_text("#!/bin/sh\necho mine\n")
        info = main._provision_deps(self.wd)
        self.assertEqual(info["deps"], "local")
        self.assertFalse(info["hook"])
        self.assertEqual(hook.read_text(), "#!/bin/sh\necho mine\n")

    def test_real_node_modules_dir_is_relinked_when_a_copy_exists(self):
        # Superseded contract: a CLI-run `npm ci` replaces the symlink with a real
        # tree, which silently put the rest of the session back on NFS. When a copy
        # for this lockfile is already provisioned we take the link back (the tree
        # is reconstructible from the lockfile). See test_deps_relink.py.
        os.makedirs(os.path.join(self.wd, "node_modules", "left-by-cli"))
        info = main._provision_deps(self.wd)
        self.assertEqual(info["deps"], "relinked")
        self.assertTrue(os.path.islink(os.path.join(self.wd, "node_modules")))

    def test_warm_rerun_is_idempotent_and_lock_change_relinks(self):
        self.assertEqual(main._provision_deps(self.wd)["deps"], "local")
        self.assertEqual(main._provision_deps(self.wd)["deps"], "linked")
        nm_b = _local_copy(LOCK_B)
        Path(self.wd, "package-lock.json").write_bytes(LOCK_B)
        info = main._provision_deps(self.wd)
        self.assertEqual(info["deps"], "local")
        self.assertEqual(os.path.realpath(os.path.join(self.wd, "node_modules")), os.path.realpath(nm_b))

    def test_dangling_link_heals(self):
        nm = os.path.join(self.wd, "node_modules")
        os.symlink(os.path.join(_TMP, "gone", "node_modules"), nm)
        self.assertFalse(os.path.exists(nm))
        self.assertEqual(main._provision_deps(self.wd)["deps"], "local")
        self.assertTrue(os.path.exists(nm))

    def test_non_npm_project_is_skipped(self):
        wd = tempfile.mkdtemp(prefix="py-", dir=_TMP)
        Path(wd, "requirements.txt").write_text("boto3\n")
        self.assertEqual(main._provision_deps(wd)["deps"], "skipped")
        self.assertFalse(os.path.lexists(os.path.join(wd, "node_modules")))
        self.assertEqual(main._provision_deps(None)["deps"], "skipped")


class TestTarballTiers(unittest.TestCase):
    def setUp(self):
        _reset_caches()
        self.wd = _repo(LOCK_B)

    def test_tarball_is_extracted_locally_once_then_reused(self):
        _publish_tar(LOCK_B)
        info = main._provision_deps(self.wd)
        self.assertEqual(info["deps"], "efs_tar")
        local_nm = os.path.join(LOCAL, _hash(LOCK_B), "node_modules")
        self.assertEqual(os.path.realpath(info["target"]), os.path.realpath(local_nm))
        self.assertTrue(os.path.isfile(os.path.join(self.wd, "node_modules", "vitest", "package.json")))
        self.assertTrue(os.path.islink(os.path.join(local_nm, ".bin", "vitest")), ".bin symlinks survive the tar")
        self.assertEqual([d for d in os.listdir(LOCAL) if ".tmp." in d], [], "staging dir renamed away")
        # Second checkout on the same VM: the local copy, no extraction.
        wd2 = _repo(LOCK_B)
        with mock.patch.object(main, "_extract_deps_tar", wraps=main._extract_deps_tar) as ex:
            self.assertEqual(main._provision_deps(wd2)["deps"], "local")
        ex.assert_not_called()

    def test_no_local_room_unpacks_on_efs_once(self):
        _publish_tar(LOCK_B)
        with mock.patch.object(main, "_local_has_room", return_value=False):
            info = main._provision_deps(self.wd)
        self.assertEqual(info["deps"], "efs")
        efs_nm = os.path.join(main.DEPS_ROOT, _hash(LOCK_B), "node_modules")
        self.assertEqual(os.path.realpath(info["target"]), os.path.realpath(efs_nm))
        self.assertFalse(os.path.exists(os.path.join(LOCAL, _hash(LOCK_B))))
        self.assertFalse(os.path.exists(os.path.join(main.DEPS_ROOT, f"{_hash(LOCK_B)}.lock")), "lock released")
        # Later VM with room prefers a local extract even though the EFS dir exists.
        wd2 = _repo(LOCK_B)
        self.assertEqual(main._provision_deps(wd2)["deps"], "efs_tar")

    def test_corrupt_tarball_leaves_old_behaviour(self):
        os.makedirs(main.DEPS_ROOT, exist_ok=True)
        Path(main._deps_tar_path(_hash(LOCK_B))).write_bytes(b"not a tar")
        info = main._provision_deps(self.wd)
        self.assertEqual(info["deps"], "unavailable")
        self.assertFalse(os.path.lexists(os.path.join(self.wd, "node_modules")))
        self.assertEqual([d for d in os.listdir(LOCAL) if os.path.isdir(os.path.join(LOCAL, d))], [])


class TestFirstBuild(unittest.TestCase):
    def setUp(self):
        _reset_caches()
        self.wd = _repo(LOCK_B)
        self.calls = []

        def fake_npm_ci(workdir, dest, lock_hash):
            self.calls.append(dest)
            _fake_node_modules(dest, "next")
            shutil.copy2(os.path.join(workdir, "package-lock.json"), os.path.join(dest, "package-lock.json"))
            return dest
        self.fake = fake_npm_ci

    def test_builds_once_publishes_tarball_and_links_local_copy(self):
        with mock.patch.object(main, "_npm_ci_into", side_effect=self.fake):
            info = main._provision_deps(self.wd)
        self.assertEqual(info["deps"], "built")
        h = _hash(LOCK_B)
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(self.calls[0].startswith(os.path.join(LOCAL, h)), "build on local disk")
        self.assertTrue(os.path.isfile(main._deps_tar_path(h)), "tarball published for other VMs")
        self.assertTrue(os.path.isfile(os.path.join(main.DEPS_ROOT, f"{h}.package-lock.json")))
        self.assertFalse(os.path.exists(os.path.join(main.DEPS_ROOT, f"{h}.lock")), "lock released")
        self.assertEqual(os.path.realpath(info["target"]), os.path.realpath(os.path.join(LOCAL, h, "node_modules")))
        self.assertTrue(os.path.isfile(os.path.join(self.wd, "node_modules", "next", "package.json")))
        self.assertEqual([d for d in os.listdir(LOCAL) if ".build." in d], [], "build dir renamed into place")
        # A second VM (no local copy) finds the tarball: no build.
        shutil.rmtree(LOCAL)
        wd2 = _repo(LOCK_B)
        with mock.patch.object(main, "_npm_ci_into", side_effect=self.fake) as m:
            info2 = main._provision_deps(wd2)
        self.assertEqual(info2["deps"], "efs_tar")
        m.assert_not_called()
        self.assertTrue(os.path.isfile(os.path.join(wd2, "node_modules", "next", "package.json")))

    def test_npm_ci_uses_its_own_local_cache(self):
        # Prod 2026-09-11: ~/.npm had root-owned files from the image build and
        # npm ci exited 243 ("cache folder contains root-owned files").
        seen = {}

        def fake_run(cmd, **kw):
            seen["cmd"], seen["env"], seen["cwd"] = cmd, kw["env"], kw["cwd"]
            _fake_node_modules(kw["cwd"], "next")
            return subprocess.CompletedProcess(cmd, 0, "", "")
        dest = os.path.join(LOCAL, "h.build.x")
        with mock.patch.object(main.subprocess, "run", side_effect=fake_run):
            out = main._npm_ci_into(self.wd, dest, "h")
        self.assertEqual(out, dest)
        self.assertEqual(seen["cmd"][:2], ["npm", "ci"])
        cache = seen["env"]["npm_config_cache"]
        self.assertEqual(cache, os.path.join(LOCAL, ".npm-cache"))
        self.assertTrue(os.path.isdir(cache), "cache dir created before npm runs")
        self.assertNotEqual(cache, os.path.expanduser("~/.npm"))

    def test_failed_install_leaves_old_behaviour(self):
        with mock.patch.object(main, "_npm_ci_into", return_value=None):
            info = main._provision_deps(self.wd)
        self.assertEqual(info["deps"], "unavailable")
        self.assertEqual(info["reason"], "build_failed")
        self.assertFalse(os.path.lexists(os.path.join(self.wd, "node_modules")))
        self.assertFalse(os.path.exists(main._deps_tar_path(_hash(LOCK_B))))
        self.assertFalse(os.path.exists(os.path.join(main.DEPS_ROOT, f"{_hash(LOCK_B)}.lock")))

    def test_publish_failure_still_uses_the_local_build(self):
        real_run = subprocess.run

        def failing_tar_create(cmd, *a, **k):
            if cmd[:2] == ["tar", "-cf"]:
                return subprocess.CompletedProcess(cmd, 1, "", "tar: No space left on device")
            return real_run(cmd, *a, **k)
        with mock.patch.object(main, "_npm_ci_into", side_effect=self.fake), \
                mock.patch.object(main.subprocess, "run", side_effect=failing_tar_create):
            info = main._provision_deps(self.wd)
        self.assertEqual(info["deps"], "built_unpublished")
        self.assertTrue(os.path.isfile(os.path.join(self.wd, "node_modules", "next", "package.json")))
        self.assertFalse(os.path.exists(main._deps_tar_path(_hash(LOCK_B))))
        self.assertEqual([f for f in os.listdir(main.DEPS_ROOT) if ".tar.tmp." in f], [], "no partial tarball")

    def test_waiter_that_wakes_to_a_tarball_extracts_instead_of_building(self):
        # Simulate the lock holder finishing between our tier check and our lock:
        real_acquire = main._acquire_mirror_lock

        def acquire_then_publish(*a, **k):
            _publish_tar(LOCK_B, marker="eslint")
            return real_acquire(*a, **k)
        with mock.patch.object(main, "_acquire_mirror_lock", side_effect=acquire_then_publish), \
                mock.patch.object(main, "_npm_ci_into", side_effect=self.fake) as m:
            info = main._provision_deps(self.wd)
        self.assertEqual(info["deps"], "efs_tar")
        m.assert_not_called()
        self.assertTrue(os.path.isfile(os.path.join(self.wd, "node_modules", "eslint", "package.json")))

    def test_stale_tarballs_are_swept_on_publish(self):
        old = _publish_tar(LOCK_A)
        old_t = 1_000_000  # 1970 — far past DEPS_TAR_TTL_S
        os.utime(old, (old_t, old_t))
        with mock.patch.object(main, "_npm_ci_into", side_effect=self.fake):
            main._provision_deps(self.wd)
        self.assertFalse(os.path.exists(old), "tarball past TTL swept")
        self.assertTrue(os.path.exists(main._deps_tar_path(_hash(LOCK_B))))


class TestKillSwitch(unittest.TestCase):
    def test_disabled_means_no_link_no_hook(self):
        off = _load_main("coding_agent_main_deps_off", {
            "WORKSPACE_ROOT": _TMP, "TURNS_ROOT": os.path.join(_TMP, "turns"),
            "DEPS_LOCAL_ROOT": LOCAL, "WORKSPACE_DEPS_ENABLED": "0",
        })
        _local_copy(LOCK_A)
        wd = _repo()
        self.assertEqual(off._provision_deps(wd)["deps"], "skipped")
        self.assertFalse(os.path.lexists(os.path.join(wd, "node_modules")))
        self.assertFalse(os.path.exists(os.path.join(wd, ".git", "hooks", "post-checkout")))


class TestDockerfileNpmAsRoot(unittest.TestCase):
    def test_root_stage_npm_calls_isolate_their_cache(self):
        user = None
        for line in (_HERE / "Dockerfile").read_text().splitlines():
            if line.startswith("USER "):
                user = line.split()[1]
            if user == "root" and re.search(r"\bnpx?\s", line) and not line.lstrip().startswith("#"):
                self.assertIn("npm_config_cache=", line, f"root-stage npm without isolated cache: {line.strip()}")


class TestNoImageBake(unittest.TestCase):
    def test_dockerfile_does_not_bake_node_modules(self):
        # AgentCore caps a runtime image at 2 GB; the coding image is ~1.85 GB.
        df = (_HERE / "Dockerfile").read_text()
        self.assertNotIn("/opt/deps", df)
        self.assertNotIn("deps-seed", df)


if __name__ == "__main__":
    unittest.main()
