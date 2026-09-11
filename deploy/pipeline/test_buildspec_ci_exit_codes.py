"""Regression tests for the build-phase pytest block in buildspec-ci.yml (TEAM-4464).

CodeBuild runs every command of a build in ONE shared bash shell with no `set -e`, so a
`- |` block's exit status is its LAST statement's. The runtime-agent pytest block used to
end in `deactivate`, which always exits 0 -- so a red pytest battery (agentcore-hub-ci
b93c4479: "2 failed, 523 passed") still reported "Phase complete BUILD State SUCCEEDED".

These tests pin: the pytest invocation (and the venv/pip setup ahead of it) is guarded
with an explicit `|| { ... exit ...; }`, the block still has no `set -e`, and -- executed
for real in a bash subprocess against a stubbed pytest -- a nonzero pytest exit code
propagates as the block's own exit code.

Hermetic: no real venv is created and no pip install runs; python3/pip/pytest are stubbed
on PATH, and the extracted block's own `/tmp/pyci` is rewritten to a tmp_path before
execution so a stub `python3 -m venv` can never touch the real venv this test itself may
be running inside of.
"""
import os
import re
import stat
import subprocess
import textwrap
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BUILDSPEC = REPO / "deploy" / "pipeline" / "buildspec-ci.yml"
CI_WORKFLOW = REPO / ".github" / "workflows" / "ci.yml"


def _literal_block(text, anchor):
    """Extract a YAML `- |` block's body (dedented) given text found inside it."""
    lines = text.splitlines()
    anchor_idx = next(i for i, l in enumerate(lines) if anchor in l)
    start = anchor_idx
    while not lines[start].lstrip().startswith("- |"):
        start -= 1
    marker_indent = len(lines[start]) - len(lines[start].lstrip())
    end = start + 1
    while end < len(lines):
        line = lines[end]
        if line.strip() and (len(line) - len(line.lstrip())) <= marker_indent:
            break
        end += 1
    return textwrap.dedent("\n".join(lines[start + 1:end]))


def _build_phase(text):
    start = text.index("\n  build:")
    return text[start:text.index("\n  post_build:", start)]


def _pytest_block():
    return _literal_block(BUILDSPEC.read_text(encoding="utf-8"), "python3 -m venv /tmp/pyci")


# ── static shape assertions ──────────────────────────────────────────────────

def test_pytest_invocation_is_guarded():
    block = _pytest_block()
    m = re.search(r"pytest -q[\s\S]*?\|\|\s*\{[^}]*exit", block)
    assert m, f"pytest invocation must be followed by an `|| {{ ... exit ... }}` guard:\n{block}"


def test_deactivate_is_not_the_status_bearing_last_statement():
    block = _pytest_block()
    lines = [l for l in block.splitlines() if l.strip()]
    # `deactivate` still runs last (venv teardown), but only test_pytest_invocation_is_guarded
    # proves it isn't STATUS-bearing -- a guardless `pytest ...` followed by a bare
    # `deactivate` would pass this line too, which is exactly the TEAM-4464 bug.
    assert lines[-1].strip() == "deactivate", "deactivate should still run last (venv teardown)"
    assert re.search(r"\|\|\s*\{[^}]*exit", block), "the line before deactivate must be guarded"


def test_block_does_not_use_set_e():
    block = _pytest_block()
    assert "set -e" not in block
    assert "set -o errexit" not in block


def test_venv_and_pip_are_guarded():
    block = _pytest_block()
    assert re.search(r"python3 -m venv /tmp/pyci\s*\|\|\s*\{[^}]*exit", block), \
        "venv creation must be guarded"
    assert re.search(r"\. /tmp/pyci/bin/activate\s*\|\|\s*\{[^}]*exit", block), \
        "venv activation must be guarded"
    assert re.search(r"pip install[^|]*\|\|\s*\{[^}]*exit", block), \
        "pip install must be guarded"


def test_install_phase_playwright_guard_survives():
    """TEAM-4462 F1's guard in the install phase is the pattern this fix mirrors --
    pin that it is still there so the two don't drift apart again."""
    install_block = _literal_block(
        BUILDSPEC.read_text(encoding="utf-8"),
        'if [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]',
    )
    assert re.search(r"npx playwright install chromium\s*\|\|\s*\{[^}]*exit 1", install_block)


def test_this_file_runs_in_ci():
    """A new pytest file that isn't wired into the buildspec (or the mirrored GitHub
    job, if one exists) silently never runs -- exactly the kind of drift TEAM-4464 is
    about. Pin both."""
    name = Path(__file__).name
    build_phase = _build_phase(BUILDSPEC.read_text(encoding="utf-8"))
    assert f"deploy/pipeline/{name}" in build_phase, (
        f"{name} must be added to buildspec-ci.yml's build-phase pytest list"
    )
    if CI_WORKFLOW.exists():
        gh = CI_WORKFLOW.read_text(encoding="utf-8")
        if "deploy/pipeline/test_prune_apt_sources.py" in gh:
            assert f"deploy/pipeline/{name}" in gh, (
                f"{name} must also be added to .github/workflows/ci.yml's pytest list "
                "(it mirrors this buildspec battery)"
            )


# ── executed: the block's shape, against a stubbed pytest ───────────────────

_STUB_PYTHON3 = """#!/usr/bin/env bash
# Emulate `python3 -m venv DIR`: create DIR/bin/activate with a no-op deactivate.
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  mkdir -p "$3/bin"
  printf 'deactivate() { :; }\\n' > "$3/bin/activate"
  exit 0
fi
exit 0
"""

_STUB_PIP = """#!/usr/bin/env bash
exit "${PIP_STUB_RC:-0}"
"""

_STUB_PYTEST = """#!/usr/bin/env bash
echo "stub pytest -> ${PYTEST_STUB_RC:-0}"
exit "${PYTEST_STUB_RC:-0}"
"""


def _write_stub(path, content):
    path.write_text(content)
    path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


def _run_block(tmp_path, pytest_rc=0, pip_rc=0):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _write_stub(bin_dir / "python3", _STUB_PYTHON3)
    _write_stub(bin_dir / "pip", _STUB_PIP)
    _write_stub(bin_dir / "pytest", _STUB_PYTEST)

    # The only rewrite made to the real block: point the venv at tmp_path so a stub
    # `python3 -m venv` can never write into a venv this test process is itself running
    # inside of (on CodeBuild this file executes inside the real /tmp/pyci venv).
    block = _pytest_block().replace("/tmp/pyci", str(tmp_path / "pyci"))

    env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}")
    if pytest_rc:
        env["PYTEST_STUB_RC"] = str(pytest_rc)
    if pip_rc:
        env["PIP_STUB_RC"] = str(pip_rc)
    return subprocess.run(
        ["bash", "-c", block], capture_output=True, text=True, env=env, cwd=str(REPO)
    )


def test_block_is_valid_bash():
    block = _pytest_block()
    proc = subprocess.run(["bash", "-n", "-c", block], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr


def test_block_exits_zero_when_pytest_passes(tmp_path):
    proc = _run_block(tmp_path, pytest_rc=0)
    assert proc.returncode == 0, proc.stderr + proc.stdout


def test_block_propagates_a_failing_pytest_exit_code(tmp_path):
    proc = _run_block(tmp_path, pytest_rc=3)
    assert proc.returncode == 3, proc.stderr + proc.stdout
    assert "runtime-agent pytest battery FAILED (exit 3)" in proc.stdout


def test_block_propagates_a_failing_pip_exit_code(tmp_path):
    proc = _run_block(tmp_path, pip_rc=7)
    assert proc.returncode == 7, proc.stderr + proc.stdout
    assert "runtime-agent pytest dep install FAILED (exit 7)" in proc.stdout
