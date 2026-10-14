"""The ticket-twin preflight in buildspec-deploy.yml's pre_build, executed for real (TEAM-5910).

Since TEAM-5832/TEAM-5805 both ticket twins refuse every non-ship Done that S3 cannot
prove has no completion record, and S3 says "no record" (404) only to a role holding
s3:ListBucket on the bucket. That grant lands only through deploy/setup-tickets-lambda.mjs
(a handoff), while Target 1b ships twin code with update-function-code alone and the
stage exits 0 — so a green deploy could ship code that refuses every non-ship Done.

pre_build now runs deploy/lib/twin-preflight.mjs over the deploy plan. A refusal fails
pre_build, so CodeBuild never enters the build phase: no update-function-code, no
rollback, no baseline advance (the next run re-plans the twin).

Hermetic: the pre_build item is extracted from the YAML and run under bash with a fake
`aws` on PATH that answers from a JSON fixture and logs every call. BUILDSPEC_DEPLOY_YML
points the executed cases at another copy of the buildspec (a `git show <base>:...`
extract) to show the base has no preflight.
"""
import json
import os
import subprocess
import textwrap
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BUILDSPEC = Path(os.environ.get("BUILDSPEC_DEPLOY_YML") or REPO / "deploy" / "pipeline" / "buildspec-deploy.yml")
CI_BUILDSPEC = REPO / "deploy" / "pipeline" / "buildspec-ci.yml"
CI_WORKFLOW = REPO / ".github" / "workflows" / "ci.yml"
ANCHOR = "node deploy/lib/twin-preflight.mjs"

ACCOUNT = "123456789012"
BUCKET = f"agentcore-hub-artifacts-{ACCOUNT}-us-east-1"
JIRA_ROW = "LAMBDA\tagentcore-hub-jira\tlambda/agentcore-hub-jira\t0\t0\tindex.mjs fix-contract.mjs gate-contract.mjs\tnote"

FAKE_AWS = r'''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ["FAKE_AWS_LOG"], "a") as f:
    f.write(" ".join(args) + "\n")
fx = json.load(open(os.environ["FAKE_AWS_FIXTURE"]))
key = " ".join(args[:2])
reply = fx.get(key)
if reply is None:
    sys.stderr.write(f"fake aws: no fixture for {key}\n"); sys.exit(255)
if "error" in reply:
    sys.stderr.write(f"\nAn error occurred ({reply['error']}) when calling the X operation: test\n"); sys.exit(254)
print(json.dumps(reply["out"]))
'''


def _policy(with_list=True):
    st = [
        {"Effect": "Allow", "Action": ["logs:CreateLogGroup"], "Resource": f"arn:aws:logs:us-east-1:{ACCOUNT}:*"},
        {"Sid": "ArtifactRead", "Effect": "Allow", "Action": ["s3:GetObject"], "Resource": f"arn:aws:s3:::{BUCKET}/*"},
    ]
    if with_list:
        st.append({"Sid": "ArtifactBucketList", "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": f"arn:aws:s3:::{BUCKET}"})
    return {"Version": "2012-10-17", "Statement": st}


def _fixture(policy=None, list_error=None):
    fx = {
        "lambda get-function-configuration": {"out": {"role": f"arn:aws:iam::{ACCOUNT}:role/AgentCoreHubJiraLambdaRole", "bucket": BUCKET}},
        "iam list-role-policies": {"error": list_error} if list_error else {"out": ["TicketsLambdaAccess"]},
        "iam get-role-policy": {"out": policy if policy is not None else _policy()},
    }
    return fx


def _preflight_item(text: str) -> str:
    """The pre_build `- |` item that runs the preflight, dedented."""
    lines = text.splitlines()
    build = next(i for i, l in enumerate(lines) if l.rstrip() == "  build:")
    hit = next((i for i, l in enumerate(lines[:build]) if ANCHOR in l and not l.lstrip().startswith("#")), None)
    assert hit is not None, f"no `{ANCHOR}` in buildspec-deploy.yml's pre_build ({BUILDSPEC})"
    start = max(i for i in range(hit + 1) if lines[i].strip() == "- |")
    end = next(i for i in range(hit + 1, build + 1) if lines[i].strip() and (len(lines[i]) - len(lines[i].lstrip())) <= 6)
    return textwrap.dedent("\n".join(lines[start + 1:end]))


def _run(tmp_path: Path, fixture: dict, plan_rows=(JIRA_ROW,)):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "aws").write_text(FAKE_AWS)
    (bindir / "aws").chmod(0o755)
    (tmp_path / "fixture.json").write_text(json.dumps(fixture))
    plan = tmp_path / "deploy-plan.tsv"
    plan.write_text("\n".join(plan_rows) + "\n")
    log = tmp_path / "aws.log"
    item = _preflight_item(BUILDSPEC.read_text(encoding="utf-8")).replace("/tmp/deploy-plan.tsv", str(plan))
    r = subprocess.run(
        ["bash", "-c", "set -euo pipefail\n" + item + "\n"],
        cwd=REPO,
        env={
            "PATH": f"{bindir}:{os.environ['PATH']}",
            "ARTIFACT_BUCKET": BUCKET,
            "AWS_REGION_HUB": "us-east-1",
            "FAKE_AWS_FIXTURE": str(tmp_path / "fixture.json"),
            "FAKE_AWS_LOG": str(log),
        },
        capture_output=True,
        text=True,
    )
    return r, (log.read_text().splitlines() if log.exists() else [])


# ── static shape ──────────────────────────────────────────────────────────────

def test_preflight_runs_in_pre_build_after_the_plan():
    text = BUILDSPEC.read_text(encoding="utf-8")
    item = _preflight_item(text)
    code = [l for l in text.splitlines() if not l.lstrip().startswith("#")]
    plan_at = next(i for i, l in enumerate(code) if "plan-surfaces.py pipeline-out/changed-files.txt" in l)
    flight_at = next(i for i, l in enumerate(code) if ANCHOR in l)
    assert plan_at < flight_at, "the preflight must read the plan, so it runs after plan-surfaces.py"
    assert "exit 1" in item


def test_this_file_runs_in_ci():
    name = Path(__file__).name
    assert f"deploy/pipeline/{name}" in CI_BUILDSPEC.read_text(encoding="utf-8"), (
        f"{name} must be added to buildspec-ci.yml's build-phase pytest list"
    )
    if CI_WORKFLOW.exists():
        assert f"deploy/pipeline/{name}" in CI_WORKFLOW.read_text(encoding="utf-8"), (
            f"{name} must also be in .github/workflows/ci.yml's pytest list"
        )


# ── executed ──────────────────────────────────────────────────────────────────

def test_missing_grant_fails_pre_build_and_updates_nothing(tmp_path):
    r, calls = _run(tmp_path, _fixture(policy=_policy(with_list=False)))
    assert r.returncode != 0, r.stdout + r.stderr
    assert "setup-tickets-lambda.mjs" in r.stdout + r.stderr
    assert not [c for c in calls if "update-function-code" in c], calls


def test_unreadable_role_policy_fails_pre_build(tmp_path):
    r, calls = _run(tmp_path, _fixture(list_error="AccessDenied"))
    assert r.returncode != 0, r.stdout + r.stderr
    assert not [c for c in calls if "update-function-code" in c], calls


def test_grant_present_lets_the_deploy_proceed(tmp_path):
    r, calls = _run(tmp_path, _fixture())
    assert r.returncode == 0, r.stdout + r.stderr
    assert any(c.startswith("iam get-role-policy") for c in calls), calls


def test_no_twin_in_the_plan_makes_no_aws_call(tmp_path):
    other = "LAMBDA\tagentcore-hub-cost-report\tlambda/cost-report\t0\t0\tindex.mjs kpi.json\t"
    r, calls = _run(tmp_path, _fixture(), plan_rows=(other,))
    assert r.returncode == 0, r.stdout + r.stderr
    assert calls == []
