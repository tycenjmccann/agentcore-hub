"""The Target 2 config seeder in buildspec-deploy.yml, executed for real (TEAM-5081).

config/models.json and config/pricing.json are LIVE documents in the artifact bucket
(the Models tab and the nightly reconcile write them). The deploy seeds them from the
repo copy on a first install and must never overwrite them afterwards. Two defects in
the seed block, both invisible without a harness (PR #708: "buildspec seeder has no
harness"):

  (a) check-then-copy race: after a 404 HEAD it ran an unconditional `aws s3 cp`, so a
      writer that created the key in between was clobbered by the bundled seed;
  (b) pricing.json was copied whenever models.json was absent, without checking
      pricing.json itself.

The block now sources deploy/lib/s3-seed-if-absent.sh and calls it once PER KEY; the
write is `put-object --if-none-match '*'` (412 = another writer's document, kept).

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

START_ANCHOR = "# Model registry (DL-033, TEAM-4995)"
END_ANCHOR = 'aws s3 cp "s3://$ARTIFACT_BUCKET/config/agents.json" /tmp/agents-s3.json'
FOREIGN = '{"foreign":"created by another writer between HEAD and PUT"}'
HEAD_403 = "An error occurred (403) when calling the HeadObject operation: Forbidden"


def _seed_block(text: str) -> str:
    """The seed lines of Target 2: from the model-registry comment up to (not including)
    the agents.json merge. Both anchors exist on the base and the fixed buildspec."""
    lines = text.splitlines()
    start = next(i for i, l in enumerate(lines) if START_ANCHOR in l)
    end = next(i for i, l in enumerate(lines) if END_ANCHOR in l and i > start)
    return textwrap.dedent("\n".join(lines[start:end]))


def _run_block(tmp_path: Path, *, store_pricing=None, store_models=None, env=None):
    """Run the extracted block in a throwaway checkout root, the way CodeBuild does:
    relative paths, `set -euo pipefail`, ARTIFACT_BUCKET/AWS_REGION_HUB exported."""
    root = tmp_path / "src-root"
    (root / "src" / "config").mkdir(parents=True)
    (root / "deploy" / "lib").mkdir(parents=True)
    shutil.copy(REPO / "src" / "config" / "models.json", root / "src" / "config" / "models.json")
    shutil.copy(REPO / "src" / "config" / "pricing.json", root / "src" / "config" / "pricing.json")
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


# ── static shape ──────────────────────────────────────────────────────────────

def test_seed_block_is_extractable_and_uses_the_shared_helper():
    block = _seed_block(BUILDSPEC.read_text(encoding="utf-8"))
    assert "source deploy/lib/s3-seed-if-absent.sh" in block
    assert re.search(r"^s3_seed_if_absent \"\$ARTIFACT_BUCKET\" config/models\.json src/config/models\.json", block, re.M)
    assert re.search(r"^s3_seed_if_absent \"\$ARTIFACT_BUCKET\" config/pricing\.json src/config/pricing\.json", block, re.M)


def test_no_unconditional_copy_of_the_live_documents_anywhere_in_the_buildspec():
    text = BUILDSPEC.read_text(encoding="utf-8")
    code = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))
    assert not re.search(r"aws s3 cp [^\n]*config/(models|pricing)\.json", code), (
        "config/models.json and config/pricing.json are live documents: never `aws s3 cp` them"
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

def test_first_deploy_seeds_both_keys_conditionally(tmp_path):
    r, calls, stored = _run_block(tmp_path)
    assert r.returncode == 0, r.stdout + r.stderr
    assert stored("config/models.json") == SEED_MODELS
    assert stored("config/pricing.json") == SEED_PRICING
    puts = [c for c in calls if c.startswith("s3api put-object")]
    assert len(puts) == 2 and all("--if-none-match *" in c for c in puts), calls
    assert not [c for c in calls if c.startswith("s3 cp")], calls


def test_both_present_nothing_written(tmp_path):
    r, calls, stored = _run_block(tmp_path, store_models=FOREIGN, store_pricing=FOREIGN)
    assert r.returncode == 0, r.stdout + r.stderr
    assert stored("config/models.json") == FOREIGN
    assert stored("config/pricing.json") == FOREIGN
    assert not [c for c in calls if c.startswith(("s3api put-object", "s3 cp"))], calls


def test_pricing_present_models_absent_pricing_is_not_overwritten(tmp_path):
    """Defect (b): pricing.json used to be copied whenever models.json was absent."""
    r, calls, stored = _run_block(tmp_path, store_pricing=FOREIGN)
    assert r.returncode == 0, r.stdout + r.stderr
    assert stored("config/models.json") == SEED_MODELS, "models.json was absent and should be seeded"
    assert stored("config/pricing.json") == FOREIGN, "pricing.json was LIVE and must not be overwritten"
    writes = [c for c in calls if c.startswith(("s3api put-object", "s3 cp")) and "pricing.json" in c]
    assert writes == [], writes


def test_models_present_pricing_absent_pricing_is_seeded(tmp_path):
    r, calls, stored = _run_block(tmp_path, store_models=FOREIGN)
    assert r.returncode == 0, r.stdout + r.stderr
    assert stored("config/models.json") == FOREIGN
    assert stored("config/pricing.json") == SEED_PRICING


def test_concurrent_create_keeps_the_other_writers_document(tmp_path):
    """Defect (a): HEAD says 404, another writer creates models.json, the seed must lose."""
    r, calls, stored = _run_block(
        tmp_path, env={"FAKE_S3_APPEAR_AFTER_HEAD": "config/models.json", "FAKE_S3_APPEAR_CONTENT": FOREIGN}
    )
    assert r.returncode == 0, r.stdout + r.stderr
    assert stored("config/models.json") == FOREIGN, "the other writer's models.json must survive the deploy"
    assert stored("config/pricing.json") == SEED_PRICING, "pricing.json was really absent and is still seeded"
    assert "appeared after the head check" in r.stdout


def test_concurrent_create_on_pricing_keeps_it_too(tmp_path):
    r, calls, stored = _run_block(
        tmp_path, env={"FAKE_S3_APPEAR_AFTER_HEAD": "config/pricing.json", "FAKE_S3_APPEAR_CONTENT": FOREIGN}
    )
    assert r.returncode == 0, r.stdout + r.stderr
    assert stored("config/pricing.json") == FOREIGN
    assert stored("config/models.json") == SEED_MODELS


def test_409_race_is_retried_then_created(tmp_path):
    r, calls, stored = _run_block(tmp_path, env={"FAKE_S3_PUT_409": "1"})
    assert r.returncode == 0, r.stdout + r.stderr
    assert stored("config/models.json") == SEED_MODELS
    assert "(409) - retry 1/2" in r.stdout


def test_head_403_fails_the_deploy_before_any_write(tmp_path):
    """TEAM-5073's classification survives: only a 404 is absence."""
    r, calls, stored = _run_block(tmp_path, env={"FAKE_S3_HEAD_ERR": HEAD_403, "FAKE_S3_HEAD_ERR_KEY": "config/models.json"})
    assert r.returncode != 0
    assert "ERROR: head-object config/models.json failed" in r.stderr
    assert stored("config/models.json") is None
    assert not [c for c in calls if c.startswith(("s3api put-object", "s3 cp"))], calls


def test_put_error_other_than_412_409_fails_the_deploy(tmp_path):
    r, calls, stored = _run_block(
        tmp_path, env={"FAKE_S3_PUT_ERR": "An error occurred (AccessDenied) when calling the PutObject operation: Access Denied"}
    )
    assert r.returncode != 0
    assert "ERROR: put-object config/models.json failed" in r.stderr
    assert stored("config/models.json") is None
    assert not [c for c in calls if c.startswith("s3 cp")], "never falls back to a plain copy"
