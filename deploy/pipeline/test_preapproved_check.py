"""TEAM-4525 -- the conditional deploy gate, exercised for real in bash.

A ship run used to ask the human to approve byte-identical code twice: the Merge
Approval gate (PR head SHA X), then this pipeline's `Approve_deploy`
ManualApproval (the merge of that same X). wf_1789170903227_c3x6k1 spent ~5.1h
between the two. TEAM-4525 makes the second gate CONDITIONAL -- skipped only when
the commit being deployed is provably the recorded merge of the head SHA a human
already approved, with CI certified on it -- and NEVER auto-approved.

`preapproved-check.sh` is the only thing that answers that question, so it is the
whole security surface of the change. These tests run it as a real bash
subprocess with a stub `aws` on PATH (hermetic: no AWS, no network) and pin both
directions:

  AC1  deployed SHA == recorded merge_commit  -> `decide` prints 1 and `gate 1`
       exits 0, i.e. the human gate is unnecessary for exactly this commit.
  AC2  anything else -- record missing, merge_commit belongs to a different
       commit, malformed JSON, non-hex sha, no bucket, no aws CLI, an unresolved
       "#{BuildVars...}" variable -- prints 0 / refuses. Fail-closed.

Plus source-level guards on the wiring, because the fail-closed ORIENTATION lives
in the CDK stack (`Operator: NE, Value: "1"`) and inverting it would silently turn
"unproven" into "skip the human". Those are pinned textually rather than by `cdk
synth`: this file runs in the Build stage's pytest battery, which has no
deploy/pipeline/node_modules.
"""
import json
import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "deploy" / "pipeline" / "preapproved-check.sh"
STACK = REPO / "deploy" / "pipeline" / "lib" / "pipeline-stack.ts"
BUILDSPEC_CI = REPO / "deploy" / "pipeline" / "buildspec-ci.yml"
BUILDSPEC_DEPLOY = REPO / "deploy" / "pipeline" / "buildspec-deploy.yml"
BUILDSPEC_RUNTIME = REPO / "deploy" / "pipeline" / "buildspec-runtime-images.yml"

BUCKET = "test-artifact-bucket"
PREFIX = "pipeline-artifacts/ship-approvals"

MERGE_SHA = "a" * 40
APPROVED_SHA = "b" * 40
OTHER_SHA = "c" * 40

# A stub `aws` that serves ONLY `aws s3 cp s3://<bucket>/<key> - [--region R]`
# from a local directory, and records every key it was asked for. Anything else
# is a hard error, so a future rewrite that reaches for a different AWS call
# cannot quietly pass these tests.
AWS_STUB = '''#!/usr/bin/env python3
import os, sys

argv = sys.argv[1:]
root = os.environ["STUB_S3_DIR"]
with open(os.path.join(root, "_requests.log"), "a") as fh:
    fh.write(" ".join(argv) + "\\n")

if argv[:2] != ["s3", "cp"] or len(argv) < 4 or argv[3] != "-":
    sys.stderr.write("stub aws: unsupported invocation %r\\n" % (argv,))
    sys.exit(64)

url = argv[2]
if not url.startswith("s3://"):
    sys.stderr.write("stub aws: not an s3 url %r\\n" % (url,))
    sys.exit(64)
bucket, _, key = url[len("s3://"):].partition("/")
if bucket != os.environ["STUB_S3_BUCKET"]:
    sys.stderr.write("stub aws: wrong bucket %r\\n" % (bucket,))
    sys.exit(1)

path = os.path.join(root, key.replace("/", "__"))
if not os.path.exists(path):
    sys.stderr.write("stub aws: NoSuchKey %s\\n" % key)
    sys.exit(1)
sys.stdout.write(open(path).read())
'''


@pytest.fixture
def s3(tmp_path):
    """A stubbed S3 + `aws` on PATH. Returns a small helper object."""
    store = tmp_path / "s3"
    store.mkdir()
    binroot = tmp_path / "bin"
    binroot.mkdir()
    stub = binroot / "aws"
    stub.write_text(AWS_STUB)
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)

    class Fixture:
        dir = store
        path_prefix = str(binroot)

        def put(self, key, body):
            target = store / key.replace("/", "__")
            target.write_text(body if isinstance(body, str) else json.dumps(body))

        def put_record(self, key_sha, **overrides):
            """Store a record AT key_sha; `merge_commit` defaults to key_sha but
            can be overridden to model a record that names a different commit."""
            record = {
                "version": 1,
                "merge_commit": key_sha,
                "approved_head_sha": APPROVED_SHA,
                "ci_build_id": "agentcore-hub-ci:0000",
                "pipeline": "agentcore-hub-deploy",
                "repo": "tycenjmccann/agentcore-hub",
                "recorded_at": "2026-09-12T00:00:00Z",
                "recorded_by": "Pipeline___start_deploy",
            }
            record.update(overrides)
            self.put(f"{PREFIX}/{key_sha}.json", json.dumps(record))

        def put_raw(self, sha, body):
            self.put(f"{PREFIX}/{sha}.json", body)

        @property
        def requests(self):
            log = store / "_requests.log"
            return log.read_text().splitlines() if log.exists() else []

    return Fixture()


def run(args, s3=None, bucket=BUCKET, with_aws=True, region="us-east-1"):
    env = {
        "PATH": (f"{s3.path_prefix}:" if (s3 and with_aws) else "")
        + os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", "/tmp"),
    }
    if bucket is not None:
        env["ARTIFACT_BUCKET"] = bucket
    if region:
        env["AWS_REGION_HUB"] = region
    if s3 is not None:
        env["STUB_S3_DIR"] = str(s3.dir)
        env["STUB_S3_BUCKET"] = bucket or ""
    return subprocess.run(
        ["bash", str(SCRIPT), *args],
        env=env,
        capture_output=True,
        text=True,
        cwd=str(REPO),
    )


def decide(sha, **kw):
    proc = run(["decide", sha], **kw)
    assert proc.returncode == 0, (
        "decide must NEVER exit non-zero -- a missing record is an answer, not a "
        f"build failure. stdout={proc.stdout!r} stderr={proc.stderr!r}"
    )
    return proc.stdout.strip()


# ── AC1: the deployed commit IS the recorded merge of the approved head ──────


def test_decide_prints_1_when_record_matches_the_deployed_commit(s3):
    s3.put_record(MERGE_SHA)
    assert decide(MERGE_SHA, s3=s3) == "1"


def test_decide_reads_exactly_the_keyed_record(s3):
    s3.put_record(MERGE_SHA)
    decide(MERGE_SHA, s3=s3)
    assert any(
        f"s3://{BUCKET}/{PREFIX}/{MERGE_SHA}.json" in line for line in s3.requests
    ), s3.requests


def test_decide_tolerates_uppercase_and_padding_in_the_record(s3):
    s3.put_record(MERGE_SHA, merge_commit=f"  {MERGE_SHA.upper()}  ")
    assert decide(MERGE_SHA, s3=s3) == "1"


def test_gate_1_passes_when_the_record_still_verifies(s3):
    s3.put_record(MERGE_SHA)
    proc = run(["gate", "1", MERGE_SHA], s3=s3)
    assert proc.returncode == 0, proc.stderr


def test_gate_0_passes_without_touching_s3_at_all(s3):
    # "0" means the human ManualApproval ran and a human approved it. There is
    # nothing left to verify, and no record needs to exist.
    proc = run(["gate", "0", MERGE_SHA], s3=s3)
    assert proc.returncode == 0, proc.stderr
    assert s3.requests == []


# ── AC2: everything else keeps the human gate / refuses ─────────────────────


def test_decide_prints_0_when_the_record_is_for_a_different_commit(s3):
    # The post-approval `main` sync case: a new merge commit, whose record either
    # does not exist or names a different merge_commit.
    s3.put_record(MERGE_SHA, merge_commit=OTHER_SHA)
    assert decide(MERGE_SHA, s3=s3) == "0"


def test_decide_prints_0_when_no_record_exists(s3):
    assert decide(MERGE_SHA, s3=s3) == "0"


def test_decide_prints_0_on_malformed_json(s3):
    s3.put_raw(MERGE_SHA, "{not json at all")
    assert decide(MERGE_SHA, s3=s3) == "0"


def test_decide_prints_0_when_the_record_is_not_an_object(s3):
    s3.put_raw(MERGE_SHA, '["merge_commit"]')
    assert decide(MERGE_SHA, s3=s3) == "0"


def test_decide_prints_0_on_empty_record(s3):
    s3.put_raw(MERGE_SHA, "")
    assert decide(MERGE_SHA, s3=s3) == "0"


@pytest.mark.parametrize(
    "approved",
    ["", "abc", "z" * 40, MERGE_SHA[:39], "not-a-sha", None],
    ids=["empty", "short", "non-hex", "39-chars", "words", "missing"],
)
def test_decide_prints_0_when_approved_head_sha_is_not_a_sha(s3, approved):
    # The whole point of the record is the binding to a human-approved head SHA.
    # A record without a credible one proves nothing.
    overrides = {} if approved is None else {"approved_head_sha": approved}
    if approved is None:
        s3.put(
            f"{PREFIX}/{MERGE_SHA}.json",
            json.dumps({"version": 1, "merge_commit": MERGE_SHA}),
        )
    else:
        s3.put_record(MERGE_SHA, **overrides)
    assert decide(MERGE_SHA, s3=s3) == "0"


@pytest.mark.parametrize(
    "sha",
    ["", "nogit", "abc1234", MERGE_SHA[:12], MERGE_SHA + "a", "../../etc/passwd"],
    ids=["empty", "nogit", "short", "12-char-tag", "41-chars", "traversal"],
)
def test_decide_prints_0_for_a_source_version_that_is_not_40_hex(s3, sha):
    s3.put_record(MERGE_SHA)
    assert decide(sha, s3=s3) == "0"


def test_decide_prints_0_with_no_artifact_bucket(s3):
    s3.put_record(MERGE_SHA)
    assert decide(MERGE_SHA, s3=s3, bucket=None) == "0"


def test_decide_prints_0_when_the_aws_cli_is_missing(s3):
    s3.put_record(MERGE_SHA)
    assert decide(MERGE_SHA, s3=s3, with_aws=False) == "0"


@pytest.mark.parametrize(
    "value",
    ["", " ", "yes", "true", "01", "1 ", "#{BuildVars.DEPLOY_PREAPPROVED}", "2", "-1"],
    ids=[
        "empty",
        "space",
        "yes",
        "true",
        "01",
        "trailing-space",
        "unresolved-variable",
        "two",
        "minus-one",
    ],
)
def test_gate_refuses_every_value_that_is_not_0_or_1(s3, value):
    s3.put_record(MERGE_SHA)
    proc = run(["gate", value, MERGE_SHA], s3=s3)
    assert proc.returncode == 1, f"{value!r} must refuse: {proc.stdout!r}"
    assert "refusing to deploy" in proc.stderr.lower()


def test_gate_1_refuses_when_the_record_does_not_verify_now(s3):
    # The independent re-read. If the Approval stage was skipped but the record
    # no longer backs this commit, prod is not touched.
    proc = run(["gate", "1", MERGE_SHA], s3=s3)
    assert proc.returncode == 1
    assert "refusing to deploy" in proc.stderr.lower()


def test_gate_1_refuses_on_a_missing_git_sha_full(s3):
    # buildspec passes `$(cat pipeline-out/git-sha-full.txt || true)`, so an
    # artifact from before this change yields an empty sha.
    s3.put_record(MERGE_SHA)
    proc = run(["gate", "1", ""], s3=s3)
    assert proc.returncode == 1


def test_unknown_subcommand_exits_non_zero(s3):
    proc = run(["approve", MERGE_SHA], s3=s3)
    assert proc.returncode != 0


# ── The script itself: no approval capability, ever ──────────────────────────


def test_script_cannot_approve_anything():
    body = SCRIPT.read_text()
    code = [
        l
        for l in body.splitlines()
        if l.strip() and not l.lstrip().startswith("#")
    ]
    joined = "\n".join(code)
    for forbidden in (
        "put-approval-result",
        "PutApprovalResult",
        "putApprovalResult",
        "codepipeline",
    ):
        assert forbidden not in joined, (
            f"{forbidden} must never appear in executable lines of "
            "preapproved-check.sh -- this script answers a question, it never "
            "clears the human gate"
        )
    assert "set -e" not in joined or "set -uo pipefail" in joined


# ── The wiring: the fail-closed orientation is not negotiable ────────────────


def test_stack_skips_the_approval_stage_only_on_the_literal_1():
    src = STACK.read_text()
    assert "beforeEntry" in src, "the Approval stage must carry an entry condition"
    assert "GateUnlessMergeApproved" in src
    assert 'provider: "VariableCheck"' in src
    assert 'Variable: "#{BuildVars.DEPLOY_PREAPPROVED}"' in src
    # THE fail-closed assertion. `NE "1"` = the rule passes (stage entered, human
    # paged) for everything that is not exactly "1". An `EQ`/`"0"` inversion here
    # would make "unproven" mean "skip the human".
    assert 'Operator: "NE"' in src
    assert 'Value: "1"' in src
    assert "codepipeline.Result.SKIP" in src


def test_build_action_exports_the_variable_under_the_namespace_the_rule_reads():
    src = STACK.read_text()
    assert 'variablesNamespace: "BuildVars"' in src
    ci = BUILDSPEC_CI.read_text()
    assert "exported-variables:" in ci
    assert "- DEPLOY_PREAPPROVED" in ci


def test_stack_has_no_approval_clearing_capability():
    # Comment lines may (and do) explain the deliberate absence; executable lines
    # must not contain it.
    code = "\n".join(
        l
        for l in STACK.read_text().splitlines()
        if l.strip() and not l.lstrip().startswith(("//", "*", "/*"))
    )
    assert "PutApprovalResult" not in code
    assert "putApprovalResult" not in code
    assert "codepipeline:PutApproval" not in code
    # The gate still exists as a human action; it is skipped, never approved.
    assert "ManualApprovalAction" in code


def test_build_emits_the_full_sha_artifact_the_deploy_stage_rechecks():
    ci = BUILDSPEC_CI.read_text()
    assert "pipeline-out/git-sha-full.txt" in ci
    assert 'preapproved-check.sh decide "$FULL_SHA"' in ci
    # git-sha.txt stays the 12-char image tag.
    assert "cut -c1-12" in ci


@pytest.mark.parametrize(
    "spec", [BUILDSPEC_DEPLOY, BUILDSPEC_RUNTIME], ids=["app-deploy", "runtime-images"]
)
def test_both_deploy_actions_recheck_before_touching_prod(spec):
    text = spec.read_text()
    assert "preapproved-check.sh gate" in text, (
        f"{spec.name} must re-read the ship-approval record itself rather than "
        "trusting a skipped Approval stage"
    )
    assert 'pipeline-out/git-sha-full.txt' in text
    # It must run in pre_build, before anything is deployed.
    pre = text.index("pre_build:")
    build = text.index("\n  build:")
    assert pre < text.index("preapproved-check.sh gate") < build


def test_both_deploy_actions_receive_the_variable():
    src = STACK.read_text()
    assert src.count('DEPLOY_PREAPPROVED: {') == 2, (
        "both Deploy_three_targets and Deploy_runtime_images must receive "
        "DEPLOY_PREAPPROVED, else one of them cannot fail closed"
    )


def test_the_new_pytest_file_is_in_the_ci_battery():
    ci = BUILDSPEC_CI.read_text()
    assert "deploy/pipeline/test_preapproved_check.py" in ci
    workflow = (REPO / ".github" / "workflows" / "ci.yml").read_text()
    assert "deploy/pipeline/test_preapproved_check.py" in workflow


def test_script_is_executable_or_invoked_with_bash():
    # The buildspecs call it via `bash <path>`, so the mode bit is not load
    # bearing -- but if it is not executable, nothing may rely on ./ invocation.
    invocations = (
        BUILDSPEC_CI.read_text()
        + BUILDSPEC_DEPLOY.read_text()
        + BUILDSPEC_RUNTIME.read_text()
    )
    executable = bool(SCRIPT.stat().st_mode & stat.S_IXUSR)
    assert executable or "./deploy/pipeline/preapproved-check.sh" not in invocations
    assert shutil.which("bash"), "these tests need bash"
