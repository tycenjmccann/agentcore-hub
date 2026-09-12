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


# ── TEAM-4491: the BUILD_APP_IMAGE post_build block ──────────────────────────
#
# This block has NO `set -e` either, and its last statement is the
# changed-files-runtime.txt `if/else` -- which essentially always succeeds.
# Every gate ahead of it, including `check-lambda-zip-manifest.sh --zip
# /tmp/orchestrator.zip` (the ONLY guard on the artifact the Deploy stage
# promotes), was maskable. Same fix, same reasoning as above: an explicit
# `|| { echo "... FAILED"; exit 1; }` on each status-bearing command.

def _build_image_block():
    return _literal_block(
        BUILDSPEC.read_text(encoding="utf-8"),
        'if [ "${BUILD_APP_IMAGE:-false}" = "true" ]',
    )


# (regex fragment, human label) for every status-bearing command TEAM-4491 guards.
_GUARDED_COMMANDS = [
    (r"\( cd lambda/orchestrator && npm ci --omit=dev \)", "orchestrator npm ci"),
    (r"\( cd lambda/orchestrator && zip -rq /tmp/orchestrator\.zip \$ZIP_ARGS \)", "orchestrator zip"),
    (r"bash scripts/check-lambda-zip-manifest\.sh --zip /tmp/orchestrator\.zip", "orchestrator zip manifest check"),
    # TEAM-4493 wrapped this pipe in `( set -o pipefail; ... )`, so the guard now hangs
    # off the subshell's closing paren -- the `\)` is load-bearing, not cosmetic.
    (r'docker login --username AWS --password-stdin "\$\{ACCOUNT_ID\}[^"]*"\s*\)', "ECR docker login"),
    (r"cp src/config/agents\.json /tmp/agents\.git\.json", "agents.json git backup"),
    (r"python3 deploy/pipeline/merge-agents-json\.py \S+ \S+ \S+", "agents.json roster merge"),
    (r"cp /tmp/agents\.merged\.json src/config/agents\.json", "agents.json merged install"),
    (r"--push --file Dockerfile \. --provenance=false", "docker buildx build/push"),
    (r"mkdir -p pipeline-out", "pipeline-out mkdir"),
    (r"cp /tmp/orchestrator\.zip pipeline-out/orchestrator\.zip", "orchestrator zip artifact copy"),
    (r'printf \'%s\' "\$IMAGE_DIGEST" > pipeline-out/image-digest\.txt', "image-digest.txt write"),
    (r'printf \'%s\' "\$GIT_SHA" > pipeline-out/git-sha\.txt', "git-sha.txt write"),
    (r"git diff --name-only \"\$\{LAST_DEPLOYED\}\.\.HEAD\" > pipeline-out/changed-files\.txt", "changed-files.txt git diff"),
    (r"git diff --name-only \"\$\{LAST_RT\}\.\.HEAD\" > pipeline-out/changed-files-runtime\.txt", "changed-files-runtime.txt git diff"),
    (r"cp /tmp/agents\.git\.json src/config/agents\.json", "agents.json git roster restore"),
    (r'echo "deploy/runtime-agent/FORCE-UNKNOWN-RANGE" > pipeline-out/changed-files\.txt', "changed-files.txt fallback write"),
    (r'echo "deploy/runtime-agent/FORCE-UNKNOWN-RANGE" > pipeline-out/changed-files-runtime\.txt', "changed-files-runtime.txt fallback write"),
]


def test_build_image_block_guards_every_status_bearing_command():
    block = _build_image_block()
    for command_re, label in _GUARDED_COMMANDS:
        m = re.search(command_re + r"\s*(\\\n\s*)?\|\|\s*\{[^}]*exit 1[^}]*\}", block)
        assert m, f"{label!r} ({command_re}) must be followed by `|| {{ ... exit 1; }}`:\n{block}"


def test_build_image_block_manifest_check_is_guarded():
    """The ticket's headline gap: the manifest check is the ONLY guard on the
    orchestrator zip the Deploy stage promotes."""
    block = _build_image_block()
    assert re.search(
        r"bash scripts/check-lambda-zip-manifest\.sh --zip /tmp/orchestrator\.zip"
        r"\s*\|\|\s*\{[^}]*echo \"orchestrator zip manifest check FAILED\"[^}]*exit 1[^}]*\}",
        block,
    ), f"manifest check must hard-fail the block on a nonzero exit:\n{block}"


def test_build_image_block_does_not_use_set_e():
    block = _build_image_block()
    assert "set -e" not in block
    assert "set -o errexit" not in block


def test_ecr_login_pipe_uses_a_scoped_pipefail_subshell():
    """TEAM-4493: without pipefail the `||` guard sees only `docker login`'s status, so a
    failed `aws ecr get-login-password` was masked. The pipefail must be scoped to that ONE
    pipe -- a block-wide `set -o pipefail` (like `set -e`) would change the semantics of
    every later command in CodeBuild's single shared shell."""
    block = _build_image_block()
    assert re.search(
        r"\(\s*set -o pipefail;\s*aws ecr get-login-password[\s\S]*?"
        r'docker login --username AWS --password-stdin "\$\{ACCOUNT_ID\}[^"]*"\s*\)'
        r"\s*(\\\n\s*)?\|\|\s*\{[^}]*exit 1[^}]*\}",
        block,
    ), f"the ECR login pipe must be `( set -o pipefail; ... ) || {{ ... exit 1; }}`:\n{block}"
    # scoped, not block-wide: the only `set -o` in the block is the one inside that subshell
    assert block.count("set -o pipefail") == 1, "no second/block-wide `set -o pipefail`"
    assert not re.search(r"^\s*set -o pipefail", block, re.M), \
        "`set -o pipefail` must not stand on its own line (that would be block-wide)"


def test_build_image_block_dockerd_bootstrap_guard_survives():
    """TEAM-4448 R11's dockerd bootstrap guard is already correct -- pin that it's
    unchanged so this fix doesn't regress it."""
    block = _build_image_block()
    assert "docker: dockerd failed to come up within 60s" in block
    assert re.search(
        r"timeout 60 bash -c '[^']*'\s*\\\n\s*\|\|\s*\{[^}]*exit 1[^}]*\}", block
    )


def test_build_image_block_digest_fatal_exit_survives():
    """The IMAGE_DIGEST retry loop's hard FATAL exit is already correct -- pin
    that it's unchanged."""
    block = _build_image_block()
    assert "FATAL: could not resolve a sha256 image digest for tag" in block


# ── executed: the block's shape, against a stubbed AWS/docker/zip toolchain ──

_OK = "#!/usr/bin/env bash\nexit 0\n"

_STUB_ZIP = """#!/usr/bin/env bash
exit "${ZIP_STUB_RC:-0}"
"""

_STUB_GREP = """#!/usr/bin/env bash
# Stands in for `grep -oE 'zip -rq function\\.zip .*' lambda/orchestrator/deploy.sh`;
# that file does not exist under the tmp_path cwd this test runs in.
echo "zip -rq function.zip index.mjs lease-constants.json node_modules"
"""

_STUB_GIT = """#!/usr/bin/env bash
case "$1" in
  rev-parse) echo abcdef123456 ;;
  cat-file) exit 0 ;;
  diff) exit 0 ;;
  *) exit 0 ;;
esac
"""

_STUB_AWS = """#!/usr/bin/env bash
case "$1$2" in
  stsget-caller-identity) echo 123456789012 ;;
  # TEAM-4493: rc!=0 prints NOTHING and fails, like a real credential failure. The
  # `docker` stub still exits 0, so only pipefail can surface this.
  ecrget-login-password)
    if [ "${AWS_ECR_LOGIN_STUB_RC:-0}" != "0" ]; then exit "${AWS_ECR_LOGIN_STUB_RC}"; fi
    echo stub-token ;;
  ecrdescribe-images) echo sha256:abc ;;
  # TEAM-4493: LAST_DEPLOYED_STUB_EMPTY=1 blanks BOTH `aws s3 cp ... -` baseline reads,
  # so both `if/else` fallbacks take their sentinel-write else branch.
  s3cp) if [ "$4" = "-" ] && [ "${LAST_DEPLOYED_STUB_EMPTY:-0}" != "1" ]; then echo 1111111111111111111111111111111111111111; fi ;;
esac
exit 0
"""


def _run_build_image_block(tmp_path, manifest_rc=0, zip_rc=0, ecr_login_rc=0,
                            last_deployed_empty=False, sentinel_path=None):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, content in (
        ("cp", _OK), ("rm", _OK), ("mkdir", _OK), ("npm", _OK), ("nohup", _OK),
        ("dockerd", _OK), ("timeout", _OK), ("sleep", _OK), ("python3", _OK), ("docker", _OK),
        ("zip", _STUB_ZIP), ("grep", _STUB_GREP), ("git", _STUB_GIT), ("aws", _STUB_AWS),
    ):
        _write_stub(bin_dir / name, content)

    # `bash scripts/check-lambda-zip-manifest.sh --zip ...` invokes `bash <script>`, so
    # `bash` itself cannot be stubbed on PATH (the harness IS `bash -c`, and the dockerd
    # bootstrap guard also needs a real `bash -c` inside the block). Rewrite the SCRIPT
    # PATH to a stub instead -- same technique as `/tmp/pyci` above.
    manifest_stub = tmp_path / "manifest-stub.sh"
    manifest_stub.write_text(f'#!/usr/bin/env bash\nexit {manifest_rc}\n')
    manifest_stub.chmod(manifest_stub.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    (tmp_path / "lambda" / "orchestrator").mkdir(parents=True)
    (tmp_path / "pipeline-out").mkdir()

    block = (
        _build_image_block()
        .replace("/tmp/", f"{tmp_path}/")
        .replace("scripts/check-lambda-zip-manifest.sh", str(manifest_stub))
    )
    # TEAM-4493: must come AFTER the "/tmp/" rewrite above -- tmp_path itself typically
    # lives under /tmp, so doing this first would mangle the injected sentinel_path the
    # same way it would mangle the manifest-stub path (same reason that replace is last).
    if sentinel_path:
        block = block.replace(
            '"deploy/runtime-agent/FORCE-UNKNOWN-RANGE" > pipeline-out/changed-files.txt',
            f'"deploy/runtime-agent/FORCE-UNKNOWN-RANGE" > {sentinel_path}',
        )

    env = dict(
        os.environ,
        PATH=f"{bin_dir}:{os.environ['PATH']}",
        BUILD_APP_IMAGE="true",
        AWS_REGION_HUB="us-east-1",
        ECR_REPO="stub-repo",
        ARTIFACT_BUCKET="stub-bucket",
    )
    env.pop("CODEBUILD_RESOLVED_SOURCE_VERSION", None)
    if zip_rc:
        env["ZIP_STUB_RC"] = str(zip_rc)
    if ecr_login_rc:
        env["AWS_ECR_LOGIN_STUB_RC"] = str(ecr_login_rc)
    if last_deployed_empty:
        env["LAST_DEPLOYED_STUB_EMPTY"] = "1"
    return subprocess.run(
        ["bash", "-c", block], capture_output=True, text=True, env=env, cwd=str(tmp_path)
    )


def test_build_image_block_is_valid_bash():
    block = _build_image_block()
    proc = subprocess.run(["bash", "-n", "-c", block], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr


def test_build_image_block_exits_zero_in_control_case(tmp_path):
    proc = _run_build_image_block(tmp_path)
    assert proc.returncode == 0, proc.stderr + proc.stdout


def test_build_image_block_propagates_a_failing_manifest_check(tmp_path):
    proc = _run_build_image_block(tmp_path, manifest_rc=1)
    assert proc.returncode != 0, proc.stderr + proc.stdout
    assert "orchestrator zip manifest check FAILED" in proc.stdout


def test_build_image_block_propagates_a_failing_zip(tmp_path):
    proc = _run_build_image_block(tmp_path, zip_rc=1)
    assert proc.returncode != 0, proc.stderr + proc.stdout
    assert "orchestrator zip FAILED" in proc.stdout


def test_build_image_block_fails_when_ecr_get_login_password_fails(tmp_path):
    """The TEAM-4493 regression test. The `docker` stub exits 0, so on the PRE-change
    buildspec (no pipefail) the pipeline status is docker's 0, the `||` guard never fires
    and the block exits 0 -- a credential failure behind a green Build."""
    proc = _run_build_image_block(tmp_path, ecr_login_rc=1)
    assert proc.returncode != 0, proc.stderr + proc.stdout
    assert "ECR docker login FAILED" in proc.stdout


def test_build_image_block_fails_when_the_sentinel_fallback_write_fails(tmp_path):
    """A nonexistent PARENT dir fails the redirect for root too -- CodeBuild runs as root,
    so a read-only dir would not fail there."""
    proc = _run_build_image_block(
        tmp_path, last_deployed_empty=True,
        sentinel_path=tmp_path / "no-such-dir" / "changed-files.txt",
    )
    assert proc.returncode != 0, proc.stderr + proc.stdout
    assert "changed-files.txt fallback write FAILED" in proc.stdout


def test_build_image_block_writes_the_sentinel_on_an_unknown_range(tmp_path):
    """Control for the test above: same else branch, writable path -> exits 0 and the
    conservative sentinel really lands (plan-surfaces.py reads a MISSING file as [], i.e.
    app-only deploy, so a silent write failure under-scopes the deploy)."""
    sentinel = tmp_path / "sentinel-changed-files.txt"
    proc = _run_build_image_block(tmp_path, last_deployed_empty=True, sentinel_path=sentinel)
    assert proc.returncode == 0, proc.stderr + proc.stdout
    assert sentinel.read_text().strip() == "deploy/runtime-agent/FORCE-UNKNOWN-RANGE"
    # the runtime sentinel took its else branch too and landed at the real relative path
    assert (tmp_path / "pipeline-out" / "changed-files-runtime.txt").read_text().strip() \
        == "deploy/runtime-agent/FORCE-UNKNOWN-RANGE"
