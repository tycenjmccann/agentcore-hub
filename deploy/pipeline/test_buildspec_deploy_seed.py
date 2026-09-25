"""The Target 2 config seeder in buildspec-deploy.yml, executed for real (TEAM-5081,
TEAM-5125).

config/models.json, config/pricing.json and config/cd-registry.json are LIVE documents
in the artifact bucket (the Models tab / nightly reconcile write the first two, the
Workflow tab / scripts/cd-registry.sh write the third). The deploy seeds each from the
repo copy on a first install and must never overwrite it afterwards. Defects found in
the seed block, all invisible without a harness (PR #708: "buildspec seeder has no
harness"; TEAM-5125 review of PR #724):

  (a) check-then-copy race: after a 404 HEAD it ran an unconditional `aws s3 cp`, so a
      writer that created the key in between was clobbered by the bundled seed;
  (b) pricing.json was copied whenever models.json was absent, without checking
      pricing.json itself;
  (c) cd-registry.json used its own hand-rolled `head-object || aws s3 cp`, unrelated
      to the shared helper: ANY head-object failure (throttle, expired token, 5xx),
      not just a real 404, read as absent and the seed then overwrote the LIVE CD
      registry — the deploy-trigger allow-list (TEAM-5125).

The block now sources deploy/lib/s3-seed-if-absent.sh once and calls it once PER KEY,
cd-registry.json included; the write is `put-object --if-none-match '*'` (412 = another
writer's document, kept).

Hermetic: the block is extracted from the YAML by its anchor comments and run under
bash with the real helper and deploy/lib/__tests__/fixtures/fake-aws-s3.sh on PATH,
whose on-disk store honours --if-none-match, so each case asserts on WHAT is stored.
BUILDSPEC_DEPLOY_YML points the executed cases at another copy of the buildspec (a
`git show <base>:...` extract) to show the race and per-key cases fail there.
"""
import os
import re
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
BUILDSPEC = Path(os.environ.get("BUILDSPEC_DEPLOY_YML") or REPO / "deploy" / "pipeline" / "buildspec-deploy.yml")
CI_BUILDSPEC = REPO / "deploy" / "pipeline" / "buildspec-ci.yml"
CI_WORKFLOW = REPO / ".github" / "workflows" / "ci.yml"
HELPER = REPO / "deploy" / "lib" / "s3-seed-if-absent.sh"
FAKE_AWS = REPO / "deploy" / "lib" / "__tests__" / "fixtures" / "fake-aws-s3.sh"

# TEAM-5125 moved the CD-registry seed to use the shared helper and pulled the
# `source` line up above it, so the seed block now starts at the CD-registry
# comment rather than the model-registry one. Both anchors exist unchanged on the
# base and the fixed buildspec.
START_ANCHOR = "# CD registry (which repos the hub merges + deploys)"
END_ANCHOR = 'aws s3 cp "s3://$ARTIFACT_BUCKET/config/agents.json" /tmp/agents-s3.json'
FOREIGN = '{"foreign":"created by another writer between HEAD and PUT"}'
HEAD_403 = "An error occurred (403) when calling the HeadObject operation: Forbidden"
HEAD_THROTTLE = "An error occurred (ThrottlingException) when calling the HeadObject operation: Rate exceeded"


def _seed_block(text: str) -> str:
    """The seed lines of Target 2: from the CD-registry comment up to (not including)
    the agents.json merge. Both anchors exist on the base and the fixed buildspec."""
    lines = text.splitlines()
    start = next(i for i, l in enumerate(lines) if START_ANCHOR in l)
    end = next(i for i, l in enumerate(lines) if END_ANCHOR in l and i > start)
    return textwrap.dedent("\n".join(lines[start:end]))


def _run_block(tmp_path: Path, *, store_pricing=None, store_models=None, store_cd_registry=None, env=None):
    """Run the extracted block in a throwaway checkout root, the way CodeBuild does:
    relative paths, `set -euo pipefail`, ARTIFACT_BUCKET/AWS_REGION_HUB exported."""
    root = tmp_path / "src-root"
    (root / "src" / "config").mkdir(parents=True)
    (root / "deploy" / "lib").mkdir(parents=True)
    shutil.copy(REPO / "src" / "config" / "models.json", root / "src" / "config" / "models.json")
    shutil.copy(REPO / "src" / "config" / "pricing.json", root / "src" / "config" / "pricing.json")
    shutil.copy(REPO / "src" / "config" / "cd-registry.json", root / "src" / "config" / "cd-registry.json")
    shutil.copy(HELPER, root / "deploy" / "lib" / "s3-seed-if-absent.sh")
    bindir = tmp_path / "bin"
    bindir.mkdir()
    shutil.copy(FAKE_AWS, bindir / "aws")
    (bindir / "aws").chmod(0o755)
    store = tmp_path / "store"
    (store / "config").mkdir(parents=True)
    if store_pricing is not None:
        (store / "config" / "pricing.json").write_text(store_pricing)
    if store_models is not None:
        (store / "config" / "models.json").write_text(store_models)
    if store_cd_registry is not None:
        (store / "config" / "cd-registry.json").write_text(store_cd_registry)
    log = tmp_path / "aws.log"
    script = "set -euo pipefail\n" + _seed_block(BUILDSPEC.read_text(encoding="utf-8")) + "\n"
    r = subprocess.run(
        ["bash", "-c", script],
        cwd=root,
        env={
            "PATH": f"{bindir}:{os.environ['PATH']}",
            "ARTIFACT_BUCKET": "fake-artifacts",
            "AWS_REGION_HUB": "us-east-1",
            "FAKE_S3_STORE": str(store),
            "FAKE_S3_LOG": str(log),
            "S3_SEED_RETRY_SLEEP": "0 0",
            **(env or {}),
        },
        capture_output=True,
        text=True,
    )
    calls = log.read_text().splitlines() if log.exists() else []

    def stored(key):
        p = store / key
        return p.read_text() if p.exists() else None

    return r, calls, stored


SEED_MODELS = (REPO / "src" / "config" / "models.json").read_text()
SEED_PRICING = (REPO / "src" / "config" / "pricing.json").read_text()
SEED_CD_REGISTRY = (REPO / "src" / "config" / "cd-registry.json").read_text()


# ── static shape ──────────────────────────────────────────────────────────────

def test_seed_block_is_extractable_and_uses_the_shared_helper():
    block = _seed_block(BUILDSPEC.read_text(encoding="utf-8"))
    assert "source deploy/lib/s3-seed-if-absent.sh" in block
    assert re.search(r"^s3_seed_if_absent \"\$ARTIFACT_BUCKET\" config/models\.json src/config/models\.json", block, re.M)
    assert re.search(r"^s3_seed_if_absent \"\$ARTIFACT_BUCKET\" config/pricing\.json src/config/pricing\.json", block, re.M)


def test_no_unconditional_copy_of_the_live_documents_anywhere_in_the_buildspec():
    text = BUILDSPEC.read_text(encoding="utf-8")
    code = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))
    assert not re.search(r"aws s3 cp [^\n]*config/(models|pricing|cd-registry)\.json", code), (
        "config/models.json, config/pricing.json and config/cd-registry.json are live "
        "documents: never `aws s3 cp` them"
    )


def test_cd_registry_seeded_only_via_the_helper():
    """TEAM-5125: cd-registry.json used to be seeded with its own `head-object || aws
    s3 cp`, bypassing the shared helper entirely (defect (c) above). It must now go
    through s3_seed_if_absent exactly like models.json/pricing.json, and the helper
    must be sourced before it is first called."""
    text = BUILDSPEC.read_text(encoding="utf-8")
    lines = text.splitlines()
    code_lines = [(i, l) for i, l in enumerate(lines) if not l.lstrip().startswith("#")]

    for i, l in code_lines:
        assert "head-object" not in l or "cd-registry" not in l, f"line {i + 1}: {l}"
        assert not re.search(r"aws s3 cp [^\n]*config/cd-registry\.json", l), f"line {i + 1}: {l}"

    call_re = re.compile(r'^\s*s3_seed_if_absent "\$ARTIFACT_BUCKET" config/cd-registry\.json src/config/cd-registry\.json "\$AWS_REGION_HUB"\s*$')
    call_lines = [i for i, l in code_lines if call_re.match(l)]
    assert len(call_lines) == 1, f"expected exactly one cd-registry.json seed call, found {len(call_lines)}"

    source_re = re.compile(r"^\s*source deploy/lib/s3-seed-if-absent\.sh\s*$")
    source_lines = [i for i, l in code_lines if source_re.match(l)]
    assert len(source_lines) == 1, f"expected exactly one `source` of the helper, found {len(source_lines)}"

    source_i, call_i = source_lines[0], call_lines[0]
    assert source_i < call_i, "the helper must be sourced before its first use"
    # No new build-phase boundary between the source and the first call — they must
    # run in the same shell (a `source` does not persist across CodeBuild commands).
    between = lines[source_i + 1 : call_i]
    assert not any(l.strip() in ("- |", "commands:") for l in between), (
        "source and first use must be in the same shell block"
    )


def test_this_file_runs_in_ci():
    name = Path(__file__).name
    assert f"deploy/pipeline/{name}" in CI_BUILDSPEC.read_text(encoding="utf-8"), (
        f"{name} must be added to buildspec-ci.yml's build-phase pytest list"
    )
    if CI_WORKFLOW.exists():
        gh = CI_WORKFLOW.read_text(encoding="utf-8")
        if "deploy/pipeline/test_plan_surfaces.py" in gh:
            assert f"deploy/pipeline/{name}" in gh, f"{name} must also be in .github/workflows/ci.yml's pytest list"


# ── executed ──────────────────────────────────────────────────────────────────

def test_first_deploy_seeds_all_three_keys_conditionally(tmp_path):
    r, calls, stored = _run_block(tmp_path)
    assert r.returncode == 0, r.stdout + r.stderr
    assert stored("config/models.json") == SEED_MODELS
    assert stored("config/pricing.json") == SEED_PRICING
    assert stored("config/cd-registry.json") == SEED_CD_REGISTRY
    puts = [c for c in calls if c.startswith("s3api put-object")]
    assert len(puts) == 3 and all("--if-none-match *" in c for c in puts), calls
    assert not [c for c in calls if c.startswith("s3 cp")], calls


def test_all_three_present_nothing_written(tmp_path):
    r, calls, stored = _run_block(tmp_path, store_models=FOREIGN, store_pricing=FOREIGN, store_cd_registry=FOREIGN)
    assert r.returncode == 0, r.stdout + r.stderr
    assert stored("config/models.json") == FOREIGN
    assert stored("config/pricing.json") == FOREIGN
    assert stored("config/cd-registry.json") == FOREIGN
    assert not [c for c in calls if c.startswith(("s3api put-object", "s3 cp"))], calls


def test_pricing_present_models_absent_pricing_is_not_overwritten(tmp_path):
    """Defect (b): pricing.json used to be copied whenever models.json was absent."""
    r, calls, stored = _run_block(tmp_path, store_pricing=FOREIGN, store_cd_registry=FOREIGN)
    assert r.returncode == 0, r.stdout + r.stderr
    assert stored("config/models.json") == SEED_MODELS, "models.json was absent and should be seeded"
    assert stored("config/pricing.json") == FOREIGN, "pricing.json was LIVE and must not be overwritten"
    writes = [c for c in calls if c.startswith(("s3api put-object", "s3 cp")) and "pricing.json" in c]
    assert writes == [], writes


def test_models_present_pricing_absent_pricing_is_seeded(tmp_path):
    r, calls, stored = _run_block(tmp_path, store_models=FOREIGN, store_cd_registry=FOREIGN)
    assert r.returncode == 0, r.stdout + r.stderr
    assert stored("config/models.json") == FOREIGN
    assert stored("config/pricing.json") == SEED_PRICING


def test_concurrent_create_keeps_the_other_writers_document(tmp_path):
    """Defect (a): HEAD says 404, another writer creates models.json, the seed must lose."""
    r, calls, stored = _run_block(
        tmp_path,
        store_cd_registry=FOREIGN,
        env={"FAKE_S3_APPEAR_AFTER_HEAD": "config/models.json", "FAKE_S3_APPEAR_CONTENT": FOREIGN},
    )
    assert r.returncode == 0, r.stdout + r.stderr
    assert stored("config/models.json") == FOREIGN, "the other writer's models.json must survive the deploy"
    assert stored("config/pricing.json") == SEED_PRICING, "pricing.json was really absent and is still seeded"
    assert "appeared after the head check" in r.stdout


def test_concurrent_create_on_pricing_keeps_it_too(tmp_path):
    r, calls, stored = _run_block(
        tmp_path,
        store_cd_registry=FOREIGN,
        env={"FAKE_S3_APPEAR_AFTER_HEAD": "config/pricing.json", "FAKE_S3_APPEAR_CONTENT": FOREIGN},
    )
    assert r.returncode == 0, r.stdout + r.stderr
    assert stored("config/pricing.json") == FOREIGN
    assert stored("config/models.json") == SEED_MODELS


def test_concurrent_create_on_cd_registry_keeps_it_too(tmp_path):
    """Same defect (a), on the CD registry key itself (TEAM-5125)."""
    r, calls, stored = _run_block(
        tmp_path,
        env={"FAKE_S3_APPEAR_AFTER_HEAD": "config/cd-registry.json", "FAKE_S3_APPEAR_CONTENT": FOREIGN},
    )
    assert r.returncode == 0, r.stdout + r.stderr
    assert stored("config/cd-registry.json") == FOREIGN, "the other writer's cd-registry.json must survive the deploy"
    assert stored("config/models.json") == SEED_MODELS
    assert stored("config/pricing.json") == SEED_PRICING


def test_409_race_is_retried_then_created(tmp_path):
    r, calls, stored = _run_block(tmp_path, env={"FAKE_S3_PUT_409": "1"})
    assert r.returncode == 0, r.stdout + r.stderr
    assert stored("config/models.json") == SEED_MODELS
    assert stored("config/cd-registry.json") == SEED_CD_REGISTRY
    assert "(409) - retry 1/2" in r.stdout


def test_head_403_fails_the_deploy_before_any_write(tmp_path):
    """TEAM-5073's classification survives: only a 404 is absence."""
    r, calls, stored = _run_block(
        tmp_path,
        store_cd_registry=FOREIGN,
        env={"FAKE_S3_HEAD_ERR": HEAD_403, "FAKE_S3_HEAD_ERR_KEY": "config/models.json"},
    )
    assert r.returncode != 0
    assert "ERROR: head-object config/models.json failed" in r.stderr
    assert stored("config/models.json") is None
    assert not [c for c in calls if c.startswith(("s3api put-object", "s3 cp"))], calls


def test_put_error_other_than_412_409_fails_the_deploy(tmp_path):
    r, calls, stored = _run_block(
        tmp_path,
        store_cd_registry=FOREIGN,
        env={"FAKE_S3_PUT_ERR": "An error occurred (AccessDenied) when calling the PutObject operation: Access Denied"},
    )
    assert r.returncode != 0
    assert "ERROR: put-object config/models.json failed" in r.stderr
    assert stored("config/models.json") is None
    assert not [c for c in calls if c.startswith("s3 cp")], "never falls back to a plain copy"


# ── CD registry, TEAM-5125 ────────────────────────────────────────────────────

def test_cd_registry_absent_seeded_conditionally(tmp_path):
    r, calls, stored = _run_block(tmp_path, store_models=FOREIGN, store_pricing=FOREIGN)
    assert r.returncode == 0, r.stdout + r.stderr
    assert stored("config/cd-registry.json") == SEED_CD_REGISTRY
    puts = [c for c in calls if c.startswith("s3api put-object") and "cd-registry.json" in c]
    assert len(puts) == 1 and "--if-none-match *" in puts[0], calls


def test_cd_registry_present_untouched(tmp_path):
    r, calls, stored = _run_block(tmp_path, store_models=FOREIGN, store_pricing=FOREIGN, store_cd_registry=FOREIGN)
    assert r.returncode == 0, r.stdout + r.stderr
    assert stored("config/cd-registry.json") == FOREIGN
    writes = [c for c in calls if c.startswith(("s3api put-object", "s3 cp")) and "cd-registry.json" in c]
    assert writes == [], writes


def test_cd_registry_head_throttle_fails_the_deploy_and_keeps_the_live_registry(tmp_path):
    """The bug (defect (c)): a HEAD error that isn't a real 404 — a throttle, an
    expired token, a 5xx — must fail the deploy, not be read as "absent" and
    silently overwrite the live registry with the empty repo seed."""
    r, calls, stored = _run_block(
        tmp_path,
        store_cd_registry=FOREIGN,
        env={"FAKE_S3_HEAD_ERR": HEAD_THROTTLE, "FAKE_S3_HEAD_ERR_KEY": "config/cd-registry.json"},
    )
    assert r.returncode != 0, r.stdout + r.stderr
    assert "ERROR: head-object config/cd-registry.json failed" in r.stderr
    assert stored("config/cd-registry.json") == FOREIGN, "the live CD registry must survive a HEAD error"
    assert not [c for c in calls if c.startswith(("s3api put-object", "s3 cp")) and "cd-registry.json" in c], calls
