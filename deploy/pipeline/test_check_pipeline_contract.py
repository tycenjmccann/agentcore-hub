"""Battery for the pipeline arg contract guard (TEAM-4563).

The stack PROVIDES env vars to the buildspecs and the buildspecs CONSUME them, but
agreeing with the stack SOURCE is not enough: PR #576 made buildspec-deploy.yml and
buildspec-runtime-images.yml read DEPLOY_PREAPPROVED, which pipeline-stack.ts does
declare as an action-level #{BuildVars.DEPLOY_PREAPPROVED} - and every main deploy
still failed at PRE_BUILD, because ./deploy/pipeline/deploy.sh is a HANDOFF that had
not run and CodePipeline resolves an unknown variable to "". PR #579 recovered it by
making preapproved-check.sh gate tolerate empty.

So deploy/pipeline/pipeline-contract.json records what the DEPLOYED pipeline
provides (never generated from the stack, which would have passed #576) and
deploy/pipeline/check-pipeline-contract.py is asymmetric: a contract entry must
exist in stack source, while a stack-source arg missing from the contract is
"declared, not yet confirmed deployed" and any buildspec READING it fails.

Every case runs the guard as a subprocess against a committed fixture dir under
fixtures/pipeline-contract/<case>/ (stack.txt, contract.json, buildspec.yml,
deploy.yml), pinning the exit code AND the operator-facing message. Hermetic: no
AWS, no network, no venv; the guard is stdlib-only and the fixtures are files.
"""
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
GUARD = REPO / "deploy" / "pipeline" / "check-pipeline-contract.py"
WRAPPER = REPO / "scripts" / "check-pipeline-contract.sh"
CONTRACT = REPO / "deploy" / "pipeline" / "pipeline-contract.json"
FIXTURES = REPO / "deploy" / "pipeline" / "fixtures" / "pipeline-contract"
BUILDSPEC_CI = REPO / "deploy" / "pipeline" / "buildspec-ci.yml"
CI_WORKFLOW = REPO / ".github" / "workflows" / "ci.yml"


def run_guard(*args, cwd=REPO):
    """Run the guard exactly as the wrapper does, capturing both streams."""
    return subprocess.run(
        [sys.executable, str(GUARD)] + [str(a) for a in args],
        cwd=str(cwd), capture_output=True, text=True,
    )


def run_case(name, *extra):
    d = FIXTURES / name
    return run_guard("--root", d, "--contract", d / "contract.json", *extra)


def output(r):
    return r.stdout + r.stderr


# --- fixture cases (design 7.3; every dir is committed under fixtures/) -------

# (case dir, extra args, expected exit code, required substring of stdout+stderr)
CASES = [
    ("fixture-pass", (), 0,
     "OK: pipeline contract - 2 buildspecs, 5 provided vars, 1 namespace refs checked"),
    ("regression-576", (), 1,
     "FAIL: deploy.yml:8 reads DEPLOY_PREAPPROVED which pipeline-contract.json does not "
     "declare for [fixture-deploy/Deploy_it] - declared in pipeline-stack.ts but not in "
     "pipeline-contract.json: deploy the stack (./deploy/pipeline/deploy.sh) then add it to "
     "the contract, or make the read tolerate absence (${DEPLOY_PREAPPROVED:-})"),
    ("regression-576-fixed", (), 0,
     "OK: pipeline contract - 2 buildspecs, 6 provided vars, 1 namespace refs checked"),
    ("contract-not-in-stack", (), 1,
     "FAIL: pipeline-contract.json declares INVENTED_ARG for buildspec.yml but stack.txt "
     "provides it to none of [fixture-build, Build_and_gate] - fix: remove it from the "
     "contract or add it to the stack (which is a HANDOFF)"),
    ("namespace-not-exported", (), 1,
     "FAIL: stack.txt:29 references #{BuildVars.DEPLOY_PREAPPROVED} but buildspec.yml "
     "env.exported-variables does not export DEPLOY_PREAPPROVED - fix: add "
     "DEPLOY_PREAPPROVED to exported-variables or remove the reference"),
    ("namespace-not-declared", (), 1,
     "FAIL: stack.txt:29 references #{BuildVars.DEPLOY_PREAPPROVED} but BuildVars is not in "
     "pipeline-contract.json namespaces - fix: add the namespace (exporter + action, or "
     "builtin: true) or remove the reference"),
    ("exporter-action-mismatch", (), 1,
     'FAIL: stack.txt declares variablesNamespace "BuildVars" on action Build_and_gate but '
     'pipeline-contract.json says action Deploy_it - fix: correct '
     'namespaces["BuildVars"].action'),
    # fail-closed: every infrastructure error is exit 2 with one FAIL line
    ("fail-closed-missing-contract", (), 2, "contract file missing"),
    ("fail-closed-unparseable-json", (), 2, "unparseable JSON"),
    ("fail-closed-buildspec-missing", (), 2, "buildspec file missing"),
    ("fail-closed-missing-stack", (), 2, "stack file missing"),
    ("fail-closed-unknown-top-key", (), 2, "unknown top-level key 'extra'"),
    ("fail-closed-unknown-entry-key", (), 2, "unknown key 'bogus'"),
    ("fail-closed-bad-absence", (), 2, 'absence must be "required" or "tolerated"'),
    ("fail-closed-unknown-buildspec-arg", ("--buildspec", "nope.yml"), 1,
     'FAIL: nope.yml has no contract entry in pipeline-contract.json buildspecs - fix: add '
     'buildspecs["nope.yml"] (providedBy + provides) or remove the file'),
    ("fail-closed-globbed-not-in-contract", (), 1,
     "FAIL: buildspec-extra.yml has no contract entry in pipeline-contract.json buildspecs "
     "- fix:"),
    ("fail-closed-globbed-yaml-not-in-contract", (), 1,
     "FAIL: buildspec-new.yaml has no contract entry in pipeline-contract.json buildspecs "
     "- fix:"),
    # P5: any fromSourceFilename() the stack runs needs a contract entry, whatever
    # its name - not just buildspec-*.yml/*.yaml
    ("stack-buildspec-not-in-contract", (), 1,
     "FAIL: specs/extra.yml has no contract entry in pipeline-contract.json buildspecs"),
    ("fail-closed-multiline-quoted-scalar", (), 2, "unsupported multi-line quoted scalar at"),
    ("fail-closed-folded-scalar", (), 2, "unsupported folded multi-line scalar at"),
    ("fail-closed-plain-multiline-scalar", (), 2, "unsupported plain multi-line scalar at"),
    ("fail-closed-unterminated-heredoc", (), 2, "unterminated heredoc <<EOF"),
    ("fail-closed-stack-unknown-spread", (), 2,
     "spread of otherVars in environmentVariables block"),
    ("fail-closed-stack-two-commons", (), 2,
     "expected exactly one `const commonEnvVars = {` block, found 2"),
    ("fail-closed-stack-nonliteral-projectName", (), 2, "projectName is not a string literal"),
    ("fail-closed-stack-env-identifier", (), 2, "environmentVariables bound to 'someOtherVars'"),
    # a declared-and-deployed arg read tolerantly is the shape the contract blesses
    ("tolerant-declared-pass", (), 0, "OK: pipeline contract - 2 buildspecs, 6 provided vars"),
    # F4: a one-line env block with more than one entry must not drop any of them
    ("stack-one-line-env-block-pass", (), 0,
     "OK: pipeline contract - 2 buildspecs, 7 provided vars"),
    ("builtin-pass", (), 0, "OK:"),
    ("lowercase-pass", (), 0, "OK:"),
    # D9: `X="${X:-default}"` is a READ of X, not a definition of it
    ("self-referential-read", (), 1,
     'FAIL: buildspec.yml:14 reads UNDECL_SELF which pipeline-contract.json does not declare '
     'for [fixture-build/Build_and_gate] - fix: if the deployed stack provides it '
     '(./deploy/pipeline/deploy.sh has run), add it under buildspecs["buildspec.yml"].provides; '
     'otherwise make the read tolerate absence or drop it, or add it to allow with a reason'),
    ("self-referential-events-table", (), 1,
     "reads EVENTS_TABLE which pipeline-contract.json does not declare for "
     "[fixture-build/Build_and_gate] - fix:"),
    ("self-referential-defined-elsewhere-pass", (), 0, "OK:"),
    # D10: DEFINED is whole-file and order-insensitive - a read above a later
    # definition of the same name is not a violation
    ("order-insensitive-defined-pass", (), 0, "OK:"),
    # D5/D7/D17: comments, heredocs and escapes
    ("comment-not-definition", (), 1,
     "reads UNDECL_C which pipeline-contract.json does not declare"),
    ("quoted-scalar-definition", (), 0, "OK:"),
    ("heredoc-literal", (), 0, "OK:"),
    ("heredoc-unquoted-read-counts", (), 1,
     "reads UNDECL_H which pipeline-contract.json does not declare"),
    ("heredoc-unquoted-body-not-definition", (), 1,
     "reads UNDECL_H2 which pipeline-contract.json does not declare"),
    ("escaped-dollar", (), 0, "OK:"),
    ("double-backslash-dollar-reads", (), 1,
     "reads UNDECL_E3 which pipeline-contract.json does not declare"),
    # the asymmetry: source-only args are fine until something reads them
    ("stack-extra-not-in-contract-pass", (), 0, "OK:"),
    ("unknown-provider", (), 1,
     "FAIL: buildspec.yml providedBy names Ghost_action, which is neither a projectName nor "
     "an actionName in stack.txt - fix: correct the name or remove it from providedBy"),
    ("source-mismatch", (), 1,
     "FAIL: pipeline-contract.json says AWS_REGION_HUB source=project for buildspec.yml but "
     "stack.txt declares it as common for fixture-build - fix: set source to common"),
    ("provider-binding", (), 1,
     'FAIL: stack.txt action Deploy_it (project fixture-deploy) runs deploy.yml but is '
     'missing from its providedBy - fix: add Deploy_it to buildspecs["deploy.yml"].providedBy'),
    ("provider-binding-wrong-buildspec", (), 1,
     "FAIL: buildspec.yml providedBy project fixture-build runs other.yml, not this buildspec "
     "- fix: move fixture-build to the entry for other.yml or fix the stack's "
     "fromSourceFilename"),
    ("missing-provider", (), 1,
     'FAIL: stack.txt project fixture-build runs buildspec.yml but is missing from its '
     'providedBy - fix: add fixture-build to buildspecs["buildspec.yml"].providedBy'),
    # D5: '#' inside 'single quotes' is data, not a comment
    ("single-quote-hash-then-read", (), 1,
     "FAIL: deploy.yml:7 reads UNDECL_A which pipeline-contract.json does not declare"),
    # D8: reads count wherever they appear; definitions only in statement position
    ("single-quoted-read-counts", (), 1,
     "FAIL: buildspec.yml:14 reads UNDECL_SQ which pipeline-contract.json does not declare"),
    ("trap-body-read", (), 1,
     "FAIL: buildspec.yml:14 reads UNDECL_T which pipeline-contract.json does not declare"),
    ("bare-export-is-read", (), 1,
     "FAIL: buildspec.yml:14 reads UNDECL_X which pipeline-contract.json does not declare"),
    ("bare-export-of-provided-pass", (), 0, "OK:"),
    ("declare-without-eq-is-definition", (), 0, "OK:"),
    ("read-for-select-definitions", (), 0, "OK:"),
    ("command-prefix-and-build-arg", (), 1,
     "FAIL: buildspec.yml:15 reads UNDECL_BA which pipeline-contract.json does not declare"),
    # A1 (--strict-absence, not wired into CI): a bare read of a may-be-absent arg
    ("strict-absence-bare-read", ("--strict-absence",), 1,
     "FAIL: buildspec.yml:13 reads ECR_REPO bare but it is marked absence=tolerated - fix: "
     "read it as ${ECR_REPO:-} because the deployed pipeline may not provide it yet"),
    ("strict-absence-same-fixture-passes-without-flag", (), 0, "OK:"),
    ("strict-absence-per-provider", ("--strict-absence",), 1,
     "FAIL: deploy.yml:8 reads DEPLOY_ONLY bare but it is not provided by fixture-deploy - "
     "fix: read it as ${DEPLOY_ONLY:-} because the deployed pipeline may not provide it yet"),
    ("explain-format", ("--explain",), 0,
     "EXPLAIN: buildspec.yml providedBy=[Build_and_gate,fixture-build] "
     "provides=[ARTIFACT_BUCKET,AWS_REGION_HUB,ECR_REPO] "
     "consumed=[ARTIFACT_BUCKET,AWS_REGION_HUB,ECR_REPO] allow=[] builtin=[] "
     "defined=[DEPLOY_PREAPPROVED]"),
    ("determinism", (), 1,
     "FAIL: buildspec.yml:13 reads AA_UNDECL which pipeline-contract.json does not declare"),
    # F5: $(( X + 1 )) and (( X > 0 )) are reads of X
    ("arithmetic-read-counts", (), 1,
     "FAIL: deploy.yml:7 reads UNDECL_F which pipeline-contract.json does not declare"),
]


@pytest.mark.parametrize("name,args,expect,want", CASES, ids=[c[0] for c in CASES])
def test_fixture_case(name, args, expect, want):
    r = run_case(name, *args)
    out = output(r)
    assert r.returncode == expect, f"{name}: exit {r.returncode}, want {expect}\n{out}"
    assert want in out, f"{name}: message not found\nwant: {want}\ngot:\n{out}"


def test_every_fixture_dir_has_a_case():
    """A fixture dir nobody runs is dead weight; a case with no dir is a typo."""
    on_disk = {p.name for p in FIXTURES.iterdir() if p.is_dir()}
    in_table = {c[0] for c in CASES} | {"undeclared-plain-read"}
    assert on_disk == in_table


def test_self_referential_companion_does_not_report_the_defined_var():
    """The EVENTS_TABLE shape from buildspec-runtime-images.yml:134: a command-prefix
    self-referential read is reported, but GIT_SHA (defined on the line above and used
    as a plain prefix) is not - D9 must not turn every prefix into a violation."""
    out = output(run_case("self-referential-events-table"))
    assert "EVENTS_TABLE" in out
    assert "GIT_SHA" not in out


def test_command_prefix_assignments_are_definitions():
    """`PFX_A=1 PFX_B="$AWS_REGION_HUB" node x.js` defines both; only the --build-arg
    read of an undeclared var is a violation."""
    out = output(run_case("command-prefix-and-build-arg"))
    assert "UNDECL_BA" in out
    assert "PFX_A" not in out and "PFX_B" not in out


def test_arithmetic_reads_count_in_both_forms():
    """`$(( X + 1 ))` and `(( X > 0 ))` are reads: an arg only ever used in
    arithmetic is exactly as absent as one used in a string. `(( ! X ))` also
    counts - unlike `${!X}`, a `!` inside arithmetic is logical NOT, not
    indirection, so the identifier after it is a genuine read of X."""
    out = output(run_case("arithmetic-read-counts"))
    assert "deploy.yml:7 reads UNDECL_F" in out, out
    assert "deploy.yml:8 reads UNDECL_G" in out, out
    assert "deploy.yml:9 reads UNDECL_H" in out, out


def test_undeclared_plain_read_via_buildspec_flag(tmp_path):
    """D11: --buildspec may point outside the root; the file is then matched to its
    contract entry by basename and the message says which entry it was graded against.
    The copy lives in tmp_path so the committed fixture stays green."""
    src = FIXTURES / "undeclared-plain-read" / "buildspec.yml"
    dst = tmp_path / "buildspec.yml"
    dst.write_text(src.read_text(encoding="utf-8") + '      - "echo \\"$FOO_BAR\\""\n',
                   encoding="utf-8")
    d = FIXTURES / "undeclared-plain-read"
    r = run_guard("--root", d, "--contract", d / "contract.json", "--buildspec", dst)
    out = output(r)
    assert r.returncode == 1, out
    assert (
        f"FAIL: {dst}:13 reads FOO_BAR which pipeline-contract.json does not declare for "
        "[fixture-build/Build_and_gate] - fix:"
    ) in out, out
    assert out.rstrip("\n").endswith(" (contract entry buildspec.yml)"), out


def test_violations_are_deduped_sorted_and_deterministic():
    """D15: two runs are byte-identical, and violations print sorted - AA_UNDECL before
    ZZ_UNDECL even though the buildspec reads ZZ first."""
    r1 = run_case("determinism")
    r2 = run_case("determinism")
    assert (r1.stdout, r1.stderr, r1.returncode) == (r2.stdout, r2.stderr, r2.returncode)
    assert r1.returncode == 1
    lines = [l for l in r1.stderr.splitlines() if l.startswith("FAIL:")]
    assert len(lines) == 2, r1.stderr
    assert "AA_UNDECL" in lines[0] and "ZZ_UNDECL" in lines[1], r1.stderr


# --- the real repo at HEAD ---------------------------------------------------

HEAD_OK = "OK: pipeline contract - 3 buildspecs, 17 provided vars, 3 namespace refs checked"

# Everything up to and including builtin=[..] is pinned exactly (design 4.12 / 12.2).
# The `defined=[..]` tail is the buildspec's own shell locals, so it is asserted to be
# present but not enumerated - the same reasoning that keeps line numbers out of the
# --strict-absence pin below.
HEAD_EXPLAIN_PREFIXES = [
    "EXPLAIN: deploy/pipeline/buildspec-ci.yml "
    "providedBy=[Build_and_gate,agentcore-hub-build,agentcore-hub-ci] "
    "provides=[ARTIFACT_BUCKET,AWS_REGION_HUB,BUILD_APP_IMAGE,ECR_REPO,EXPECTED_ACCOUNT_ID,"
    "NEXT_PUBLIC_PIPELINE_ENABLED] "
    "consumed=[ARTIFACT_BUCKET,AWS_REGION_HUB,BUILD_APP_IMAGE,ECR_REPO,"
    "NEXT_PUBLIC_PIPELINE_ENABLED] allow=[PLAYWRIGHT_BROWSERS_PATH] "
    "builtin=[CODEBUILD_RESOLVED_SOURCE_VERSION]",
    "EXPLAIN: deploy/pipeline/buildspec-deploy.yml "
    "providedBy=[Deploy_three_targets,agentcore-hub-deploy] "
    "provides=[ARTIFACT_BUCKET,AWS_REGION_HUB,DEPLOY_PREAPPROVED,ECR_REPO,ECS_SERVICE_ARN,"
    "EXPECTED_ACCOUNT_ID] "
    "consumed=[ARTIFACT_BUCKET,AWS_REGION_HUB,DEPLOY_PREAPPROVED,ECR_REPO,ECS_SERVICE_ARN,"
    "EXPECTED_ACCOUNT_ID] allow=[] builtin=[]",
    "EXPLAIN: deploy/pipeline/buildspec-runtime-images.yml "
    "providedBy=[Deploy_runtime_images,agentcore-hub-runtime-image-deploy] "
    "provides=[ARTIFACT_BUCKET,AWS_REGION_HUB,DEPLOY_PREAPPROVED,EVENTS_TABLE,"
    "EXPECTED_ACCOUNT_ID] "
    "consumed=[ARTIFACT_BUCKET,AWS_REGION_HUB,DEPLOY_PREAPPROVED,EVENTS_TABLE,"
    "EXPECTED_ACCOUNT_ID] allow=[] builtin=[]",
]


def test_head_passes_with_the_shipped_contract():
    r = run_guard("--root", REPO)
    assert r.returncode == 0, output(r)
    assert r.stdout.strip() == HEAD_OK
    assert r.stderr == ""


def test_head_explain_lines_are_pinned():
    r = run_guard("--root", REPO, "--explain")
    assert r.returncode == 0, output(r)
    lines = r.stdout.splitlines()
    assert len(lines) == 4, r.stdout
    for line, prefix in zip(lines, HEAD_EXPLAIN_PREFIXES):
        assert line.startswith(prefix), f"want prefix:\n{prefix}\ngot:\n{line}"
        assert line[len(prefix):].startswith(" defined=["), line
    assert lines[3] == HEAD_OK


def test_head_strict_absence_finding_is_the_ci_buildspec_ecr_repo_read():
    """Section 8: the one bare read of a may-be-absent arg at HEAD is ECR_REPO inside
    buildspec-ci.yml's BUILD_APP_IMAGE block (agentcore-hub-ci never provides it and
    never enters the block). The (file, var) pairs are pinned, NOT the line numbers -
    an edit above the block must not break this test, while a new bare read of another
    var, or the same finding moving to another file, still does."""
    r = run_guard("--root", REPO, "--strict-absence")
    assert r.returncode == 1, output(r)
    pairs = set(re.findall(r"^FAIL: (\S+?):\d+ reads (\w+) bare ", r.stderr, re.M))
    assert pairs == {("deploy/pipeline/buildspec-ci.yml", "ECR_REPO")}, r.stderr


def test_emit_from_stack_is_reserved():
    """D22: the contract is never generated from the stack - a generated one would have
    passed #576. The flag exists so nobody wires it up by accident."""
    r = run_guard("--root", REPO, "--emit-from-stack")
    assert r.returncode == 2
    assert "reserved and not implemented" in r.stderr


# --- wiring, source and contract pins ----------------------------------------

def test_the_guard_runs_on_both_ci_rails():
    """A guard wired into neither rail guards nothing; one wired into only one rail
    drifts (model: test_buildspec_ci_exit_codes.py::test_this_file_runs_in_ci)."""
    gh = CI_WORKFLOW.read_text(encoding="utf-8")
    bs = BUILDSPEC_CI.read_text(encoding="utf-8")
    assert "./scripts/check-pipeline-contract.sh" in gh, \
        "ci.yml must run the wrapper in the build job"
    assert "./scripts/check-pipeline-contract.sh" in bs, \
        "buildspec-ci.yml must run the wrapper in pre_build"


def test_this_file_runs_in_ci():
    name = Path(__file__).name
    gh = CI_WORKFLOW.read_text(encoding="utf-8")
    bs = BUILDSPEC_CI.read_text(encoding="utf-8")
    assert f"deploy/pipeline/{name}" in gh, \
        f"{name} must be in .github/workflows/ci.yml's pytest list"
    assert f"deploy/pipeline/{name}" in bs, \
        f"{name} must be in buildspec-ci.yml's build-phase pytest list"


def test_buildspec_pytest_block_keeps_its_guarded_tail():
    """TEAM-4464: the block's exit status is its LAST statement's, so this file was
    inserted BEFORE the guarded tail - `... || { ... exit "$rc"; }` then `deactivate`."""
    text = BUILDSPEC_CI.read_text(encoding="utf-8")
    start = text.index("python3 -m venv /tmp/pyci")
    body = [text[start:].splitlines()[0]]
    for line in text[start:].splitlines()[1:]:
        if line.strip() and not line.startswith("        "):
            break  # dedented out of the `- |` literal block
        body.append(line)
    block = "\n".join(body)
    lines = [l for l in block.splitlines() if l.strip()]
    assert lines[-1].strip() == "deactivate", block
    assert re.search(r"\|\|\s*\{[^}]*exit", lines[-2]), lines[-2]
    assert "deploy/pipeline/test_check_pipeline_contract.py \\" in block


def test_wrapper_is_executable():
    assert WRAPPER.is_file()
    assert os.stat(WRAPPER).st_mode & stat.S_IXUSR, \
        "scripts/check-pipeline-contract.sh must be mode 100755 like its sibling guards"


def test_guard_is_stdlib_only_and_offline():
    """The guard runs on every PR and inside CodeBuild's pre_build, before any AWS
    credentials or pip install are in play (design 5.5)."""
    src = GUARD.read_text(encoding="utf-8")
    for banned in ("boto3", "subprocess", "urllib", "requests", "import yaml", "os.environ"):
        assert banned not in src, f"the guard must not reference {banned}"
    imports = {l.strip() for l in src.splitlines()
               if l.startswith("import ") or l.startswith("from ")}
    assert imports == {
        "import argparse", "import glob", "import json", "import re", "import sys",
        "from pathlib import Path",
    }, imports


def test_no_em_dashes_in_the_shipped_surfaces():
    """Repo convention: hyphens, never em dashes, in anything that can reach an AWS
    resource name, a CodeBuild log line or the contract."""
    for path in (GUARD, CONTRACT, WRAPPER):
        assert "\u2014" not in path.read_text(encoding="utf-8"), path


def test_shipped_contract_pins():
    data = json.loads(CONTRACT.read_text(encoding="utf-8"))
    assert data["stack"] == "deploy/pipeline/lib/pipeline-stack.ts"
    assert data["$comment"] == (
        "Adding an entry here asserts the DEPLOYED pipeline provides it: run "
        "./deploy/pipeline/deploy.sh first (or in the same release), or make the consuming "
        "buildspec tolerate absence."
    )
    assert "$schema" not in data, "the contract is hand-edited, not schema-generated"
    for key in ("deploy/pipeline/buildspec-deploy.yml",
                "deploy/pipeline/buildspec-runtime-images.yml"):
        entry = data["buildspecs"][key]["provides"]["DEPLOY_PREAPPROVED"]
        assert entry["source"] == "action"
        assert entry["absence"] == "tolerated", (
            "#576/#579: the deployed pipeline may not provide it, so the read must be "
            "allowed to see it empty"
        )
