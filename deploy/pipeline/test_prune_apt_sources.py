"""Regression tests for deploy/pipeline/prune-apt-sources.sh (TEAM-4311).

`npx playwright install --with-deps chromium` shells out to
`apt-get update && apt-get install -y --no-install-recommends <libs>`, so ANY broken
third-party apt source in the CodeBuild image fails the whole INSTALL phase with exit
100 -- which is exactly how a dl.google.com "Hash Sum mismatch" outage killed two
deploy builds. The prune script drops the repos this build does not use.

These tests pin: the four third-party sources go, the Ubuntu ones stay (both the
22.04 `.list` and a 24.04 deb822 `.sources`), an empty/missing dir is a no-op,
/etc/apt/sources.list is never a removal target, and buildspec-ci.yml actually runs
the prune BEFORE playwright without softening the playwright line.

Hermetic: APT_SOURCES_DIR points at tmp_path, so no system apt config is touched.

TEAM-4385: the two sudo-branch behavioural tests skip under root (CodeBuild) -- root
ignores directory mode bits, so the "not writable" branch cannot be exercised there;
a static test keeps the guard covered in CodeBuild instead. See requires_non_root below.
"""
import os
import re
import subprocess

import pytest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "deploy" / "pipeline" / "prune-apt-sources.sh"
BUILDSPEC = REPO / "deploy" / "pipeline" / "buildspec-ci.yml"

# CodeBuild runs the pipeline's pytest gate as root, and root's writes ignore
# directory mode bits (CAP_DAC_OVERRIDE): chmod 0o555 cannot make a dir unwritable
# for uid 0, so `[ ! -w "$dir" ]` is FALSE and the two tests below cannot exercise
# the sudo / no-sudo branch at all -- they were the "2 failed" the buildspec's
# missing `set -e` was swallowing (TEAM-4385). GitHub's hosted runners and dev
# machines are non-root, so the branch is still really exercised there; as root the
# static guard test below keeps the sudo path from going entirely unchecked.
requires_non_root = pytest.mark.skipif(
    os.geteuid() == 0,
    reason="root ignores directory mode bits, so the not-writable branch cannot be "
           "exercised as root (CodeBuild runs as root; GH runners / dev boxes do not)",
)

# Verbatim-shaped sources from aws/aws-codebuild-docker-images ubuntu/standard/7.0.
THIRD_PARTY = {
    "google-chrome.list":
        "deb [arch=amd64] https://dl.google.com/linux/chrome-stable/deb/ stable main\n",
    "mozillateam-ubuntu-ppa-jammy.list":
        "deb https://ppa.launchpadcontent.net/mozillateam/ppa/ubuntu/ jammy main\n",
    "corretto.list":
        "deb https://apt.corretto.aws stable main\n",
    "github-cli.list":
        "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg]"
        " https://cli.github.com/packages stable main\n",
}

UBUNTU = {
    # deb822, as a 24.04 image would ship it -- must survive an image bump.
    "ubuntu.sources": (
        "Types: deb\n"
        "URIs: http://archive.ubuntu.com/ubuntu/\n"
        "Suites: noble noble-updates\n"
        "Components: main universe\n"
    ),
    "ubuntu-security.list": "deb http://security.ubuntu.com/ubuntu jammy-security main\n",
}


def run(sources_dir):
    """Run the script with APT_SOURCES_DIR pointed at a scratch dir."""
    env = dict(os.environ, APT_SOURCES_DIR=str(sources_dir))
    return subprocess.run(
        ["bash", str(SCRIPT)], capture_output=True, text=True, env=env, cwd=str(REPO)
    )


def _install_phase(text):
    """buildspec-ci.yml's `install:` phase as raw text (requirements-test.txt has no PyYAML)."""
    start = text.index("\n  install:")
    return text[start:text.index("\n  pre_build:", start)]


# ── (a) prunes third-party, keeps Ubuntu ─────────────────────────────────────

def test_prunes_third_party_and_keeps_ubuntu(tmp_path):
    d = tmp_path / "sources.list.d"
    d.mkdir()
    for name, body in {**THIRD_PARTY, **UBUNTU}.items():
        (d / name).write_text(body, encoding="utf-8")

    r = run(d)

    assert r.returncode == 0, r.stderr
    for name in THIRD_PARTY:
        assert not (d / name).exists(), f"{name} must be pruned"
        assert name in r.stdout, f"stdout must name the pruned file {name}"
    for name, body in UBUNTU.items():
        assert (d / name).read_text(encoding="utf-8") == body, f"{name} must survive untouched"


def test_ppa_is_pruned_despite_ubuntu_in_its_path(tmp_path):
    """ppa.launchpadcontent.net/.../ubuntu/ contains "ubuntu" but is not *.ubuntu.com."""
    d = tmp_path / "sources.list.d"
    d.mkdir()
    name = "mozillateam-ubuntu-ppa-jammy.list"
    (d / name).write_text(THIRD_PARTY[name], encoding="utf-8")

    r = run(d)

    assert r.returncode == 0, r.stderr
    assert list(d.iterdir()) == []
    assert "ppa.launchpadcontent.net" in r.stdout   # the deb line is echoed


# ── (b) empty / missing dir is a no-op ───────────────────────────────────────

def test_empty_dir_is_a_noop(tmp_path):
    d = tmp_path / "sources.list.d"
    d.mkdir()
    assert run(d).returncode == 0


def test_missing_dir_is_a_noop(tmp_path):
    assert run(tmp_path / "does-not-exist").returncode == 0


def test_never_removes_etc_apt_sources_list():
    code = "\n".join(
        l for l in SCRIPT.read_text(encoding="utf-8").splitlines()
        if not l.lstrip().startswith("#")
    )
    assert "/etc/apt/sources.list.d" in code                       # the default dir
    assert not re.search(r"rm\b[^\n]*/etc/apt/sources\.list(?!\.d)", code)


# ── (c) buildspec ordering ───────────────────────────────────────────────────

def test_buildspec_prunes_before_playwright_install():
    install = _install_phase(BUILDSPEC.read_text(encoding="utf-8"))
    prune = install.find("bash deploy/pipeline/prune-apt-sources.sh")
    playwright = install.find("npx playwright install --with-deps chromium")
    assert prune != -1, "install phase must run deploy/pipeline/prune-apt-sources.sh"
    assert playwright != -1, "install phase must still install the browser"
    assert prune < playwright, "the prune must run BEFORE playwright install --with-deps"


def test_prune_command_is_a_quoted_yaml_scalar():
    """buildspec-ci.yml's header: an unquoted command makes CodeBuild reject the array."""
    install = _install_phase(BUILDSPEC.read_text(encoding="utf-8"))
    line = next(l for l in install.splitlines() if "prune-apt-sources.sh" in l)
    assert line.strip() == '- "bash deploy/pipeline/prune-apt-sources.sh"', line


def test_playwright_install_is_not_softened():
    """A missing browser must still fail the build -- no `|| true` on that line."""
    for line in BUILDSPEC.read_text(encoding="utf-8").splitlines():
        if "playwright install" in line:
            assert "|| true" not in line, line


def test_script_guards_unwritable_dir_before_removing():
    """Root-safe half of the sudo coverage: the two behavioural tests below skip as
    root (CodeBuild), so pin the guard's SHAPE from the source text -- an unwritable
    dir must route rm through sudo, and a missing sudo must exit clean."""
    code = "\n".join(
        l for l in SCRIPT.read_text(encoding="utf-8").splitlines()
        if not l.lstrip().startswith("#")
    )
    assert '[ ! -w "$dir" ]' in code
    assert "command -v sudo" in code
    assert 'SUDO="sudo"' in code
    assert "$SUDO rm -f" in code


@requires_non_root
def test_uses_sudo_when_the_directory_is_not_writable(tmp_path):
    """GitHub's hosted runners are non-root and bake in the same google-chrome
    source, so this script serves that caller too — but `rm` there needs sudo,
    and under `set -e` a permission-denied rm would abort the job it is meant to
    protect. A read-only dir must route through sudo (stubbed here), never a bare
    rm, and must not touch anything when sudo is missing either."""
    d = tmp_path / "sources.list.d"
    d.mkdir()
    (d / "google-chrome.list").write_text("deb https://dl.google.com/linux/chrome-stable/deb stable main\n")
    d.chmod(0o555)
    try:
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        # A sudo that records its argv instead of escalating.
        log = tmp_path / "sudo.log"
        sudo = bin_dir / "sudo"
        sudo.write_text(f'#!/usr/bin/env bash\necho "$@" >> "{log}"\n')
        sudo.chmod(0o755)

        env = dict(os.environ, APT_SOURCES_DIR=str(d), PATH=f"{bin_dir}:{os.environ['PATH']}")
        proc = subprocess.run(["bash", str(SCRIPT)], capture_output=True, text=True, env=env)
        assert proc.returncode == 0, proc.stderr
        assert "pruned google-chrome.list" in proc.stdout
        assert log.read_text().strip().startswith("rm -f ")
    finally:
        d.chmod(0o755)


@requires_non_root
def test_no_sudo_and_no_write_access_exits_clean_without_pruning(tmp_path):
    """Better to leave the sources alone and let apt speak than to abort a build
    on a `sudo: not found`."""
    d = tmp_path / "sources.list.d"
    d.mkdir()
    (d / "google-chrome.list").write_text("deb https://dl.google.com/linux/chrome-stable/deb stable main\n")
    d.chmod(0o555)
    try:
        empty_bin = tmp_path / "empty"
        empty_bin.mkdir()
        env = dict(os.environ, APT_SOURCES_DIR=str(d), PATH=str(empty_bin))
        proc = subprocess.run(["/bin/bash", str(SCRIPT)], capture_output=True, text=True, env=env)
        assert proc.returncode == 0, proc.stderr
        assert (d / "google-chrome.list").exists()
    finally:
        d.chmod(0o755)
